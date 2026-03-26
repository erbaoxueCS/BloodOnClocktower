import type { Room } from '../game/types.js';
import type { StorytellerRequest } from './types.js';

/**
 * 从游戏状态生成供 AI 使用的请求摘要（不暴露真实身份）
 */
export function buildStorytellerRequest(room: Room, stepId: string, stepNameZh: string): StorytellerRequest {
  const aliveSeatIndices = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
  const deadSeatIndices = room.players.filter((p) => !p.isAlive).map((p) => p.seatIndex);
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
  };
}
