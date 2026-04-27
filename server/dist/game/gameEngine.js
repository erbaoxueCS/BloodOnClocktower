const EVIL_CHARACTER_IDS = new Set(['imp', 'poisoner', 'spy', 'baron', 'scarlet_woman']);
/** 可作为「世袭」新恶魔的爪牙（小恶魔自杀后由其一继位） */
const MINION_CHARACTER_IDS = new Set(['poisoner', 'spy', 'baron', 'scarlet_woman']);
export function isPoisoned(room, seatIndex) {
    const p = room.players[seatIndex];
    // 简化：酒鬼视为“醉酒/中毒”状态，其信息与能力可能失真或无效
    return room.poisonedSeatIndex === seatIndex || p?.characterId === 'drunk';
}
export function findAliveSeatByCharacter(room, characterId) {
    const p = room.players.find((x) => x.isAlive && getEffectiveCharacterId(x) === characterId);
    return p ? p.seatIndex : null;
}
export function getCharacterNameZh(room, characterId) {
    return room.script.characters.find((c) => c.id === characterId)?.nameZh ?? characterId;
}
export function getEffectiveCharacterId(p) {
    if (p.characterId === 'drunk' && p.drunkPretendCharacterId)
        return p.drunkPretendCharacterId;
    return p.characterId;
}
export function getShownCharacterId(p) {
    // 严格酒鬼伪装：客户端看到“伪装角色”
    return getEffectiveCharacterId(p);
}
function getCharacterMeta(room, characterId) {
    if (!characterId)
        return null;
    return room.script.characters.find((c) => c.id === characterId) ?? null;
}
function getVirginTriggeredSet(room) {
    const k = 'virgin_triggered_seats';
    const v = room.storytellerDecisions.get(k);
    if (v instanceof Set)
        return v;
    const s = new Set();
    room.storytellerDecisions.set(k, s);
    return s;
}
export function computeChefPairs(room) {
    // 计算“相邻两名邪恶玩家”的数量（环形相邻）
    const n = room.players.length;
    let count = 0;
    for (let i = 0; i < n; i++) {
        const a = room.players[i];
        const b = room.players[(i + 1) % n];
        if (!a || !b)
            continue;
        const ca = getEffectiveCharacterId(a);
        const cb = getEffectiveCharacterId(b);
        const evilA = ca ? EVIL_CHARACTER_IDS.has(ca) : false;
        const evilB = cb ? EVIL_CHARACTER_IDS.has(cb) : false;
        if (evilA && evilB)
            count++;
    }
    return count;
}
export function computeEmpathCount(room, empathSeatIndex) {
    const n = room.players.length;
    const left = room.players[(empathSeatIndex - 1 + n) % n];
    const right = room.players[(empathSeatIndex + 1) % n];
    let count = 0;
    const cl = left ? getEffectiveCharacterId(left) : undefined;
    const cr = right ? getEffectiveCharacterId(right) : undefined;
    if (left?.isAlive && cl && EVIL_CHARACTER_IDS.has(cl))
        count++;
    if (right?.isAlive && cr && EVIL_CHARACTER_IDS.has(cr))
        count++;
    return count;
}
function randInt(min, max) {
    const a = Math.ceil(min);
    const b = Math.floor(max);
    return Math.floor(Math.random() * (b - a + 1)) + a;
}
export function computeChefPairsForSeat(room, chefSeatIndex) {
    if (isPoisoned(room, chefSeatIndex)) {
        const maxPlausible = Math.min(Math.floor(room.players.length / 2), 4);
        return randInt(0, maxPlausible);
    }
    return computeChefPairs(room);
}
export function computeEmpathCountForSeat(room, empathSeatIndex) {
    if (isPoisoned(room, empathSeatIndex))
        return randInt(0, 2);
    return computeEmpathCount(room, empathSeatIndex);
}
export function formatWasherLibrarianInvestigator(room, stepId, decision) {
    // decision: { players:[a,b], characterId }
    const players = decision?.players;
    const characterId = decision?.characterId;
    if (!players || players.length !== 2 || !characterId)
        return `${getCharacterNameZh(room, stepId)}：无信息`;
    const [a, b] = players;
    const roleZh = getCharacterNameZh(room, characterId);
    const stepZh = getCharacterNameZh(room, stepId);
    return `${stepZh}：在 #${a + 1} 与 #${b + 1} 中，有一位是「${roleZh}」。`;
}
/**
 * 洗衣妇/图书管理员/调查员：中毒或醉酒时用“随机但看起来合理”的假信息。
 * - 约 50%：保留两人、换掉宣称的镇民身份；
 * - 约 50%：另选两名存活玩家 + 随机镇民身份（与随机说书人占位同一“善良镇民”池）。
 */
export function distortWasherLibrarianInvestigatorDecision(room, infoSeatIndex, truth) {
    if (!truth || truth.players.length !== 2)
        return truth;
    if (!isPoisoned(room, infoSeatIndex))
        return truth;
    const aliveSeats = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
    if (aliveSeats.length < 2)
        return truth;
    const goodTowns = room.script.characters.filter((c) => c.alignment === 'good' && c.type !== 'outsider');
    if (goodTowns.length === 0)
        return truth;
    if (Math.random() < 0.5) {
        const others = goodTowns.filter((c) => c.id !== truth.characterId);
        const pool = others.length > 0 ? others : goodTowns;
        const char = pool[randInt(0, pool.length - 1)];
        return { players: [truth.players[0], truth.players[1]], characterId: char.id };
    }
    const [a, b] = pickTwo(aliveSeats);
    const char = goodTowns[randInt(0, goodTowns.length - 1)];
    return { players: [a, b], characterId: char.id };
}
/** 守鸦人夜间死亡后获知行凶者身份（简化：记录恶魔刀人时的行凶座位） */
export function resolveRavenkeeperNightInfo(room, victimSeat) {
    const p = room.players[victimSeat];
    if (!p || p.characterId !== 'ravenkeeper')
        return '';
    const attackerSeat = room.nightKillAttackerByVictim.get(victimSeat);
    if (isPoisoned(room, victimSeat)) {
        const alive = room.players.filter((x) => x.isAlive);
        if (alive.length === 0)
            return '守鸦人：你得知的信息乱了…';
        const decoy = alive[randInt(0, alive.length - 1)];
        const sh = getShownCharacterId(decoy) ?? decoy.characterId ?? '?';
        return `守鸦人：杀害你的是 #${decoy.seatIndex + 1}，其身份为「${getCharacterNameZh(room, sh)}」。（信息可能为假）`;
    }
    if (attackerSeat !== undefined && room.players[attackerSeat]) {
        const kid = room.players[attackerSeat]?.characterId;
        return `守鸦人：杀害你的是 #${attackerSeat + 1}，其身份为「${getCharacterNameZh(room, kid ?? 'unknown')}」。`;
    }
    return '守鸦人：你无法得知杀害者的身份。';
}
export function formatUndertakerInfo(room) {
    // 掘墓人是否中毒由调用方决定（需要 seatIndex）
    if (room.lastExecutedSeatIndex == null || room.lastExecutedCharacterId == null)
        return '掘墓人：今日无人被处决。';
    const roleZh = getCharacterNameZh(room, room.lastExecutedCharacterId);
    return `掘墓人：今日被处决的是 #${room.lastExecutedSeatIndex + 1}，其身份为「${roleZh}」。`;
}
export function formatUndertakerInfoForSeat(room, undertakerSeatIndex) {
    if (room.lastExecutedSeatIndex == null || room.lastExecutedCharacterId == null)
        return '掘墓人：今日无人被处决。';
    if (isPoisoned(room, undertakerSeatIndex)) {
        const any = room.script.characters[randInt(0, room.script.characters.length - 1)]?.id ?? 'unknown';
        return `掘墓人：今日被处决的是 #${room.lastExecutedSeatIndex + 1}，其身份为「${getCharacterNameZh(room, any)}」。`;
    }
    return formatUndertakerInfo(room);
}
export function formatFortuneTellerResult(room, targets) {
    const hasDemon = targets.some((s) => room.players[s]?.isAlive && room.players[s]?.characterId === 'imp');
    return `占卜师：你选择了 #${targets[0] + 1} 与 #${targets[1] + 1}，结果为「${hasDemon ? '是（其中有恶魔）' : '否（其中没有恶魔）'}」。`;
}
export function formatFortuneTellerResultForSeat(room, fortuneSeatIndex, targets) {
    if (isPoisoned(room, fortuneSeatIndex)) {
        const yes = Math.random() < 0.5;
        return `占卜师：你选择了 #${targets[0] + 1} 与 #${targets[1] + 1}，结果为「${yes ? '是（其中有恶魔）' : '否（其中没有恶魔）'}」。`;
    }
    return formatFortuneTellerResult(room, targets);
}
/** 根据人数生成本局角色池（暗流涌动简化：固定比例） */
export function assignRoles(room) {
    const n = room.players.length;
    const script = room.script;
    const townsfolk = script.characters.filter((c) => c.type === 'townsfolk');
    const outsiders = script.characters.filter((c) => c.type === 'outsider');
    const minions = script.characters.filter((c) => c.type === 'minion');
    const demons = script.characters.filter((c) => c.type === 'demon');
    let numOutsiders = 0;
    if (n <= 6)
        numOutsiders = 0;
    else if (n <= 9)
        numOutsiders = 1;
    else if (n <= 12)
        numOutsiders = 2;
    else
        numOutsiders = 3;
    const numEvil = n <= 6 ? 1 : 2;
    const numMinions = numEvil - 1;
    const numTownsfolk = n - numOutsiders - numEvil;
    const pool = [];
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
        p.drunkPretendCharacterId = null;
        p.isAlive = true;
        p.hasDeadVote = true;
        p.usedDayActions = [];
    });
    // 酒鬼严格伪装：从 townsfolk 中随机挑一个“伪装角色”，尽量避免与场上真实角色重复
    const inGameReal = new Set(room.players.map((p) => p.characterId).filter(Boolean));
    const pretendCandidates = townsfolk.map((c) => c.id).filter((id) => id !== 'drunk');
    for (const p of room.players) {
        if (p.characterId !== 'drunk')
            continue;
        const notUsed = pretendCandidates.filter((id) => !inGameReal.has(id));
        const pool2 = (notUsed.length > 0 ? notUsed : pretendCandidates);
        p.drunkPretendCharacterId = pool2[Math.floor(Math.random() * pool2.length)] ?? 'washerwoman';
    }
    // 恶魔 3 张不在场“伪装身份”：无论人数多少都生成，便于邪恶阵营可持续伪装与编故事。
    // 约束：必须是不在场的善良角色（排除恶魔）。
    const inGame = new Set(pool);
    const goodChars = script.characters.filter((c) => c.alignment === 'good' && c.type !== 'demon');
    const notInGame = goodChars.filter((c) => !inGame.has(c.id)).map((c) => c.id);
    shuffle(notInGame);
    room.demonBluffs = notInGame.slice(0, 3);
}
function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
}
/** 开始游戏：进入首夜 */
export function startGame(room) {
    if (room.status !== 'lobby' || room.players.length < room.script.minPlayers)
        return false;
    const allReady = room.players.every((p) => p.isReady);
    if (!allReady)
        return false;
    room.status = 'playing';
    room.replayLog = [];
    room.publicLog = [];
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
    room.usedDayActionsBySeat = new Map();
    room.nightKillAttackerByVictim = new Map();
    return true;
}
/** 当前夜晚顺序表 */
export function getCurrentNightOrder(room) {
    return room.phase === 'first_night' ? room.script.firstNightOrder : room.script.otherNightOrder;
}
/** 当前夜晚步骤 ID */
export function getCurrentNightStep(room) {
    const order = getCurrentNightOrder(room);
    if (room.nightStepIndex >= order.length)
        return null;
    return order[room.nightStepIndex];
}
/** 需要说书人决策时返回步骤信息，否则返回 null */
export function getStorytellerStep(room) {
    const stepId = getCurrentNightStep(room);
    if (!stepId)
        return null;
    const char = room.script.characters.find((c) => c.id === stepId);
    if (char?.requiresStorytellerChoice)
        return { stepId, characterId: stepId };
    if (stepId === 'demon_info' || stepId === 'minion_info')
        return null;
    return null;
}
/** 应用说书人决策并推进夜晚（可传入随机占位结果） */
export function applyStorytellerDecision(room, decision) {
    const stepId = getCurrentNightStep(room);
    if (!stepId)
        return;
    room.storytellerDecisions.set(stepId, decision);
    room.nightStepIndex++;
    advanceNight(room);
}
/** 随机生成说书人决策（Phase 1 占位） */
export function randomStorytellerDecision(room) {
    const stepId = getCurrentNightStep(room);
    if (!stepId)
        return null;
    const aliveSeats = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
    if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
        if (aliveSeats.length < 2)
            return null;
        const [a, b] = pickTwo(aliveSeats);
        const goodChars = room.script.characters.filter((c) => c.alignment === 'good' && c.type !== 'outsider');
        const char = goodChars[Math.floor(Math.random() * goodChars.length)];
        return { type: `${stepId}_result`, players: [a, b], characterId: char.id };
    }
    return null;
}
function pickTwo(arr) {
    const i = Math.floor(Math.random() * arr.length);
    let j = Math.floor(Math.random() * arr.length);
    while (j === i)
        j = Math.floor(Math.random() * arr.length);
    return [arr[i], arr[j]];
}
/** 推进夜晚：执行下一步；若需说书人决策则停留并返回 true */
export function advanceNight(room) {
    // 若正在等待玩家夜晚行动输入，则不推进
    if (room.pendingNightAction)
        return false;
    const order = getCurrentNightOrder(room);
    if (room.nightStepIndex >= order.length) {
        // 夜序结束：改为等待全员确认天亮
        room.awaitingNightConfirm = true;
        room.nightConfirmations = new Set();
        return false;
    }
    const stepId = order[room.nightStepIndex];
    const char = room.script.characters.find((c) => c.id === stepId);
    if (char?.requiresStorytellerChoice)
        return true;
    if (stepId === 'demon_info' || stepId === 'minion_info') {
        room.nightStepIndex++;
        return advanceNight(room);
    }
    // 需要玩家选择目标的夜晚行动：暂停并等待输入
    if (stepId === 'imp' || stepId === 'monk' || stepId === 'fortune_teller' || stepId === 'poisoner') {
        const actor = room.players.find((p) => p.isAlive && getEffectiveCharacterId(p) === stepId);
        if (actor) {
            room.pendingNightAction = { stepId, actorSeatIndex: actor.seatIndex, pick: stepId === 'fortune_teller' ? 2 : 1 };
            return false;
        }
        // 若该角色不在场或已死亡，直接跳过
        room.nightStepIndex++;
        return advanceNight(room);
    }
    // 守鸦人：纯信息、由 `index.ts` 的 runNightLoop 处理，禁止在此处递归跳过
    if (stepId === 'ravenkeeper')
        return false;
    room.nightStepIndex++;
    return advanceNight(room);
}
function promoteFirstMinionToImp(room) {
    const candidates = room.players
        .filter((p) => p.isAlive && getEffectiveCharacterId(p) && MINION_CHARACTER_IDS.has(getEffectiveCharacterId(p)))
        .sort((a, b) => a.seatIndex - b.seatIndex);
    if (candidates.length === 0)
        return;
    candidates[0].characterId = 'imp';
    candidates[0].drunkPretendCharacterId = null;
}
function runDemonKill(room) {
    const demon = room.players.find((p) => getEffectiveCharacterId(p) === 'imp' && p.isAlive);
    if (!demon)
        return;
    const decision = room.storytellerDecisions.get('imp_kill');
    if (decision === undefined)
        return;
    // 若恶魔中毒，杀人结果不可靠：50% 无人死亡，否则随机杀害一名其他存活玩家
    let actualTargetSeat = decision;
    if (isPoisoned(room, demon.seatIndex)) {
        if (Math.random() < 0.5)
            return;
        const aliveOthers = room.players.filter((p) => p.isAlive && p.seatIndex !== demon.seatIndex);
        if (aliveOthers.length === 0)
            return;
        actualTargetSeat = aliveOthers[randInt(0, aliveOthers.length - 1)].seatIndex;
    }
    const target = room.players[actualTargetSeat];
    if (!target?.isAlive)
        return;
    const isSelfKill = actualTargetSeat === demon.seatIndex;
    // 僧侣保护仅挡「恶魔杀害他人」；恶魔刀自己不受保护影响
    if (!isSelfKill && room.protectedSeatIndex === target.seatIndex)
        return;
    // 士兵：恶魔无法杀死你（若士兵中毒/醉酒则视为无效）
    if (!isSelfKill && getEffectiveCharacterId(target) === 'soldier' && !isPoisoned(room, target.seatIndex))
        return;
    room.lastNightDeaths.push(actualTargetSeat);
    room.nightKillAttackerByVictim.set(actualTargetSeat, demon.seatIndex);
    target.isAlive = false;
    if (isSelfKill)
        promoteFirstMinionToImp(room);
}
/** 提交夜晚行动（由服务端在收到玩家输入后调用） */
export function submitNightAction(room, actorSeatIndex, targets) {
    const pending = room.pendingNightAction;
    if (!pending)
        return { ok: false, error: 'no_pending_action' };
    if (pending.actorSeatIndex !== actorSeatIndex)
        return { ok: false, error: 'not_your_turn' };
    if (targets.length !== pending.pick)
        return { ok: false, error: 'invalid_target_count' };
    const actor = room.players[actorSeatIndex];
    if (!actor?.isAlive)
        return { ok: false, error: 'actor_not_alive' };
    const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));
    for (const t of targets) {
        if (!Number.isInteger(t) || !aliveSeats.has(t))
            return { ok: false, error: 'invalid_target' };
    }
    const stepId = pending.stepId;
    let info;
    if (stepId === 'imp') {
        room.storytellerDecisions.set('imp_kill', targets[0]);
        // 立即结算恶魔杀人
        runDemonKill(room);
    }
    else if (stepId === 'monk') {
        // 若僧侣中毒，其保护可能失效（这里直接失效）
        if (!isPoisoned(room, actorSeatIndex))
            room.protectedSeatIndex = targets[0];
        room.storytellerDecisions.set('monk_protect', targets[0]);
    }
    else if (stepId === 'poisoner') {
        // 若投毒者中毒：随机投毒目标
        const alive = room.players.filter((p) => p.isAlive);
        const actual = isPoisoned(room, actorSeatIndex) ? alive[randInt(0, alive.length - 1)].seatIndex : targets[0];
        room.poisonedSeatIndex = actual;
        room.storytellerDecisions.set('poisoner_poison', actual);
    }
    else if (stepId === 'fortune_teller') {
        room.storytellerDecisions.set('fortune_teller_pick', targets);
        info = formatFortuneTellerResultForSeat(room, actorSeatIndex, targets);
    }
    room.pendingNightAction = null;
    room.nightStepIndex++;
    advanceNight(room);
    return { ok: true, info };
}
function gotoDay(room) {
    room.phase = 'day';
    room.dayNumber++;
    // 按需求：白天不需要“进入提名阶段”按钮，天亮后直接开始提名流转
    room.daySubPhase = 'nomination';
    room.currentNomination = null;
    room.nominationsToday = new Map();
    room.skippedNominationsToday = new Set();
    room.nominatedToday = new Set();
    room.votes = new Map();
    room.pendingExecution = null;
    room.pendingExecutionVotesFor = 0;
    room.pendingExecutionTied = false;
    room.awaitingNightConfirm = false;
    room.nightConfirmations = new Set();
    /** 胜负仅在「进入白天」时结算，便于夜间链式规则（刀自己、后续角色等）自由组合 */
    const win = checkWin(room);
    if (win) {
        room.status = 'ended';
        room.phase = 'waiting';
    }
}
export function finishNightAndGotoDay(room) {
    if (room.status !== 'playing')
        return;
    if (room.phase !== 'night' && room.phase !== 'first_night')
        return;
    if (!room.awaitingNightConfirm)
        return;
    room.awaitingNightConfirm = false;
    room.nightConfirmations = new Set();
    gotoDay(room);
}
function gotoNight(room) {
    room.phase = 'night';
    // 进入夜晚视为黄昏：清除上一夜投毒效果
    room.poisonedSeatIndex = null;
    room.nightStepIndex = 0;
    room.pendingNightAction = null;
    room.protectedSeatIndex = null;
    room.lastNightDeaths = [];
    room.lastNightRevivals = [];
    room.nightKillAttackerByVictim = new Map();
}
function allAliveHandledNomination(room) {
    const aliveSeats = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
    return aliveSeats.every((s) => room.nominationsToday.has(s) || room.skippedNominationsToday.has(s));
}
export function skipNomination(room, seatIndex) {
    if (room.phase !== 'day')
        return false;
    if (room.daySubPhase !== 'nomination' && room.daySubPhase !== 'discussion')
        return false;
    if (room.currentNomination !== null)
        return false;
    const p = room.players[seatIndex];
    if (!p?.isAlive)
        return false;
    if (room.nominationsToday.has(seatIndex))
        return false;
    room.skippedNominationsToday.add(seatIndex);
    return true;
}
/** 白天结束：若存在唯一最高票待处决者则处决，否则直接入夜 */
export function maybeFinishDay(room) {
    if (room.phase !== 'day')
        return { ended: false, executedSeatIndex: null };
    if (room.currentNomination !== null)
        return { ended: false, executedSeatIndex: null };
    if (!allAliveHandledNomination(room))
        return { ended: false, executedSeatIndex: null };
    if (room.pendingExecution != null && !room.pendingExecutionTied) {
        const executed = room.pendingExecution;
        execute(room);
        return { ended: true, executedSeatIndex: executed };
    }
    // 平局或无人达到处决条件：今日无人处决，直接入夜
    room.pendingExecution = null;
    room.pendingExecutionVotesFor = 0;
    room.pendingExecutionTied = false;
    room.daySubPhase = 'discussion';
    gotoNight(room);
    return { ended: true, executedSeatIndex: null };
}
/** 发起提名（允许提名自己；处决投票中被提名者亦可自投赞成/反对） */
export function nominate(room, nominatorSeat, nominatedSeat) {
    if (room.daySubPhase !== 'nomination' && room.daySubPhase !== 'discussion')
        return false;
    const nominator = room.players[nominatorSeat];
    const nominated = room.players[nominatedSeat];
    if (!nominator?.isAlive || !nominated?.isAlive)
        return false;
    if (room.nominationsToday.has(nominatorSeat))
        return false;
    if (room.skippedNominationsToday.has(nominatorSeat))
        return false;
    if (room.nominatedToday.has(nominatedSeat))
        return false;
    if (room.currentNomination !== null)
        return false;
    // 处女（Virgin）：首次被提名且提名者真实为镇民时，提名者立即被处决
    // 注意：允许“装作处女/杀手”等玩法，所以任何人都能提名；这里只处理真实处女的效果触发
    const nominatedRealChar = nominated.characterId;
    if (nominatedRealChar === 'virgin') {
        const triggered = getVirginTriggeredSet(room);
        const virginSeat = nominatedSeat;
        const firstTime = !triggered.has(virginSeat);
        const virginWorks = firstTime && !isPoisoned(room, virginSeat);
        const nominatorMeta = getCharacterMeta(room, nominator.characterId);
        const nominatorIsTownsfolk = nominatorMeta?.type === 'townsfolk';
        if (virginWorks && nominatorIsTownsfolk) {
            // 标记已触发
            triggered.add(virginSeat);
            // 提名者立即被处决（算作“处决”，供掘墓人等使用）
            nominator.isAlive = false;
            nominator.hasDeadVote = true;
            room.lastExecutedSeatIndex = nominatorSeat;
            room.lastExecutedCharacterId = nominator.characterId ?? null;
            // 清理当下提名状态（本次提名不进入投票）
            room.daySubPhase = 'discussion';
            room.currentNomination = null;
            room.votes = new Map();
            // 今日也算提名过/被提名过，避免重复刷触发
            room.nominationsToday.set(nominatorSeat, nominatedSeat);
            room.nominatedToday.add(nominatedSeat);
            // 若触发后满足胜利条件，立即结束（白天判定允许即时结束）
            const win = checkWin(room);
            if (win) {
                room.status = 'ended';
                room.phase = 'waiting';
            }
            return true;
        }
    }
    room.daySubPhase = 'nomination';
    room.currentNomination = { nominator: nominatorSeat, nominated: nominatedSeat };
    room.nominationsToday.set(nominatorSeat, nominatedSeat);
    room.nominatedToday.add(nominatedSeat);
    room.votes = new Map();
    return true;
}
/** 投票 */
export function vote(room, seatIndex, inFavor) {
    if (room.currentNomination === null)
        return false;
    const p = room.players[seatIndex];
    if (!p)
        return false;
    // 存活玩家：每次提名都可以投票
    if (p.isAlive) {
        room.votes.set(seatIndex, inFavor);
        return true;
    }
    // 死亡玩家：整局仅一次“幽灵票”
    if (!p.hasDeadVote)
        return false;
    room.votes.set(seatIndex, inFavor);
    // 立刻消耗幽灵票（不允许改票/反悔）
    p.hasDeadVote = false;
    return true;
}
/** 统计投票并判定是否处决 */
export function tallyVotes(room) {
    if (room.currentNomination === null)
        return { passed: false, votesFor: 0, votes: [] };
    const aliveCount = room.players.filter((p) => p.isAlive).length;
    let votesFor = 0;
    room.votes.forEach((v) => { if (v)
        votesFor++; });
    const required = Math.ceil(aliveCount / 2);
    const passed = votesFor >= required;
    if (passed) {
        const nominee = room.currentNomination.nominated;
        if (votesFor > room.pendingExecutionVotesFor) {
            room.pendingExecution = nominee;
            room.pendingExecutionVotesFor = votesFor;
            room.pendingExecutionTied = false;
        }
        else if (votesFor === room.pendingExecutionVotesFor) {
            // 最高票平局：当日无人处决（即使后续不再出现更高票）
            room.pendingExecution = null;
            room.pendingExecutionTied = true;
        }
    }
    const votes = Array.from(room.votes.entries()).map(([seatIndex, inFavor]) => ({ seatIndex, inFavor }));
    room.currentNomination = null;
    return { passed, votesFor, votes };
}
/** 执行处决并进入夜晚或结束 */
export function execute(room) {
    const target = room.pendingExecution;
    if (target == null)
        return;
    const p = room.players[target];
    if (!p)
        return;
    p.isAlive = false;
    // 死亡后的“幽灵票”默认可用；消耗在投票时处理
    p.hasDeadVote = true;
    room.lastExecutedSeatIndex = target;
    room.lastExecutedCharacterId = p.characterId ?? null;
    room.pendingExecution = null;
    room.daySubPhase = 'discussion';
    room.pendingExecutionVotesFor = 0;
    room.pendingExecutionTied = false;
    const win = checkWin(room);
    if (win) {
        room.status = 'ended';
        room.phase = 'waiting';
        return;
    }
    gotoNight(room);
}
/** 检查胜利条件 */
export function checkWin(room) {
    const alive = room.players.filter((p) => p.isAlive);
    const demonAlive = alive.some((p) => p.characterId === 'imp');
    if (!demonAlive)
        return 'good';
    if (alive.length <= 2)
        return 'evil';
    return null;
}
