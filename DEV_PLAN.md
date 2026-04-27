# Blood on the Clocktower（Trouble Brewing）开发总览

本文件是“下一次继续开发”的单一入口，目标是让人和大模型都能在 3-5 分钟内理解：

- 项目做到了什么
- 当前卡在哪里
- 哪些规则边界不能动错
- 下一步应该优先做什么

---

## 1. 项目当前定位（请先读）

- 当前实现是 **Trouble Brewing 的可运行工程版**，重点是完整跑通线上局流程，而非 100% 规则还原。
- 系统架构已收敛为：`玩家意图 -> 说书人裁决 -> 规则引擎落地`。
- 近期改动重点是：**说书人边界明确化、AI 托管可控化、流程可观测化**。

一句话状态：  
**核心流程可跑、AI 能接管、日志可复盘；但规则完整度和说书人白天裁量仍需继续补齐。**

---

## 1.1 开发原则（必须遵守）

- **根因优先，禁止掩盖**：发现问题必须修复真实根因，不允许通过定制化分支、前端兜底、静态特判去“看起来正常”。
- **规则优先于提示词**：先修正引擎与流程规则，再做 AI prompt 倾向调优。
- **单点开关语义一致**：`aiStorytellerEnabled` 是自动导演总开关，任何自动推进都不得绕过该语义。
- **可解释与可追踪**：关键动作必须可审计（裁决结果、来源、理由可追溯）。

---

## 2. 技术架构（高层）

- 前端：`React + Vite`（`client/`）
- 后端：`Node.js + Express + ws`（`server/`）
- 核心状态：内存房间模型 `Room`（无持久化）
- 核心引擎：`server/src/game/gameEngine.ts`
- 流程编排与网络入口：`server/src/index.ts`
- AI 能力：
  - 说书人：`server/src/ai/storyteller.ts`
  - 玩家代理：`server/src/ai/playerAgent.ts`
  - 调用日志：`server/src/ai/invocationLog.ts`

---

## 3. 已完成能力（保留）

### 3.1 对局主链路

- 大厅/建房/加入/准备/开始
- 首夜 -> 白天 -> 夜晚循环 -> 终局
- 提名/投票/白天结算/夜晚结算
- `game_over + replay` 终局复盘下发

### 3.2 当前关键规则（已落地）

- 白天可提名自己；被提名者可投票
- 死亡玩家可参与讨论，但：
  - 不可提名
  - 仅有一次幽灵赞成票（`hasDeadVote`）
- 白天可能多次提名，按最高票决定待处决候选；平票默认无人处决

### 3.3 AI 与流程控制

- AI 玩家白天按 `day_plan` 运行，夜晚仅在轮到自身行动时决策
- 公开发言阶段有完成标记与兜底，避免无发言导致流程卡住
- 夜间行动从“说书人改写目标”调整为“校验优先 + 记录理由”
- 引入统一裁决层（提名/投票/夜间行动）与裁决日志

### 3.4 可观测性与自动化

- AI 调用日志统一记录（请求/响应/状态/耗时）
- 增加自动化测试入口（自动建房、托管、开局、汇总指标）
- 支持裁决日志读取，便于排障和策略迭代

---

## 4. 当前必须遵守的边界（高优先规则）

1. **说书人接管开关是总门禁**
   - 未开启 `aiStorytellerEnabled` 时，系统不应自动导演并跑完整局。
   - 应停在需要说书人操作的节点。

2. **动作链路不能绕过裁决层**
   - 提名/投票/夜间行动都应经过统一裁决入口并记录。

3. **夜间玩家意图优先**
   - 在合法前提下，尽量保留玩家目标，不做黑箱重写。

4. **讨论权与规则权分离**
   - 死亡玩家可讨论，但规则层仍限制其提名权和幽灵票次数。

---

## 5. 与官方规则的差距（仍待补齐）

以下是“已知偏差”，是后续开发主要方向：

- 角色能力覆盖仍不完整（部分角色仅占位或简化）
- 醉酒/中毒时序与失真机制仍是工程化近似，不是完整官方语义
- 夜序细节、说书人裁量细节（尤其白天）仍偏简化
- 复盘日志尚未做持久化（当前主要是内存/实时视图）

---

## 6. 下一步优先级（按投入产出）

### P0（规则与稳定性）

- 补齐 Drunk / Poison 的完整语义与时序边界
- 继续补全关键角色能力与夜序步骤
- 维持“不开 AI 说书人不自动推进”的回归测试

### P1（AI 说书人质量）

- 将 `storyteller_ai` 在白天提名/投票阶段做成独立、可解释、可配置策略
- 继续强化裁决理由可读性，便于复盘与调参

### P1（AI 玩家质量）

- 继续迭代 `playerMemory` 摘要质量（减少噪音、提升行动一致性）
- 通过自动化对局比较不同 prompt 风格效果，而非用规则硬约束玩法

### P2（工程化）

- 复盘与行为日志落盘（`jsonl`）
- 可选持久化（Redis/DB）
- 前端补充票型与调试可视化面板

---

## 7. 关键接口与入口文件（最小清单）

### 核心文件

- `server/src/index.ts`：流程导演、WS 入口、AI 托管调度、自动化测试入口
- `server/src/game/gameEngine.ts`：规则判定与状态变更
- `server/src/ai/storyteller.ts`：说书人裁决与模型调用
- `server/src/ai/playerAgent.ts`：AI 玩家日夜策略与记忆摘要
- `server/src/script/troubleBrewing.ts`：剧本角色与配板基线
- `client/src/Game.tsx`：主要对局 UI 与交互

### 关键 API / 消息（只列常用）

- HTTP:
  - `POST /api/rooms`
  - `POST /api/rooms/:roomId/join`
  - `GET /api/rooms/:roomId`
  - `GET /api/storyteller-ai`
  - `POST /api/dev/autotest/run`
  - `GET /api/dev/adjudication-log`
- WS:
  - 入站：`start` `ready` `nominate` `skip_nomination` `vote` `night_action` `day_action` `toggle_ai_storyteller`
  - 出站：`room` `phase` `night_prompt` `night_info` `vote_result` `game_over` `error`

---

## 8. 本地运行（简版）

```bash
# root
npm install

# server
cd server && npm install && npm run dev

# client
cd ../client && npm install && npm run dev
```

### 8.1 标准后端启动配置（默认使用，避免反复踩坑）

下次启动后端请默认使用以下配置（已验证可用）：

```bash
cd server
export OPENAI_API_KEY="你的key"
export DASHSCOPE_API_KEY="你的key"
export USE_AI_STORYTELLER=true
export OPENAI_BASE_URL="https://coding.dashscope.aliyuncs.com"
export OPENAI_MODEL="qwen3.6-plus"
npm run dev
```

启动后务必检查：

- `GET /api/dev/llm/health` 中 `useAiStoryteller=true`
- `baseUrl=https://coding.dashscope.aliyuncs.com`
- `model=qwen3.6-plus`

说明：

- `OPENAI_BASE_URL` 必须使用 `coding.dashscope.aliyuncs.com`（当前 key 在此网关稳定可用）。
- 同时设置 `OPENAI_API_KEY` 与 `DASHSCOPE_API_KEY`，可避免不同调用路径读取变量不一致。

可选 AI 说书人环境变量（server）：

- `USE_AI_STORYTELLER=true`
- `OPENAI_API_KEY=...`
- `OPENAI_BASE_URL=...`
- `OPENAI_MODEL=...`

---

## 9. 给下一次开发者/大模型的指令建议

当你基于本项目继续开发时，请优先遵循以下顺序：

1. 先确认“是否开启 AI 说书人”边界是否被破坏。
2. 再确认提名/投票/夜间行动是否仍走统一裁决入口。
3. 然后做规则修复（引擎）再做 prompt 调优（AI 行为）。
4. 每次改动后至少验证：
   - 未接管说书人时不会自动跑完整局；
   - 死亡玩家可讨论、不可提名、幽灵票单次；
   - 自动化对局指标可正常产出。

如果要扩展新玩法，请尽量通过“可配置策略 + 可观测日志”实现，避免把策略硬编码成不可解释分支。
# 血染钟楼（Blood on the Clocktower）线上版开发说明

本文档用于团队协作：描述**当前已实现功能**、**整体设计**、**规则引擎现状**、**消息协议**与**后续 TODO**，便于你提交代码后其他同学持续开发。

> 当前实现以「暗流涌动（Trouble Brewing）」为主，且为**可跑通流程的简化版**：优先把房间/阶段/夜晚轮询/提名投票/胜负跑通，再逐步补齐角色细节与 AI 说书人。

---

## 0. 版本与变更记录

| 版本 | 说明 |
|------|------|
| **1.0.0** | 基线：大厅/房间、首夜与循环夜、白天提名投票处决、胜负判定；身份仅本人可见；**无**对局结束全量复盘 UI。 |
| **1.0.1** | 服务端维护 `Room.replayLog`，在 `game_over` 消息中附带 `replay`（全员真实身份 + 按 `groupKey`/`groupTitle` 可分组的时间线）；前端在 `status === ended` 时展示复盘面板；修复处决后写复盘时使用「当前天」标题（避免 `phase === waiting` 时错标为夜）。 |
| **1.0.2** | WebSocket `room` / `game_over` 对每位玩家附带 `yourRole`：`characterId`、`characterName`（英）、`characterNameZh`、`ability`（与剧本一致，当前为中文简述）；复盘 `replay.identities` 增加 `characterName`、`ability` 列供终局表展示。 |
| **1.0.3** | 复盘/分组标题修正「第几夜」：`phase==='night'` 时用 `dayNumber+1` 作为夜次（首夜后第一次恶魔刀人所在夜为「第 2 夜」）；首夜块内补充说明「仅信息、首夜无刀」；顶栏阶段文案与之一致。 |
| **1.0.4** | 白天提名允许**提名自己**；处决投票中**被提名者可投票**（含赞成/反对自己）；引擎侧提名要求被提名者须存活。 |
| **1.0.5** | P0 起步：酒鬼严格伪装（客户端看到伪装镇民）；白天主动技能新增 `day_action`（以“杀手开枪”为例：**所有玩家都可宣称发动**，只有真实拥有且未中毒/醉酒且未用过才会生效）；士兵免疫恶魔夜杀（中毒/醉酒则失效）；夜晚行动面板展示能力文案。 |
| **1.0.6** | 处女（Virgin）落地：白天提名真实处女且未中毒/醉酒、且提名者真实为镇民时，提名者立即被处决并写入复盘；可能即时触发胜负并下发 `game_over`。 |
| **1.0.7** | 洗衣妇/图书管理员/调查员信息失真统一为 `distortWasherLibrarianInvestigatorDecision`（中毒/醉酒：约 50% 换人设、50% 换两人组合）；守鸦人：普通夜 `imp` 后增加 `ravenkeeper` 步，死亡守鸦人依 `nightKillAttackerByVictim` 获知行凶者（中毒/醉酒可假信息）；`advanceNight` 防止跳过守鸦人步；恶魔杀人时记录受害者→行凶者映射。 |
| **1.0.8** | **P1**：在线 `runNightLoop` 对洗衣妇/图书管理员/调查员调用 `getStorytellerDecision`（`USE_AI_STORYTELLER` + `OPENAI_API_KEY` 时请求 OpenAI，`OPENAI_MODEL` 可选）；校验失败或未配置时回退随机；中毒座位摘要写入 AI 提示；`GET /api/storyteller-ai` 查询是否启用；`validateDecision` 允许恶魔目标为自己（与引擎一致）。 |
| **1.0.9** | 进度控制从“1号玩家”解耦为**房主权限**：创建房间返回 `hostSecret`，WebSocket 连接携带 `hostSecret` 才具备控制权限（如 `start` 等）。对局中新增 `Room.publicLog` 公开事件日志，前端增加“公共大屏”展示公开事件（提名、投票结果、处决、白天宣称技能与结果等）。 |
| **1.0.10** | 增加“管理员专用页面”（大厅可用 `roomId + hostSecret` 直接进入，不占玩家座位，`admin=1` WebSocket 连接）；管理员可控制进度但不可 ready/提名/投票/白天技能/夜间行动。白天主动技能“宣称次数”改为严格限制：如 `slayer_shot` 超过 1 次直接返回 `day_action_limit_reached`，不再记录二次宣称。 |
| **1.0.11** | 白天提名/投票/处决流转细化：白天自动进入提名环节；每名**存活**玩家必须“提名一次”或“声明本轮不提名”后才能结束白天并入夜；投票达到处决条件时仅**标记待处决**（记录最高赞成票），待白天结束统一执行处决或无人处决入夜；死亡玩家仍有 1 次“死人票”（`hasDeadVote`）且整局仅可用一次。 |
| **1.0.12** | 体验与稳定性修复：服务端补齐对局结束 `game_over + replay` 下发兜底（避免“游戏已结束但未收到复盘数据”），并在结束时将所有玩家重置为**未准备**（下一局默认未准备）；前端交互优化：按钮新增按下态/键盘聚焦态、移动端禁用 hover 位移；聊天支持 **Enter 发送**、自动滚动（仅在接近底部时跟随）、发送防连点与“发送中…”反馈；管理员控制台按钮按“连接状态/房主权限/大厅状态”合理禁用并提示。 |
| **1.0.13** | 本轮整合（cursor 分支）：AI 调用可观测性升级（统一 invocation log、前端过滤/导出/夜晚中转链路视图）；白天四阶段编排与兜底推进；夜晚玩家建议+说书人裁定双调用；玩家调用上下文注入全场聊天/票型/存活状态；5 人局配比修正为 `3 镇民 + 1 爪牙 + 1 恶魔` 并切标准 5~15 配比表；图书管理员支持“无外来者”；调查员/图书管理员/洗衣妇随机与失真池按角色类型分流；夜晚流程重构为房间级互斥执行与同角色同夜单次信息下发，修复重入和重复夜间信息。 |

后续迭代请在表中追加行，并在本文相关章节（消息协议、Room 结构）同步更新。

---

## 1. 总体架构

- **前端**：React + Vite（`client/`）
  - 展示大厅/房间/对局
  - 通过 WebSocket 与后端实时同步房间状态，并接收夜晚提示/夜间信息
- **后端**：Node.js + Express + ws（`server/`）
  - Express 提供房间与剧本的 HTTP API
  - WebSocket 负责实时事件：准备、开始、夜晚行动、提名/投票/处决、票型广播等
- **规则引擎**：纯内存状态机（`server/src/game/*`）
  - `Room` 结构保存房间与对局状态
  - 夜晚顺序表驱动夜间轮询
  - 白天提名/投票/处决与胜负判定
- **AI 说书人**：`server/src/ai/*`
  - 适配层 `adapter.ts`、校验与 OpenAI 调用 `storyteller.ts`
  - **在线夜晚**：洗衣妇/图书管理员/调查员步骤在配置 `USE_AI_STORYTELLER` + `OPENAI_API_KEY` 时走 LLM，否则回退随机；确定性规则（失真、投票、杀人结算等）仍在引擎内

---

## 2. 快速启动与调试

### 2.1 安装依赖

在项目根目录执行：

```bash
npm install
cd server && npm install
cd ../client && npm install
```

### 2.2 启动

- 后端（3001）：

```bash
cd server
npm run dev
```

> 说明：由于 `tsx watch` 在某些环境触发 pipe 权限问题，后端 `dev` 已改为 `node --watch --import tsx ...`（见 `server/package.json`）。

- 前端（5173/5174…）：

```bash
cd client
npm run dev
```

若 `5173` 被占用，Vite 会自动切换到 `5174`。

**可选：启用 AI 说书人（OpenAI）**：在启动后端前设置环境变量 `USE_AI_STORYTELLER=true`、`OPENAI_API_KEY=...`，可选 `OPENAI_MODEL=gpt-4o-mini`。可用 `GET http://localhost:3001/api/storyteller-ai` 确认是否已启用。

### 2.3 访问

- 前端：终端输出的 `http://localhost:5173/` 或 `5174`
- 后端：`http://localhost:3001/`

---

## 3. 当前已实现功能（可用）

### 3.1 大厅/房间

- 创建房间
- 加入房间（按加入顺序分配座位号 seatIndex）
- 准备/取消准备
- 房主（seatIndex=0）在所有人准备且人数达标时可开始

### 3.2 身份分发（简化）

- 根据人数粗略计算镇民/外来者/爪牙/恶魔数量，生成角色池并洗牌分配
- 7 人及以上生成恶魔“3 张不在场善良身份”（`demonBluffs`）
- 身份只对本人可见（每个连接收到 `yourCharacterId`），房间公共状态不暴露身份

### 3.3 阶段与流程

- 首夜 → 白天（自动进入提名流转）→ 夜晚 → … 循环
- 白天提名：每名玩家每天最多提名一次；每名玩家每天最多被提名一次；同一时间只有一个提名；**可提名自己**
- 投票与处决（简化但更贴近桌游节奏）：
  - 统计赞成票，达到“存活人数半数（向上取整）”则**标记为待处决候选**（不立刻处决）
  - 本日可能出现多次提名投票：以**最高赞成票**作为当日待处决候选；若最高票平局，则本日默认无人处决（除非后续出现更高票打破）
  - 白天结束（见下条）时才会真正执行处决并入夜；若无处决则直接入夜
  - **被提名者可参与投票（含投给自己）**
- 白天结束条件：每名**存活玩家**必须“提名一次”或“选择本轮不提名”，且当前没有进行中的投票，才会结束白天进入夜晚（并在需要时统一结算处决）
- 胜利判定：
  - 善良：恶魔死亡
  - 邪恶：场上存活 ≤ 2

### 3.4 投票规则（已按需求修复）

- **存活玩家**：每次提名都可以投赞成或反对
- **死亡玩家**：整局只有 1 次“幽灵票”（`hasDeadVote`），投出后立即消耗，后续不能再投

### 3.5 票型公开（已按需求修复）

- 每次结束投票后广播 `vote_result`，包含：
  - `passed` / `votesFor`
  - `votes`: `[{ seatIndex, inFavor }]`
- 前端当前先把票型打印到浏览器控制台（后续可做 UI 面板）

### 3.6 夜晚轮询（“上帝逐个对话/发信息”）

夜晚由夜晚顺序表驱动，对每个步骤：

- **信息型角色**：只向对应玩家发送 `night_info`
- **操作型角色**：只向对应玩家发送 `night_prompt`，该玩家在 UI 里选择目标并 `night_action` 提交

当前已覆盖（按 `Trouble Brewing` 精简夜序）：

- 首夜：
  - 邪恶互认信息（座位号）+ 恶魔 3 bluff（仅邪恶收到 `night_info`）
  - 洗衣妇/图书管理员/调查员：系统生成“二选一含某身份”的信息（暂用随机说书人占位），只发给本人
  - 厨师：相邻邪恶对数，只发给本人
  - 共情者：相邻邪恶人数，只发给本人
  - 占卜师：提示本人选择 2 人，提交后回结果
  - 僧侣：提示本人选择 1 人保护
- 普通夜：
  - 投毒者：提示本人选择 1 人投毒
  - 占卜师：选择 2 人并回结果
  - 僧侣：选择 1 人保护
  - 恶魔：选择 1 人杀害（提交后立即结算死亡，天亮公布）
  - 掘墓人：若当日有处决，夜里只发给本人“被处决者身份”

### 3.7 中毒导致信息/能力失真（已实现一部分）

新增 `room.poisonedSeatIndex`（**简化实现**：投毒在夜里设置，影响当夜后续信息/能力；在下一次进入夜晚时清除）：

- 被投毒者：
  - 厨师/共情者/掘墓人/占卜师：信息随机化（不保证正确）
  - 僧侣：保护失效（简化）
  - 恶魔：杀人不可靠：50% 无人死，否则随机杀一名存活玩家（不含自己）
- 投毒者若被投毒：投毒目标会随机（简化）

> 注意：这不是原版完整“醉酒/中毒”规则，只是为了让协作者可继续扩展。

---

## 4. 重要简化/偏离原版的点（当前已知）

这些属于“未完成/待改进”，提交前建议团队知晓：

- **剧本/角色实现为精简版**：只实现了部分角色的夜序与能力（重点保证流程跑通）
- **醉酒（Drunk）尚未实现**：目前仅存在角色条目，未实现“伪装为镇民且能力无效/信息错误”等机制
- **投毒持续时间简化**：当前在“进入夜晚（黄昏）”时清除；原版更细的“到下一黄昏”需要明确阶段边界
  - 补充说明（现状）：投毒在夜晚行动时写入 `poisonedSeatIndex`，会影响当夜后续信息/能力；在进入下一次夜晚前清除（简化）
- **恶魔/爪牙互认规则简化**：目前按座位号互认，不区分 7 人以下/以上的细节与不在场身份展示细节
- **夜晚顺序表不完整**：`spy` 等步骤目前大多跳过或仅作为占位
- **提名/投票的语音/计票流程简化**：没有“说书人计票顺序/举手规则”细节，仅做结果判定
- **处女、杀手、守鸦人、士兵、市长等角色能力未实现或未接入流程**
- **复盘/日志落盘未做**：目前“复盘”只能看服务端终端输出，未持久化

---

## 5. 消息协议（HTTP + WebSocket）

### 5.1 HTTP API（Express）

- `GET /api/scripts`
  - 返回剧本列表（当前仅暗流涌动）
- `POST /api/rooms`
  - body: `{ scriptId }`
  - 返回 `{ roomId, scriptId, hostSecret }`（**仅创建者持有**；用于房主控制权限）
- `POST /api/rooms/:roomId/join`
  - body: `{ nickname }`
  - 返回 `{ roomId, seatIndex, playerId, room }`
- `GET /api/rooms/:roomId`
  - 返回 `RoomView`
- `GET /api/storyteller-ai`
  - 返回 `{ enabled, useAiFlag, hasApiKey }`（**不返回密钥**）—— `enabled` 为真正会走 LLM 的条件

### 5.2 WebSocket 连接

- URL：`ws://localhost:3001?roomId=...&seatIndex=...&hostSecret=...`（可选；带上则该连接具备房主权限）
- 服务端会对每个连接发送：
  - `type: 'room'` + `room: RoomView` + `yourSeatIndex` + `yourCharacterId`

### 5.3 WebSocket 客户端→服务端

- `ready`: `{ type:'ready', ready:boolean }`
- `start`: `{ type:'start' }`
- `nominate`: `{ type:'nominate', nominatedSeat:number }`
- `skip_nomination`: `{ type:'skip_nomination' }`（存活玩家：声明本轮不提名）
- `vote`: `{ type:'vote', inFavor:boolean }`
- `night_action`: `{ type:'night_action', targets:number[] }`
- `ping`: `{ type:'ping' }`

### 5.4 WebSocket 服务端→客户端

- `room`: `{ type:'room', room:RoomView, yourSeatIndex, yourCharacterId, yourRole?:null|{ characterId, characterName, characterNameZh, ability } }`（**1.0.2+** 发牌后 `yourRole` 为完整名片；大厅为 `null`）
  - **1.0.9+**：额外包含 `isHost:boolean`，表示本连接是否具备房主权限；`RoomView` 额外包含 `publicLog`（公开事件日志）
  - **1.0.11+**：`RoomView` 增加 `nominationsToday` / `skippedNominationsToday` / `pendingExecutionVotesFor` / `pendingExecutionTied`，用于前端提示“本轮提名完成情况”与“当前标记的最高票待处决状态”
- `phase`: `{ type:'phase', phase, dayNumber }`
- `night_prompt`: `{ type:'night_prompt', stepId, actorSeatIndex, pick, aliveSeatIndices }`（只发给行动者）
- `night_info`: `{ type:'night_info', message }`（只发给对应玩家）
- `vote_result`: `{ type:'vote_result', passed, votesFor, votes:[{seatIndex,inFavor}] }`
- `game_over`（**1.0.1+**）: `{ type:'game_over', winner, room, replay?, yourRole?, yourCharacterId?, yourSeatIndex? }` — `replay.identities` **1.0.2+** 含 `characterName`、`ability`；`yourRole` 与同坐 `room` 消息含义一致
- `error`: `{ type:'error', message }`

---

## 6. 关键代码位置（协作者入口）

- 剧本数据：
  - `server/src/script/troubleBrewing.ts`
- 房间状态与管理：
  - `server/src/game/types.ts`
  - `server/src/game/roomManager.ts`
- 规则引擎（核心）：
  - `server/src/game/gameEngine.ts`
- 网络层（HTTP + WS + 夜晚消息分发）：
  - `server/src/index.ts`
- 前端 UI（大厅/对局/夜晚面板/夜间信息）：
  - `client/src/Lobby.tsx`
  - `client/src/Game.tsx`

---

## 7. 后续 TODO（建议按优先级）

### P0（尽快补齐核心体验）

- **酒鬼（Drunk）完整机制**
  - 给酒鬼分配“伪装角色”（镇民）并在夜序中按伪装角色行动/收信息
  - 酒鬼的结果始终无效或错误（按原规则与剧本实现细化）
- **投毒/醉酒对更多信息与能力的影响**
  - 洗衣妇/调查员/图书管理员信息可能为假
  - 僧侣保护失败/恶魔杀人偏离等按原规则调整
- **夜序表补全 + 更多角色能力落地**
  - 处女、杀手、守鸦人、士兵、市长等

### P1（AI 说书人真正接入）

- **已接入（1.0.8）**：`runNightLoop` 中洗衣妇 / 图书管理员 / 调查员步骤调用 `getStorytellerDecision()`；`validateDecision` 校验座位与善良 `characterId`；失败回退 `randomStorytellerDecision`；中毒/醉酒后的**玩家侧失真**仍由引擎 `distortWasherLibrarianInvestigatorDecision` 处理。
- **环境变量**（服务端）：
  - `USE_AI_STORYTELLER=true`（或 `1`）
  - `OPENAI_API_KEY`：OpenAI API Key
  - `OPENAI_BASE_URL`：默认 `https://dashscope.aliyuncs.com/compatible-mode`（与 OpenAI 习惯一致：**不要**在末尾再手写 `/v1`，代码会拼 `/v1/chat/completions`；国际区可换 `https://dashscope-intl.aliyuncs.com/compatible-mode` 等，见阿里云百炼文档）
  - `OPENAI_MODEL`：可选，默认 `gpt-4o-mini`
- **仍待扩展**：更多裁量点（如间谍观板、男爵配板等）、可插拔供应商（Azure/本地模型）、异步超时与前端「说书人思考中」状态。

### P0/P1（AI 玩家托管：可用性重构）

当前 AI 玩家托管改为**按阶段编排 + 调用预算**（避免“全员 noop 等待”与高频调用）：

- **白天（每座位每白天最多 1 次大模型）**：
  - 每个开启托管的座位生成一次 `day_plan`（私聊 0~2 条 → 公聊 1 条 → 提名倾向 → 投票倾向）
  - 服务端按计划自动发送 DM 与公聊（每座位每天至少 1 条公聊）
  - 提名/投票阶段优先使用计划结果，避免随机行为
- **夜晚（仅在轮到该座位行动时调用大模型）**：
  - 仅当 `pendingNightAction.actorSeatIndex === seatIndex` 才调用大模型，输出 `night_action`
- **阵营/角色驱动**：
  - `yourRole` 增加 `alignment`/`roleType`，提示模型以“己方阵营胜利”为最高目标
  - 邪恶阵营额外注入 `demonBluffs`（本局不在场善良身份）用于伪装编故事

### P2（产品化/协作）

- **复盘与日志落盘**：把每晚/每昼事件记录到 `server/logs/*.jsonl`（可回放）
- **状态持久化**：Redis/DB（可选）
- **更友好的 UI**
  - 票型面板（UI 显示每个座位的投票）
  - 夜晚行动引导文案（显示角色中文名与简要能力）

---

## 8. 本次整合提交清单（相对上次提交）

为避免“修修补补式扩张”，本轮已做结构收口，主要集中在以下模块：

- **夜晚流程收口（稳定性重构）**
  - 新增房间级夜晚互斥执行入口，统一替代散落的 `runNightLoop` 调用点，避免并发重入。
  - 夜间信息分发增加“同角色同夜仅一次”约束，防止同一角色收到互相冲突的重复信息。

- **AI 上下文与行为一致性**
  - 玩家每轮大模型调用统一注入：全场聊天（public/dm/god）、当前提名与票型、当日提名记录、存活/死亡列表、近期投票事件摘要。
  - 白天投票改为“优先处决名单（priorityExecuteSeats）”驱动，避免“全员激进同意”导致票型失真。

- **说书人信息正确性**
  - 图书管理员支持“本局无外来者”结果分支。
  - 洗衣妇/图书管理员/调查员在随机兜底和失真逻辑中按角色类型分池（townsfolk / outsider / minion）。
  - 说书人模型上下文升级为全知视图（全角色/阵营、全场聊天、票型与提名状态）。

- **规则与剧本基线修正**
  - 角色描述与 Trouble Brewing 官方语义对齐（重点角色能力文案修订）。
  - 5 人局固定配比修正为 `3 镇民 + 1 爪牙 + 1 恶魔`，并补全 5~15 人标准配比表。

- **可观测性与复盘能力**
  - 引入统一 AI 调用记录模块（请求/响应/行为/耗时/状态）。
  - 前端支持 AI 调用过滤、关键词检索、夜晚中转链路视图与结构化 JSON 导出。

---

## 9. 贡献建议（给协作者）

- 每新增一个角色，建议在 `gameEngine.ts` 做：
  - 能力的“输入/输出”定义（是否需要 `night_prompt`）
  - 信息计算函数（支持被投毒/醉酒时的失真）
  - 在 `server/src/index.ts` 的 `runNightLoop()` 中把该角色的夜晚步骤接上（发 `night_info` 或触发 `pendingNightAction`）
- 任何“只对本人可见”的信息都必须通过 `sendToSeat()` 发送，避免泄露。

---

## 10. 本轮补充（终局复盘与可观测性增强）

本轮在不改变既有白天/夜晚主流程的前提下，补齐终局复盘能力与统计可读性：

- **终局复盘问答扩展**
  - 现有“终局问上帝”保留；
  - 新增“终局问玩家”：可选择任意座位提问“为什么这么做”，由该玩家视角结合真实对局记录进行复盘回答；
  - 仅在 `room.status === ended` 时启用，属于只读复盘，不改变房间状态。

- **AI 调用统计（终局）**
  - 在 AI 调用详情面板增加终局统计块；
  - 统计维度：总调用数、成功数、失败数、失败原因分布（按次数降序）；
  - 统计口径按调用 `id` 去重并取最终状态，避免一次调用多条状态更新导致重复计数。

- **可维护性说明**
  - 终局统计目前在前端基于 trace 记录实时聚合；
  - 若后续需要全房间/跨会话统计，建议将聚合下沉到服务端并提供独立查询接口。

---

## 11. 本轮迭代补充（说书人边界与自动化）

本节用于承接最近一轮“说书人职责对齐 + AI 托管边界收口”的改动，便于后续继续迭代。

### 11.1 目标与原则

- 统一 AI 玩法链路为：`玩家意图 -> 说书人裁决 -> 引擎落地`。
- 说书人未开启 AI 接管时，系统不应自动导演并快进完整对局。
- 玩法策略倾向优先通过提示词与记忆摘要调优，而不是通过硬编码约束玩法多样性。

### 11.2 已完成改动

- **夜间行动“校验器化”**
  - 夜间提交流程改为“校验 + 记录理由”为主，避免说书人层无条件改写玩家目标。
  - 目标是在合法前提下尽量保留玩家原始意图。

- **裁决层统一入口（Adjudication Layer）**
  - 提名、投票、夜间行动统一走裁决入口并记录来源与结果。
  - 新增裁决日志读取接口，支持排障与自动化评估。

- **AI 玩家记忆摘要优先**
  - 从“原始聊天直接喂给模型”改为“摘要优先 + 少量原始尾部校验”，降低噪音与上下文长度。

- **白天公开发言与阶段兜底修复**
  - 增加公开发言完成标记与超时兜底，降低“无人发言/发言丢失”导致的流程异常。
  - 死亡玩家可参与讨论；提名与幽灵票限制继续由规则层约束。

- **自动化对局与指标汇总**
  - 增加后端一键自测入口，支持自动建房/托管/开局/汇总对局结果。
  - 扩展聚合指标，支持多提示词风格横向比较。

- **关键边界修复：未开启 AI 说书人时禁止自动推进**
  - 在流程导演与白天托管入口均增加硬门禁：仅 `aiStorytellerEnabled=true` 才允许自动推进。
  - 语义收敛为：未接管说书人时，流程应卡在需要说书人操作的节点。

### 11.3 本轮验证建议

- 场景 A：不开 AI 说书人，只开 AI 玩家
  - 预期：流程不会自动跑完整局，会停在需说书人推进节点。
- 场景 B：同时开启 AI 说书人 + AI 玩家
  - 预期：可自动推进，且公开发言、提名投票、夜晚结算有可追踪日志。
- 场景 C：死亡玩家在白天
  - 预期：可讨论；不可提名；仅可使用一次幽灵赞成票。

### 11.4 下一步建议（未完成）

- 将 `storyteller_ai` 在白天提名/投票阶段补齐为“可解释、可配置”的独立裁量策略（当前仍以规则引擎镜像为主）。
- 基于自动化对局结果继续扩展指标（发言覆盖率、有效提名率、关键角色存活关联等）。

---

## 12. 最近改动归档（2026-04-27）

### 12.1 规则与引擎（根因修复）

- 修复 Trouble Brewing 配板根因：`5` 人局由错误的 `4-0-0-1` 改为官方 `3-0-1-1`。
- `assignRoles` 改为 `5~15` 人固定配比表，不再使用简化公式推导，避免类似偏差重复出现。

### 12.2 AI 调用可见性与权限边界

- 调整 `ai_trace` 分发策略为严格隔离：
  - 玩家仅可见自己座位的 AI 调用；
  - 管理员（上帝）仅可见说书人调用（`seatIndex=null`）；
  - 禁止“房主看全员调用”越权路径。
- 管理员页新增“AI 调用记录（上帝）”并做可视化增强（状态标签、时间、阶段、错误高亮）。

### 12.3 模型调用链路与性能参数

- 统一说书人与玩家调用为非流式：`stream=false`。
- 对支持参数的模型关闭思考过程：`enable_thinking=false`。
- 按最新决策，已移除本轮临时加入的 `max_tokens` 限制（说书人 + 玩家全部撤回）。

### 12.4 运行配置基线（必须对齐）

- 统一后端默认启动配置为：
  - `USE_AI_STORYTELLER=true`
  - `OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com`
  - `OPENAI_MODEL=qwen3.6-plus`
  - 同时设置 `OPENAI_API_KEY` 与 `DASHSCOPE_API_KEY`
- 启动后通过 `GET /api/dev/llm/health` 校验：
  - `useAiStoryteller=true`
  - `baseUrl` / `model` 与启动参数一致

### 12.5 本轮经验结论（避免重复踩坑）

- 若出现“上帝无 AI 调用”，先检查运行进程环境而不是先改代码：
  - `USE_AI_STORYTELLER` 是否为 `true`
  - `OPENAI_BASE_URL` 是否退回默认
  - `/api/dev/llm/health` 是否与预期一致

