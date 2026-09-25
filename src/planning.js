// 纯函数规划器：把团组请求与场馆工位/导师/开放时段匹配成建议路线。
// 不暂占任何资源；调用方（service）只在老师确认后才写入占用。
// 所有时间均为 ISO 字符串，比较时统一转毫秒数。

const DEFAULT_LEG_MINUTES = 45;

const t = (value) => new Date(value).getTime();

export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return t(aStart) < t(bEnd) && t(bStart) < t(aEnd);
}

function travelMinutesBetween(fromStation, toStation, world) {
  if (!fromStation) return 0;
  if (fromStation.station_id === toStation.station_id) return 0;
  const explicit = world.travel?.[fromStation.station_id]?.[toStation.station_id];
  if (Number.isFinite(explicit)) return explicit;
  if (fromStation.museum_id === toStation.museum_id) return world.intra_museum_minutes ?? 5;
  return world.inter_museum_minutes ?? 20;
}

function mentorCoversNeed(mentor, need) {
  return (mentor.support ?? []).includes(need) || (mentor.certifications ?? []).includes(need);
}

function stationCoversNeed(station, need) {
  return (station.accessibility ?? []).includes(need);
}

// 讲解员资质：具备目标技能，且满足团组对该目标要求的资质/支持项。
function mentorQualifies(mentor, objective, needs, requiredCerts, requiredCertsByObjective = {}, supportByObjective = {}) {
  if (!(mentor.skills ?? []).includes(objective)) return { ok: false, reason: "NO_MENTOR_SKILL" };
  for (const cert of [...(requiredCerts ?? []), ...(requiredCertsByObjective[objective] ?? [])]) {
    if (!(mentor.certifications ?? []).includes(cert)) return { ok: false, reason: "MENTOR_CERTIFICATION" };
  }
  const supportNeeds = [...(needs ?? []), ...(supportByObjective[objective] ?? [])];
  for (const need of supportNeeds) {
    // 设施类支持由工位承担；人员类支持（如手语）必须随讲解员具备。
    if (!stationCoversNeedGuaranteed(need) && !mentorCoversNeed(mentor, need)) {
      return { ok: false, reason: "MENTOR_SUPPORT" };
    }
  }
  return { ok: true };
}

// 默认约定：设施类无障碍需求由工位的 accessibility 承担，其余（手语讲解等）随讲解员。
const FACILITY_NEEDS = new Set(["wheelchair", "elevator", "accessible_restroom"]);
function stationCoversNeedGuaranteed(need) {
  return FACILITY_NEEDS.has(need);
}

function stationOpen(station, start, end) {
  const opening = station.opening;
  if (!opening) return false;
  return t(start) >= t(opening.start) && t(end) <= t(opening.end);
}

function mentorFree(mentor, start, end) {
  const windows = mentor.available;
  if (!windows || windows.length === 0) return true; // 未登记可用窗时默认随场馆开放
  return windows.some((w) => t(start) >= t(w.start) && t(end) <= t(w.end));
}

// 汇总在 [start,end) 内某工位已被占用的席位数（讲解员冲突另行全局检查）。
function seatsUsedAt(occupancy, stationId, start, end) {
  let seats = 0;
  for (const leg of occupancy ?? []) {
    if (leg.station_id === stationId && intervalsOverlap(start, end, leg.start, leg.end)) {
      seats += leg.seats ?? 1;
    }
  }
  return seats;
}

// 为单个学习目标寻找最早可行的（工位, 讲解员, 时段）。
// bounds: { earliest, latest, ignoreStationIds }；latest 为该腿必须结束的时刻。
export function findLeg(objective, request, world, occupancy, options = {}) {
  const {
    earliest,
    latest,
    fromStation = null,
    planLegs = [],
    ignoreStationIds = [],
  } = options;
  const needs = request.accessibility_needs ?? [];
  const requiredCerts = request.required_mentor_certifications ?? [];
  const requiredCertsByObjective = request.required_certifications_by_objective ?? {};
  const supportByObjective = request.support_needs_by_objective ?? {};
  const legMinutes = request.objective_minutes?.[objective] ?? world.default_leg_minutes ?? DEFAULT_LEG_MINUTES;
  const diagnostics = [];

  const candidates = (world.stations ?? [])
    .filter((station) => (station.objectives ?? []).includes(objective))
    .sort((a, b) => scoreStation(a, fromStation) - scoreStation(b, fromStation));

  for (const station of candidates) {
    const diag = { station_id: station.station_id, attempts: [] };
    if (station.disabled || ignoreStationIds.includes(station.station_id)) {
      diag.reason = "DISABLED";
      diagnostics.push(diag);
      continue;
    }
    const missingFacility = needs.find(
      (need) => stationCoversNeedGuaranteed(need) && !stationCoversNeed(station, need),
    );
    if (missingFacility) {
      diag.reason = "ACCESSIBILITY";
      diag.detail = missingFacility;
      diagnostics.push(diag);
      continue;
    }

    const travel = travelMinutesBetween(fromStation, station, world);
    const baseStart = fromStation
      ? t(fromStation.end ?? earliest) + travel * 60000
      : t(earliest);
    const held = [...(occupancy ?? []), ...planLegs];

    // 沿时间轴收集候选起点：最早可达、闭馆窗结束、占用/讲解员忙段结束、讲解员可用窗开始。
    const candidateTimes = new Set([Math.max(baseStart, t(earliest))]);
    for (const window of station.unavailable_windows ?? []) {
      if (t(window.to) > baseStart) candidateTimes.add(Math.max(t(window.to), baseStart));
    }
    for (const busy of held) {
      const atStation = busy.station_id === station.station_id;
      const mentorHere = (station.mentors ?? []).some((candidate) => candidate.mentor_id === busy.mentor_id);
      if (!atStation && !mentorHere) continue;
      const busyStation = (world.stations ?? []).find((item) => item.station_id === busy.station_id);
      const mentorTravel = mentorHere && busyStation ? travelMinutesBetween(busyStation, station, world) : 0;
      if (t(busy.end) + mentorTravel * 60000 > baseStart) {
        candidateTimes.add(Math.max(t(busy.end) + mentorTravel * 60000, baseStart));
      }
    }
    for (const mentor of station.mentors ?? []) {
      for (const window of mentor.available ?? []) {
        if (t(window.start) > baseStart) candidateTimes.add(t(window.start));
      }
    }

    let succeeded = null;
    for (const startTime of [...candidateTimes].sort((a, b) => a - b)) {
      const legStart = new Date(startTime);
      const legEnd = addMinutes(legStart, legMinutes);
      if (t(legEnd) > t(latest)) break; // 之后的起点只会更晚
      const attempt = { start: legStart.toISOString(), end: legEnd.toISOString() };

      if (t(legStart) < t(earliest)) continue;
      if (!stationOpen(station, legStart, legEnd)) {
        attempt.reason = "CLOSED";
        diag.attempts.push(attempt);
        continue;
      }
      const blocked = (station.unavailable_windows ?? []).find((window) =>
        intervalsOverlap(legStart, legEnd, window.from, window.to),
      );
      if (blocked) {
        attempt.reason = "TEMPORARILY_CLOSED";
        attempt.detail = blocked;
        diag.attempts.push(attempt);
        continue;
      }

      const seats = seatsUsedAt(held, station.station_id, legStart, legEnd);
      if (seats + request.size > station.capacity) {
        attempt.reason = "CAPACITY";
        attempt.detail = { used: seats, capacity: station.capacity, requested: request.size };
        diag.attempts.push(attempt);
        continue;
      }

      // 讲解员不能在任意工位的时间重叠段被重复安排。
      const globallyBusy = new Set(
        held
          .filter((item) => item.mentor_id && intervalsOverlap(legStart, legEnd, item.start, item.end))
          .map((item) => item.mentor_id),
      );

      const selectedMentor = (station.mentors ?? []).find((candidate) => {
        const q = mentorQualifies(candidate, objective, needs, requiredCerts, requiredCertsByObjective, supportByObjective);
        if (!q.ok) return false;
        if (globallyBusy.has(candidate.mentor_id)) return false;
        if (!mentorFree(candidate, legStart, legEnd)) return false;
        return true;
      });
      if (!selectedMentor) {
        attempt.reason = "NO_AVAILABLE_MENTOR";
        attempt.detail = (station.mentors ?? []).map((candidate) => ({
          mentor_id: candidate.mentor_id,
          ...mentorQualifies(candidate, objective, needs, requiredCerts, requiredCertsByObjective, supportByObjective),
          busy: globallyBusy.has(candidate.mentor_id),
          free: mentorFree(candidate, legStart, legEnd),
        }));
        diag.attempts.push(attempt);
        continue;
      }

      succeeded = {
        leg: {
          station_id: station.station_id,
          museum_id: station.museum_id,
          mentor_id: selectedMentor.mentor_id,
          objective,
          start: legStart.toISOString(),
          end: legEnd.toISOString(),
          seats: request.size,
        },
        resource_basis: {
          objective,
          station_id: station.station_id,
          mentor_id: selectedMentor.mentor_id,
          travel_from_prev_minutes: travel,
          capacity: { used: seats, capacity: station.capacity, remaining: station.capacity - seats - request.size },
          matched_features: (station.accessibility ?? []).filter((code) => needs.includes(code)),
          matched_mentor_support: (selectedMentor.support ?? []).filter(
            (code) => needs.includes(code) || (supportByObjective[objective] ?? []).includes(code),
          ),
          mentor_skills: selectedMentor.skills ?? [],
          mentor_certifications: selectedMentor.certifications ?? [],
        },
      };
      break;
    }
    if (succeeded) return succeeded;

    const last = diag.attempts.at(-1);
    diag.reason = last?.reason ?? "TIME_WINDOW";
    if (last?.detail) diag.detail = last.detail;
    diagnostics.push(diag);
  }

  return { leg: null, diagnostics };
}

function addMinutes(value, minutes) {
  return new Date(t(value) + minutes * 60000);
}

// 近馆优先：与上一腿同馆的工位排前面，减少交通衔接成本。
function scoreStation(station, fromStation) {
  if (!fromStation) return 0;
  return station.museum_id === fromStation.museum_id ? 0 : 1;
}

// 生成完整建议：按学习目标顺序贪心成线，失败的目标进入 unmet（原路线只剩部分可执行）。
export function buildProposal(request, world, occupancy = []) {
  const legs = [];
  const bases = [];
  const unmet = [];
  let fromStation = null;

  for (const objective of request.learning_objectives) {
    const found = findLeg(objective, request, world, occupancy, {
      earliest: request.time_window.start,
      latest: request.time_window.end,
      fromStation,
      planLegs: legs,
    });
    if (!found.leg) {
      unmet.push({ objective, candidates: found.diagnostics });
      continue;
    }
    legs.push(found.leg);
    bases.push(found.resource_basis);
    fromStation = { ...found.leg, end: found.leg.end };
  }

  return {
    legs,
    resource_basis: bases,
    unmet,
    coverage: coverageOf(request, legs),
  };
}

export function coverageOf(request, legs) {
  const covered = new Set(legs.map((leg) => leg.objective));
  return {
    planned: [...request.learning_objectives],
    covered: [...covered],
    missing: request.learning_objectives.filter((objective) => !covered.has(objective)),
  };
}

// 局部停用后的重排：未变行程原样保留，仅替换受影响节点。
// occupancy 只包含其他团组的占用；本团组保留中的腿由本函数自行计入，避免重复占容。
// disabledStationIds：被停用的工位；window 给定时，只有与停用窗时间重叠的腿才算受影响，
// 同一工位上不重叠的腿原样保留。工位的 unavailable_windows 会阻止替换腿落回闭馆时段，
// 因此替换节点仍可安排回同一工位的其他时段。
export function replanRoute(request, world, occupancy, currentLegs, disabledStationIds, window = null) {
  const disabled = new Set(disabledStationIds);
  const isAffected = (leg) =>
    disabled.has(leg.station_id) &&
    (!window || intervalsOverlap(leg.start, leg.end, window.from, window.to));
  const unchanged = currentLegs.filter((leg) => !isAffected(leg));
  const affected = currentLegs.filter(isAffected);

  const added = [];
  const addedBases = [];
  const cancelled = [];
  const replacementByLeg = new Map();

  for (const leg of affected) {
    const index = currentLegs.indexOf(leg);
    // 向前回溯：未变腿直接使用；已替换腿使用其替换腿；被取消的腿跳过。
    let prev = null;
    for (let i = index - 1; i >= 0; i -= 1) {
      const earlier = currentLegs[i];
      if (!disabled.has(earlier.station_id)) {
        prev = earlier;
        break;
      }
      if (replacementByLeg.has(earlier)) {
        prev = replacementByLeg.get(earlier);
        break;
      }
    }
    const next = currentLegs.slice(index + 1).find((candidate) => !disabled.has(candidate.station_id)) ?? null;

    const legMinutes =
      request.objective_minutes?.[leg.objective] ?? world.default_leg_minutes ?? DEFAULT_LEG_MINUTES;
    const earliest = prev ? prev.end : request.time_window.start;
    const latest = next
      ? new Date(t(next.start) - (world.arrival_buffer_minutes ?? 0) * 60000).toISOString()
      : request.time_window.end;

    if (t(earliest) + legMinutes * 60000 > t(latest)) {
      cancelled.push({ leg, reason: "NO_SLOT_BETWEEN_PRESERVED_LEGS" });
      continue;
    }

    // 保留腿与已定替换腿仍然占容，新替换腿必须与它们错开。
    const plannedOccupancy = [
      ...(occupancy ?? []),
      ...unchanged.map((kept) => ({ ...kept, seats: request.size })),
      ...added,
    ];
    const found = findLeg(leg.objective, request, world, plannedOccupancy, {
      earliest,
      latest,
      fromStation: prev ? { ...prev, end: prev.end } : null,
      // 整站停用时不得回到原工位；时间窗停用时工位的 unavailable_windows 会挡住闭馆时段，可复用其他时段。
      ignoreStationIds: window ? [] : disabledStationIds,
    });
    if (!found.leg) {
      cancelled.push({ leg, reason: "NO_REPLACEMENT", candidates: found.diagnostics });
    } else {
      added.push(found.leg);
      addedBases.push(found.resource_basis);
      replacementByLeg.set(leg, found.leg);
    }
  }

  // 按原始顺序重建路线：未变腿原样保留，受影响腿换成替换腿，被取消的节点缺位。
  const merged = [];
  for (const leg of currentLegs) {
    if (!isAffected(leg)) {
      merged.push(leg);
    } else if (replacementByLeg.has(leg)) {
      merged.push(replacementByLeg.get(leg));
    }
  }

  return {
    legs: merged,
    removed_legs: affected,
    added_legs: added,
    added_resource_basis: addedBases,
    cancelled_legs: cancelled,
    unchanged_legs: unchanged,
    coverage: coverageOf(request, merged),
  };
}
