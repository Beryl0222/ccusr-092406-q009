# 技能研学团组弹性编排服务

面向职业学校组织学生到多家技能博物馆研学的场景：临时闭馆、无障碍需求、讲解员资质会让原路线只剩部分可执行，人工重排又容易让同一工位超额接待。本项目实现一套**事件溯源（event-sourced）的弹性编排领域核心**，把团组请求、工位容量、行程暂占、路线重排、候补推进与到访对账统一在同一套事件术语下。

全部代码为零依赖的 Node ESM，可在单个容器内构建与测试，不需要数据库或外部服务。

## 目录

- `src/skill_museum_learning.js`：事件种类、信封/载荷字段校验。
- `src/planning.js`：纯函数规划器（匹配、成线、局部重排），不暂占任何资源。
- `src/service.js`：编排状态机。命令产生事件，状态完全由事件重放得到。
- `data/sample.json`：符合严格校验的虚构事件样例。
- `tests/`：契约测试（样例格式）、规划器测试、服务场景测试。

## 本地核对

```bash
npm test   # 运行全部 node:test 用例
npm run build  # 对三个源文件做语法检查
```

## 领域事件

| 事件 | 含义 |
| --- | --- |
| `GROUP_REQUESTED` | 团组请求：学习目标、人数、时间窗、交通衔接、无障碍/支持需求、**绝对释放截止时间** |
| `STATION_CAPACITY_SET` | 工位容量、开放时段、无障碍条件、讲解员技能/资质/可用时段 |
| `STATION_UNAVAILABLE_DECLARED` | 工位或整馆临时停用（闭馆、检修），带作用域与时间窗 |
| `PLAN_PROPOSED` / `PLAN_SUPERSEDED` | 编排**建议**及其作废；建议不暂占容量 |
| `ITINERARY_HELD` | 老师确认后在单个原子批次内暂占全部工位与讲解员 |
| `HOLD_RELEASED` | 拒绝 `REJECTED`、超时 `EXPIRED`、替换 `REPLACED`、对账结束 `RECONCILED` 时原子释放全部占用 |
| `ROUTE_REPLANNED` | 局部停用后只替换受影响节点，未变行程原样保留 |
| `WAITLIST_JOINED` / `WAITLIST_PROMOTED` | 容量不足时按团组候补，释放后按位次推进 |
| `CHECK_IN_RECORDED` | 离线/在线签到，带幂等键 |
| `VISIT_RECONCILED` | 按签到证据核对目标覆盖、缺席、临时替代并给出解释 |

## 关键不变量

1. **计算结果只是建议**：`propose()` 不写任何占用；只有老师 `confirm()` 才在同一命令批次内原子暂占。
2. **一团一方案**：确认新方案时先以 `REPLACED` 释放旧方案再暂占，日志中无"两方案并存"的中间态。
3. **原子释放**：拒绝/超时/对账通过单个携带全部腿的 `HOLD_RELEASED` 事件释放跨工位、讲解员的占用。
4. **局部替换**：闭馆只重排与停用窗时间重叠的腿；未变腿保持同一对象引用；找不到替代的节点进入 `cancelled_legs`，其余行程保留。
5. **容量与讲解员不超额**：工位席位按时间重叠段累计；讲解员跨工位的时间重叠也全局拦截；规划器沿时间轴尝试闭馆窗结束、忙段结束等多个起点后顺延。
6. **幂等**：确认与签到携带 `idempotency_key`，重复确认返回 `ALREADY_HELD`、重复签到返回 `DUPLICATE_IGNORED`，不会多占容量。
7. **绝对截止时间**：截止时间记录在事件中，停机不延长。`recover(at)`/`tick(at)` 重放后对已过截止的占用立即释放，并继续推进候补（候补同样受该截止时间约束）。
8. **可解释对账**：`reconcile()` 以签到为参与证据，输出目标覆盖、缺席工位、临时替代链及每条替代的资源依据（工位、讲解员、资质、容量余量）。

## 最小用法

```js
import { createService } from "./src/service.js";

const svc = createService({ inter_museum_minutes: 15, default_leg_minutes: 40 });

svc.registerStation({
  station_id: "W1", museum_id: "M1", capacity: 20,
  opening: { start: "2026-09-25T08:00:00+08:00", end: "2026-09-25T18:00:00+08:00" },
  accessibility: ["wheelchair"], objectives: ["woodwork"],
  mentors: [{ mentor_id: "T1", skills: ["woodwork"], certifications: ["L2"], support: [] }],
});

svc.registerRequest({
  group_id: "G1", size: 18,
  learning_objectives: ["woodwork"],
  time_window: { start: "2026-09-25T09:00:00+08:00", end: "2026-09-25T12:00:00+08:00" },
  accessibility_needs: ["wheelchair"],
  required_certifications_by_objective: { woodwork: ["L2"] },
  release_deadline: "2026-09-24T18:00:00+08:00",
});

const proposal = svc.propose("G1");              // 建议，零占用
svc.confirm("G1", proposal.proposal_id,          // 老师确认后暂占
  { idempotencyKey: "teacher-confirm-1" });

svc.declareUnavailable({
  scope: "STATION", ref_id: "W1",
  from: "2026-09-25T09:00:00+08:00", to: "2026-09-25T10:30:00+08:00",
  reason: "EQUIPMENT_CHECK",
}); // 自动局部重排受影响的在途行程
svc.tick("2026-09-24T18:01:00+08:00");           // 超时释放并推进候补

const log = svc.snapshot().events;               // 持久化事件日志
import { replayService } from "./src/service.js";
const restored = replayService(log);             // 崩溃恢复：状态一致，截止时间不变
restored.recover("2026-09-24T20:00:00+08:00");   // 按原截止时间继续释放与候补
```

## 关于数据

样例与测试中的场馆、团组、讲解员标识均为虚构，不含真实个人信息、生产连接或外部账号。
