// 纯函数规划器：把团组请求（学习目标、人数、时间窗、交通衔接、必要支持）
// 与场馆工位（技能、讲解员资质、无障碍等支持特性、开放时段与剩余容量）匹配，
// 产出「建议方案」。规划器不做任何状态修改，也不占用容量——
// 计算结果只是建议，老师确认后才由编排服务暂占资源。

import { ts, overlaps, within } from "./util.js";

// 团组可活动的时间边界：交通衔接到达/离开时间收窄时间窗。
export function groupBounds(request) {
  return {
    start: request.transport?.earliest_start ?? request.time_window.start,
    end: request.transport?.latest_end ?? request.time_window.end,
  };
}

export function slotList(station) {
  return station.slots instanceof Map ? [...station.slots.values()] : [...station.slots];
}

// 工位是否满足团组的必要支持（如无障碍），以及工位技能与讲解员资质是否覆盖目标。
export function stationSupports(station, request, goals) {
  const features = new Set(station.support_features ?? []);
  if (!(request.support_needs ?? []).every((need) => features.has(need))) return false;
  const skills = new Set(station.skills ?? []);
  const mentors = new Set(station.mentor_skills ?? []);
  return goals.every((goal) => skills.has(goal) && mentors.has(goal));
}

// 时段是否可用：未关闭、完整落在交通衔接与时间窗边界内、剩余容量够全团。
export function slotEligible({ slot, request, bounds, remaining }) {
  if (slot.closed) return { ok: false, cause: "SLOT_CLOSED" };
  if (!within(slot, bounds.start, bounds.end)) return { ok: false, cause: "OUTSIDE_WINDOW" };
  if (remaining < request.headcount) return { ok: false, cause: "NO_CAPACITY" };
  return { ok: true };
}

function sortedCandidates(stations) {
  const candidates = [];
  for (const station of stations) {
    for (const slot of slotList(station)) candidates.push({ station, slot });
  }
  candidates.sort(
    (a, b) =>
      ts(a.slot.start) - ts(b.slot.start) ||
      a.station.station_id.localeCompare(b.station.station_id) ||
      a.slot.slot_id.localeCompare(b.slot.slot_id),
  );
  return candidates;
}

// 诊断一个目标无法安排的原因（用于未覆盖目标与资源依据说明）。
function diagnose(goal, request, stations, bounds, placed) {
  const teaching = stations.filter((s) => (s.skills ?? []).includes(goal));
  if (!teaching.length) return "NO_STATION";
  const mentored = teaching.filter((s) => (s.mentor_skills ?? []).includes(goal));
  if (!mentored.length) return "NO_QUALIFIED_MENTOR";
  const supported = mentored.filter((s) =>
    (request.support_needs ?? []).every((need) => (s.support_features ?? []).includes(need)),
  );
  if (!supported.length) return "SUPPORT_MISMATCH";
  const allSlots = supported.flatMap((s) => slotList(s));
  const openSlots = allSlots.filter((slot) => !slot.closed);
  if (!openSlots.length) return allSlots.length ? "SLOT_CLOSED" : "NO_OPEN_SLOT";
  const inWindow = openSlots.filter((slot) => within(slot, bounds.start, bounds.end));
  if (!inWindow.length) return "OUTSIDE_WINDOW";
  const free = inWindow.filter((slot) => !placed.some((node) => overlaps(node, slot)));
  if (!free.length) return "TIME_CONFLICT";
  return "NO_CAPACITY";
}

// 计算建议方案。
//   request:           团组请求 {headcount, goals, time_window, transport?, support_needs?}
//   stations:          工位定义数组
//   remainingCapacity: (station_id, slot_id) => 当前剩余容量（不含本方案将占用的部分）
//   keptNodes:         重排时保留不变的节点（新节点不得与其时间冲突）
// 返回 {nodes, unmet_goals, rationale}；节点状态为 AVAILABLE（可立即暂占）或 WAITLIST（候补）。
export function computeSuggestion({ request, stations, remainingCapacity, keptNodes = [] }) {
  const bounds = groupBounds(request);
  const candidates = sortedCandidates(stations);
  const placed = [...keptNodes];
  const nodes = [];
  const rationale = { nodes: [], waitlist: [], unmet: [] };
  // 保留节点已覆盖的目标无需再安置
  const keptGoals = new Set(keptNodes.flatMap((node) => node.goals ?? []));
  let goalsLeft = [...new Set(request.goals)].filter((goal) => !keptGoals.has(goal));

  const conflicts = (slot) => placed.some((node) => overlaps(node, slot));
  const coverableAt = (station) =>
    goalsLeft.filter((goal) => stationSupports(station, request, [goal]));

  // 贪心集合覆盖：每轮选出能覆盖最多剩余目标的可用时段，同量时取最早。
  for (;;) {
    let best = null;
    let bestCover = [];
    for (const { station, slot } of candidates) {
      if (conflicts(slot)) continue;
      const cover = coverableAt(station);
      if (!cover.length) continue;
      const fit = slotEligible({
        slot,
        request,
        bounds,
        remaining: remainingCapacity(station.station_id, slot.slot_id),
      });
      if (!fit.ok) continue;
      if (cover.length > bestCover.length) {
        best = { station, slot };
        bestCover = cover;
      }
    }
    if (!best) break;
    const remaining = remainingCapacity(best.station.station_id, best.slot.slot_id);
    const node = {
      station_id: best.station.station_id,
      slot_id: best.slot.slot_id,
      start: best.slot.start,
      end: best.slot.end,
      goals: bestCover,
      status: "AVAILABLE",
    };
    nodes.push(node);
    placed.push(node);
    rationale.nodes.push({
      station_id: node.station_id,
      slot_id: node.slot_id,
      covered_goals: bestCover,
      headcount: request.headcount,
      remaining_capacity_before: remaining,
      remaining_capacity_after: remaining - request.headcount,
    });
    goalsLeft = goalsLeft.filter((goal) => !bestCover.includes(goal));
  }

  // 剩余目标：若存在「其他条件都满足、只是容量不足」的时段，产出候补候选。
  for (const goal of goalsLeft) {
    const waitlistSlot = candidates.find(
      ({ station, slot }) =>
        !slot.closed &&
        within(slot, bounds.start, bounds.end) &&
        stationSupports(station, request, [goal]) &&
        !conflicts(slot),
    );
    if (waitlistSlot) {
      const node = {
        station_id: waitlistSlot.station.station_id,
        slot_id: waitlistSlot.slot.slot_id,
        start: waitlistSlot.slot.start,
        end: waitlistSlot.slot.end,
        goals: [goal],
        status: "WAITLIST",
      };
      nodes.push(node);
      placed.push(node);
      rationale.waitlist.push({
        station_id: node.station_id,
        slot_id: node.slot_id,
        goals: [goal],
        headcount: request.headcount,
        remaining_capacity: remainingCapacity(node.station_id, node.slot_id),
        cause: "NO_CAPACITY",
      });
    }
  }

  const waitlistedGoals = new Set(
    nodes.filter((node) => node.status === "WAITLIST").flatMap((node) => node.goals),
  );
  const unmetGoals = goalsLeft
    .filter((goal) => !waitlistedGoals.has(goal))
    .map((goal) => ({ goal, cause: diagnose(goal, request, stations, bounds, placed) }));
  for (const item of unmetGoals) rationale.unmet.push(item);

  return { nodes, unmet_goals: unmetGoals, rationale };
}
