import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createRoom, getRoom, joinRoom, getRoomView, setReady, bindConnection, unbindConnection } from './game/roomManager.js';
import { startGame, advanceNight, getCurrentNightStep, randomStorytellerDecision, nominate, vote, tallyVotes, execute, startNominationPhase, submitNightAction, findAliveSeatByCharacter, computeChefPairsForSeat, computeEmpathCountForSeat, formatUndertakerInfoForSeat, formatWasherLibrarianInvestigator } from './game/gameEngine.js';
import { troubleBrewing } from './script/troubleBrewing.js';

const app = express();
app.use(cors());
app.use(express.json());

const HTTP_PORT = 3001;

app.get('/api/scripts', (_req, res) => {
  res.json([{ id: troubleBrewing.id, name: troubleBrewing.name, nameZh: troubleBrewing.nameZh, minPlayers: troubleBrewing.minPlayers, maxPlayers: troubleBrewing.maxPlayers }]);
});

app.post('/api/rooms', (req, res) => {
  const scriptId = (req.body?.scriptId as string) || troubleBrewing.id;
  const room = createRoom(scriptId);
  res.json({ roomId: room.id, scriptId: room.scriptId });
});

app.post('/api/rooms/:roomId/join', (req, res) => {
  const { roomId } = req.params;
  const nickname = (req.body?.nickname as string) || 'Player';
  const result = joinRoom(roomId, nickname);
  if (!result) return res.status(400).json({ error: 'Cannot join room' });
  const view = getRoomView(result.room);
  res.json({ roomId, seatIndex: result.seatIndex, playerId: result.room.players[result.seatIndex].id, room: view });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(getRoomView(room));
});

function sendNightInfo(roomId: string, seatIndex: number, message: string) {
  sendToSeat(roomId, seatIndex, { type: 'night_info', message });
}

function runNightLoop(roomId: string, room: import('./game/types.js').Room): void {
  for (;;) {
    if (room.pendingNightAction) break;
    const stepId = getCurrentNightStep(room);
    if (!stepId) {
      advanceNight(room);
      if (room.phase === 'day' || room.phase === 'waiting') break;
      continue;
    }

    // 信息型步骤：直接向对应玩家发送信息，并推进一步
    if (stepId === 'chef') {
      const seat = findAliveSeatByCharacter(room, 'chef');
      if (seat != null) sendNightInfo(roomId, seat, `厨师：你得知相邻两名邪恶玩家的数量为 ${computeChefPairsForSeat(room, seat)}。`);
      room.nightStepIndex++;
      continue;
    }
    if (stepId === 'empath') {
      const seat = findAliveSeatByCharacter(room, 'empath');
      if (seat != null) sendNightInfo(roomId, seat, `共情者：你得知相邻邪恶玩家数量为 ${computeEmpathCountForSeat(room, seat)}。`);
      room.nightStepIndex++;
      continue;
    }
    if (stepId === 'undertaker') {
      const seat = findAliveSeatByCharacter(room, 'undertaker');
      if (seat != null) sendNightInfo(roomId, seat, formatUndertakerInfoForSeat(room, seat));
      room.nightStepIndex++;
      continue;
    }

    // 说书人选择型（首夜）：洗衣妇/图书管理员/调查员 —— 目前用随机替代说书人
    if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
      const seat = findAliveSeatByCharacter(room, stepId);
      const decision = randomStorytellerDecision(room) as any;
      room.storytellerDecisions.set(stepId, decision);
      if (seat != null) sendNightInfo(roomId, seat, formatWasherLibrarianInvestigator(room, stepId, decision));
      room.nightStepIndex++;
      continue;
    }

    // 其余步骤交给引擎推进（会在需要行动时设置 pendingNightAction）
    advanceNight(room);
    if (room.phase === 'day' || room.phase === 'waiting') break;
    if (room.pendingNightAction) break;
  }
}

const server = createServer(app);
const wss = new WebSocketServer({ server });

type ClientMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'start' }
  | { type: 'nominate'; nominatedSeat: number }
  | { type: 'vote'; inFavor: boolean }
  | { type: 'end_voting' }
  | { type: 'execute' }
  | { type: 'night_action'; targets: number[] }
  | { type: 'next_phase' }
  | { type: 'ping' };

function broadcast(roomId: string, payload: object, excludeConnectionId?: string) {
  const room = getRoom(roomId);
  if (!room) return;
  (wss as any).clients?.forEach((ws: any) => {
    if (ws.roomId !== roomId || ws.connectionId === excludeConnectionId || ws.readyState !== 1) return;
    let p = payload as Record<string, unknown>;
    if (payload && typeof payload === 'object' && (payload as any).type === 'room' && (payload as any).room) {
      const seatIndex = ws.seatIndex;
      const yourCharacterId = room.players[seatIndex]?.characterId;
      p = { ...(payload as object), yourCharacterId, yourSeatIndex: seatIndex } as Record<string, unknown>;
    }
    ws.send(JSON.stringify(p));
  });
}

function sendToSeat(roomId: string, seatIndex: number, payload: object) {
  const room = getRoom(roomId);
  if (!room) return;
  (wss as any).clients?.forEach((ws: any) => {
    if (ws.roomId !== roomId || ws.readyState !== 1) return;
    if (ws.seatIndex !== seatIndex) return;
    let p = payload as Record<string, unknown>;
    if (payload && typeof payload === 'object' && (payload as any).type === 'room' && (payload as any).room) {
      const yourCharacterId = room.players[seatIndex]?.characterId;
      p = { ...(payload as object), yourCharacterId, yourSeatIndex: seatIndex } as Record<string, unknown>;
    }
    ws.send(JSON.stringify(p));
  });
}

function sendNightPrompt(roomId: string, room: import('./game/types.js').Room) {
  if (!room.pendingNightAction) return;
  const a = room.pendingNightAction;
  sendToSeat(roomId, a.actorSeatIndex, {
    type: 'night_prompt',
    stepId: a.stepId,
    actorSeatIndex: a.actorSeatIndex,
    pick: a.pick,
    aliveSeatIndices: room.players.filter((p) => p.isAlive).map((p) => p.seatIndex),
  });
}

function sendEvilInfo(roomId: string, room: import('./game/types.js').Room) {
  const evilSeats = room.players.filter((p) => p.isAlive && (p.characterId === 'imp' || ['poisoner', 'spy', 'baron', 'scarlet_woman'].includes(p.characterId ?? ''))).map((p) => p.seatIndex);
  const demonSeat = room.players.find((p) => p.isAlive && p.characterId === 'imp')?.seatIndex ?? null;
  // 简化：互相告知座位号（不告知具体身份）
  for (const s of evilSeats) {
    const isDemon = s === demonSeat;
    sendToSeat(roomId, s, {
      type: 'night_info',
      message: isDemon
        ? `你是恶魔。你的爪牙座位号：${evilSeats.filter((x) => x !== s).map((x) => `#${x + 1}`).join('、') || '无'}。不在场善良身份：${room.demonBluffs?.join(',') || '无'}`
        : `你是爪牙。恶魔座位号：${demonSeat != null ? `#${demonSeat + 1}` : '未知'}。其他邪恶座位号：${evilSeats.filter((x) => x !== s).map((x) => `#${x + 1}`).join('、') || '无'}`,
    });
  }
}

wss.on('connection', (ws: any, req) => {
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

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as ClientMessage;
      const room = getRoom(roomId);
      if (!room) return;
      const seatIndex = parseInt(seatIndexStr, 10);

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (msg.type === 'ready') {
        setReady(room, seatIndex, msg.ready);
        // 需要回推给发起者，否则其 UI 不会更新 ready 状态
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }
      if (msg.type === 'start') {
        const ok = startGame(room);
        if (!ok) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot start game' }));
          return;
        }
        runNightLoop(roomId, room);
        sendEvilInfo(roomId, room);
        sendNightPrompt(roomId, room);
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
        const { passed, votesFor, votes } = tallyVotes(room);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        broadcast(roomId, { type: 'vote_result', passed, votesFor, votes });
        return;
      }
      if (msg.type === 'execute') {
        execute(room);
        if (room.status === 'ended') {
          const win = room.players.some((p) => p.isAlive && p.characterId === 'imp') ? 'evil' : 'good';
          broadcast(roomId, { type: 'game_over', winner: win, room: getRoomView(room) });
        } else {
          room.phase = 'night';
          room.nightStepIndex = 0;
          room.pendingNightAction = null;
          room.protectedSeatIndex = null;
          room.lastNightDeaths = [];
          room.lastNightRevivals = [];
          runNightLoop(roomId, room);
          sendNightPrompt(roomId, room);
          broadcast(roomId, { type: 'room', room: getRoomView(room) });
          broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
        }
        return;
      }
      if (msg.type === 'night_action') {
        const result = submitNightAction(room, seatIndex, msg.targets ?? []);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'error', message: `night_action_failed:${result.error ?? 'unknown'}` }));
          return;
        }
        if (result.info) {
          sendToSeat(roomId, seatIndex, { type: 'night_info', message: result.info });
        }
        // 夜晚继续推进直到下一次需要输入或天亮
        runNightLoop(roomId, room);
        sendNightPrompt(roomId, room);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
        return;
      }
      if (msg.type === 'next_phase') {
        if (room.phase === 'day' && room.daySubPhase === 'discussion') {
          startNominationPhase(room);
          broadcast(roomId, { type: 'room', room: getRoomView(room) });
        }
        return;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: (e as Error).message }));
    }
  });

  ws.on('close', () => {
    const room = getRoom(roomId ?? '');
    if (room) unbindConnection(room, connectionId);
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP + WS server on http://localhost:${HTTP_PORT}`);
});
