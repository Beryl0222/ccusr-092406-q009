import assert from "node:assert/strict";
import test from "node:test";
import { computeSuggestion } from "../src/planner.js";
import { DAY, makeRequest, muStation, taoStation, taoStation2 } from "./helpers.js";

const full = () => () => 99;

test("学习目标与工位技能、开放时段匹配，产出可暂占节点", () => {
  const result = computeSuggestion({
    request: makeRequest(),
    stations: [taoStation(), muStation()],
    remainingCapacity: full(),
  });
  assert.equal(result.unmet_goals.length, 0);
  assert.equal(result.nodes.length, 2);
  assert.deepEqual(
    result.nodes.map((n) => [n.station_id, n.goals]),
    [
      ["st-tao", ["陶艺拉坯"]],
      ["st-mu", ["木作榫卯"]],
    ],
  );
  assert.ok(result.nodes.every((n) => n.status === "AVAILABLE"));
});

test("一个工位覆盖多个目标时合并为一个节点", () => {
  const both = taoStation({ skills: ["陶艺拉坯", "木作榫卯"], mentor_skills: ["陶艺拉坯", "木作榫卯"] });
  const result = computeSuggestion({ request: makeRequest(), stations: [both], remainingCapacity: full() });
  assert.equal(result.nodes.length, 1);
  assert.deepEqual(result.nodes[0].goals, ["陶艺拉坯", "木作榫卯"]);
});

test("讲解员资质不足的工位被排除并说明原因", () => {
  const noMentor = taoStation({ mentor_skills: [] });
  const result = computeSuggestion({
    request: makeRequest({ goals: ["陶艺拉坯"] }),
    stations: [noMentor],
    remainingCapacity: full(),
  });
  assert.equal(result.nodes.length, 0);
  assert.deepEqual(result.unmet_goals, [{ goal: "陶艺拉坯", cause: "NO_QUALIFIED_MENTOR" }]);
});

test("必要支持（无障碍）不满足的工位被排除", () => {
  const noAccess = taoStation({ support_features: [] });
  const result = computeSuggestion({
    request: makeRequest({ goals: ["陶艺拉坯"] }),
    stations: [noAccess],
    remainingCapacity: full(),
  });
  assert.deepEqual(result.unmet_goals, [{ goal: "陶艺拉坯", cause: "SUPPORT_MISMATCH" }]);
});

test("交通衔接边界之外的时段不可用", () => {
  const early = taoStation({
    slots: [{ slot_id: "dawn", start: `${DAY}T07:00:00+08:00`, end: `${DAY}T08:30:00+08:00`, capacity: 30 }],
  });
  const result = computeSuggestion({
    request: makeRequest({ goals: ["陶艺拉坯"] }),
    stations: [early],
    remainingCapacity: full(),
  });
  assert.deepEqual(result.unmet_goals, [{ goal: "陶艺拉坯", cause: "OUTSIDE_WINDOW" }]);
});

test("容量不足的时段进入候补而不是超占", () => {
  const result = computeSuggestion({
    request: makeRequest({ goals: ["陶艺拉坯"] }),
    stations: [taoStation()],
    remainingCapacity: () => 10,
  });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].status, "WAITLIST");
  assert.equal(result.unmet_goals.length, 0);
  assert.equal(result.rationale.waitlist[0].cause, "NO_CAPACITY");
});

test("没有场馆教授的目标报告为未覆盖", () => {
  const result = computeSuggestion({
    request: makeRequest({ goals: ["古琴修复"] }),
    stations: [taoStation()],
    remainingCapacity: full(),
  });
  assert.deepEqual(result.unmet_goals, [{ goal: "古琴修复", cause: "NO_STATION" }]);
});

test("同一团组的节点在时间上互不重叠", () => {
  const overlap = muStation({
    skills: ["木作榫卯"],
    slots: [{ slot_id: "overlap", start: `${DAY}T10:00:00+08:00`, end: `${DAY}T11:30:00+08:00`, capacity: 30 }],
  });
  const later = muStation();
  const result = computeSuggestion({
    request: makeRequest(),
    stations: [taoStation(), overlap, later],
    remainingCapacity: full(),
  });
  const ranges = result.nodes.map((n) => [n.start, n.end]).sort();
  for (let i = 1; i < ranges.length; i += 1) assert.ok(ranges[i][0] >= ranges[i - 1][1], "节点不得重叠");
  // 木作榫卯应落在下午时段，而非与陶艺重叠的上午时段
  const muNode = result.nodes.find((n) => n.goals.includes("木作榫卯"));
  assert.equal(muNode.slot_id, "st-mu-pm");
});

test("重排时保留节点作为固定约束", () => {
  const kept = [
    {
      node_id: "kept",
      station_id: "st-tao",
      slot_id: "st-tao-am",
      start: `${DAY}T09:30:00+08:00`,
      end: `${DAY}T11:00:00+08:00`,
      goals: ["陶艺拉坯"],
      status: "HELD",
    },
  ];
  const overlapMu = muStation({
    station_id: "st-mu-early",
    slots: [{ slot_id: "clash", start: `${DAY}T10:30:00+08:00`, end: `${DAY}T12:00:00+08:00`, capacity: 30 }],
  });
  const result = computeSuggestion({
    request: makeRequest({ goals: ["木作榫卯"] }),
    stations: [overlapMu, muStation()],
    remainingCapacity: full(),
    keptNodes: kept,
  });
  assert.equal(result.nodes[0].slot_id, "st-mu-pm", "应避开与保留节点冲突的时段");
});

test("依据（rationale）记录容量核算，便于解释", () => {
  const result = computeSuggestion({
    request: makeRequest({ goals: ["陶艺拉坯"] }),
    stations: [taoStation()],
    remainingCapacity: () => 25,
  });
  assert.deepEqual(result.rationale.nodes[0], {
    station_id: "st-tao",
    slot_id: "st-tao-am",
    covered_goals: ["陶艺拉坯"],
    headcount: 20,
    remaining_capacity_before: 25,
    remaining_capacity_after: 5,
  });
});
