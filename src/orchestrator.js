// 弹性编排服务：在「团组请求 / 工位容量 / 行程暂占 / 路线重排 / 到访对账」
// 事件骨架上实现的领域服务。
//
// 设计要点：
//   - 事件溯源：所有状态变化先追加事件再重放得到状态；Orchestrator.fromEvents
//     可在服务恢复后重建状态，截止时间（hold_until）是事件中的绝对时间，
//     恢复后 tick 仍按原截止时间释放与推进候补。
//   - 建议与暂占分离：suggestPlan 只是计算（规划器纯函数），不占容量；
//     老师 confirmPlan 后才暂占资源，且确认时重新校验容量与资质。
//   - 一个团组一套有效方案：确认新方案会原子地先释放旧方案再暂占新方案。
//   - 原子释放：拒绝 / 超时通过单个 HOLD_RELEASED 事件释放方案全部节点。
//   - 幂等：重复确认同一方案、重复同步同一签到（checkin_id）都不会多占容量。
//   - 局部停用：工位容量事件后自动检测受影响节点并重排，保留未变行程。

import { validateEvent } from "./skill_museum_learning.js";
import { computeSuggestion, groupBounds, stationSupports } from "./planner.js";
import { computeReconciliation } from "./reconcile.js";
import { overlaps, ts, within } from "./util.js";

export class OrchestratorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    this.details = details;
  }
}

const ACTIVE_PLAN_STATUSES = new Set(["HELD", "FINALIZED"]);

function normalizeRequest(cmd, revision) {
  return {
    group_id: cmd.group_id,
    headcount: cmd.headcount,
    goals: [...new Set(cmd.goals)],
    time_window: { start: cmd.time_window.start, end: cmd.time_window.end },
    ...(cmd.transport
      ? { transport: { earliest_start: cmd.transport.earliest_start, latest_end: cmd.transport.latest_end } }
      : {}),
    support_needs: [...(cmd.support_needs ?? [])],
    revision,
    ...(cmd.school ? { school: cmd.school } : {}),
  };
}

function normalizeStation(payload) {
  const closed = new Set(payload.closed_slots ?? []);
  return {
    station_id: payload.station_id,
    venue_id: payload.venue_id ?? null,
    skills: [...(payload.skills ?? [])],
    mentor_skills: [...(payload.mentor_skills ?? [])],
    support_features: [...(payload.support_features ?? [])],
    slots: new Map(
      (payload.slots ?? []).map((slot) => [
        slot.slot_id,
        {
          slot_id: slot.slot_id,
          start: slot.start,
          end: slot.end,
          capacity: slot.capacity,
          closed: closed.has(slot.slot_id) || slot.closed === true,
        },
      ]),
    ),
  };
}

export class Orchestrator {
  constructor() {
    this.events = [];
    this.groups = new Map(); // group_id → {request}
    this.stations = new Map(); // station_id → 工位定义（slots 为 Map）
    this.suggestions = new Map(); // plan_id → 建议（SUGGESTED / CONFIRMED）
    this.plans = new Map(); // plan_id → 方案（HELD / FINALIZED / RELEASED / EXPIRED / COMPLETED）
    this.checkins = new Map(); // checkin_id → 签到记录
    this.reconciliations = new Map(); // group_id → 对账结果
  }

  // 服务恢复：重放事件流重建状态，截止时间等均以事件中的绝对时间为准。
  static fromEvents(events) {
    const orchestrator = new Orchestrator();
    for (const event of events) orchestrator.apply(event);
    return orchestrator;
  }

  apply(event) {
    const problems = validateEvent(event);
    if (problems.length) {
      throw new OrchestratorError("INVALID_EVENT", `事件不符合领域约定: ${problems.join(", ")}`, { problems, event });
    }
    this._reduce(event);
    this.events.push(event);
    return event;
  }

  _append(kind, subjectId, payload, { now, eventId } = {}) {
    const occurredAt = now ?? new Date().toISOString();
    return this.apply({
      event_id: eventId ?? `E${this.events.length + 1}`,
      kind,
      occurred_at: occurredAt,
      subject_id: subjectId,
      payload,
    });
  }

  _reduce(event) {
    const p = event.payload;
    switch (event.kind) {
      case "GROUP_REQUESTED":
        this.groups.set(p.group_id, { request: normalizeRequest(p, p.revision ?? 1) });
        break;
      case "STATION_CAPACITY_SET":
        this.stations.set(p.station_id, normalizeStation(p));
        break;
      case "PLAN_SUGGESTED":
        this.suggestions.set(p.plan_id, {
          plan_id: p.plan_id,
          group_id: p.group_id,
          nodes: p.nodes.map((n) => ({ ...n })),
          unmet_goals: p.unmet_goals.map((u) => ({ ...u })),
          rationale: p.rationale,
          status: "SUGGESTED",
          suggested_at: event.occurred_at,
        });
        break;
      case "ITINERARY_HELD": {
        this.plans.set(p.plan_id, {
          plan_id: p.plan_id,
          group_id: p.group_id,
          version: p.version,
          status: "HELD",
          nodes: p.nodes.map((n) => ({ ...n })),
          hold_until: p.hold_until,
          held_at: event.occurred_at,
        });
        const suggestion = this.suggestions.get(p.plan_id);
        if (suggestion) suggestion.status = "CONFIRMED";
        break;
      }
      case "PLAN_FINALIZED": {
        const plan = this.plans.get(p.plan_id);
        if (plan) plan.status = "FINALIZED";
        break;
      }
      case "HOLD_RELEASED": {
        const plan = this.plans.get(p.plan_id);
        if (plan) {
          plan.status = p.reason === "EXPIRED" ? "EXPIRED" : "RELEASED";
          plan.released_reason = p.reason;
        }
        break;
      }
      case "ROUTE_REPLANNED": {
        const plan = this.plans.get(p.plan_id);
        if (!plan) break;
        const removed = new Set(p.removed_nodes.map((n) => n.node_id));
        plan.nodes = plan.nodes.filter((n) => !removed.has(n.node_id)).concat(p.added_nodes.map((n) => ({ ...n })));
        plan.version = p.version;
        break;
      }
      case "CHECK_IN_RECORDED":
        if (!this.checkins.has(p.checkin_id)) this.checkins.set(p.checkin_id, { ...p });
        break;
      case "WAITLIST_PROMOTED": {
        const plan = this.plans.get(p.plan_id);
        const node = plan?.nodes.find((n) => n.node_id === p.node_id);
        if (node) node.status = "HELD";
        break;
      }
      case "VISIT_RECONCILED": {
        this.reconciliations.set(p.group_id, p);
        const plan = this.plans.get(p.plan_id);
        if (plan) plan.status = "COMPLETED";
        break;
      }
      default:
        throw new OrchestratorError("INVALID_EVENT", `未知事件种类: ${event.kind}`);
    }
  }

  // ---------- 查询 ----------

  getGroup(groupId) {
    const entry = this.groups.get(groupId);
    return entry ? structuredClone(entry.request) : null;
  }

  getStation(stationId) {
    const station = this.stations.get(stationId);
    return station ? structuredClone({ ...station, slots: [...station.slots.values()] }) : null;
  }

  getPlan(planId) {
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan) : null;
  }

  getSuggestion(planId) {
    const suggestion = this.suggestions.get(planId);
    return suggestion ? structuredClone(suggestion) : null;
  }

  getActivePlan(groupId) {
    const plan = this._activePlan(groupId);
    return plan ? structuredClone(plan) : null;
  }

  reconciliationFor(groupId) {
    const payload = this.reconciliations.get(groupId);
    return payload ? structuredClone(payload) : null;
  }

  // 某工位时段已被暂占的人数（不含候补，签到不影响容量）。
  usageAt(stationId, slotId, excludePlanId = null) {
    return this._usageAt(stationId, slotId, excludePlanId);
  }

  waitlistEntries() {
    const entries = [];
    for (const plan of this.plans.values()) {
      if (!ACTIVE_PLAN_STATUSES.has(plan.status)) continue;
      for (const node of plan.nodes) {
        if (node.status === "WAITLISTED") entries.push({ plan_id: plan.plan_id, group_id: plan.group_id, ...structuredClone(node) });
      }
    }
    return entries.sort((a, b) => ts(a.waitlisted_at) - ts(b.waitlisted_at) || a.node_id.localeCompare(b.node_id));
  }

  _activePlan(groupId) {
    for (const plan of this.plans.values()) {
      if (plan.group_id === groupId && ACTIVE_PLAN_STATUSES.has(plan.status)) return plan;
    }
    return null;
  }

  _usageAt(stationId, slotId, excludePlanId = null) {
    let total = 0;
    for (const plan of this.plans.values()) {
      if (!ACTIVE_PLAN_STATUSES.has(plan.status)) continue;
      if (plan.plan_id === excludePlanId) continue;
      for (const node of plan.nodes) {
        if (node.status === "HELD" && node.station_id === stationId && node.slot_id === slotId) {
          total += this.groups.get(plan.group_id).request.headcount;
        }
      }
    }
    return total;
  }

  // ---------- 命令 ----------

  // 团组提交研学请求。已有有效方案时拒绝重复提交（先拒绝旧方案再变更）。
  submitGroupRequest(cmd, { now, eventId } = {}) {
    const problems = [];
    if (typeof cmd.group_id !== "string" || !cmd.group_id) problems.push("group_id");
    if (!Number.isInteger(cmd.headcount) || cmd.headcount <= 0) problems.push("headcount");
    if (!Array.isArray(cmd.goals) || !cmd.goals.length || cmd.goals.some((g) => typeof g !== "string" || !g)) {
      problems.push("goals");
    }
    const window = cmd.time_window;
    try {
      if (!window || ts(window.start) >= ts(window.end)) problems.push("time_window");
    } catch {
      problems.push("time_window");
    }
    try {
      if (cmd.transport && ts(cmd.transport.earliest_start) >= ts(cmd.transport.latest_end)) problems.push("transport");
    } catch {
      problems.push("transport");
    }
    if (problems.length) throw new OrchestratorError("INVALID_REQUEST", `团组请求不合法: ${problems.join(", ")}`, { problems });

    const existing = this.groups.get(cmd.group_id);
    if (existing) {
      if (this._activePlan(cmd.group_id)) {
        throw new OrchestratorError("ACTIVE_PLAN_EXISTS", "团组已持有有效方案，请先拒绝或等待释放后再变更请求");
      }
      const incoming = normalizeRequest(cmd, existing.request.revision);
      if (JSON.stringify(incoming) === JSON.stringify(existing.request)) return structuredClone(existing.request);
    }
    const request = normalizeRequest(cmd, cmd.revision ?? (existing ? existing.request.revision + 1 : 1));
    this._append("GROUP_REQUESTED", cmd.group_id, { ...request }, { now, eventId });
    return structuredClone(request);
  }

  // 设置工位容量（含开放时段、技能、讲解员资质、支持特性、停用时段）。
  // 设置后自动检测受影响的有效方案并重排，保留未变行程；容量增加后推进候补。
  setStationCapacity(cmd, { now, eventId } = {}) {
    const problems = [];
    if (typeof cmd.station_id !== "string" || !cmd.station_id) problems.push("station_id");
    if (!Array.isArray(cmd.slots)) problems.push("slots");
    for (const slot of cmd.slots ?? []) {
      if (!slot.slot_id) {
        problems.push("slots.slot_id");
        continue;
      }
      try {
        if (ts(slot.start) >= ts(slot.end)) problems.push(`slots.${slot.slot_id}`);
      } catch {
        problems.push(`slots.${slot.slot_id}`);
      }
      if (!Number.isInteger(slot.capacity) || slot.capacity < 0) problems.push(`slots.${slot.slot_id}.capacity`);
    }
    if (problems.length) throw new OrchestratorError("INVALID_STATION", `工位容量不合法: ${problems.join(", ")}`, { problems });

    const slots = cmd.slots.map((slot) => ({
      slot_id: slot.slot_id,
      start: slot.start,
      end: slot.end,
      capacity: slot.capacity,
    }));
    const closedSlots = new Set(cmd.closed_slots ?? []);
    for (const slot of cmd.slots) if (slot.closed === true) closedSlots.add(slot.slot_id);
    const payload = {
      station_id: cmd.station_id,
      venue_id: cmd.venue_id ?? null,
      skills: [...(cmd.skills ?? [])],
      mentor_skills: [...(cmd.mentor_skills ?? [])],
      support_features: [...(cmd.support_features ?? [])],
      slots,
      closed_slots: [...closedSlots],
    };
    this._append("STATION_CAPACITY_SET", cmd.station_id, payload, { now, eventId });

    // 局部停用 / 调减：对受影响方案做弹性重排。
    const affected = [];
    const candidates = [...this.plans.values()]
      .filter(
        (plan) =>
          ACTIVE_PLAN_STATUSES.has(plan.status) &&
          plan.nodes.some((node) => node.status === "HELD" && node.station_id === cmd.station_id),
      )
      .sort((a, b) => a.plan_id.localeCompare(b.plan_id));
    for (const plan of candidates) {
      const invalid = this._invalidNodeIds(plan, cmd.station_id);
      if (!invalid.size) continue;
      this._replan(plan, invalid, {
        now,
        reason: "STATION_CAPACITY_CHANGED",
        trigger: { station_id: cmd.station_id, causes: Object.fromEntries(invalid) },
      });
      affected.push(plan.plan_id);
    }
    const promoted = this._promoteWaitlist({ now });
    return { affected, promoted };
  }

  // 计算建议方案：纯计算 + 记录建议事件，不占用任何容量。
  suggestPlan(groupId, { now, eventId, planId } = {}) {
    const entry = this.groups.get(groupId);
    if (!entry) throw new OrchestratorError("GROUP_NOT_FOUND", `未找到团组请求: ${groupId}`);
    const request = entry.request;
    const active = this._activePlan(groupId);
    const remainingCapacity = (stationId, slotId) => {
      const slot = this.stations.get(stationId)?.slots.get(slotId);
      if (!slot) return 0;
      return slot.capacity - this._usageAt(stationId, slotId, active?.plan_id ?? null);
    };
    const result = computeSuggestion({ request, stations: [...this.stations.values()], remainingCapacity });
    const seq = [...this.suggestions.values()].filter((s) => s.group_id === groupId).length + 1;
    const finalPlanId = planId ?? `P-${groupId}-${seq}`;
    const nodes = result.nodes.map((node, index) => ({ node_id: `${finalPlanId}-n${index + 1}`, ...node }));
    this._append(
      "PLAN_SUGGESTED",
      groupId,
      { plan_id: finalPlanId, group_id: groupId, nodes, unmet_goals: result.unmet_goals, rationale: result.rationale },
      { now, eventId },
    );
    return this.getSuggestion(finalPlanId);
  }

  // 老师确认建议：重新校验通过后暂占资源。重复确认同一方案是幂等空操作；
  // 确认不同方案会原子地先释放旧方案（一套有效方案）。
  confirmPlan(groupId, planId, { now, eventId, holdUntil } = {}) {
    const suggestion = this.suggestions.get(planId);
    if (!suggestion || suggestion.group_id !== groupId) {
      throw new OrchestratorError("SUGGESTION_NOT_FOUND", `未找到团组 ${groupId} 的建议方案: ${planId}`);
    }
    const active = this._activePlan(groupId);
    if (active && active.plan_id === planId) return this.getPlan(planId); // 重复确认：不多占容量
    if (suggestion.status !== "SUGGESTED") {
      throw new OrchestratorError("SUGGESTION_STALE", "该建议已被确认过，请重新计算建议");
    }
    const nowIso = now ?? new Date().toISOString();
    if (!holdUntil || ts(holdUntil) <= ts(nowIso)) {
      throw new OrchestratorError("INVALID_HOLD_UNTIL", "暂占截止时间必须晚于当前时间");
    }
    const request = this.groups.get(groupId).request;
    const availableNodes = suggestion.nodes.filter((n) => n.status === "AVAILABLE");
    const waitlistNodes = suggestion.nodes.filter((n) => n.status === "WAITLIST");
    if (!availableNodes.length && !waitlistNodes.length) {
      throw new OrchestratorError("EMPTY_PLAN", "建议不含任何可暂占或候补的节点");
    }

    // 确认时按当前状态重新校验：建议可能已过期（容量被占、资质变化、时段停用）。
    const bounds = groupBounds(request);
    const problems = [];
    for (const node of availableNodes) {
      const station = this.stations.get(node.station_id);
      const slot = station?.slots.get(node.slot_id);
      if (!station || !slot || slot.closed) problems.push({ node_id: node.node_id, cause: "SLOT_CLOSED" });
      else if (slot.start !== node.start || slot.end !== node.end) problems.push({ node_id: node.node_id, cause: "SLOT_TIME_CHANGED" });
      else if (!within(node, bounds.start, bounds.end)) problems.push({ node_id: node.node_id, cause: "OUTSIDE_WINDOW" });
      else if (!stationSupports(station, request, node.goals)) problems.push({ node_id: node.node_id, cause: "CAPABILITY_CHANGED" });
      else {
        const remaining = slot.capacity - this._usageAt(node.station_id, node.slot_id, active?.plan_id ?? null);
        if (remaining < request.headcount) problems.push({ node_id: node.node_id, cause: "NO_CAPACITY", remaining });
      }
    }
    if (problems.length) {
      throw new OrchestratorError("PLAN_STALE", "建议已失效，请重新计算后再确认", { problems });
    }

    if (active) {
      this._append(
        "HOLD_RELEASED",
        groupId,
        {
          plan_id: active.plan_id,
          group_id: groupId,
          reason: "SUPERSEDED",
          released_nodes: active.nodes.filter((n) => n.status === "HELD").map((n) => n.node_id),
          released_all: true,
        },
        { now: nowIso },
      );
    }
    const nodes = [
      ...availableNodes.map((n) => ({ ...n, status: "HELD" })),
      ...waitlistNodes.map((n) => ({ ...n, status: "WAITLISTED", waitlisted_at: nowIso })),
    ];
    this._append(
      "ITINERARY_HELD",
      groupId,
      {
        plan_id: planId,
        group_id: groupId,
        version: 1,
        nodes,
        hold_until: holdUntil,
        supersedes: active?.plan_id ?? null,
        rationale: suggestion.rationale,
      },
      { now: nowIso, eventId },
    );
    this._promoteWaitlist({ now: nowIso });
    return this.getPlan(planId);
  }

  // 学校/场馆最终确认：方案不再因超时释放，容量承诺保留到对账。
  finalizePlan(groupId, { now, eventId } = {}) {
    const plan = this._activePlan(groupId);
    if (!plan) throw new OrchestratorError("NO_ACTIVE_PLAN", `团组 ${groupId} 没有有效方案`);
    if (plan.status === "FINALIZED") return this.getPlan(plan.plan_id); // 幂等
    this._append("PLAN_FINALIZED", groupId, { plan_id: plan.plan_id, group_id: groupId }, { now, eventId });
    return this.getPlan(plan.plan_id);
  }

  // 拒绝方案：原子释放全部占用。重复拒绝是幂等空操作。
  rejectPlan(groupId, { now, eventId, reason = "REJECTED" } = {}) {
    const plan = this._activePlan(groupId);
    if (!plan) return null;
    this._append(
      "HOLD_RELEASED",
      groupId,
      {
        plan_id: plan.plan_id,
        group_id: groupId,
        reason,
        released_nodes: plan.nodes.filter((n) => n.status === "HELD").map((n) => n.node_id),
        released_all: true,
      },
      { now, eventId },
    );
    const promoted = this._promoteWaitlist({ now });
    return { released: plan.plan_id, promoted };
  }

  // 离线签到：只记录参与证据，永不占用容量；同一 checkin_id 重复同步不多计。
  checkIn(cmd, { now, eventId } = {}) {
    const problems = [];
    if (typeof cmd.checkin_id !== "string" || !cmd.checkin_id) problems.push("checkin_id");
    if (typeof cmd.group_id !== "string" || !cmd.group_id) problems.push("group_id");
    if (typeof cmd.station_id !== "string" || !cmd.station_id) problems.push("station_id");
    if (!cmd.checked_at || Number.isNaN(Date.parse(cmd.checked_at))) problems.push("checked_at");
    if (problems.length) throw new OrchestratorError("INVALID_CHECKIN", `签到不合法: ${problems.join(", ")}`, { problems });

    const existing = this.checkins.get(cmd.checkin_id);
    if (existing) return { record: structuredClone(existing), duplicate: true };
    const payload = {
      checkin_id: cmd.checkin_id,
      group_id: cmd.group_id,
      station_id: cmd.station_id,
      ...(cmd.slot_id ? { slot_id: cmd.slot_id } : {}),
      checked_at: cmd.checked_at,
      ...(cmd.source ? { source: cmd.source } : {}),
      ...(cmd.headcount ? { headcount: cmd.headcount } : {}),
    };
    this._append("CHECK_IN_RECORDED", cmd.group_id, payload, { now, eventId });
    return { record: structuredClone(payload), duplicate: false };
  }

  // 时钟推进：按原截止时间超时释放（原子），随后推进候补。
  // 服务恢复后调用同一逻辑——截止时间来自事件中的绝对时间，不依赖运行期定时器。
  tick({ now } = {}) {
    const nowIso = now ?? new Date().toISOString();
    const nowMs = ts(nowIso);
    const expiring = [...this.plans.values()]
      .filter((plan) => plan.status === "HELD" && ts(plan.hold_until) <= nowMs)
      .sort((a, b) => ts(a.hold_until) - ts(b.hold_until) || a.plan_id.localeCompare(b.plan_id));
    const expired = [];
    for (const plan of expiring) {
      this._append(
        "HOLD_RELEASED",
        plan.group_id,
        {
          plan_id: plan.plan_id,
          group_id: plan.group_id,
          reason: "EXPIRED",
          released_nodes: plan.nodes.filter((n) => n.status === "HELD").map((n) => n.node_id),
          released_all: true,
        },
        { now: nowIso },
      );
      expired.push(plan.plan_id);
    }
    const promoted = this._promoteWaitlist({ now: nowIso });
    return { expired, promoted };
  }

  // 手动触发重排：检测当前方案中已失效的节点并尽量替换，保留未变行程。
  replanGroup(groupId, { now, reason = "MANUAL" } = {}) {
    const plan = this._activePlan(groupId);
    if (!plan) throw new OrchestratorError("NO_ACTIVE_PLAN", `团组 ${groupId} 没有有效方案`);
    const invalid = this._invalidNodeIds(plan);
    if (!invalid.size) return null;
    const payload = this._replan(plan, invalid, { now, reason, trigger: { reason } });
    this._promoteWaitlist({ now });
    return payload;
  }

  // 到访对账：按实际签到证据核对目标覆盖、缺席与临时替代。幂等。
  reconcile(groupId, { now, eventId } = {}) {
    const existing = this.reconciliations.get(groupId);
    if (existing) return structuredClone(existing);
    const plan = this._activePlan(groupId);
    if (!plan) throw new OrchestratorError("NO_ACTIVE_PLAN", `团组 ${groupId} 没有可对账的有效方案`);
    const request = this.groups.get(groupId).request;
    const replans = this.events.filter((e) => e.kind === "ROUTE_REPLANNED" && e.payload.plan_id === plan.plan_id);
    const payload = computeReconciliation({ request, plan, replans, checkins: [...this.checkins.values()] });
    this._append("VISIT_RECONCILED", groupId, payload, { now, eventId });
    return structuredClone(payload);
  }

  // ---------- 内部 ----------

  // 检测方案中已失效的暂占节点：时段关闭/变更、资质或支持变化、容量调减后被驱逐。
  // 返回 Map<node_id, cause>；stationId 限定检测单个工位。
  _invalidNodeIds(plan, stationId = null) {
    const request = this.groups.get(plan.group_id).request;
    const invalid = new Map();
    const heldNodes = plan.nodes.filter(
      (n) => n.status === "HELD" && (!stationId || n.station_id === stationId),
    );
    for (const node of heldNodes) {
      const station = this.stations.get(node.station_id);
      const slot = station?.slots.get(node.slot_id);
      if (!station || !slot || slot.closed) invalid.set(node.node_id, "SLOT_CLOSED");
      else if (slot.start !== node.start || slot.end !== node.end) invalid.set(node.node_id, "SLOT_TIME_CHANGED");
      else if (!stationSupports(station, request, node.goals)) invalid.set(node.node_id, "CAPABILITY_CHANGED");
    }
    // 容量调减：同一时段按暂占先后保留，后占者超出容量即被驱逐。
    const stationIds = stationId ? [stationId] : [...new Set(heldNodes.map((n) => n.station_id))];
    for (const id of stationIds) {
      const station = this.stations.get(id);
      if (!station) continue;
      for (const slot of station.slots.values()) {
        const holders = [];
        for (const other of this.plans.values()) {
          if (!ACTIVE_PLAN_STATUSES.has(other.status)) continue;
          for (const node of other.nodes) {
            if (node.status === "HELD" && node.station_id === id && node.slot_id === slot.slot_id) {
              holders.push({ plan: other, node, headcount: this.groups.get(other.group_id).request.headcount });
            }
          }
        }
        holders.sort((a, b) => ts(a.plan.held_at) - ts(b.plan.held_at) || a.plan.plan_id.localeCompare(b.plan.plan_id));
        let used = 0;
        for (const holder of holders) {
          used += holder.headcount;
          if (used > slot.capacity && holder.plan.plan_id === plan.plan_id) {
            invalid.set(holder.node.node_id, "CAPACITY_REDUCED");
          }
        }
      }
    }
    return invalid;
  }

  // 弹性重排：释放失效节点，尽量用其他工位替换受影响目标，保留未变节点；
  // 原暂占截止时间不变。全部变更记录在一个 ROUTE_REPLANNED 事件中（原子）。
  _replan(plan, invalid, { now, reason, trigger }) {
    const nowIso = now ?? new Date().toISOString();
    const request = this.groups.get(plan.group_id).request;
    const invalidNodes = plan.nodes.filter((n) => n.status === "HELD" && invalid.has(n.node_id));
    if (!invalidNodes.length) return null;
    const kept = plan.nodes.filter((n) => n.status === "HELD" && !invalid.has(n.node_id));
    // 只需重新安置失效节点覆盖的目标；保留节点已覆盖的目标不参与重排
    const goalsToPlace = [...new Set(invalidNodes.flatMap((n) => n.goals))];
    const remainingCapacity = (stationId, slotId) => {
      const slot = this.stations.get(stationId)?.slots.get(slotId);
      if (!slot) return 0;
      const keptOnSlot = kept.filter((n) => n.station_id === stationId && n.slot_id === slotId).length;
      return slot.capacity - this._usageAt(stationId, slotId, plan.plan_id) - keptOnSlot * request.headcount;
    };
    const suggestion = computeSuggestion({
      request: { ...request, goals: goalsToPlace },
      stations: [...this.stations.values()],
      remainingCapacity,
      keptNodes: kept,
    });
    const version = plan.version + 1;
    const addedNodes = suggestion.nodes.map((node, index) => ({
      node_id: `${plan.plan_id}-v${version}-n${index + 1}`,
      ...node,
      status: node.status === "AVAILABLE" ? "HELD" : "WAITLISTED",
      ...(node.status === "WAITLIST" ? { waitlisted_at: nowIso } : {}),
    }));
    const capacityBefore = new Map();
    for (const item of suggestion.rationale.nodes) {
      capacityBefore.set(`${item.station_id}/${item.slot_id}`, item.remaining_capacity_before);
    }
    for (const item of suggestion.rationale.waitlist) {
      capacityBefore.set(`${item.station_id}/${item.slot_id}`, item.remaining_capacity);
    }
    const replaced = invalidNodes.map((oldNode) => {
      const newNodes = addedNodes.filter((n) => n.goals.some((g) => oldNode.goals.includes(g)));
      return {
        old_node: { ...oldNode },
        goals: oldNode.goals.filter((g) => newNodes.some((n) => n.goals.includes(g))),
        new_nodes: newNodes,
        resource_basis: {
          trigger,
          cause: invalid.get(oldNode.node_id),
          new_slots: newNodes.map((n) => ({
            station_id: n.station_id,
            slot_id: n.slot_id,
            headcount: request.headcount,
            remaining_capacity_before: capacityBefore.get(`${n.station_id}/${n.slot_id}`) ?? null,
          })),
        },
      };
    });
    const payload = {
      plan_id: plan.plan_id,
      group_id: plan.group_id,
      version,
      reason,
      trigger,
      kept_nodes: kept.map((n) => ({ ...n })),
      removed_nodes: invalidNodes.map((n) => ({ ...n })),
      added_nodes: addedNodes,
      replaced,
      dropped_goals: suggestion.unmet_goals.map((u) => ({ goals: [u.goal], cause: u.cause })),
      hold_until: plan.hold_until,
    };
    this._append("ROUTE_REPLANNED", plan.group_id, payload, { now: nowIso });
    return structuredClone(payload);
  }

  // 候补推进：按登记顺序检查候补节点，容量、资质、时间均满足即转为暂占。
  _promoteWaitlist({ now } = {}) {
    const promoted = [];
    for (const entry of this.waitlistEntries()) {
      const plan = this.plans.get(entry.plan_id);
      const request = this.groups.get(plan.group_id).request;
      const node = plan.nodes.find((n) => n.node_id === entry.node_id);
      const station = this.stations.get(node.station_id);
      const slot = station?.slots.get(node.slot_id);
      if (!station || !slot || slot.closed) continue;
      if (slot.start !== node.start || slot.end !== node.end) continue;
      const bounds = groupBounds(request);
      if (!within(node, bounds.start, bounds.end)) continue;
      if (!stationSupports(station, request, node.goals)) continue;
      if (this._usageAt(node.station_id, node.slot_id) + request.headcount > slot.capacity) continue;
      if (plan.nodes.some((n) => n.status === "HELD" && overlaps(n, node))) continue;
      this._append(
        "WAITLIST_PROMOTED",
        plan.group_id,
        {
          plan_id: plan.plan_id,
          group_id: plan.group_id,
          node_id: node.node_id,
          station_id: node.station_id,
          slot_id: node.slot_id,
          goals: node.goals,
        },
        { now },
      );
      promoted.push({ plan_id: plan.plan_id, node_id: node.node_id });
    }
    return promoted;
  }
}
