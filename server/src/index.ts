import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createRoom, getRoom, joinRoom, getRoomView, setReady, bindConnection, unbindConnection } from './game/roomManager.js';
import { buildYourRolePayload } from './game/yourRole.js';
import { startGame, advanceNight, getCurrentNightStep, nominate, vote, tallyVotes, execute, startNominationPhase, submitNightAction, findAliveSeatByCharacter, computeChefPairsForSeat, computeEmpathCountForSeat, formatUndertakerInfoForSeat, formatWasherLibrarianInvestigator, checkWin, getShownCharacterId, distortWasherLibrarianInvestigatorDecision, resolveRavenkeeperNightInfo } from './game/gameEngine.js';
import { getStorytellerDecision } from './ai/storyteller.js';
import { pushReplay, buildReplayBundle, seatLabel, pushPublic } from './game/replay.js';
import type { GamePhase } from './game/types.js';
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
  res.json({ roomId: room.id, scriptId: room.scriptId, hostSecret: room.hostSecret });
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
function nightReplayTitle(room: import('./game/types.js').Room): { key: string; title: string } {
  if (room.phase === 'first_night') return { key: 'first_night', title: '首夜' };
  const nightOrdinal = room.dayNumber + 1;
  return { key: `night_${nightOrdinal}`, title: `第 ${nightOrdinal} 夜` };
}

function dayReplayTitle(room: import('./game/types.js').Room): { key: string; title: string } {
  return { key: `day_${room.dayNumber}`, title: `第 ${room.dayNumber} 天 · 白天` };
}

function sendNightInfo(roomId: string, room: import('./game/types.js').Room, seatIndex: number, message: string) {
  const { key, title } = nightReplayTitle(room);
  pushReplay(room, key, title, `[夜间信息] ${seatLabel(room, seatIndex)}：${message}`);
  sendToSeat(roomId, seatIndex, { type: 'night_info', message });
}

function maybeLogDawn(room: import('./game/types.js').Room, phaseBefore: GamePhase): void {
  if (phaseBefore !== 'first_night' && phaseBefore !== 'night') return;
  /** 正常天亮为 day；夜间结束时若胜负已判则 phase 会变为 waiting，仍需记录天亮公布的死亡 */
  const dawnLike = room.phase === 'day' || (room.status === 'ended' && room.phase === 'waiting');
  if (!dawnLike) return;
  const { key, title } = dayReplayTitle(room);
  const dead = room.lastNightDeaths.length > 0
    ? `天亮公布：昨夜死亡 ${room.lastNightDeaths.map((s) => seatLabel(room, s)).join('、')}`
    : '天亮公布：昨夜无人死亡';
  pushReplay(room, key, title, dead);
}

function broadcastAfterNight(roomId: string, room: import('./game/types.js').Room, phaseBeforeLoop: GamePhase): void {
  maybeLogDawn(room, phaseBeforeLoop);
  if (room.status === 'ended') {
    const win = checkWin(room);
    if (win) {
      pushReplay(room, 'result', '游戏结束', `${win === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);
      const replay = buildReplayBundle(room, win);
      broadcast(roomId, { type: 'game_over', winner: win, room: getRoomView(room), replay });
    }
    return;
  }
  broadcast(roomId, { type: 'room', room: getRoomView(room) });
  broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
}

function maybeLogEnterNight(room: import('./game/types.js').Room, phaseBefore: GamePhase): void {
  if (room.phase !== 'night' || phaseBefore !== 'day') return;
  const { key, title } = nightReplayTitle(room);
  pushReplay(room, key, title, '进入夜晚。');
}

async function runNightLoop(roomId: string, room: import('./game/types.js').Room): Promise<void> {
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
      if (seat != null) sendNightInfo(roomId, room, seat, `厨师：你得知相邻两名邪恶玩家的数量为 ${computeChefPairsForSeat(room, seat)}。`);
      room.nightStepIndex++;
      continue;
    }
    if (stepId === 'empath') {
      const seat = findAliveSeatByCharacter(room, 'empath');
      if (seat != null) sendNightInfo(roomId, room, seat, `共情者：你得知相邻邪恶玩家数量为 ${computeEmpathCountForSeat(room, seat)}。`);
      room.nightStepIndex++;
      continue;
    }
    if (stepId === 'undertaker') {
      const seat = findAliveSeatByCharacter(room, 'undertaker');
      if (seat != null) sendNightInfo(roomId, room, seat, formatUndertakerInfoForSeat(room, seat));
      room.nightStepIndex++;
      continue;
    }

    if (stepId === 'ravenkeeper') {
      for (const vSeat of room.lastNightDeaths) {
        if (room.players[vSeat]?.characterId !== 'ravenkeeper') continue;
        const msg = resolveRavenkeeperNightInfo(room, vSeat);
        if (msg) sendNightInfo(roomId, room, vSeat, msg);
      }
      room.nightStepIndex++;
      continue;
    }

    // 说书人裁量型：洗衣妇/图书管理员/调查员 —— USE_AI_STORYTELLER + OPENAI_API_KEY 时走 AI，否则随机；中毒/醉酒仍由引擎失真
    if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
      const seat = findAliveSeatByCharacter(room, stepId);
      const stepNameZh = room.script.characters.find((c) => c.id === stepId)?.nameZh ?? stepId;
      const raw = (await getStorytellerDecision(room, stepId, stepNameZh)) as any;
      let decision = raw;
      if (seat != null && raw && Array.isArray(raw.players) && raw.players.length === 2 && typeof raw.characterId === 'string') {
        decision = distortWasherLibrarianInvestigatorDecision(room, seat, { players: raw.players, characterId: raw.characterId });
      }
      room.storytellerDecisions.set(stepId, decision);
      if (seat != null) sendNightInfo(roomId, room, seat, formatWasherLibrarianInvestigator(room, stepId, decision));
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
  | { type: 'end_nomination' }
  | { type: 'cancel_current_nomination' }
  | { type: 'execute' }
  | { type: 'night_action'; targets: number[] }
  | { type: 'day_action'; actionId: string; targetSeat?: number }
  | { type: 'next_phase' }
  | { type: 'ping' };

function broadcast(roomId: string, payload: object, excludeConnectionId?: string) {
  const room = getRoom(roomId);
  if (!room) return;
  (wss as any).clients?.forEach((ws: any) => {
    if (ws.roomId !== roomId || ws.connectionId === excludeConnectionId || ws.readyState !== 1) return;
    let p = payload as Record<string, unknown>;
    if (payload && typeof payload === 'object') {
      const type = (payload as any).type;
      const seatIndex = ws.seatIndex as number;
      if (typeof seatIndex === 'number' && (type === 'room' || type === 'game_over') && (payload as any).room) {
        const yourCharacterId = getShownCharacterId(room.players[seatIndex]);
        const yourRole = buildYourRolePayload(room, seatIndex);
        p = { ...(payload as object), yourCharacterId, yourRole, yourSeatIndex: seatIndex, isHost: !!ws.isHost } as Record<string, unknown>;
      }
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
      const yourCharacterId = getShownCharacterId(room.players[seatIndex]);
      const yourRole = buildYourRolePayload(room, seatIndex);
      p = { ...(payload as object), yourCharacterId, yourRole, yourSeatIndex: seatIndex, isHost: !!ws.isHost } as Record<string, unknown>;
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

wss.on('connection', (ws: any, req) => {
  const url = new URL(req.url ?? '', `http://localhost`);
  const roomId = url.searchParams.get('roomId');
  const seatIndexStr = url.searchParams.get('seatIndex');
  const hostSecret = url.searchParams.get('hostSecret');
  const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ws.connectionId = connectionId;
  ws.roomId = roomId;
  ws.seatIndex = seatIndexStr !== null ? parseInt(seatIndexStr, 10) : null;
  ws.isHost = false;

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
  if (hostSecret && hostSecret === room.hostSecret) ws.isHost = true;
  bindConnection(room, connectionId, parseInt(seatIndexStr, 10));
  const si = parseInt(seatIndexStr, 10);
  ws.send(
    JSON.stringify({
      type: 'room',
      room: getRoomView(room),
      yourSeatIndex: si,
      yourCharacterId: getShownCharacterId(room.players[si]),
      yourRole: buildYourRolePayload(room, si),
      isHost: ws.isHost,
    }),
  );

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as ClientMessage;
      const room = getRoom(roomId);
      if (!room) return;
      const seatIndex = parseInt(seatIndexStr, 10);
      const isHost = !!ws.isHost;

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
        return;
      }
      if (msg.type === 'nominate') {
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
      if (msg.type === 'vote') {
        vote(room, seatIndex, msg.inFavor);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }
      if (msg.type === 'end_nomination') {
        if (!isHost) {
          ws.send(JSON.stringify({ type: 'error', message: 'host_only:end_nomination' }));
          return;
        }
        if (room.phase !== 'day') {
          ws.send(JSON.stringify({ type: 'error', message: 'end_nomination_not_in_day' }));
          return;
        }
        room.daySubPhase = 'discussion';
        room.currentNomination = null;
        room.votes = new Map();
        pushPublic(room, '房主结束提名阶段，回到讨论。');
        const { key, title } = dayReplayTitle(room);
        pushReplay(room, key, title, '房主结束提名阶段，回到讨论。');
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }
      if (msg.type === 'cancel_current_nomination') {
        if (!isHost) {
          ws.send(JSON.stringify({ type: 'error', message: 'host_only:cancel_current_nomination' }));
          return;
        }
        if (room.phase !== 'day') {
          ws.send(JSON.stringify({ type: 'error', message: 'cancel_nomination_not_in_day' }));
          return;
        }
        if (!room.currentNomination) {
          ws.send(JSON.stringify({ type: 'error', message: 'no_current_nomination' }));
          return;
        }
        const n = room.currentNomination;
        room.currentNomination = null;
        room.votes = new Map();
        pushPublic(room, `房主取消本次提名：#${n.nominator + 1} → #${n.nominated + 1}。`);
        const { key, title } = dayReplayTitle(room);
        pushReplay(room, key, title, `房主取消本次提名：${seatLabel(room, n.nominator)} → ${seatLabel(room, n.nominated)}。`);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }
      if (msg.type === 'day_action') {
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
          const target = room.players[targetSeat as number];
          if (!target?.isAlive) {
            ws.send(JSON.stringify({ type: 'error', message: 'day_action_target_not_alive' }));
            return;
          }

          // 所有人都可以“宣称发动”，但只有真实杀手且未中毒/醉酒且未使用过才会生效
          pushReplay(room, key, title, `[白天技能] ${seatLabel(room, seatIndex)} 宣称自己是「杀手」并向 ${seatLabel(room, targetSeat as number)} 开枪。`);
          pushPublic(room, `${seatLabel(room, seatIndex)} 宣称自己是「杀手」并向 ${seatLabel(room, targetSeat as number)} 开枪。`);

          const used = room.usedDayActionsBySeat.get(seatIndex) ?? new Set<string>();
          if (used.has('slayer_shot')) {
            pushReplay(room, key, title, '枪击结果：无事发生（你本局已使用过该技能）。');
            pushPublic(room, '枪击结果：无事发生。');
            broadcast(roomId, { type: 'room', room: getRoomView(room) });
            return;
          }
          used.add('slayer_shot');
          room.usedDayActionsBySeat.set(seatIndex, used);

          const isRealSlayer = room.players[seatIndex]?.characterId === 'slayer';
          const canWork = isRealSlayer && room.poisonedSeatIndex !== seatIndex && room.players[seatIndex]?.characterId !== 'drunk';
          if (canWork && room.players[targetSeat as number]?.characterId === 'imp') {
            room.players[targetSeat as number].isAlive = false;
            pushReplay(room, key, title, `枪击命中：${seatLabel(room, targetSeat as number)}（恶魔）死亡。`);
            pushPublic(room, `枪击命中：${seatLabel(room, targetSeat as number)} 死亡。`);
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
          } else {
            pushReplay(room, key, title, '枪击结果：无事发生。');
            pushPublic(room, '枪击结果：无事发生。');
          }

          broadcast(roomId, { type: 'room', room: getRoomView(room) });
          return;
        }

        ws.send(JSON.stringify({ type: 'error', message: 'day_action_unknown' }));
        return;
      }
      if (msg.type === 'end_voting') {
        if (!isHost) {
          ws.send(JSON.stringify({ type: 'error', message: 'host_only:end_voting' }));
          return;
        }
        const { passed, votesFor, votes } = tallyVotes(room);
        const { key, title } = dayReplayTitle(room);
        const voteLines = votes.map((v) => `${seatLabel(room, v.seatIndex)}：${v.inFavor ? '赞成' : '反对'}`).join('；');
        pushReplay(room, key, title, `投票结束：${passed ? '达到处决条件' : '未达到处决条件'}（赞成 ${votesFor} 票）。票型：${voteLines || '（无人投票记录）'}`);
        pushPublic(room, `投票结束：${passed ? '达到处决条件' : '未达到处决条件'}（赞成 ${votesFor} 票）。`);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        broadcast(roomId, { type: 'vote_result', passed, votesFor, votes });
        return;
      }
      if (msg.type === 'execute') {
        if (!isHost) {
          ws.send(JSON.stringify({ type: 'error', message: 'host_only:execute' }));
          return;
        }
        const phaseBeforeExec = room.phase;
        const targetSeat = room.pendingExecution;
        const dayNumForReplay = room.dayNumber;
        const dayReplayKey = `day_${dayNumForReplay}`;
        const dayReplayTitleText = `第 ${dayNumForReplay} 天 · 白天`;
        execute(room);
        if (room.status === 'ended') {
          const win = room.players.some((p) => p.isAlive && p.characterId === 'imp') ? 'evil' : 'good';
          if (targetSeat != null) {
            pushReplay(room, dayReplayKey, dayReplayTitleText, `处决执行：${seatLabel(room, targetSeat)} 死亡。`);
            pushPublic(room, `处决执行：${seatLabel(room, targetSeat)} 死亡。`);
          }
          pushReplay(room, 'result', '游戏结束', `${win === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);
          const replay = buildReplayBundle(room, win);
          broadcast(roomId, { type: 'game_over', winner: win, room: getRoomView(room), replay });
        } else {
          if (targetSeat != null) {
            pushReplay(room, dayReplayKey, dayReplayTitleText, `处决执行：${seatLabel(room, targetSeat)} 死亡。`);
            pushPublic(room, `处决执行：${seatLabel(room, targetSeat)} 死亡。`);
          }
          maybeLogEnterNight(room, phaseBeforeExec);
          room.pendingNightAction = null;
          room.protectedSeatIndex = null;
          const phaseBeforeLoop = room.phase;
          await runNightLoop(roomId, room);
          // 若已结束（phase=waiting），不再提示夜晚行动
          if (room.phase !== 'waiting') sendNightPrompt(roomId, room);
          broadcastAfterNight(roomId, room, phaseBeforeLoop);
        }
        return;
      }
      if (msg.type === 'night_action') {
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
          } else if (pendingBefore.stepId === 'monk' && targets[0] !== undefined) {
            pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（僧侣）选择保护 ${seatLabel(room, targets[0])}。`);
          } else if (pendingBefore.stepId === 'poisoner' && targets[0] !== undefined) {
            pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（投毒者）选择毒害 ${seatLabel(room, targets[0])}。`);
          } else if (pendingBefore.stepId === 'fortune_teller' && targets.length === 2) {
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
        if (room.phase !== 'waiting') sendNightPrompt(roomId, room);
        broadcastAfterNight(roomId, room, phaseBeforeLoop);
        return;
      }
      if (msg.type === 'next_phase') {
        if (room.phase === 'day' && room.daySubPhase === 'discussion') {
          if (!isHost) {
            ws.send(JSON.stringify({ type: 'error', message: 'host_only:next_phase' }));
            return;
          }
          startNominationPhase(room);
          const { key, title } = dayReplayTitle(room);
          pushReplay(room, key, title, '进入提名阶段。');
          pushPublic(room, '进入提名阶段。');
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
