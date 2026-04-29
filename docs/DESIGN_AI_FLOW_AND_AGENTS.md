# AI 说书人 / AI 玩家与流程编排 — 交付设计方案

本文档将讨论结论固化为**可评审、可排期、可验收**的设计方案：与当前仓库实现（`server/src/game/gameEngine.ts`、`server/src/index.ts`、`server/src/ai/*`、`server/src/script/troubleBrewing.ts`）对齐，并说明演进路径。

---

## 1. 背景与目标

### 1.1 问题

- **AI 说书人**与**AI 玩家**职责边界在实现层混用（例如「说书人」既指 LLM 裁量，又指计时推进），易导致协作理解与调试困难。
- **AI 玩家**使用通用「单步动作」接口时，可能在错误阶段输出无关动作（聊天、投票等），与真实玩家「当前能点的按钮」不一致。
- **夜晚技能顺序**必须strictly 遵循剧本；任何插队或并行夜行动都会破坏规则与信息Reveal时机。

### 1.2 目标

1. **流程与策略分离**：推进桌子的人不替玩家做策略；玩家代理不改写夜序。
2. **阶段化 AI 玩家**：每个游戏子状态只开放**合法动作集合**，大模型仅在需要策略的节点调用。
3. **夜序单一事实源**：`Script.firstNightOrder` / `Script.otherNightOrder` + `nightStepIndex`；所有夜步注册与处理与之对齐。
4. **可验收**：用一场完整对局的**时间线表**作为集成验收清单。

---

## 2. 设计原则（非妥协项）

| 编号 | 原则 | 说明 |
|------|------|------|
| P-1 | **夜序权威在剧本** | 禁止绕过 `getCurrentNightOrder` / `getCurrentNightStep` 另开夜流程。新增角色先改顺序表，再接线引擎与 `runNightLoop`。 |
| P-2 | **Director 默认不用 LLM** | 阶段切换、超时兜底、投票结算广播等由确定性逻辑完成，避免「模型当主持人」带来的不可复现。 |
| P-3 | **Grimoire LLM 只做裁量** | 仅输出规则允许的说书人设定内容（如「两玩家 + 一镇上善良身份」），不代为投票、选刀、聊天。 |
| P-4 | **Seat Agent 对齐 UI** | 某阶段模型输出必须等价于「该玩家在客户端本阶段可发起的一种合法操作」。 |
| P-5 | **混合房间可完结** | 人类座位必须有阶段 SLA + 规则内安全默认值，避免 API 故障或挂机导致永久阻塞。 |

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Game Engine（规则状态机）                  │
│  Room / advanceNight / submitNightAction / 白天提名投票…       │
│  夜序：script.firstNightOrder | otherNightOrder + nightStepIndex │
└─────────────────────────────────────────────────────────────┘
          ▲                                    │
          │ 仅通过既定 API 推进                  │ 产出 pending / phase / logs
          │                                    ▼
┌──────────────────────┐          ┌──────────────────────────────┐
│ Director（流程导演）   │          │ Grimoire LLM（说书人裁量）     │
│ - runNightLoop 调度   │          │ - getStorytellerDecision     │
│ - 投票收尾 / 天夜切换  │          │ - 校验 + 失真由引擎负责        │
│ - 超时与兜底          │          └──────────────────────────────┘
│ - 广播 phase / prompt │
└──────────────────────┘
          │
          │ 每个真人/AI 座位
          ▼
┌──────────────────────┐
│ Seat Agent（单座代理） │
│ - 按子状态调用不同 LLM │
│ - 输出 nominate/C_vote/night_action/… │
└──────────────────────┘
```

### 3.1 与现有代码映射（现状 → 目标命名）

| 概念 | 当前主要位置 | 目标职责 |
|------|----------------|----------|
| Director | `index.ts` 中 `setInterval`、`maybeAiTakeoverDay/Night`、`runNightLoop` 调用链 | 集中「无策略」推进；名称/注释与 LLM 说书人区分 |
| Grimoire LLM | `ai/storyteller.ts` → `getStorytellerDecision` | 保持：仅裁量步；扩展时只增加 `validateDecision` 覆盖的 step |
| Seat Agent | `ai/playerAgent.ts` + `index.ts` 定时器内编排 | 拆分为阶段专用决策函数 + 收紧 `allowedActions` |
| 夜序 | `script/troubleBrewing.ts`、`gameEngine.getCurrentNightStep` | **唯一源**；缺位角色（如掘墓夜信息）以「补顺序表 + 注册处理」还债 |

---

## 4. 游戏阻塞点与 Director 职责

与 `Room` 已存在字段对齐（概念层）：

| 阻塞条件 | Director 必须保证 |
|----------|-------------------|
| `pendingNightAction != null` | 仅当前 `actorSeatIndex` 可 `submitNightAction`；AI/人类超时按规则兜底（合法目标或跳过规则允许跳过的情况）。 |
| `awaitingNightConfirm` | 收集全员确认后 `finishNightAndGotoDay`；AI 托管可自动确认，但不得跳过未处理完的夜步。 |
| 白天 `daySubPhase === 'nomination'` 且需每人决策 | 每名存活玩家完成 `nominate` 或 `skip_nomination` 后才能进入「可结束白天」判定。 |
| `currentNomination != null` | 可投票者完成 `vote` 后 `tallyVotes` 并广播；全员投完才能关闭本轮提名（与现逻辑一致）。 |

**说明：** `maybeAiTakeoverDay` 类逻辑归类为 Director 的「计时/收尾辅助」，文档与代码注释中避免简称为「AI 说书人」，以免与 `storyteller.ts` 混淆。

---

## 5. Seat Agent：阶段化 LLM 契约（目标接口）

以下为**逻辑接口**（实现时可仍为同一 `fetch` 封装，但 **system prompt + JSON schema + 校验器**按阶段拆分）。

| 子状态（判定方式） | 函数（建议名） | 模型输出类型 | 禁止 |
|--------------------|----------------|--------------|------|
| 任意（可选） | `reflectNightInfo` | 仅私用摘要 / noop | 改房间状态 |
| `pendingNightAction.actorSeat === me` | `decideNightTargets` | `night_action`，`targets.length === pick` | `chat_*`、`nominate`、`vote` |
| `awaitingNightConfirm` 且未确认 | `confirmNightEnd` | `night_confirm` 或硬编码 true | 与当夜步无关的聊天 |
| 白天讨论 | `planDaySocial` | 对齐现有 `day_plan`（DM + public + 提名/投票倾向） | 在本阶段发 `night_action` |
| 提名轮到自己 | `decideNomination` | `nominate` / `skip_nomination` | 冗长公聊（若已单独「讨论阶段」） |
| 存在 `currentNomination` 且可投未投 | `decideVote` | `vote` | 改提名对象 |
| 白天技能窗口 | `decideDayAbility` | `day_action` | 夜间逻辑 |

**校验：** 服务端在应用前做**阶段门控**：若解析出的 `type` 不在当前阶段 `allowedActions` 内 → 丢弃并记日志 / 走兜底。

---

## 6. Grimoire LLM（说书人裁量）

### 6.1 当前已接入（参考）

- 洗衣妇 / 图书管理员 / 调查员：LLM 输出两名座位 + `characterId`（善良池校验），中毒/醉酒后的错误呈现由引擎 `distortWasherLibrarianInvestigatorDecision` 处理。
- 恶魔刀目标：可与 LLM 或随机策略结合（`validateDecision` 已限制存活座位）。

### 6.2 扩展规则

- 每新增裁量 step：`buildStorytellerRequest` 扩展字段 → `callOpenAI` schema → `validateDecision` → `toEngineDecision`。
- **不得**在 Grimoire 内调用「替某座位 `submitNightAction`」；夜行动仍以 Seat Agent + 引擎为准。

---

## 7. 夜序与剧本：单一事实源与扩展清单

### 7.1 权威数据

- `Script.firstNightOrder`、`Script.otherNightOrder`（例：`server/src/script/troubleBrewing.ts`）。
- 引擎 `getCurrentNightOrder(room)` / `getCurrentNightStep(room)`。

### 7.2 实现纪律

1. 在官方 «Trouble Brewing»（或目标剧本）中确认**完整**夜晚顺序。
2. 在剧本对象中**补全** `firstNightOrder` / `otherNightOrder`（含信息类与行动类步骤的正确相对位置）。
3. 在 `advanceNight` 中声明：该 step 是「跳过 / 等待说书人 / 设置 `pendingNightAction` / 交由 `runNightLoop` 发信息」中的哪一种。
4. 在 `runNightLoop`（或未来的表驱动注册表）中：**仅当 `getCurrentNightStep(room) === stepId`** 时处理该步并发信/调用 Grimoire，然后递增索引，避免与 `advanceNight` 双写不同步。

### 7.3 技术债（排期时显式列入）

- 若某角色有能力但**未**出现在 `otherNightOrder` / `firstNightOrder` 中，应在「夜序对齐」里程碑中修复，而不是在别处散发自定义夜消息。

---

## 8. 完整对局预演（验收用例大纲）

以下用于**手工或日志自动化**验收：每一步记录 `phase`、`dayNumber`、`getCurrentNightStep`、`pendingNightAction`、`currentNomination`、`votes` 等关键字段。

| 段 | 步骤 | 期望 |
|----|------|------|
| 开局 | start | `first_night`，`nightStepIndex` 从 0 开始 |
| 首夜 | 按 `firstNightOrder` 逐步 | 信息步仅目标座位收到 `night_info`；行动步仅当 `night_prompt` 对应座位提交后 `nightStepIndex` 前进 |
| 首夜末 | 全员 night_confirm | `finishNightAndGotoDay` → `day`，进入提名 |
| 第 1 天 | 每名存活 nominate/skip | 无遗漏则白天可结束；多轮投票则每轮全员投票后 `vote_result` |
| 入夜 | 处决结算后 | `night`，`nightStepIndex` 重置，严格按 `otherNightOrder` |
| 普通夜 | poisoner → … → imp → ravenkeeper | **顺序固定**；恶魔仅 imp 步行动；守鸦信息在 ravenkeeper 步处理 |
| 循环 | 日↔夜 | 直到 `checkWin` → `game_over` |

（具体座位与角色可fixture为一局 7 人标准配置，用于回归。）

---

## 9. 工程交付物（代码侧）

| 交付物 | 内容 |
|--------|------|
| D-1 | `Director` 模块或 `index.ts` 内聚函数：`tickDirector(room)`、`tickSeatAgent(room, seat)`，行为与现网等价后再迭代 |
| D-2 | `playerAgent.ts`：阶段化函数 + 统一 `allowedActions` 门控；夜晚 `pendingNightAction` 时仅 `decideNightTargets` |
| D-3 | 夜步**表驱动**注册（可选但推荐）：`Record<stepId, Handler>`，减少 `runNightLoop` 巨型 if |
| D-4 | 人类 SLA 与兜底策略（配置项：`AI_HUMAN_PHASE_TIMEOUT_MS` 等） |
| D-5 | 日志：`Director` 打当前阻塞原因；`Seat Agent` 打阶段 + `allowedActions` |

---

## 10. 里程碑（建议）

| 阶段 | 范围 | 完成标准 |
|------|------|----------|
| M0 | 文档评审 | 本方案与团队对齐 P-1～P-5 |
| M1 | 无行为搬家 | 抽出 Director / Seat 计时边界，**逻辑与现网一致**，测试一局全 AI 跑通 |
| M2 | Seat Agent 阶段门控 | 夜行动阶段拒绝 `chat_*`/投票类输出；超时合法兜底 |
| M3 | 夜序还债 + 表驱动 | 剧本 order 与官方一致；掘墓等缺位步骤按序接入；`runNightLoop` 与 `advanceNight` 无冲突 |
| M4 | 混合房间 SLA | 人类超时默认 skip/反对/随机合法夜目标等可配置 |

---

## 11. 风险与对策

| 风险 | 对策 |
|------|------|
| LLM 延迟导致全 AI 房间慢 | 并行仅允许「不同座位不同天」的预算；同一步夜行动仍串行；可降模或缓存确定性兜底 |
| 夜序与 `runNightLoop` 双写漂移 | M3 表驱动 + 单测：`order` 中每一步恰好被处理一次 |
| 与官方规则仍「简化版」 | 在 `DEV_PLAN.md` 或剧本 README 标明差异；本方案只保证**顺序与实现自洽** |

---

## 12. 文档维护

- 实施变更时：更新夜序表、`validateDecision`、验收预演表中的步骤。
- 本文件版本：**1.0**（与对话结论同步）；后续迭代在文末追加修订记录。

---

**修订记录**

- **1.0**（2026-04-03）：初版 — Director / Grimoire / Seat Agent 分责、夜序单一源、阶段化 AI 玩家、验收预演与里程碑。
- **1.1**（2026-04-03）：部分落地 — `night/runNightLoop.ts` 承载自动夜序；`decideAiPlayerNightTargets` 专用于夜晚行动；`tickFlowDirector` + `AI_DIRECTOR_LOG`；`otherNightOrder` 增补 `undertaker`（与信息发放逻辑一致）。未改 `DEV_PLAN.md`。
- **1.2**（2026-04-23）：终局复盘增强 — 在 AI 调用详情区域补充终局统计（总调用/成功/失败/失败原因聚合）；终局问答从“仅问上帝”扩展为“可问任意玩家”，用于解释高争议行为（如爪牙提名恶魔）背后的上下文与策略动机。
