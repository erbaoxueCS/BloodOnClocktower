import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createRoom, getRoom, joinRoom, getRoomView, setReady, bindConnection, unbindConnection } from './game/roomManager.js';
import { startGame, advanceNight, applyStorytellerDecision, randomStorytellerDecision, nominate, vote, tallyVotes, execute, startNominationPhase } from './game/gameEngine.js';
import { troubleBrewing } from './script/troubleBrewing.js';
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
    res.json({ roomId: room.id, scriptId: room.scriptId });
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
function runNightLoop(room) {
    for (;;) {
        const needDecision = advanceNight(room);
        if (!needDecision)
            break;
        const decision = randomStorytellerDecision(room);
        applyStorytellerDecision(room, decision);
    }
}
const server = createServer(app);
const wss = new WebSocketServer({ server });
function broadcast(roomId, payload, excludeConnectionId) {
    const room = getRoom(roomId);
    if (!room)
        return;
    wss.clients?.forEach((ws) => {
        if (ws.roomId !== roomId || ws.connectionId === excludeConnectionId || ws.readyState !== 1)
            return;
        let p = payload;
        if (payload && typeof payload === 'object' && payload.type === 'room' && payload.room) {
            const seatIndex = ws.seatIndex;
            const yourCharacterId = room.players[seatIndex]?.characterId;
            p = { ...payload, yourCharacterId, yourSeatIndex: seatIndex };
        }
        ws.send(JSON.stringify(p));
    });
}
wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', `http://localhost`);
    const roomId = url.searchParams.get('roomId');
    const seatIndexStr = url.searchParams.get('seatIndex');
    const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ws.connectionId = connectionId;
    ws.roomId = roomId;
    ws.seatIndex = seatIndexStr !== null ? parseInt(seatIndexStr, 10) : null;
    if (!roomId || seatIndexStr === null) {
        ws.send(JSON.stringify({ type: 'error', message: 'roomId and seatIndex required' }));
        ws.close();
        return;
    }
    const room = getRoom(roomId);
    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        ws.close();
        return;
    }
    bindConnection(room, connectionId, parseInt(seatIndexStr, 10));
    ws.send(JSON.stringify({ type: 'room', room: getRoomView(room), yourSeatIndex: parseInt(seatIndexStr, 10), yourCharacterId: room.players[parseInt(seatIndexStr, 10)]?.characterId }));
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const room = getRoom(roomId);
            if (!room)
                return;
            const seatIndex = parseInt(seatIndexStr, 10);
            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }
            if (msg.type === 'ready') {
                setReady(room, seatIndex, msg.ready);
                broadcast(roomId, { type: 'room', room: getRoomView(room) }, connectionId);
                return;
            }
            if (msg.type === 'start') {
                const ok = startGame(room);
                if (!ok) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Cannot start game' }));
                    return;
                }
                runNightLoop(room);
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
                return;
            }
            if (msg.type === 'nominate') {
                const ok = nominate(room, seatIndex, msg.nominatedSeat);
                if (!ok) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Nomination not allowed' }));
                    return;
                }
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                return;
            }
            if (msg.type === 'vote') {
                vote(room, seatIndex, msg.inFavor);
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                return;
            }
            if (msg.type === 'end_voting') {
                const { passed, votesFor } = tallyVotes(room);
                broadcast(roomId, { type: 'room', room: getRoomView(room) });
                broadcast(roomId, { type: 'vote_result', passed, votesFor });
                return;
            }
            if (msg.type === 'execute') {
                execute(room);
                if (room.status === 'ended') {
                    const win = room.players.some((p) => p.isAlive && p.characterId === 'imp') ? 'evil' : 'good';
                    broadcast(roomId, { type: 'game_over', winner: win, room: getRoomView(room) });
                }
                else {
                    room.phase = 'night';
                    room.nightStepIndex = 0;
                    room.lastNightDeaths = [];
                    room.lastNightRevivals = [];
                    runNightLoop(room);
                    broadcast(roomId, { type: 'room', room: getRoomView(room) });
                    broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
                }
                return;
            }
            if (msg.type === 'next_phase') {
                if (room.phase === 'day' && room.daySubPhase === 'discussion') {
                    startNominationPhase(room);
                    broadcast(roomId, { type: 'room', room: getRoomView(room) });
                }
                return;
            }
        }
        catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
    });
    ws.on('close', () => {
        const room = getRoom(roomId ?? '');
        if (room)
            unbindConnection(room, connectionId);
    });
});
server.listen(HTTP_PORT, () => {
    console.log(`HTTP + WS server on http://localhost:${HTTP_PORT}`);
});
