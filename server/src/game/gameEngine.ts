import type { Room, GamePhase, DaySubPhase } from './types.js';

const EVIL_CHARACTER_IDS = new Set(['imp', 'poisoner', 'spy', 'baron', 'scarlet_woman']);

export function isPoisoned(room: Room, seatIndex: number): boolean {
  return room.poisonedSeatIndex === seatIndex;
}

export function findAliveSeatByCharacter(room: Room, characterId: string): number | null {
  const p = room.players.find((x) => x.isAlive && x.characterId === characterId);
  return p ? p.seatIndex : null;
}

export function getCharacterNameZh(room: Room, characterId: string): string {
  return room.script.characters.find((c) => c.id === characterId)?.nameZh ?? characterId;
}

export function computeChefPairs(room: Room): number {
  // 计算“相邻两名邪恶玩家”的数量（环形相邻）
  const n = room.players.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = room.players[i];
    const b = room.players[(i + 1) % n];
    if (!a || !b) continue;
    const evilA = a.characterId ? EVIL_CHARACTER_IDS.has(a.characterId) : false;
    const evilB = b.characterId ? EVIL_CHARACTER_IDS.has(b.characterId) : false;
    if (evilA && evilB) count++;
  }
  return count;
}

export function computeEmpathCount(room: Room, empathSeatIndex: number): number {
  const n = room.players.length;
  const left = room.players[(empathSeatIndex - 1 + n) % n];
  const right = room.players[(empathSeatIndex + 1) % n];
  let count = 0;
  if (left?.isAlive && left.characterId && EVIL_CHARACTER_IDS.has(left.characterId)) count++;
  if (right?.isAlive && right.characterId && EVIL_CHARACTER_IDS.has(right.characterId)) count++;
  return count;
}

function randInt(min: number, max: number): number {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

export function computeChefPairsForSeat(room: Room, chefSeatIndex: number): number {
  if (isPoisoned(room, chefSeatIndex)) {
    const maxPlausible = Math.min(Math.floor(room.players.length / 2), 4);
    return randInt(0, maxPlausible);
  }
  return computeChefPairs(room);
}

export function computeEmpathCountForSeat(room: Room, empathSeatIndex: number): number {
  if (isPoisoned(room, empathSeatIndex)) return randInt(0, 2);
  return computeEmpathCount(room, empathSeatIndex);
}

export function formatWasherLibrarianInvestigator(room: Room, stepId: string, decision: any): string {
  // decision: { players:[a,b], characterId }
  const players = decision?.players as number[] | undefined;
  const characterId = decision?.characterId as string | undefined;
  if (!players || players.length !== 2 || !characterId) return `${getCharacterNameZh(room, stepId)}：无信息`;
  const [a, b] = players;
  const roleZh = getCharacterNameZh(room, characterId);
  const stepZh = getCharacterNameZh(room, stepId);
  return `${stepZh}：在 #${a + 1} 与 #${b + 1} 中，有一位是「${roleZh}」。`;
}

export function formatUndertakerInfo(room: Room): string {
  // 掘墓人是否中毒由调用方决定（需要 seatIndex）
  if (room.lastExecutedSeatIndex == null || room.lastExecutedCharacterId == null) return '掘墓人：今日无人被处决。';
  const roleZh = getCharacterNameZh(room, room.lastExecutedCharacterId);
  return `掘墓人：今日被处决的是 #${room.lastExecutedSeatIndex + 1}，其身份为「${roleZh}」。`;
}

export function formatUndertakerInfoForSeat(room: Room, undertakerSeatIndex: number): string {
  if (room.lastExecutedSeatIndex == null || room.lastExecutedCharacterId == null) return '掘墓人：今日无人被处决。';
  if (isPoisoned(room, undertakerSeatIndex)) {
    const any = room.script.characters[randInt(0, room.script.characters.length - 1)]?.id ?? 'unknown';
    return `掘墓人：今日被处决的是 #${room.lastExecutedSeatIndex + 1}，其身份为「${getCharacterNameZh(room, any)}」。`;
  }
  return formatUndertakerInfo(room);
}

export function formatFortuneTellerResult(room: Room, targets: number[]): string {
  const demonSeat = findAliveSeatByCharacter(room, 'imp');
  const hasDemon = demonSeat != null && targets.includes(demonSeat);
  return `占卜师：你选择了 #${targets[0] + 1} 与 #${targets[1] + 1}，结果为「${hasDemon ? '是（其中有恶魔）' : '否（其中没有恶魔）'}」。`;
}

export function formatFortuneTellerResultForSeat(room: Room, fortuneSeatIndex: number, targets: number[]): string {
  if (isPoisoned(room, fortuneSeatIndex)) {
    const yes = Math.random() < 0.5;
    return `占卜师：你选择了 #${targets[0] + 1} 与 #${targets[1] + 1}，结果为「${yes ? '是（其中有恶魔）' : '否（其中没有恶魔）'}」。`;
  }
  return formatFortuneTellerResult(room, targets);
}

/** 根据人数生成本局角色池（暗流涌动简化：固定比例） */
export function assignRoles(room: Room): void {
  const n = room.players.length;
  const script = room.script;
  const townsfolk = script.characters.filter((c) => c.type === 'townsfolk');
  const outsiders = script.characters.filter((c) => c.type === 'outsider');
  const minions = script.characters.filter((c) => c.type === 'minion');
  const demons = script.characters.filter((c) => c.type === 'demon');

  let numOutsiders = 0;
  if (n <= 6) numOutsiders = 0;
  else if (n <= 9) numOutsiders = 1;
  else if (n <= 12) numOutsiders = 2;
  else numOutsiders = 3;

  const numEvil = n <= 6 ? 1 : 2;
  const numMinions = numEvil - 1;
  const numTownsfolk = n - numOutsiders - numEvil;

  const pool: string[] = [];
  for (let i = 0; i < numTownsfolk; i++) {
    pool.push(townsfolk[i % townsfolk.length].id);
  }
  for (let i = 0; i < numOutsiders; i++) {
    pool.push(outsiders[i % outsiders.length].id);
  }
  for (let i = 0; i < numMinions; i++) {
    pool.push(minions[i % minions.length].id);
  }
  pool.push(demons[0].id);

  shuffle(pool);
  room.players.forEach((p, i) => {
    p.characterId = pool[i];
    p.isAlive = true;
    p.hasDeadVote = true;
  });

  if (n >= 7) {
    const inGame = new Set(pool);
    const goodChars = script.characters.filter((c) => c.alignment === 'good' && c.type !== 'demon');
    const notInGame = goodChars.filter((c) => !inGame.has(c.id)).map((c) => c.id);
    shuffle(notInGame);
    room.demonBluffs = notInGame.slice(0, 3);
  } else {
    room.demonBluffs = null;
  }
}

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

/** 开始游戏：进入首夜 */
export function startGame(room: Room): boolean {
  if (room.status !== 'lobby' || room.players.length < room.script.minPlayers) return false;
  const allReady = room.players.every((p) => p.isReady);
  if (!allReady) return false;
  room.status = 'playing';
  assignRoles(room);
  room.phase = 'first_night';
  room.dayNumber = 0;
  room.nightStepIndex = 0;
  room.pendingNightAction = null;
  room.protectedSeatIndex = null;
  room.poisonedSeatIndex = null;
  room.lastExecutedSeatIndex = null;
  room.lastExecutedCharacterId = null;
  room.lastNightDeaths = [];
  room.lastNightRevivals = [];
  return true;
}

/** 当前夜晚顺序表 */
export function getCurrentNightOrder(room: Room): string[] {
  return room.phase === 'first_night' ? room.script.firstNightOrder : room.script.otherNightOrder;
}

/** 当前夜晚步骤 ID */
export function getCurrentNightStep(room: Room): string | null {
  const order = getCurrentNightOrder(room);
  if (room.nightStepIndex >= order.length) return null;
  return order[room.nightStepIndex];
}

/** 需要说书人决策时返回步骤信息，否则返回 null */
export function getStorytellerStep(room: Room): { stepId: string; characterId: string } | null {
  const stepId = getCurrentNightStep(room);
  if (!stepId) return null;
  const char = room.script.characters.find((c) => c.id === stepId);
  if (char?.requiresStorytellerChoice) return { stepId, characterId: stepId };
  if (stepId === 'demon_info' || stepId === 'minion_info') return null;
  return null;
}

/** 应用说书人决策并推进夜晚（可传入随机占位结果） */
export function applyStorytellerDecision(room: Room, decision: unknown): void {
  const stepId = getCurrentNightStep(room);
  if (!stepId) return;
  room.storytellerDecisions.set(stepId, decision);
  room.nightStepIndex++;
  advanceNight(room);
}

/** 随机生成说书人决策（Phase 1 占位） */
export function randomStorytellerDecision(room: Room): unknown {
  const stepId = getCurrentNightStep(room);
  if (!stepId) return null;
  const aliveSeats = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
  if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
    if (aliveSeats.length < 2) return null;
    const [a, b] = pickTwo(aliveSeats);
    const goodChars = room.script.characters.filter((c) => c.alignment === 'good' && c.type !== 'outsider');
    const char = goodChars[Math.floor(Math.random() * goodChars.length)];
    return { type: `${stepId}_result`, players: [a, b], characterId: char.id };
  }
  return null;
}

function pickTwo(arr: number[]): [number, number] {
  const i = Math.floor(Math.random() * arr.length);
  let j = Math.floor(Math.random() * arr.length);
  while (j === i) j = Math.floor(Math.random() * arr.length);
  return [arr[i], arr[j]];
}

/** 推进夜晚：执行下一步；若需说书人决策则停留并返回 true */
export function advanceNight(room: Room): boolean {
  // 若正在等待玩家夜晚行动输入，则不推进
  if (room.pendingNightAction) return false;
  const order = getCurrentNightOrder(room);
  if (room.nightStepIndex >= order.length) {
    gotoDay(room);
    return false;
  }
  const stepId = order[room.nightStepIndex];
  const char = room.script.characters.find((c) => c.id === stepId);
  if (char?.requiresStorytellerChoice) return true;
  if (stepId === 'demon_info' || stepId === 'minion_info') {
    room.nightStepIndex++;
    return advanceNight(room);
  }
  // 需要玩家选择目标的夜晚行动：暂停并等待输入
  if (stepId === 'imp' || stepId === 'monk' || stepId === 'fortune_teller' || stepId === 'poisoner') {
    const actor = room.players.find((p) => p.isAlive && p.characterId === stepId);
    if (actor) {
      room.pendingNightAction = { stepId, actorSeatIndex: actor.seatIndex, pick: stepId === 'fortune_teller' ? 2 : 1 };
      return false;
    }
    // 若该角色不在场或已死亡，直接跳过
    room.nightStepIndex++;
    return advanceNight(room);
  }
  room.nightStepIndex++;
  return advanceNight(room);
}

function runDemonKill(room: Room): void {
  const demon = room.players.find((p) => p.characterId === 'imp' && p.isAlive);
  if (!demon) return;
  const decision = room.storytellerDecisions.get('imp_kill') as number | undefined;
  if (decision !== undefined) {
    // 若恶魔中毒，杀人结果不可靠：50% 无人死亡，否则随机杀一名存活玩家（不含自己）
    let actualTargetSeat = decision;
    if (isPoisoned(room, demon.seatIndex)) {
      if (Math.random() < 0.5) return;
      const alive = room.players.filter((p) => p.isAlive && p.seatIndex !== demon.seatIndex);
      if (alive.length === 0) return;
      actualTargetSeat = alive[randInt(0, alive.length - 1)].seatIndex;
    }
    const target = room.players[actualTargetSeat];
    if (target?.isAlive && target.seatIndex !== demon.seatIndex) {
      if (room.protectedSeatIndex === target.seatIndex) return;
      room.lastNightDeaths.push(actualTargetSeat);
      target.isAlive = false;
    }
  }
}

/** 提交夜晚行动（由服务端在收到玩家输入后调用） */
export function submitNightAction(room: Room, actorSeatIndex: number, targets: number[]): { ok: boolean; error?: string; info?: string } {
  const pending = room.pendingNightAction;
  if (!pending) return { ok: false, error: 'no_pending_action' };
  if (pending.actorSeatIndex !== actorSeatIndex) return { ok: false, error: 'not_your_turn' };
  if (targets.length !== pending.pick) return { ok: false, error: 'invalid_target_count' };
  const actor = room.players[actorSeatIndex];
  if (!actor?.isAlive) return { ok: false, error: 'actor_not_alive' };

  const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));
  for (const t of targets) {
    if (!Number.isInteger(t) || !aliveSeats.has(t)) return { ok: false, error: 'invalid_target' };
  }

  const stepId = pending.stepId;
  let info: string | undefined;
  if (stepId === 'imp') {
    if (targets[0] === actorSeatIndex) return { ok: false, error: 'cannot_kill_self' };
    room.storytellerDecisions.set('imp_kill', targets[0]);
    // 立即结算恶魔杀人
    runDemonKill(room);
  } else if (stepId === 'monk') {
    // 若僧侣中毒，其保护可能失效（这里直接失效）
    if (!isPoisoned(room, actorSeatIndex)) room.protectedSeatIndex = targets[0];
    room.storytellerDecisions.set('monk_protect', targets[0]);
  } else if (stepId === 'poisoner') {
    // 若投毒者中毒：随机投毒目标
    const alive = room.players.filter((p) => p.isAlive);
    const actual = isPoisoned(room, actorSeatIndex) ? alive[randInt(0, alive.length - 1)].seatIndex : targets[0];
    room.poisonedSeatIndex = actual;
    room.storytellerDecisions.set('poisoner_poison', actual);
  } else if (stepId === 'fortune_teller') {
    room.storytellerDecisions.set('fortune_teller_pick', targets);
    info = formatFortuneTellerResultForSeat(room, actorSeatIndex, targets);
  }

  room.pendingNightAction = null;
  room.nightStepIndex++;
  advanceNight(room);
  return { ok: true, info };
}

function gotoDay(room: Room): void {
  room.phase = 'day';
  room.dayNumber++;
  room.daySubPhase = 'discussion';
  room.currentNomination = null;
  room.nominationsToday = new Map();
  room.nominatedToday = new Set();
  room.votes = new Map();
  room.pendingExecution = null;
}

/** 进入提名阶段 */
export function startNominationPhase(room: Room): void {
  room.daySubPhase = 'nomination';
  room.currentNomination = null;
}

/** 发起提名 */
export function nominate(room: Room, nominatorSeat: number, nominatedSeat: number): boolean {
  if (room.daySubPhase !== 'nomination' && room.daySubPhase !== 'discussion') return false;
  const nominator = room.players[nominatorSeat];
  const nominated = room.players[nominatedSeat];
  if (!nominator?.isAlive || !nominated) return false;
  if (room.nominationsToday.has(nominatorSeat)) return false;
  if (room.nominatedToday.has(nominatedSeat)) return false;
  if (room.currentNomination !== null) return false;

  room.daySubPhase = 'nomination';
  room.currentNomination = { nominator: nominatorSeat, nominated: nominatedSeat };
  room.nominationsToday.set(nominatorSeat, nominatedSeat);
  room.nominatedToday.add(nominatedSeat);
  room.votes = new Map();
  return true;
}

/** 投票 */
export function vote(room: Room, seatIndex: number, inFavor: boolean): boolean {
  if (room.currentNomination === null) return false;
  const p = room.players[seatIndex];
  if (!p) return false;
  // 存活玩家：每次提名都可以投票
  if (p.isAlive) {
    room.votes.set(seatIndex, inFavor);
    return true;
  }
  // 死亡玩家：整局仅一次“幽灵票”
  if (!p.hasDeadVote) return false;
  room.votes.set(seatIndex, inFavor);
  // 立刻消耗幽灵票（不允许改票/反悔）
  p.hasDeadVote = false;
  return true;
}

/** 统计投票并判定是否处决 */
export function tallyVotes(room: Room): { passed: boolean; votesFor: number; votes: Array<{ seatIndex: number; inFavor: boolean }> } {
  if (room.currentNomination === null) return { passed: false, votesFor: 0, votes: [] };
  const aliveCount = room.players.filter((p) => p.isAlive).length;
  let votesFor = 0;
  room.votes.forEach((v) => { if (v) votesFor++; });
  const required = Math.ceil(aliveCount / 2);
  const passed = votesFor >= required;
  if (passed) room.pendingExecution = room.currentNomination.nominated;
  const votes = Array.from(room.votes.entries()).map(([seatIndex, inFavor]) => ({ seatIndex, inFavor }));
  room.currentNomination = null;
  return { passed, votesFor, votes };
}

/** 执行处决并进入夜晚或结束 */
export function execute(room: Room): void {
  const target = room.pendingExecution;
  if (target == null) return;
  const p = room.players[target];
  if (!p) return;
  p.isAlive = false;
  // 死亡后的“幽灵票”默认可用；消耗在投票时处理
  p.hasDeadVote = true;
  room.lastExecutedSeatIndex = target;
  room.lastExecutedCharacterId = p.characterId ?? null;
  room.pendingExecution = null;
  room.daySubPhase = 'discussion';

  const win = checkWin(room);
  if (win) {
    room.status = 'ended';
    room.phase = 'waiting';
    return;
  }
  room.phase = 'night';
  // 进入夜晚视为黄昏：清除上一夜投毒效果
  room.poisonedSeatIndex = null;
  room.nightStepIndex = 0;
  room.lastNightDeaths = [];
  room.lastNightRevivals = [];
}

/** 检查胜利条件 */
export function checkWin(room: Room): 'good' | 'evil' | null {
  const alive = room.players.filter((p) => p.isAlive);
  const demonAlive = alive.some((p) => p.characterId === 'imp');
  if (!demonAlive) return 'good';
  if (alive.length <= 2) return 'evil';
  return null;
}
