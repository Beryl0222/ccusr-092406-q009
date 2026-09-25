import assert from "node:assert/strict";
import test from "node:test";
import { createService, replayService } from "../src/service.js";
import { buildService, groupRequest, kindsOf, eventsOf, DAY_TS } from "./fixtures.js";

const CONFIRM_AT = "2026-09-24T10:10:00+08:00";
const DAY_END_DEADLINE = "2026-09-25T12:30:00+08:00";

function setupGroup(svc, id, size = 18, objectives = ["woodwork", "pottery"], extra = {}) {
  svc.registerRequest(groupRequest(id, size, objectives, extra), "2026-09-24T09:00:00+08:00");
  const proposal = svc.propose(id, "2026-09-24T09:05:00+08:00");
  return proposal;
}

test("建议不暂占容量：未确认的建议不影响其他团组确认同一工位", () => {
  const svc = buildService();
  const g1 = setupGroup(svc, "G1", 18); // 建议占用 W1 18/20，但未确认
  const g2 = setupGroup(svc, "G2", 19, ["woodwork"], { objective_minutes: { woodwork: 175 } });
  const confirm2 = svc.confirm("G2", g2.proposal_id, { at: CONFIRM_AT });
  assert.equal(confirm2.status, "HELD"); // G2 先确认即可暂占，建议不具排他性

  const confirm1 = svc.confirm("G1", g1.proposal_id, { at: CONFIRM_AT });
  assert.equal(confirm1.status, "WAITLISTED"); // 窗口已被占满，再确认 G1 只能候补
  assert.deepEqual(eventsOf(svc, "ITINERARY_HELD").map((e) => e.payload.group_id), ["G2"]);
});

test("确认后暂占容量，容量不足时进入候补，释放后按候补顺序推进", () => {
  const svc = buildService();
  const g1 = setupGroup(svc, "G1", 15, ["woodwork"], { objective_minutes: { woodwork: 175 } });
  const g2 = setupGroup(svc, "G2", 10, ["woodwork"]);
  assert.equal(svc.confirm("G1", g1.proposal_id, { at: CONFIRM_AT, idempotencyKey: "k1" }).status, "HELD");
  assert.equal(svc.confirm("G2", g2.proposal_id, { at: CONFIRM_AT, idempotencyKey: "k2" }).status, "WAITLISTED");
  assert.deepEqual(svc.debugState().waitlist.map((item) => item.group_id), ["G2"]);

  svc.reject("G1", CONFIRM_AT);
  // 原子释放后候补自动推进：G2 暂占成功
  assert.deepEqual(eventsOf(svc, "WAITLIST_PROMOTED").map((e) => e.payload.group_id), ["G2"]);
  assert.equal(svc.debugState().active_holds.map(([id]) => id)[0], "G2");
});

test("一个团组只能持有一套有效方案：确认新方案在同一批次释放旧方案", () => {
  const svc = buildService({ withReplacement: true });
  const first = setupGroup(svc, "G1", 10, ["woodwork"]);
  svc.confirm("G1", first.proposal_id, { at: CONFIRM_AT, idempotencyKey: "k1" });
  assert.equal(svc.debugState().active_holds.length, 1);

  const second = svc.propose("G1", "2026-09-24T11:00:00+08:00");
  svc.confirm("G1", second.proposal_id, { at: "2026-09-24T11:05:00+08:00", idempotencyKey: "k2" });

  assert.equal(svc.debugState().active_holds.length, 1);
  const release = eventsOf(svc, "HOLD_RELEASED").at(-1);
  assert.equal(release.payload.reason, "REPLACED");
  assert.equal(release.payload.proposal_id, first.proposal_id);
  // 两个事件同处一个命令批次，顺序为先释放后暂占
  const kinds = kindsOf(svc);
  assert.ok(kinds.lastIndexOf("HOLD_RELEASED") < kinds.lastIndexOf("ITINERARY_HELD"));
});

test("重复确认幂等：不会暂占两次或多占容量", () => {
  const svc = buildService();
  const proposal = setupGroup(svc, "G1", 18, ["woodwork"]);
  const first = svc.confirm("G1", proposal.proposal_id, { at: CONFIRM_AT, idempotencyKey: "same-key" });
  const second = svc.confirm("G1", proposal.proposal_id, { at: CONFIRM_AT, idempotencyKey: "same-key" });
  assert.equal(first.status, "HELD");
  assert.equal(second.status, "ALREADY_HELD");
  assert.equal(second.idempotent, true);
  assert.equal(eventsOf(svc, "ITINERARY_HELD").length, 1);
});

test("拒绝原子释放该团组的全部占用（跨工位、讲解员）", () => {
  const svc = buildService();
  const proposal = setupGroup(svc, "G1", 18, ["woodwork", "pottery"]);
  svc.confirm("G1", proposal.proposal_id, { at: CONFIRM_AT });
  assert.equal(svc.debugState().active_holds[0][1].legs.length, 2);

  svc.reject("G1", CONFIRM_AT);
  assert.equal(svc.debugState().active_holds.length, 0);
  const release = eventsOf(svc, "HOLD_RELEASED")[0];
  assert.equal(release.payload.legs.length, 2); // 一个事件携带全部腿，原子释放
  assert.equal(release.payload.reason, "REJECTED");
});

test("超时按绝对截止时间释放，且释放后推进候补；停机不延长截止时间", () => {
  const svc = buildService();
  const g1 = setupGroup(svc, "G1", 15, ["woodwork"], {
    release_deadline: "2026-09-24T18:00:00+08:00",
    objective_minutes: { woodwork: 175 },
  });
  const g2 = setupGroup(svc, "G2", 10, ["woodwork"], { release_deadline: "2026-09-25T18:00:00+08:00" });
  svc.confirm("G1", g1.proposal_id, { at: CONFIRM_AT, idempotencyKey: "g1" });
  svc.confirm("G2", g2.proposal_id, { at: CONFIRM_AT, idempotencyKey: "g2" });

  // 服务在截止前停机，恢复时已超过截止时间两小时：tick 立即按原截止时间释放。
  const result = svc.recover("2026-09-24T20:00:00+08:00");
  assert.deepEqual(result.expired, ["G1"]);
  const release = eventsOf(svc, "HOLD_RELEASED").find((event) => event.payload.group_id === "G1");
  assert.equal(release.payload.reason, "EXPIRED");
  assert.deepEqual(eventsOf(svc, "WAITLIST_PROMOTED").map((e) => e.payload.group_id), ["G2"]);
});

test("局部闭馆只替换受影响节点，未变行程原样保留", () => {
  const svc = buildService({ withReplacement: true });
  const proposal = setupGroup(svc, "G1", 18, ["woodwork", "pottery"], { release_deadline: DAY_END_DEADLINE });
  svc.confirm("G1", proposal.proposal_id, { at: CONFIRM_AT });
  const originalLegs = svc.debugState().active_holds[0][1].legs;
  const woodLeg = originalLegs.find((leg) => leg.objective === "woodwork");
  const potteryLeg = originalLegs.find((leg) => leg.objective === "pottery");

  svc.declareUnavailable(
    { scope: "STATION", ref_id: "W1", from: woodLeg.start, to: woodLeg.end, reason: "TEMP_CLOSURE" },
    "2026-09-24T12:00:00+08:00",
  );

  const replanned = eventsOf(svc, "ROUTE_REPLANNED")[0].payload;
  assert.equal(replanned.removed_legs[0].station_id, "W1");
  assert.equal(replanned.added_legs[0].station_id, "W2");
  // 陶艺腿是同一对象引用，未变行程原样保留
  assert.equal(replanned.unchanged_legs[0], potteryLeg);
  const holdLegs = svc.debugState().active_holds[0][1].legs;
  assert.deepEqual(holdLegs.map((leg) => leg.objective), ["woodwork", "pottery"]);
  assert.ok(holdLegs.includes(potteryLeg));
});

test("整馆闭馆按馆作用域命中该馆全部在途腿", () => {
  const svc = buildService({ withReplacement: true });
  const proposal = setupGroup(svc, "G1", 18, ["woodwork"], { release_deadline: DAY_END_DEADLINE });
  svc.confirm("G1", proposal.proposal_id, { at: CONFIRM_AT });
  svc.declareUnavailable(
    { scope: "MUSEUM", ref_id: "M1", from: DAY_TS("08:00"), to: DAY_TS("12:00"), reason: "MUSEUM_EVENT" },
    "2026-09-24T12:00:00+08:00",
  );
  const replanned = eventsOf(svc, "ROUTE_REPLANNED")[0].payload;
  assert.equal(replanned.removed_legs[0].station_id, "W1");
  assert.equal(replanned.added_legs[0].station_id, "W2");
});

test("离线签到按幂等键去重，重复签到不多占容量", () => {
  const svc = buildService();
  const proposal = setupGroup(svc, "G1", 18, ["woodwork"], { release_deadline: DAY_END_DEADLINE });
  svc.confirm("G1", proposal.proposal_id, { at: CONFIRM_AT });

  const payload = { group_id: "G1", station_id: "W1", occurred_at: DAY_TS("09:05"), idempotency_key: "ci-1" };
  const first = svc.recordCheckIn(payload);
  const second = svc.recordCheckIn({ ...payload, occurred_at: DAY_TS("09:08") });
  assert.equal(first.status, "RECORDED");
  assert.equal(second.status, "DUPLICATE_IGNORED");
  assert.equal(eventsOf(svc, "CHECK_IN_RECORDED").length, 1);
});

test("对账核对目标覆盖、缺席与临时替代，并给出改线的资源依据", () => {
  const svc = buildService({ withReplacement: true });
  const proposal = setupGroup(svc, "G1", 18, ["woodwork", "pottery"], { release_deadline: DAY_END_DEADLINE });
  svc.confirm("G1", proposal.proposal_id, { at: CONFIRM_AT });
  const woodLeg = svc.debugState().active_holds[0][1].legs.find((leg) => leg.objective === "woodwork");
  svc.declareUnavailable(
    { scope: "STATION", ref_id: "W1", from: woodLeg.start, to: woodLeg.end, reason: "TEMP_CLOSURE" },
    "2026-09-24T12:00:00+08:00",
  );
  const finalLegs = svc.debugState().active_holds[0][1].legs;
  // 只在陶艺工位签到：木工缺席
  svc.recordCheckIn({ group_id: "G1", station_id: "P1", occurred_at: finalLegs[1].start, idempotency_key: "ci-pot" });

  const result = svc.reconcile("G1", "2026-09-25T12:10:00+08:00", { note: "木工组迟到未入馆" });
  const payload = result.event.payload;
  assert.deepEqual(payload.covered_objectives, ["pottery"]);
  assert.deepEqual(payload.planned_objectives, ["woodwork", "pottery"]);
  assert.equal(payload.absent_legs[0].objective, "woodwork");
  assert.equal(payload.substitutions[0].replaced_station_ids[0], "W1");
  assert.equal(payload.substitutions[0].replacement_station_id, "W2");
  assert.ok(payload.substitutions[0].resource_basis.mentor_id);
  assert.match(payload.explanation, /TEMP_CLOSURE/);
  assert.match(payload.explanation, /木工组迟到未入馆/);
  // 对账结束释放占用
  assert.equal(svc.debugState().active_holds.length, 0);
});

test("事件日志重放后状态一致，并按原截止时间继续释放与候补推进", () => {
  const svc = buildService();
  const g1 = setupGroup(svc, "G1", 15, ["woodwork"], {
    release_deadline: "2026-09-24T18:00:00+08:00",
    objective_minutes: { woodwork: 175 },
  });
  const g2 = setupGroup(svc, "G2", 10, ["woodwork"], { release_deadline: "2026-09-25T18:00:00+08:00" });
  svc.confirm("G1", g1.proposal_id, { at: CONFIRM_AT, idempotencyKey: "g1" });
  svc.confirm("G2", g2.proposal_id, { at: CONFIRM_AT, idempotencyKey: "g2" });
  const log = svc.snapshot().events;

  const restored = replayService(log);
  assert.deepEqual(
    restored.debugState().active_holds.map(([id, hold]) => [id, hold.legs.length]),
    [["G1", 1]],
  );
  assert.deepEqual(restored.debugState().waitlist.map((item) => item.group_id), ["G2"]);
  assert.equal(restored.debugState().proposals.length, svc.debugState().proposals.length);
  // 重放不产生派生事件（无重复重排/建议）
  assert.equal(restored._events.length, log.length);

  restored.recover("2026-09-24T20:00:00+08:00");
  assert.equal(restored.debugState().active_holds.map(([id]) => id)[0], "G2");
  assert.equal(restored.debugState().waitlist.length, 0);
});

test("事件严格校验拒绝缺字段的记录", () => {
  const svc = createService();
  assert.throws(
    () => svc.ingest({ event_id: "x", kind: "GROUP_REQUESTED", occurred_at: "2026-09-24T09:00:00+08:00", subject_id: "G", payload: {} }),
    (error) => error.code === "INVALID_EVENT",
  );
});
