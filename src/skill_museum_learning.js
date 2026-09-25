// skill_museum_learning 领域资料的基础结构。
//
// 本模块是「技能研学团组弹性编排」的领域契约：
//   - EVENT_KINDS：事件种类清单（在原有五类骨架事件上扩展生命周期事件）；
//   - REQUIRED_FIELDS：所有事件共有的最小字段；
//   - PAYLOAD_FIELDS：每类事件的 payload 必填字段（交换字段约定）；
//   - SUBJECT_FIELD：每类事件 subject_id 应与 payload 中哪个字段一致；
//   - validateEvent(record)：返回问题清单，空数组表示符合约定。
//
// 状态机（方案生命周期）：
//   PLAN_SUGGESTED（建议，不占容量）
//     → ITINERARY_HELD（老师确认后暂占，含 hold_until 截止时间）
//       → PLAN_FINALIZED（学校/场馆最终确认，不再超时释放）
//       → HOLD_RELEASED（拒绝 / 超时 / 被新方案取代，原子释放全部节点）
//     → ROUTE_REPLANNED（局部停用后替换受影响节点，保留未变行程，版本 +1）
//     → CHECK_IN_RECORDED（离线签到证据，幂等，不影响容量）
//     → WAITLIST_PROMOTED（容量释放后候补节点转为暂占）
//     → VISIT_RECONCILED（结束后按实际参与证据对账）

export const EVENT_KINDS = Object.freeze([
  // 既有骨架事件
  "GROUP_REQUESTED",
  "STATION_CAPACITY_SET",
  "ITINERARY_HELD",
  "ROUTE_REPLANNED",
  "VISIT_RECONCILED",
  // 生命周期扩展事件
  "PLAN_SUGGESTED",
  "PLAN_FINALIZED",
  "HOLD_RELEASED",
  "CHECK_IN_RECORDED",
  "WAITLIST_PROMOTED",
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 每类事件的 payload 必填字段（交换字段约定）。
export const PAYLOAD_FIELDS = Object.freeze({
  GROUP_REQUESTED: ["group_id", "headcount", "goals", "time_window"],
  STATION_CAPACITY_SET: ["station_id", "slots"],
  PLAN_SUGGESTED: ["plan_id", "group_id", "nodes", "unmet_goals"],
  ITINERARY_HELD: ["plan_id", "group_id", "version", "nodes", "hold_until"],
  PLAN_FINALIZED: ["plan_id", "group_id"],
  HOLD_RELEASED: ["plan_id", "group_id", "reason", "released_nodes"],
  ROUTE_REPLANNED: ["plan_id", "group_id", "version", "reason", "kept_nodes", "removed_nodes", "added_nodes"],
  CHECK_IN_RECORDED: ["checkin_id", "group_id", "station_id", "checked_at"],
  WAITLIST_PROMOTED: ["plan_id", "group_id", "node_id", "station_id", "slot_id"],
  VISIT_RECONCILED: ["group_id", "plan_id", "goal_coverage", "absences", "substitutions", "summary"],
});

// subject_id 一致性约定：团组事件以 group_id 为主体，工位事件以 station_id 为主体。
export const SUBJECT_FIELD = Object.freeze({
  GROUP_REQUESTED: "group_id",
  STATION_CAPACITY_SET: "station_id",
  PLAN_SUGGESTED: "group_id",
  ITINERARY_HELD: "group_id",
  PLAN_FINALIZED: "group_id",
  HOLD_RELEASED: "group_id",
  ROUTE_REPLANNED: "group_id",
  CHECK_IN_RECORDED: "group_id",
  WAITLIST_PROMOTED: "group_id",
  VISIT_RECONCILED: "group_id",
});

// 释放原因：拒绝 / 超时 / 被取代 / 取消。
export const RELEASE_REASONS = Object.freeze(["REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (problems.length) return problems;
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  if (typeof record.occurred_at !== "string" || Number.isNaN(Date.parse(record.occurred_at))) {
    problems.push("occurred_at");
  }
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    problems.push("payload");
    return problems;
  }
  for (const name of PAYLOAD_FIELDS[record.kind]) {
    if (!(name in record.payload)) problems.push(`payload.${name}`);
  }
  const subjectField = SUBJECT_FIELD[record.kind];
  if (subjectField && subjectField in record.payload && record.subject_id !== record.payload[subjectField]) {
    problems.push("subject_id");
  }
  return problems;
}
