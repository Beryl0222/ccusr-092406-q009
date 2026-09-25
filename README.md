# 技能研学资源编排

职业学校组织学生到多家技能博物馆研学时，临时闭馆、无障碍需求和讲解员资质会让原路线只剩部分可执行，人工重排又容易让同一工位超额接待。本项目在「团组请求、工位容量、行程暂占、路线重排、到访对账」五类骨架事件上实现**弹性编排**领域服务，并整理对应的事件名称、交换字段与脱敏样例，方便业务、运营和研发人员在同一套术语下讨论后续服务。资料只包含领域约定与虚构样例，不包含真实个人信息、生产连接或外部账号。

## 目录

- `src/skill_museum_learning.js`：事件种类、交换字段与最小校验（领域契约）。
- `src/planner.js`：纯函数规划器，把团组请求与工位供给匹配成建议方案。
- `src/orchestrator.js`：事件溯源的编排服务（命令 + 状态重建）。
- `src/reconcile.js`：到访对账（按实际参与证据核对）。
- `src/util.js`：时间比较工具。
- `data/sample.json`：单条虚构事件样例；`data/sample_events.json`：完整生命周期事件流样例。
- `tests/`：契约、规划、编排、恢复与对账的行为测试。

## 本地核对

```bash
npm test        # 运行全部测试
npm run build   # 语法检查全部 src 文件
```

所有测试和构建均在单个 Linux 应用容器内完成，不需要另行启动数据库或外部服务。

## 事件种类

| 事件 | 主体（subject_id） | 含义 |
| --- | --- | --- |
| `GROUP_REQUESTED` | group_id | 团组提交研学请求：学习目标、人数、时间窗、交通衔接（最早开始/最晚结束）、必要支持（如无障碍） |
| `STATION_CAPACITY_SET` | station_id | 设置工位定义：技能、讲解员资质、支持特性、开放时段与容量、停用时段（`closed_slots`） |
| `PLAN_SUGGESTED` | group_id | 建议方案已计算（**只是建议，不占容量**），含未覆盖目标与容量核算依据 |
| `ITINERARY_HELD` | group_id | 老师确认后暂占资源，含 `hold_until` 截止时间与整套节点 |
| `PLAN_FINALIZED` | group_id | 学校/场馆最终确认，方案不再因超时释放 |
| `HOLD_RELEASED` | group_id | 拒绝 / 超时 / 被取代时**原子释放全部占用**（单个事件） |
| `ROUTE_REPLANNED` | group_id | 局部停用后重排：保留未变节点、替换受影响节点、记录原因与资源依据，版本 +1 |
| `CHECK_IN_RECORDED` | group_id | 离线签到证据（按 `checkin_id` 幂等，永不占用容量） |
| `WAITLIST_PROMOTED` | group_id | 容量释放后候补节点转为暂占 |
| `VISIT_RECONCILED` | group_id | 结束后对账：目标覆盖、缺席、临时替代、计划外到访、重复签到 |

每类事件的 payload 必填字段见 `src/skill_museum_learning.js` 的 `PAYLOAD_FIELDS`；`validateEvent` 同时校验 `occurred_at` 可解析、`subject_id` 与 payload 主体一致。

## 方案状态机

```
PLAN_SUGGESTED ──确认──> HELD ──最终确认──> FINALIZED ──对账──> COMPLETED
   │                      │ 超时(tick)          │
   │                      ▼                     ▼
   └──确认新方案──> HOLD_RELEASED(SUPERSEDED)  HOLD_RELEASED(REJECTED/CANCELLED)
HELD ──局部停用──> ROUTE_REPLANNED（版本+1，截止时间不变）
```

## 弹性编排不变量

1. **建议与暂占分离**：`suggestPlan` 是纯计算，确认（`confirmPlan`）时才按当前状态重新校验并暂占；校验失败不追加任何事件。
2. **一套有效方案**：一个团组同一时刻最多一个 HELD/FINALIZED 方案；确认新方案会在同一命令内先原子释放旧方案再暂占新方案。
3. **原子释放**：拒绝与超时通过单个 `HOLD_RELEASED` 事件释放方案全部节点；超时判断只依赖事件中的绝对截止时间 `hold_until`。
4. **幂等容量**：重复确认同一方案是空操作；离线签到按 `checkin_id` 去重且永不占用容量；同一工位重复扫码在对账中只计一次到访。
5. **局部重排**：工位容量事件后自动检测失效节点（时段关闭/变更、资质或支持变化、容量调减后被驱逐），只替换受影响节点，未变行程原样保留，暂占截止时间不变；容量调减时先占者保留、后占者被驱逐。
6. **候补推进**：任何释放或扩容后按登记顺序推进候补；服务恢复（`Orchestrator.fromEvents`）后 `tick` 仍按原截止时间释放与推进，不依赖运行期定时器。
7. **可解释**：建议、暂占与重排事件都携带容量核算与原因（`rationale` / `resource_basis`），对账事件汇总目标覆盖、缺席与临时替代，学校能解释每次改线及其资源依据。

## 服务接口（`src/orchestrator.js`）

```js
import { Orchestrator } from "../src/orchestrator.js";

const orch = new Orchestrator();
orch.submitGroupRequest(cmd, { now });          // 团组请求（有有效方案时拒绝变更）
orch.setStationCapacity(cmd, { now });          // 工位容量/停用；自动重排受影响方案并推进候补
const suggestion = orch.suggestPlan(groupId, { now });        // 建议（不占容量）
orch.confirmPlan(groupId, planId, { now, holdUntil });        // 确认暂占（幂等；自动取代旧方案）
orch.finalizePlan(groupId, { now });            // 最终确认，不再超时
orch.rejectPlan(groupId, { now });              // 拒绝，原子释放（幂等）
orch.checkIn(cmd, { now });                     // 离线签到（按 checkin_id 幂等）
orch.tick({ now });                             // 时钟推进：超时释放 + 候补推进
orch.replanGroup(groupId, { now });             // 手动触发重排
orch.reconcile(groupId, { now });               // 到访对账（幂等）

// 服务恢复：重放事件流即可重建全部状态
const restored = Orchestrator.fromEvents(orch.events);
```

所有命令都接受显式 `now`（ISO 8601），领域逻辑不读取系统时钟，因此恢复后的行为与一直在场实例完全一致（测试中有逐事件比对）。
