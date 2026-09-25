// 测试共用的虚构夹具：时间、团组请求与工位定义。

export const DAY = "2026-10-12";
export const T = {
  request: "2026-09-20T09:00:00+08:00",
  capacity: "2026-09-20T09:05:00+08:00",
  suggest: "2026-09-20T09:10:00+08:00",
  confirm: "2026-09-20T09:20:00+08:00",
  confirmLater: "2026-09-20T10:20:00+08:00",
  holdUntil: "2026-09-25T18:00:00+08:00",
  afterHold: "2026-09-26T09:00:00+08:00",
  visit: "2026-10-12T10:00:00+08:00",
  reconcile: "2026-10-12T18:00:00+08:00",
};

export function makeRequest(overrides = {}) {
  return {
    group_id: "g1",
    headcount: 20,
    goals: ["陶艺拉坯", "木作榫卯"],
    time_window: { start: `${DAY}T08:30:00+08:00`, end: `${DAY}T16:00:00+08:00` },
    transport: { earliest_start: `${DAY}T09:00:00+08:00`, latest_end: `${DAY}T15:30:00+08:00` },
    support_needs: ["wheelchair"],
    ...overrides,
  };
}

export function taoStation(overrides = {}) {
  return {
    station_id: "st-tao",
    venue_id: "museum-tao",
    skills: ["陶艺拉坯"],
    mentor_skills: ["陶艺拉坯"],
    support_features: ["wheelchair"],
    slots: [
      { slot_id: "st-tao-am", start: `${DAY}T09:30:00+08:00`, end: `${DAY}T11:00:00+08:00`, capacity: 30 },
    ],
    ...overrides,
  };
}

// 陶艺替代工位：与 st-tao-am 同时段，用于局部停用后的替换。
export function taoStation2(overrides = {}) {
  return {
    station_id: "st-tao2",
    venue_id: "museum-tao",
    skills: ["陶艺拉坯"],
    mentor_skills: ["陶艺拉坯"],
    support_features: ["wheelchair"],
    slots: [
      { slot_id: "st-tao2-am", start: `${DAY}T09:45:00+08:00`, end: `${DAY}T11:15:00+08:00`, capacity: 30 },
    ],
    ...overrides,
  };
}

export function muStation(overrides = {}) {
  return {
    station_id: "st-mu",
    venue_id: "museum-mu",
    skills: ["木作榫卯"],
    mentor_skills: ["木作榫卯"],
    support_features: ["wheelchair"],
    slots: [
      { slot_id: "st-mu-pm", start: `${DAY}T13:00:00+08:00`, end: `${DAY}T14:30:00+08:00`, capacity: 30 },
    ],
    ...overrides,
  };
}

// 快速搭好「请求 + 双工位」的服务，返回编排器。
export function seededOrchestrator(orchestrator, { requestOverrides, stations } = {}) {
  orchestrator.submitGroupRequest(makeRequest(requestOverrides), { now: T.request });
  for (const station of stations ?? [taoStation(), muStation()]) {
    orchestrator.setStationCapacity(station, { now: T.capacity });
  }
  return orchestrator;
}
