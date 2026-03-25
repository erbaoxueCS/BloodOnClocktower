# 血染钟楼（Blood on the Clocktower）线上版开发说明

本文档用于团队协作：描述**当前已实现功能**、**整体设计**、**规则引擎现状**、**消息协议**与**后续 TODO**，便于你提交代码后其他同学持续开发。

> 当前实现以「暗流涌动（Trouble Brewing）」为主，且为**可跑通流程的简化版**：优先把房间/阶段/夜晚轮询/提名投票/胜负跑通，再逐步补齐角色细节与 AI 说书人。

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
- **AI 说书人（预留/脚手架）**：`server/src/ai/*`
  - 已有适配层/决策 schema/校验逻辑骨架
  - **当前在线流程仍主要使用“随机说书人”占位**（洗衣妇/图书管理员/调查员等），AI 模块尚未接入在线夜晚流程
  - 计划改动：将随机占位替换为 AI 决策输出（需严格 schema 校验 + 回退策略）

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

- 首夜 → 白天（讨论→提名）→ 夜晚 → … 循环
- 白天提名：每名玩家每天最多提名一次；每名玩家每天最多被提名一次；同一时间只有一个提名
- 投票与处决：统计赞成票，达到“存活人数半数（向上取整）”则进入待处决
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
- **投毒持续时间简化**：当前在 `execute()` 进入夜晚时清除；原版更细的“到下一黄昏”需要明确阶段边界
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
  - 返回 `{ roomId, scriptId }`
- `POST /api/rooms/:roomId/join`
  - body: `{ nickname }`
  - 返回 `{ roomId, seatIndex, playerId, room }`
- `GET /api/rooms/:roomId`
  - 返回 `RoomView`

### 5.2 WebSocket 连接

- URL：`ws://localhost:3001?roomId=...&seatIndex=...`
- 服务端会对每个连接发送：
  - `type: 'room'` + `room: RoomView` + `yourSeatIndex` + `yourCharacterId`

### 5.3 WebSocket 客户端→服务端

- `ready`: `{ type:'ready', ready:boolean }`
- `start`: `{ type:'start' }`
- `next_phase`: `{ type:'next_phase' }`（讨论 → 提名）
- `nominate`: `{ type:'nominate', nominatedSeat:number }`
- `vote`: `{ type:'vote', inFavor:boolean }`
- `end_voting`: `{ type:'end_voting' }`
- `execute`: `{ type:'execute' }`
- `night_action`: `{ type:'night_action', targets:number[] }`
- `ping`: `{ type:'ping' }`

### 5.4 WebSocket 服务端→客户端

- `room`: `{ type:'room', room:RoomView, yourSeatIndex, yourCharacterId }`
- `phase`: `{ type:'phase', phase, dayNumber }`
- `night_prompt`: `{ type:'night_prompt', stepId, actorSeatIndex, pick, aliveSeatIndices }`（只发给行动者）
- `night_info`: `{ type:'night_info', message }`（只发给对应玩家）
- `vote_result`: `{ type:'vote_result', passed, votesFor, votes:[{seatIndex,inFavor}] }`
- `game_over`: `{ type:'game_over', winner:'good'|'evil', room:RoomView }`
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

- 将“随机说书人决策”替换为 `server/src/ai/storyteller.ts` 的结构化决策
- 为每个需要裁量的角色定义严格 schema（并做合法性校验与回退）
- AI 输出只影响“说书人裁量点”，确定性规则仍由引擎实现

### P2（产品化/协作）

- **复盘与日志落盘**：把每晚/每昼事件记录到 `server/logs/*.jsonl`（可回放）
- **状态持久化**：Redis/DB（可选）
- **更友好的 UI**
  - 票型面板（UI 显示每个座位的投票）
  - 夜晚行动引导文案（显示角色中文名与简要能力）

---

## 8. 贡献建议（给协作者）

- 每新增一个角色，建议在 `gameEngine.ts` 做：
  - 能力的“输入/输出”定义（是否需要 `night_prompt`）
  - 信息计算函数（支持被投毒/醉酒时的失真）
  - 在 `server/src/index.ts` 的 `runNightLoop()` 中把该角色的夜晚步骤接上（发 `night_info` 或触发 `pendingNightAction`）
- 任何“只对本人可见”的信息都必须通过 `sendToSeat()` 发送，避免泄露。

