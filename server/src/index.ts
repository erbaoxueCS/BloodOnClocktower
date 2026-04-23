import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createRoom, getRoom, joinRoom, getRoomView, setReady, bindConnection, unbindConnection, rooms } from './game/roomManager.js';
import { buildYourRolePayload } from './game/yourRole.js';
import { startGame, advanceNight, getCurrentNightStep, nominate, skipNomination, vote, tallyVotes, execute, maybeFinishDay, submitNightAction, computeChefPairsForSeat, computeEmpathCountForSeat, formatUndertakerInfoForSeat, formatWasherLibrarianInvestigator, checkWin, getShownCharacterId, resolveRavenkeeperNightInfo, finishNightAndGotoDay } from './game/gameEngine.js';
import { getStorytellerLlmKeyInfo, storytellerLlmSelfTest, getStorytellerMediatedNightTargets, answerPostGameQuestion } from './ai/storyteller.js';
import { aiPlayerLlmAvailable, decideAiPlayerDayPlan, decideAiPlayerNightTargets, getAiPlayerLlmKeyInfo, aiPlayerLlmSelfTest, answerPostGamePlayerQuestion } from './ai/playerAgent.js';
import type { AiPlayerDebugEvent } from './ai/playerAgent.js';
import { runNightLoop as runAutomatedNightLoop } from './night/runNightLoop.js';
import { pushReplay, buildReplayBundle, seatLabel, pushPublic } from './game/replay.js';
import type { GamePhase } from './game/types.js';
import { troubleBrewing } from './script/troubleBrewing.js';
import { createInvocation, updateInvocation } from './ai/invocationLog.js';
import type { AiInvocationRecord } from './ai/invocationLog.js';

function normalizeGodQuery(text: string): string {
  return text.trim().replace(/\s+/g, '');
}

function makeDeterministicGodReply(room: import('./game/types.js').Room, seatIndex: number, queryRaw: string): string {
  const query = normalizeGodQuery(queryRaw);
  const p = room.players[seatIndex];
  if (!p) return '上帝：……';
  if (room.status !== 'playing') return '上帝：……';
  if (room.phase !== 'night' && room.phase !== 'first_night') return '上帝：现在不是夜晚。';
  if (query !== '今晚信息' && query !== '信息' && query !== '今晚' && query !== '结果') return '上帝：你现在得不到更多信息。';

  const shown = getShownCharacterId(p);
  if (!shown) return '上帝：……';

  if (!p.isAlive) return '上帝：你已死亡。';

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
    if (!decision) return `${room.script.characters.find((c) => c.id === shown)?.nameZh ?? shown}：无信息`;
    return formatWasherLibrarianInvestigator(room, shown, decision);
  }
  if (shown === 'ravenkeeper') {
    const msg = resolveRavenkeeperNightInfo(room, seatIndex);
    return msg || '守鸦人：无信息';
  }

  return '上帝：你现在得不到更多信息。';
}

function pushChat(room: import('./game/types.js').Room, entry: Omit<import('./game/types.js').ChatEntry, 'id'>): import('./game/types.js').ChatEntry {
  const full = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
  room.chatLog.push(full);
  if (room.chatLog.length > 500) room.chatLog = room.chatLog.slice(-500);
  return full;
}

function broadcastChat(roomId: string, entry: import('./game/types.js').ChatEntry): void {
  if (entry.scope === 'god') {
    sendToSeat(roomId, entry.fromSeat, { type: 'chat_event', entry });
    return;
  }
  if (entry.scope === 'dm') {
    sendToSeat(roomId, entry.fromSeat, { type: 'chat_event', entry });
    if (typeof entry.toSeat === 'number') sendToSeat(roomId, entry.toSeat, { type: 'chat_event', entry });
    return;
  }
  if (entry.scope === 'public') {
    broadcast(roomId, { type: 'chat_event', entry });
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const HTTP_PORT = Number(process.env.PORT ?? '') || 3001;

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
  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode').replace(/\/+$/, '');
  res.json({
    enabled: useFlag && !!process.env.OPENAI_API_KEY,
    useAiFlag: useFlag,
    hasApiKey: !!process.env.OPENAI_API_KEY,
    baseUrl,
  });
});

// 开发辅助：自检大模型调用（说书人 / AI 玩家）
app.get('/api/dev/llm/health', (_req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });
  res.json({
    storyteller: getStorytellerLlmKeyInfo(),
    aiPlayer: getAiPlayerLlmKeyInfo(),
    baseUrl: (process.env.OPENAI_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode').replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
  });
});

app.post('/api/dev/llm/test-storyteller', async (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });
  const prompt = typeof req.body?.prompt === 'string' ? String(req.body.prompt) : undefined;
  const timeoutMs = Number.isFinite(req.body?.timeoutMs) ? Number(req.body.timeoutMs) : undefined;
  res.json(await storytellerLlmSelfTest({ prompt, timeoutMs }));
});

app.post('/api/dev/llm/test-ai-player', async (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });
  const prompt = typeof req.body?.prompt === 'string' ? String(req.body.prompt) : undefined;
  const timeoutMs = Number.isFinite(req.body?.timeoutMs) ? Number(req.body.timeoutMs) : undefined;
  res.json(await aiPlayerLlmSelfTest({ prompt, timeoutMs }));
});

// 开发辅助：一键创建房间并自动加入/准备 N 个玩家（可选直接开局）
app.post('/api/dev/quickstart', async (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });

  const scriptId = (req.body?.scriptId as string) || troubleBrewing.id;
  const playerCountRaw = req.body?.playerCount;
  const playerCount = Number.isInteger(playerCountRaw) ? (playerCountRaw as number) : 5;
  const start = req.body?.start === false ? false : true;

  const room = createRoom(scriptId);
  const nickPrefix = ['夜行', '钟声', '雾隐', '火漆', '预言', '静默', '迷踪', '秘钥', '月影', '余烬'];
  const nickSuffix = ['守夜人', '提名王', '验人师', '反转侠', '沉默狼', '谜语客', '夜鸦', '推理官', '投票手', '烛火'];
  const players: Array<{ seatIndex: number; nickname: string }> = [];
  for (let i = 0; i < playerCount; i++) {
    const nickname = `${nickPrefix[i % nickPrefix.length]}${nickSuffix[i % nickSuffix.length]}${Math.floor(Math.random() * 90) + 10}`;
    const j = joinRoom(room.id, nickname);
    if (!j) break;
    setReady(room, j.seatIndex, true);
    players.push({ seatIndex: j.seatIndex, nickname });
  }

  if (start) {
    const ok = startGame(room);
    if (!ok) return res.status(400).json({ error: 'Cannot start game' });
    pushReplay(room, 'setup', '对局', `游戏开始：${room.players.length} 人，剧本「${room.script.nameZh}」。`);
    pushPublic(room, `游戏开始：${room.players.length} 人，剧本「${room.script.nameZh}」。`);
    pushReplay(room, 'first_night', '首夜', '进入首夜。');
    pushReplay(room, 'first_night', '首夜', '本夜仅有信息步骤（剧本：无恶魔杀人）；恶魔首次刀人在下一普通夜。');
    // 重要：quickstart 不能被大模型调用阻塞，否则前端按钮表现为“无反应/超时”
    // 夜晚推进放到后台执行，先返回 joinUrls/adminUrl 让测试页能立即打开
    void (async () => {
      const phaseBeforeLoop = room.phase;
      await runNightLoopExclusive(room.id, room);
      if (room.status !== 'ended') {
        if (room.phase === 'first_night') {
          sendEvilInfo(room.id, room);
        }
        sendNightPrompt(room.id, room);
      }
      broadcastAfterNight(room.id, room, phaseBeforeLoop);
      broadcastNightConfirm(room.id, room);
    })();
  }

  // 返回给前端打开的新标签页 URL 应指向“前端站点”而不是后端 3001（否则会出现 Cannot GET /）。
  // 优先使用 Origin / Referer（一般来自前端 5173），再退回到 X-Forwarded-*，最后兜底本地 5173。
  const origin = (req.headers.origin as string | undefined) ?? '';
  const referer = (req.headers.referer as string | undefined) ?? '';
  let base =
    origin
    || (() => {
      try {
        const u = new URL(referer);
        return u.origin;
      } catch {
        return '';
      }
    })()
    || (() => {
      const xfProto = (req.headers['x-forwarded-proto'] as string | undefined) ?? '';
      const xfHost = (req.headers['x-forwarded-host'] as string | undefined) ?? '';
      return xfProto && xfHost ? `${xfProto}://${xfHost}` : '';
    })()
    || 'http://localhost:5173';
  // 通过 Vite 代理访问时，host 往往仍是 3001，导致返回的链接指向后端而出现 Cannot GET /。
  // 本地 dev 场景下直接兜底到前端 5173。
  if (/:(3001)$/.test(String(req.get('host') ?? '')) && !/:(5173|5174)$/.test(base)) base = 'http://localhost:5173';
  const joinUrls = players.map((p) => `${base}/?autoJoin=1&autoAi=1&roomId=${encodeURIComponent(room.id)}&nickname=${encodeURIComponent(p.nickname)}`);
  const adminUrl = `${base}/?admin=1&roomId=${encodeURIComponent(room.id)}&hostSecret=${encodeURIComponent(room.hostSecret)}`;
  res.json({ roomId: room.id, hostSecret: room.hostSecret, players, joinUrls, adminUrl, started: start });
});

// 开发辅助：快速“进入已存在座位”（quickstart 先加人再开局时，新标签页不能再走 /join）
app.post('/api/dev/take-seat', (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });

  const rid = String(req.body?.roomId ?? '');
  const nickname = String(req.body?.nickname ?? '').trim();
  if (!rid || !nickname) return res.status(400).json({ error: 'roomId and nickname required' });
  const room = getRoom(rid);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const seatIndex = room.players.find((p) => p.nickname === nickname)?.seatIndex;
  if (seatIndex == null) return res.status(404).json({ error: 'Seat not found' });
  const view = getRoomView(room);
  res.json({ roomId: rid, seatIndex, room: view });
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
  // 幂等：避免后台夜晚推进/重入导致同一条夜间信息重复刷入复盘与下发
  const dk = 'night_info_dedup';
  const v = room.storytellerDecisions.get(dk);
  const set: Set<string> = v instanceof Set ? (v as Set<string>) : new Set<string>();
  if (!(v instanceof Set)) room.storytellerDecisions.set(dk, set);
  const stamp = `${room.phase}|day=${room.dayNumber}|seat=${seatIndex}|msg=${message}`;
  if (set.has(stamp)) return;
  set.add(stamp);

  const { key, title } = nightReplayTitle(room);
  pushReplay(room, key, title, `[夜间信息] ${seatLabel(room, seatIndex)}：${message}`);
  const log = getNightInfoLogBySeat(room);
  const prev = log.get(seatIndex) ?? [];
  prev.push(message);
  log.set(seatIndex, prev.slice(-NIGHT_INFO_LOG_LIMIT));
  sendToSeat(roomId, seatIndex, { type: 'night_info', message });
}

function buildNightLoopOptions(roomId: string, room: import('./game/types.js').Room) {
  const traceIdByKey = new Map<string, string>();
  return {
    sendNightInfo,
    onStorytellerDebug: (payload: {
      roomId: string;
      seatIndex: number | null;
      stepId: string;
      phase: string;
      debug: { kind: 'request' | 'response' | 'error'; model: string; systemPrompt?: string; userPrompt?: string; rawResponse?: string; elapsedMs?: number; error?: string };
      appliedDecision?: unknown;
    }) => {
      const key = `${payload.stepId}:${payload.seatIndex ?? -1}:${payload.phase}`;
      const model = payload.debug.model || (process.env.OPENAI_MODEL ?? 'qwen3.5-plus');
      if (payload.debug.kind === 'request') {
        const requestText = toTraceText({
          systemPrompt: payload.debug.systemPrompt,
          userPrompt: payload.debug.userPrompt,
        });
        const rec = createInvocation(room, {
          actor: 'storyteller',
          stage: 'storyteller_decision',
          roomId,
          seatIndex: payload.seatIndex,
          phase: payload.phase,
          stepId: payload.stepId,
          model,
          status: 'started',
          request: requestText,
        });
        traceIdByKey.set(key, rec.id);
        sendAiTrace(roomId, null, rec);
        return;
      }
      const traceId = traceIdByKey.get(key);
      if (!traceId) return;
      if (payload.debug.kind === 'response') {
        const rec = updateInvocation(room, traceId, {
          status: payload.appliedDecision !== undefined ? 'applied' : 'responded',
          elapsedMs: payload.debug.elapsedMs,
          response: payload.debug.rawResponse ? toTraceText(payload.debug.rawResponse) : undefined,
          behavior: payload.appliedDecision !== undefined ? `appliedDecision=${toTraceText(payload.appliedDecision)}` : undefined,
        });
        if (rec) sendAiTrace(roomId, null, rec);
        return;
      }
      const rec = updateInvocation(room, traceId, {
        status: 'error',
        error: payload.debug.error ?? 'unknown_error',
      });
      if (rec) sendAiTrace(roomId, null, rec);
    },
  };
}

function maybeLogDawn(room: import('./game/types.js').Room, phaseBefore: GamePhase): void {
  if (phaseBefore !== 'first_night' && phaseBefore !== 'night') return;
  /** 正常天亮为 day；夜间结束时若胜负已判则 phase 会变为 waiting，仍需记录天亮公布的死亡 */
  const dawnLike = room.phase === 'day' || (room.status === 'ended' && room.phase === 'waiting');
  if (!dawnLike) return;

  // 幂等：避免同一“天亮公布”在多次 broadcastAfterNight 中重复写入复盘
  const mk = `dawn_logged_day_${room.dayNumber}`;
  if (room.storytellerDecisions.get(mk) === true) return;
  room.storytellerDecisions.set(mk, true);

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
      emitGameOver(roomId, room, win);
    }
    return;
  }
  broadcast(roomId, { type: 'room', room: getRoomView(room) });
  broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
}

function emitGameOver(roomId: string, room: import('./game/types.js').Room, winner: 'good' | 'evil'): void {
  const k = 'game_over_sent';
  if (room.storytellerDecisions.get(k) === true) return;
  room.storytellerDecisions.set(k, true);

  // 下一局默认未准备：避免“结束后所有人都显示已准备”
  for (const p of room.players) p.isReady = false;

  pushReplay(room, 'result', '游戏结束', `${winner === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);
  const replay = buildReplayBundle(room, winner);
  broadcast(roomId, { type: 'game_over', winner, room: getRoomView(room), replay });
}

function maybeLogEnterNight(room: import('./game/types.js').Room, phaseBefore: GamePhase): void {
  if (room.phase !== 'night' || phaseBefore !== 'day') return;
  const { key, title } = nightReplayTitle(room);
  pushReplay(room, key, title, '进入夜晚。');
}

const AI_DIRECTOR_LOG = process.env.AI_DIRECTOR_LOG === 'true' || process.env.AI_DIRECTOR_LOG === '1';
const lastDirectorDebugAt = new Map<string, number>();
const FALLBACK_NIGHT_ACTION_TIMEOUT_MS = Number(process.env.FALLBACK_NIGHT_ACTION_TIMEOUT_MS ?? '') || 60_000;
const FALLBACK_NIGHT_CONFIRM_TIMEOUT_MS = Number(process.env.FALLBACK_NIGHT_CONFIRM_TIMEOUT_MS ?? '') || 45_000;
const FALLBACK_DAY_VOTE_TIMEOUT_MS = Number(process.env.FALLBACK_DAY_VOTE_TIMEOUT_MS ?? '') || 60_000;
const FALLBACK_DAY_TURN_TIMEOUT_MS = Number(process.env.FALLBACK_DAY_TURN_TIMEOUT_MS ?? '') || 60_000;
const DAY_FLOW_STAGES: Array<import('./game/types.js').DayFlowStage> = [
  'god_dialogue',
  'private_dialogue',
  'public_speech',
  'nomination_vote',
];
const NIGHT_MEDIATED_STEP_IDS = new Set(['imp', 'monk', 'poisoner', 'fortune_teller']);

function directorBlockSummary(room: import('./game/types.js').Room): string {
  if (room.status !== 'playing') return 'not_playing';
  if (room.phase === 'night' || room.phase === 'first_night') {
    if (room.pendingNightAction) {
      return `night_action_pending:${room.pendingNightAction.stepId}@${room.pendingNightAction.actorSeatIndex}`;
    }
    if (room.awaitingNightConfirm) return 'awaiting_night_confirm';
    return `night_step:${getCurrentNightStep(room) ?? 'null'}@idx${room.nightStepIndex}`;
  }
  if (room.phase === 'day') {
    if (room.currentNomination) {
      return `voting:${room.currentNomination.nominator}->${room.currentNomination.nominated}`;
    }
    return `day:${room.daySubPhase}`;
  }
  return String(room.phase);
}

function maybeLogDirectorDebug(roomId: string, room: import('./game/types.js').Room): void {
  if (!AI_DIRECTOR_LOG || room.status !== 'playing') return;
  const now = Date.now();
  const prev = lastDirectorDebugAt.get(roomId) ?? 0;
  if (now - prev < 5000) return;
  lastDirectorDebugAt.set(roomId, now);
  console.log('[director]', { roomId, block: directorBlockSummary(room), aiFlowAssist: room.aiStorytellerEnabled });
}

function getFallbackClock(room: import('./game/types.js').Room): { key: string; since: number } {
  const now = Date.now();
  const key = `phase=${room.phase}|sub=${room.daySubPhase}|flow=${room.dayFlowStage}|flowStart=${room.dayFlowStartSeat}|nom=${room.currentNomination ? `${room.currentNomination.nominator}-${room.currentNomination.nominated}` : 'none'}|pendingNight=${room.pendingNightAction ? `${room.pendingNightAction.stepId}@${room.pendingNightAction.actorSeatIndex}` : 'none'}|awaitingConfirm=${room.awaitingNightConfirm}`;
  const prevKey = String(room.storytellerDecisions.get('fallback_clock_key') ?? '');
  const prevSince = Number(room.storytellerDecisions.get('fallback_clock_since') ?? now);
  if (prevKey !== key) {
    room.storytellerDecisions.set('fallback_clock_key', key);
    room.storytellerDecisions.set('fallback_clock_since', now);
    return { key, since: now };
  }
  return { key, since: prevSince };
}

function orderedAliveSeats(room: import('./game/types.js').Room, startSeat: number | null): number[] {
  const alive = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex).sort((a, b) => a - b);
  if (alive.length === 0) return [];
  if (startSeat == null || !alive.includes(startSeat)) return alive;
  const idx = alive.indexOf(startSeat);
  return [...alive.slice(idx), ...alive.slice(0, idx)];
}

function getDayFlowDoneSet(room: import('./game/types.js').Room, stage: import('./game/types.js').DayFlowStage): Set<number> {
  const key = `day_flow_done_${room.dayNumber}_${stage}`;
  const v = room.storytellerDecisions.get(key);
  if (v instanceof Set) return v as Set<number>;
  const s = new Set<number>();
  room.storytellerDecisions.set(key, s);
  return s;
}

function getDayFlowCursor(room: import('./game/types.js').Room, stage: import('./game/types.js').DayFlowStage): number {
  const key = `day_flow_cursor_${room.dayNumber}_${stage}`;
  return Number(room.storytellerDecisions.get(key) ?? 0);
}

function setDayFlowCursor(room: import('./game/types.js').Room, stage: import('./game/types.js').DayFlowStage, cursor: number): void {
  const key = `day_flow_cursor_${room.dayNumber}_${stage}`;
  room.storytellerDecisions.set(key, cursor);
}

function dayPlanTraceKey(dayNumber: number, seatIndex: number): string {
  return `ai_day_plan_trace_id_${dayNumber}_${seatIndex}`;
}

function appendBehavior(
  roomId: string,
  room: import('./game/types.js').Room,
  seatIndex: number,
  traceId: string | null,
  part: string,
): void {
  if (!traceId) return;
  const prev = (room.storytellerDecisions.get(`${traceId}_behavior`) as string | undefined) ?? '';
  const next = prev ? `${prev}; ${part}` : part;
  room.storytellerDecisions.set(`${traceId}_behavior`, next);
  const rec = updateInvocation(room, traceId, { behavior: next });
  if (rec) sendAiTrace(roomId, seatIndex, rec);
}

function isNightMediatedStepId(stepId: string): stepId is 'imp' | 'monk' | 'poisoner' | 'fortune_teller' {
  return NIGHT_MEDIATED_STEP_IDS.has(stepId);
}

function moveToNextDayFlowStage(room: import('./game/types.js').Room): void {
  if (room.dayFlowStage == null) return;
  const idx = DAY_FLOW_STAGES.indexOf(room.dayFlowStage);
  const next = DAY_FLOW_STAGES[idx + 1] ?? null;
  room.dayFlowStage = next;
  room.dayFlowStartSeat = room.players.filter((p) => p.isAlive).length > 0
    ? room.players.filter((p) => p.isAlive)[Math.floor(Math.random() * room.players.filter((p) => p.isAlive).length)].seatIndex
    : null;
  if (next === 'nomination_vote') {
    room.daySubPhase = 'nomination';
    pushPublic(room, '进入白天阶段：提名与投票。');
  } else if (next != null) {
    room.daySubPhase = 'discussion';
    const stageZh =
      next === 'private_dialogue'
        ? '玩家私聊'
        : next === 'public_speech'
          ? '公开发言'
          : '上帝问答';
    pushPublic(room, `进入白天阶段：${stageZh}。`);
  }
}

function maybeAdvanceStructuredDay(roomId: string, room: import('./game/types.js').Room): void {
  if (room.phase !== 'day' || room.status !== 'playing') return;
  if (room.dayFlowStage == null) return;
  if (room.dayFlowStage === 'nomination_vote') return;
  if (room.currentNomination) return;

  const stage = room.dayFlowStage;
  const queue = orderedAliveSeats(room, room.dayFlowStartSeat);
  const done = getDayFlowDoneSet(room, stage);
  if (queue.length === 0) return;
  const cursor = Math.max(0, Math.min(getDayFlowCursor(room, stage), queue.length - 1));
  const actor = queue[cursor];
  if (!done.has(actor)) {
    done.add(actor);
    if (stage === 'god_dialogue') {
      pushPublic(room, `白天流程：${seatLabel(room, actor)} 完成上帝问答。`);
    } else if (stage === 'private_dialogue') {
      pushPublic(room, `白天流程：${seatLabel(room, actor)} 完成私聊阶段。`);
    } else if (stage === 'public_speech') {
      pushPublic(room, `白天流程：${seatLabel(room, actor)} 完成公开发言。`);
    }
  }
  setDayFlowCursor(room, stage, cursor + 1);
  const allDone = queue.every((s) => done.has(s));
  if (allDone) {
    moveToNextDayFlowStage(room);
  }
  broadcast(roomId, { type: 'room', room: getRoomView(room) });
}

function fillMissingVotesAsAgainst(room: import('./game/types.js').Room): number {
  const eligible = room.players.filter((p) => p.isAlive || p.hasDeadVote).map((p) => p.seatIndex);
  let filled = 0;
  for (const seat of eligible) {
    if (room.votes.has(seat)) continue;
    room.votes.set(seat, false);
    filled++;
  }
  return filled;
}

function skipRemainingAlivePlayers(room: import('./game/types.js').Room): number {
  const alive = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
  let skipped = 0;
  for (const seat of alive) {
    if (room.nominationsToday.has(seat) || room.skippedNominationsToday.has(seat)) continue;
    room.skippedNominationsToday.add(seat);
    skipped++;
  }
  return skipped;
}

function enforceProgressFallback(roomId: string, room: import('./game/types.js').Room): void {
  if (room.status !== 'playing') return;
  const now = Date.now();
  const { since } = getFallbackClock(room);
  const stuckMs = now - since;

  if ((room.phase === 'night' || room.phase === 'first_night') && room.pendingNightAction && stuckMs >= FALLBACK_NIGHT_ACTION_TIMEOUT_MS) {
    const pending = room.pendingNightAction;
    const actor = pending.actorSeatIndex;
    const aliveAll = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
    const candidate = pending.stepId === 'imp' ? aliveAll.filter((s) => s !== actor) : aliveAll;
    const targets: number[] = [];
    for (let i = 0; i < pending.pick; i++) {
      const remain = candidate.filter((s) => !targets.includes(s));
      if (remain.length === 0) break;
      targets.push(remain[Math.floor(Math.random() * remain.length)]);
    }
    if (targets.length === pending.pick) {
      const result = submitNightAction(room, actor, targets);
      if (result.ok) {
        pushPublic(room, `兜底推进：${seatLabel(room, actor)} 夜晚超时，系统自动提交行动。`);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
      }
    }
    return;
  }

  if ((room.phase === 'night' || room.phase === 'first_night') && room.awaitingNightConfirm && stuckMs >= FALLBACK_NIGHT_CONFIRM_TIMEOUT_MS) {
    const allSeats = room.players.map((p) => p.seatIndex);
    for (const s of allSeats) room.nightConfirmations.add(s);
    finishNightAndGotoDay(room);
    pushPublic(room, '兜底推进：夜晚确认超时，系统自动进入白天。');
    broadcast(roomId, { type: 'room', room: getRoomView(room) });
    broadcast(roomId, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
    return;
  }

  if (room.phase === 'day' && room.currentNomination && stuckMs >= FALLBACK_DAY_VOTE_TIMEOUT_MS) {
    const filled = fillMissingVotesAsAgainst(room);
    const { passed, votesFor, votes } = tallyVotes(room);
    pushPublic(room, `兜底推进：投票超时，系统为未投玩家默认反对（${filled} 人），并自动结算。`);
    broadcast(roomId, { type: 'vote_result', passed, votesFor, votes });
    broadcast(roomId, { type: 'room', room: getRoomView(room) });
    const phaseBefore = room.phase;
    const fin = maybeFinishDay(room);
    if (fin.ended) void handleDayMaybeEnterNight(roomId, room, phaseBefore, fin.executedSeatIndex);
    return;
  }

  const canFallbackNominationTurn = room.dayFlowStage == null || room.dayFlowStage === 'nomination_vote';
  if (room.phase === 'day' && canFallbackNominationTurn && room.currentNomination === null && stuckMs >= FALLBACK_DAY_TURN_TIMEOUT_MS) {
    const skipped = skipRemainingAlivePlayers(room);
    if (skipped > 0) {
      pushPublic(room, `兜底推进：白天决策超时，系统自动为 ${skipped} 名玩家标记“本轮不提名”。`);
      broadcast(roomId, { type: 'room', room: getRoomView(room) });
    }
    const phaseBefore = room.phase;
    const fin = maybeFinishDay(room);
    if (fin.ended) void handleDayMaybeEnterNight(roomId, room, phaseBefore, fin.executedSeatIndex);
  }
}

/** 流程辅助（计时推进投票结算、无阻塞时推进夜序）：与 Grimoire LLM 说书人裁量解耦；`maybeFinishDay` 仍在各座位逻辑之后由宿主调用 */
function tickFlowDirector(roomId: string, room: import('./game/types.js').Room): void {
  maybeLogDirectorDebug(roomId, room);
  maybeAdvanceStructuredDay(roomId, room);
  enforceProgressFallback(roomId, room);
  if (room.aiStorytellerEnabled) {
    if (room.phase === 'day') maybeAiTakeoverDay(roomId, room);
    else if (room.phase === 'night' || room.phase === 'first_night') void maybeAiTakeoverNight(roomId, room);
  }
}

const server = createServer(app);
const wss = new WebSocketServer({ server });
const nightLoopInFlightByRoom = new Map<string, Promise<void>>();

type ClientMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'start' }
  | { type: 'nominate'; nominatedSeat: number }
  | { type: 'skip_nomination' }
  | { type: 'vote'; inFavor: boolean }
  | { type: 'chat_send'; scope: 'god' | 'dm' | 'public'; toSeat?: number; text: string }
  | { type: 'toggle_ai_player'; enabled: boolean }
  | { type: 'set_ai_player_temperature'; temperature: number }
  | { type: 'night_confirm' }
  | { type: 'night_action'; targets: number[] }
  | { type: 'day_action'; actionId: string; targetSeat?: number }
  | { type: 'toggle_ai_storyteller'; enabled: boolean }
  | { type: 'post_game_ask_god'; question: string }
  | { type: 'post_game_ask_player'; targetSeatIndex: number; question: string }
  | { type: 'ping' };

async function handleDayMaybeEnterNight(roomId: string, room: import('./game/types.js').Room, phaseBefore: GamePhase, executedSeatIndex: number | null): Promise<void> {
  if (room.status === 'ended') {
    const win = checkWin(room);
    if (win) emitGameOver(roomId, room, win);
    return;
  }
  const { key, title } = dayReplayTitle(room);
  if (executedSeatIndex != null) {
    pushReplay(room, key, title, `处决执行：${seatLabel(room, executedSeatIndex)} 死亡。`);
    pushPublic(room, `处决执行：${seatLabel(room, executedSeatIndex)} 死亡。`);
  } else {
    pushReplay(room, key, title, '今日无人被处决。');
    pushPublic(room, '今日无人被处决。');
  }
  maybeLogEnterNight(room, phaseBefore);
  if (room.phase === 'night') pushPublic(room, '进入夜晚。');
  const phaseBeforeLoop = room.phase;
  await runNightLoopExclusive(roomId, room);
  if (room.phase !== 'waiting') sendNightPrompt(roomId, room);
  broadcastAfterNight(roomId, room, phaseBeforeLoop);
  broadcastNightConfirm(roomId, room);
}

function maybeAiTakeoverDay(roomId: string, room: import('./game/types.js').Room): void {
  if (room.phase !== 'day' || room.status !== 'playing') return;
  const now = Date.now();
  if (now - room.aiLastActionAt < 2400) return;
  const { key, title } = dayReplayTitle(room);

  if (room.daySubPhase === 'nomination') {
    if (!room.currentNomination) return;
    // 仅主持“结束投票并结算”，不替玩家投票或发起提名。
    // 严格要求：所有可投票玩家都完成选择后，才结束投票。
    const eligibleVoters = room.players.filter((p) => p.isAlive || p.hasDeadVote).map((p) => p.seatIndex);
    const allVoted = eligibleVoters.every((seat) => room.votes.has(seat));
    if (!allVoted) return;
    if (now - room.aiLastActionAt < 9000) return;
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

async function maybeAiTakeoverNight(roomId: string, room: import('./game/types.js').Room): Promise<void> {
  if (room.status !== 'playing' || (room.phase !== 'night' && room.phase !== 'first_night')) return;
  // 严格边界：夜晚若轮到玩家行动，AI 说书人只等待，不代替玩家提交目标
  if (room.pendingNightAction) return;
  if (room.awaitingNightConfirm) return;
  const phaseBeforeLoop = room.phase;
  await runNightLoopExclusive(roomId, room);
  // 自动夜序可能推进到“等待玩家输入”，此处只发提示、不代替玩家提交
  sendNightPrompt(roomId, room);
  broadcastAfterNight(roomId, room, phaseBeforeLoop);
  broadcastNightConfirm(roomId, room);
}

async function runNightLoopExclusive(roomId: string, room: import('./game/types.js').Room): Promise<void> {
  const existing = nightLoopInFlightByRoom.get(roomId);
  if (existing) {
    room.storytellerDecisions.set('night_loop_rerun_pending', true);
    await existing;
    return;
  }
  const task = (async () => {
    for (;;) {
      room.storytellerDecisions.set('night_loop_rerun_pending', false);
      await runAutomatedNightLoop(roomId, room, buildNightLoopOptions(roomId, room));
      const rerun = room.storytellerDecisions.get('night_loop_rerun_pending') === true;
      if (!rerun) break;
      if (room.phase !== 'night' && room.phase !== 'first_night') break;
      if (room.pendingNightAction || room.awaitingNightConfirm) break;
    }
  })().finally(() => {
    nightLoopInFlightByRoom.delete(roomId);
  });
  nightLoopInFlightByRoom.set(roomId, task);
  await task;
}

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
        p = {
          ...(payload as object),
          room: getRoomView(room, seatIndex, false),
          yourCharacterId,
          yourRole,
          yourSeatIndex: seatIndex,
          isHost: !!ws.isHost,
        } as Record<string, unknown>;
      } else if ((type === 'room' || type === 'game_over') && (payload as any).room && ws.isAdmin) {
        p = {
          ...(payload as object),
          room: getRoomView(room, undefined, true),
          isHost: !!ws.isHost,
          isAdmin: true,
        } as Record<string, unknown>;
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

function toTraceText(v: unknown, maxLen = 50000): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  } catch {
    return String(v);
  }
}

function sendAiTrace(roomId: string, seatIndex: number | null, entry: AiInvocationRecord): void {
  if (seatIndex == null) {
    broadcast(roomId, { type: 'ai_trace', entry });
    return;
  }
  sendToSeat(roomId, seatIndex, { type: 'ai_trace', entry });
}

function toFullPromptDebugText(e: AiPlayerDebugEvent): string {
  return JSON.stringify(
    {
      stage: e.stage,
      kind: e.kind,
      seatIndex: e.seatIndex,
      systemPrompt: e.systemPrompt,
      userPrompt: e.userPrompt,
      messages: e.messages,
      elapsedMs: e.elapsedMs,
    },
    null,
    2,
  );
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

function broadcastNightConfirm(roomId: string, room: import('./game/types.js').Room): void {
  broadcast(roomId, {
    type: 'night_confirm_update',
    awaiting: room.awaitingNightConfirm,
    confirmedSeats: Array.from(room.nightConfirmations.values()),
  });
}

const NIGHT_INFO_LOG_LIMIT = 20;
function getNightInfoLogBySeat(room: import('./game/types.js').Room): Map<number, string[]> {
  const k = 'night_info_log_by_seat';
  const v = room.storytellerDecisions.get(k);
  if (v instanceof Map) return v as Map<number, string[]>;
  const m = new Map<number, string[]>();
  room.storytellerDecisions.set(k, m);
  return m;
}

function getAiSharedNightInfoCursor(room: import('./game/types.js').Room): Map<number, number> {
  const k = 'ai_shared_nightinfo_cursor';
  const v = room.storytellerDecisions.get(k);
  if (v instanceof Map) return v as Map<number, number>;
  const m = new Map<number, number>();
  room.storytellerDecisions.set(k, m);
  return m;
}

type AiTrustDelta = { seatIndex: number; delta: number };

function getAiTrustScores(room: import('./game/types.js').Room, viewerSeatIndex: number): Map<number, number> {
  const k = `ai_trust_scores_${viewerSeatIndex}`;
  const v = room.storytellerDecisions.get(k);
  if (v instanceof Map) return v as Map<number, number>;
  const m = new Map<number, number>();
  for (const p of room.players) m.set(p.seatIndex, 0);

  // 初始：自己是善/恶固定为“已知真值”
  const shown = getShownCharacterId(room.players[viewerSeatIndex]);
  const char = shown ? room.script.characters.find((c) => c.id === shown) : undefined;
  const alignment = (char?.alignment ?? 'good') as 'good' | 'evil';
  m.set(viewerSeatIndex, alignment === 'evil' ? -2 : 2);

  room.storytellerDecisions.set(k, m);
  return m;
}

function getRoleAlignmentByNameZh(room: import('./game/types.js').Room, roleZh: string): 'good' | 'evil' | null {
  const c = room.script.characters.find((x) => x.nameZh === roleZh);
  if (!c) return null;
  return (c.alignment ?? 'good') as 'good' | 'evil';
}

function parseNightInfoToTrustDeltas(room: import('./game/types.js').Room, infoText: string): AiTrustDelta[] {
  // 默认空：只在能稳定解析出“指向某些座位”的信息时更新。
  const out: AiTrustDelta[] = [];

  const undertaker = infoText.match(/^掘墓人：今日被处决的是 #(\d+)，其身份为「([^」]+)」/);
  if (undertaker) {
    const seatNum = Number(undertaker[1]);
    const roleZh = undertaker[2];
    const alignment = getRoleAlignmentByNameZh(room, roleZh);
    if (Number.isInteger(seatNum) && seatNum >= 1 && seatNum <= room.players.length && alignment) {
      out.push({ seatIndex: seatNum - 1, delta: alignment === 'evil' ? -2 : +1 });
    }
    return out;
  }

  const ravenkeeper = infoText.match(/^守鸦人：杀害你的是 #(\d+)，其身份为「([^」]+)」/);
  if (ravenkeeper) {
    const seatNum = Number(ravenkeeper[1]);
    const roleZh = ravenkeeper[2];
    const alignment = getRoleAlignmentByNameZh(room, roleZh);
    if (Number.isInteger(seatNum) && seatNum >= 1 && seatNum <= room.players.length && alignment) {
      out.push({ seatIndex: seatNum - 1, delta: alignment === 'evil' ? -2 : +1 });
    }
    return out;
  }

  const fortune = infoText.match(/^占卜师：你选择了 #(\d+) 与 #(\d+)，结果为「([^」]+)」/);
  if (fortune) {
    const aNum = Number(fortune[1]);
    const bNum = Number(fortune[2]);
    const resultText = fortune[3] ?? '';
    const delta = resultText.startsWith('是') ? -2 : +1;
    if (
      Number.isInteger(aNum) &&
      Number.isInteger(bNum) &&
      aNum >= 1 &&
      bNum >= 1 &&
      aNum <= room.players.length &&
      bNum <= room.players.length
    ) {
      out.push({ seatIndex: aNum - 1, delta });
      out.push({ seatIndex: bNum - 1, delta });
    }
    return out;
  }

  const washerLike = infoText.match(/^.+：在 #(\d+) 与 #(\d+) 中，有一位是「([^」]+)」/);
  if (washerLike) {
    const aNum = Number(washerLike[1]);
    const bNum = Number(washerLike[2]);
    const roleZh = washerLike[3];
    const alignment = getRoleAlignmentByNameZh(room, roleZh);
    if (
      Number.isInteger(aNum) &&
      Number.isInteger(bNum) &&
      aNum >= 1 &&
      bNum >= 1 &&
      aNum <= room.players.length &&
      bNum <= room.players.length &&
      alignment
    ) {
      const delta = alignment === 'evil' ? -1.5 : +0.25;
      out.push({ seatIndex: aNum - 1, delta });
      out.push({ seatIndex: bNum - 1, delta });
    }
    return out;
  }

  // 首夜恶魔互认/邪恶私密（兜底时会被公开分享）：将列出的邪恶座位一律当作“真相”
  if (infoText.includes('你是恶魔') || infoText.includes('你是爪牙')) {
    const nums = Array.from(infoText.matchAll(/#(\d+)/g)).map((m) => Number(m[1]));
    for (const n of nums) {
      if (!Number.isInteger(n)) continue;
      const seatIndex = n - 1;
      if (seatIndex < 0 || seatIndex >= room.players.length) continue;
      out.push({ seatIndex, delta: -2 });
    }
    // 去重
    const best = new Map<number, number>();
    for (const d of out) best.set(d.seatIndex, (best.get(d.seatIndex) ?? 0) + d.delta);
    return Array.from(best.entries()).map(([seatIndex, delta]) => ({ seatIndex, delta }));
  }

  return out;
}

function updateAiTrustFromSharedNightInfo(room: import('./game/types.js').Room, infoText: string): void {
  const aiSeats = room.players
    .filter((p) => (room.aiPlayerEnabledBySeat.get(p.seatIndex) ?? false) && p.isAlive)
    .map((p) => p.seatIndex);
  if (aiSeats.length === 0) return;

  const deltas = parseNightInfoToTrustDeltas(room, infoText);
  if (deltas.length === 0) return;

  for (const viewerSeatIndex of aiSeats) {
    const scores = getAiTrustScores(room, viewerSeatIndex);
    for (const d of deltas) {
      if (!Number.isInteger(d.seatIndex)) continue;
      const cur = scores.get(d.seatIndex) ?? 0;
      scores.set(d.seatIndex, cur + d.delta);
    }
  }
}

function aiPickNominationTargetByTrust(room: import('./game/types.js').Room, viewerSeatIndex: number): number | null {
  const inFallbackThreshold = Number(process.env.AI_FALLBACK_TRUST_SUSPECT_THRESHOLD ?? -1);
  const scores = getAiTrustScores(room, viewerSeatIndex);
  const aliveSeats = room.players.filter((p) => p.isAlive).map((p) => p.seatIndex);
  if (aliveSeats.length === 0) return null;

  let worstSeat = viewerSeatIndex;
  let worstScore = scores.get(worstSeat) ?? 0;
  for (const seat of aliveSeats) {
    const s = scores.get(seat) ?? 0;
    if (s < worstScore) {
      worstScore = s;
      worstSeat = seat;
    }
  }

  // 若没有足够“嫌疑”，则选择不提名（让白天结束）
  if (worstScore > inFallbackThreshold) return null;
  return worstSeat;
}

function aiVoteInFavorByTrust(room: import('./game/types.js').Room, voterSeatIndex: number, nominatedSeatIndex: number): boolean {
  const inFallbackThreshold = Number(process.env.AI_FALLBACK_TRUST_SUSPECT_THRESHOLD ?? -1);
  const scores = getAiTrustScores(room, voterSeatIndex);
  const trust = scores.get(nominatedSeatIndex) ?? 0;
  // trust 越低越像“坏人”，因此 trust<=阈值时投赞成执行
  return trust <= inFallbackThreshold;
}

function isGoodInfoRole(room: import('./game/types.js').Room, seatIndex: number): boolean {
  const p = room.players[seatIndex];
  if (!p?.characterId) return false;
  const meta = room.script.characters.find((c) => c.id === p.characterId);
  if (!meta || meta.alignment !== 'good') return false;
  return ['chef', 'empath', 'fortune_teller', 'undertaker', 'washerwoman', 'librarian', 'investigator', 'ravenkeeper'].includes(meta.id);
}

function shouldPushGoodInfoAggression(room: import('./game/types.js').Room, seatIndex: number): boolean {
  if (room.phase !== 'day') return false;
  if (!isGoodInfoRole(room, seatIndex)) return false;
  const nightInfoCount = (getNightInfoLogBySeat(room).get(seatIndex) ?? []).length;
  return nightInfoCount > 0;
}

function pickMostSuspiciousAlive(room: import('./game/types.js').Room, viewerSeatIndex: number): number | null {
  const scores = getAiTrustScores(room, viewerSeatIndex);
  const aliveSeats = room.players
    .filter((p) => p.isAlive && p.seatIndex !== viewerSeatIndex)
    .map((p) => p.seatIndex);
  if (aliveSeats.length === 0) return null;
  let worstSeat = aliveSeats[0];
  let worstScore = scores.get(worstSeat) ?? 0;
  for (const seat of aliveSeats) {
    const s = scores.get(seat) ?? 0;
    if (s < worstScore) {
      worstScore = s;
      worstSeat = seat;
    }
  }
  return worstSeat;
}

function pickTopSuspiciousAlive(
  room: import('./game/types.js').Room,
  viewerSeatIndex: number,
  limit = 2,
): Array<{ seatIndex: number; score: number }> {
  const scores = getAiTrustScores(room, viewerSeatIndex);
  const alive = room.players
    .filter((p) => p.isAlive && p.seatIndex !== viewerSeatIndex)
    .map((p) => ({ seatIndex: p.seatIndex, score: scores.get(p.seatIndex) ?? 0 }));
  alive.sort((a, b) => a.score - b.score);
  return alive.slice(0, Math.max(1, limit));
}

function summarizeMyNightInfo(room: import('./game/types.js').Room, seatIndex: number): string {
  const msgs = getNightInfoLogBySeat(room).get(seatIndex) ?? [];
  if (msgs.length === 0) return '';
  const latest = String(msgs[msgs.length - 1] ?? '').trim().replace(/\s+/g, ' ');
  if (!latest) return '';
  return latest.length > 80 ? `${latest.slice(0, 80)}...` : latest;
}

function buildForcedActiveDayPlan(
  room: import('./game/types.js').Room,
  seatIndex: number,
): {
  type: 'day_plan';
  dm: Array<{ toSeat: number; text: string }>;
  public: { text: string };
  nomination: { type: 'nominate'; targetSeat: number } | { type: 'skip' };
  vote: { inFavor: boolean; reason?: string; priorityExecuteSeats?: number[] };
} {
  const topSuspicious = pickTopSuspiciousAlive(room, seatIndex, 2);
  const target = topSuspicious[0]?.seatIndex ?? null;
  const rolePush = shouldPushGoodInfoAggression(room, seatIndex);
  const targetLabel = target != null ? `#${target + 1}` : '最高嫌疑目标';
  const alt = topSuspicious[1]?.seatIndex;
  const altLabel = alt != null ? `，备选 #${alt + 1}` : '';
  const myInfo = summarizeMyNightInfo(room, seatIndex);
  const infoPart = rolePush && myInfo ? `我的夜间信息是：${myInfo}。` : '';
  const publicText = rolePush
    ? `${infoPart}基于我掌握的信息和发言矛盾，今天主推 ${targetLabel}${altLabel}，请不要分票，优先形成处决票型。`
    : `我建议大家收敛到一个最高嫌疑目标，不要分票空转。优先推进 ${targetLabel}${altLabel}。`;
  const dm: Array<{ toSeat: number; text: string }> = [];
  if (target != null) {
    for (const p of room.players) {
      if (!p.isAlive || p.seatIndex === seatIndex || p.seatIndex === target) continue;
      dm.push({
        toSeat: p.seatIndex,
        text: rolePush
          ? `我根据自己的夜间信息主推 #${target + 1}${alt != null ? `（备选 #${alt + 1}）` : ''}，请你在提名与投票阶段优先配合集中票型。`
          : `我建议今天优先推进 #${target + 1}，不要分票；你如果同意请在投票阶段配合。`,
      });
      if (dm.length >= 3) break;
    }
  }
  return {
    type: 'day_plan',
    dm,
    public: { text: publicText.slice(0, 500) },
    nomination: target != null ? { type: 'nominate', targetSeat: target } : { type: 'skip' },
    vote: {
      inFavor: false,
      reason: target != null ? '仅在提名命中优先目标时赞成处决。' : '暂未形成可执行目标。',
      priorityExecuteSeats: target != null ? [target] : [],
    },
  };
}

function isWeakPublicSpeech(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (t.length >= 40 && (t.includes('我的夜间信息') || t.includes('我昨晚') || t.includes('#'))) return false;
  const weakPatterns = [
    '我先观望',
    '简单交换信息',
    '大家也可以私聊我',
    '先听大家发言',
    '信息不足',
  ];
  return weakPatterns.some((w) => t.includes(w));
}

function buildVoteSnapshot(room: import('./game/types.js').Room): {
  currentNomination: { nominator: number; nominated: number } | null;
  votes: Array<{ seatIndex: number; inFavor: boolean }>;
  nominationsToday: Array<{ nominator: number; nominated: number }>;
  skippedNominationsToday: number[];
  aliveSeatIndices: number[];
  deadSeatIndices: number[];
} {
  return {
    currentNomination: room.currentNomination,
    votes: Array.from(room.votes.entries()).map(([seatIndex, inFavor]) => ({ seatIndex, inFavor })),
    nominationsToday: Array.from(room.nominationsToday.entries()).map(([nominator, nominated]) => ({ nominator, nominated })),
    skippedNominationsToday: Array.from(room.skippedNominationsToday.values()),
    aliveSeatIndices: room.players.filter((p) => p.isAlive).map((p) => p.seatIndex),
    deadSeatIndices: room.players.filter((p) => !p.isAlive).map((p) => p.seatIndex),
  };
}

function buildRecentVoteEvents(room: import('./game/types.js').Room): string[] {
  return room.replayLog
    .slice(-80)
    .filter((e) => e.groupKey.includes('day') && (e.line.includes('投票') || e.line.includes('提名') || e.line.includes('处决')))
    .slice(-20)
    .map((e) => e.line);
}

type AiChatSnapshot = Array<{
  scope: string;
  fromSeat: number;
  toSeat?: number;
  text: string;
  at: number;
}>;

type AiGlobalChatSnapshot = Array<{
  scope: string;
  fromSeat: number;
  toSeat?: number;
  text: string;
  at: number;
  dayNumber?: number;
  phase?: string;
}>;

function buildAiSeatContext(room: import('./game/types.js').Room, seatIndex: number): {
  roomView: ReturnType<typeof getRoomView>;
  yourCharacterId: string | null;
  yourRole: ReturnType<typeof buildYourRolePayload>;
  yourAlignment: 'good' | 'evil' | undefined;
  chatLog: AiChatSnapshot;
  allChatLog: AiGlobalChatSnapshot;
  nightInfo: string[];
} {
  const roomView = getRoomView(room, seatIndex, false);
  const roomViewGlobal = getRoomView(room, seatIndex, true);
  const yourCharacterId = getShownCharacterId(room.players[seatIndex]) ?? null;
  const yourRole = buildYourRolePayload(room, seatIndex);
  const yourAlignment = (yourRole as any)?.alignment as ('good' | 'evil' | undefined);
  const chatLog = (roomView.chatLog ?? []).map((e) => ({
    scope: e.scope,
    fromSeat: e.fromSeat,
    toSeat: e.toSeat,
    text: e.text,
    at: e.at,
  }));
  const allChatLog = (roomViewGlobal.chatLog ?? []).map((e) => ({
    scope: e.scope,
    fromSeat: e.fromSeat,
    toSeat: e.toSeat,
    text: e.text,
    at: e.at,
    dayNumber: e.dayNumber,
    phase: e.phase,
  }));
  const nightInfo = (getNightInfoLogBySeat(room).get(seatIndex) ?? []).slice(-NIGHT_INFO_LOG_LIMIT);
  return { roomView, yourCharacterId, yourRole, yourAlignment, chatLog, allChatLog, nightInfo };
}

function shouldVoteInFavorByPriority(
  room: import('./game/types.js').Room,
  seatIndex: number,
  nominatedSeat: number,
  explicitPriority: number[] | null,
): boolean {
  const priority = explicitPriority && explicitPriority.length > 0
    ? explicitPriority
    : pickTopSuspiciousAlive(room, seatIndex, 2).map((x) => x.seatIndex);
  if (priority.includes(nominatedSeat)) return true;
  const threshold = Number(process.env.AI_FALLBACK_TRUST_SUSPECT_THRESHOLD ?? -1);
  const trust = getAiTrustScores(room, seatIndex).get(nominatedSeat) ?? 0;
  return trust <= threshold;
}

function shareAiNightInfoAtDawn(roomId: string, room: import('./game/types.js').Room): void {
  if (room.status !== 'playing' || room.phase !== 'day') return;
  const log = getNightInfoLogBySeat(room);
  const cursors = getAiSharedNightInfoCursor(room);
  const inFallback = !aiPlayerLlmAvailable();
  const alwaysShare = inFallback || process.env.AI_FALLBACK_ALWAYS_SHARE === 'true';
  for (const p of room.players) {
    const seatIndex = p.seatIndex;
    if (!(room.aiPlayerEnabledBySeat.get(seatIndex) ?? false)) continue;
    const msgs = log.get(seatIndex) ?? [];
    if (msgs.length === 0) continue;
    const cursor = Math.max(0, Number(cursors.get(seatIndex) ?? 0));
    if (cursor >= msgs.length) continue;
    const pending = msgs.slice(cursor);
    const temp = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
    for (const msg of pending) {
      // 公开分享：以“公开发言”的形式发到公屏，避免与真人行为产生可观察差异；并按温度控制积极程度
      if (!(alwaysShare || Math.random() < temp)) continue;
      pushPublic(room, `公开发言：${seatLabel(room, seatIndex)}：${msg}`);
      const entry = pushChat(room, { at: Date.now(), scope: 'public', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: msg });
      broadcastChat(roomId, entry);
      // 兜底模式：大家默认信任并把信息写进“好坏人表”
      if (inFallback) updateAiTrustFromSharedNightInfo(room, msg);
    }
    cursors.set(seatIndex, msgs.length);
  }
  broadcast(roomId, { type: 'room', room: getRoomView(room) });
}

function sendEvilInfo(roomId: string, room: import('./game/types.js').Room) {
  const evilSeats = room.players.filter((p) => p.isAlive && (p.characterId === 'imp' || ['poisoner', 'spy', 'baron', 'scarlet_woman'].includes(p.characterId ?? ''))).map((p) => p.seatIndex);
  const demonSeat = room.players.find((p) => p.isAlive && p.characterId === 'imp')?.seatIndex ?? null;
  // 简化：互相告知座位号（不告知具体身份）
  for (const s of evilSeats) {
    const isDemon = s === demonSeat;
    const message = isDemon
      ? `你是恶魔。你的爪牙座位号：${evilSeats.filter((x) => x !== s).map((x) => `#${x + 1}`).join('、') || '无'}。不在场善良身份：${room.demonBluffs?.join(',') || '无'}`
      : `你是爪牙。恶魔座位号：${demonSeat != null ? `#${demonSeat + 1}` : '未知'}。其他邪恶座位号：${evilSeats.filter((x) => x !== s).map((x) => `#${x + 1}`).join('、') || '无'}`;
    // 统一走夜间信息通道：保证兜底“信息公开+写入好坏人表”可复用。
    sendNightInfo(roomId, room, s, message);
  }
}

wss.on('connection', (ws: any, req) => {
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
  if (hostSecret && hostSecret === room.hostSecret) ws.isHost = true;
  if (!adminMode) {
    const siStr = seatIndexStr as string;
    bindConnection(room, connectionId, parseInt(siStr, 10));
    const si = parseInt(siStr, 10);
    ws.send(
      JSON.stringify({
        type: 'room',
        room: getRoomView(room),
        yourSeatIndex: si,
        yourCharacterId: getShownCharacterId(room.players[si]),
        yourRole: buildYourRolePayload(room, si),
        isHost: ws.isHost,
        isAdmin: false,
      }),
    );
  } else {
    ws.send(
      JSON.stringify({
        type: 'room',
        room: getRoomView(room, undefined, true),
        isHost: ws.isHost,
        isAdmin: true,
      }),
    );
  }

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as ClientMessage;
      const room = getRoom(roomId);
      if (!room) return;
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
        if (enabled && !room.aiPlayerTemperatureBySeat.has(seatIndex)) room.aiPlayerTemperatureBySeat.set(seatIndex, 0.5);
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
          if (!room.players[toSeat as number]) {
            ws.send(JSON.stringify({ type: 'error', message: 'chat_dm_invalid_toSeat' }));
            return;
          }
          const entry = pushChat(room, {
            at: Date.now(),
            scope: 'dm',
            phase: room.phase,
            dayNumber: room.dayNumber,
            fromSeat: seatIndex,
            toSeat: toSeat as number,
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
            if (win) emitGameOver(roomId, room, win);
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
      if (msg.type === 'post_game_ask_god') {
        if (isAdmin) {
          ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_post_game_ask_god' }));
          return;
        }
        if (room.status !== 'ended') {
          ws.send(JSON.stringify({ type: 'error', message: 'post_game_ask_only_when_ended' }));
          return;
        }
        const question = String(msg.question ?? '').trim();
        if (!question) {
          ws.send(JSON.stringify({ type: 'error', message: 'post_game_ask_empty' }));
          return;
        }
        if (question.length > 1000) {
          ws.send(JSON.stringify({ type: 'error', message: 'post_game_ask_too_long' }));
          return;
        }
        const answer = await answerPostGameQuestion(room, seatIndex, question);
        sendToSeat(roomId, seatIndex, {
          type: 'post_game_god_answer',
          question,
          answer,
          at: Date.now(),
        });
        return;
      }
      if (msg.type === 'post_game_ask_player') {
        if (isAdmin) {
          ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_post_game_ask_player' }));
          return;
        }
        if (room.status !== 'ended') {
          ws.send(JSON.stringify({ type: 'error', message: 'post_game_ask_player_only_when_ended' }));
          return;
        }
        const targetSeatIndex = Number(msg.targetSeatIndex);
        if (!Number.isInteger(targetSeatIndex) || !room.players[targetSeatIndex]) {
          ws.send(JSON.stringify({ type: 'error', message: 'post_game_ask_player_invalid_target' }));
          return;
        }
        const question = String(msg.question ?? '').trim();
        if (!question) {
          ws.send(JSON.stringify({ type: 'error', message: 'post_game_ask_player_empty' }));
          return;
        }
        if (question.length > 1000) {
          ws.send(JSON.stringify({ type: 'error', message: 'post_game_ask_player_too_long' }));
          return;
        }
        const answer = await answerPostGamePlayerQuestion(room, targetSeatIndex, seatIndex, question);
        sendToSeat(roomId, seatIndex, {
          type: 'post_game_player_answer',
          targetSeatIndex,
          question,
          answer,
          at: Date.now(),
        });
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
        await runNightLoopExclusive(roomId, room);
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
          const target = room.players[targetSeat as number];
          if (!target?.isAlive) {
            ws.send(JSON.stringify({ type: 'error', message: 'day_action_target_not_alive' }));
            return;
          }

          const used = room.usedDayActionsBySeat.get(seatIndex) ?? new Set<string>();
          if (used.has('slayer_shot')) {
            ws.send(JSON.stringify({ type: 'error', message: 'day_action_limit_reached:slayer_shot' }));
            return;
          }

          // 所有人都可以“宣称发动”，但只有真实杀手且未中毒/醉酒且未使用过才会生效
          pushReplay(room, key, title, `[白天技能] ${seatLabel(room, seatIndex)} 宣称自己是「杀手」并向 ${seatLabel(room, targetSeat as number)} 开枪。`);
          pushPublic(room, `${seatLabel(room, seatIndex)} 宣称自己是「杀手」并向 ${seatLabel(room, targetSeat as number)} 开枪。`);
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
        await runNightLoopExclusive(roomId, room);
        // 若已结束（phase=waiting），不再提示夜晚行动
        if (room.phase !== 'waiting') sendNightPrompt(roomId, room);
        broadcastAfterNight(roomId, room, phaseBeforeLoop);
        broadcastNightConfirm(roomId, room);
        return;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: (e as Error).message }));
    }
  });

  ws.on('close', () => {
    const room = getRoom(roomId ?? '');
    if (room && !ws.isAdmin) unbindConnection(room, connectionId);
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP + WS server on http://localhost:${HTTP_PORT}`);
});

setInterval(async () => {
  for (const [rid, room] of rooms.entries()) {
    if (room.status !== 'playing') continue;
    tickFlowDirector(rid, room);

    // AI 玩家托管：按阶段编排；夜晚仅 `decideAiPlayerNightTargets`（只含 night_action）
    // - 白天：每座位每白天最多 1 次 LLM（day_plan）→ 私聊→公聊→提名/投票
    for (const p of room.players) {
      const seatIndex = p.seatIndex;
      if (!(room.aiPlayerEnabledBySeat.get(seatIndex) ?? false)) continue;

      // 诊断日志：当开启 AI_PLAYER_LLM_LOG 时，打印每座位当前卡点（避免“只看到 input 没看到 output”）
      if (process.env.AI_PLAYER_LLM_LOG === 'true' || process.env.AI_PLAYER_LLM_LOG === '1') {
        const planKey = `ai_day_plan_${room.dayNumber}_seat_${seatIndex}`;
        const dmMarkKey = `ai_day_dm_done_${room.dayNumber}_seat_${seatIndex}`;
        const pubMarkKey = `ai_day_public_done_${room.dayNumber}_seat_${seatIndex}`;
        const inflight = room.storytellerDecisions.get(`ai_player_dayplan_inflight_${seatIndex}`) === true;
        const hasPlan = !!room.storytellerDecisions.get(planKey);
        const dmDone = room.storytellerDecisions.get(dmMarkKey) === true;
        const pubDone = room.storytellerDecisions.get(pubMarkKey) === true;
        if (room.phase === 'day') {
          console.log('[ai_player] day_state', {
            dayNumber: room.dayNumber,
            seatIndex,
            inflightDayPlan: inflight,
            hasDayPlan: hasPlan,
            dmDone,
            pubDone,
            daySubPhase: room.daySubPhase,
            hasCurrentNomination: !!room.currentNomination,
            hasVoted: room.votes.has(seatIndex),
          });
        }
      }

      // 白天：优先生成计划并发言，再进入提名/投票（避免先兜底 skip 导致“全员不提名”）
      if (room.phase === 'day') {
        try {
          const tempNow = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
          const planKey = `ai_day_plan_${room.dayNumber}_seat_${seatIndex}`;
          const existing = room.storytellerDecisions.get(planKey) as any;
          const needPlan = !existing || existing.type !== 'day_plan';
          // 若上次是 noop/无计划，则允许下一轮继续重试（避免 dmDone/pubDone 永远卡住）
          if (needPlan && aiPlayerLlmAvailable()) {
            const {
              roomView,
              yourCharacterId,
              yourRole,
              yourAlignment,
              chatLog,
              allChatLog,
              nightInfo,
            } = buildAiSeatContext(room, seatIndex);

            let dayTraceId: string | null = null;
            const plan = await decideAiPlayerDayPlan(room, seatIndex, {
              roomView,
              yourSeatIndex: seatIndex,
              yourRole,
              yourCharacterId,
              yourAlignment,
              demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
              chatLog,
              allChatLog,
              nightInfo,
              voteSnapshot: buildVoteSnapshot(room),
              recentVoteEvents: buildRecentVoteEvents(room),
              nightPrompt: null,
              currentNomination: room.currentNomination,
            }, tempNow, (event) => {
              if (event.kind === 'request') {
                const rec = createInvocation(room, {
                  actor: 'player',
                  stage: 'day_plan',
                  roomId: rid,
                  seatIndex,
                  phase: room.phase,
                  model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
                  status: 'started',
                  request: toTraceText(toFullPromptDebugText(event)),
                });
                dayTraceId = rec.id;
                room.storytellerDecisions.set(dayPlanTraceKey(room.dayNumber, seatIndex), rec.id);
                sendAiTrace(rid, seatIndex, rec);
              } else if (event.kind === 'response') {
                if (!dayTraceId) return;
                const rec = updateInvocation(room, dayTraceId, {
                  status: 'responded',
                  elapsedMs: event.elapsedMs,
                  response: toTraceText(event.rawResponse ?? ''),
                });
                if (rec) sendAiTrace(rid, seatIndex, rec);
              } else if (event.kind === 'error') {
                if (!dayTraceId) return;
                const rec = updateInvocation(room, dayTraceId, {
                  status: 'error',
                  error: event.error ?? 'unknown_error',
                });
                if (rec) sendAiTrace(rid, seatIndex, rec);
              }
            });
            if (!(plan && plan.type === 'day_plan')) {
              if (dayTraceId) {
                const rec = updateInvocation(room, dayTraceId, {
                  status: 'fallback',
                  behavior: `fallback_default_day_plan`,
                });
                if (rec) sendAiTrace(rid, seatIndex, rec);
              }
            }
            // 若模型仍给 noop，则落一个最小可用计划，保证白天不会卡死
            if (plan && plan.type === 'day_plan') {
              room.storytellerDecisions.set(planKey, plan);
              if (dayTraceId) {
                const rec = updateInvocation(room, dayTraceId, {
                  status: 'applied',
                  behavior: 'stored_day_plan',
                });
                if (rec) sendAiTrace(rid, seatIndex, rec);
              }
            } else {
              room.storytellerDecisions.set(planKey, buildForcedActiveDayPlan(room, seatIndex));
            }
          }

          const plan = room.storytellerDecisions.get(planKey) as any;
          const stage = room.dayFlowStage;
          const traceId = String(room.storytellerDecisions.get(dayPlanTraceKey(room.dayNumber, seatIndex)) ?? '') || null;

          // 上帝问答阶段：每名 AI 玩家执行一次（无夜间信息可直接跳过）
          const godMarkKey = `ai_day_god_done_${room.dayNumber}_seat_${seatIndex}`;
          if (stage === 'god_dialogue' && plan && plan.type === 'day_plan' && room.storytellerDecisions.get(godMarkKey) !== true) {
            const q = String(plan.godQuestion?.text ?? '').trim().slice(0, 200);
            const hasNightInfo = (getNightInfoLogBySeat(room).get(seatIndex) ?? []).length > 0;
            if (q && hasNightInfo) {
              const ask = pushChat(room, {
                at: Date.now(),
                scope: 'god',
                phase: room.phase,
                dayNumber: room.dayNumber,
                fromSeat: seatIndex,
                text: q,
              });
              broadcastChat(rid, ask);
              const replyText = makeDeterministicGodReply(room, seatIndex, q);
              const reply = pushChat(room, {
                at: Date.now(),
                scope: 'god',
                phase: room.phase,
                dayNumber: room.dayNumber,
                fromSeat: seatIndex,
                text: replyText,
              });
              broadcastChat(rid, reply);
              appendBehavior(rid, room, seatIndex, traceId, `god_dialogue:asked="${q}" replied="${replyText.slice(0, 80)}"`);
            } else {
              appendBehavior(rid, room, seatIndex, traceId, 'god_dialogue:skipped(no_question_or_no_night_info)');
            }
            room.storytellerDecisions.set(godMarkKey, true);
          }

          // 私聊
          const dmMarkKey = `ai_day_dm_done_${room.dayNumber}_seat_${seatIndex}`;
          if (stage === 'private_dialogue' && plan && plan.type === 'day_plan' && room.storytellerDecisions.get(dmMarkKey) !== true) {
            const dmList = Array.isArray(plan.dm) ? plan.dm : [];
            const dmMap = new Map<number, string>();
            for (const d of dmList) {
              if (!d || typeof d !== 'object') continue;
              const toSeat = (d as any).toSeat;
              const text = String((d as any).text ?? '').trim();
              if (!Number.isInteger(toSeat) || !text) continue;
              if (!room.players[toSeat]) continue;
              dmMap.set(toSeat, text.slice(0, 500));
            }
            const peers = room.players
              .filter((p) => p.isAlive && p.seatIndex !== seatIndex)
              .map((p) => p.seatIndex)
              .sort((a, b) => a - b);
            let dmSent = 0;
            let dmSkipped = 0;
            for (const toSeat of peers) {
              const text = dmMap.get(toSeat);
              if (!text) {
                dmSkipped++;
                continue;
              }
              const entry = pushChat(room, {
                at: Date.now(),
                scope: 'dm',
                phase: room.phase,
                dayNumber: room.dayNumber,
                fromSeat: seatIndex,
                toSeat,
                text,
              });
              broadcastChat(rid, entry);
              dmSent++;
            }
            appendBehavior(rid, room, seatIndex, traceId, `private_dialogue:peer_loop=${peers.length}; sent_dm=${dmSent}; skipped_dm=${dmSkipped}`);
            room.storytellerDecisions.set(dmMarkKey, true);
          }

          // 公聊（每天至少 1 条）
          const pubMarkKey = `ai_day_public_done_${room.dayNumber}_seat_${seatIndex}`;
          if (stage === 'public_speech' && plan && plan.type === 'day_plan' && room.storytellerDecisions.get(pubMarkKey) !== true) {
            const aggressiveGoodInfo = shouldPushGoodInfoAggression(room, seatIndex);
            const rawText = String(plan.public?.text ?? '').trim();
            const replacedByForcedPush = aggressiveGoodInfo && isWeakPublicSpeech(rawText);
            const text = replacedByForcedPush
              ? buildForcedActiveDayPlan(room, seatIndex).public.text
              : rawText;
            if (text) {
              const entry = pushChat(room, { at: Date.now(), scope: 'public', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: text.slice(0, 500) });
              pushPublic(room, `公开发言：${seatLabel(room, seatIndex)}：${text.slice(0, 500)}`);
              broadcastChat(rid, entry);
              broadcast(rid, { type: 'room', room: getRoomView(room) });
              appendBehavior(rid, room, seatIndex, traceId, `public_speech:spoken="${text.slice(0, 80)}"`);
              if (replacedByForcedPush) {
                appendBehavior(rid, room, seatIndex, traceId, `public_speech:forced_push_rewrite(from="${rawText.slice(0, 60)}")`);
              }
            } else {
              appendBehavior(rid, room, seatIndex, traceId, 'public_speech:skipped(empty_text)');
            }
            room.storytellerDecisions.set(pubMarkKey, true);
          }
        } catch (e) {
          const rec = createInvocation(room, {
            actor: 'player',
            stage: 'day_plan',
            roomId: rid,
            seatIndex,
            phase: room.phase,
            model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
          });
          sendAiTrace(rid, seatIndex, rec);
        }
      }

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
              if (win) emitGameOver(rid, room, win);
              continue;
            }
            shareAiNightInfoAtDawn(rid, room);
            broadcast(rid, { type: 'room', room: getRoomView(room) });
            broadcast(rid, { type: 'phase', phase: room.phase, dayNumber: room.dayNumber });
          }
        }
        continue;
      }

      // 2) 夜晚轮到该 AI 玩家行动：
      // - 若可用大模型：等待大模型决策（不要随机兜底跳过）
      // - 否则：随机兜底，避免永远卡死
      if (room.pendingNightAction && room.pendingNightAction.actorSeatIndex === seatIndex) {
        if (aiPlayerLlmAvailable()) {
          // fallthrough 到后面的 LLM 决策分支
        } else {
        const pendingBefore = room.pendingNightAction;
        const pick = room.pendingNightAction.pick;
        const aliveAll = room.players.filter((x) => x.isAlive).map((x) => x.seatIndex);
        const alive = pendingBefore.stepId === 'imp' ? aliveAll.filter((s) => s !== seatIndex) : aliveAll;
        const targets: number[] = [];
        for (let i = 0; i < pick; i++) {
          const remain = alive.filter((s) => !targets.includes(s));
          if (remain.length === 0) break;
          targets.push(remain[Math.floor(Math.random() * remain.length)]);
        }
        if (targets.length === pick) {
          const result = submitNightAction(room, seatIndex, targets);
          if (result.ok) {
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
            if (result.info) sendToSeat(rid, seatIndex, { type: 'night_info', message: result.info });
            const phaseBeforeLoop = room.phase;
            await runNightLoopExclusive(rid, room);
            if (room.phase !== 'waiting') sendNightPrompt(rid, room);
            broadcastAfterNight(rid, room, phaseBeforeLoop);
            broadcastNightConfirm(rid, room);
          }
        }
        continue;
        }
      }

      // 3) 白天提名阶段：若该 AI 玩家尚未做出“提名/不提名”，则自动进行一次操作，保证白天可结束
      if (room.phase === 'day' && room.daySubPhase === 'nomination' && room.currentNomination === null) {
        const me = room.players[seatIndex];
        const decided = room.nominationsToday.has(seatIndex) || room.skippedNominationsToday.has(seatIndex);
        if (me?.isAlive && !decided) {
          const traceId = String(room.storytellerDecisions.get(dayPlanTraceKey(room.dayNumber, seatIndex)) ?? '') || null;
          // 使用“本日计划”决定提名（每座位每白天最多 1 次 LLM 生成计划；若计划缺失则兜底不提名）
          const planKey = `ai_day_plan_${room.dayNumber}_seat_${seatIndex}`;
          const plan = room.storytellerDecisions.get(planKey) as any;
          const planNom = plan && typeof plan === 'object' ? plan.nomination : null;
          const aggressiveGoodInfo = shouldPushGoodInfoAggression(room, seatIndex);
          let ok = false;
          if (planNom && planNom.type === 'nominate' && Number.isInteger(planNom.targetSeat)) {
            ok = nominate(room, seatIndex, planNom.targetSeat);
            if (ok) {
              const { key, title } = dayReplayTitle(room);
              pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）提名 ${seatLabel(room, planNom.targetSeat)}。`);
              pushPublic(room, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, planNom.targetSeat)}。`);
              appendBehavior(rid, room, seatIndex, traceId, `nomination_vote:nominate(target=${planNom.targetSeat})`);
              broadcast(rid, { type: 'room', room: getRoomView(room) });
            }
          }
          if (!ok) {
            const inFallback = !aiPlayerLlmAvailable();
            if (!inFallback) {
              if (aggressiveGoodInfo) {
                const target = pickMostSuspiciousAlive(room, seatIndex);
                if (target != null) {
                  ok = nominate(room, seatIndex, target);
                  if (ok) {
                    const { key, title } = dayReplayTitle(room);
                    pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）根据信息位策略主动提名 ${seatLabel(room, target)}。`);
                    pushPublic(room, `${seatLabel(room, seatIndex)} 发起主动提名 ${seatLabel(room, target)}（信息位推进）。`);
                    appendBehavior(rid, room, seatIndex, traceId, `nomination_vote:nominate_good_info_push(target=${target})`);
                    broadcast(rid, { type: 'room', room: getRoomView(room) });
                    continue;
                  }
                }
              }
              // LLM 可用时：若计划尚未生成，先等下一轮，避免全员空转/skip 导致白天难以推进
              if (!plan || plan.type !== 'day_plan') continue;
              const ok2 = skipNomination(room, seatIndex);
              if (ok2) {
                const { key, title } = dayReplayTitle(room);
                pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）选择本轮不提名。`);
                pushPublic(room, `${seatLabel(room, seatIndex)} 选择本轮不提名。`);
                appendBehavior(rid, room, seatIndex, traceId, 'nomination_vote:skip(use_plan)');
                broadcast(rid, { type: 'room', room: getRoomView(room) });
                const phaseBefore = room.phase;
                const fin = maybeFinishDay(room);
                if (fin.ended) await handleDayMaybeEnterNight(rid, room, phaseBefore, fin.executedSeatIndex);
              }
              continue;
            }

            // 兜底：按“好坏人表”提名嫌疑最重的玩家；阈值以上则选择本轮不提名
            const target = aiPickNominationTargetByTrust(room, seatIndex);
            if (target != null) {
              ok = nominate(room, seatIndex, target);
              if (ok) {
                const { key, title } = dayReplayTitle(room);
                pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）提名 ${seatLabel(room, target)}。`);
                pushPublic(room, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, target)}。`);
                appendBehavior(rid, room, seatIndex, traceId, `nomination_vote:nominate_fallback(target=${target})`);
                broadcast(rid, { type: 'room', room: getRoomView(room) });
                continue;
              }
            }

            const ok2 = skipNomination(room, seatIndex);
            if (ok2) {
              const { key, title } = dayReplayTitle(room);
              pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）选择本轮不提名。`);
              pushPublic(room, `${seatLabel(room, seatIndex)} 选择本轮不提名。`);
              appendBehavior(rid, room, seatIndex, traceId, 'nomination_vote:skip_fallback');
              broadcast(rid, { type: 'room', room: getRoomView(room) });
              const phaseBefore = room.phase;
              const fin = maybeFinishDay(room);
              if (fin.ended) await handleDayMaybeEnterNight(rid, room, phaseBefore, fin.executedSeatIndex);
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
          const traceId = String(room.storytellerDecisions.get(dayPlanTraceKey(room.dayNumber, seatIndex)) ?? '') || null;
          // 优先使用本日计划的投票倾向；否则兜底：被提名者反对，其余人保守反对
          const planKey = `ai_day_plan_${room.dayNumber}_seat_${seatIndex}`;
          const plan = room.storytellerDecisions.get(planKey) as any;
          const planVote = plan && typeof plan === 'object' ? plan.vote : null;
          const aggressiveGoodInfo = shouldPushGoodInfoAggression(room, seatIndex);
          let inFavor = false;
          if (planVote && typeof planVote === 'object') {
            const priority = Array.isArray(planVote.priorityExecuteSeats)
              ? (planVote.priorityExecuteSeats as unknown[])
                .map((x) => Number(x))
                .filter((x) => Number.isInteger(x))
              : null;
            if (priority && priority.length > 0) {
              inFavor = shouldVoteInFavorByPriority(room, seatIndex, room.currentNomination.nominated, priority);
            } else if (aggressiveGoodInfo) {
              inFavor = shouldVoteInFavorByPriority(room, seatIndex, room.currentNomination.nominated, null);
            } else {
              inFavor = !!planVote.inFavor;
            }
          } else if (!aiPlayerLlmAvailable()) {
            // 兜底：按“好坏人表”投票；嫌疑越低越像坏人，trust<=阈值则投赞成执行
            inFavor = aiVoteInFavorByTrust(room, seatIndex, room.currentNomination.nominated);
          } else if (aggressiveGoodInfo) {
            inFavor = shouldVoteInFavorByPriority(room, seatIndex, room.currentNomination.nominated, null);
          }
          vote(room, seatIndex, inFavor);
          appendBehavior(rid, room, seatIndex, traceId, `nomination_vote:vote(${inFavor ? 'in_favor' : 'against'})`);
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
          if (fin.ended) await handleDayMaybeEnterNight(rid, room, phaseBefore, fin.executedSeatIndex);
          continue;
        }
      }

      try {
        // 夜晚：仅在轮到自己行动时调用 LLM（且不再先随机兜底）
        if (!(room.pendingNightAction && room.pendingNightAction.actorSeatIndex === seatIndex)) continue;
        const tempNow = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
        const {
          roomView,
          yourCharacterId,
          yourRole,
          yourAlignment,
          chatLog,
          allChatLog,
          nightInfo,
        } = buildAiSeatContext(room, seatIndex);

        const pending = room.pendingNightAction;
        const aliveAll = room.players.filter((x) => x.isAlive).map((x) => x.seatIndex);
        const aliveSeatIndices = pending?.stepId === 'imp' ? aliveAll.filter((s) => s !== seatIndex) : aliveAll;
        const nightPrompt = pending && pending.actorSeatIndex === seatIndex
          ? { stepId: pending.stepId, pick: pending.pick, aliveSeatIndices }
          : null;

        let nightTraceId: string | null = null;
        const action = await decideAiPlayerNightTargets(room, seatIndex, {
          roomView,
          yourSeatIndex: seatIndex,
          yourRole,
          yourCharacterId,
          yourAlignment,
          demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
          chatLog,
          allChatLog,
          nightInfo,
          voteSnapshot: buildVoteSnapshot(room),
          recentVoteEvents: buildRecentVoteEvents(room),
          nightPrompt,
          currentNomination: room.currentNomination,
        }, tempNow, (event) => {
          if (event.kind === 'request') {
            const rec = createInvocation(room, {
              actor: 'player',
              stage: 'night_action',
              roomId: rid,
              seatIndex,
              phase: room.phase,
              stepId: nightPrompt?.stepId,
              model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
              status: 'started',
              request: toTraceText(toFullPromptDebugText(event)),
            });
            nightTraceId = rec.id;
            sendAiTrace(rid, seatIndex, rec);
          } else if (event.kind === 'response') {
            if (!nightTraceId) return;
            const rec = updateInvocation(room, nightTraceId, {
              status: 'responded',
              elapsedMs: event.elapsedMs,
              response: toTraceText(event.rawResponse ?? ''),
            });
            if (rec) sendAiTrace(rid, seatIndex, rec);
          } else if (event.kind === 'error') {
            if (!nightTraceId) return;
            const rec = updateInvocation(room, nightTraceId, {
              status: 'error',
              error: event.error ?? 'unknown_error',
            });
            if (rec) sendAiTrace(rid, seatIndex, rec);
          }
        });
        const playerSuggestedTargets = action.type === 'night_action' ? action.targets : [];
        if (action.type !== 'night_action' && nightTraceId) {
          const rec = updateInvocation(room, nightTraceId, {
            status: 'fallback',
            behavior: 'fallback_due_to_invalid_action',
          });
          if (rec) sendAiTrace(rid, seatIndex, rec);
        }

        if (room.pendingNightAction?.actorSeatIndex === seatIndex) {
          const pendingNow = room.pendingNightAction;
          if (!isNightMediatedStepId(pendingNow.stepId) || (pendingNow.pick !== 1 && pendingNow.pick !== 2)) continue;
          let storytellerTraceId: string | null = null;
          const finalTargets = await getStorytellerMediatedNightTargets(
            room,
            {
              stepId: pendingNow.stepId,
              actorSeatIndex: pendingNow.actorSeatIndex,
              pick: pendingNow.pick as 1 | 2,
              aliveSeatIndices,
              playerSuggestedTargets,
            },
            false,
            (event) => {
              if (event.kind === 'request') {
                const rec = createInvocation(room, {
                  actor: 'storyteller',
                  stage: 'storyteller_decision',
                  roomId: rid,
                  seatIndex: pendingNow.actorSeatIndex,
                  phase: room.phase,
                  stepId: pendingNow.stepId,
                  model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
                  status: 'started',
                  request: toTraceText(
                    `system:\n${event.systemPrompt ?? ''}\n\nuser:\n${event.userPrompt ?? ''}`,
                  ),
                });
                storytellerTraceId = rec.id;
                sendAiTrace(rid, pendingNow.actorSeatIndex, rec);
              } else if (event.kind === 'response') {
                if (!storytellerTraceId) return;
                const rec = updateInvocation(room, storytellerTraceId, {
                  status: 'responded',
                  elapsedMs: event.elapsedMs,
                  response: toTraceText(event.rawResponse ?? ''),
                });
                if (rec) sendAiTrace(rid, pendingNow.actorSeatIndex, rec);
              } else if (event.kind === 'error') {
                if (!storytellerTraceId) return;
                const rec = updateInvocation(room, storytellerTraceId, {
                  status: 'error',
                  error: event.error ?? 'unknown_error',
                });
                if (rec) sendAiTrace(rid, pendingNow.actorSeatIndex, rec);
              }
            },
          );
          const pendingBefore = room.pendingNightAction;
          const result = submitNightAction(room, seatIndex, finalTargets);
          if (result.ok) {
            if (nightTraceId) {
              const rec = updateInvocation(room, nightTraceId, {
                status: 'applied',
                behavior: `player_suggested_targets=${JSON.stringify(playerSuggestedTargets)}; storyteller_final_targets=${JSON.stringify(finalTargets)}`,
              });
              if (rec) sendAiTrace(rid, seatIndex, rec);
            }
            if (storytellerTraceId) {
              const rec = updateInvocation(room, storytellerTraceId, {
                status: 'applied',
                behavior: `submitNightAction(${pendingBefore?.stepId ?? 'unknown'}) targets=${JSON.stringify(finalTargets)}`,
              });
              if (rec) sendAiTrace(rid, seatIndex, rec);
            }
            if (pendingBefore) {
              const { key, title } = nightReplayTitle(room);
              if (pendingBefore.stepId === 'imp' && finalTargets[0] !== undefined) {
                pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（恶魔）选择杀害 ${seatLabel(room, finalTargets[0])}。`);
              } else if (pendingBefore.stepId === 'monk' && finalTargets[0] !== undefined) {
                pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（僧侣）选择保护 ${seatLabel(room, finalTargets[0])}。`);
              } else if (pendingBefore.stepId === 'poisoner' && finalTargets[0] !== undefined) {
                pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（投毒者）选择毒害 ${seatLabel(room, finalTargets[0])}。`);
              } else if (pendingBefore.stepId === 'fortune_teller' && finalTargets.length === 2) {
                pushReplay(room, key, title, `${seatLabel(room, pendingBefore.actorSeatIndex)}（占卜师）选择查验 ${seatLabel(room, finalTargets[0])} 与 ${seatLabel(room, finalTargets[1])}。`);
              }
            }
            if (result.info) sendToSeat(rid, seatIndex, { type: 'night_info', message: result.info });
            const phaseBeforeLoop = room.phase;
            await runNightLoopExclusive(rid, room);
            if (room.phase !== 'waiting') sendNightPrompt(rid, room);
            broadcastAfterNight(rid, room, phaseBeforeLoop);
            broadcastNightConfirm(rid, room);
          }
        }
      } catch (e) {
        const rec = createInvocation(room, {
          actor: 'player',
          stage: 'night_action',
          roomId: rid,
          seatIndex,
          phase: room.phase,
          model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
        sendAiTrace(rid, seatIndex, rec);
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
