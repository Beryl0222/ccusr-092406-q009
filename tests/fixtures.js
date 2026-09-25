// 测试夹具：虚构场馆、工位、讲解员与团组，不含任何真实信息。
import { createService } from "../src/service.js";

const DAY = "2026-09-25";
export const OPENING = { start: `${DAY}T08:00:00+08:00`, end: `${DAY}T18:00:00+08:00` };
export const DEADLINE = "2026-09-24T18:00:00+08:00";
export const DAY_TS = (hhmm) => `${DAY}T${hhmm}:00+08:00`;

export function mentor(id, skills, extra = {}) {
  return { mentor_id: id, skills, certifications: [], support: [], ...extra };
}

export function station(id, museumId, objectives, extra = {}) {
  return {
    station_id: id,
    museum_id: museumId,
    capacity: 20,
    opening: OPENING,
    accessibility: ["wheelchair"],
    objectives,
    mentors: [],
    ...extra,
  };
}

export function groupRequest(id, size, objectives, extra = {}) {
  return {
    group_id: id,
    size,
    learning_objectives: objectives,
    time_window: { start: DAY_TS("09:00"), end: DAY_TS("12:00") },
    accessibility_needs: ["wheelchair"],
    required_mentor_certifications: [],
    release_deadline: DEADLINE,
    ...extra,
  };
}

// 标准世界：W1 木工、P1 陶艺各一个工位（容量竞争场景）；可追加 W2 作为木工替换工位。
export function buildService({ withReplacement = false } = {}) {
  const svc = createService({
    inter_museum_minutes: 15,
    intra_museum_minutes: 5,
    default_leg_minutes: 40,
    arrival_buffer_minutes: 5,
  });
  svc.registerStation(
    station("W1", "M1", ["woodwork"], { mentors: [mentor("T1", ["woodwork"], { certifications: ["L2"] })] }),
    "2026-09-24T09:00:00+08:00",
  );
  svc.registerStation(
    station("P1", "M2", ["pottery"], { mentors: [mentor("T2", ["pottery"])] }),
    "2026-09-24T09:00:00+08:00",
  );
  if (withReplacement) {
    // 替换工位放在别的馆，使"整馆闭馆"场景下仍有可替换节点。
    svc.registerStation(
      station("W2", "M3", ["woodwork"], { mentors: [mentor("T3", ["woodwork"], { certifications: ["L2"] })] }),
      "2026-09-24T09:00:00+08:00",
    );
  }
  return svc;
}

export function kindsOf(svc) {
  return svc._events.map((event) => event.kind);
}

export function eventsOf(svc, kind) {
  return svc._events.filter((event) => event.kind === kind);
}
