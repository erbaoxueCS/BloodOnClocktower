// ============================================================
// 说书人 Prompt 模板
// ============================================================

import type { GameState } from '../../engine/types.js';
import type { CharacterDef } from '../../engine/types.js';
import { getEffectiveCharacterId } from '../../engine/gameEngine.js';

export function buildStorytellerPrompts(
  game: GameState,
  stepId: string,
  characterDef: CharacterDef,
): { systemPrompt: string; userPrompt: string } {
  const alive = game.players.filter(p => p.isAlive);
  const dead = game.players.filter(p => !p.isAlive);
  const characters = game.script.characters;

  const aliveList = alive.map(p => {
    const shown = getEffectiveCharacterId(p);
    const shownDef = shown ? characters.find(c => c.id === shown) : undefined;
    return `  #${p.seatIndex + 1} ${p.nickname} [${shownDef?.type ?? '?'}${shownDef?.alignment === 'evil' ? '/邪恶' : ''}]`;
  }).join('\n');

  const deadList = dead.length > 0
    ? dead.map(p => `  #${p.seatIndex + 1} ${p.nickname} (已死亡)`).join('\n')
    : '  无';

  const phaseLabel = game.phase === 'first_night' ? '首夜' : `第 ${game.dayNumber} 夜`;
  const stepLabel = characterDef.nameZh;

  const systemPrompt = `你是血染钟楼 (Blood on the Clocktower) 的说书人。
你的职责是根据当前游戏状态，为信息角色提供合理、有趣且平衡的信息。

重要原则：
1. 你是公正的裁判，信息应该对善良和邪恶阵营都有平衡的机会
2. 对于洗衣妇/图书管理员/调查员：选择玩家时，优先选择能创造有趣讨论和推理的指向
3. 不要总是把信息指向同一个玩家，分散信息让更多玩家参与
4. 如果邪恶阵营处于劣势，可以稍微让信息不那么精确；反之亦然
5. 你只输出合法的 JSON，不要额外解释`;

  const userPrompt = `当前阶段：${phaseLabel}
当前步骤：${stepLabel}（${characterDef.name}）

游戏状态：
- 存活玩家 (${alive.length}/${game.players.length})：
${aliveList}
- 已死亡玩家：
${deadList}

${stepId === 'washerwoman' ? `
你是洗衣妇。你需要选择两名存活玩家，并选择一个镇民身份，告诉洗衣妇"这两名玩家中有一位是此镇民"。
请输出 JSON：
{
  "players": [玩家编号-1, 玩家编号-1],  // 两个不同的存活玩家
  "characterId": "角色id"  // 一个镇民角色的 id（如 washerwoman, chef, empath 等）
}
注意：应该选择能创造有趣讨论的两人组合。考虑游戏平衡。` : ''}

${stepId === 'librarian' ? `
你是图书管理员。你需要选择两名存活玩家，并选择一个外来者身份（或标记"没有外来者"）。
请输出 JSON：
{
  "players": [玩家编号-1, 玩家编号-1],
  "characterId": "角色id",  // 外来者角色 id（如 drunk, recluse, saint, butler）
  "noOutsider": false  // 如果本局确实没有外来者，设为 true
}
注意：如果有外来者，优先指向真实的外来者玩家。如果没有，用 noOutsider: true。` : ''}

${stepId === 'investigator' ? `
你是调查员。你需要选择两名存活玩家，并选择一个爪牙身份，告诉调查员"这两名玩家中有一位是此爪牙"。
请输出 JSON：
{
  "players": [玩家编号-1, 玩家编号-1],
  "characterId": "角色id"  // 一个爪牙角色 id（poisoner, spy, baron, scarlet_woman）
}
注意：优先让一名真实爪牙在指认范围内（但不一定必须）。考虑游戏平衡。` : ''}

请仅输出 JSON 对象，不要其他内容。`;

  return { systemPrompt, userPrompt };
}
