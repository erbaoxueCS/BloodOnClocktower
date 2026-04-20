# 变更记录

## 2026-04-20 - AI 深度思考 + 纯 AI 自对局引擎

### 新增文件
- `server/src/ai/persona.ts` - AI 玩家人设生成器（性格、策略、谎言倾向）
- `server/src/ai/aiMemory.ts` - AI 玩家记忆系统（短期/长期记忆、怀疑度、心路历程持久化）
- `server/src/runner/simulation.ts` - Headless 纯 AI 自对局引擎
- `server/src/runner/report.ts` - 对局分析报告生成器
- `server/src/runner/aiPlayerWrapper.ts` - 无头模式下 AI 玩家自动操作包装器

### 修改文件
| 文件 | 改动说明 |
|------|----------|
| `server/src/game/types.ts` | 新增 `AiPlayerPersona`、`AiPlayerMemory`、`AiThoughtEntry` 类型；Room 新增 `aiPersonaBySeat`/`aiMemoryBySeat`/`aiThoughtLog` 字段 |
| `server/src/game/roomManager.ts` | 初始化新字段；`resetRoomForNextGame` 清理新字段；`getRoomView` 返回 `aiThoughtLog`（仅管理员） |
| `server/src/ai/types.ts` | 完整重写，新增 `PoisonerChoice`/`FortuneTellerChoice`/`MonkChoice`/`DemonBluffChoice` 类型 |
| `server/src/ai/playerAgent.ts` | **重构**：引入人设驱动、记忆集成、深度思考链持久化、邪恶角色撒谎策略 |
| `server/src/ai/storyteller.ts` | 扩展：新增恶魔刀人、投毒、占卜师、僧侣裁量点；不干预固定能力事实 |
| `server/src/ai/adapter.ts` | 扩展：新增历史决策、聊天摘要、局势评估上下文 |
| `server/src/index.ts` | 新增 `/api/simulation/run` 和 `/api/rooms/:roomId/ai-thoughts` API |

### 核心功能

#### 1. AI 玩家人设系统
```typescript
interface AiPlayerPersona {
  role: 'good' | 'evil';
  personality: {
    aggression: number;   // 攻击性
    bluffing: number;     // 撒谎倾向（邪恶越高）
    trust: number;        // 信任度
    social: number;       // 发言活跃度
    riskTaking: number;   // 冒险倾向
  };
  strategy: 'logical' | 'emotional' | 'chaos';
  evilStrategy?: {
    bluffTarget: string;  // 伪装角色
    protectWho: number;   // 保护的队友
    sacrificeWillingness: number;
  };
}
```

#### 2. AI 心路历程持久化
每次决策的完整推理过程存储到 `room.aiThoughtLog`，包含：
- 触发事件
- 上下文快照（公开信息、私有信息、怀疑度）
- 完整推理过程
- 最终决策
- 情绪标签

#### 3. 纯 AI 自对局引擎
```bash
# 运行 5 局 7 人 AI 自对局
curl -X POST http://localhost:3001/api/simulation/run \
  -H "Content-Type: application/json" \
  -d '{"playerCount":7, "iterations":5, "maxDays":10}'
```

#### 4. 说书人 AI 扩展
现在支持更多裁量点：
- ✅ 洗衣妇/图书管理员/调查员信息生成
- ✅ 恶魔刀人目标（未中毒则 100% 成功）
- ✅ 投毒者目标选择
- ✅ 占卜师结果判定
- ✅ 僧侣保护目标

### 回退方法
```bash
cd BloodOnClocktower
git checkout -- server/src/ai/persona.ts
git checkout -- server/src/ai/aiMemory.ts
git checkout -- server/src/runner/
git checkout -- server/src/ai/playerAgent.ts
git checkout -- server/src/ai/storyteller.ts
git checkout -- server/src/ai/adapter.ts
git checkout -- server/src/ai/types.ts
git checkout -- server/src/game/types.ts
git checkout -- server/src/game/roomManager.ts
git checkout -- server/src/index.ts
```
