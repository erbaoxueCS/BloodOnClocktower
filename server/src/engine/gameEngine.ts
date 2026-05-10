// ============================================================
// 规则引擎：所有确定性规则在此实现
// 不包含 AI 调用、不包含说书人裁量逻辑
// ============================================================

import type {
  GameState, GamePhase, DaySubPhase, DayFlowStage,
  PlayerState, Nomination, PendingNightAction,
  ScriptDef, CharacterDef, Alignment,
  WinResult, WorldView, YourRoleInfo, ReplayIdentity,
  PublicLogEntry, ReplayLogEntry, ChatEntry, ChatScope,
} from './types.js';

// ----- 工具函数 -----
function shuffle<T>(a: T[]): T[] {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ----- 角色分配 -----
interface RoleDistribution {
  townsfolk: number; outsiders: number; minions: number; demons: number;
}

function getDistribution(playerCount: number): RoleDistribution {
  if (playerCount === 5)  return { townsfolk: 3, outsiders: 0, minions: 1, demons: 1 };
  if (playerCount === 6)  return { townsfolk: 3, outsiders: 1, minions: 1, demons: 1 };
  if (playerCount === 7)  return { townsfolk: 5, outsiders: 0, minions: 1, demons: 1 };
  if (playerCount === 8)  return { townsfolk: 5, outsiders: 1, minions: 1, demons: 1 };
  if (playerCount === 9)  return { townsfolk: 5, outsiders: 2, minions: 1, demons: 1 };
  if (playerCount === 10) return { townsfolk: 7, outsiders: 0, minions: 2, demons: 1 };
  if (playerCount === 11) return { townsfolk: 7, outsiders: 1, minions: 2, demons: 1 };
  if (playerCount === 12) return { townsfolk: 7, outsiders: 2, minions: 2, demons: 1 };
  if (playerCount === 13) return { townsfolk: 9, outsiders: 0, minions: 3, demons: 1 };
  if (playerCount === 14) return { townsfolk: 9, outsiders: 1, minions: 3, demons: 1 };
  if (playerCount === 15) return { townsfolk: 9, outsiders: 2, minions: 3, demons: 1 };
  return { townsfolk: 3, outsiders: 0, minions: 1, demons: 1 };
}

/** 男爵强制 +2 外来者 */
function applyBaronModifier(dist: RoleDistribution, inPlayCharacterIds: string[]): RoleDistribution {
  if (!inPlayCharacterIds.includes('baron')) return dist;
  return {
    ...dist,
    outsiders: Math.min(dist.outsiders + 2, dist.townsfolk + dist.outsiders - 1),
    townsfolk: Math.max(0, dist.townsfolk - 2),
  };
}

// ----- 角色池与身份分配 -----
export function assignCharacters(game: GameState): void {
  const script = game.script;
  const dist = getDistribution(game.players.length);
  const modDist = applyBaronModifier(dist, []);  // 男爵在角色池阶段处理

  const townsfolkPool = script.characters.filter(c => c.type === 'townsfolk');
  const outsiderPool = script.characters.filter(c => c.type === 'outsider');
  const minionPool = script.characters.filter(c => c.type === 'minion');
  const demonPool = script.characters.filter(c => c.type === 'demon');

  // 构建角色池
  const pool: string[] = [];
  for (let i = 0; i < modDist.townsfolk; i++) pool.push(townsfolkPool[i % townsfolkPool.length].id);
  for (let i = 0; i < modDist.outsiders; i++) pool.push(outsiderPool[i % outsiderPool.length].id);
  for (let i = 0; i < modDist.minions; i++) pool.push(minionPool[i % minionPool.length].id);
  for (let i = 0; i < modDist.demons; i++) pool.push(demonPool[i % demonPool.length].id);

  const shuffled = shuffle(pool);

  game.players.forEach((p, i) => {
    p.characterId = shuffled[i];
    p.isAlive = true;
    p.hasGhostVote = true;
    p.usedDayActions = [];
  });

  // 酒鬼伪装：随机分配一个不在场的镇民身份
  const inGameIds = new Set(shuffled);
  const pretendPool = townsfolkPool.filter(c => c.id !== 'drunk' && !inGameIds.has(c.id)).map(c => c.id);
  for (const p of game.players) {
    if (p.characterId === 'drunk') {
      p.drunkPretendCharacterId = pretendPool.length > 0
        ? pretendPool[randInt(0, pretendPool.length - 1)]
        : 'washerwoman';
    }
  }

  // 恶魔不在场 bluff（3个善良角色）
  const goodNotInGame = script.characters
    .filter(c => c.alignment === 'good' && !inGameIds.has(c.id))
    .map(c => c.id);
  game.demonBluffs = shuffle(goodNotInGame).slice(0, 3);
}

// ----- 游戏初始化 -----
export function initGame(game: GameState): void {
  game.phase = 'first_night';
  game.dayNumber = 0;
  game.daySubPhase = null;
  game.dayFlowStage = null;
  game.dayFlowStartSeat = null;
  game.nightStepIndex = 0;
  game.pendingNightAction = null;
  game.protectedSeatIndex = null;
  game.poisonedSeatIndex = null;
  game.lastNightDeaths = [];
  game.lastNightRevivals = [];
  game.nightKillAttackerByVictim = new Map();
  game.lastExecutedSeatIndex = null;
  game.lastExecutedCharacterId = null;
  game.currentNomination = null;
  game.nominationsToday = new Map();
  game.skippedNominationsToday = new Set();
  game.nominatedToday = new Set();
  game.votes = new Map();
  game.pendingExecution = null;
  game.pendingExecutionVotesFor = 0;
  game.pendingExecutionTied = false;
  game.usedDayActionsBySeat = new Map();
  game.awaitingNightConfirm = false;
  game.nightConfirmations = new Set();
  game.awaitingNightInfoConfirm = false;
  game.pendingNightInfoConfirmSeats = new Set();
  game.nightInfoConfirmations = new Set();
  game.storytellerDecisions = new Map();
  game.chatLog = [];
  game.publicLog = [];
  game.replayLog = [];
  game.demonBluffs = [];

  assignCharacters(game);
}

// ----- 有效角色ID（处理酒鬼伪装）-----
export function getEffectiveCharacterId(p: PlayerState): string | undefined {
  if (p.characterId === 'drunk' && p.drunkPretendCharacterId) {
    return p.drunkPretendCharacterId;
  }
  return p.characterId;
}

export function getShownCharacterId(p: PlayerState): string | undefined {
  return getEffectiveCharacterId(p);
}

// ----- 中毒检查 -----
export function isPoisonedOrDrunk(game: GameState, seatIndex: number): boolean {
  const p = game.players[seatIndex];
  if (!p) return false;
  if (game.poisonedSeatIndex === seatIndex) return true;
  if (p.characterId === 'drunk') return true;
  return false;
}

// ----- 查找角色 -----
export function findAliveByCharacter(game: GameState, characterId: string): number | null {
  const p = game.players.find(x => x.isAlive && getEffectiveCharacterId(x) === characterId);
  return p ? p.seatIndex : null;
}

export function findDemon(game: GameState): PlayerState | undefined {
  return game.players.find(p => p.isAlive && p.characterId === 'imp');
}

export function findAliveMinions(game: GameState): PlayerState[] {
  return game.players.filter(p =>
    p.isAlive &&
    p.characterId &&
    game.script.characters.find(c => c.id === p.characterId)?.type === 'minion'
  );
}

// ----- 夜晚顺序 -----
export function getCurrentNightOrder(game: GameState): string[] {
  return game.phase === 'first_night'
    ? game.script.firstNightOrder
    : game.script.otherNightOrder;
}

export function getCurrentNightStep(game: GameState): string | null {
  const order = getCurrentNightOrder(game);
  if (game.nightStepIndex >= order.length) return null;
  return order[game.nightStepIndex];
}

// ----- 规则计算：信息角色 -----

/** 厨师：计算相邻邪恶玩家对数（确定性） */
export function computeChefPairs(game: GameState): number {
  const n = game.players.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = game.players[i];
    const b = game.players[(i + 1) % n];
    if (!a || !b) continue;
    const ca = getEffectiveCharacterId(a);
    const cb = getEffectiveCharacterId(b);
    if (!ca || !cb) continue;
    const alignA = game.script.characters.find(c => c.id === ca)?.alignment;
    const alignB = game.script.characters.find(c => c.id === cb)?.alignment;
    if (alignA === 'evil' && alignB === 'evil') count++;
  }
  return count;
}

/** 共情者：计算相邻存活邪恶玩家数（确定性） */
export function computeEmpathCount(game: GameState, seatIndex: number): number {
  const n = game.players.length;
  const left = game.players[(seatIndex - 1 + n) % n];
  const right = game.players[(seatIndex + 1) % n];
  let count = 0;
  for (const neighbor of [left, right]) {
    if (!neighbor?.isAlive) continue;
    const cid = getEffectiveCharacterId(neighbor);
    if (!cid) continue;
    const align = game.script.characters.find(c => c.id === cid)?.alignment;
    if (align === 'evil') count++;
  }
  return count;
}

/** 占卜师：检查两名目标中是否有恶魔（确定性） */
export function checkFortuneTellerTargets(
  game: GameState,
  targets: number[],
  redHerringSeat: number | null,
): boolean {
  for (const s of targets) {
    const p = game.players[s];
    if (!p?.isAlive) continue;
    // 红鲱鱼：指定座位始终检测为恶魔
    if (redHerringSeat != null && s === redHerringSeat) return true;
    if (p.characterId === 'imp') return true;
  }
  return false;
}

/** 掘墓人：获取被处决玩家的真实角色（确定性） */
export function resolveUndertakerInfo(game: GameState): { seatIndex: number; characterId: string } | null {
  if (game.lastExecutedSeatIndex == null || game.lastExecutedCharacterId == null) return null;
  return {
    seatIndex: game.lastExecutedSeatIndex,
    characterId: game.lastExecutedCharacterId,
  };
}

/** 守鸦人：获取杀害者（确定性） */
export function resolveRavenkeeperInfo(game: GameState, victimSeat: number): number | null {
  const attacker = game.nightKillAttackerByVictim.get(victimSeat);
  return attacker ?? null;
}

// ----- 夜晚行动结算 -----

/** 结算恶魔击杀 */
export function resolveDemonKill(game: GameState, targetSeat: number, demonSeat: number): {
  killed: boolean;
  actualTarget: number;
  blockedByMonk: boolean;
  blockedBySoldier: boolean;
} {
  const target = game.players[targetSeat];
  const demon = game.players[demonSeat];
  if (!demon?.isAlive) return { killed: false, actualTarget: targetSeat, blockedByMonk: false, blockedBySoldier: false };

  // 自刀
  if (targetSeat === demonSeat) {
    // 结算恶魔自杀
    target.isAlive = false;
    game.lastNightDeaths.push(targetSeat);
    game.nightKillAttackerByVictim.set(targetSeat, demonSeat);
    promoteMinionToDemon(game);
    return { killed: true, actualTarget: targetSeat, blockedByMonk: false, blockedBySoldier: false };
  }

  // 僧侣保护
  if (game.protectedSeatIndex === targetSeat) {
    return { killed: false, actualTarget: targetSeat, blockedByMonk: true, blockedBySoldier: false };
  }

  // 士兵免疫
  if (getEffectiveCharacterId(target) === 'soldier') {
    return { killed: false, actualTarget: targetSeat, blockedByMonk: false, blockedBySoldier: true };
  }

  // 正常击杀
  target.isAlive = false;
  game.lastNightDeaths.push(targetSeat);
  game.nightKillAttackerByVictim.set(targetSeat, demonSeat);
  return { killed: true, actualTarget: targetSeat, blockedByMonk: false, blockedBySoldier: false };
}

/** 爪牙晋升为恶魔（小恶魔自刀后） */
function promoteMinionToDemon(game: GameState): void {
  const minions = game.players
    .filter(p => {
      if (!p.isAlive || !p.characterId) return false;
      const def = game.script.characters.find(c => c.id === p.characterId);
      return def?.type === 'minion';
    })
    .sort((a, b) => a.seatIndex - b.seatIndex);
  if (minions.length > 0) {
    minions[0].characterId = 'imp';
    minions[0].drunkPretendCharacterId = undefined;
  }
}

/** 猩红女巫：恶魔死后自动继位 */
export function checkScarletWoman(game: GameState): boolean {
  const aliveCount = game.players.filter(p => p.isAlive).length;
  if (aliveCount < 5) return false;
  const demonAlive = game.players.some(p => p.isAlive && p.characterId === 'imp');
  if (demonAlive) return false;
  const sw = game.players.find(p =>
    p.isAlive &&
    p.characterId === 'scarlet_woman' &&
    !isPoisonedOrDrunk(game, p.seatIndex)
  );
  if (!sw) return false;
  sw.characterId = 'imp';
  sw.drunkPretendCharacterId = undefined;
  return true;
}

/** 市长替死：说书人决定让谁替市长死（规则确定性部分：市长必须活着且被恶魔刀） */
export function shouldMayorBounce(game: GameState, mayorSeat: number): boolean {
  const mayor = game.players[mayorSeat];
  if (!mayor?.isAlive) return false;
  if (getEffectiveCharacterId(mayor) !== 'mayor') return false;
  // 至少有其他存活玩家可以替死
  const otherAlive = game.players.filter(p => p.isAlive && p.seatIndex !== mayorSeat);
  return otherAlive.length > 0;
}

// ----- 白天行动 -----

/** 杀手开枪：目标为恶魔则击杀（确定性） */
export function executeSlayerShot(game: GameState, actorSeat: number, targetSeat: number): {
  success: boolean;
  killedDemon: boolean;
} {
  const actor = game.players[actorSeat];
  if (!actor?.isAlive) return { success: false, killedDemon: false };

  // 标记已使用
  const used = game.usedDayActionsBySeat.get(actorSeat) ?? new Set();
  if (used.has('slayer_shot')) return { success: false, killedDemon: false };
  used.add('slayer_shot');
  game.usedDayActionsBySeat.set(actorSeat, used);

  const target = game.players[targetSeat];
  if (!target?.isAlive) return { success: false, killedDemon: false };

  // 杀手是否中毒/醉酒（能力可能失灵）
  if (isPoisonedOrDrunk(game, actorSeat)) {
    return { success: false, killedDemon: false };
  }

  if (target.characterId === 'imp') {
    target.isAlive = false;
    return { success: true, killedDemon: true };
  }

  // 隐士可能被误杀（说书人裁量）——规则层面，如果目标是隐士，不杀
  if (target.characterId === 'recluse') {
    return { success: true, killedDemon: false };  // 说书人可能决定隐士死亡
  }

  return { success: true, killedDemon: false };
}

/** 处女触发：提名者为镇民时立即处决（确定性条件 + 说书人确认） */
export function checkVirginTrigger(
  game: GameState,
  virginSeat: number,
  nominatorSeat: number,
): { triggered: boolean; nominatorIsTownsfolk: boolean } {
  const virgin = game.players[virginSeat];
  const nominator = game.players[nominatorSeat];
  if (!virgin?.isAlive || !nominator?.isAlive) return { triggered: false, nominatorIsTownsfolk: false };
  if (getEffectiveCharacterId(virgin) !== 'virgin') return { triggered: false, nominatorIsTownsfolk: false };
  if (isPoisonedOrDrunk(game, virginSeat)) return { triggered: false, nominatorIsTownsfolk: false };

  // 检查是否首次被提名
  const triggeredSet = game.storytellerDecisions.get('virgin_triggered_seats') as Set<number> | undefined;
  if (triggeredSet?.has(virginSeat)) return { triggered: false, nominatorIsTownsfolk: false };

  const nomCharId = getEffectiveCharacterId(nominator);
  const nomDef = nomCharId ? game.script.characters.find(c => c.id === nomCharId) : undefined;
  const nominatorIsTownsfolk = nomDef?.type === 'townsfolk';

  if (nominatorIsTownsfolk) {
    // 标记已触发
    if (!triggeredSet) game.storytellerDecisions.set('virgin_triggered_seats', new Set([virginSeat]));
    else triggeredSet.add(virginSeat);

    // 提名者被处决
    nominator.isAlive = false;
    nominator.hasGhostVote = true;
    game.lastExecutedSeatIndex = nominatorSeat;
    game.lastExecutedCharacterId = nominator.characterId ?? null;
    return { triggered: true, nominatorIsTownsfolk: true };
  }

  return { triggered: false, nominatorIsTownsfolk: false };
}

// ----- 提名与投票（确定性的计票规则）-----

/** 发起提名 */
export function nominate(game: GameState, nominatorSeat: number, nominatedSeat: number): boolean {
  if (game.phase !== 'day') return false;
  if (game.daySubPhase !== 'nomination' && game.daySubPhase !== 'discussion') return false;
  if (game.currentNomination) return false;

  const nominator = game.players[nominatorSeat];
  const nominated = game.players[nominatedSeat];
  if (!nominator?.isAlive || !nominated?.isAlive) return false;
  // 防止重复提名或被提名
  if (game.nominationsToday.has(nominatorSeat)) return false;
  if (game.skippedNominationsToday.has(nominatorSeat)) return false;
  if (game.nominatedToday.has(nominatedSeat)) return false;

  game.currentNomination = { nominator: nominatorSeat, nominated: nominatedSeat };
  game.nominationsToday.set(nominatorSeat, nominatedSeat);
  game.nominatedToday.add(nominatedSeat);
  game.votes = new Map();
  game.daySubPhase = 'voting';
  return true;
}

/** 跳过提名 */
export function skipNomination(game: GameState, seatIndex: number): boolean {
  if (game.phase !== 'day') return false;
  if (game.currentNomination) return false;
  const p = game.players[seatIndex];
  if (!p?.isAlive) return false;
  if (game.nominationsToday.has(seatIndex)) return false;
  game.skippedNominationsToday.add(seatIndex);
  return true;
}

/** 投票 */
export function vote(game: GameState, seatIndex: number, inFavor: boolean): boolean {
  if (!game.currentNomination) return false;
  const p = game.players[seatIndex];
  if (!p) return false;

  if (p.isAlive) {
    game.votes.set(seatIndex, inFavor);
    return true;
  }
  // 幽灵票：死过一次的玩家可用，用完即清
  if (p.hasGhostVote) {
    game.votes.set(seatIndex, inFavor);
    p.hasGhostVote = false;
    return true;
  }
  return false;
}

// 管家投票约束
export function canButlerVote(game: GameState, butlerSeat: number, masterSeat: number): boolean {
  // 管家只能在 master 也投票时投票
  const butler = game.players[butlerSeat];
  if (!butler?.isAlive) return true;  // 死了无所谓
  if (getEffectiveCharacterId(butler) !== 'butler') return true;
  if (game.currentNomination) {
    // 如果 master 还没投，管家不能投
    return game.votes.has(masterSeat);
  }
  return true;
}

/** 计票 */
export function tallyVotes(game: GameState): {
  passed: boolean;
  votesFor: number;
  votes: Array<{ seatIndex: number; inFavor: boolean }>;
} {
  if (!game.currentNomination) return { passed: false, votesFor: 0, votes: [] };

  const aliveCount = game.players.filter(p => p.isAlive).length;
  let votesFor = 0;
  game.votes.forEach(v => { if (v) votesFor++; });

  const required = Math.ceil(aliveCount / 2);
  const passed = votesFor >= required;

  const votes = Array.from(game.votes.entries()).map(([seatIndex, inFavor]) => ({ seatIndex, inFavor }));

  if (passed) {
    const nominee = game.currentNomination.nominated;
    if (votesFor > game.pendingExecutionVotesFor) {
      game.pendingExecution = nominee;
      game.pendingExecutionVotesFor = votesFor;
      game.pendingExecutionTied = false;
    } else if (votesFor === game.pendingExecutionVotesFor) {
      // 平局：当日无人处决
      game.pendingExecution = null;
      game.pendingExecutionTied = true;
    }
  }

  game.currentNomination = null;
  game.daySubPhase = 'nomination';  // 回到提名阶段，等待下一位提名者
  return { passed, votesFor, votes };
}

/** 检查是否所有存活玩家都已完成提名/跳过 */
function allAliveHandledNomination(game: GameState): boolean {
  return game.players
    .filter(p => p.isAlive)
    .every(p => game.nominationsToday.has(p.seatIndex) || game.skippedNominationsToday.has(p.seatIndex));
}

/** 结算处决 */
export function executePending(game: GameState): number | null {
  if (game.pendingExecution == null || game.pendingExecutionTied) {
    game.pendingExecution = null;
    game.pendingExecutionVotesFor = 0;
    game.pendingExecutionTied = false;
    return null;
  }
  const seat = game.pendingExecution;
  const p = game.players[seat];
  if (!p) return null;

  p.isAlive = false;
  p.hasGhostVote = true;
  game.lastExecutedSeatIndex = seat;
  game.lastExecutedCharacterId = p.characterId ?? null;
  game.pendingExecution = null;
  game.pendingExecutionVotesFor = 0;
  game.pendingExecutionTied = false;
  return seat;
}

/** 尝试结束白天 */
export function tryEndDay(game: GameState): 'goto_night' | 'continue' | 'ended' {
  if (game.currentNomination) return 'continue';
  if (!allAliveHandledNomination(game)) return 'continue';

  // 处决
  const executed = executePending(game);

  // 检查圣徒被处决 → 善良失败
  if (executed != null) {
    const executedChar = game.script.characters.find(c => c.id === game.lastExecutedCharacterId!);
    if (executedChar?.id === 'saint') {
      return 'ended';  // 游戏结束，邪恶获胜
    }
  }

  return 'goto_night';
}

// ----- 胜负判定 -----
export function checkWin(game: GameState): WinResult {
  const alive = game.players.filter(p => p.isAlive);

  // 恶魔是否存活
  const demonAlive = alive.some(p => p.characterId === 'imp');

  // 猩红女巫继位后也算恶魔存活
  if (!demonAlive) {
    const swAlive = alive.some(p =>
      p.characterId === 'scarlet_woman' &&
      !isPoisonedOrDrunk(game, p.seatIndex)
    );
    if (swAlive && alive.length >= 5) return null;  // 女巫即将继位
    if (!swAlive) return 'good';  // 恶魔死亡且无继位 → 善良获胜
  }

  // 市长胜利条件：仅3人存活且今日无人被处决
  if (alive.length === 3 && game.pendingExecution == null && game.pendingExecutionTied) {
    const mayorAlive = alive.some(p =>
      getEffectiveCharacterId(p) === 'mayor' &&
      !isPoisonedOrDrunk(game, p.seatIndex)
    );
    if (mayorAlive) return 'good';
  }

  // 仅剩2人存活 → 邪恶获胜
  if (alive.length <= 2) return 'evil';

  return null;
}

/** 判定圣徒处决 → 善良失败 */
export function checkSaintExecutionLoss(game: GameState, executedSeatIndex: number): boolean {
  const p = game.players[executedSeatIndex];
  if (!p) return false;
  return p.characterId === 'saint';
}

// ----- 阶段流转 -----
export function gotoDay(game: GameState): void {
  game.phase = 'day';
  game.dayNumber++;
  game.daySubPhase = 'discussion';
  game.dayFlowStage = 'god_dialogue';
  const aliveSeats = game.players.filter(p => p.isAlive).map(p => p.seatIndex);
  game.dayFlowStartSeat = aliveSeats.length > 0
    ? aliveSeats[Math.floor(Math.random() * aliveSeats.length)]
    : null;
  game.currentNomination = null;
  game.nominationsToday = new Map();
  game.skippedNominationsToday = new Set();
  game.nominatedToday = new Set();
  game.votes = new Map();
  game.pendingExecution = null;
  game.pendingExecutionVotesFor = 0;
  game.pendingExecutionTied = false;
  game.awaitingNightConfirm = false;
  game.nightConfirmations = new Set();
  game.awaitingNightInfoConfirm = false;
  game.pendingNightInfoConfirmSeats = new Set();
  game.nightInfoConfirmations = new Set();
}

export function gotoNight(game: GameState): void {
  game.phase = 'night';
  // 进入夜晚 = 黄昏：清除投毒
  game.poisonedSeatIndex = null;
  game.nightStepIndex = 0;
  game.pendingNightAction = null;
  game.awaitingNightInfoConfirm = false;
  game.pendingNightInfoConfirmSeats = new Set();
  game.nightInfoConfirmations = new Set();
  game.protectedSeatIndex = null;
  game.lastNightDeaths = [];
  game.lastNightRevivals = [];
  game.nightKillAttackerByVictim = new Map();
  game.daySubPhase = null;
  game.dayFlowStage = null;
}


// ----- 日志 -----
let seqCounter = 0;
export function pushPublicLog(game: GameState, line: string): void {
  game.publicLog.push({ seq: seqCounter++, at: Date.now(), line });
}

export function pushReplayLog(game: GameState, groupKey: string, groupTitle: string, line: string): void {
  game.replayLog.push({ seq: seqCounter++, at: Date.now(), groupKey, groupTitle, line });
}

// ----- 视野构建 -----
/** 为指定座位构建 WorldView */
export function buildWorldView(game: GameState, seatIndex: number): WorldView {
  const p = game.players[seatIndex];
  const aliveSeats = game.players.filter(x => x.isAlive).map(x => x.seatIndex);
  const deadSeats = game.players.filter(x => !x.isAlive).map(x => x.seatIndex);

  let yourRole: YourRoleInfo | undefined;
  if (p && p.characterId) {
    const shownId = getShownCharacterId(p);
    const def = shownId ? game.script.characters.find(c => c.id === shownId) : undefined;
    const trueDef = p.characterId ? game.script.characters.find(c => c.id === p.characterId) : undefined;
    if (def) {
      yourRole = {
        characterId: def.id,
        characterName: def.name,
        characterNameZh: def.nameZh,
        ability: def.ability,
        abilityZh: def.abilityZh,
        alignment: trueDef?.alignment ?? def.alignment,
        type: trueDef?.type ?? def.type,
        infoSource: def.infoSource,
      };
    }
  }

  // 过滤聊天
  const visibleChat = game.chatLog.filter(e => {
    if (e.scope === 'public') return true;
    if (e.scope === 'god') return e.fromSeat === seatIndex;
    if (e.scope === 'dm') return e.fromSeat === seatIndex || e.toSeat === seatIndex;
    return false;
  });

  return {
    seatIndex,
    phase: game.phase,
    dayNumber: game.dayNumber,
    daySubPhase: game.daySubPhase,
    aliveSeats,
    deadSeats,
    players: game.players.map(p => ({
      id: p.id,
      seatIndex: p.seatIndex,
      nickname: p.nickname,
      isReady: p.isReady,
      isAlive: p.isAlive,
      hasGhostVote: p.hasGhostVote,
    })),
    yourRole,
    yourAlignment: p?.characterId
      ? game.script.characters.find(c => c.id === p.characterId)?.alignment
      : undefined,
    publicLog: game.publicLog,
    chatLog: visibleChat,
    nominationsToday: Array.from(game.nominationsToday.entries()).map(([n, d]) => ({ nominator: n, nominated: d })),
    skippedNominationsToday: Array.from(game.skippedNominationsToday),
    currentNomination: game.currentNomination,
    pendingExecution: game.pendingExecution,
    lastNightDeaths: game.lastNightDeaths,
    lastNightRevivals: game.lastNightRevivals,
  };
}

// ----- 复盘 -----
export function buildReplayIdentities(game: GameState): ReplayIdentity[] {
  return game.players.map(p => {
    const def = p.characterId ? game.script.characters.find(c => c.id === p.characterId) : undefined;
    return {
      seatIndex: p.seatIndex,
      nickname: p.nickname,
      characterId: p.characterId ?? 'unknown',
      characterName: def?.name ?? 'unknown',
      characterZh: def?.nameZh ?? 'unknown',
      ability: def?.ability ?? '',
      alignment: def?.alignment ?? 'unknown',
      survived: p.isAlive,
    };
  });
}
