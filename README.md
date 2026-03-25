# 血染钟楼 · 常规功能 + AI 说书人

基于血染钟楼规则的在线对战实现：常规游戏流程 + 可选 AI 说书人决策。

## 技术栈

- **后端**：Node.js + Express + WebSocket (ws)，TypeScript
- **前端**：React + Vite，TypeScript
- **剧本**：暗流涌动（Trouble Brewing）精简版

## 快速开始

```bash
# 安装依赖
npm install
cd server && npm install && cd ..
cd client && npm install && cd ..

# 开发：同时启动后端与前端
npm run dev

# 后端：http://localhost:3001
# 前端：http://localhost:5173
```

1. 打开前端，点击「创建房间」，复制房间号。
2. 另开标签页或设备，输入房间号与昵称「加入房间」。
3. 所有人准备后，房主点击「开始游戏」。
4. 白天：房主可「进入提名阶段」；存活玩家可提名他人并投票；房主「结束投票」后若通过则出现「执行处决」，房主点击后进入下一夜。

## 项目结构

- `server/`：游戏服务、规则引擎、剧本数据、WebSocket 与 HTTP 接口
- `client/`：大厅、房间、对局 UI（玩家列表、提名、投票、处决）
- 说书人决策：首版为随机占位，Phase 2 接入 AI 模块

## 后续

- Phase 2：AI 说书人（状态适配、决策接口、洗衣妇/调查员等）
- Phase 3：更多角色、醉酒/中毒、旅行者、复盘
