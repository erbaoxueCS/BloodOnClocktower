// ============================================================
// 说书人 Prompt 模板（增强版）
// ============================================================

import type { GameState } from '../../engine/types.js';
import type { CharacterDef } from '../../engine/types.js';
import { getEffectiveCharacterId } from '../../engine/gameEngine.js';

const GAME_RULES = `【血染钟楼·暗流涌动 说书人规则备忘录】

=== 你的职责 ===
你是游戏的说书人（Storyteller），负责在信息角色获得信息时做出公正合理的裁量。
你的目标是让游戏有趣、平衡、公平。你提供的"信息"会影响整个游戏的走向。

=== 首夜信息角色裁量指南 ===

1. 洗衣妇 (Washerwoman)：
   - 选择两名存活玩家 + 一个镇民身份，告诉洗衣妇"这两人中有一位是这个镇民"。
   - 建议：至少让一名候选人的真实身份与你给出的镇民身份匹配或接近。
   - 中毒/醉酒时应该给出虚假信息。

2. 图书管理员 (Librarian)：
   - 选择两名存活玩家，告诉图书管理员"这两人中有一位是外来者"，或者"本局没有外来者"。
   - 如果确实有外来者，应该让其中一名真实外来者在范围内。
   - 如果没有外来者，使用 noOutsider: true。

3. 调查员 (Investigator)：
   - 选择两名存活玩家 + 一个爪牙身份，告诉调查员"这两人中有一位是这个爪牙"。
   - 建议：让一名真实爪牙在范围内，让信息有实际价值但不是直接暴露。

=== 平衡性原则 ===
- 不要总是给出完全精确的信息——适度的模糊让游戏更有趣。
- 如果邪恶阵营处于劣势，可以稍微模糊信息。如果处于优势，给善良阵营更清楚的信息。
- 确保每局游戏的走向不完全由初始信息决定。`;

export function buildStorytellerPrompts(
  game: GameState,
  stepId: string,
  characterDef: CharacterDef,
): { systemPrompt: string; userPrompt: string } {
  const alive = game.players.filter(p => p.isAlive);
  const dead = game.players.filter(p => !p.isAlive);
  const characters = game.script.characters;

  const aliveList = alive.map(p => {
    const effectiveId = getEffectiveCharacterId(p);
    const shownDef = effectiveId ? characters.find(c => c.id === effectiveId) : undefined;
    const trueDef = p.characterId ? characters.find(c => c.id === p.characterId) : undefined;
    const isDrunk = p.characterId === 'drunk';
    return `  #${p.seatIndex + 1} ${p.nickname} [显示:${shownDef?.nameZh ?? '?'}/${shownDef?.alignment === 'evil' ? '邪恶' : '善良'} 真实:${trueDef?.nameZh ?? '?'}/${trueDef?.alignment === 'evil' ? '邪恶' : '善良'}${isDrunk ? ' (酒鬼)' : ''}]`;
  }).join('\n');

  const deadList = dead.length > 0
    ? dead.map(p => {
        const trueDef = p.characterId ? characters.find(c => c.id === p.characterId) : undefined;
        return `  #${p.seatIndex + 1} ${p.nickname} (已死亡, 真实身份:${trueDef?.nameZh ?? '?'})`;
      }).join('\n')
    : '  无';

  const phaseLabel = game.phase === 'first_night' ? '首夜' : `第 ${game.dayNumber} 夜`;
  const stepLabel = characterDef.nameZh;

  // 构建邪恶阵营名单（说书人视角，用于决定信息指向）
  const evilSeats = game.players.filter(p => {
    const def = p.characterId ? characters.find(c => c.id === p.characterId) : undefined;
    return def?.alignment === 'evil';
  }).map(p => `#${p.seatIndex + 1} (${characters.find(c => c.id === p.characterId)?.nameZh ?? '?'})`).join(', ');

  // 构建善良阵营已知信息摘要
  const knownInfo: string[] = [];
  const ww = game.storytellerDecisions.get('washerwoman') as any;
  const lib = game.storytellerDecisions.get('librarian') as any;
  const inv = game.storytellerDecisions.get('investigator') as any;
  if (ww) knownInfo.push(`洗衣妇已获知信息`);
  if (lib) knownInfo.push(`图书管理员已获知信息`);
  if (inv) knownInfo.push(`调查员已获知信息`);
  const publicLogs = game.publicLog.slice(-10).map(l => l.line);

  const systemPrompt = `你是血染钟楼 (Blood on the Clocktower) 的说书人。

${GAME_RULES}

重要原则：
1. 你是公正的裁判，信息应该对善良和邪恶阵营都有平衡的机会
2. 对于洗衣妇/图书管理员/调查员：选择玩家时，优先选择能创造有趣讨论和推理的指向
3. 不要总是把信息指向同一个玩家，分散信息让更多玩家参与
4. 如果邪恶阵营处于劣势，可以稍微让信息不那么精确；反之亦然
5. 你只输出合法的 JSON，不要额外解释
6. 记住：你的目标是让游戏进程有趣，不是让某一方必胜`;

  const userPrompt = `当前阶段：${phaseLabel}
当前步骤：${stepLabel}（${characterDef.name}）

=== 游戏状态 ===
存活玩家 (${alive.length}/${game.players.length})：
${aliveList}
已死亡玩家：
${deadList}

=== 阵营分布（说书人全知视角） ===
邪恶阵营：${evilSeats || '无'}
${
  game.poisonedSeatIndex != null
    ? `当前中毒玩家：#${game.poisonedSeatIndex + 1}`
    : '本轮无人中毒'
}

${
  publicLogs.length > 0
    ? `=== 已发生的公开事件 ===\n${publicLogs.map(l => `  ${l}`).join('\n')}`
    : ''
}

${stepId === 'washerwoman' ? `
你是洗衣妇。你需要选择两名存活玩家，并选择一个镇民身份，告诉洗衣妇"这两名玩家中有一位是此镇民"。
请选择两名存活玩家+一个镇民角色，输出 JSON：
{
  "players": [座位号-1, 座位号-1],
  "characterId": "角色英文id"
}
注意：推荐让其中一名玩家的真实身份与你选择的角色匹配，这样信息有意义但不直接暴露。` : ''}

${stepId === 'librarian' ? `
你是图书管理员。你需要选择两名存活玩家，并选择一个外来者身份（或标记"没有外来者"）。
请输出 JSON：
{
  "players": [座位号-1, 座位号-1],
  "characterId": "外来者角色英文id",
  "noOutsider": false
}
注意：如果游戏中有外来者，请优先让其中一名真实外来者在指认范围内。` : ''}

${stepId === 'investigator' ? `
你是调查员。你需要选择两名存活玩家，并选择一个爪牙身份，告诉调查员"这两名玩家中有一位是此爪牙"。
请输出 JSON：
{
  "players": [座位号-1, 座位号-1],
  "characterId": "爪牙角色英文id"
}
注意：推荐让一名真实爪牙在指认范围内（但建议不是直接唯一指向）。` : ''}`;

  return { systemPrompt, userPrompt };
}
