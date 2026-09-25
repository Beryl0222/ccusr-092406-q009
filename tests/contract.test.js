import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EVENT_KINDS, validateEvent } from "../src/skill_museum_learning.js";

const load = (name) => readFile(new URL(`../data/${name}`, import.meta.url), "utf8").then(JSON.parse);

test("样例符合领域约定", async () => {
  const record = await load("sample.json");
  assert.deepEqual(validateEvent(record), []);
});

test("生命周期样例事件流全部符合领域约定", async () => {
  const stream = await load("sample_events.json");
  assert.ok(stream.length >= 8);
  for (const event of stream) assert.deepEqual(validateEvent(event), [], event.event_id);
});

test("既有五类骨架事件仍在契约中", () => {
  for (const kind of ["GROUP_REQUESTED", "STATION_CAPACITY_SET", "ITINERARY_HELD", "ROUTE_REPLANNED", "VISIT_RECONCILED"]) {
    assert.ok(EVENT_KINDS.includes(kind), kind);
  }
});

test("缺少顶层字段", () => {
  const problems = validateEvent({ kind: "GROUP_REQUESTED" });
  assert.ok(problems.includes("event_id"));
  assert.ok(problems.includes("occurred_at"));
  assert.ok(problems.includes("subject_id"));
  assert.ok(problems.includes("payload"));
});

test("未知事件种类", () => {
  const problems = validateEvent({
    event_id: "x",
    kind: "NOPE",
    occurred_at: "2026-09-20T09:00:00+08:00",
    subject_id: "g1",
    payload: {},
  });
  assert.deepEqual(problems, ["kind"]);
});

test("缺少 payload 必填字段", () => {
  const problems = validateEvent({
    event_id: "x",
    kind: "GROUP_REQUESTED",
    occurred_at: "2026-09-20T09:00:00+08:00",
    subject_id: "g1",
    payload: { group_id: "g1", goals: ["陶艺拉坯"], time_window: { start: "a", end: "b" } },
  });
  assert.deepEqual(problems, ["payload.headcount"]);
});

test("subject_id 与 payload 主体不一致", () => {
  const problems = validateEvent({
    event_id: "x",
    kind: "STATION_CAPACITY_SET",
    occurred_at: "2026-09-20T09:00:00+08:00",
    subject_id: "st-other",
    payload: { station_id: "st-tao", slots: [] },
  });
  assert.deepEqual(problems, ["subject_id"]);
});

test("occurred_at 无法解析", () => {
  const problems = validateEvent({
    event_id: "x",
    kind: "PLAN_FINALIZED",
    occurred_at: "not-a-time",
    subject_id: "g1",
    payload: { plan_id: "p1", group_id: "g1" },
  });
  assert.deepEqual(problems, ["occurred_at"]);
});
