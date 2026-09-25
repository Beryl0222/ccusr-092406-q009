import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Orchestrator } from "../src/orchestrator.js";
import { T, makeRequest, muStation, taoStation } from "./helpers.js";

// 搭好「g1 暂占 + g3 候补」的现场，返回原编排器。
function buildLive() {
  const orch = new Orchestrator();
  orch.submitGroupRequest(makeRequest({ group_id: "g1" }), { now: T.request });
  orch.submitGroupRequest(makeRequest({ group_id: "g3", headcount: 25, goals: ["木作榫卯"] }), { now: T.request });
  orch.setStationCapacity(taoStation(), { now: T.capacity });
  orch.setStationCapacity(muStation(), { now: T.capacity });
  const s1 = orch.suggestPlan("g1", { now: T.suggest });
  orch.confirmPlan("g1", s1.plan_id, { now: T.confirm, holdUntil: T.holdUntil });
  // g3（25 人）在木作馆剩余 10 人容量下只能候补；其截止时间更晚，不在本轮超时之列
  const s3 = orch.suggestPlan("g3", { now: T.confirmLater });
  orch.confirmPlan("g3", s3.plan_id, { now: T.confirmLater, holdUntil: "2026-09-28T18:00:00+08:00" });
  return { orch, p1: s1.plan_id, p3: s3.plan_id };
}

test("服务恢复后按原截止时间继续释放与候补推进", () => {
  const { orch: live, p1, p3 } = buildLive();
  assert.equal(live.getPlan(p3).nodes[0].status, "WAITLISTED");

  // 服务重启：仅从事先持久化的事件流恢复，不携带任何运行期定时器
  const recovered = Orchestrator.fromEvents(live.events);
  assert.equal(recovered.getPlan(p1).status, "HELD");
  assert.equal(recovered.getPlan(p3).nodes[0].status, "WAITLISTED");

  // 截止时间未到：不释放
  const early = recovered.tick({ now: "2026-09-25T17:00:00+08:00" });
  assert.deepEqual(early.expired, []);
  assert.equal(recovered.usageAt("st-mu", "st-mu-pm"), 20);

  // 超过原截止时间：g1 原子释放，g3 的候补按原规则推进
  const outcome = recovered.tick({ now: T.afterHold });
  assert.deepEqual(outcome.expired, [p1]);
  assert.equal(recovered.getPlan(p1).status, "EXPIRED");
  assert.equal(recovered.getPlan(p3).nodes[0].status, "HELD");
  assert.equal(recovered.usageAt("st-mu", "st-mu-pm"), 25, "候补已补上释放出的容量");
  assert.equal(recovered.usageAt("st-tao", "st-tao-am"), 0);

  // 恢复后的实例与一直在场的实例行为完全一致（确定性重放）
  live.tick({ now: "2026-09-25T17:00:00+08:00" });
  live.tick({ now: T.afterHold });
  assert.deepEqual(recovered.events, live.events);
});

test("样例事件流可重放，且对账结论可由服务复算", async () => {
  const stream = JSON.parse(await readFile(new URL("../data/sample_events.json", import.meta.url), "utf8"));
  const expected = stream.at(-1);

  // 重放到对账前，由服务重新计算对账结果，应与样例中的 VISIT_RECONCILED 一致
  const beforeReconcile = Orchestrator.fromEvents(stream.slice(0, -1));
  const recomputed = beforeReconcile.reconcile("grp-012", { now: "2026-10-12T18:00:00+08:00" });
  assert.deepEqual(recomputed, expected.payload);

  // 完整重放后方案进入已完成状态
  const full = Orchestrator.fromEvents(stream);
  assert.equal(full.getPlan("P-grp-012-1").status, "COMPLETED");
  assert.deepEqual(full.reconciliationFor("grp-012"), expected.payload);
});
