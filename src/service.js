// 弹性编排服务：基于事件溯源的状态机。
//
// 关键约定：
// - 编排结果只是建议（PLAN_PROPOSED），不暂占任何容量；带队老师确认后才原子暂占（ITINERARY_HELD）。
// - 一个团组至多持有一套有效方案；确认新方案时旧方案在同一批次内原子释放（REPLACED）。
// - 拒绝或超时通过单个 HOLD_RELEASED 事件原子释放该团组的全部占用，随即推进候补。
// - 局部停用只替换受影响节点（ROUTE_REPLANNED），未变行程原样保留。
// - 截止时间是绝对时间，记录在事件里；崩溃恢复重放事件后按原截止时间继续释放与候补推进。
// - 确认与签到按 idempotency_key 去重，重复操作不会多占容量。

import { buildProposal, replanRoute, intervalsOverlap } from "./planning.js";
import {
  EVENT_KINDS,
  RELEASE_REASONS,
  validateEventStrict,
} from "./skill_museum_learning.js";

const ts = (value) => new Date(value).getTime();

export class ServiceError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ServiceError";
    this.code = code;
    this.details = details;
  }
}

export function createService(options = {}) {
  const world = {
    stations: [],
    travel: options.travel ?? {},
    intra_museum_minutes: options.intra_museum_minutes ?? 5,
    inter_museum_minutes: options.inter_museum_minutes ?? 20,
    default_leg_minutes: options.default_leg_minutes ?? 45,
    arrival_buffer_minutes: options.arrival_buffer_minutes ?? 5,
  };

  // ---- 状态（可由 events 重放重建）----
  const events = [];
  const requests = new Map();
  const stationsById = new Map();
  const proposals = new Map(); // proposal_id -> proposal
  const latestProposalByGroup = new Map(); // group_id -> proposal_id
  const holds = new Map(); // group_id -> { proposal_id, legs, release_deadline, idempotency_key }
  const waitlist = []; // [{ group_id, proposal_id, idempotency_key }]
  const confirmKeys = new Map(); // idempotency_key -> { group_id, proposal_id }
  const checkins = new Map(); // idempotency_key -> check-in 事件
  const checkinsByLeg = new Map(); // `${group_id}:${station_id}` -> 首次签到
  const routeHistory = new Map(); // group_id -> 变更说明数组（用于对账解释）
  const finalLegsByGroup = new Map(); // group_id -> 最近一次有效方案的腿（含重排结果）
  const reconciliations = new Map();

  let sequence = 0;

  function nowIso() {
    return options.clock ? options.clock() : new Date().toISOString();
  }

  // ---- 事件追加（单命令单批次，命令级原子）----
  function append(kind, subjectId, payload, at = nowIso()) {
    const event = {
      event_id: `evt-${(sequence += 1).toString(10).padStart(5, "0")}`,
      kind,
      occurred_at: typeof at === "string" ? at : new Date(at).toISOString(),
      subject_id: subjectId,
      payload,
    };
    const problems = validateEventStrict(event);
    if (problems.length) throw new ServiceError("INVALID_EVENT", { event, problems });
    events.push(event);
    fold(event);
    return event;
  }

  function worldView() {
    return { ...world, stations: world.stations.map((station) => ({ ...station })) };
  }

  // 除指定团组自身占用外的全部有效占用（用于规划与候补校验）。
  function occupancyExcluding(groupId) {
    const legs = [];
    for (const [owner, hold] of holds) {
      if (owner === groupId) continue;
      for (const leg of hold.legs) legs.push({ ...leg });
    }
    return legs;
  }

  function occupancyForReplan(groupId) {
    return occupancyExcluding(groupId);
  }

  // ---- 事件 fold：纯状态演进，重放与实时处理共用同一路径 ----
  function fold(event) {
    const { kind, payload } = event;
    switch (kind) {
      case "GROUP_REQUESTED": {
        requests.set(payload.group_id, { ...payload });
        break;
      }
      case "STATION_CAPACITY_SET": {
        const existing = stationsById.get(payload.station_id);
        const merged = {
          unavailable_windows: existing?.unavailable_windows ?? [],
          ...payload,
          mentors: payload.mentors ?? existing?.mentors ?? [],
        };
        stationsById.set(payload.station_id, merged);
        rebuildStationList();
        break;
      }
      case "STATION_UNAVAILABLE_DECLARED": {
        applyUnavailability(payload);
        rebuildStationList();
        break;
      }
      case "PLAN_PROPOSED": {
        proposals.set(payload.proposal_id, { ...payload, status: "PROPOSED" });
        latestProposalByGroup.set(payload.group_id, payload.proposal_id);
        break;
      }
      case "PLAN_SUPERSEDED": {
        const old = proposals.get(payload.proposal_id);
        // 已暂占的方案由其持有期的释放事件管理，不被新建议直接覆盖状态。
        if (old && old.status === "PROPOSED") old.status = "SUPERSEDED";
        break;
      }
      case "ITINERARY_HELD": {
        holds.set(payload.group_id, {
          proposal_id: payload.proposal_id,
          legs: payload.legs,
          release_deadline: payload.release_deadline,
          idempotency_key: payload.idempotency_key,
          held_at: event.occurred_at,
        });
        finalLegsByGroup.set(payload.group_id, payload.legs);
        // 团组拿到有效方案后离开候补，杜绝同一团组被候补推进再次暂占。
        const waitingIndex = waitlist.findIndex((item) => item.group_id === payload.group_id);
        if (waitingIndex >= 0) waitlist.splice(waitingIndex, 1);
        confirmKeys.set(payload.idempotency_key, {
          group_id: payload.group_id,
          proposal_id: payload.proposal_id,
        });
        const held = proposals.get(payload.proposal_id);
        if (held) held.status = "HELD";
        break;
      }
      case "HOLD_RELEASED": {
        holds.delete(payload.group_id);
        const proposalId = payload.proposal_id;
        if (proposalId) {
          const held = proposals.get(proposalId);
          if (held && held.status === "HELD") held.status = "RELEASED";
        }
        break;
      }
      case "ROUTE_REPLANNED": {
        const hold = holds.get(payload.group_id);
        const nextLegs = dedupeLegs(payload.legs ?? [...payload.unchanged_legs, ...payload.added_legs]);
        if (hold) hold.legs = nextLegs;
        finalLegsByGroup.set(payload.group_id, nextLegs);
        const history = routeHistory.get(payload.group_id) ?? [];
        history.push({ at: event.occurred_at, ...payload });
        routeHistory.set(payload.group_id, history);
        break;
      }
      case "WAITLIST_JOINED": {
        const existingIndex = waitlist.findIndex((item) => item.group_id === payload.group_id);
        const entry = {
          group_id: payload.group_id,
          proposal_id: payload.proposal_id,
          idempotency_key: payload.idempotency_key,
          joined_at: event.occurred_at,
        };
        if (existingIndex >= 0) {
          // 同一团组改确认新建议时保留其候补位次，只更新指向的建议。
          entry.joined_at = waitlist[existingIndex].joined_at;
          waitlist[existingIndex] = entry;
        } else {
          waitlist.push(entry);
        }
        if (payload.idempotency_key && !confirmKeys.has(payload.idempotency_key)) {
          confirmKeys.set(payload.idempotency_key, {
            group_id: payload.group_id,
            proposal_id: payload.proposal_id,
            waiting: true,
          });
        }
        break;
      }
      case "WAITLIST_PROMOTED": {
        const index = waitlist.findIndex((item) => item.group_id === payload.group_id);
        if (index >= 0) waitlist.splice(index, 1);
        break;
      }
      case "CHECK_IN_RECORDED": {
        checkins.set(payload.idempotency_key, payload);
        const legKey = `${payload.group_id}:${payload.station_id}`;
        if (!checkinsByLeg.has(legKey)) checkinsByLeg.set(legKey, payload);
        break;
      }
      case "VISIT_RECONCILED": {
        reconciliations.set(payload.group_id, { at: event.occurred_at, ...payload });
        holds.delete(payload.group_id);
        break;
      }
      default:
        // 未知事件不阻断重放。
        break;
    }
  }

  function dedupeLegs(legs) {
    const seen = new Set();
    return legs.filter((leg) => {
      const key = `${leg.station_id}:${leg.start}:${leg.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function rebuildStationList() {
    world.stations = [...stationsById.values()];
  }

  function applyUnavailability(payload) {
    const targets = [...stationsById.values()].filter((station) =>
      payload.scope === "MUSEUM"
        ? station.museum_id === payload.ref_id
        : station.station_id === payload.ref_id,
    );
    for (const station of targets) {
      station.unavailable_windows = [
        ...(station.unavailable_windows ?? []),
        { from: payload.from, to: payload.to, reason: payload.reason },
      ];
    }
  }

  // ---- 命令 ----

  // 登记外部事件（团组请求、容量设置、闭馆、签到）。
  // replay=true 时只做 fold 重放，不再触发派生事件，避免重放产生重复的重排/建议。
  function ingest(record, { replay = false } = {}) {
    const problems = validateEventStrict(record);
    if (problems.length) throw new ServiceError("INVALID_EVENT", { record, problems });
    events.push(record);
    fold(record);
    if (!replay && record.kind === "STATION_UNAVAILABLE_DECLARED") {
      handleUnavailability(record);
    }
    return record;
  }

  function registerRequest(request, at = nowIso()) {
    return append(
      "GROUP_REQUESTED",
      request.group_id,
      {
        group_id: request.group_id,
        size: request.size,
        learning_objectives: request.learning_objectives,
        time_window: request.time_window,
        accessibility_needs: request.accessibility_needs ?? [],
        required_mentor_certifications: request.required_mentor_certifications ?? [],
        required_certifications_by_objective: request.required_certifications_by_objective ?? {},
        support_needs_by_objective: request.support_needs_by_objective ?? {},
        transport: request.transport ?? null,
        objective_minutes: request.objective_minutes ?? {},
        release_deadline: request.release_deadline,
      },
      at,
    );
  }

  function registerStation(station, at = nowIso()) {
    return append(
      "STATION_CAPACITY_SET",
      station.station_id,
      {
        station_id: station.station_id,
        museum_id: station.museum_id,
        capacity: station.capacity,
        opening: station.opening,
        accessibility: station.accessibility ?? [],
        objectives: station.objectives ?? [],
        mentors: station.mentors ?? [],
      },
      at,
    );
  }

  // 仅生成建议，不暂占资源。部分目标不可行时照常出建议，unmet 给出每个候选工位的落选原因。
  function propose(groupId, at = nowIso(), supersedeReason = "REPLACED_BY_NEWER_PROPOSAL") {
    const request = requests.get(groupId);
    if (!request) throw new ServiceError("UNKNOWN_GROUP", { group_id: groupId });

    const previous = latestProposalByGroup.get(groupId);
    const result = buildProposal(request, worldView(), occupancyExcluding(groupId));
    const proposalId = `proposal-${groupId}-${proposals.size + 1}`;
    append(
      "PLAN_PROPOSED",
      groupId,
      {
        proposal_id: proposalId,
        group_id: groupId,
        legs: result.legs,
        resource_basis: result.resource_basis,
        unmet: result.unmet,
        coverage: result.coverage,
        proposed_at: typeof at === "string" ? at : new Date(at).toISOString(),
      },
      at,
    );
    if (previous) {
      append("PLAN_SUPERSEDED", groupId, { proposal_id: previous, group_id: groupId, reason: supersedeReason }, at);
    }
    return proposals.get(proposalId);
  }

  // 老师确认建议：建议只是计算结果，确认时以当前占用重新规划并原子校验。
  // 全部目标可安排则原子暂占（旧方案同窗释放）；任一目标放不下则进入候补、不占任何容量。
  function confirm(groupId, proposalId, { at = nowIso(), idempotencyKey } = {}) {
    const key = idempotencyKey ?? `confirm:${groupId}:${proposalId}`;
    const repeat = confirmKeys.get(key);
    if (repeat) {
      const existing = holds.get(repeat.group_id);
      if (existing) return { status: "ALREADY_HELD", hold: existing, idempotent: true };
      if (repeat.waiting || waitlist.some((item) => item.group_id === groupId)) {
        return { status: "WAITLISTED", idempotent: true };
      }
    }
    const proposal = proposals.get(proposalId);
    if (!proposal || proposal.group_id !== groupId) {
      throw new ServiceError("UNKNOWN_PROPOSAL", { group_id: groupId, proposal_id: proposalId });
    }
    if (proposal.status === "SUPERSEDED") throw new ServiceError("PROPOSAL_SUPERSEDED", { proposal_id: proposalId });

    const request = requests.get(groupId);
    if (ts(request.release_deadline) <= ts(at)) throw new ServiceError("DEADLINE_PASSED", { group_id: groupId });

    const fresh = buildProposal(request, worldView(), occupancyExcluding(groupId));
    if (fresh.unmet.length > 0) {
      append("WAITLIST_JOINED", groupId, { group_id: groupId, proposal_id: proposalId, idempotency_key: key }, at);
      return { status: "WAITLISTED", unmet: fresh.unmet };
    }

    // 同一批次：先释放旧方案（若有），再暂占新方案，保证一团一方案且对外无中间态。
    const previousHold = holds.get(groupId);
    if (previousHold) {
      append(
        "HOLD_RELEASED",
        groupId,
        {
          group_id: groupId,
          proposal_id: previousHold.proposal_id,
          reason: "REPLACED",
          legs: previousHold.legs,
        },
        at,
      );
    }
    append(
      "ITINERARY_HELD",
      groupId,
      {
        proposal_id: proposalId,
        group_id: groupId,
        legs: fresh.legs,
        resource_basis: fresh.resource_basis,
        release_deadline: request.release_deadline,
        idempotency_key: key,
      },
      at,
    );
    return { status: "HELD", hold: holds.get(groupId) };
  }

  function reject(groupId, at = nowIso()) {
    const hold = holds.get(groupId);
    if (!hold) return { status: "NO_ACTIVE_HOLD" };
    append(
      "HOLD_RELEASED",
      groupId,
      { group_id: groupId, proposal_id: hold.proposal_id, reason: "REJECTED", legs: hold.legs },
      at,
    );
    promoteWaitlist(at);
    return { status: "RELEASED" };
  }

  // 时间推进/服务恢复：按事件中记录的绝对截止时间释放超时占用，再推进候补。
  // 截止时间不随停机时长延长——重放后迟到的 tick 会立即释放所有已超时占用。
  function tick(at = nowIso()) {
    const expired = [];
    for (const [groupId, hold] of holds) {
      if (ts(hold.release_deadline) <= ts(at)) expired.push([groupId, hold]);
    }
    for (const [groupId, hold] of expired) {
      append(
        "HOLD_RELEASED",
        groupId,
        { group_id: groupId, proposal_id: hold.proposal_id, reason: "EXPIRED", legs: hold.legs },
        at,
      );
    }
    promoteWaitlist(at);
    return { expired: expired.map(([groupId]) => groupId) };
  }

  // 别名：服务恢复入口，语义同 tick——按原截止时间继续。
  const recover = tick;

  function promoteWaitlist(at) {
    const promoted = [];
    // 按入列顺序推进；每次成功暂占后重新扫描，因为容量可能再次被占满。
    // 仍不可行的团组保留其位次；截止时间已过的候补项直接移除。
    let progressed = true;
    while (progressed && waitlist.length) {
      progressed = false;
      for (let i = 0; i < waitlist.length; i += 1) {
        const item = waitlist[i];
        const request = requests.get(item.group_id);
        if (!request) continue;
        if (ts(request.release_deadline) <= ts(at)) {
          waitlist.splice(i, 1);
          i -= 1;
          progressed = true;
          continue;
        }
        // 已经持有有效方案的团组不再参与候补（fold 时一般已移除，这里兜底）。
        if (holds.has(item.group_id)) {
          waitlist.splice(i, 1);
          i -= 1;
          progressed = true;
          continue;
        }
        const fresh = buildProposal(request, worldView(), occupancyExcluding(item.group_id));
        if (fresh.unmet.length > 0) continue; // 容量仍不足，保留下一个位次继续尝试后面的团组

        append(
          "ITINERARY_HELD",
          item.group_id,
          {
            proposal_id: item.proposal_id,
            group_id: item.group_id,
            legs: fresh.legs,
            resource_basis: fresh.resource_basis,
            release_deadline: request.release_deadline,
            idempotency_key: item.idempotency_key,
            promoted_from_waitlist: true,
          },
          at,
        );
        append("WAITLIST_PROMOTED", item.group_id, { group_id: item.group_id, proposal_id: item.proposal_id }, at);
        waitlist.splice(i, 1);
        promoted.push(item.group_id);
        progressed = true;
        break; // 占用已变化，从头扫描保证位次公平
      }
    }
    return promoted;
  }

  // 闭馆/停用：只替换受影响节点，未变行程保留；无有效方案可替换时相关腿取消。
  function declareUnavailable(declaration, at = nowIso()) {
    const event = append(
      "STATION_UNAVAILABLE_DECLARED",
      declaration.ref_id,
      {
        scope: declaration.scope,
        ref_id: declaration.ref_id,
        from: declaration.from,
        to: declaration.to,
        reason: declaration.reason,
      },
      at,
    );
    handleUnavailability(event);
    return event;
  }

  function handleUnavailability(event) {
    const { scope, ref_id: refId, from, to } = event.payload;
    const hits = (station) =>
      scope === "MUSEUM" ? station.museum_id === refId : station.station_id === refId;

    for (const [groupId, hold] of [...holds]) {
      const request = requests.get(groupId);
      const affected = hold.legs.filter(
        (leg) => hits(stationsById.get(leg.station_id)) && intervalsOverlap(leg.start, leg.end, from, to),
      );
      if (!affected.length) continue;

      const disabledStationIds = [...new Set(affected.map((leg) => leg.station_id))];
      const result = replanRoute(
        request,
        worldView(),
        occupancyForReplan(groupId),
        hold.legs,
        disabledStationIds,
        { from, to },
      );
      append("ROUTE_REPLANNED", groupId, {
        group_id: groupId,
        reason: event.payload.reason,
        trigger_event_id: event.event_id,
        legs: result.legs,
        removed_legs: result.removed_legs,
        added_legs: result.added_legs,
        added_resource_basis: result.added_resource_basis,
        cancelled_legs: result.cancelled_legs,
        unchanged_legs: result.unchanged_legs,
        coverage: result.coverage,
      }, event.occurred_at);
    }

    // 待确认建议在资源变化后作废，并给出新建议供老师重新确认。
    for (const [groupId, proposalId] of [...latestProposalByGroup]) {
      const proposal = proposals.get(proposalId);
      if (proposal.status !== "PROPOSED") continue;
      const stale = proposal.legs.some(
        (leg) => hits(stationsById.get(leg.station_id)) && intervalsOverlap(leg.start, leg.end, from, to),
      );
      if (stale) {
        propose(groupId, event.occurred_at, "RESOURCE_UNAVAILABLE");
      }
    }
  }

  // 离线/在线签到：按 idempotency_key 去重；可补传早于当前时间的 occurred_at。
  function recordCheckIn({ group_id: groupId, station_id: stationId, occurred_at: at, idempotency_key: key }) {
    if (checkins.has(key)) {
      return { status: "DUPLICATE_IGNORED", existing: checkins.get(key), idempotent: true };
    }
    const event = append(
      "CHECK_IN_RECORDED",
      groupId,
      {
        group_id: groupId,
        station_id: stationId,
        occurred_at: at,
        idempotency_key: key,
      },
      at,
    );
    return { status: "RECORDED", event };
  }

  // 到访对账：以签到为参与证据，核对目标覆盖、缺席与临时替代，给出可解释的改线依据。
  function reconcile(groupId, at = nowIso(), evidence = {}) {
    const hold = holds.get(groupId);
    const request = requests.get(groupId);
    if (!request) throw new ServiceError("UNKNOWN_GROUP", { group_id: groupId });

    const finalLegs = hold?.legs ?? finalLegsByGroup.get(groupId) ?? [];
    const attendedStationIds = new Set(
      [...checkinsByLeg.entries()]
        .filter(([legKey]) => legKey.startsWith(`${groupId}:`))
        .map(([, payload]) => payload.station_id),
    );

    const absentLegs = finalLegs.filter((leg) => !attendedStationIds.has(leg.station_id));
    const attendedLegs = finalLegs.filter((leg) => attendedStationIds.has(leg.station_id));
    const coveredObjectives = [...new Set(attendedLegs.map((leg) => leg.objective))];

    const history = routeHistory.get(groupId) ?? [];
    const substitutions = history.flatMap((change) =>
      change.added_legs.map((leg) => ({
        at: change.at,
        reason: change.reason,
        objective: leg.objective,
        replacement_station_id: leg.station_id,
        replacement_mentor_id: leg.mentor_id,
        replaced_station_ids: change.removed_legs
          .filter((removed) => removed.objective === leg.objective)
          .map((removed) => removed.station_id),
        resource_basis: (change.added_resource_basis ?? []).find(
          (basis) => basis.station_id === leg.station_id && basis.objective === leg.objective,
        ),
      })),
    );

    const explanation = buildExplanation({
      request,
      finalLegs,
      history,
      absentLegs,
      note: evidence.note,
    });

    const event = (() => {
      // 对账结束原子释放仍持有的占用，释放与对账在同一命令批次内完成。
      if (hold) {
        append(
          "HOLD_RELEASED",
          groupId,
          { group_id: groupId, proposal_id: hold.proposal_id, reason: "RECONCILED", legs: hold.legs },
          at,
        );
      }
      return append(
        "VISIT_RECONCILED",
        groupId,
        {
          group_id: groupId,
          planned_objectives: request.learning_objectives,
          covered_objectives: coveredObjectives,
          absent_legs: absentLegs,
          substitutions,
          evidence: { checkin_count: attendedStationIds.size, ...evidence },
          explanation,
        },
        at,
      );
    })();
    promoteWaitlist(at);
    return { status: "RECONCILED", reconciliation: reconciliations.get(groupId), event };
  }

  function buildExplanation({ request, finalLegs, history, absentLegs, note }) {
    const lines = [];
    lines.push(
      `团组 ${request.group_id} 计划目标 ${request.learning_objectives.length} 项，实际到访工位 ${finalLegs.length} 个。`,
    );
    for (const change of history) {
      const removed = change.removed_legs.map((leg) => `${leg.station_id}(${leg.objective})`).join("、");
      const added = change.added_legs.map((leg) => `${leg.station_id}(${leg.objective})`).join("、") || "无";
      const cancelled = change.cancelled_legs
        .map((item) => `${item.leg.station_id}:${item.reason}`)
        .join("、");
      lines.push(`- ${change.at} 因「${change.reason}」停用 ${removed}；替换为 ${added}${cancelled ? `；取消 ${cancelled}` : ""}。`);
    }
    if (absentLegs.length) {
      lines.push(`- 缺席工位：${absentLegs.map((leg) => leg.station_id).join("、")}。`);
    }
    if (note) lines.push(`- 带队老师备注：${note}`);
    return lines.join("\n");
  }

  // ---- 快照与重放（崩溃恢复的核心：状态完全由事件决定）----
  function snapshot() {
    return {
      sequence,
      events: events.map((event) => structuredClone(event)),
      groups: {
        active_holds: [...holds.entries()].map(([groupId, hold]) => [groupId, structuredClone(hold)]),
        waitlist: structuredClone(waitlist),
        proposals: [...proposals.entries()].map(([id, proposal]) => [id, { ...proposal }]),
        checkins: [...checkins.keys()],
        reconciled: [...reconciliations.keys()],
      },
    };
  }

  // 调试视图：返回真实引用（用于断言"未变行程原样保留"等对象同一性）；持久化用 snapshot()。
  function debugState() {
    return {
      active_holds: [...holds.entries()],
      waitlist,
      proposals: [...proposals.entries()],
      checkins: [...checkins.keys()],
      reconciled: [...reconciliations.keys()],
    };
  }

  return {
    ingest,
    registerRequest,
    registerStation,
    declareUnavailable,
    propose,
    confirm,
    reject,
    tick,
    recover,
    recordCheckIn,
    reconcile,
    snapshot,
    debugState,
    // 测试/重放辅助
    _events: events,
    _setSequence(value) {
      sequence = value;
    },
  };
}

// 由事件日志重建服务：重放只演进状态，不再触发派生事件。
// 重放后截止时间保持原值，调用 recover(at) 即按原截止时间继续释放与候补推进。
export function replayService(eventLog, options = {}) {
  const service = createService(options);
  let maxSequence = 0;
  for (const event of eventLog) {
    service.ingest(structuredClone(event), { replay: true });
    const match = /^evt-(\d+)$/.exec(event.event_id ?? "");
    if (match) maxSequence = Math.max(maxSequence, Number(match[1]));
  }
  service._setSequence?.(maxSequence);
  return service;
}

export { EVENT_KINDS, RELEASE_REASONS };
