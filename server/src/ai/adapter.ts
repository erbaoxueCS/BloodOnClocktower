// [MODIFIED] AI 说书人适配器 - 扩展支持更多上下文
import type { Room } from '../game/types.js';
import type { StorytellerRequest } from './types.js';

/**
 * 从游戏状态生成供 AI 使用的请求摘要（不暴露真实身份）
 * [MODIFIED] 新增：历史决策、聊天摘要、局势评估
 */
export function buildStorytellerRequest(room: Room, stepId: string, stepNameZh: string): StorytellerRequest {
  const aliveSeatIndices = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
  const deadSeatIndices = room.players.filter((p) => !p.isAlive).map((p) => p.seatIndex);

  // [NEW] 构建历史决策摘要
  const pastDecisions: Record<string, unknown> = {};
  for (const [key, value] of room.storytellerDecisions) {
    if (key.includes('_result') || key === 'imp_kill' || key === 'poisoner_target') {
      pastDecisions[key] = value;
    }
  }

  // [NEW] 构建聊天摘要（最近 10 条公开聊天）
  const recentPublicChat = room.chatLog
    .filter(c => c.scope === 'public')
    .slice(-10)
    .map(c => `#${c.fromSeat + 1}: ${c.text}`)
    .join('\n');

  // [NEW] 简单局势评估
  const aliveGood = room.players.filter(p => {
    if (!p.isAlive) return false;
    const char = room.script.characters.find(c => c.id === p.characterId);
    return char?.alignment === 'good';
  }).length;
  const aliveEvil = room.players.filter(p => {
    if (!p.isAlive) return false;
    const char = room.script.characters.find(c => c.id === p.characterId);
    return char?.alignment === 'evil';
  }).length;
  const gameBalance = aliveGood > aliveEvil + 2 ? 'good_advantage' :
                      aliveEvil >= aliveGood ? 'evil_advantage' : 'even';

  return {
    scriptName: room.script.name,
    scriptNameZh: room.script.nameZh,
    phase: room.phase === 'first_night' ? 'first_night' : 'night',
    dayNumber: room.dayNumber,
    stepId,
    stepNameZh,
    aliveSeatIndices,
    deadSeatIndices,
    playerCount: room.players.length,
    poisonedSeatIndex: room.poisonedSeatIndex ?? null,
    // [NEW] 额外上下文
    pastDecisions,
    chatSummary: recentPublicChat || '（暂无公开聊天）',
    gameBalance,
  };
}
