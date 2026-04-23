# Blood on the Clocktower（暗流涌动）

这是一个基于 React + Node.js 的《血染钟楼》在线对局原型，当前聚焦 Trouble Brewing（暗流涌动）并已接入 AI 玩家与 AI 说书人协作流程。

## 当前能力

- 完整大厅/房间/准备/开局流程（含管理员模式）
- 白天四阶段编排：`god_dialogue` → `private_dialogue` → `public_speech` → `nomination_vote`
- 夜晚双调用链：玩家先给行动建议，AI 说书人裁定最终目标
- AI 调用全链路日志（请求/响应/行为/状态），前端可筛选与导出 JSON
- 终局复盘问答：支持“问上帝”与“问任意玩家”（用于解释策略动机）
- 终局 AI 调用统计：总调用/成功/失败次数 + 失败原因聚合
- 5 人局配比修正为：`3 镇民 + 1 爪牙 + 1 恶魔`（并补齐 5~15 人标准配比）
- 首夜信息角色（洗衣妇/图书管理员/调查员）支持说书人 AI 裁量与兜底
- 关键稳定性措施：夜晚互斥执行、同角色同夜信息单发、全阶段超时兜底防卡死

## 技术栈

- 后端：Node.js + Express + ws + TypeScript
- 前端：React + Vite + TypeScript
- 模型调用：OpenAI 兼容接口（可配置 DashScope）

## 本地启动

```bash
# 根目录安装
npm install
cd server && npm install && cd ..
cd client && npm install && cd ..

# 同时启动前后端
npm run dev
```

- 后端默认：`http://localhost:3001`
- 前端默认：`http://localhost:5173`（被占用时自动切 5174）

## AI 相关环境变量（后端）

```bash
USE_AI_STORYTELLER=true
USE_AI_PLAYER=true
OPENAI_API_KEY=your_key
# 可选
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode
OPENAI_MODEL=qwen3.5-plus
```

可用健康检查接口：

- `GET /api/dev/llm/health`

## 快速测试

```bash
POST /api/dev/quickstart
body: { "playerCount": 5 }
```

返回值包含：

- `joinUrls`：玩家自动入座链接（可带 autoAi）
- `adminUrl`：管理员控制台链接

## 项目结构

- `server/src/game/*`：规则引擎、房间与流程状态机
- `server/src/ai/*`：AI 玩家/说书人调用与日志模块
- `server/src/night/runNightLoop.ts`：夜晚主循环
- `server/src/index.ts`：HTTP + WS 入口与流程调度
- `client/src/Game.tsx`：对局 UI 与 AI 调用日志面板

## 文档

- 详细开发说明与版本演进见 `DEV_PLAN.md`
- AI 流程设计见 `docs/DESIGN_AI_FLOW_AND_AGENTS.md`
