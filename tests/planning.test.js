import assert from "node:assert/strict";
import test from "node:test";
import { buildProposal, replanRoute } from "../src/planning.js";
import { OPENING, DEADLINE, DAY_TS, mentor, station, groupRequest } from "./fixtures.js";

const world = (stations, extra = {}) => ({
  stations,
  inter_museum_minutes: 15,
  intra_museum_minutes: 5,
  default_leg_minutes: 40,
  ...extra,
});

test("规划器匹配学习目标、讲解员资质与无障碍需求", () => {
  const w = world([
    station("W1", "M1", ["woodwork"], {
      mentors: [mentor("T1", ["woodwork"], { certifications: ["L2"], support: ["sign_language"] })],
    }),
    station("P1", "M2", ["pottery"], { mentors: [mentor("T2", ["pottery"])] }),
  ]);
  const request = groupRequest("G1", 18, ["woodwork", "pottery"], {
    required_certifications_by_objective: { woodwork: ["L2"] },
    support_needs_by_objective: { woodwork: ["sign_language"] },
    accessibility_needs: ["wheelchair"],
  });

  const result = buildProposal(request, w, []);
  assert.equal(result.unmet.length, 0);
  assert.deepEqual(result.legs.map((leg) => leg.objective), ["woodwork", "pottery"]);
  const woodLeg = result.legs[0];
  assert.equal(woodLeg.mentor_id, "T1");
  // 跨馆交通衔接：第二腿不早于第一腿结束 + 跨馆时长。
  assert.ok(
    new Date(result.legs[1].start).getTime() >=
      new Date(result.legs[0].end).getTime() + 15 * 60000,
  );
  // 资源依据说明用了哪个工位、哪位讲解员及其资质。
  assert.deepEqual(result.resource_basis[0].matched_mentor_support, ["sign_language"]);
  assert.ok(result.resource_basis[0].mentor_certifications.includes("L2"));
});

test("容量、资质、无障碍不足时进入 unmet 并给出每个候选工位的落选原因", () => {
  const request = groupRequest("G1", 18, ["woodwork"], {
    required_certifications_by_objective: { woodwork: ["L3"] },
  });
  const w = world([
    station("W1", "M1", ["woodwork"], { mentors: [mentor("T1", ["woodwork"], { certifications: ["L2"] })] }),
  ]);
  const result = buildProposal(request, w, []);
  assert.equal(result.legs.length, 0);
  assert.equal(result.unmet[0].objective, "woodwork");
  assert.equal(result.unmet[0].candidates[0].reason, "NO_AVAILABLE_MENTOR");

  // 容量不足
  const capacityReq = groupRequest("G2", 19, ["woodwork"]);
  const capacityResult = buildProposal(
    capacityReq,
    world([
      station("W1", "M1", ["woodwork"], {
        capacity: 20,
        mentors: [mentor("T1", ["woodwork"])],
      }),
    ]),
    [{ station_id: "W1", mentor_id: "TX", start: DAY_TS("09:00"), end: DAY_TS("12:00"), seats: 5 }],
  );
  assert.equal(capacityResult.unmet[0].candidates[0].reason, "CAPACITY");

  // 无障碍设施不足
  const accessReq = groupRequest("G3", 10, ["woodwork"], { accessibility_needs: ["wheelchair"] });
  const accessResult = buildProposal(
    accessReq,
    world([station("W1", "M1", ["woodwork"], { accessibility: [], mentors: [mentor("T1", ["woodwork"])] })]),
    [],
  );
  assert.equal(accessResult.unmet[0].candidates[0].reason, "ACCESSIBILITY");
});

test("临时闭馆窗与腿重叠时该工位不可用", () => {
  const request = groupRequest("G1", 10, ["woodwork"]);
  const w = world([
    station("W1", "M1", ["woodwork"], {
      mentors: [mentor("T1", ["woodwork"])],
      unavailable_windows: [{ from: DAY_TS("08:30"), to: DAY_TS("11:30"), reason: "CHECK" }],
    }),
  ]);
  const result = buildProposal(request, w, []);
  // 窗口覆盖了时间窗内的可行起点 → 无腿可排。
  assert.equal(result.legs.length, 0);
  assert.equal(result.unmet[0].candidates[0].reason, "TEMPORARILY_CLOSED");
});

test("重排只替换受影响节点，未变行程原样保留", () => {
  const request = groupRequest("G1", 18, ["woodwork", "pottery"]);
  const w = world([
    station("W1", "M1", ["woodwork"], { mentors: [mentor("T1", ["woodwork"])] }),
    station("W2", "M3", ["woodwork"], { mentors: [mentor("T3", ["woodwork"])] }),
    station("P1", "M2", ["pottery"], { mentors: [mentor("T2", ["pottery"])] }),
  ]);
  const original = buildProposal(request, w, []);
  assert.equal(original.legs.length, 2);
  const potteryLeg = original.legs.find((leg) => leg.objective === "pottery");

  const replanned = replanRoute(request, w, [], original.legs, ["W1"]);
  assert.equal(replanned.unchanged_legs.length, 1);
  assert.equal(replanned.unchanged_legs[0], potteryLeg); // 同一对象引用，未变行程原样保留
  assert.equal(replanned.added_legs[0].station_id, "W2");
  assert.deepEqual(
    replanned.legs.map((leg) => leg.objective),
    ["woodwork", "pottery"],
  );
});

test("无替换节点时取消受影响腿并保留其余行程", () => {
  const request = groupRequest("G1", 18, ["woodwork", "pottery"]);
  const w = world([
    station("W1", "M1", ["woodwork"], { mentors: [mentor("T1", ["woodwork"])] }),
    station("P1", "M2", ["pottery"], { mentors: [mentor("T2", ["pottery"])] }),
  ]);
  const original = buildProposal(request, w, []);
  const replanned = replanRoute(request, w, [], original.legs, ["W1"]);
  assert.equal(replanned.added_legs.length, 0);
  assert.equal(replanned.cancelled_legs.length, 1);
  assert.equal(replanned.cancelled_legs[0].reason, "NO_REPLACEMENT");
  assert.equal(replanned.legs.length, 1);
  assert.equal(replanned.legs[0].objective, "pottery");
  assert.deepEqual(replanned.coverage.missing, ["woodwork"]);
});

test("闭馆窗结束后的空档仍可滑动安排（时间轴多起点）", () => {
  const request = groupRequest("G1", 10, ["woodwork"]);
  const w = world([
    station("W1", "M1", ["woodwork"], {
      mentors: [mentor("T1", ["woodwork"])],
      unavailable_windows: [{ from: DAY_TS("08:30"), to: DAY_TS("10:30"), reason: "CHECK" }],
    }),
  ]);
  const result = buildProposal(request, w, []);
  assert.equal(result.legs.length, 1);
  assert.equal(new Date(result.legs[0].start).getTime(), new Date(DAY_TS("10:30")).getTime());
});

test("同一讲解员不能在时间重叠段被两个团组共用", () => {
  const request = groupRequest("G1", 5, ["woodwork"]);
  const w = world([
    station("W1", "M1", ["woodwork"], { capacity: 20, mentors: [mentor("T1", ["woodwork"])] }),
  ]);
  const result = buildProposal(request, w, [
    { station_id: "W1", mentor_id: "T1", start: DAY_TS("08:00"), end: DAY_TS("12:00"), seats: 5 },
  ]);
  assert.equal(result.legs.length, 0);
  assert.equal(result.unmet[0].candidates[0].reason, "NO_AVAILABLE_MENTOR");
});

test("讲解员忙段结束后可顺延安排", () => {
  const request = groupRequest("G1", 5, ["woodwork"]);
  const w = world([
    station("W1", "M1", ["woodwork"], { capacity: 20, mentors: [mentor("T1", ["woodwork"])] }),
  ]);
  const result = buildProposal(request, w, [
    { station_id: "W1", mentor_id: "T1", start: DAY_TS("08:50"), end: DAY_TS("09:50"), seats: 5 },
  ]);
  assert.equal(result.legs.length, 1);
  assert.equal(new Date(result.legs[0].start).getTime(), new Date(DAY_TS("09:50")).getTime());
});

// 避免夹具未使用告警（DEADLINE/OPENING 为对外常量）。
void DEADLINE;
void OPENING;
