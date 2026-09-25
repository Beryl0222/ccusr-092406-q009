// 到访对账：研学结束后，按实际参与证据（签到事件）核对
//   - 目标覆盖：每个学习目标是否有「计划节点 + 实际到访」双重证据；
//   - 缺席：计划内但无签到证据的节点；
//   - 临时替代：路线重排事件记录的新旧节点替换及其原因与资源依据；
//   - 计划外到访与重复签到：离线签到同步带来的异常证据。
// 对账结果写入 VISIT_RECONCILED 事件，让学校能解释每次改线及其资源依据。

// checkins 需已按 checkin_id 去重（编排服务保证）。
export function computeReconciliation({ request, plan, replans, checkins }) {
  const groupCheckins = checkins
    .filter((c) => c.group_id === request.group_id)
    .sort((a, b) => a.checked_at.localeCompare(b.checked_at) || a.checkin_id.localeCompare(b.checkin_id));

  // 每个工位取最早一条签到作为到访证据；其余视为重复签到（不多计）。
  const firstVisitAt = new Map();
  const duplicateCheckins = [];
  for (const checkin of groupCheckins) {
    if (firstVisitAt.has(checkin.station_id)) duplicateCheckins.push(checkin.checkin_id);
    else firstVisitAt.set(checkin.station_id, checkin);
  }

  const heldNodes = plan.nodes.filter((node) => node.status === "HELD");
  const waitlistedNodes = plan.nodes.filter((node) => node.status === "WAITLISTED");
  const droppedEntries = replans.flatMap((event) => event.payload.dropped_goals ?? []);

  const goalCoverage = request.goals.map((goal) => {
    const node = heldNodes.find((n) => n.goals.includes(goal));
    if (node) {
      const evidence = firstVisitAt.get(node.station_id);
      if (evidence) {
        return {
          goal,
          status: "COVERED",
          evidence: {
            node_id: node.node_id,
            station_id: node.station_id,
            slot_id: node.slot_id,
            checkin_id: evidence.checkin_id,
          },
        };
      }
      return { goal, status: "MISSED", reason: "NO_CHECKIN", node_id: node.node_id, station_id: node.station_id };
    }
    const dropped = droppedEntries.find((entry) => entry.goals.includes(goal));
    if (dropped) return { goal, status: "MISSED", reason: "DROPPED", cause: dropped.cause };
    const waiting = waitlistedNodes.find((n) => n.goals.includes(goal));
    if (waiting) {
      return { goal, status: "MISSED", reason: "WAITLIST_UNFILLED", station_id: waiting.station_id, slot_id: waiting.slot_id };
    }
    return { goal, status: "MISSED", reason: "NOT_PLANNED" };
  });

  const absences = heldNodes
    .filter((node) => !firstVisitAt.has(node.station_id))
    .map((node) => ({
      node_id: node.node_id,
      station_id: node.station_id,
      slot_id: node.slot_id,
      goals: node.goals,
    }));

  // 临时替代：来自路线重排事件的新旧节点对照，附原因与资源依据。
  const substitutions = replans.flatMap((event) =>
    (event.payload.replaced ?? []).map((item) => ({
      from: { node_id: item.old_node.node_id, station_id: item.old_node.station_id, slot_id: item.old_node.slot_id },
      to: item.new_nodes.map((n) => ({ node_id: n.node_id, station_id: n.station_id, slot_id: n.slot_id })),
      goals: item.goals,
      reason: event.payload.reason,
      resource_basis: item.resource_basis,
    })),
  );

  // 计划外到访：任何版本方案中都未出现过的工位签到。
  const plannedStations = new Set(plan.nodes.map((node) => node.station_id));
  for (const event of replans) {
    for (const node of event.payload.removed_nodes ?? []) plannedStations.add(node.station_id);
  }
  const unplannedVisits = groupCheckins
    .filter((checkin) => !plannedStations.has(checkin.station_id))
    .map((checkin) => ({ checkin_id: checkin.checkin_id, station_id: checkin.station_id }));

  const covered = goalCoverage.filter((item) => item.status === "COVERED").length;
  return {
    group_id: request.group_id,
    plan_id: plan.plan_id,
    goal_coverage: goalCoverage,
    absences,
    substitutions,
    unplanned_visits: unplannedVisits,
    duplicate_checkins: duplicateCheckins,
    summary: {
      goals_covered: covered,
      goals_missed: goalCoverage.length - covered,
      nodes_visited: heldNodes.length - absences.length,
      nodes_absent: absences.length,
    },
  };
}
