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
        p.isAlive = true;
        p.hasDeadVote = true;
    });
    if (n >= 7) {
        const inGame = new Set(pool);
        const goodChars = script.characters.filter((c) => c.alignment === 'good' && c.type !== 'demon');
        const notInGame = goodChars.filter((c) => !inGame.has(c.id)).map((c) => c.id);
        shuffle(notInGame);
        room.demonBluffs = notInGame.slice(0, 3);
    }
    else {
        room.demonBluffs = null;
    }
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
    assignRoles(room);
    room.phase = 'first_night';
    room.dayNumber = 0;
    room.nightStepIndex = 0;
    room.lastNightDeaths = [];
    room.lastNightRevivals = [];
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
    const order = getCurrentNightOrder(room);
    if (room.nightStepIndex >= order.length) {
        gotoDay(room);
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
    if (stepId === 'imp') {
        if (!room.storytellerDecisions.has('imp_kill')) {
            const demon = room.players.find((p) => p.characterId === 'imp' && p.isAlive);
            const alive = room.players.filter((p) => p.isAlive && p.seatIndex !== demon?.seatIndex);
            if (alive.length > 0) {
                const target = alive[Math.floor(Math.random() * alive.length)];
                room.storytellerDecisions.set('imp_kill', target.seatIndex);
            }
        }
        runDemonKill(room);
        room.nightStepIndex++;
        return advanceNight(room);
    }
    room.nightStepIndex++;
    return advanceNight(room);
}
function runDemonKill(room) {
    const demon = room.players.find((p) => p.characterId === 'imp' && p.isAlive);
    if (!demon)
        return;
    const decision = room.storytellerDecisions.get('imp_kill');
    if (decision !== undefined) {
        const target = room.players[decision];
        if (target?.isAlive && target.seatIndex !== demon.seatIndex) {
            room.lastNightDeaths.push(decision);
            target.isAlive = false;
        }
    }
}
function gotoDay(room) {
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
export function startNominationPhase(room) {
    room.daySubPhase = 'nomination';
    room.currentNomination = null;
}
/** 发起提名 */
export function nominate(room, nominatorSeat, nominatedSeat) {
    if (room.daySubPhase !== 'nomination' && room.daySubPhase !== 'discussion')
        return false;
    const nominator = room.players[nominatorSeat];
    const nominated = room.players[nominatedSeat];
    if (!nominator?.isAlive || !nominated)
        return false;
    if (room.nominationsToday.has(nominatorSeat))
        return false;
    if (room.nominatedToday.has(nominatedSeat))
        return false;
    if (room.currentNomination !== null)
        return false;
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
    room.votes.set(seatIndex, inFavor);
    return true;
}
/** 统计投票并判定是否处决 */
export function tallyVotes(room) {
    if (room.currentNomination === null)
        return { passed: false, votesFor: 0 };
    const aliveCount = room.players.filter((p) => p.isAlive).length;
    let votesFor = 0;
    room.votes.forEach((v) => { if (v)
        votesFor++; });
    const required = Math.ceil(aliveCount / 2);
    const passed = votesFor >= required;
    if (passed)
        room.pendingExecution = room.currentNomination.nominated;
    room.currentNomination = null;
    return { passed, votesFor };
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
    if (p.hasDeadVote)
        p.hasDeadVote = false;
    room.pendingExecution = null;
    room.daySubPhase = 'discussion';
    const win = checkWin(room);
    if (win) {
        room.status = 'ended';
        room.phase = 'waiting';
        return;
    }
    room.phase = 'night';
    room.nightStepIndex = 0;
    room.lastNightDeaths = [];
    room.lastNightRevivals = [];
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
