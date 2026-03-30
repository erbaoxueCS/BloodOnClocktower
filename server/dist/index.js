import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createRoom, getRoom, joinRoom, getRoomView, setReady, bindConnection, unbindConnection, rooms } from './game/roomManager.js';
import { buildYourRolePayload } from './game/yourRole.js';
import { startGame, advanceNight, getCurrentNightStep, nominate, skipNomination, vote, tallyVotes, maybeFinishDay, submitNightAction, findAliveSeatByCharacter, computeChefPairsForSeat, computeEmpathCountForSeat, formatUndertakerInfoForSeat, formatWasherLibrarianInvestigator, checkWin, getShownCharacterId, distortWasherLibrarianInvestigatorDecision, resolveRavenkeeperNightInfo, finishNightAndGotoDay } from './game/gameEngine.js';
import { getStorytellerDecision } from './ai/storyteller.js';
import { aiPlayerLlmAvailable, decideAiPlayerAction } from './ai/playerAgent.js';
import { pushReplay, buildReplayBundle, seatLabel, pushPublic } from './game/replay.js';
import { troubleBrewing } from './script/troubleBrewing.js';
function normalizeGodQuery(text) {
    return text.trim().replace(/\s+/g, '');
}
function makeDeterministicGodReply(room, seatIndex, queryRaw) {
    const query = normalizeGodQuery(queryRaw);
    const p = room.players[seatIndex];
    if (!p)
        return '上帝：……';
    if (room.status !== 'playing')
        return '上帝：……';
    if (room.phase !== 'night' && room.phase !== 'first_night')
        return '上帝：现在不是夜晚。';
    if (query !== '今晚信息' && query !== '信息' && query !== '今晚' && query !== '结果')
        return '上帝：你现在得不到更多信息。';
    const shown = getShownCharacterId(p);
    if (!shown)
        return '上帝：……';
    if (!p.isAlive)
        return '上帝：你已死亡。';
    if (shown === 'chef') {
        return `厨师：你得知相邻两名邪恶玩家的数量为 ${computeChefPairsForSeat(room, seatIndex)}。`;
    }
    if (shown === 'empath') {
        return `共情者：你得知相邻邪恶玩家数量为 ${computeEmpathCountForSeat(room, seatIndex)}。`;
    }
    if (shown === 'undertaker') {
        return formatUndertakerInfoForSeat(room, seatIndex);
    }
    if (shown === 'washerwoman' || shown === 'librarian' || shown === 'investigator') {
        const decision = room.storytellerDecisions.get(shown);
        if (!decision)
            return `${room.script.characters.find((c) => c.id === shown)?.nameZh ?? shown}：无信息`;
        return formatWasherLibrarianInvestigator(room, shown, decision);
    }
    if (shown === 'ravenkeeper') {
        const msg = resolveRavenkeeperNightInfo(room, seatIndex);
        return msg || '守鸦人：无信息';
    }
    return '上帝：你现在得不到更多信息。';
}
function pushChat(room, entry) {
    const full = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    room.chatLog.push(full);
    if (room.chatLog.length > 500)
        room.chatLog = room.chatLog.slice(-500);
    return full;
}
function broadcastChat(roomId, entry) {
    if (entry.scope === 'god') {
        sendToSeat(roomId, entry.fromSeat, { type: 'chat_event', entry });
        return;
    }
    if (entry.scope === 'dm') {
        sendToSeat(roomId, entry.fromSeat, { type: 'chat_event', entry });
        if (typeof entry.toSeat === 'number')
            sendToSeat(roomId, entry.toSeat, { type: 'chat_event', entry });
        return;
    }
    if (entry.scope === 'public') {
        broadcast(roomId, { type: 'chat_event', entry });
    }
}
const app = express();
app.use(cors());
app.use(express.json());
const HTTP_PORT = 3001;
app.get('/api/scripts', (_req, res) => {
    res.json([{ id: troubleBrewing.id, name: troubleBrewing.name, nameZh: troubleBrewing.nameZh, minPlayers: troubleBrewing.minPlayers, maxPlayers: troubleBrewing.maxPlayers }]);
});
app.post('/api/rooms', (req, res) => {
    const scriptId = req.body?.scriptId || troubleBrewing.id;
    const room = createRoom(scriptId);
    res.json({ roomId: room.id, scriptId: room.scriptId, hostSecret: room.hostSecret });
});
app.post('/api/rooms/:roomId/join', (req, res) => {
    const { roomId } = req.params;
    const nickname = req.body?.nickname || 'Player';
    const result = joinRoom(roomId, nickname);
    if (!result)
        return res.status(400).json({ error: 'Cannot join room' });
    const view = getRoomView(result.room);
    res.json({ roomId, seatIndex: result.seatIndex, playerId: result.room.players[result.seatIndex].id, room: view });
});
app.get('/api/rooms/:roomId', (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room)
        return res.status(404).json({ error: 'Room not found' });
    res.json(getRoomView(room));
});
app.get('/api/storyteller-ai', (_req, res) => {
    const useFlag = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
    const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com').replace(/\/+$/, '');
    res.json({
        enabled: useFlag && !!process.env.OPENAI_API_KEY,
        useAiFlag: useFlag,
        hasApiKey: !!process.env.OPENAI_API_KEY,
        baseUrl,
    });
});
/**
 * 复盘用的「第几夜」与引擎里 dayNumber 对齐方式：
 * - dayNumber 表示「即将进入的 / 当前计数的白昼序号」，首夜开始时为 0，第一次天亮后变为 1（第 1 天）；
 * - 首夜（仅信息、剧本中无恶魔刀人步骤）固定称「首夜」；
 * - 普通夜发生在「第 dayNumber 天」结束之后，按玩家习惯是「第 (dayNumber+1) 夜」（第二次起算即恶魔首次刀人的那一夜）。
 */
function nightReplayTitle(room) {
    if (room.phase === 'first_night')
        return { key: 'first_night', title: '首夜' };
    const nightOrdinal = room.dayNumber + 1;
    return { key: `night_${nightOrdinal}`, title: `第 ${nightOrdinal} 夜` };
}
function dayReplayTitle(room) {
    return { key: `day_${room.dayNumber}`, title: `第 ${room.dayNumber} 天 · 白天` };
}
function sendNightInfo(roomId, room, seatIndex, message) {
    const { key, title } = nightReplayTitle(room);
    pushReplay(room, key, title, `[夜间信息] ${seatLabel(room, seatIndex)}：${message}`);
    const log = getNightInfoLogBySeat(room);
    const prev = log.get(seatIndex) ?? [];
    prev.push(message);
    log.set(seatIndex, prev.slice(-NIGHT_INFO_LOG_LIMIT));
    sendToSeat(roomId, seatIndex, { type: 'night_info', message });
}
function maybeLogDawn(room, phaseBefore) {
    if (phaseBefore !== 'first_night' && phaseBefore !== 'night')
        return;
    /** 正常天亮为 day；夜间结束时若胜负已判则 phase 会变为 waiting，仍需记录天亮公布的死亡 */
    const dawnLike = room.phase === 'day' || (room.status === 'ended' && room.phase === 'waiting');
    if (!dawnLike)
        return;
    const { key, title } = dayReplayTitle(room);
    const dead = room.lastNightDeaths.length > 0
        ? `天亮公布：昨夜死亡 ${room.lastNightDeaths.map((s) => seatLabel(room, s)).join('、')}`
        : '天亮公布：昨夜无人死亡';
    pushReplay(room, key, title, dead);
}
function broadcastAfterNight(roomId, room, phaseBeforeLoop) {
    maybeLogDawn(room, phaseBeforeLoop);
    if (room.status === 'ended') {
        const win = checkWin(room);
        if (win) {
            emitGameOver(roomId, room, win);
        }
        return;
    }
    broadcast(roomId, { type: 'room', room: getRoomView(room) });
    broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
}
function emitGameOver(roomId, room, winner) {
    const k = 'game_over_sent';
    if (room.storytellerDecisions.get(k) === true)
        return;
    room.storytellerDecisions.set(k, true);
    // 下一局默认未准备：避免“结束后所有人都显示已准备”
    for (const p of room.players)
        p.isReady = false;
    pushReplay(room, 'result', '游戏结束', `${winner === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);
    const replay = buildReplayBundle(room, winner);
    broadcast(roomId, { type: 'game_over', winner, room: getRoomView(room), replay });
}
function maybeLogEnterNight(room, phaseBefore) {
    if (room.phase !== 'night' || phaseBefore !== 'day')
        return;
    const { key, title } = nightReplayTitle(room);
    pushReplay(room, key, title, '进入夜晚。');
}
async function runNightLoop(roomId, room) {
    for (;;) {
        if (room.pendingNightAction)
            break;
        if (room.awaitingNightConfirm)
            break;
        const stepId = getCurrentNightStep(room);
        if (!stepId) {
            advanceNight(room);
            if (room.phase === 'day' || room.phase === 'waiting')
                break;
            if (room.awaitingNightConfirm)
                break;
            continue;
        }
        // 信息型步骤：直接向对应玩家发送信息，并推进一步
        if (stepId === 'chef') {
            const seat = findAliveSeatByCharacter(room, 'chef');
            if (seat != null)
                sendNightInfo(roomId, room, seat, `厨师：你得知相邻两名邪恶玩家的数量为 ${computeChefPairsForSeat(room, seat)}。`);
            room.nightStepIndex++;
            continue;
        }
        if (stepId === 'empath') {
            const seat = findAliveSeatByCharacter(room, 'empath');
            if (seat != null)
                sendNightInfo(roomId, room, seat, `共情者：你得知相邻邪恶玩家数量为 ${computeEmpathCountForSeat(room, seat)}。`);
            room.nightStepIndex++;
            continue;
        }
        if (stepId === 'undertaker') {
            const seat = findAliveSeatByCharacter(room, 'undertaker');
            if (seat != null)
                sendNightInfo(roomId, room, seat, formatUndertakerInfoForSeat(room, seat));
            room.nightStepIndex++;
            continue;
        }
        if (stepId === 'ravenkeeper') {
            for (const vSeat of room.lastNightDeaths) {
                if (room.players[vSeat]?.characterId !== 'ravenkeeper')
                    continue;
                const msg = resolveRavenkeeperNightInfo(room, vSeat);
                if (msg)
                    sendNightInfo(roomId, room, vSeat, msg);
            }
            room.nightStepIndex++;
            continue;
        }
        // 说书人裁量型：洗衣妇/图书管理员/调查员 —— USE_AI_STORYTELLER + OPENAI_API_KEY 时走 AI，否则随机；中毒/醉酒仍由引擎失真
        if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
            const seat = findAliveSeatByCharacter(room, stepId);
            const stepNameZh = room.script.characters.find((c) => c.id === stepId)?.nameZh ?? stepId;
            const raw = (await getStorytellerDecision(room, stepId, stepNameZh, room.aiStorytellerEnabled));
            let decision = raw;
            if (seat != null && raw && Array.isArray(raw.players) && raw.players.length === 2 && typeof raw.characterId === 'string') {
                decision = distortWasherLibrarianInvestigatorDecision(room, seat, { players: raw.players, characterId: raw.characterId });
            }
            room.storytellerDecisions.set(stepId, decision);
            if (seat != null)
                sendNightInfo(roomId, room, seat, formatWasherLibrarianInvestigator(room, stepId, decision));
            room.nightStepIndex++;
            continue;
        }
        // 其余步骤交给引擎推进（会在需要行动时设置 pendingNightAction）
        advanceNight(room);
        if (room.phase === 'day' || room.phase === 'waiting')
            break;
        if (room.pendingNightAction)
            break;
        if (room.awaitingNightConfirm)
            break;
    }
}
const server = createServer(app);
const wss = new WebSocketServer({ server });
async function handleDayMaybeEnterNight(roomId, room, phaseBefore, executedSeatIndex) {
    if (room.status === 'ended') {
        const win = checkWin(room);
        if (win)
            emitGameOver(roomId, room, win);
        return;
    }
    const { key, title } = dayReplayTitle(room);
    if (executedSeatIndex != null) {
        pushReplay(room, key, title, `处决执行：${seatLabel(room, executedSeatIndex)} 死亡。`);
        pushPublic(room, `处决执行：${seatLabel(room, executedSeatIndex)} 死亡。`);
    }
    else {
        pushReplay(room, key, title, '今日无人被处决。');
        pushPublic(room, '今日无人被处决。');
    }
    maybeLogEnterNight(room, phaseBefore);
    if (room.phase === 'night')
        pushPublic(room, '进入夜晚。');
    const phaseBeforeLoop = room.phase;
    await runNightLoop(roomId, room);
    if (room.phase !== 'waiting')
        sendNightPrompt(roomId, room);
    broadcastAfterNight(roomId, room, phaseBeforeLoop);
    broadcastNightConfirm(roomId, room);
}
function maybeAiTakeoverDay(roomId, room) {
    if (room.phase !== 'day' || room.status !== 'playing')
        return;
    const now = Date.now();
    if (now - room.aiLastActionAt < 2400)
        return;
    const { key, title } = dayReplayTitle(room);
    if (room.daySubPhase === 'nomination') {
        if (!room.currentNomination)
            return;
        // 仅主持“结束投票并结算”，不替玩家投票或发起提名。
        // 严格要求：所有可投票玩家都完成选择后，才结束投票。
        const eligibleVoters = room.players.filter((p) => p.isAlive || p.hasDeadVote).map((p) => p.seatIndex);
        const allVoted = eligibleVoters.every((seat) => room.votes.has(seat));
        if (!allVoted)
            return;
        if (now - room.aiLastActionAt < 9000)
            return;
        const { passed, votesFor, votes } = tallyVotes(room);
        const voteLines = votes.map((v) => `${seatLabel(room, v.seatIndex)}：${v.inFavor ? '赞成' : '反对'}`).join('；');
        pushReplay(room, key, title, `AI 说书人：结束本次投票并结算，${passed ? '达到处决条件' : '未达到处决条件'}（赞成 ${votesFor} 票）。票型：${voteLines || '（无人投票记录）'}`);
        pushPublic(room, `AI 说书人：结束本次投票并结算，${passed ? '达到处决条件' : '未达到处决条件'}（赞成 ${votesFor} 票）。`);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        broadcast(roomId, { type: 'vote_result', passed, votesFor, votes });
        room.aiLastActionAt = now;
        const phaseBefore = room.phase;
        const fin = maybeFinishDay(room);
        if (fin.ended) {
            void handleDayMaybeEnterNight(roomId, room, phaseBefore, fin.executedSeatIndex);
            return;
        }
        return;
    }
}
async function maybeAiTakeoverNight(roomId, room) {
    if (room.status !== 'playing' || (room.phase !== 'night' && room.phase !== 'first_night'))
        return;
    // 严格边界：夜晚若轮到玩家行动，AI 说书人只等待，不代替玩家提交目标
    if (room.pendingNightAction)
        return;
    if (room.awaitingNightConfirm)
        return;
    const phaseBeforeLoop = room.phase;
    await runNightLoop(roomId, room);
    // runNightLoop 可能推进到“等待玩家输入”的步骤，此时只负责发提示，不做代操作
    sendNightPrompt(roomId, room);
    broadcastAfterNight(roomId, room, phaseBeforeLoop);
    broadcastNightConfirm(roomId, room);
}
function broadcast(roomId, payload, excludeConnectionId) {
    const room = getRoom(roomId);
    if (!room)
        return;
    wss.clients?.forEach((ws) => {
        if (ws.roomId !== roomId || ws.connectionId === excludeConnectionId || ws.readyState !== 1)
            return;
        let p = payload;
        if (payload && typeof payload === 'object') {
            const type = payload.type;
            const seatIndex = ws.seatIndex;
            if (typeof seatIndex === 'number' && (type === 'room' || type === 'game_over') && payload.room) {
                const yourCharacterId = getShownCharacterId(room.players[seatIndex]);
                const yourRole = buildYourRolePayload(room, seatIndex);
                p = {
                    ...payload,
                    room: getRoomView(room, seatIndex, false),
                    yourCharacterId,
                    yourRole,
                    yourSeatIndex: seatIndex,
                    isHost: !!ws.isHost,
                };
            }
            else if ((type === 'room' || type === 'game_over') && payload.room && ws.isAdmin) {
                p = {
                    ...payload,
                    room: getRoomView(room, undefined, true),
                    isHost: !!ws.isHost,
                    isAdmin: true,
                };
            }
        }
        ws.send(JSON.stringify(p));
    });
}
function sendToSeat(roomId, seatIndex, payload) {
    const room = getRoom(roomId);
    if (!room)
        return;
    wss.clients?.forEach((ws) => {
        if (ws.roomId !== roomId || ws.readyState !== 1)
            return;
        if (ws.seatIndex !== seatIndex)
            return;
        let p = payload;
        if (payload && typeof payload === 'object' && payload.type === 'room' && payload.room) {
            const yourCharacterId = getShownCharacterId(room.players[seatIndex]);
            const yourRole = buildYourRolePayload(room, seatIndex);
            p = { ...payload, yourCharacterId, yourRole, yourSeatIndex: seatIndex, isHost: !!ws.isHost };
        }
        ws.send(JSON.stringify(p));
    });
}
function sendNightPrompt(roomId, room) {
    if (!room.pendingNightAction)
        return;
    const a = room.pendingNightAction;
    sendToSeat(roomId, a.actorSeatIndex, {
        type: 'night_prompt',
        stepId: a.stepId,
        actorSeatIndex: a.actorSeatIndex,
        pick: a.pick,
        aliveSeatIndices: room.players.filter((p) => p.isAlive).map((p) => p.seatIndex),
    });
}
function broadcastNightConfirm(roomId, room) {
    broadcast(roomId, {
        type: 'night_confirm_update',
        awaiting: room.awaitingNightConfirm,
        confirmedSeats: Array.from(room.nightConfirmations.values()),
    });
}
const NIGHT_INFO_LOG_LIMIT = 20;
function getNightInfoLogBySeat(room) {
    const k = 'night_info_log_by_seat';
    const v = room.storytellerDecisions.get(k);
    if (v instanceof Map)
        return v;
    const m = new Map();
    room.storytellerDecisions.set(k, m);
    return m;
}
function getAiSharedNightInfoSet(room) {
    const k = 'ai_shared_nightinfo_marks';
    const v = room.storytellerDecisions.get(k);
    if (v instanceof Set)
        return v;
    const s = new Set();
    room.storytellerDecisions.set(k, s);
    return s;
}
function shareAiNightInfoAtDawn(roomId, room) {
    if (room.status !== 'playing' || room.phase !== 'day')
        return;
    const log = getNightInfoLogBySeat(room);
    const marks = getAiSharedNightInfoSet(room);
    for (const p of room.players) {
        const seatIndex = p.seatIndex;
        if (!(room.aiPlayerEnabledBySeat.get(seatIndex) ?? false))
            continue;
        const key = `day_${room.dayNumber}_seat_${seatIndex}`;
        if (marks.has(key))
            continue;
        const msgs = log.get(seatIndex) ?? [];
        if (msgs.length === 0)
            continue;
        const last = msgs[msgs.length - 1];
        const temp = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
        // 公开分享：以“公开发言”的形式发到公屏，避免与真人行为产生可观察差异；并按温度控制积极程度
        if (Math.random() < temp) {
            pushPublic(room, `公开发言：${seatLabel(room, seatIndex)}：${last}`);
            const entry = pushChat(room, { at: Date.now(), scope: 'public', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: last });
            broadcastChat(roomId, entry);
        }
        marks.add(key);
    }
    broadcast(roomId, { type: 'room', room: getRoomView(room) });
}
function sendEvilInfo(roomId, room) {
    const evilSeats = room.players.filter((p) => p.isAlive && (p.characterId === 'imp' || ['poisoner', 'spy', 'baron', 'scarlet_woman'].includes(p.characterId ?? ''))).map((p) => p.seatIndex);
    const demonSeat = room.players.find((p) => p.isAlive && p.characterId === 'imp')?.seatIndex ?? null;
    const { key, title } = nightReplayTitle(room);
    // 简化：互相告知座位号（不告知具体身份）
    for (const s of evilSeats) {
        const isDemon = s === demonSeat;
        const message = isDemon
            ? `你是恶魔。你的爪牙座位号：${evilSeats.filter((x) => x !== s).map((x) => `#${x + 1}`).join('、') || '无'}。不在场善良身份：${room.demonBluffs?.join(',') || '无'}`
            : `你是爪牙。恶魔座位号：${demonSeat != null ? `#${demonSeat + 1}` : '未知'}。其他邪恶座位号：${evilSeats.filter((x) => x !== s).map((x) => `#${x + 1}`).join('、') || '无'}`;
        pushReplay(room, key, title, `[邪恶私密] ${seatLabel(room, s)}：${message}`);
        sendToSeat(roomId, s, { type: 'night_info', message });
    }
}
wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', `http://localhost`);
    const roomId = url.searchParams.get('roomId');
    const seatIndexStr = url.searchParams.get('seatIndex');
    const hostSecret = url.searchParams.get('hostSecret');
    const adminMode = url.searchParams.get('admin') === '1';
    const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ws.connectionId = connectionId;
    ws.roomId = roomId;
    ws.seatIndex = seatIndexStr !== null ? parseInt(seatIndexStr, 10) : null;
    ws.isHost = false;
    ws.isAdmin = adminMode;
    if (!roomId || (!adminMode && seatIndexStr === null)) {
        ws.send(JSON.stringify({ type: 'error', message: 'roomId required; seatIndex required unless admin=1' }));
        ws.close();
        return;
    }
    const room = getRoom(roomId);
    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        ws.close();
        return;
    }
    if (hostSecret && hostSecret === room.hostSecret)
        ws.isHost = true;
    if (!adminMode) {
        const siStr = seatIndexStr;
        bindConnection(room, connectionId, parseInt(siStr, 10));
        const si = parseInt(siStr, 10);
        ws.send(JSON.stringify({
            type: 'room',
            room: getRoomView(room),
            yourSeatIndex: si,
            yourCharacterId: getShownCharacterId(room.players[si]),
            yourRole: buildYourRolePayload(room, si),
            isHost: ws.isHost,
            isAdmin: false,
        }));
    }
    else {
        ws.send(JSON.stringify({
            type: 'room',
            room: getRoomView(room, undefined, true),
            isHost: ws.isHost,
            isAdmin: true,
        }));
    }
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const room = getRoom(roomId);
            if (!room)
                return;
            const seatIndex = seatIndexStr !== null ? parseInt(seatIndexStr, 10) : -1;
            const isHost = !!ws.isHost;
            const isAdmin = !!ws.isAdmin;
            if (msg.type === 'toggle_ai_player') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_toggle_ai_player' }));
                    return;
                }
                if (room.status !== 'playing') {
                    ws.send(JSON.stringify({ type: 'error', message: 'toggle_ai_player_not_allowed' }));
                    return;
                }
                const enabled = !!msg.enabled;
                room.aiPlayerEnabledBySeat.set(seatIndex, enabled);
                room.aiPlayerLastActionAtBySeat.set(seatIndex, 0);
                if (enabled && !room.aiPlayerTemperatureBySeat.has(seatIndex))
                    room.aiPlayerTemperatureBySeat.set(seatIndex, 0.5);
                const tip = enabled ? `AI 托管已开启：${seatLabel(room, seatIndex)}。` : `AI 托管已关闭：${seatLabel(room, seatIndex)}。`;
                pushPublic(room, tip);
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                return;
            }
            if (msg.type === 'set_ai_player_temperature') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_set_ai_player_temperature' }));
                    return;
                }
                if (room.status !== 'playing') {
                    ws.send(JSON.stringify({ type: 'error', message: 'set_ai_player_temperature_not_allowed' }));
                    return;
                }
                const t = Number(msg.temperature);
                if (!Number.isFinite(t) || t < 0 || t > 1) {
                    ws.send(JSON.stringify({ type: 'error', message: 'invalid_ai_player_temperature' }));
                    return;
                }
                room.aiPlayerTemperatureBySeat.set(seatIndex, t);
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                return;
            }
            if (msg.type === 'chat_send') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_chat_send' }));
                    return;
                }
                if (room.status !== 'playing') {
                    ws.send(JSON.stringify({ type: 'error', message: 'chat_not_allowed' }));
                    return;
                }
                const text = String(msg.text ?? '').trim();
                if (!text) {
                    ws.send(JSON.stringify({ type: 'error', message: 'chat_empty' }));
                    return;
                }
                if (text.length > 500) {
                    ws.send(JSON.stringify({ type: 'error', message: 'chat_too_long' }));
                    return;
                }
                if (msg.scope === 'dm') {
                    const toSeat = msg.toSeat;
                    if (!Number.isInteger(toSeat)) {
                        ws.send(JSON.stringify({ type: 'error', message: 'chat_dm_missing_toSeat' }));
                        return;
                    }
                    if (toSeat === seatIndex) {
                        ws.send(JSON.stringify({ type: 'error', message: 'chat_dm_to_self' }));
                        return;
                    }
                    if (!room.players[toSeat]) {
                        ws.send(JSON.stringify({ type: 'error', message: 'chat_dm_invalid_toSeat' }));
                        return;
                    }
                    const entry = pushChat(room, {
                        at: Date.now(),
                        scope: 'dm',
                        phase: room.phase,
                        dayNumber: room.dayNumber,
                        fromSeat: seatIndex,
                        toSeat: toSeat,
                        text,
                    });
                    broadcastChat(roomId, entry);
                    return;
                }
                if (msg.scope === 'god') {
                    const entry = pushChat(room, {
                        at: Date.now(),
                        scope: 'god',
                        phase: room.phase,
                        dayNumber: room.dayNumber,
                        fromSeat: seatIndex,
                        text,
                    });
                    broadcastChat(roomId, entry);
                    const replyText = makeDeterministicGodReply(room, seatIndex, text);
                    const reply = pushChat(room, {
                        at: Date.now(),
                        scope: 'god',
                        phase: room.phase,
                        dayNumber: room.dayNumber,
                        fromSeat: seatIndex,
                        text: replyText,
                    });
                    broadcastChat(roomId, reply);
                    return;
                }
                if (msg.scope === 'public') {
                    const entry = pushChat(room, {
                        at: Date.now(),
                        scope: 'public',
                        phase: room.phase,
                        dayNumber: room.dayNumber,
                        fromSeat: seatIndex,
                        text,
                    });
                    // 公开屏幕交流：写入 publicLog（公共大屏），并广播 chat_event
                    pushPublic(room, `公开发言：${seatLabel(room, seatIndex)}：${text}`);
                    broadcastChat(roomId, entry);
                    broadcast(roomId, { type: 'room', room: getRoomView(room) });
                    return;
                }
                ws.send(JSON.stringify({ type: 'error', message: 'chat_unknown_scope' }));
                return;
            }
            if (msg.type === 'night_confirm') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_night_confirm' }));
                    return;
                }
                if (room.status !== 'playing' || (room.phase !== 'night' && room.phase !== 'first_night')) {
                    ws.send(JSON.stringify({ type: 'error', message: 'night_confirm_not_in_night' }));
                    return;
                }
                if (!room.awaitingNightConfirm) {
                    ws.send(JSON.stringify({ type: 'error', message: 'night_confirm_not_waiting' }));
                    return;
                }
                room.nightConfirmations.add(seatIndex);
                broadcastNightConfirm(roomId, room);
                if (room.nightConfirmations.size >= room.players.length) {
                    // 全员确认后才天亮
                    const { key, title } = nightReplayTitle(room);
                    pushReplay(room, key, title, '全员确认夜晚结束，天亮。');
                    pushPublic(room, '全员确认夜晚结束，天亮。');
                    finishNightAndGotoDay(room);
                    if (checkWin(room)) {
                        const win = checkWin(room);
                        if (win)
                            emitGameOver(roomId, room, win);
                        return;
                    }
                    shareAiNightInfoAtDawn(roomId, room);
                    broadcast(roomId, { type: 'room', room: getRoomView(room) });
                    broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
                }
                return;
            }
            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }
            if (msg.type === 'toggle_ai_storyteller') {
                if (!isHost) {
                    ws.send(JSON.stringify({ type: 'error', message: 'host_only:toggle_ai_storyteller' }));
                    return;
                }
                room.aiStorytellerEnabled = !!msg.enabled;
                room.aiLastActionAt = 0;
                const tip = room.aiStorytellerEnabled ? 'AI 说书人已接管流程。' : 'AI 说书人已关闭，切回人工控制。';
                const section = room.phase === 'day' ? dayReplayTitle(room) : nightReplayTitle(room);
                pushReplay(room, section.key, section.title, tip);
                pushPublic(room, tip);
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                return;
            }
            if (msg.type === 'ready') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_ready' }));
                    return;
                }
                setReady(room, seatIndex, msg.ready);
                // 需要回推给发起者，否则其 UI 不会更新 ready 状态
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                return;
            }
            if (msg.type === 'start') {
                if (!isHost) {
                    ws.send(JSON.stringify({ type: 'error', message: 'host_only:start' }));
                    return;
                }
                const ok = startGame(room);
                if (!ok) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Cannot start game' }));
                    return;
                }
                pushReplay(room, 'setup', '对局', `游戏开始：${room.players.length} 人，剧本「${room.script.nameZh}」。`);
                pushPublic(room, `游戏开始：${room.players.length} 人，剧本「${room.script.nameZh}」。`);
                pushReplay(room, 'first_night', '首夜', '进入首夜。');
                pushReplay(room, 'first_night', '首夜', '本夜仅有信息步骤（剧本：无恶魔杀人）；恶魔首次刀人在下一普通夜。');
                const phaseBeforeLoop = room.phase;
                await runNightLoop(roomId, room);
                if (room.status !== 'ended') {
                    if (room.phase === 'first_night') {
                        sendEvilInfo(roomId, room);
                    }
                    sendNightPrompt(roomId, room);
                }
                broadcastAfterNight(roomId, room, phaseBeforeLoop);
                broadcastNightConfirm(roomId, room);
                return;
            }
            if (msg.type === 'nominate') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_nominate' }));
                    return;
                }
                const ok = nominate(room, seatIndex, msg.nominatedSeat);
                if (!ok) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Nomination not allowed' }));
                    return;
                }
                const { key, title } = dayReplayTitle(room);
                pushReplay(room, key, title, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, msg.nominatedSeat)}。`);
                pushPublic(room, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, msg.nominatedSeat)}。`);
                // 处女可能导致“提名者立刻被处决”
                if (!room.players[seatIndex]?.isAlive) {
                    pushReplay(room, key, title, `处女触发：提名者 ${seatLabel(room, seatIndex)} 立即被处决。`);
                    pushPublic(room, `处女触发：提名者 ${seatLabel(room, seatIndex)} 立即被处决。`);
                    if (room.status === 'ended') {
                        const win = checkWin(room);
                        if (win) {
                            pushReplay(room, 'result', '游戏结束', `${win === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);
                            pushPublic(room, `游戏结束：${win === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);
                            const replay = buildReplayBundle(room, win);
                            broadcast(roomId, { type: 'game_over', winner: win, room: getRoomView(room), replay });
                            return;
                        }
                    }
                }
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                return;
            }
            if (msg.type === 'skip_nomination') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_skip_nomination' }));
                    return;
                }
                const ok = skipNomination(room, seatIndex);
                if (!ok) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Skip nomination not allowed' }));
                    return;
                }
                const { key, title } = dayReplayTitle(room);
                pushReplay(room, key, title, `${seatLabel(room, seatIndex)} 选择本轮不提名。`);
                pushPublic(room, `${seatLabel(room, seatIndex)} 选择本轮不提名。`);
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                const phaseBefore = room.phase;
                const fin = maybeFinishDay(room);
                if (fin.ended) {
                    await handleDayMaybeEnterNight(roomId, room, phaseBefore, fin.executedSeatIndex);
                    return;
                }
                return;
            }
            if (msg.type === 'vote') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_vote' }));
                    return;
                }
                vote(room, seatIndex, msg.inFavor);
                // 自动结束投票：所有可投票玩家都完成选择后立即结算
                if (room.currentNomination) {
                    const eligibleVoters = room.players.filter((p) => p.isAlive || p.hasDeadVote).map((p) => p.seatIndex);
                    const allVoted = eligibleVoters.every((s) => room.votes.has(s));
                    if (allVoted) {
                        const { passed, votesFor, votes } = tallyVotes(room);
                        const { key, title } = dayReplayTitle(room);
                        const voteLines = votes.map((v) => `${seatLabel(room, v.seatIndex)}：${v.inFavor ? '赞成' : '反对'}`).join('；');
                        pushReplay(room, key, title, `投票结束：${passed ? '达到处决条件（已标记待处决）' : '未达到处决条件'}（赞成 ${votesFor} 票）。票型：${voteLines || '（无人投票记录）'}`);
                        pushPublic(room, `投票结束：${passed ? '达到处决条件（已标记待处决）' : '未达到处决条件'}（赞成 ${votesFor} 票）。`);
                        broadcast(roomId, { type: 'vote_result', passed, votesFor, votes });
                    }
                }
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                const phaseBefore = room.phase;
                const fin = maybeFinishDay(room);
                if (fin.ended) {
                    await handleDayMaybeEnterNight(roomId, room, phaseBefore, fin.executedSeatIndex);
                    return;
                }
                return;
            }
            if (msg.type === 'day_action') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_day_action' }));
                    return;
                }
                if (room.status !== 'playing' || room.phase !== 'day') {
                    ws.send(JSON.stringify({ type: 'error', message: 'day_action_not_allowed' }));
                    return;
                }
                const actor = room.players[seatIndex];
                if (!actor?.isAlive) {
                    ws.send(JSON.stringify({ type: 'error', message: 'day_action_actor_not_alive' }));
                    return;
                }
                const { key, title } = dayReplayTitle(room);
                if (msg.actionId === 'slayer_shot') {
                    const targetSeat = msg.targetSeat;
                    if (!Number.isInteger(targetSeat)) {
                        ws.send(JSON.stringify({ type: 'error', message: 'day_action_invalid_target' }));
                        return;
                    }
                    const target = room.players[targetSeat];
                    if (!target?.isAlive) {
                        ws.send(JSON.stringify({ type: 'error', message: 'day_action_target_not_alive' }));
                        return;
                    }
                    const used = room.usedDayActionsBySeat.get(seatIndex) ?? new Set();
                    if (used.has('slayer_shot')) {
                        ws.send(JSON.stringify({ type: 'error', message: 'day_action_limit_reached:slayer_shot' }));
                        return;
                    }
                    // 所有人都可以“宣称发动”，但只有真实杀手且未中毒/醉酒且未使用过才会生效
                    pushReplay(room, key, title, `[白天技能] ${seatLabel(room, seatIndex)} 宣称自己是「杀手」并向 ${seatLabel(room, targetSeat)} 开枪。`);
                    pushPublic(room, `${seatLabel(room, seatIndex)} 宣称自己是「杀手」并向 ${seatLabel(room, targetSeat)} 开枪。`);
                    used.add('slayer_shot');
                    room.usedDayActionsBySeat.set(seatIndex, used);
                    const isRealSlayer = room.players[seatIndex]?.characterId === 'slayer';
                    const canWork = isRealSlayer && room.poisonedSeatIndex !== seatIndex && room.players[seatIndex]?.characterId !== 'drunk';
                    if (canWork && room.players[targetSeat]?.characterId === 'imp') {
                        room.players[targetSeat].isAlive = false;
                        pushReplay(room, key, title, `枪击命中：${seatLabel(room, targetSeat)}（恶魔）死亡。`);
                        pushPublic(room, `枪击命中：${seatLabel(room, targetSeat)} 死亡。`);
                        const win = checkWin(room);
                        if (win) {
                            room.status = 'ended';
                            room.phase = 'waiting';
                            pushReplay(room, 'result', '游戏结束', `${win === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);
                            pushPublic(room, `游戏结束：${win === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);
                            const replay = buildReplayBundle(room, win);
                            broadcast(roomId, { type: 'game_over', winner: win, room: getRoomView(room), replay });
                            return;
                        }
                    }
                    else {
                        pushReplay(room, key, title, '枪击结果：无事发生。');
                        pushPublic(room, '枪击结果：无事发生。');
                    }
                    broadcast(roomId, { type: 'room', room: getRoomView(room) });
                    return;
                }
                ws.send(JSON.stringify({ type: 'error', message: 'day_action_unknown' }));
                return;
            }
            if (msg.type === 'night_action') {
                if (isAdmin) {
                    ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_night_action' }));
                    return;
                }
                const pendingBefore = room.pendingNightAction;
                const targets = msg.targets ?? [];
                const result = submitNightAction(room, seatIndex, targets);
                if (!result.ok) {
                    ws.send(JSON.stringify({ type: 'error', message: `night_action_failed:${result.error ?? 'unknown'}` }));
                    sendNightPrompt(roomId, room);
                    return;
                }
                if (pendingBefore) {
                    const { key, title } = nightReplayTitle(room);
                    if (pendingBefore.stepId === 'imp' && targets[0] !== undefined) {
                        pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（恶魔）选择杀害 ${seatLabel(room, targets[0])}。`);
                    }
                    else if (pendingBefore.stepId === 'monk' && targets[0] !== undefined) {
                        pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（僧侣）选择保护 ${seatLabel(room, targets[0])}。`);
                    }
                    else if (pendingBefore.stepId === 'poisoner' && targets[0] !== undefined) {
                        pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（投毒者）选择毒害 ${seatLabel(room, targets[0])}。`);
                    }
                    else if (pendingBefore.stepId === 'fortune_teller' && targets.length === 2) {
                        pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（占卜师）选择查验 ${seatLabel(room, targets[0])} 与 ${seatLabel(room, targets[1])}。`);
                    }
                }
                if (result.info) {
                    const { key, title } = nightReplayTitle(room);
                    pushReplay(room, key, title, `[夜间信息] ${seatLabel(room, seatIndex)}：${result.info}`);
                    sendToSeat(roomId, seatIndex, { type: 'night_info', message: result.info });
                }
                // 夜晚继续推进直到下一次需要输入或天亮
                const phaseBeforeLoop = room.phase;
                await runNightLoop(roomId, room);
                // 若已结束（phase=waiting），不再提示夜晚行动
                if (room.phase !== 'waiting')
                    sendNightPrompt(roomId, room);
                broadcastAfterNight(roomId, room, phaseBeforeLoop);
                broadcastNightConfirm(roomId, room);
                return;
            }
        }
        catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
    });
    ws.on('close', () => {
        const room = getRoom(roomId ?? '');
        if (room && !ws.isAdmin)
            unbindConnection(room, connectionId);
    });
});
server.listen(HTTP_PORT, () => {
    console.log(`HTTP + WS server on http://localhost:${HTTP_PORT}`);
});
setInterval(async () => {
    for (const [rid, room] of rooms.entries()) {
        if (room.status !== 'playing')
            continue;
        if (room.aiStorytellerEnabled) {
            if (room.phase === 'day')
                maybeAiTakeoverDay(rid, room);
            else if (room.phase === 'night' || room.phase === 'first_night')
                await maybeAiTakeoverNight(rid, room);
        }
        // AI 玩家托管：每座位独立节流与上下文（严格隔离）
        for (const p of room.players) {
            const seatIndex = p.seatIndex;
            if (!(room.aiPlayerEnabledBySeat.get(seatIndex) ?? false))
                continue;
            // 确定性兜底：避免 AI 沉默导致流程卡死
            // 1) 夜晚等待确认：AI 玩家自动确认
            if (room.awaitingNightConfirm && (room.phase === 'night' || room.phase === 'first_night')) {
                if (!room.nightConfirmations.has(seatIndex)) {
                    room.nightConfirmations.add(seatIndex);
                    broadcastNightConfirm(rid, room);
                    if (room.nightConfirmations.size >= room.players.length) {
                        const { key, title } = nightReplayTitle(room);
                        pushReplay(room, key, title, '全员确认夜晚结束，天亮。');
                        pushPublic(room, '全员确认夜晚结束，天亮。');
                        finishNightAndGotoDay(room);
                        if (checkWin(room)) {
                            const win = checkWin(room);
                            if (win)
                                emitGameOver(rid, room, win);
                            continue;
                        }
                        shareAiNightInfoAtDawn(rid, room);
                        broadcast(rid, { type: 'room', room: getRoomView(room) });
                        broadcast(rid, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
                    }
                }
                continue;
            }
            // 2) 夜晚轮到该 AI 玩家行动：自动随机选目标提交
            if (room.pendingNightAction && room.pendingNightAction.actorSeatIndex === seatIndex) {
                const pendingBefore = room.pendingNightAction;
                const pick = room.pendingNightAction.pick;
                const alive = room.players.filter((x) => x.isAlive).map((x) => x.seatIndex);
                const targets = [];
                for (let i = 0; i < pick; i++) {
                    const remain = alive.filter((s) => !targets.includes(s));
                    if (remain.length === 0)
                        break;
                    targets.push(remain[Math.floor(Math.random() * remain.length)]);
                }
                if (targets.length === pick) {
                    const result = submitNightAction(room, seatIndex, targets);
                    if (result.ok) {
                        if (pendingBefore) {
                            const { key, title } = nightReplayTitle(room);
                            if (pendingBefore.stepId === 'imp' && targets[0] !== undefined) {
                                pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（恶魔）选择杀害 ${seatLabel(room, targets[0])}。`);
                            }
                            else if (pendingBefore.stepId === 'monk' && targets[0] !== undefined) {
                                pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（僧侣）选择保护 ${seatLabel(room, targets[0])}。`);
                            }
                            else if (pendingBefore.stepId === 'poisoner' && targets[0] !== undefined) {
                                pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（投毒者）选择毒害 ${seatLabel(room, targets[0])}。`);
                            }
                            else if (pendingBefore.stepId === 'fortune_teller' && targets.length === 2) {
                                pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（占卜师）选择查验 ${seatLabel(room, targets[0])} 与 ${seatLabel(room, targets[1])}。`);
                            }
                        }
                        if (result.info)
                            sendToSeat(rid, seatIndex, { type: 'night_info', message: result.info });
                        const phaseBeforeLoop = room.phase;
                        await runNightLoop(rid, room);
                        if (room.phase !== 'waiting')
                            sendNightPrompt(rid, room);
                        broadcastAfterNight(rid, room, phaseBeforeLoop);
                        broadcastNightConfirm(rid, room);
                    }
                }
                continue;
            }
            // 3) 白天提名阶段：若该 AI 玩家尚未做出“提名/不提名”，则自动进行一次操作，保证白天可结束
            if (room.phase === 'day' && room.daySubPhase === 'nomination' && room.currentNomination === null) {
                const me = room.players[seatIndex];
                const decided = room.nominationsToday.has(seatIndex) || room.skippedNominationsToday.has(seatIndex);
                if (me?.isAlive && !decided) {
                    // 优先随机提名一名存活玩家（含自己），若无法提名则不提名
                    const alive = room.players.filter((x) => x.isAlive).map((x) => x.seatIndex);
                    const pick = alive[Math.floor(Math.random() * alive.length)];
                    const ok = typeof pick === 'number' ? nominate(room, seatIndex, pick) : false;
                    if (ok) {
                        const { key, title } = dayReplayTitle(room);
                        pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）提名 ${seatLabel(room, pick)}。`);
                        pushPublic(room, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, pick)}。`);
                        broadcast(rid, { type: 'room', room: getRoomView(room) });
                    }
                    else {
                        const ok2 = skipNomination(room, seatIndex);
                        if (ok2) {
                            const { key, title } = dayReplayTitle(room);
                            pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）选择本轮不提名。`);
                            pushPublic(room, `${seatLabel(room, seatIndex)} 选择本轮不提名。`);
                            broadcast(rid, { type: 'room', room: getRoomView(room) });
                            const phaseBefore = room.phase;
                            const fin = maybeFinishDay(room);
                            if (fin.ended)
                                await handleDayMaybeEnterNight(rid, room, phaseBefore, fin.executedSeatIndex);
                        }
                    }
                    continue;
                }
            }
            // 4) 白天投票：若当前有提名且该 AI 玩家可投票但尚未投，则自动投票
            if (room.phase === 'day' && room.currentNomination) {
                const me = room.players[seatIndex];
                const canVote = !!me && (me.isAlive || me.hasDeadVote);
                if (canVote && !room.votes.has(seatIndex)) {
                    // 若已配置大模型，则交给大模型决策，避免“生硬随机票”
                    if (aiPlayerLlmAvailable()) {
                        // 继续走后面的 LLM 决策分支
                    }
                    else {
                        // 兜底启发式：被提名者默认反对；其他人默认反对（保守），避免轻易过半
                        const inFavor = room.currentNomination.nominated === seatIndex ? false : false;
                        vote(room, seatIndex, inFavor);
                    }
                    // 可能触发自动结算与白天结束
                    if (room.currentNomination) {
                        const eligibleVoters = room.players.filter((x) => x.isAlive || x.hasDeadVote).map((x) => x.seatIndex);
                        const allVoted = eligibleVoters.every((s) => room.votes.has(s));
                        if (allVoted) {
                            const { passed, votesFor, votes: vv } = tallyVotes(room);
                            const { key, title } = dayReplayTitle(room);
                            const voteLines = vv.map((v) => `${seatLabel(room, v.seatIndex)}：${v.inFavor ? '赞成' : '反对'}`).join('；');
                            pushReplay(room, key, title, `投票结束：${passed ? '达到处决条件（已标记待处决）' : '未达到处决条件'}（赞成 ${votesFor} 票）。票型：${voteLines || '（无人投票记录）'}`);
                            pushPublic(room, `投票结束：${passed ? '达到处决条件（已标记待处决）' : '未达到处决条件'}（赞成 ${votesFor} 票）。`);
                            broadcast(rid, { type: 'vote_result', passed, votesFor, votes: vv });
                        }
                    }
                    broadcast(rid, { type: 'room', room: getRoomView(room) });
                    const phaseBefore = room.phase;
                    const fin = maybeFinishDay(room);
                    if (fin.ended)
                        await handleDayMaybeEnterNight(rid, room, phaseBefore, fin.executedSeatIndex);
                    if (!aiPlayerLlmAvailable())
                        continue;
                }
            }
            const last = room.aiPlayerLastActionAtBySeat.get(seatIndex) ?? 0;
            const now = Date.now();
            if (now - last < 2500)
                continue;
            room.aiPlayerLastActionAtBySeat.set(seatIndex, now);
            try {
                const roomView = getRoomView(room, seatIndex, false);
                const yourCharacterId = getShownCharacterId(room.players[seatIndex]) ?? null;
                const yourRole = buildYourRolePayload(room, seatIndex);
                const chatLog = (roomView.chatLog ?? []).map((e) => ({
                    scope: e.scope,
                    fromSeat: e.fromSeat,
                    toSeat: e.toSeat,
                    text: e.text,
                    at: e.at,
                }));
                const nightInfo = (getNightInfoLogBySeat(room).get(seatIndex) ?? []).slice(-NIGHT_INFO_LOG_LIMIT);
                const nightPrompt = room.pendingNightAction && room.pendingNightAction.actorSeatIndex === seatIndex
                    ? {
                        stepId: room.pendingNightAction.stepId,
                        pick: room.pendingNightAction.pick,
                        aliveSeatIndices: room.players.filter((x) => x.isAlive).map((x) => x.seatIndex),
                    }
                    : null;
                const temp = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
                const action = await decideAiPlayerAction(room, seatIndex, {
                    roomView,
                    yourSeatIndex: seatIndex,
                    yourRole,
                    yourCharacterId,
                    chatLog,
                    nightInfo,
                    nightPrompt,
                    currentNomination: room.currentNomination,
                }, temp);
                // 执行动作（复用既有逻辑入口，保持规则一致）
                if (action.type === 'chat_public') {
                    const entry = pushChat(room, { at: Date.now(), scope: 'public', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: action.text });
                    pushPublic(room, `公开发言：${seatLabel(room, seatIndex)}：${action.text}`);
                    broadcastChat(rid, entry);
                    broadcast(rid, { type: 'room', room: getRoomView(room) });
                }
                else if (action.type === 'chat_dm') {
                    const entry = pushChat(room, { at: Date.now(), scope: 'dm', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, toSeat: action.toSeat, text: action.text });
                    broadcastChat(rid, entry);
                }
                else if (action.type === 'chat_god') {
                    const entry = pushChat(room, { at: Date.now(), scope: 'god', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: action.text });
                    broadcastChat(rid, entry);
                    const replyText = makeDeterministicGodReply(room, seatIndex, action.text);
                    const reply = pushChat(room, { at: Date.now(), scope: 'god', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: replyText });
                    broadcastChat(rid, reply);
                }
                else if (action.type === 'night_confirm') {
                    if (room.awaitingNightConfirm && (room.phase === 'night' || room.phase === 'first_night')) {
                        room.nightConfirmations.add(seatIndex);
                        broadcastNightConfirm(rid, room);
                        if (room.nightConfirmations.size >= room.players.length) {
                            const { key, title } = nightReplayTitle(room);
                            pushReplay(room, key, title, '全员确认夜晚结束，天亮。');
                            pushPublic(room, '全员确认夜晚结束，天亮。');
                            finishNightAndGotoDay(room);
                            shareAiNightInfoAtDawn(rid, room);
                            broadcast(rid, { type: 'room', room: getRoomView(room) });
                            broadcast(rid, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
                        }
                    }
                }
                else if (action.type === 'night_action') {
                    if (room.pendingNightAction && room.pendingNightAction.actorSeatIndex === seatIndex) {
                        const pendingBefore = room.pendingNightAction;
                        const result = submitNightAction(room, seatIndex, action.targets);
                        if (result.ok) {
                            if (pendingBefore) {
                                const { key, title } = nightReplayTitle(room);
                                if (pendingBefore.stepId === 'imp' && action.targets[0] !== undefined) {
                                    pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（恶魔）选择杀害 ${seatLabel(room, action.targets[0])}。`);
                                }
                                else if (pendingBefore.stepId === 'monk' && action.targets[0] !== undefined) {
                                    pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（僧侣）选择保护 ${seatLabel(room, action.targets[0])}。`);
                                }
                                else if (pendingBefore.stepId === 'poisoner' && action.targets[0] !== undefined) {
                                    pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（投毒者）选择毒害 ${seatLabel(room, action.targets[0])}。`);
                                }
                                else if (pendingBefore.stepId === 'fortune_teller' && action.targets.length === 2) {
                                    pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（占卜师）选择查验 ${seatLabel(room, action.targets[0])} 与 ${seatLabel(room, action.targets[1])}。`);
                                }
                            }
                            if (result.info)
                                sendToSeat(rid, seatIndex, { type: 'night_info', message: result.info });
                            const phaseBeforeLoop = room.phase;
                            await runNightLoop(rid, room);
                            if (room.phase !== 'waiting')
                                sendNightPrompt(rid, room);
                            broadcastAfterNight(rid, room, phaseBeforeLoop);
                            broadcastNightConfirm(rid, room);
                        }
                    }
                }
                else if (action.type === 'nominate') {
                    if (room.phase === 'day') {
                        const ok = nominate(room, seatIndex, action.nominatedSeat);
                        if (ok) {
                            const { key, title } = dayReplayTitle(room);
                            pushReplay(room, key, title, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, action.nominatedSeat)}。`);
                            pushPublic(room, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, action.nominatedSeat)}。`);
                            broadcast(rid, { type: 'room', room: getRoomView(room) });
                        }
                    }
                }
                else if (action.type === 'skip_nomination') {
                    if (room.phase === 'day') {
                        const ok = skipNomination(room, seatIndex);
                        if (ok) {
                            const { key, title } = dayReplayTitle(room);
                            pushReplay(room, key, title, `${seatLabel(room, seatIndex)} 选择本轮不提名。`);
                            pushPublic(room, `${seatLabel(room, seatIndex)} 选择本轮不提名。`);
                            broadcast(rid, { type: 'room', room: getRoomView(room) });
                            const phaseBefore = room.phase;
                            const fin = maybeFinishDay(room);
                            if (fin.ended)
                                await handleDayMaybeEnterNight(rid, room, phaseBefore, fin.executedSeatIndex);
                        }
                    }
                }
                else if (action.type === 'vote') {
                    if (room.phase === 'day') {
                        vote(room, seatIndex, action.inFavor);
                        if (room.currentNomination) {
                            const eligibleVoters = room.players.filter((x) => x.isAlive || x.hasDeadVote).map((x) => x.seatIndex);
                            const allVoted = eligibleVoters.every((s) => room.votes.has(s));
                            if (allVoted) {
                                const { passed, votesFor, votes: vv } = tallyVotes(room);
                                const { key, title } = dayReplayTitle(room);
                                const voteLines = vv.map((v) => `${seatLabel(room, v.seatIndex)}：${v.inFavor ? '赞成' : '反对'}`).join('；');
                                pushReplay(room, key, title, `投票结束：${passed ? '达到处决条件（已标记待处决）' : '未达到处决条件'}（赞成 ${votesFor} 票）。票型：${voteLines || '（无人投票记录）'}`);
                                pushPublic(room, `投票结束：${passed ? '达到处决条件（已标记待处决）' : '未达到处决条件'}（赞成 ${votesFor} 票）。`);
                                broadcast(rid, { type: 'vote_result', passed, votesFor, votes: vv });
                            }
                        }
                        broadcast(rid, { type: 'room', room: getRoomView(room) });
                        const phaseBefore = room.phase;
                        const fin = maybeFinishDay(room);
                        if (fin.ended)
                            await handleDayMaybeEnterNight(rid, room, phaseBefore, fin.executedSeatIndex);
                    }
                }
                else if (action.type === 'day_action') {
                    if (room.phase === 'day') {
                        // 直接复用已有 day_action 处理路径太重，这里仅支持 slayer_shot（与现有实现一致）
                        if (action.actionId === 'slayer_shot' && Number.isInteger(action.targetSeat)) {
                            const fakeWs = { send: (_) => { } };
                            // 复用现有逻辑：走同一段代码需要大改结构；这里先让 AI 玩家以“公开宣称”方式引导人类点按钮。
                            // 先不自动执行，避免越权；后续可以把 day_action 逻辑抽函数供复用。
                            void fakeWs;
                        }
                    }
                }
            }
            catch {
                // ignore ai errors
            }
        }
        // 房间级兜底：若白天所有存活玩家都已完成“提名/不提名”，则结束白天（避免遗漏触发导致卡死）
        if (room.phase === 'day' && room.currentNomination === null) {
            const phaseBefore = room.phase;
            const fin = maybeFinishDay(room);
            if (fin.ended) {
                await handleDayMaybeEnterNight(rid, room, phaseBefore, fin.executedSeatIndex);
            }
        }
    }
}, 1200);
