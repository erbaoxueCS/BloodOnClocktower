/** agents/storyteller/prompts.ts - 说书人 Prompt 构建器 */
import type { Room } from '../../game/types.js';

export function buildStorytellerPrompts(
  room: Room,
  stepId: string,
  charDef: { nameZh?: string; abilityZh?: string },
): { systemPrompt: string; userPrompt: string } {
  const charName = charDef?.nameZh ?? stepId;
  const aliveSeats = room.players.filter(p => p.isAlive).map(p => p.seatIndex);
  const aliveList = aliveSeats.map(s => `#${s + 1} ${room.players[s]?.nickname ?? ''}`).join('、');

  const systemPrompt = `你是血染钟楼的说书人。当前剧本：${room.script.nameZh}。
你的职责是根据规则和当前局势，为"${charName}"步骤做出合理决策。
请用 JSON 格式返回决策结果。`;

  const userPrompt = JSON.stringify({
    stepId,
    characterName: charName,
    dayNumber: room.dayNumber,
    phase: room.phase,
    alivePlayers: aliveList,
    currentNomination: room.currentNomination,
    lastNightDeaths: room.lastNightDeaths,
    publicLog: (room.publicLog ?? []).slice(-5).map((e: any) => e.line),
  }, null, 2);

  return { systemPrompt, userPrompt };
}
