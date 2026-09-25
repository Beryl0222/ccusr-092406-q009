// 技能研学弹性编排的领域词汇：事件种类与最小字段校验。
// 资料只描述领域约定，事件载荷中的标识均为虚构，不含真实个人信息。

// 事件种类（前五项为基线词汇，保持向后兼容）。
export const EVENT_KINDS = Object.freeze([
  // 团组提交研学请求：学习目标、人数、时间窗、交通衔接与必要支持。
  "GROUP_REQUESTED",
  // 场馆登记工位容量、开放时段、无障碍条件与讲解员（导师）技能/资质。
  "STATION_CAPACITY_SET",
  // 场馆或工位临时停用（临时闭馆、设备检修等），影响既定行程。
  "STATION_UNAVAILABLE_DECLARED",
  // 编排结果仅为建议：给出可行路线与资源依据，尚未暂占任何容量。
  "PLAN_PROPOSED",
  // 建议被旧建议取代（如资源变化后需重新建议）。
  "PLAN_SUPERSEDED",
  // 带队老师确认建议：在同一原子批次内暂占全部工位与讲解员。
  "ITINERARY_HELD",
  // 拒绝、超时、改线替换或对账结束时，原子释放团组持有的全部占用。
  "HOLD_RELEASED",
  // 局部停用后仅替换受影响节点，未变行程原样保留。
  "ROUTE_REPLANNED",
  // 容量不足时团组进入候补；释放发生后按候补顺序推进。
  "WAITLIST_JOINED",
  "WAITLIST_PROMOTED",
  // 离线/在线签到，按幂等键去重，重复签到不重复占容。
  "CHECK_IN_RECORDED",
  // 到访结束后按实际参与证据核对目标覆盖、缺席与临时替代。
  "VISIT_RECONCILED",
]);

// 所有事件共用的信封字段。
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 各事件类型载荷中的必备字段（点号表示嵌套字段）。
export const PAYLOAD_REQUIRED_FIELDS = Object.freeze({
  GROUP_REQUESTED: [
    "group_id",
    "size",
    "learning_objectives",
    "time_window.start",
    "time_window.end",
    "release_deadline",
  ],
  STATION_CAPACITY_SET: [
    "station_id",
    "museum_id",
    "capacity",
    "opening",
    "mentors",
  ],
  STATION_UNAVAILABLE_DECLARED: ["scope", "ref_id", "from", "to", "reason"],
  PLAN_PROPOSED: ["proposal_id", "group_id", "legs", "unmet", "proposed_at"],
  PLAN_SUPERSEDED: ["proposal_id", "group_id", "reason"],
  ITINERARY_HELD: [
    "proposal_id",
    "group_id",
    "legs",
    "release_deadline",
    "idempotency_key",
  ],
  HOLD_RELEASED: ["group_id", "reason", "legs"],
  ROUTE_REPLANNED: [
    "group_id",
    "legs",
    "removed_legs",
    "added_legs",
    "cancelled_legs",
    "unchanged_legs",
    "reason",
  ],
  WAITLIST_JOINED: ["group_id", "proposal_id"],
  WAITLIST_PROMOTED: ["group_id", "proposal_id"],
  CHECK_IN_RECORDED: ["group_id", "station_id", "occurred_at", "idempotency_key"],
  VISIT_RECONCILED: [
    "group_id",
    "planned_objectives",
    "covered_objectives",
    "absent_legs",
    "substitutions",
    "explanation",
  ],
});

// 占用释放原因。
export const RELEASE_REASONS = Object.freeze([
  "REJECTED", // 带队老师拒绝建议/主动取消
  "EXPIRED", // 到达绝对截止时间仍未完成
  "REPLACED", // 被新的有效方案替换
  "RECONCILED", // 到访对账结束
]);

function hasPath(record, path) {
  return path.split(".").every((key) => {
    if (record === null || typeof record !== "object" || !(key in record)) return false;
    record = record[key];
    return true;
  });
}

// 信封级校验（基线行为，保持不变）。
export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

// 载荷级校验：按事件种类核对必备字段。
export function validatePayload(record) {
  const required = PAYLOAD_REQUIRED_FIELDS[record.kind] ?? [];
  return required.filter((path) => !hasPath(record.payload ?? {}, path)).map((path) => `payload.${path}`);
}

// 严格校验：信封 + 载荷 + 时间格式。
export function validateEventStrict(record) {
  const problems = validateEvent(record);
  problems.push(...validatePayload(record));
  if (Number.isNaN(Date.parse(record.occurred_at))) problems.push("occurred_at");
  return problems;
}
