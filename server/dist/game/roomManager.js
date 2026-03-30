import { v4 as uuidv4 } from 'uuid';
import { troubleBrewing } from '../script/troubleBrewing.js';
const rooms = new Map();
function getScript(scriptId) {
    if (scriptId === troubleBrewing.id)
        return troubleBrewing;
    return troubleBrewing;
}
/** 创建房间 */
export function createRoom(scriptId) {
    const script = getScript(scriptId);
    const room = {
        id: uuidv4(),
        scriptId,
        script,
        players: [],
        status: 'lobby',
        phase: 'waiting',
        dayNumber: 0,
        daySubPhase: null,
        currentNomination: null,
        nominationsToday: new Map(),
        skippedNominationsToday: new Set(),
        nominatedToday: new Set(),
        votes: new Map(),
        pendingExecution: null,
        pendingExecutionVotesFor: 0,
        pendingExecutionTied: false,
        nightStepIndex: 0,
        pendingNightAction: null,
        protectedSeatIndex: null,
        poisonedSeatIndex: null,
        lastExecutedSeatIndex: null,
        lastExecutedCharacterId: null,
        lastNightDeaths: [],
        lastNightRevivals: [],
        demonBluffs: null,
        storytellerDecisions: new Map(),
        connections: new Map(),
        createdAt: Date.now(),
        replayLog: [],
        publicLog: [],
        hostSecret: uuidv4(),
        usedDayActionsBySeat: new Map(),
        nightKillAttackerByVictim: new Map(),
        aiStorytellerEnabled: false,
        aiLastActionAt: 0,
    };
    rooms.set(room.id, room);
    return room;
}
/** 加入房间 */
export function joinRoom(roomId, nickname) {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'lobby')
        return null;
    if (room.players.length >= room.script.maxPlayers)
        return null;
    const seatIndex = room.players.length;
    const player = {
        id: uuidv4(),
        seatIndex,
        nickname,
        isReady: false,
        isAlive: true,
        hasDeadVote: true,
        drunkPretendCharacterId: null,
        usedDayActions: [],
    };
    room.players.push(player);
    return { room, seatIndex };
}
/** 获取房间 */
export function getRoom(roomId) {
    return rooms.get(roomId) ?? null;
}
/** 获取房间视图（脱敏，供前端） */
export function getRoomView(room, _forSeatIndex, includeGlobalLog = false) {
    const players = room.players.map((p) => {
        const { characterId, drunkPretendCharacterId, usedDayActions, ...rest } = p;
        return rest;
    });
    return {
        id: room.id,
        scriptId: room.scriptId,
        scriptName: room.script.name,
        scriptNameZh: room.script.nameZh,
        players,
        status: room.status,
        phase: room.phase,
        dayNumber: room.dayNumber,
        daySubPhase: room.daySubPhase,
        currentNomination: room.currentNomination,
        pendingExecution: room.pendingExecution,
        nominationsToday: Array.from(room.nominationsToday.entries()).map(([nominator, nominated]) => ({ nominator, nominated })),
        skippedNominationsToday: Array.from(room.skippedNominationsToday.values()),
        pendingExecutionVotesFor: room.pendingExecutionVotesFor,
        pendingExecutionTied: room.pendingExecutionTied,
        lastNightDeaths: room.lastNightDeaths,
        lastNightRevivals: room.lastNightRevivals,
        publicLog: room.publicLog,
        globalLog: includeGlobalLog ? room.replayLog : undefined,
        aiStorytellerEnabled: room.aiStorytellerEnabled,
        minPlayers: room.script.minPlayers,
        maxPlayers: room.script.maxPlayers,
    };
}
function resetRoomForNextGame(room) {
    room.status = 'lobby';
    room.phase = 'waiting';
    room.dayNumber = 0;
    room.daySubPhase = null;
    room.currentNomination = null;
    room.nominationsToday = new Map();
    room.skippedNominationsToday = new Set();
    room.nominatedToday = new Set();
    room.votes = new Map();
    room.pendingExecution = null;
    room.pendingExecutionVotesFor = 0;
    room.pendingExecutionTied = false;
    room.nightStepIndex = 0;
    room.pendingNightAction = null;
    room.protectedSeatIndex = null;
    room.poisonedSeatIndex = null;
    room.lastExecutedSeatIndex = null;
    room.lastExecutedCharacterId = null;
    room.lastNightDeaths = [];
    room.lastNightRevivals = [];
    room.demonBluffs = null;
    room.storytellerDecisions = new Map();
    room.replayLog = [];
    room.publicLog = [];
    room.usedDayActionsBySeat = new Map();
    room.nightKillAttackerByVictim = new Map();
    room.aiLastActionAt = 0;
    for (const p of room.players) {
        p.isReady = false;
        p.isAlive = true;
        p.hasDeadVote = true;
        p.characterId = undefined;
        p.drunkPretendCharacterId = null;
        p.usedDayActions = [];
    }
}
/** 准备/取消准备 */
export function setReady(room, seatIndex, ready) {
    const p = room.players[seatIndex];
    if (!p)
        return false;
    // 对局结束后，首次准备会把房间重置回大厅，支持原房间直接开下一局
    if (room.status === 'ended')
        resetRoomForNextGame(room);
    p.isReady = ready;
    return true;
}
/** 绑定连接与座位 */
export function bindConnection(room, connectionId, seatIndex) {
    room.connections.set(connectionId, seatIndex);
}
/** 解绑连接 */
export function unbindConnection(room, connectionId) {
    room.connections.delete(connectionId);
}
export { rooms };
