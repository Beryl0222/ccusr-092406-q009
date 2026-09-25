import assert from "node:assert/strict";
import test from "node:test";
import { Orchestrator, OrchestratorError } from "../src/orchestrator.js";
import { DAY, T, makeRequest, muStation, seededOrchestrator, taoStation, taoStation2 } from "./helpers.js";

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof OrchestratorError, `应为 OrchestratorError: ${error}`);
    return error.code;
  }
  throw new Error("预期抛出异常");
}

test("完整生命周期：请求→建议→确认→最终确认→签到→对账", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  assert.equal(suggestion.unmet_goals.length, 0);

  const plan = orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  assert.equal(plan.status, "HELD");
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 20);
  assert.equal(orch.usageAt("st-mu", "st-mu-pm"), 20);

  const finalized = orch.finalizePlan("g1", { now: T.confirm });
  assert.equal(finalized.status, "FINALIZED");

  orch.checkIn(
    { checkin_id: "ck-1", group_id: "g1", station_id: "st-tao", checked_at: `${DAY}T09:35:00+08:00` },
    { now: `${DAY}T09:36:00+08:00` },
  );
  orch.checkIn(
    { checkin_id: "ck-2", group_id: "g1", station_id: "st-mu", checked_at: `${DAY}T13:05:00+08:00` },
    { now: `${DAY}T13:06:00+08:00` },
  );

  const result = orch.reconcile("g1", { now: T.reconcile });
  assert.equal(result.summary.goals_covered, 2);
  assert.equal(result.summary.goals_missed, 0);
  assert.equal(orch.getPlan(plan.plan_id).status, "COMPLETED");
});

test("建议只是计算结果，不占用容量", () => {
  const orch = seededOrchestrator(new Orchestrator());
  orch.suggestPlan("g1", { now: T.suggest });
  orch.suggestPlan("g1", { now: T.suggest });
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 0);
  assert.equal(orch.usageAt("st-mu", "st-mu-pm"), 0);
});

test("重复确认同一方案不多占容量（幂等）", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  const eventsBefore = orch.events.length;
  const again = orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirmLater, holdUntil: T.holdUntil });
  assert.equal(again.status, "HELD");
  assert.equal(orch.events.length, eventsBefore, "重复确认不应追加事件");
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 20, "容量只被计算一次");
});

test("一个团组只能持有一套有效方案：确认新方案原子替换旧方案", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const first = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", first.plan_id, { now: T.confirm, holdUntil: T.holdUntil });

  // 环境变化后出现更早的时段，老师计算并确认了新建议
  orch.setStationCapacity(
    taoStation2({
      slots: [{ slot_id: "st-tao2-early", start: `${DAY}T09:00:00+08:00`, end: `${DAY}T10:20:00+08:00`, capacity: 30 }],
    }),
    { now: T.confirmLater },
  );
  const second = orch.suggestPlan("g1", { now: T.confirmLater });
  const plan = orch.confirmPlan("g1", second.plan_id, { now: T.confirmLater, holdUntil: T.holdUntil });

  assert.equal(orch.getPlan(first.plan_id).status, "RELEASED");
  assert.equal(orch.getPlan(first.plan_id).released_reason, "SUPERSEDED");
  assert.equal(plan.status, "HELD");
  assert.equal(orch.getActivePlan("g1").plan_id, second.plan_id);
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 0, "旧方案占用已释放");
  assert.equal(orch.usageAt("st-tao2", "st-tao2-early"), 20, "新方案正常暂占");
  assert.equal(orch.usageAt("st-mu", "st-mu-pm"), 20);
});

test("拒绝会原子释放全部占用", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });

  const eventsBefore = orch.events.length;
  const outcome = orch.rejectPlan("g1", { now: T.confirmLater });
  assert.equal(outcome.released, suggestion.plan_id);
  assert.equal(orch.events.length, eventsBefore + 1, "全部占用由单个事件原子释放");
  const release = orch.events.at(-1);
  assert.equal(release.kind, "HOLD_RELEASED");
  assert.equal(release.payload.released_nodes.length, 2);
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 0);
  assert.equal(orch.usageAt("st-mu", "st-mu-pm"), 0);
  assert.equal(orch.getActivePlan("g1"), null);

  // 重复拒绝是幂等空操作
  assert.equal(orch.rejectPlan("g1", { now: T.confirmLater }), null);
});

test("超时按原截止时间原子释放；最终确认的方案不超时", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const s1 = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", s1.plan_id, { now: T.confirm, holdUntil: T.holdUntil });

  orch.submitGroupRequest(makeRequest({ group_id: "g2", headcount: 10, goals: ["陶艺拉坯"] }), { now: T.request });
  const s2 = orch.suggestPlan("g2", { now: T.suggest });
  orch.confirmPlan("g2", s2.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  orch.finalizePlan("g2", { now: T.confirm });

  const { expired } = orch.tick({ now: T.afterHold });
  assert.deepEqual(expired, [s1.plan_id], "只有未最终确认的方案超时");
  assert.equal(orch.getPlan(s1.plan_id).status, "EXPIRED");
  assert.equal(orch.getPlan(s2.plan_id).status, "FINALIZED");
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 10, "最终确认的方案保留占用");
});

test("容量不足时确认失败且不产生任何事件（原子校验）", () => {
  const orch = new Orchestrator();
  orch.submitGroupRequest(makeRequest({ group_id: "g1", goals: ["陶艺拉坯"] }), { now: T.request });
  orch.submitGroupRequest(makeRequest({ group_id: "g2", goals: ["陶艺拉坯"] }), { now: T.request });
  orch.setStationCapacity(taoStation(), { now: T.capacity });

  const s1 = orch.suggestPlan("g1", { now: T.suggest });
  const s2 = orch.suggestPlan("g2", { now: T.suggest });
  orch.confirmPlan("g1", s1.plan_id, { now: T.confirm, holdUntil: T.holdUntil });

  // g2 的建议是在 g1 确认前计算的（剩余 10 < 20），确认时必须失败
  const eventsBefore = orch.events.length;
  const code = codeOf(() => orch.confirmPlan("g2", s2.plan_id, { now: T.confirmLater, holdUntil: T.holdUntil }));
  assert.equal(code, "PLAN_STALE");
  assert.equal(orch.events.length, eventsBefore, "失败的确认不得追加事件");
  assert.equal(orch.getActivePlan("g2"), null);
});

test("容量不足时建议给出候补，容量释放后候补推进", () => {
  const orch = new Orchestrator();
  orch.submitGroupRequest(makeRequest({ group_id: "g1", goals: ["陶艺拉坯"] }), { now: T.request });
  orch.submitGroupRequest(makeRequest({ group_id: "g2", goals: ["陶艺拉坯"] }), { now: T.request });
  orch.setStationCapacity(taoStation(), { now: T.capacity });

  const s1 = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", s1.plan_id, { now: T.confirm, holdUntil: T.holdUntil });

  // g2 在容量被占后计算建议：只能候补
  const s2 = orch.suggestPlan("g2", { now: T.confirmLater });
  assert.equal(s2.nodes[0].status, "WAITLIST");
  const plan2 = orch.confirmPlan("g2", s2.plan_id, { now: T.confirmLater, holdUntil: T.holdUntil });
  assert.equal(plan2.nodes[0].status, "WAITLISTED");
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 20, "候补不占容量");

  // g1 拒绝后，g2 的候补被推进为暂占
  orch.rejectPlan("g1", { now: T.confirmLater });
  const promoted = orch.getPlan(plan2.plan_id);
  assert.equal(promoted.nodes[0].status, "HELD");
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 20);
  assert.ok(orch.events.some((e) => e.kind === "WAITLIST_PROMOTED" && e.payload.plan_id === plan2.plan_id));
});

test("局部停用时替换受影响节点并保留未变行程", () => {
  const orch = seededOrchestrator(new Orchestrator(), { stations: [taoStation(), taoStation2(), muStation()] });
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  const before = orch.getActivePlan("g1");
  const muNode = before.nodes.find((n) => n.station_id === "st-mu");

  // 陶艺馆上午时段临时闭馆
  const { affected } = orch.setStationCapacity(taoStation({ closed_slots: ["st-tao-am"] }), { now: T.confirmLater });
  assert.deepEqual(affected, [before.plan_id]);

  const after = orch.getActivePlan("g1");
  assert.equal(after.version, 2);
  const keptMu = after.nodes.find((n) => n.station_id === "st-mu");
  assert.deepEqual(keptMu, muNode, "未受影响的木作行程原样保留");
  const moved = after.nodes.find((n) => n.goals.includes("陶艺拉坯"));
  assert.equal(moved.station_id, "st-tao2", "受影响节点被替换到替代工位");
  assert.equal(moved.status, "HELD");
  assert.equal(after.hold_until, T.holdUntil, "重排不改变原暂占截止时间");
  assert.equal(orch.usageAt("st-tao2", "st-tao2-am"), 20);
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 0);

  const replan = orch.events.find((e) => e.kind === "ROUTE_REPLANNED");
  assert.equal(replan.payload.reason, "STATION_CAPACITY_CHANGED");
  assert.equal(replan.payload.kept_nodes[0].station_id, "st-mu");
  assert.equal(replan.payload.replaced[0].resource_basis.cause, "SLOT_CLOSED");
  assert.equal(replan.payload.replaced[0].resource_basis.new_slots[0].remaining_capacity_before, 30);
});

test("无替代工位时目标被放弃并记录原因；恢复开放后未变行程不受影响", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });

  orch.setStationCapacity(taoStation({ closed_slots: ["st-tao-am"] }), { now: T.confirmLater });
  const after = orch.getActivePlan("g1");
  assert.equal(after.nodes.length, 1, "只剩木作节点");
  assert.equal(after.nodes[0].station_id, "st-mu");
  const replan = orch.events.find((e) => e.kind === "ROUTE_REPLANNED");
  assert.deepEqual(replan.payload.dropped_goals, [{ goals: ["陶艺拉坯"], cause: "SLOT_CLOSED" }]);

  // 工位恢复开放：未变行程不受打扰，被放弃的目标由老师重新计算建议来找回
  orch.setStationCapacity(taoStation(), { now: T.confirmLater });
  const reopened = orch.getActivePlan("g1");
  assert.equal(reopened.nodes.length, 1);
  assert.equal(reopened.nodes[0].station_id, "st-mu");
  const again = orch.suggestPlan("g1", { now: T.confirmLater });
  assert.ok(again.nodes.some((n) => n.goals.includes("陶艺拉坯") && n.status === "AVAILABLE"));
});

test("替代工位满员时受影响目标转候补，容量增加后自动推进", () => {
  const orch = new Orchestrator();
  orch.submitGroupRequest(makeRequest({ goals: ["陶艺拉坯"] }), { now: T.request });
  orch.submitGroupRequest(makeRequest({ group_id: "g2", headcount: 30, goals: ["陶艺拉坯"] }), { now: T.request });
  orch.setStationCapacity(taoStation(), { now: T.capacity });
  // 替代工位时段更早，会被大团优先选中
  orch.setStationCapacity(
    taoStation2({
      slots: [{ slot_id: "st-tao2-am", start: `${DAY}T09:00:00+08:00`, end: `${DAY}T10:30:00+08:00`, capacity: 30 }],
    }),
    { now: T.capacity },
  );

  // g2（30 人）先占满替代工位 st-tao2
  const s2 = orch.suggestPlan("g2", { now: T.suggest });
  orch.confirmPlan("g2", s2.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  // g1（20 人）只能去原工位 st-tao
  const s1 = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", s1.plan_id, { now: T.confirmLater, holdUntil: T.holdUntil });
  assert.equal(orch.usageAt("st-tao2", "st-tao2-am"), 30);
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 20);

  // 原工位闭馆：替代工位剩余 0，g1 的陶艺目标转候补
  orch.setStationCapacity(taoStation({ closed_slots: ["st-tao-am"] }), { now: T.confirmLater });
  const after = orch.getActivePlan("g1");
  assert.equal(after.nodes[0].status, "WAITLISTED");
  assert.equal(after.nodes[0].station_id, "st-tao2");

  // 替代工位扩容后候补自动推进
  orch.setStationCapacity(
    taoStation2({
      slots: [{ slot_id: "st-tao2-am", start: `${DAY}T09:00:00+08:00`, end: `${DAY}T10:30:00+08:00`, capacity: 50 }],
    }),
    { now: T.confirmLater },
  );
  const promoted = orch.getActivePlan("g1");
  assert.equal(promoted.nodes[0].status, "HELD");
  assert.equal(orch.usageAt("st-tao2", "st-tao2-am"), 50);
});

test("容量调减时后占者被驱逐并弹性重排，先占者不受影响", () => {
  const orch = new Orchestrator();
  orch.submitGroupRequest(makeRequest({ group_id: "g1", goals: ["陶艺拉坯"] }), { now: T.request });
  orch.submitGroupRequest(makeRequest({ group_id: "g2", goals: ["陶艺拉坯"] }), { now: T.request });
  orch.setStationCapacity(
    taoStation({ slots: [{ slot_id: "st-tao-am", start: `${DAY}T09:30:00+08:00`, end: `${DAY}T11:00:00+08:00`, capacity: 40 }] }),
    { now: T.capacity },
  );
  const s1 = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", s1.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  const s2 = orch.suggestPlan("g2", { now: T.suggest });
  orch.confirmPlan("g2", s2.plan_id, { now: T.confirmLater, holdUntil: T.holdUntil });
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 40);

  // 容量 40 → 30：后确认的 g2 被驱逐，转为候补；先占的 g1 保留
  orch.setStationCapacity(
    taoStation({ slots: [{ slot_id: "st-tao-am", start: `${DAY}T09:30:00+08:00`, end: `${DAY}T11:00:00+08:00`, capacity: 30 }] }),
    { now: T.confirmLater },
  );
  assert.equal(orch.getActivePlan("g1").nodes[0].status, "HELD");
  assert.equal(orch.getActivePlan("g2").nodes[0].status, "WAITLISTED");
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 20);
});

test("离线签到与重复同步不多占容量、不多计证据", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  orch.finalizePlan("g1", { now: T.confirm });

  const first = orch.checkIn(
    { checkin_id: "ck-1", group_id: "g1", station_id: "st-tao", checked_at: `${DAY}T09:35:00+08:00`, source: "OFFLINE_SYNC" },
    { now: `${DAY}T09:40:00+08:00` },
  );
  assert.equal(first.duplicate, false);
  const eventsBefore = orch.events.length;
  // 同一 checkin_id 重复同步
  const dup = orch.checkIn(
    { checkin_id: "ck-1", group_id: "g1", station_id: "st-tao", checked_at: `${DAY}T09:35:00+08:00`, source: "OFFLINE_SYNC" },
    { now: `${DAY}T09:41:00+08:00` },
  );
  assert.equal(dup.duplicate, true);
  assert.equal(orch.events.length, eventsBefore, "重复签到不追加事件");
  // 同一工位重复扫码（不同 checkin_id）
  orch.checkIn(
    { checkin_id: "ck-1b", group_id: "g1", station_id: "st-tao", checked_at: `${DAY}T09:36:00+08:00`, source: "OFFLINE_SYNC" },
    { now: `${DAY}T09:42:00+08:00` },
  );
  assert.equal(orch.usageAt("st-tao", "st-tao-am"), 20, "签到永不改变容量占用");

  orch.checkIn(
    { checkin_id: "ck-2", group_id: "g1", station_id: "st-mu", checked_at: `${DAY}T13:05:00+08:00` },
    { now: `${DAY}T13:06:00+08:00` },
  );
  const result = orch.reconcile("g1", { now: T.reconcile });
  assert.equal(result.summary.goals_covered, 2);
  assert.deepEqual(result.duplicate_checkins, ["ck-1b"], "重复扫码只记录一次到访");
});

test("已持有有效方案的团组不能重复提交请求", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  const code = codeOf(() => orch.submitGroupRequest(makeRequest({ headcount: 18 }), { now: T.confirmLater }));
  assert.equal(code, "ACTIVE_PLAN_EXISTS");
});

test("相同请求重复提交是幂等空操作", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const eventsBefore = orch.events.length;
  orch.submitGroupRequest(makeRequest(), { now: T.confirmLater });
  assert.equal(orch.events.length, eventsBefore);
});

test("对账：覆盖、缺席、临时替代、计划外到访与未覆盖目标", () => {
  const orch = new Orchestrator();
  orch.submitGroupRequest(makeRequest({ goals: ["陶艺拉坯", "木作榫卯", "古琴修复"] }), { now: T.request });
  orch.setStationCapacity(taoStation(), { now: T.capacity });
  orch.setStationCapacity(taoStation2(), { now: T.capacity });
  orch.setStationCapacity(muStation(), { now: T.capacity });

  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  assert.deepEqual(suggestion.unmet_goals, [{ goal: "古琴修复", cause: "NO_STATION" }]);
  orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  orch.finalizePlan("g1", { now: T.confirm });

  // 陶艺馆闭馆 → 改到替代工位（临时替代）
  orch.setStationCapacity(taoStation({ closed_slots: ["st-tao-am"] }), { now: T.confirmLater });

  // 实际到访：替代工位签到；木作馆缺席；计划外工位签到
  orch.checkIn({ checkin_id: "ck-1", group_id: "g1", station_id: "st-tao2", checked_at: `${DAY}T09:50:00+08:00` }, { now: `${DAY}T09:51:00+08:00` });
  orch.checkIn({ checkin_id: "ck-9", group_id: "g1", station_id: "st-gift-shop", checked_at: `${DAY}T15:00:00+08:00` }, { now: `${DAY}T15:01:00+08:00` });

  const result = orch.reconcile("g1", { now: T.reconcile });
  const byGoal = Object.fromEntries(result.goal_coverage.map((item) => [item.goal, item]));
  assert.equal(byGoal["陶艺拉坯"].status, "COVERED");
  assert.equal(byGoal["陶艺拉坯"].evidence.station_id, "st-tao2");
  assert.equal(byGoal["木作榫卯"].status, "MISSED");
  assert.equal(byGoal["木作榫卯"].reason, "NO_CHECKIN");
  assert.equal(byGoal["古琴修复"].status, "MISSED");
  assert.equal(byGoal["古琴修复"].reason, "NOT_PLANNED");

  assert.deepEqual(result.absences.map((a) => a.station_id), ["st-mu"]);
  assert.equal(result.substitutions.length, 1);
  assert.equal(result.substitutions[0].from.station_id, "st-tao");
  assert.equal(result.substitutions[0].to[0].station_id, "st-tao2");
  assert.equal(result.substitutions[0].reason, "STATION_CAPACITY_CHANGED");
  assert.ok(result.substitutions[0].resource_basis.new_slots[0].remaining_capacity_before >= 20);
  assert.deepEqual(result.unplanned_visits, [{ checkin_id: "ck-9", station_id: "st-gift-shop" }]);

  // 对账幂等
  const eventsBefore = orch.events.length;
  assert.deepEqual(orch.reconcile("g1", { now: T.reconcile }), result);
  assert.equal(orch.events.length, eventsBefore);
});

test("候补未兑现的目标在对账中标记为 WAITLIST_UNFILLED", () => {
  const orch = new Orchestrator();
  orch.submitGroupRequest(makeRequest({ group_id: "g1", goals: ["陶艺拉坯"] }), { now: T.request });
  orch.submitGroupRequest(makeRequest({ group_id: "g2", goals: ["陶艺拉坯"] }), { now: T.request });
  orch.setStationCapacity(taoStation(), { now: T.capacity });
  const s1 = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", s1.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  const s2 = orch.suggestPlan("g2", { now: T.confirmLater });
  orch.confirmPlan("g2", s2.plan_id, { now: T.confirmLater, holdUntil: T.holdUntil });

  const result = orch.reconcile("g2", { now: T.reconcile });
  assert.equal(result.goal_coverage[0].status, "MISSED");
  assert.equal(result.goal_coverage[0].reason, "WAITLIST_UNFILLED");
});

test("无有效方案时请求可修订，版本号递增", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const revised = orch.submitGroupRequest(makeRequest({ headcount: 18 }), { now: T.confirmLater });
  assert.equal(revised.headcount, 18);
  assert.equal(revised.revision, 2);
  assert.equal(orch.getGroup("g1").headcount, 18);
});

test("手动重排：没有失效节点时是空操作", () => {
  const orch = seededOrchestrator(new Orchestrator());
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  const eventsBefore = orch.events.length;
  assert.equal(orch.replanGroup("g1", { now: T.confirmLater }), null);
  assert.equal(orch.events.length, eventsBefore);
});

test("无效输入被拒绝", () => {
  const orch = new Orchestrator();
  assert.equal(codeOf(() => orch.submitGroupRequest(makeRequest({ headcount: 0 }), { now: T.request })), "INVALID_REQUEST");
  assert.equal(codeOf(() => orch.submitGroupRequest(makeRequest({ goals: [] }), { now: T.request })), "INVALID_REQUEST");
  assert.equal(codeOf(() => orch.suggestPlan("ghost", { now: T.suggest })), "GROUP_NOT_FOUND");
  orch.submitGroupRequest(makeRequest(), { now: T.request });
  orch.setStationCapacity(taoStation(), { now: T.capacity });
  const suggestion = orch.suggestPlan("g1", { now: T.suggest });
  assert.equal(codeOf(() => orch.confirmPlan("g1", "nope", { now: T.confirm, holdUntil: T.holdUntil })), "SUGGESTION_NOT_FOUND");
  assert.equal(
    codeOf(() => orch.confirmPlan("g1", suggestion.plan_id, { now: T.confirm, holdUntil: T.request })),
    "INVALID_HOLD_UNTIL",
  );
  assert.equal(codeOf(() => orch.finalizePlan("g1", { now: T.confirm })), "NO_ACTIVE_PLAN");
  assert.equal(
    codeOf(() => orch.checkIn({ checkin_id: "ck-x", group_id: "g1", station_id: "st-tao" }, { now: T.visit })),
    "INVALID_CHECKIN",
  );
});
