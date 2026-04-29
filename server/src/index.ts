import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createRoom, getRoom, joinRoom, getRoomView, setReady, bindConnection, unbindConnection, rooms } from './game/roomManager.js';
import { buildYourRolePayload } from './game/yourRole.js';
import { startGame, advanceNight, getCurrentNightStep, nominate, skipNomination, vote, tallyVotes, execute, maybeFinishDay, submitNightAction, computeChefPairsForSeat, computeEmpathCountForSeat, formatUndertakerInfoForSeat, formatWasherLibrarianInvestigator, checkWin, getShownCharacterId, resolveRavenkeeperNightInfo, finishNightAndGotoDay } from './game/gameEngine.js';
import { getStorytellerLlmKeyInfo, storytellerLlmSelfTest, answerPostGameQuestion } from './ai/storyteller.js';
import { aiPlayerLlmAvailable, decideAiPlayerConstrainedAction, decideAiPlayerDayPlan, decideAiPlayerNightTargets, getAiPlayerLlmKeyInfo, aiPlayerLlmSelfTest, answerPostGamePlayerQuestion, refineAiPlayerMemorySummary } from './ai/playerAgent.js';
import type { AiPlayerDebugEvent } from './ai/playerAgent.js';
import { runNightLoop as runAutomatedNightLoop } from './night/runNightLoop.js';
import { pushReplay, buildReplayBundle, seatLabel, pushPublic } from './game/replay.js';
import type { GamePhase } from './game/types.js';
import { troubleBrewing } from './script/troubleBrewing.js';
import { createInvocation, listInvocations, updateInvocation } from './ai/invocationLog.js';
import type { AiInvocationRecord } from './ai/invocationLog.js';

function normalizeGodQuery(text: string): string {
  return text.trim().replace(/\s+/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOrInitDaySeatTimer(room: import('./game/types.js').Room, key: string): number {
  const now = Date.now();
  const raw = Number(room.storytellerDecisions.get(key) ?? 0);
  if (Number.isFinite(raw) && raw > 0) return raw;
  room.storytellerDecisions.set(key, now);
  return now;
}

function incDaySeatCounter(room: import('./game/types.js').Room, key: string): number {
  const raw = Number(room.storytellerDecisions.get(key) ?? 0);
  const next = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) + 1 : 1;
  room.storytellerDecisions.set(key, next);
  return next;
}

function getDaySeatCounter(room: import('./game/types.js').Room, key: string): number {
  const raw = Number(room.storytellerDecisions.get(key) ?? 0);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
}

function cooldownOk(room: import('./game/types.js').Room, key: string, cooldownMs: number): boolean {
  const now = Date.now();
  const raw = Number(room.storytellerDecisions.get(key) ?? 0);
  const last = Number.isFinite(raw) ? raw : 0;
  if (now - last < cooldownMs) return false;
  room.storytellerDecisions.set(key, now);
  return true;
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

function shouldRejectRoleClaimText(room: import('./game/types.js').Room, seatIndex: number, textRaw: string): boolean {
  const text = String(textRaw ?? '').trim();
  if (!text) return false;
  // 编号规范：所有玩家编号必须在 1..n（展示层统一规则）
  const n = room.players.length;
  for (const m of text.matchAll(/#\s*(\d{1,2})\b/g)) {
    const x = Number(m[1]);
    if (!Number.isInteger(x) || x < 1 || x > n) return true;
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s*号\b/g)) {
    const x = Number(m[1]);
    if (!Number.isInteger(x) || x < 1 || x > n) return true;
  }
  const p = room.players[seatIndex];
  if (!p) return false;
  // 只对“善良阵营玩家的对话”做强约束：避免随口编身份造成观感灾难
  const shownId = getShownCharacterId(p);
  const shownNameZh = shownId ? (room.script.characters.find((c) => c.id === shownId)?.nameZh ?? '') : '';
  if (!shownId || !shownNameZh) return false;
  const alignment = room.script.characters.find((c) => c.id === shownId)?.alignment ?? 'unknown';
  if (alignment !== 'good') return false;

  // 检测形如“我是/我身份是/我就是 + 角色名”
  for (const c of room.script.characters) {
    if (!c?.nameZh) continue;
    if (c.id === shownId) continue;
    const re = new RegExp(`(我是|我身份是|我就是)\\s*${c.nameZh.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`);
    if (re.test(text)) {
      return true;
    }
  }
  // 同时避免“我就是恶魔/爪牙”这类明显破坏体验的自曝（善良不该这么说）
  if (/(我是|我就是|我身份是).*(恶魔|爪牙)/.test(text)) return true;
  return false;
}

function pushChat(room: import('./game/types.js').Room, entry: Omit<import('./game/types.js').ChatEntry, 'id'>): import('./game/types.js').ChatEntry {
  const full = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
  room.chatLog.push(full);
  if (room.chatLog.length > 500) room.chatLog = room.chatLog.slice(-500);
  const line =
    full.scope === 'dm'
      ? `私聊 #${full.fromSeat + 1}${typeof full.toSeat === 'number' ? `->#${full.toSeat + 1}` : ''}：${full.text.slice(0, 120)}`
      : full.scope === 'god'
        ? `上帝问答 #${full.fromSeat + 1}：${full.text.slice(0, 120)}`
        : `公开发言 #${full.fromSeat + 1}：${full.text.slice(0, 120)}`;
  if (full.scope === 'public') {
    appendAiMemoryLine(room, room.players.map((p) => p.seatIndex), line);
  } else if (full.scope === 'dm') {
    const seats = [full.fromSeat];
    if (typeof full.toSeat === 'number') seats.push(full.toSeat);
    appendAiMemoryLine(room, seats, line);
  } else {
    appendAiMemoryLine(room, [full.fromSeat], line);
  }
  return full;
}

function broadcastChat(roomId: string, entry: import('./game/types.js').ChatEntry): void {
  if (entry.scope === 'god') {
    sendToSeat(roomId, entry.fromSeat, { type: 'chat_event', entry });
    sendToAdmins(roomId, { type: 'chat_event', entry });
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
  const storytellerFlag = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
  const aiPlayerFlagRaw = String(process.env.USE_AI_PLAYER ?? '').trim().toLowerCase();
  const aiPlayerFlag = aiPlayerFlagRaw ? (aiPlayerFlagRaw === 'true' || aiPlayerFlagRaw === '1') : true;
  res.json({
    storyteller: getStorytellerLlmKeyInfo(),
    aiPlayer: getAiPlayerLlmKeyInfo(),
    flags: {
      useAiStoryteller: storytellerFlag,
      useAiPlayer: aiPlayerFlag,
      rawUseAiPlayer: process.env.USE_AI_PLAYER ?? null,
    },
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

// 开发辅助：拉取房间内 AI 调用追踪（用于定位 429/超时/参数错误等）
app.get('/api/dev/rooms/:roomId/ai-traces', (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const limitRaw = Number(req.query.limit ?? '');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : 500;
  const items = listInvocations(room);
  res.json({
    roomId: room.id,
    count: items.length,
    items: items.slice(-limit),
  });
});

// 开发辅助：一键创建房间并自动加入/准备 N 个玩家（可选直接开局）
app.post('/api/dev/quickstart', async (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });

  const scriptId = (req.body?.scriptId as string) || troubleBrewing.id;
  const playerCountRaw = req.body?.playerCount;
  const playerCount = Number.isInteger(playerCountRaw) ? (playerCountRaw as number) : 5;
  const start = req.body?.start === false ? false : true;
  const aiTakeover = req.body?.aiTakeover === false ? false : true;

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
    if (aiTakeover) {
      room.aiStorytellerEnabled = true;
      room.aiLastActionAt = 0;
      ensureAiTakeoverForUnattendedSeats(room);
    }
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
  res.json({ roomId: room.id, hostSecret: room.hostSecret, players, joinUrls, adminUrl, started: start, aiTakeover });
});

interface AutoTestGameSummary {
  roomId: string;
  playerCount: number;
  promptStyle: string;
  winner: 'good' | 'evil' | null;
  dayNumber: number;
  ended: boolean;
  timedOut: boolean;
  durationMs: number;
  fallbackEvents: number;
  noExecutionDays: number;
  totalExecutions: number;
  totalNightDeaths: number;
  totalNominations: number;
  totalVoteRounds: number;
  passedVoteRounds: number;
  avgVotesFor: number;
  timeoutSnapshot?: {
    phase: string;
    dayNumber: number;
    daySubPhase: string | null;
    dayFlowStage: string | null;
    directorBlock: string;
    currentNomination: { nominator: number; nominated: number } | null;
    pendingNightAction: { stepId: string; actorSeatIndex: number; pick: 1 | 2 } | null;
    awaitingNightConfirm: boolean;
    aliveSeats: number[];
    votesCount: number;
    nominationsTodayCount: number;
    skippedNominationsTodayCount: number;
    lastPublicLogTail: string[];
  };
  notes: string[];
}

function buildAutoTestTimeoutSnapshot(room: import('./game/types.js').Room) {
  return {
    phase: room.phase,
    dayNumber: room.dayNumber,
    daySubPhase: room.daySubPhase,
    dayFlowStage: room.dayFlowStage,
    directorBlock: directorBlockSummary(room),
    currentNomination: room.currentNomination,
    pendingNightAction: room.pendingNightAction
      ? {
        stepId: room.pendingNightAction.stepId,
        actorSeatIndex: room.pendingNightAction.actorSeatIndex,
        pick: room.pendingNightAction.pick,
      }
      : null,
    awaitingNightConfirm: room.awaitingNightConfirm,
    aliveSeats: room.players.filter((p) => p.isAlive).map((p) => p.seatIndex),
    votesCount: room.votes.size,
    nominationsTodayCount: room.nominationsToday.size,
    skippedNominationsTodayCount: room.skippedNominationsToday.size,
    lastPublicLogTail: room.publicLog.slice(-12).map((x) => x.line),
  };
}

function summarizeAutoTestGame(
  room: import('./game/types.js').Room,
  durationMs: number,
  timedOut: boolean,
  promptStyle: string,
  timeoutSnapshot?: AutoTestGameSummary['timeoutSnapshot'],
): AutoTestGameSummary {
  const winner = checkWin(room);
  const replayLines = room.replayLog.map((x) => x.line);
  const publicLines = room.publicLog.map((x) => x.line);
  const fallbackEvents = publicLines.filter((x) => x.includes('兜底推进')).length;
  const noExecutionDays = replayLines.filter((x) => x.includes('今日无人被处决')).length;
  const totalExecutions = replayLines.filter((x) => x.includes('处决执行：') && x.includes('死亡')).length;
  const totalNightDeaths = replayLines.filter((x) => x.includes('昨夜死亡')).length;
  const totalNominations = publicLines.filter((x) => x.includes(' 提名 ')).length;
  const voteResultLines = publicLines.filter((x) => x.includes('投票结束：'));
  const totalVoteRounds = voteResultLines.length;
  const passedVoteRounds = voteResultLines.filter((x) => x.includes('达到处决条件')).length;
  const votesForList = voteResultLines
    .map((x) => {
      const m = x.match(/赞成\s+(\d+)\s+票/);
      return m ? Number(m[1]) : null;
    })
    .filter((x): x is number => Number.isFinite(x));
  const avgVotesFor = votesForList.length > 0 ? votesForList.reduce((s, n) => s + n, 0) / votesForList.length : 0;
  const notes: string[] = [];
  if (fallbackEvents >= 2) notes.push('白天多次触发兜底推进，说明 AI 白天决策或节奏控制偏弱。');
  if (noExecutionDays >= 2) notes.push('无人处决日较多，可能导致信息推进不足。');
  if (totalNominations <= Math.max(1, room.dayNumber - 1)) notes.push('提名密度偏低，白天推进略保守。');
  if (winner === 'evil' && room.dayNumber <= 2) notes.push('邪恶方过快获胜，善良信息链可能不足。');
  if (winner === 'good' && room.dayNumber <= 2) notes.push('善良方过快获胜，邪恶抗压与伪装链可能偏弱。');
  if (timedOut) notes.push('对局超时，存在流程卡顿风险。');
  return {
    roomId: room.id,
    playerCount: room.players.length,
    promptStyle,
    winner,
    dayNumber: room.dayNumber,
    ended: room.status === 'ended',
    timedOut,
    durationMs,
    fallbackEvents,
    noExecutionDays,
    totalExecutions,
    totalNightDeaths,
    totalNominations,
    totalVoteRounds,
    passedVoteRounds,
    avgVotesFor,
    timeoutSnapshot,
    notes,
  };
}

function buildAutoTestRecommendations(games: AutoTestGameSummary[]): string[] {
  if (games.length === 0) return ['没有可分析的对局数据。'];
  const avgFallback = games.reduce((s, g) => s + g.fallbackEvents, 0) / games.length;
  const avgNoExec = games.reduce((s, g) => s + g.noExecutionDays, 0) / games.length;
  const avgNominations = games.reduce((s, g) => s + g.totalNominations, 0) / games.length;
  const avgVoteRounds = games.reduce((s, g) => s + g.totalVoteRounds, 0) / games.length;
  const avgVotePassRate = games.reduce((s, g) => s + (g.totalVoteRounds > 0 ? g.passedVoteRounds / g.totalVoteRounds : 0), 0) / games.length;
  const evilWins = games.filter((g) => g.winner === 'evil').length;
  const goodWins = games.filter((g) => g.winner === 'good').length;
  const timedOut = games.filter((g) => g.timedOut).length;
  const recs: string[] = [];
  if (avgFallback >= 1.5) {
    recs.push('优先优化 AI 白天行动计划质量（提名目标选择与投票意愿），降低兜底推进频率。');
  }
  if (avgNoExec >= 1.5) {
    recs.push('提高“有证据时发起提名”的激进度，减少连续无人处决导致的低信息局。');
  }
  if (avgNominations < Math.max(1.5, avgVoteRounds)) {
    recs.push('提名轮次偏少：可在提示词中提升“形成候选池并收敛目标”的优先级。');
  }
  if (avgVotePassRate < 0.45) {
    recs.push('投票通过率偏低：建议在提示词中强化“围绕主推目标集中举票，避免分票”。');
  }
  if (evilWins >= goodWins + 2) {
    recs.push('善良方偏弱：应加强信息位公开策略与协同投票逻辑。');
  }
  if (goodWins >= evilWins + 2) {
    recs.push('邪恶方偏弱：应加强邪恶方伪装与误导策略，避免早期暴露。');
  }
  if (timedOut > 0) {
    recs.push('存在超时局：建议增加夜间/白天卡点日志并缩短无效等待窗口。');
  }
  if (recs.length === 0) {
    recs.push('当前自动对局总体可闭环，下一步建议聚焦角色规则一致性（Baron/Spy/Mayor/Saint）以提升真实性。');
  }
  return recs;
}

// 开发辅助：后台自动跑多局（全员 AI 托管 + AI 说书人）并输出对局分析
app.post('/api/dev/autotest/run', async (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });
  const scriptId = (req.body?.scriptId as string) || troubleBrewing.id;
  const roundsRaw = req.body?.rounds;
  const rounds = Number.isInteger(roundsRaw) ? Math.max(1, Math.min(20, Number(roundsRaw))) : 3;
  const playerCountRaw = req.body?.playerCount;
  const playerCount = Number.isInteger(playerCountRaw) ? Math.max(5, Math.min(15, Number(playerCountRaw))) : 7;
  const perGameTimeoutMsRaw = req.body?.perGameTimeoutMs;
  const perGameTimeoutMs = Number.isInteger(perGameTimeoutMsRaw) ? Math.max(30_000, Math.min(15 * 60_000, Number(perGameTimeoutMsRaw))) : 3 * 60_000;
  const promptStyleRaw = String(req.body?.playerPromptStyle ?? process.env.AI_PLAYER_PROMPT_STYLE ?? 'balanced').trim().toLowerCase();
  const allowedStyles = new Set(['balanced', 'assertive', 'deceptive', 'chaotic', 'mixed']);
  const promptStyle = allowedStyles.has(promptStyleRaw) ? promptStyleRaw : 'balanced';
  const startedAt = Date.now();
  const games: AutoTestGameSummary[] = [];

  for (let i = 0; i < rounds; i++) {
    const room = createRoom(scriptId);
    const styleBySeat = new Map<number, string>();
    for (let s = 0; s < playerCount; s++) {
      const nickname = `AutoBot${i + 1}-${s + 1}`;
      const joined = joinRoom(room.id, nickname);
      if (!joined) break;
      setReady(room, joined.seatIndex, true);
      room.aiPlayerEnabledBySeat.set(joined.seatIndex, true);
      ensureAiBehaviorStyle(room, joined.seatIndex);
      const stylePool = ['balanced', 'assertive', 'deceptive', 'chaotic'];
      const seatStyle = promptStyle === 'mixed'
        ? stylePool[(joined.seatIndex + i) % stylePool.length]
        : promptStyle;
      styleBySeat.set(joined.seatIndex, seatStyle);
    }
    room.storytellerDecisions.set('ai_player_prompt_style', promptStyle);
    room.storytellerDecisions.set('ai_player_prompt_style_by_seat', styleBySeat);
    room.aiStorytellerEnabled = true;
    room.aiLastActionAt = 0;
    const ok = startGame(room);
    if (!ok) {
      games.push({
        roomId: room.id,
        playerCount: room.players.length,
        promptStyle,
        winner: null,
        dayNumber: room.dayNumber,
        ended: false,
        timedOut: true,
        durationMs: 0,
        fallbackEvents: 0,
        noExecutionDays: 0,
        totalExecutions: 0,
        totalNightDeaths: 0,
        totalNominations: 0,
        totalVoteRounds: 0,
        passedVoteRounds: 0,
        avgVotesFor: 0,
        notes: ['开局失败（人数或准备状态不满足）。'],
      });
      continue;
    }
    pushReplay(room, 'setup', '自动测试', `自动测试开局：第 ${i + 1}/${rounds} 局，${room.players.length} 人。`);
    pushPublic(room, `自动测试开局：第 ${i + 1}/${rounds} 局。`);
    const gameStartedAt = Date.now();
    const phaseBeforeLoop = room.phase;
    await runNightLoopExclusive(room.id, room);
    if (room.status !== 'ended') {
      if (room.phase === 'first_night') sendEvilInfo(room.id, room);
      sendNightPrompt(room.id, room);
    }
    broadcastAfterNight(room.id, room, phaseBeforeLoop);
    broadcastNightConfirm(room.id, room);

    let timedOut = false;
    while (room.status !== 'ended') {
      if (Date.now() - gameStartedAt > perGameTimeoutMs) {
        timedOut = true;
        break;
      }
      await sleep(800);
    }
    const timeoutSnapshot = timedOut ? buildAutoTestTimeoutSnapshot(room) : undefined;
    games.push(summarizeAutoTestGame(room, Date.now() - gameStartedAt, timedOut, promptStyle, timeoutSnapshot));
  }

  const recs = buildAutoTestRecommendations(games);
  const aggregate = {
    avgDurationMs: games.length > 0 ? games.reduce((s, g) => s + g.durationMs, 0) / games.length : 0,
    avgNoExecutionDays: games.length > 0 ? games.reduce((s, g) => s + g.noExecutionDays, 0) / games.length : 0,
    avgNominations: games.length > 0 ? games.reduce((s, g) => s + g.totalNominations, 0) / games.length : 0,
    avgVotePassRate: games.length > 0
      ? games.reduce((s, g) => s + (g.totalVoteRounds > 0 ? g.passedVoteRounds / g.totalVoteRounds : 0), 0) / games.length
      : 0,
    winners: {
      good: games.filter((g) => g.winner === 'good').length,
      evil: games.filter((g) => g.winner === 'evil').length,
      unknown: games.filter((g) => g.winner == null).length,
    },
    timedOutRoomIds: games.filter((g) => g.timedOut).map((g) => g.roomId),
  };
  return res.json({
    rounds,
    scriptId,
    playerCount,
    promptStyle,
    elapsedMs: Date.now() - startedAt,
    aggregate,
    games,
    recommendations: recs,
  });
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

// 开发辅助：读取裁定链路日志（intent -> adjudication -> apply）
app.get('/api/dev/adjudication-log', (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return res.status(404).json({ error: 'Not found' });
  const roomId = String(req.query.roomId ?? '').trim();
  if (!roomId) return res.status(400).json({ error: 'roomId required' });
  const room = getRoom(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const limitRaw = Number(req.query.limit ?? 200);
  const entries = getAdjudicationLogView(room, Number.isFinite(limitRaw) ? limitRaw : 200);
  res.json({
    roomId: room.id,
    status: room.status,
    phase: room.phase,
    dayNumber: room.dayNumber,
    aiStorytellerEnabled: room.aiStorytellerEnabled,
    total: getAdjudicationLog(room).length,
    returned: entries.length,
    entries,
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
  appendAiMemoryLine(room, [seatIndex], `夜间信息：${message.slice(0, 140)}`);
  sendToSeat(roomId, seatIndex, { type: 'night_info', message });
  // 信息位确认：收到夜间信息后，必须由对应玩家确认，夜序才继续推进
  room.awaitingNightInfoConfirm = true;
  room.pendingNightInfoConfirmSeats = new Set([seatIndex]);
  room.nightInfoConfirmations = new Set();
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
const DAY_PUBLIC_SPEECH_WAIT_TIMEOUT_MS = Number(process.env.DAY_PUBLIC_SPEECH_WAIT_TIMEOUT_MS ?? '') || 15_000;
// 必须高于单座位上帝问答窗口，否则导演层会先判超时，导致“前几个座位总被跳过”。
const DAY_DIALOGUE_WAIT_TIMEOUT_MS = Number(process.env.DAY_DIALOGUE_WAIT_TIMEOUT_MS ?? '') || 35_000;
// 白天讨论阶段：允许多轮微决策，但必须有时间/轮次上限，避免无限闲聊导致对局卡住
const DAY_GOD_DIALOGUE_MAX_MS = Number(process.env.DAY_GOD_DIALOGUE_MAX_MS ?? '') || 24_000;
const DAY_PRIVATE_DIALOGUE_MAX_MS = Number(process.env.DAY_PRIVATE_DIALOGUE_MAX_MS ?? '') || 40_000;
const DAY_PUBLIC_SPEECH_MAX_MS = Number(process.env.DAY_PUBLIC_SPEECH_MAX_MS ?? '') || 26_000;
const AI_DAY_GOD_MAX_TURNS_PER_SEAT = Number(process.env.AI_DAY_GOD_MAX_TURNS_PER_SEAT ?? '') || 3;
const AI_DAY_DM_MAX_TURNS_PER_SEAT = Number(process.env.AI_DAY_DM_MAX_TURNS_PER_SEAT ?? '') || 6;
const AI_DAY_PUBLIC_MAX_TURNS_PER_SEAT = Number(process.env.AI_DAY_PUBLIC_MAX_TURNS_PER_SEAT ?? '') || 3;
// 冷却做成“按阶段分开”，避免上帝问答占用冷却导致私聊/公聊没机会发生
const AI_DAY_CHAT_COOLDOWN_MS = Number(process.env.AI_DAY_CHAT_COOLDOWN_MS ?? '') || 1200;
const AI_DAY_DM_PAIR_COOLDOWN_MS = Number(process.env.AI_DAY_DM_PAIR_COOLDOWN_MS ?? '') || 2800;
const DAY_FLOW_STAGES: Array<import('./game/types.js').DayFlowStage> = [
  'god_dialogue',
  'private_dialogue',
  'public_speech',
  'nomination_vote',
];
const NIGHT_PLAYER_ACTION_STEP_IDS = new Set(['imp', 'monk', 'poisoner', 'fortune_teller']);

function directorBlockSummary(room: import('./game/types.js').Room): string {
  if (room.status !== 'playing') return 'not_playing';
  if (room.phase === 'night' || room.phase === 'first_night') {
    if (room.pendingNightAction) {
      return `night_action_pending:${room.pendingNightAction.stepId}@${room.pendingNightAction.actorSeatIndex}`;
    }
    if (room.awaitingNightInfoConfirm) {
      return `awaiting_night_info_confirm:${Array.from(room.pendingNightInfoConfirmSeats.values()).join(',') || 'none'}`;
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
  const key = `phase=${room.phase}|sub=${room.daySubPhase}|flow=${room.dayFlowStage}|flowStart=${room.dayFlowStartSeat}|nom=${room.currentNomination ? `${room.currentNomination.nominator}-${room.currentNomination.nominated}` : 'none'}|pendingNight=${room.pendingNightAction ? `${room.pendingNightAction.stepId}@${room.pendingNightAction.actorSeatIndex}` : 'none'}|awaitingInfoConfirm=${room.awaitingNightInfoConfirm ? Array.from(room.pendingNightInfoConfirmSeats.values()).sort((a, b) => a - b).join(',') : 'none'}|awaitingConfirm=${room.awaitingNightConfirm}`;
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

function orderedDiscussionSeats(room: import('./game/types.js').Room, startSeat: number | null): number[] {
  const seats = room.players.map((p) => p.seatIndex).sort((a, b) => a - b);
  if (seats.length === 0) return [];
  if (startSeat == null || !seats.includes(startSeat)) return seats;
  const idx = seats.indexOf(startSeat);
  return [...seats.slice(idx), ...seats.slice(0, idx)];
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

function isNightPlayerActionStepId(stepId: string): stepId is 'imp' | 'monk' | 'poisoner' | 'fortune_teller' {
  return NIGHT_PLAYER_ACTION_STEP_IDS.has(stepId);
}

function validateNightTargetsForPending(
  room: import('./game/types.js').Room,
  pending: NonNullable<import('./game/types.js').Room['pendingNightAction']>,
  targets: number[],
): string | null {
  if (!isNightPlayerActionStepId(pending.stepId)) return 'unsupported_step';
  if (!Array.isArray(targets) || targets.length !== pending.pick) return 'invalid_target_count_or_type';
  if (targets.some((t) => !Number.isInteger(t))) return 'invalid_target_count_or_type';

  const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));
  for (const t of targets) {
    if (!aliveSeats.has(t)) return 'invalid_target';
  }
  if (pending.stepId === 'monk' && targets[0] === pending.actorSeatIndex) return 'monk_cannot_target_self';
  if (pending.stepId === 'fortune_teller' && targets.length === 2 && targets[0] === targets[1]) {
    return 'fortune_teller_targets_must_be_distinct';
  }
  return null;
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
  const queue = orderedDiscussionSeats(room, room.dayFlowStartSeat);
  const done = getDayFlowDoneSet(room, stage);
  if (queue.length === 0) return;
  const cursor = Math.max(0, Math.min(getDayFlowCursor(room, stage), queue.length - 1));
  const actor = queue[cursor];
  if (!done.has(actor)) {
    let stageCompleted = false;
    if (stage === 'public_speech') {
      const pubMarkKey = `ai_day_public_done_${room.dayNumber}_seat_${actor}`;
      const spoken = room.storytellerDecisions.get(pubMarkKey) === true;
      const waitKey = `day_flow_wait_since_${room.dayNumber}_${stage}_${actor}`;
      const now = Date.now();
      const waitSinceRaw = Number(room.storytellerDecisions.get(waitKey) ?? 0);
      const waitSince = Number.isFinite(waitSinceRaw) && waitSinceRaw > 0 ? waitSinceRaw : now;
      if (!spoken) {
        room.storytellerDecisions.set(waitKey, waitSince);
        const waited = now - waitSince;
        if (waited < DAY_PUBLIC_SPEECH_WAIT_TIMEOUT_MS) {
          broadcast(roomId, { type: 'room', room: getRoomView(room) });
          return;
        }
        const fallbackText = buildForcedActiveDayPlan(room, actor).public.text;
        if (fallbackText) {
          const entry = pushChat(room, {
            at: now,
            scope: 'public',
            phase: room.phase,
            dayNumber: room.dayNumber,
            fromSeat: actor,
            text: fallbackText.slice(0, 500),
          });
          pushPublic(room, `公开发言（超时兜底）：${seatLabel(room, actor)}：${fallbackText.slice(0, 500)}`);
          broadcastChat(roomId, entry);
        }
        room.storytellerDecisions.set(pubMarkKey, true);
      }
      room.storytellerDecisions.set(waitKey, 0);
      stageCompleted = room.storytellerDecisions.get(pubMarkKey) === true;
    } else if (stage === 'god_dialogue' || stage === 'private_dialogue') {
      const markKey = stage === 'god_dialogue'
        ? `ai_day_god_done_${room.dayNumber}_seat_${actor}`
        : `ai_day_dm_done_${room.dayNumber}_seat_${actor}`;
      const completed = room.storytellerDecisions.get(markKey) === true;
      if (completed) {
        stageCompleted = true;
      } else {
        const waitKey = `day_flow_wait_since_${room.dayNumber}_${stage}_${actor}`;
        const now = Date.now();
        const waitSinceRaw = Number(room.storytellerDecisions.get(waitKey) ?? 0);
        const waitSince = Number.isFinite(waitSinceRaw) && waitSinceRaw > 0 ? waitSinceRaw : now;
        room.storytellerDecisions.set(waitKey, waitSince);
        const waited = now - waitSince;
        if (waited < DAY_DIALOGUE_WAIT_TIMEOUT_MS) {
          broadcast(roomId, { type: 'room', room: getRoomView(room) });
          return;
        }
        room.storytellerDecisions.set(markKey, true);
        room.storytellerDecisions.set(waitKey, 0);
        pushPublic(
          room,
          stage === 'god_dialogue'
            ? `上帝问答（超时跳过）：${seatLabel(room, actor)} 本轮未发起问答。`
            : `玩家私聊（超时跳过）：${seatLabel(room, actor)} 本轮未发起私聊。`,
        );
        stageCompleted = true;
      }
    } else {
      stageCompleted = true;
    }

    if (!stageCompleted) {
      broadcast(roomId, { type: 'room', room: getRoomView(room) });
      return;
    }

    done.add(actor);
    if (stage === 'god_dialogue') {
      const askedCountKey = `ai_day_god_asked_count_${room.dayNumber}_seat_${actor}`;
      const askedCount = Number(room.storytellerDecisions.get(askedCountKey) ?? 0);
      if (Number.isFinite(askedCount) && askedCount > 0) {
        const lastQKey = `ai_day_god_last_q_${room.dayNumber}_seat_${actor}`;
        const lastQ = String(room.storytellerDecisions.get(lastQKey) ?? '').trim();
        pushPublic(
          room,
          `白天流程：${seatLabel(room, actor)} 完成上帝问答（已提问 ${Math.floor(askedCount)} 次${lastQ ? `，最近问题：${lastQ.slice(0, 40)}` : ''}）。`,
        );
      } else {
        pushPublic(room, `白天流程：${seatLabel(room, actor)} 完成上帝问答（未发起提问）。`);
      }
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
      const result = adjudicateAndApplyNightAction(room, actor, targets, 'storyteller_fallback');
      if (result.ok) {
        pushPublic(room, `兜底推进：${seatLabel(room, actor)} 夜晚超时，系统自动提交行动。`);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
      }
    }
    return;
  }

  if ((room.phase === 'night' || room.phase === 'first_night') && room.awaitingNightInfoConfirm && stuckMs >= FALLBACK_NIGHT_CONFIRM_TIMEOUT_MS) {
    for (const s of room.pendingNightInfoConfirmSeats) room.nightInfoConfirmations.add(s);
    room.awaitingNightInfoConfirm = false;
    room.pendingNightInfoConfirmSeats = new Set();
    room.nightInfoConfirmations = new Set();
    pushPublic(room, '兜底推进：夜间信息确认超时，系统自动继续夜晚流程。');
    broadcast(roomId, { type: 'room', room: getRoomView(room) });
    broadcastNightConfirm(roomId, room);
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
  const hasAiPlayerEnabled = room.players.some((p) => room.aiPlayerEnabledBySeat.get(p.seatIndex) === true);
  // 结构化白天流程与 AI 玩家托管解耦：只要有 AI 玩家，就推进白天讨论阶段。
  if (hasAiPlayerEnabled) {
    maybeAdvanceStructuredDay(roomId, room);
  }
  // 强兜底与导演快进仍由 AI 说书人开关控制，避免手动主持时被系统硬推进。
  if (room.aiStorytellerEnabled) {
    enforceProgressFallback(roomId, room);
  }
  if (hasAiPlayerEnabled && room.phase === 'day') {
    maybeAiTakeoverDay(roomId, room);
  }
  if (hasAiPlayerEnabled && (room.phase === 'night' || room.phase === 'first_night')) {
    void maybeAiTakeoverNight(roomId, room);
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
  | { type: 'set_ai_player_behavior_style'; style: import('./game/types.js').AiBehaviorStyle }
  | { type: 'set_ai_player_temperature'; temperature: number } // deprecated
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
  if (room.awaitingNightInfoConfirm) return;
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
      if (room.pendingNightAction || room.awaitingNightInfoConfirm || room.awaitingNightConfirm) break;
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

function sendToAdmins(roomId: string, payload: object): void {
  (wss as any).clients?.forEach((ws: any) => {
    if (ws.roomId !== roomId || ws.readyState !== 1) return;
    if (!ws.isAdmin) return;
    ws.send(JSON.stringify(payload));
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
  // 严格隔离：
  // - 玩家视角：仅可见自己座位的 AI 调用记录；
  // - 上帝管理员视角：admin 连接仅可见“说书人（seatIndex=null）”调用记录。
  if (seatIndex != null) {
    sendToSeat(roomId, seatIndex, { type: 'ai_trace', entry });
    const godDialogueTrace = entry.stage === 'day_dialogue' && String(entry.stepId ?? '').includes('god');
    if (!godDialogueTrace) return;
    (wss as any).clients?.forEach((ws: any) => {
      if (ws.roomId !== roomId || ws.readyState !== 1) return;
      if (!ws.isAdmin) return;
      ws.send(JSON.stringify({ type: 'ai_trace', entry }));
    });
    return;
  }
  (wss as any).clients?.forEach((ws: any) => {
    if (ws.roomId !== roomId || ws.readyState !== 1) return;
    if (!ws.isAdmin) return;
    ws.send(JSON.stringify({ type: 'ai_trace', entry }));
  });
}

function emitGodConversationTrace(
  roomId: string,
  room: import('./game/types.js').Room,
  seatIndex: number,
  playerText: string,
  godText: string,
): void {
  const rec = createInvocation(room, {
    actor: 'storyteller',
    stage: 'day_dialogue',
    roomId,
    seatIndex,
    phase: room.phase,
    stepId: 'god_chat',
    model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
    status: 'applied',
    request: toTraceText({ role: 'player', seat: seatIndex + 1, text: playerText }),
    response: toTraceText({ role: 'god', text: godText }),
    behavior: 'god_dialogue_exchange',
  });
  // 玩家侧可见自己的上帝问答；管理员侧也可在“AI对话”中看到同一条记录。
  sendAiTrace(roomId, seatIndex, rec);
  sendAiTrace(roomId, null, rec);
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
    awaitingInfo: room.awaitingNightInfoConfirm,
    pendingInfoSeats: Array.from(room.pendingNightInfoConfirmSeats.values()),
    infoConfirmedSeats: Array.from(room.nightInfoConfirmations.values()),
  });
}

const NIGHT_INFO_LOG_LIMIT = 20;
const AI_MEMORY_LIMIT = 160;
const AI_MEMORY_SUMMARY_MAX_CHARS = Number(process.env.AI_MEMORY_SUMMARY_MAX_CHARS ?? '') || 1200;
const AI_MEMORY_SUMMARY_MIN_DELTA = Number(process.env.AI_MEMORY_SUMMARY_MIN_DELTA ?? '') || 3;

function getAiMemoryBySeat(room: import('./game/types.js').Room): Map<number, string[]> {
  const k = 'ai_player_memory_by_seat';
  const v = room.storytellerDecisions.get(k);
  if (v instanceof Map) return v as Map<number, string[]>;
  const m = new Map<number, string[]>();
  room.storytellerDecisions.set(k, m);
  return m;
}

function getAiMemorySummaryBySeat(room: import('./game/types.js').Room): Map<number, string> {
  const k = 'ai_player_memory_summary_by_seat';
  const v = room.storytellerDecisions.get(k);
  if (v instanceof Map) return v as Map<number, string>;
  const m = new Map<number, string>();
  room.storytellerDecisions.set(k, m);
  return m;
}

function getAiMemorySummaryCursorBySeat(room: import('./game/types.js').Room): Map<number, number> {
  const k = 'ai_player_memory_summary_cursor_by_seat';
  const v = room.storytellerDecisions.get(k);
  if (v instanceof Map) return v as Map<number, number>;
  const m = new Map<number, number>();
  room.storytellerDecisions.set(k, m);
  return m;
}

function appendAiMemoryLine(room: import('./game/types.js').Room, seatIndices: number[], line: string): void {
  const memory = getAiMemoryBySeat(room);
  for (const seat of seatIndices) {
    if (!Number.isInteger(seat) || !room.players[seat]) continue;
    const prev = memory.get(seat) ?? [];
    prev.push(`[D${room.dayNumber}|${room.phase}] ${line}`);
    memory.set(seat, prev.slice(-AI_MEMORY_LIMIT));
  }
}

async function maybeRefreshAiMemorySummary(room: import('./game/types.js').Room, seatIndex: number): Promise<void> {
  if (!aiPlayerLlmAvailable()) return;
  const memory = getAiMemoryBySeat(room);
  const summaryBySeat = getAiMemorySummaryBySeat(room);
  const cursorBySeat = getAiMemorySummaryCursorBySeat(room);
  const raw = memory.get(seatIndex) ?? [];
  const prevCursor = Number(cursorBySeat.get(seatIndex) ?? 0);
  const delta = raw.length - prevCursor;
  const hasSummary = String(summaryBySeat.get(seatIndex) ?? '').trim().length > 0;
  if (delta < AI_MEMORY_SUMMARY_MIN_DELTA && hasSummary) return;

  const inflightKey = `ai_memory_summary_inflight_${seatIndex}`;
  if (room.storytellerDecisions.get(inflightKey) === true) return;
  room.storytellerDecisions.set(inflightKey, true);
  try {
    const previousSummary = summaryBySeat.get(seatIndex) ?? '';
    const recentEvents = raw.slice(-40);
    const next = await refineAiPlayerMemorySummary({
      seatIndex,
      previousSummary,
      recentEvents,
      maxChars: AI_MEMORY_SUMMARY_MAX_CHARS,
    });
    if (String(next).trim()) {
      summaryBySeat.set(seatIndex, String(next).trim());
      cursorBySeat.set(seatIndex, raw.length);
    }
  } finally {
    room.storytellerDecisions.set(inflightKey, false);
  }
}

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
  const voice = buildVoiceProfile(room, seatIndex);
  const seed = `${room.id}|forced_day_plan|seat=${seatIndex}|day=${room.dayNumber}`;
  const publicTemplates = rolePush
    ? [
      `${infoPart}我先把我这边信息摊出来：我目前更怀疑 ${targetLabel}${altLabel}，因为它和公开发言/票型有冲突点需要解释。建议先提名 ${targetLabel} 观察票型反应，再决定是否处决。`,
      `${infoPart}我有个担心：${targetLabel}${altLabel} 这边信息链对不上（发言/票型里有矛盾）。我想先小步验证——先提名看票型，大家有不同信息欢迎补充。`,
      `${infoPart}给两点理由我为什么想看 ${targetLabel}${altLabel}：①公开信息里矛盾未解释；②票型/节奏上更像关键位。先提名试探，别急着一锤定音。`,
      `${infoPart}我先不下死结论，但 ${targetLabel}${altLabel} 值得今天优先验证。我们先提名 ${targetLabel} 看谁愿意跟票、谁在躲票，再决定是否处决。`,
    ]
    : [
      `我先抛一个假设：${targetLabel}${altLabel} 可能更值得优先验证。理由来自公开发言与票型细节（欢迎反驳/补充）。建议先提名 ${targetLabel} 看票型反应。`,
      `我暂时没有强信息，但不想空转：我倾向先看 ${targetLabel}${altLabel}。先提名 ${targetLabel} 观察票型，大家把自己的理由说清楚再做处决共识。`,
      `我更想走“可验证”的路径：先围绕 ${targetLabel}${altLabel} 做一次提名试探，看看票型与发言的对应关系，再决定处决目标。`,
      `我直觉上觉得 ${targetLabel}${altLabel} 值得先压一下，但我也可能错。先提名 ${targetLabel}，如果你们有更强信息请直接抛出来。`,
    ];
  const publicText = `${voice} ${pickBySeed(publicTemplates, seed)}`;
  const dm: Array<{ toSeat: number; text: string }> = [];
  if (target != null) {
    for (const p of room.players) {
      if (!p.isAlive || p.seatIndex === seatIndex || p.seatIndex === target) continue;
      dm.push({
        toSeat: p.seatIndex,
        text: rolePush
          ? `我这边夜间信息（可简述）：${myInfo || '有但不便全公开'}。我目前更想先验证 #${target + 1}${alt != null ? `（备选 #${alt + 1}）` : ''}，理由是它和公开发言/票型有冲突点。你昨晚有信息吗？你更怀疑谁、为什么？如果你也觉得可疑，白天可以先提名/投票观察票型。`
          : `我目前更想先看 #${target + 1}${alt != null ? `（备选 #${alt + 1}）` : ''}，主要基于公开发言与票型的细节。你这边有信息或更强嫌疑目标吗？如果你同意，我们可以先围绕这个座位提名试探票型，再决定是否处决。`,
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

function isBackgroundSystemLine(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return true;
  return t.includes('AI 托管已开启')
    || t.includes('AI 托管已关闭')
    || t.includes('AI 说书人已接管流程')
    || t.includes('AI 说书人已关闭');
}

function isHighSignalPublicLine(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t || isBackgroundSystemLine(t)) return false;
  return t.includes('公开发言')
    || t.includes('提名')
    || t.includes('投票')
    || t.includes('处决')
    || t.includes('死亡')
    || t.includes('复活')
    || t.includes('进入夜晚')
    || t.includes('进入白天')
    || t.includes('夜晚结束');
}

function ensureAiTakeoverForUnattendedSeats(room: import('./game/types.js').Room): number {
  const connectedSeats = new Set<number>(Array.from(room.connections.values()));
  let enabledCount = 0;
  for (const p of room.players) {
    const seat = p.seatIndex;
    // 已有真人在线连接的座位保持手动，不强制接管。
    if (connectedSeats.has(seat)) continue;
    if (!(room.aiPlayerEnabledBySeat.get(seat) ?? false)) {
      room.aiPlayerEnabledBySeat.set(seat, true);
      enabledCount++;
    }
    ensureAiBehaviorStyle(room, seat);
    room.aiPlayerLastActionAtBySeat.set(seat, 0);
  }
  return enabledCount;
}

const AI_BEHAVIOR_STYLES: Array<import('./game/types.js').AiBehaviorStyle> = [
  'analytical',
  'skeptical',
  'cautious',
  'empathetic',
  'deceptive',
  'chaotic',
];

function temperatureFromBehaviorStyle(style: import('./game/types.js').AiBehaviorStyle): number {
  if (style === 'analytical') return 0.35;
  if (style === 'skeptical') return 0.45;
  if (style === 'cautious') return 0.25;
  if (style === 'empathetic') return 0.55;
  if (style === 'deceptive') return 0.65;
  return 0.8;
}

function setAiBehaviorStyle(room: import('./game/types.js').Room, seatIndex: number, style: import('./game/types.js').AiBehaviorStyle): void {
  room.aiPlayerBehaviorStyleBySeat.set(seatIndex, style);
  room.aiPlayerTemperatureBySeat.set(seatIndex, temperatureFromBehaviorStyle(style));
  // 行为方式改变后，允许立即重新规划（避免继续沿用旧 day_plan）
  room.storytellerDecisions.delete(`ai_day_plan_${room.dayNumber}_seat_${seatIndex}`);
}

function ensureAiBehaviorStyle(room: import('./game/types.js').Room, seatIndex: number): import('./game/types.js').AiBehaviorStyle {
  const existing = room.aiPlayerBehaviorStyleBySeat.get(seatIndex);
  if (existing) return existing;
  // 每局固定随机：用 room.createdAt 作为一局的稳定种子，避免运行中抖动
  const seed = `${room.id}|ai_behavior|seat=${seatIndex}|createdAt=${room.createdAt}`;
  const style = pickBySeed(AI_BEHAVIOR_STYLES, seed);
  setAiBehaviorStyle(room, seatIndex, style);
  return style;
}

function hashToInt(s: string): number {
  // 简单稳定 hash（非加密）：用于“可复现伪随机”
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickBySeed<T>(items: T[], seed: string): T {
  if (items.length === 0) throw new Error('pickBySeed: empty items');
  const idx = hashToInt(seed) % items.length;
  return items[idx]!;
}

function buildVoiceProfile(room: import('./game/types.js').Room, seatIndex: number): string {
  const style = ensureAiBehaviorStyle(room, seatIndex);
  const baseSeed = `${room.id}|seat=${seatIndex}|day=${room.dayNumber}|style=${style}`;
  const byStyle: Record<import('./game/types.js').AiBehaviorStyle, string[]> = {
    analytical: [
      '画像=条理型：偏好用“1/2/3点”结构，说话简洁，强调可验证事实与票型。',
      '画像=推理型：偏好列出证据链与反证，谨慎下结论，倾向先提名验证。',
    ],
    skeptical: [
      '画像=质询型：偏好反问与追问矛盾点，要求对方给出理由，但语气不过分强硬。',
      '画像=怀疑型：更关注“谁在回避细节/谁在带节奏”，用问题逼出信息。',
    ],
    cautious: [
      '画像=谨慎型：更强调不确定性与风险点（中毒/伪装），倾向先小步验证再下结论。',
      '画像=保守型：倾向先收集信息、少做大跳跃结论，避免误处决关键好人。',
    ],
    empathetic: [
      '画像=共情型：语气更友好，先认可他人观点再补充自己的理由，擅长拉共识。',
      '画像=协调型：擅长总结分歧并提出折中验证方案，减少对立情绪。',
    ],
    deceptive: [
      '画像=圆滑型：表达更委婉、模糊留余地，善于转移焦点并制造信息噪音。',
      '画像=带节奏型：用“看似合理的理由”引导票型，但避免明显自相矛盾。',
    ],
    chaotic: [
      '画像=戏剧型：适度使用比喻/讲故事式表达，但仍需落到具体可执行下一步。',
      '画像=反常规型：允许非常规推理顺序与节奏，但行动仍需自洽。',
    ],
  };
  return pickBySeed(byStyle[style], baseSeed);
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

function buildAiPlayerMemory(room: import('./game/types.js').Room, seatIndex: number): string {
  const me = room.players[seatIndex];
  if (!me) return '无有效座位信息。';
  const aliveSeats = room.players.filter((p) => p.isAlive).map((p) => `#${p.seatIndex + 1}`);
  const deadSeats = room.players.filter((p) => !p.isAlive).map((p) => `#${p.seatIndex + 1}`);
  const myNightInfo = (getNightInfoLogBySeat(room).get(seatIndex) ?? []).slice(-6);
  const visibleChat = room.chatLog
    .filter((e) => {
      if (e.scope === 'public') return true;
      if (e.scope === 'god') return e.fromSeat === seatIndex;
      if (e.scope === 'dm') return e.fromSeat === seatIndex || e.toSeat === seatIndex;
      return false;
    })
    .filter((e) => !isBackgroundSystemLine(e.text))
    .slice(-10)
    .map((e) => `[${e.scope}] #${e.fromSeat + 1}${typeof e.toSeat === 'number' ? `->#${e.toSeat + 1}` : ''}: ${e.text.slice(0, 70)}`);
  const publicTail = room.publicLog
    .filter((x) => isHighSignalPublicLine(x.line))
    .slice(-10)
    .map((x) => x.line.slice(0, 90));
  const memoryTail = (getAiMemoryBySeat(room).get(seatIndex) ?? []).slice(-24);
  const memorySummary = String(getAiMemorySummaryBySeat(room).get(seatIndex) ?? '').trim();
  const trustTop = pickTopSuspiciousAlive(room, seatIndex, 3).map((x) => `#${x.seatIndex + 1}(${x.score.toFixed(2)})`);
  const voteTail = buildRecentVoteEvents(room).slice(-6);
  return [
    `[核心身份] 你是 #${seatIndex + 1}·${me.nickname}。当前：第 ${room.dayNumber} 天，阶段=${room.phase}/${room.daySubPhase ?? 'none'}。`,
    `[场上存活] 存活：${aliveSeats.join('、') || '无'}；死亡：${deadSeats.join('、') || '无'}。`,
    `[私有信息] 最近夜间信息：${myNightInfo.length > 0 ? myNightInfo.join(' | ') : '暂无'}`,
    `[策略摘要] 你的心路历程（模型整理）：${memorySummary || '暂无'}`,
    `[聊天重点] 你可见聊天：${visibleChat.length > 0 ? visibleChat.join(' || ') : '暂无'}`,
    `[流程重点] 公共流程：${publicTail.length > 0 ? publicTail.join(' || ') : '暂无'}`,
    `[投票重点] 近期提名/投票：${voteTail.length > 0 ? voteTail.join(' || ') : '暂无'}`,
    `[候选目标] 当前高嫌疑目标（内部评分）：${trustTop.length > 0 ? trustTop.join('、') : '暂无明显目标'}`,
    `[校验尾部] 近期原始事件（仅校验）：${memoryTail.length > 0 ? memoryTail.join(' || ') : '暂无'}`,
  ].join('\n');
}

function buildAiSeatContext(room: import('./game/types.js').Room, seatIndex: number): {
  roomView: ReturnType<typeof getRoomView>;
  yourCharacterId: string | null;
  yourRole: ReturnType<typeof buildYourRolePayload>;
  yourAlignment: 'good' | 'evil' | undefined;
  chatLog: AiChatSnapshot;
  allChatLog: AiGlobalChatSnapshot;
  playerMemory: string;
  nightInfo: string[];
  promptStyle: string;
  voiceProfile: string;
} {
  const roomView = getRoomView(room, seatIndex, false);
  const aiRoomView = {
    ...roomView,
    publicLog: (roomView.publicLog ?? []).filter((x) => isHighSignalPublicLine(x.line)),
    chatLog: (roomView.chatLog ?? []).filter((e) => !isBackgroundSystemLine(e.text)),
  };
  const yourCharacterId = getShownCharacterId(room.players[seatIndex]) ?? null;
  const yourRole = buildYourRolePayload(room, seatIndex);
  const yourAlignment = (yourRole as any)?.alignment as ('good' | 'evil' | undefined);
  const chatLog = (aiRoomView.chatLog ?? []).map((e) => ({
    scope: e.scope,
    fromSeat: e.fromSeat,
    toSeat: e.toSeat,
    text: e.text,
    at: e.at,
  }));
  const allChatLog = (aiRoomView.chatLog ?? []).slice(-120).map((e) => ({
    scope: e.scope,
    fromSeat: e.fromSeat,
    toSeat: e.toSeat,
    text: e.text,
    at: e.at,
    dayNumber: e.dayNumber,
    phase: e.phase,
  }));
  const nightInfo = (getNightInfoLogBySeat(room).get(seatIndex) ?? []).slice(-NIGHT_INFO_LOG_LIMIT);
  const playerMemory = buildAiPlayerMemory(room, seatIndex);
  const globalStyle = String(room.storytellerDecisions.get('ai_player_prompt_style') ?? process.env.AI_PLAYER_PROMPT_STYLE ?? 'balanced');
  const styleBySeat = room.storytellerDecisions.get('ai_player_prompt_style_by_seat');
  let promptStyle = globalStyle;
  if (styleBySeat instanceof Map) {
    const seatStyle = styleBySeat.get(seatIndex);
    if (typeof seatStyle === 'string' && seatStyle.trim()) promptStyle = seatStyle;
  }
  // 行为方式模块：优先用它影响 promptStyle（减少同质化 + 与旧“积极程度”合并）
  const behavior = ensureAiBehaviorStyle(room, seatIndex);
  if (behavior === 'analytical') promptStyle = 'balanced';
  else if (behavior === 'skeptical') promptStyle = 'assertive';
  else if (behavior === 'cautious') promptStyle = 'balanced';
  else if (behavior === 'empathetic') promptStyle = 'balanced';
  else if (behavior === 'deceptive') promptStyle = 'deceptive';
  else if (behavior === 'chaotic') promptStyle = 'chaotic';
  const voiceProfile = buildVoiceProfile(room, seatIndex);
  return { roomView: aiRoomView, yourCharacterId, yourRole, yourAlignment, chatLog, allChatLog, playerMemory, nightInfo, promptStyle, voiceProfile };
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

type IntentSource =
  | 'human_player'
  | 'ai_player'
  | 'storyteller_fallback';

type AdjudicationStage = 'nomination' | 'vote' | 'night_action';

interface AdjudicationRecord {
  at: number;
  stage: AdjudicationStage;
  source: IntentSource;
  actorSeat: number;
  mode: 'rules_engine' | 'storyteller_ai';
  intent: Record<string, unknown>;
  ok: boolean;
  error?: string;
  applied?: Record<string, unknown>;
}

interface Adjudicator {
  mode: 'rules_engine' | 'storyteller_ai';
  adjudicateNomination: (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    targetSeat: number;
  }) => { ok: boolean; error?: string; appliedTargetSeat?: number; rationale?: string };
  adjudicateVote: (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    inFavor: boolean;
  }) => { ok: boolean; error?: string; appliedInFavor?: boolean; rationale?: string };
  adjudicateNightAction: (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    targets: number[];
  }) => { ok: boolean; error?: string; info?: string; appliedTargets?: number[]; rationale?: string };
}

function getAdjudicationLog(room: import('./game/types.js').Room): AdjudicationRecord[] {
  const k = 'adjudication_log';
  const v = room.storytellerDecisions.get(k);
  if (Array.isArray(v)) return v as AdjudicationRecord[];
  const out: AdjudicationRecord[] = [];
  room.storytellerDecisions.set(k, out);
  return out;
}

function appendAdjudicationRecord(room: import('./game/types.js').Room, rec: AdjudicationRecord): void {
  const log = getAdjudicationLog(room);
  log.push(rec);
  if (log.length > 800) log.splice(0, log.length - 800);
}

function getAdjudicationLogView(room: import('./game/types.js').Room, limit = 200): AdjudicationRecord[] {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  const log = getAdjudicationLog(room);
  if (log.length <= n) return [...log];
  return log.slice(log.length - n);
}

function resolveAdjudicator(room: import('./game/types.js').Room): Adjudicator {
  const adjudicateNominationByRules = (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    targetSeat: number;
  }): { ok: boolean; error?: string; appliedTargetSeat?: number; rationale?: string } => {
    const ok = nominate(params.room, params.actorSeat, params.targetSeat);
    return ok
      ? { ok: true, appliedTargetSeat: params.targetSeat, rationale: 'rules_engine_nomination_apply_intent' }
      : { ok: false, error: 'nomination_rejected_by_rules' };
  };

  const adjudicateVoteByRules = (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    inFavor: boolean;
  }): { ok: boolean; error?: string; appliedInFavor?: boolean; rationale?: string } => {
    const ok = vote(params.room, params.actorSeat, params.inFavor);
    return ok
      ? { ok: true, appliedInFavor: params.inFavor, rationale: 'rules_engine_vote_apply_intent' }
      : { ok: false, error: 'vote_rejected_by_rules' };
  };

  const adjudicateNominationByStorytellerPolicy = (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    targetSeat: number;
  }): { ok: boolean; error?: string; appliedTargetSeat?: number; rationale?: string } => {
    // 当前策略：提名按玩家意图执行，后续可扩展为“平衡局势”裁量器。
    return adjudicateNominationByRules(params);
  };

  const adjudicateVoteByStorytellerPolicy = (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    inFavor: boolean;
  }): { ok: boolean; error?: string; appliedInFavor?: boolean; rationale?: string } => {
    // 当前策略：投票按玩家意图执行，后续可扩展为“异常票型干预”裁量器。
    return adjudicateVoteByRules(params);
  };

  const adjudicateNightActionByRules = (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    targets: number[];
  }): { ok: boolean; error?: string; info?: string; appliedTargets?: number[]; rationale?: string } => {
    const pending = params.room.pendingNightAction;
    if (!pending) return { ok: false, error: 'no_pending_night_action' };
    if (pending.actorSeatIndex !== params.actorSeat) return { ok: false, error: 'not_your_turn' };
    const validationError = validateNightTargetsForPending(params.room, pending, params.targets);
    if (validationError) return { ok: false, error: validationError };
    const result = submitNightAction(params.room, params.actorSeat, params.targets);
    return { ...result, appliedTargets: params.targets, rationale: 'rules_engine_apply_player_intent' };
  };

  const adjudicateNightActionByStorytellerPolicy = (params: {
    room: import('./game/types.js').Room;
    actorSeat: number;
    targets: number[];
  }): { ok: boolean; error?: string; info?: string; appliedTargets?: number[]; rationale?: string } => {
    const pending = params.room.pendingNightAction;
    if (!pending) return { ok: false, error: 'no_pending_night_action' };
    if (pending.actorSeatIndex !== params.actorSeat) return { ok: false, error: 'not_your_turn' };
    const validationError = validateNightTargetsForPending(params.room, pending, params.targets);
    if (validationError) return { ok: false, error: validationError };

    let finalTargets = params.targets.slice();
    let rationale = 'storyteller_ai_keep_player_intent';
    // 规则内裁量策略（可替换为更复杂策略）：恶魔夜刀默认不允许“无收益自刀”
    // 若玩家选择自刀且当前无存活爪牙可继承，则改为随机其他存活目标。
    if (pending.stepId === 'imp' && finalTargets.length === 1 && finalTargets[0] === params.actorSeat) {
      const aliveMinionExists = params.room.players.some((p) => {
        if (!p.isAlive) return false;
        const cid = p.characterId ?? '';
        return ['poisoner', 'spy', 'baron', 'scarlet_woman'].includes(cid);
      });
      if (!aliveMinionExists) {
        const aliveOthers = params.room.players.filter((p) => p.isAlive && p.seatIndex !== params.actorSeat).map((p) => p.seatIndex);
        if (aliveOthers.length > 0) {
          finalTargets = [aliveOthers[Math.floor(Math.random() * aliveOthers.length)]];
          rationale = 'storyteller_ai_prevent_pointless_imp_self_kill';
        }
      }
    }
    const result = submitNightAction(params.room, params.actorSeat, finalTargets);
    return { ...result, appliedTargets: finalTargets, rationale };
  };

  // 第二阶段收敛骨架：当 AI 说书人开启时，动作先走 storyteller_ai 裁定器分支。
  // 当前实现先与规则引擎保持同结果，后续可在 storyteller_ai 分支接入真实裁量策略。
  if (room.aiStorytellerEnabled) {
    return {
      mode: 'storyteller_ai',
      adjudicateNomination: ({ room, actorSeat, targetSeat }) =>
        adjudicateNominationByStorytellerPolicy({ room, actorSeat, targetSeat }),
      adjudicateVote: ({ room, actorSeat, inFavor }) =>
        adjudicateVoteByStorytellerPolicy({ room, actorSeat, inFavor }),
      adjudicateNightAction: ({ room, actorSeat, targets }) =>
        adjudicateNightActionByStorytellerPolicy({ room, actorSeat, targets }),
    };
  }
  return {
    mode: 'rules_engine',
    adjudicateNomination: ({ room, actorSeat, targetSeat }) =>
      adjudicateNominationByRules({ room, actorSeat, targetSeat }),
    adjudicateVote: ({ room, actorSeat, inFavor }) =>
      adjudicateVoteByRules({ room, actorSeat, inFavor }),
    adjudicateNightAction: ({ room, actorSeat, targets }) =>
      adjudicateNightActionByRules({ room, actorSeat, targets }),
  };
}

function adjudicateAndApplyNomination(
  room: import('./game/types.js').Room,
  actorSeat: number,
  targetSeat: number,
  source: IntentSource,
): { ok: boolean; error?: string } {
  const adjudicator = resolveAdjudicator(room);
  const result = adjudicator.adjudicateNomination({ room, actorSeat, targetSeat });
  appendAdjudicationRecord(room, {
    at: Date.now(),
    stage: 'nomination',
    source,
    actorSeat,
    mode: adjudicator.mode,
    intent: { targetSeat },
    ok: result.ok,
    error: result.error,
    applied: result.ok
      ? {
        type: 'nominate',
        requestedTargetSeat: targetSeat,
        finalTargetSeat: result.appliedTargetSeat ?? targetSeat,
        rationale: result.rationale ?? 'unknown',
      }
      : undefined,
  });
  return result;
}

function adjudicateAndApplyVote(
  room: import('./game/types.js').Room,
  actorSeat: number,
  inFavor: boolean,
  source: IntentSource,
): { ok: boolean; error?: string } {
  const adjudicator = resolveAdjudicator(room);
  const result = adjudicator.adjudicateVote({ room, actorSeat, inFavor });
  appendAdjudicationRecord(room, {
    at: Date.now(),
    stage: 'vote',
    source,
    actorSeat,
    mode: adjudicator.mode,
    intent: { inFavor },
    ok: result.ok,
    error: result.error,
    applied: result.ok
      ? {
        type: 'vote',
        requestedInFavor: inFavor,
        finalInFavor: result.appliedInFavor ?? inFavor,
        rationale: result.rationale ?? 'unknown',
      }
      : undefined,
  });
  return result;
}

function adjudicateAndApplyNightAction(
  room: import('./game/types.js').Room,
  actorSeat: number,
  targets: number[],
  source: IntentSource,
): { ok: boolean; error?: string; info?: string } {
  const adjudicator = resolveAdjudicator(room);
  const result = adjudicator.adjudicateNightAction({ room, actorSeat, targets });
  appendAdjudicationRecord(room, {
    at: Date.now(),
    stage: 'night_action',
    source,
    actorSeat,
    mode: adjudicator.mode,
    intent: { targets },
    ok: result.ok,
    error: result.error,
    applied: result.ok
      ? {
        type: 'night_action',
        playerTargets: targets,
        finalTargets: result.appliedTargets ?? targets,
        hasInfo: !!result.info,
        rationale: result.rationale ?? 'unknown',
      }
      : undefined,
  });
  return result;
}

function shareAiNightInfoAtDawn(roomId: string, room: import('./game/types.js').Room): void {
  void roomId;
  if (room.status !== 'playing' || room.phase !== 'day') return;
  const log = getNightInfoLogBySeat(room);
  const cursors = getAiSharedNightInfoCursor(room);
  const inFallback = !aiPlayerLlmAvailable();
  // 夜间信息属于私密信息，不应自动公开到公屏。
  // 仅在兜底模式下将其作为“内部信任更新”输入，不写入 public/chat。
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
      if (inFallback && Math.random() < temp) updateAiTrustFromSharedNightInfo(room, msg);
    }
    cursors.set(seatIndex, msgs.length);
  }
}

function sendEvilInfo(roomId: string, room: import('./game/types.js').Room) {
  const evilSeats = room.players.filter((p) => p.isAlive && (p.characterId === 'imp' || ['poisoner', 'spy', 'baron', 'scarlet_woman'].includes(p.characterId ?? ''))).map((p) => p.seatIndex);
  const demonSeat = room.players.find((p) => p.isAlive && p.characterId === 'imp')?.seatIndex ?? null;
  // 简化：互相告知座位号（不告知具体身份）
  for (const s of evilSeats) {
    const isDemon = s === demonSeat;
    const me = room.players[s];
    const myChar = me?.characterId ? room.script.characters.find((c) => c.id === me.characterId) : null;
    const abilityText = myChar?.ability ?? '（无能力描述）';
    const message = isDemon
      ? `你是恶魔。你的能力：${abilityText}。你的爪牙座位号：${evilSeats.filter((x) => x !== s).map((x) => `#${x + 1}`).join('、') || '无'}。不在场善良身份：${room.demonBluffs?.join(',') || '无'}`
      : `你是爪牙。你的能力：${abilityText}。恶魔座位号：${demonSeat != null ? `#${demonSeat + 1}` : '未知'}。其他邪恶座位号：${evilSeats.filter((x) => x !== s).map((x) => `#${x + 1}`).join('、') || '无'}`;
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
        if (enabled) ensureAiBehaviorStyle(room, seatIndex);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }

      if (msg.type === 'set_ai_player_behavior_style') {
        if (isAdmin) {
          ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_set_ai_player_behavior_style' }));
          return;
        }
        if (room.status !== 'playing') {
          ws.send(JSON.stringify({ type: 'error', message: 'set_ai_player_behavior_style_not_allowed' }));
          return;
        }
        const style = String((msg as any).style ?? '') as import('./game/types.js').AiBehaviorStyle;
        if (!AI_BEHAVIOR_STYLES.includes(style)) {
          ws.send(JSON.stringify({ type: 'error', message: 'invalid_ai_player_behavior_style' }));
          return;
        }
        // 开启托管时才允许调整（避免“手动玩家被动改掉策略”）
        if (!(room.aiPlayerEnabledBySeat.get(seatIndex) ?? false)) {
          ws.send(JSON.stringify({ type: 'error', message: 'ai_player_not_enabled' }));
          return;
        }
        setAiBehaviorStyle(room, seatIndex, style);
        room.aiPlayerLastActionAtBySeat.set(seatIndex, 0);
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
        // 兼容旧客户端：温度已合并为“行为方式”模块，不再允许手动设置。
        ws.send(JSON.stringify({ type: 'error', message: 'ai_player_temperature_deprecated' }));
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
          let godReplyText = '';
          if (room.aiStorytellerEnabled) {
            const replyText = makeDeterministicGodReply(room, seatIndex, text);
            godReplyText = replyText;
            const reply = pushChat(room, {
              at: Date.now(),
              scope: 'god',
              phase: room.phase,
              dayNumber: room.dayNumber,
              fromSeat: seatIndex,
              text: replyText,
            });
            broadcastChat(roomId, reply);
          } else {
            godReplyText = '上帝：当前为人工说书人模式，请等待说书人回应。';
            const reply = pushChat(room, {
              at: Date.now(),
              scope: 'god',
              phase: room.phase,
              dayNumber: room.dayNumber,
              fromSeat: seatIndex,
              text: godReplyText,
            });
            broadcastChat(roomId, reply);
          }
          emitGodConversationTrace(roomId, room, seatIndex, text, godReplyText);
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
        if (room.awaitingNightInfoConfirm) {
          if (!room.pendingNightInfoConfirmSeats.has(seatIndex)) {
            ws.send(JSON.stringify({ type: 'error', message: 'night_info_confirm_not_required_for_you' }));
            return;
          }
          room.nightInfoConfirmations.add(seatIndex);
          broadcastNightConfirm(roomId, room);
          const done = Array.from(room.pendingNightInfoConfirmSeats.values()).every((s) => room.nightInfoConfirmations.has(s));
          if (done) {
            const { key, title } = nightReplayTitle(room);
            const labels = Array.from(room.pendingNightInfoConfirmSeats.values()).map((s) => seatLabel(room, s)).join('、');
            pushReplay(room, key, title, `${labels || '信息位'} 已确认夜间信息，继续推进夜晚。`);
            room.awaitingNightInfoConfirm = false;
            room.pendingNightInfoConfirmSeats = new Set();
            room.nightInfoConfirmations = new Set();
            const phaseBeforeLoop = room.phase;
            await runNightLoopExclusive(roomId, room);
            sendNightPrompt(roomId, room);
            broadcastAfterNight(roomId, room, phaseBeforeLoop);
            broadcastNightConfirm(roomId, room);
          }
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
        const trace = createInvocation(room, {
          actor: 'storyteller',
          stage: 'storyteller_decision',
          roomId,
          seatIndex,
          phase: room.phase,
          stepId: 'post_game_qa',
          model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
          status: 'started',
          request: toTraceText({
            type: 'post_game_ask_god',
            askerSeatIndex: seatIndex,
            question,
          }),
        });
        sendAiTrace(roomId, seatIndex, trace);
        const startedAt = Date.now();
        const answer = await answerPostGameQuestion(room, seatIndex, question);
        const responded = updateInvocation(room, trace.id, {
          status: 'responded',
          elapsedMs: Date.now() - startedAt,
          response: toTraceText(answer),
        });
        if (responded) sendAiTrace(roomId, seatIndex, responded);
        const applied = updateInvocation(room, trace.id, {
          status: 'applied',
          behavior: 'post_game_god_answer_sent',
        });
        if (applied) sendAiTrace(roomId, seatIndex, applied);
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
        if (room.aiStorytellerEnabled) {
          const enabledCount = ensureAiTakeoverForUnattendedSeats(room);
          if (enabledCount > 0) {
            const section = room.phase === 'day' ? dayReplayTitle(room) : nightReplayTitle(room);
            pushReplay(room, section.key, section.title, `AI 说书人接管后，已自动开启 ${enabledCount} 个无人在线座位的 AI 玩家托管。`);
          }
        }
        const tip = room.aiStorytellerEnabled ? 'AI 说书人已接管流程。' : 'AI 说书人已关闭，切回人工控制。';
        const section = room.phase === 'day' ? dayReplayTitle(room) : nightReplayTitle(room);
        pushReplay(room, section.key, section.title, tip);
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
        if (room.aiStorytellerEnabled) {
          const enabledCount = ensureAiTakeoverForUnattendedSeats(room);
          if (enabledCount > 0) {
            pushReplay(room, 'setup', '对局', `开局前自动开启 ${enabledCount} 个无人在线座位的 AI 托管。`);
          }
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
        const applied = adjudicateAndApplyNomination(room, seatIndex, msg.nominatedSeat, 'human_player');
        if (!applied.ok) {
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
        const applied = adjudicateAndApplyVote(room, seatIndex, msg.inFavor, 'human_player');
        if (!applied.ok) {
          ws.send(JSON.stringify({ type: 'error', message: `vote_failed:${applied.error ?? 'unknown'}` }));
          return;
        }
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
        if (!pendingBefore || pendingBefore.actorSeatIndex !== seatIndex) {
          ws.send(JSON.stringify({ type: 'error', message: 'night_action_failed:not_your_turn' }));
          sendNightPrompt(roomId, room);
          return;
        }
        let finalTargets = targets;
        if (isNightPlayerActionStepId(pendingBefore.stepId) && (pendingBefore.pick === 1 || pendingBefore.pick === 2)) {
          const validationError = validateNightTargetsForPending(room, pendingBefore, targets);
          if (validationError) {
            ws.send(JSON.stringify({ type: 'error', message: `night_action_failed:${validationError}` }));
            ws.send(JSON.stringify({ type: 'error', message: `请按你的身份能力行动（${pendingBefore.stepId} 需要选择 ${pendingBefore.pick} 名目标）` }));
            sendNightPrompt(roomId, room);
            return;
          }
          finalTargets = targets;
        }
        const result = adjudicateAndApplyNightAction(room, seatIndex, finalTargets, 'human_player');
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'error', message: `night_action_failed:${result.error ?? 'unknown'}` }));
          ws.send(JSON.stringify({ type: 'error', message: `请按你的身份能力行动（${pendingBefore.stepId}）` }));
          sendNightPrompt(roomId, room);
          return;
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

server.on('error', (e: any) => {
  const code = e && typeof e === 'object' ? (e.code as string | undefined) : undefined;
  if (code === 'EADDRINUSE') {
    console.error(`[server] PORT ${HTTP_PORT} already in use. Another dev server instance is running.`);
    console.error(`[server] Fix: stop the other process, or start this one with PORT=<otherPort>.`);
    process.exit(1);
  }
  console.error('[server] fatal server error', e);
  process.exit(1);
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
    // 重要：AI 玩家托管与 AI 说书人接管解耦。
    // 只要座位开启了 AI 托管，就允许该座位自动决策与互动。
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
          await maybeRefreshAiMemorySummary(room, seatIndex);
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
              playerMemory,
              nightInfo,
              promptStyle,
              voiceProfile,
            } = buildAiSeatContext(room, seatIndex);

            let dayTraceId: string | null = null;
            const plan = await decideAiPlayerDayPlan(room, seatIndex, {
              roomView,
              yourSeatIndex: seatIndex,
              yourRole,
              yourCharacterId,
              voiceProfile,
              yourAlignment,
              demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
              chatLog,
              allChatLog,
              playerMemory,
              nightInfo,
              voteSnapshot: buildVoteSnapshot(room),
              recentVoteEvents: buildRecentVoteEvents(room),
              nightPrompt: null,
              currentNomination: room.currentNomination,
              promptStyle,
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
            // 若模型给出有效 plan，直接存；否则允许短重试，减少“看起来像兜底”的比例
            if (plan && plan.type === 'day_plan') {
              room.storytellerDecisions.set(planKey, plan);
              room.storytellerDecisions.set(`ai_day_plan_fail_${room.dayNumber}_seat_${seatIndex}`, 0);
              room.storytellerDecisions.set(`ai_day_plan_fail_since_${room.dayNumber}_seat_${seatIndex}`, 0);
              if (dayTraceId) {
                const rec = updateInvocation(room, dayTraceId, {
                  status: 'applied',
                  behavior: 'stored_day_plan',
                });
                if (rec) sendAiTrace(rid, seatIndex, rec);
              }
            } else {
              const failKey = `ai_day_plan_fail_${room.dayNumber}_seat_${seatIndex}`;
              const sinceKey = `ai_day_plan_fail_since_${room.dayNumber}_seat_${seatIndex}`;
              const failCount = incDaySeatCounter(room, failKey);
              const since = getOrInitDaySeatTimer(room, sinceKey);
              const waited = Date.now() - since;
              // 允许短重试窗口：减少强塞计划的“兜底感”
              const allowRetryMs = Number(process.env.AI_DAY_PLAN_RETRY_WINDOW_MS ?? '') || 18_000;
              const maxFailsBeforeFallback = Number(process.env.AI_DAY_PLAN_MAX_FAILS_BEFORE_FALLBACK ?? '') || 2;
              if (failCount >= maxFailsBeforeFallback || waited >= allowRetryMs) {
                room.storytellerDecisions.set(planKey, buildForcedActiveDayPlan(room, seatIndex));
                room.storytellerDecisions.set(failKey, 0);
                room.storytellerDecisions.set(sinceKey, 0);
              }
            }
          }

          const plan = room.storytellerDecisions.get(planKey) as any;
          const stage = room.dayFlowStage;
          const traceId = String(room.storytellerDecisions.get(dayPlanTraceKey(room.dayNumber, seatIndex)) ?? '') || null;

          // 上帝问答阶段：允许多轮“微决策”（每次最多一句 chat_god），不再要求由 day_plan 一次性给出。
          const godMarkKey = `ai_day_god_done_${room.dayNumber}_seat_${seatIndex}`;
          if (stage === 'god_dialogue' && room.storytellerDecisions.get(godMarkKey) !== true) {
            const sinceKey = `ai_day_god_since_${room.dayNumber}_seat_${seatIndex}`;
            const turnsKey = `ai_day_god_turns_${room.dayNumber}_seat_${seatIndex}`;
            const since = getOrInitDaySeatTimer(room, sinceKey);
            const turns = getDaySeatCounter(room, turnsKey);
            const elapsed = Date.now() - since;
            const hasNightInfo = (getNightInfoLogBySeat(room).get(seatIndex) ?? []).length > 0;
            if (elapsed >= DAY_GOD_DIALOGUE_MAX_MS || turns >= AI_DAY_GOD_MAX_TURNS_PER_SEAT || !hasNightInfo) {
              room.storytellerDecisions.set(godMarkKey, true);
              appendBehavior(
                rid,
                room,
                seatIndex,
                traceId,
                !hasNightInfo
                  ? 'god_dialogue:done(no_night_info)'
                  : `god_dialogue:done(turns=${turns}; elapsedMs=${elapsed})`,
              );
            } else {
              const cdKey = `ai_day_chat_cd_${room.dayNumber}_god_${seatIndex}`;
              if (cooldownOk(room, cdKey, AI_DAY_CHAT_COOLDOWN_MS)) {
                const tempNow = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
                const { roomView, yourCharacterId, yourRole, yourAlignment, chatLog, allChatLog, playerMemory, nightInfo, promptStyle, voiceProfile } =
                  buildAiSeatContext(room, seatIndex);
                let dialogueTraceId: string | null = null;
                const mustAskThisTurn = hasNightInfo && turns === 0;
                const godAllowedActions: Array<'noop' | 'chat_god'> = mustAskThisTurn ? ['chat_god'] : ['noop', 'chat_god'];
                const act = await decideAiPlayerConstrainedAction(room, seatIndex, {
                  roomView,
                  yourSeatIndex: seatIndex,
                  yourRole,
                  yourCharacterId,
                  voiceProfile,
                  yourAlignment,
                  demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
                  chatLog,
                  allChatLog,
                  playerMemory,
                  nightInfo,
                  voteSnapshot: buildVoteSnapshot(room),
                  recentVoteEvents: buildRecentVoteEvents(room),
                  nightPrompt: null,
                  currentNomination: room.currentNomination,
                  promptStyle,
                }, tempNow, {
                  allowedActions: godAllowedActions,
                  stageHint: 'god_dialogue',
                  instruction: mustAskThisTurn
                    ? '你现在处于上帝问答阶段。你有夜间信息，必须向上帝发起一次具体提问（禁止 noop）。'
                    : '你现在处于上帝问答阶段：若你确实有夜间信息需要确认/澄清，可向上帝提一个具体问题；否则输出 noop。',
                  outputSchema: {
                    chat_god: { type: 'chat_god', text: 'string' },
                    noop: { type: 'noop' },
                  },
                }, (event) => {
                  if (event.kind === 'request') {
                    const rec = createInvocation(room, {
                      actor: 'player',
                      stage: 'day_dialogue',
                      roomId: rid,
                      seatIndex,
                      phase: room.phase,
                      stepId: 'god_dialogue',
                      model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
                      status: 'started',
                      request: toTraceText(toFullPromptDebugText(event)),
                    });
                    dialogueTraceId = rec.id;
                    sendAiTrace(rid, seatIndex, rec);
                  } else if (event.kind === 'response') {
                    if (!dialogueTraceId) return;
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'responded',
                      elapsedMs: event.elapsedMs,
                      response: toTraceText(event.rawResponse ?? ''),
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  } else if (event.kind === 'error') {
                    if (!dialogueTraceId) return;
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'error',
                      error: event.error ?? 'unknown_error',
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  }
                });
                // 关键：无论是提问还是 noop，都计入一次“上帝问答尝试”。
                // 否则若持续 noop，会一直不涨 turns，最终只能被导演层超时跳过。
                const attemptTurns = incDaySeatCounter(room, turnsKey);
                const askedText = (() => {
                  if (act.type === 'chat_god') {
                    const q = String(act.text ?? '').trim().slice(0, 200);
                    if (q) return q;
                  }
                  // 有夜间信息且首轮必须提问时，若模型未给出有效问题，补一条标准问句，保证不“空转完成”。
                  if (mustAskThisTurn) return '今晚信息';
                  return '';
                })();
                if (askedText) {
                  const ask = pushChat(room, { at: Date.now(), scope: 'god', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: askedText });
                  broadcastChat(rid, ask);
                  const replyText = makeDeterministicGodReply(room, seatIndex, askedText);
                  const reply = pushChat(room, { at: Date.now(), scope: 'god', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: replyText });
                  broadcastChat(rid, reply);
                  const askedCountKey = `ai_day_god_asked_count_${room.dayNumber}_seat_${seatIndex}`;
                  const prevAsked = Number(room.storytellerDecisions.get(askedCountKey) ?? 0);
                  room.storytellerDecisions.set(askedCountKey, Number.isFinite(prevAsked) ? Math.max(0, Math.floor(prevAsked)) + 1 : 1);
                  room.storytellerDecisions.set(`ai_day_god_last_q_${room.dayNumber}_seat_${seatIndex}`, askedText.slice(0, 120));
                  appendBehavior(rid, room, seatIndex, traceId, `god_dialogue:asked="${askedText}" replied="${replyText.slice(0, 80)}" turns=${attemptTurns}`);
                  if (dialogueTraceId) {
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'applied',
                      behavior: `chat_god asked="${askedText.slice(0, 80)}"${mustAskThisTurn && act.type !== 'chat_god' ? ' (forced_default)' : ''}`,
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  }
                } else if (dialogueTraceId) {
                  const rec = updateInvocation(room, dialogueTraceId, {
                    status: 'applied',
                    behavior: `noop turns=${attemptTurns}`,
                  });
                  if (rec) sendAiTrace(rid, seatIndex, rec);
                }
              }
            }
          }

          // 私聊：允许多轮“微决策”（每次最多一条 chat_dm），允许自然出现“试探-回应-再试探”。
          const dmMarkKey = `ai_day_dm_done_${room.dayNumber}_seat_${seatIndex}`;
          if (stage === 'private_dialogue' && room.storytellerDecisions.get(dmMarkKey) !== true) {
            const sinceKey = `ai_day_dm_since_${room.dayNumber}_seat_${seatIndex}`;
            const turnsKey = `ai_day_dm_turns_${room.dayNumber}_seat_${seatIndex}`;
            const since = getOrInitDaySeatTimer(room, sinceKey);
            const turns = getDaySeatCounter(room, turnsKey);
            const elapsed = Date.now() - since;
            if (elapsed >= DAY_PRIVATE_DIALOGUE_MAX_MS || turns >= AI_DAY_DM_MAX_TURNS_PER_SEAT) {
              room.storytellerDecisions.set(dmMarkKey, true);
              appendBehavior(rid, room, seatIndex, traceId, `private_dialogue:done(turns=${turns}; elapsedMs=${elapsed})`);
            } else {
              const cdKey = `ai_day_chat_cd_${room.dayNumber}_dm_${seatIndex}`;
              if (cooldownOk(room, cdKey, AI_DAY_CHAT_COOLDOWN_MS)) {
                const tempNow = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
                const { roomView, yourCharacterId, yourRole, yourAlignment, chatLog, allChatLog, playerMemory, nightInfo, promptStyle, voiceProfile } =
                  buildAiSeatContext(room, seatIndex);
                let dialogueTraceId: string | null = null;
                const act = await decideAiPlayerConstrainedAction(room, seatIndex, {
                  roomView,
                  yourSeatIndex: seatIndex,
                  yourRole,
                  yourCharacterId,
                  voiceProfile,
                  yourAlignment,
                  demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
                  chatLog,
                  allChatLog,
                  playerMemory,
                  nightInfo,
                  voteSnapshot: buildVoteSnapshot(room),
                  recentVoteEvents: buildRecentVoteEvents(room),
                  nightPrompt: null,
                  currentNomination: room.currentNomination,
                  promptStyle,
                }, tempNow, {
                  allowedActions: ['noop', 'chat_dm'],
                  stageHint: 'private_dialogue',
                  instruction: '你现在处于私聊阶段：你可以选择私聊一个对象进行试探/交换信息（只发一条），或输出 noop。',
                  outputSchema: {
                    chat_dm: { type: 'chat_dm', toSeat: 'number', text: 'string' },
                    noop: { type: 'noop' },
                  },
                }, (event) => {
                  if (event.kind === 'request') {
                    const rec = createInvocation(room, {
                      actor: 'player',
                      stage: 'day_dialogue',
                      roomId: rid,
                      seatIndex,
                      phase: room.phase,
                      stepId: 'private_dialogue',
                      model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
                      status: 'started',
                      request: toTraceText(toFullPromptDebugText(event)),
                    });
                    dialogueTraceId = rec.id;
                    sendAiTrace(rid, seatIndex, rec);
                  } else if (event.kind === 'response') {
                    if (!dialogueTraceId) return;
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'responded',
                      elapsedMs: event.elapsedMs,
                      response: toTraceText(event.rawResponse ?? ''),
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  } else if (event.kind === 'error') {
                    if (!dialogueTraceId) return;
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'error',
                      error: event.error ?? 'unknown_error',
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  }
                });
                if (act.type === 'chat_dm') {
                  const toSeat = Number((act as any).toSeat);
                  const text = String((act as any).text ?? '').trim().slice(0, 500);
                  if (Number.isInteger(toSeat) && toSeat !== seatIndex && room.players[toSeat]?.isAlive && text) {
                    if (shouldRejectRoleClaimText(room, seatIndex, text)) {
                      appendBehavior(rid, room, seatIndex, traceId, 'private_dialogue:rejected_role_claim_text');
                      if (dialogueTraceId) {
                        const rec = updateInvocation(room, dialogueTraceId, { status: 'applied', behavior: 'rejected_role_claim_text' });
                        if (rec) sendAiTrace(rid, seatIndex, rec);
                      }
                      // 选项 1：被拦截后立刻重试一次（同轮内），不给下一轮冷却“吞掉”这次机会
                      let dialogueRetryTraceId: string | null = null;
                      const retryAct = await decideAiPlayerConstrainedAction(room, seatIndex, {
                        roomView,
                        yourSeatIndex: seatIndex,
                        yourRole,
                        yourCharacterId,
                        voiceProfile,
                        yourAlignment,
                        demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
                        chatLog,
                        allChatLog,
                        playerMemory,
                        nightInfo,
                        voteSnapshot: buildVoteSnapshot(room),
                        recentVoteEvents: buildRecentVoteEvents(room),
                        nightPrompt: null,
                        currentNomination: room.currentNomination,
                        promptStyle,
                      }, tempNow, {
                        allowedActions: ['noop', 'chat_dm'],
                        stageHint: 'private_dialogue',
                        instruction: '你刚才的表达因身份宣称不一致被拒绝。请重写：不要声称“我是某角色/昨晚查到…”，改为提问或试探（例如“你昨晚有信息吗？”），只发一条私聊或 noop。',
                        outputSchema: {
                          chat_dm: { type: 'chat_dm', toSeat: 'number', text: 'string' },
                          noop: { type: 'noop' },
                        },
                      }, (event) => {
                        if (event.kind === 'request') {
                          const rec = createInvocation(room, {
                            actor: 'player',
                            stage: 'day_dialogue',
                            roomId: rid,
                            seatIndex,
                            phase: room.phase,
                            stepId: 'private_dialogue_retry',
                            model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
                            status: 'started',
                            request: toTraceText(toFullPromptDebugText(event)),
                          });
                          dialogueRetryTraceId = rec.id;
                          sendAiTrace(rid, seatIndex, rec);
                        } else if (event.kind === 'response') {
                          if (!dialogueRetryTraceId) return;
                          const rec = updateInvocation(room, dialogueRetryTraceId, {
                            status: 'responded',
                            elapsedMs: event.elapsedMs,
                            response: toTraceText(event.rawResponse ?? ''),
                          });
                          if (rec) sendAiTrace(rid, seatIndex, rec);
                        } else if (event.kind === 'error') {
                          if (!dialogueRetryTraceId) return;
                          const rec = updateInvocation(room, dialogueRetryTraceId, {
                            status: 'error',
                            error: event.error ?? 'unknown_error',
                          });
                          if (rec) sendAiTrace(rid, seatIndex, rec);
                        }
                      });
                      if (retryAct.type === 'chat_dm') {
                        const retryToSeat = Number((retryAct as any).toSeat);
                        const retryText = String((retryAct as any).text ?? '').trim().slice(0, 500);
                        if (
                          Number.isInteger(retryToSeat)
                          && retryToSeat !== seatIndex
                          && room.players[retryToSeat]?.isAlive
                          && retryText
                          && !shouldRejectRoleClaimText(room, seatIndex, retryText)
                        ) {
                          const entry = pushChat(room, {
                            at: Date.now(),
                            scope: 'dm',
                            phase: room.phase,
                            dayNumber: room.dayNumber,
                            fromSeat: seatIndex,
                            toSeat: retryToSeat,
                            text: retryText,
                          });
                          broadcastChat(rid, entry);
                          const t2 = incDaySeatCounter(room, turnsKey);
                          appendBehavior(rid, room, seatIndex, traceId, `private_dialogue:dm_retry(to=${retryToSeat}) turns=${t2}`);
                          if (dialogueRetryTraceId) {
                            const rec = updateInvocation(room, dialogueRetryTraceId, {
                              status: 'applied',
                              behavior: `chat_dm_retry toSeat=${retryToSeat + 1} text="${retryText.slice(0, 80)}"`,
                            });
                            if (rec) sendAiTrace(rid, seatIndex, rec);
                          }
                        } else if (dialogueRetryTraceId) {
                          const rec = updateInvocation(room, dialogueRetryTraceId, {
                            status: 'applied',
                            behavior: 'retry_invalid_or_rejected',
                          });
                          if (rec) sendAiTrace(rid, seatIndex, rec);
                        }
                      } else if (dialogueRetryTraceId) {
                        const rec = updateInvocation(room, dialogueRetryTraceId, { status: 'applied', behavior: 'noop' });
                        if (rec) sendAiTrace(rid, seatIndex, rec);
                      }
                      continue;
                    }
                    const pairCdKey = `ai_day_dm_pair_cd_${room.dayNumber}_${seatIndex}_${toSeat}`;
                    if (cooldownOk(room, pairCdKey, AI_DAY_DM_PAIR_COOLDOWN_MS)) {
                      const entry = pushChat(room, { at: Date.now(), scope: 'dm', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, toSeat, text });
                      broadcastChat(rid, entry);
                      const t2 = incDaySeatCounter(room, turnsKey);
                      appendBehavior(rid, room, seatIndex, traceId, `private_dialogue:dm(to=${toSeat}) turns=${t2}`);
                      if (dialogueTraceId) {
                        const rec = updateInvocation(room, dialogueTraceId, {
                          status: 'applied',
                          behavior: `chat_dm toSeat=${toSeat + 1} text="${text.slice(0, 80)}"`,
                        });
                        if (rec) sendAiTrace(rid, seatIndex, rec);
                      }
                    }
                  }
                } else if (dialogueTraceId) {
                  const rec = updateInvocation(room, dialogueTraceId, {
                    status: 'applied',
                    behavior: `noop`,
                  });
                  if (rec) sendAiTrace(rid, seatIndex, rec);
                }
              }
            }
          }

          // 公聊：允许多轮“微决策”（每次最多一条 chat_public），并保留超时兜底以保证流程可持续。
          const pubMarkKey = `ai_day_public_done_${room.dayNumber}_seat_${seatIndex}`;
          if (stage === 'public_speech' && room.storytellerDecisions.get(pubMarkKey) !== true) {
            const sinceKey = `ai_day_pub_since_${room.dayNumber}_seat_${seatIndex}`;
            const turnsKey = `ai_day_pub_turns_${room.dayNumber}_seat_${seatIndex}`;
            const since = getOrInitDaySeatTimer(room, sinceKey);
            const turns = getDaySeatCounter(room, turnsKey);
            const elapsed = Date.now() - since;
            if (elapsed >= DAY_PUBLIC_SPEECH_MAX_MS || turns >= AI_DAY_PUBLIC_MAX_TURNS_PER_SEAT) {
              // 若完全沉默且时间到，则兜底发一条，保证流程可持续
              if (turns === 0) {
                // 最后一击：忽略冷却再给 AI 一次必须开口的机会，仍失败才兜底
                const tempNow = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
                const { roomView, yourCharacterId, yourRole, yourAlignment, chatLog, allChatLog, playerMemory, nightInfo, promptStyle, voiceProfile } =
                  buildAiSeatContext(room, seatIndex);
                let dialogueTraceId: string | null = null;
                const act = await decideAiPlayerConstrainedAction(room, seatIndex, {
                  roomView,
                  yourSeatIndex: seatIndex,
                  yourRole,
                  yourCharacterId,
                  voiceProfile,
                  yourAlignment,
                  demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
                  chatLog,
                  allChatLog,
                  playerMemory,
                  nightInfo,
                  voteSnapshot: buildVoteSnapshot(room),
                  recentVoteEvents: buildRecentVoteEvents(room),
                  nightPrompt: null,
                  currentNomination: room.currentNomination,
                  promptStyle,
                }, tempNow, {
                  allowedActions: ['noop', 'chat_public'],
                  stageHint: 'public_speech',
                  instruction: '这是公开发言阶段的最后机会：请务必说一句简短可被回应的话（一个问题/一个疑点/一个建议），禁止输出 noop。',
                  outputSchema: {
                    chat_public: { type: 'chat_public', text: 'string' },
                    noop: { type: 'noop' },
                  },
                }, (event) => {
                  if (event.kind === 'request') {
                    const rec = createInvocation(room, {
                      actor: 'player',
                      stage: 'day_dialogue',
                      roomId: rid,
                      seatIndex,
                      phase: room.phase,
                      stepId: 'public_speech',
                      model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
                      status: 'started',
                      request: toTraceText(toFullPromptDebugText(event)),
                    });
                    dialogueTraceId = rec.id;
                    sendAiTrace(rid, seatIndex, rec);
                  } else if (event.kind === 'response') {
                    if (!dialogueTraceId) return;
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'responded',
                      elapsedMs: event.elapsedMs,
                      response: toTraceText(event.rawResponse ?? ''),
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  } else if (event.kind === 'error') {
                    if (!dialogueTraceId) return;
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'error',
                      error: event.error ?? 'unknown_error',
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  }
                });

                const text = act.type === 'chat_public' ? String((act as any).text ?? '').trim().slice(0, 500) : '';
                if (text) {
                  const entry = pushChat(room, { at: Date.now(), scope: 'public', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text });
                  pushPublic(room, `公开发言：${seatLabel(room, seatIndex)}：${text.slice(0, 500)}`);
                  broadcastChat(rid, entry);
                  broadcast(rid, { type: 'room', room: getRoomView(room) });
                  appendBehavior(rid, room, seatIndex, traceId, 'public_speech:last_chance_spoken');
                  if (dialogueTraceId) {
                    const rec = updateInvocation(room, dialogueTraceId, { status: 'applied', behavior: `chat_public text="${text.slice(0, 80)}"` });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  }
                } else {
                  const fallbackText = buildForcedActiveDayPlan(room, seatIndex).public.text;
                  const entry = pushChat(room, { at: Date.now(), scope: 'public', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: fallbackText.slice(0, 500) });
                  pushPublic(room, `公开发言（超时兜底）：${seatLabel(room, seatIndex)}：${fallbackText.slice(0, 500)}`);
                  broadcastChat(rid, entry);
                  broadcast(rid, { type: 'room', room: getRoomView(room) });
                  appendBehavior(rid, room, seatIndex, traceId, 'public_speech:fallback_due_to_silence');
                  if (dialogueTraceId) {
                    const rec = updateInvocation(room, dialogueTraceId, { status: 'applied', behavior: `noop_then_fallback` });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  }
                }
              }
              room.storytellerDecisions.set(pubMarkKey, true);
              appendBehavior(rid, room, seatIndex, traceId, `public_speech:done(turns=${turns}; elapsedMs=${elapsed})`);
            } else {
              const cdKey = `ai_day_chat_cd_${room.dayNumber}_pub_${seatIndex}`;
              if (cooldownOk(room, cdKey, AI_DAY_CHAT_COOLDOWN_MS)) {
                const tempNow = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.5;
                const { roomView, yourCharacterId, yourRole, yourAlignment, chatLog, allChatLog, playerMemory, nightInfo, promptStyle, voiceProfile } =
                  buildAiSeatContext(room, seatIndex);
                let dialogueTraceId: string | null = null;
                const act = await decideAiPlayerConstrainedAction(room, seatIndex, {
                  roomView,
                  yourSeatIndex: seatIndex,
                  yourRole,
                  yourCharacterId,
                  voiceProfile,
                  yourAlignment,
                  demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
                  chatLog,
                  allChatLog,
                  playerMemory,
                  nightInfo,
                  voteSnapshot: buildVoteSnapshot(room),
                  recentVoteEvents: buildRecentVoteEvents(room),
                  nightPrompt: null,
                  currentNomination: room.currentNomination,
                  promptStyle,
                }, tempNow, {
                  allowedActions: ['noop', 'chat_public'],
                  stageHint: 'public_speech',
                  instruction: '你现在处于公开发言阶段：可以说一句简短、可被回应的话（提出一个疑点/一个问题/一个建议），或输出 noop。',
                  outputSchema: {
                    chat_public: { type: 'chat_public', text: 'string' },
                    noop: { type: 'noop' },
                  },
                }, (event) => {
                  if (event.kind === 'request') {
                    const rec = createInvocation(room, {
                      actor: 'player',
                      stage: 'day_dialogue',
                      roomId: rid,
                      seatIndex,
                      phase: room.phase,
                      stepId: 'public_speech',
                      model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
                      status: 'started',
                      request: toTraceText(toFullPromptDebugText(event)),
                    });
                    dialogueTraceId = rec.id;
                    sendAiTrace(rid, seatIndex, rec);
                  } else if (event.kind === 'response') {
                    if (!dialogueTraceId) return;
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'responded',
                      elapsedMs: event.elapsedMs,
                      response: toTraceText(event.rawResponse ?? ''),
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  } else if (event.kind === 'error') {
                    if (!dialogueTraceId) return;
                    const rec = updateInvocation(room, dialogueTraceId, {
                      status: 'error',
                      error: event.error ?? 'unknown_error',
                    });
                    if (rec) sendAiTrace(rid, seatIndex, rec);
                  }
                });
                if (act.type === 'chat_public') {
                  const text = String((act as any).text ?? '').trim().slice(0, 500);
                  if (text) {
                    if (shouldRejectRoleClaimText(room, seatIndex, text)) {
                      appendBehavior(rid, room, seatIndex, traceId, 'public_speech:rejected_role_claim_text');
                      if (dialogueTraceId) {
                        const rec = updateInvocation(room, dialogueTraceId, { status: 'applied', behavior: 'rejected_role_claim_text' });
                        if (rec) sendAiTrace(rid, seatIndex, rec);
                      }
                      let dialogueRetryTraceId: string | null = null;
                      const retryAct = await decideAiPlayerConstrainedAction(room, seatIndex, {
                        roomView,
                        yourSeatIndex: seatIndex,
                        yourRole,
                        yourCharacterId,
                        voiceProfile,
                        yourAlignment,
                        demonBluffs: yourAlignment === 'evil' ? (room.demonBluffs ?? null) : null,
                        chatLog,
                        allChatLog,
                        playerMemory,
                        nightInfo,
                        voteSnapshot: buildVoteSnapshot(room),
                        recentVoteEvents: buildRecentVoteEvents(room),
                        nightPrompt: null,
                        currentNomination: room.currentNomination,
                        promptStyle,
                      }, tempNow, {
                        allowedActions: ['noop', 'chat_public'],
                        stageHint: 'public_speech',
                        instruction: '你刚才的表达因身份宣称不一致被拒绝。请重写为一句不涉及具体身份自曝的公开发言（一个问题/疑点/建议），或 noop。',
                        outputSchema: {
                          chat_public: { type: 'chat_public', text: 'string' },
                          noop: { type: 'noop' },
                        },
                      }, (event) => {
                        if (event.kind === 'request') {
                          const rec = createInvocation(room, {
                            actor: 'player',
                            stage: 'day_dialogue',
                            roomId: rid,
                            seatIndex,
                            phase: room.phase,
                            stepId: 'public_speech_retry',
                            model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus',
                            status: 'started',
                            request: toTraceText(toFullPromptDebugText(event)),
                          });
                          dialogueRetryTraceId = rec.id;
                          sendAiTrace(rid, seatIndex, rec);
                        } else if (event.kind === 'response') {
                          if (!dialogueRetryTraceId) return;
                          const rec = updateInvocation(room, dialogueRetryTraceId, {
                            status: 'responded',
                            elapsedMs: event.elapsedMs,
                            response: toTraceText(event.rawResponse ?? ''),
                          });
                          if (rec) sendAiTrace(rid, seatIndex, rec);
                        } else if (event.kind === 'error') {
                          if (!dialogueRetryTraceId) return;
                          const rec = updateInvocation(room, dialogueRetryTraceId, {
                            status: 'error',
                            error: event.error ?? 'unknown_error',
                          });
                          if (rec) sendAiTrace(rid, seatIndex, rec);
                        }
                      });
                      if (retryAct.type === 'chat_public') {
                        const retryText = String((retryAct as any).text ?? '').trim().slice(0, 500);
                        if (retryText && !shouldRejectRoleClaimText(room, seatIndex, retryText)) {
                          const entry = pushChat(room, { at: Date.now(), scope: 'public', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text: retryText });
                          pushPublic(room, `公开发言：${seatLabel(room, seatIndex)}：${retryText.slice(0, 500)}`);
                          broadcastChat(rid, entry);
                          broadcast(rid, { type: 'room', room: getRoomView(room) });
                          const t2 = incDaySeatCounter(room, turnsKey);
                          appendBehavior(rid, room, seatIndex, traceId, `public_speech:spoken_retry turns=${t2}`);
                          if (dialogueRetryTraceId) {
                            const rec = updateInvocation(room, dialogueRetryTraceId, {
                              status: 'applied',
                              behavior: `chat_public_retry text="${retryText.slice(0, 80)}"`,
                            });
                            if (rec) sendAiTrace(rid, seatIndex, rec);
                          }
                        } else if (dialogueRetryTraceId) {
                          const rec = updateInvocation(room, dialogueRetryTraceId, { status: 'applied', behavior: 'retry_invalid_or_rejected' });
                          if (rec) sendAiTrace(rid, seatIndex, rec);
                        }
                      } else if (dialogueRetryTraceId) {
                        const rec = updateInvocation(room, dialogueRetryTraceId, { status: 'applied', behavior: 'noop' });
                        if (rec) sendAiTrace(rid, seatIndex, rec);
                      }
                    } else {
                    const entry = pushChat(room, { at: Date.now(), scope: 'public', phase: room.phase, dayNumber: room.dayNumber, fromSeat: seatIndex, text });
                    pushPublic(room, `公开发言：${seatLabel(room, seatIndex)}：${text.slice(0, 500)}`);
                    broadcastChat(rid, entry);
                    broadcast(rid, { type: 'room', room: getRoomView(room) });
                    const t2 = incDaySeatCounter(room, turnsKey);
                    appendBehavior(rid, room, seatIndex, traceId, `public_speech:spoken="${text.slice(0, 80)}" turns=${t2}`);
                    if (dialogueTraceId) {
                      const rec = updateInvocation(room, dialogueTraceId, {
                        status: 'applied',
                        behavior: `chat_public text="${text.slice(0, 80)}"`,
                      });
                      if (rec) sendAiTrace(rid, seatIndex, rec);
                    }
                    }
                  }
                } else if (dialogueTraceId) {
                  const rec = updateInvocation(room, dialogueTraceId, {
                    status: 'applied',
                    behavior: `noop`,
                  });
                  if (rec) sendAiTrace(rid, seatIndex, rec);
                }
              }
            }
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
      // 1) 夜间信息确认：AI 玩家自动确认（仅对被要求确认的信息位）
      if (room.awaitingNightInfoConfirm && (room.phase === 'night' || room.phase === 'first_night')) {
        if (room.pendingNightInfoConfirmSeats.has(seatIndex) && !room.nightInfoConfirmations.has(seatIndex)) {
          room.nightInfoConfirmations.add(seatIndex);
          broadcastNightConfirm(rid, room);
          const done = Array.from(room.pendingNightInfoConfirmSeats.values()).every((s) => room.nightInfoConfirmations.has(s));
          if (done) {
            room.awaitingNightInfoConfirm = false;
            room.pendingNightInfoConfirmSeats = new Set();
            room.nightInfoConfirmations = new Set();
            const phaseBeforeLoop = room.phase;
            await runNightLoopExclusive(rid, room);
            sendNightPrompt(rid, room);
            broadcastAfterNight(rid, room, phaseBeforeLoop);
            broadcastNightConfirm(rid, room);
          }
        }
        continue;
      }

      // 2) 夜晚等待确认：AI 玩家自动确认
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

      // 3) 夜晚轮到该 AI 玩家行动：
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
          const result = adjudicateAndApplyNightAction(room, seatIndex, targets, 'storyteller_fallback');
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

      // 4) 白天提名阶段：若该 AI 玩家尚未做出“提名/不提名”，则自动进行一次操作，保证白天可结束
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
            ok = adjudicateAndApplyNomination(room, seatIndex, planNom.targetSeat, 'ai_player').ok;
            if (ok) {
              const { key, title } = dayReplayTitle(room);
              pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）提名 ${seatLabel(room, planNom.targetSeat)}。`);
              pushPublic(room, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, planNom.targetSeat)}。`);
              appendBehavior(rid, room, seatIndex, traceId, `nomination_vote:nominate(target=${planNom.targetSeat + 1})`);
              broadcast(rid, { type: 'room', room: getRoomView(room) });
            }
          }
          if (!ok) {
            const inFallback = !aiPlayerLlmAvailable();
            if (!inFallback) {
              if (aggressiveGoodInfo) {
                const target = pickMostSuspiciousAlive(room, seatIndex);
                if (target != null) {
                  ok = adjudicateAndApplyNomination(room, seatIndex, target, 'ai_player').ok;
                  if (ok) {
                    const { key, title } = dayReplayTitle(room);
                    pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）根据信息位策略主动提名 ${seatLabel(room, target)}。`);
                    pushPublic(room, `${seatLabel(room, seatIndex)} 发起主动提名 ${seatLabel(room, target)}（信息位推进）。`);
                    appendBehavior(rid, room, seatIndex, traceId, `nomination_vote:nominate_good_info_push(target=${target + 1})`);
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
              ok = adjudicateAndApplyNomination(room, seatIndex, target, 'storyteller_fallback').ok;
              if (ok) {
                const { key, title } = dayReplayTitle(room);
                pushReplay(room, key, title, `${seatLabel(room, seatIndex)}（AI）提名 ${seatLabel(room, target)}。`);
                pushPublic(room, `${seatLabel(room, seatIndex)} 提名 ${seatLabel(room, target)}。`);
                appendBehavior(rid, room, seatIndex, traceId, `nomination_vote:nominate_fallback(target=${target + 1})`);
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

      // 5) 白天投票：若当前有提名且该 AI 玩家可投票但尚未投，则自动投票
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
          const appliedVote = adjudicateAndApplyVote(room, seatIndex, inFavor, 'ai_player');
          if (!appliedVote.ok) continue;
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
        await maybeRefreshAiMemorySummary(room, seatIndex);
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
          playerMemory,
          nightInfo,
          promptStyle,
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
          playerMemory,
          nightInfo,
          voteSnapshot: buildVoteSnapshot(room),
          recentVoteEvents: buildRecentVoteEvents(room),
          nightPrompt,
          currentNomination: room.currentNomination,
          promptStyle,
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
          if (!isNightPlayerActionStepId(pendingNow.stepId) || (pendingNow.pick !== 1 && pendingNow.pick !== 2)) continue;
          const validationError = validateNightTargetsForPending(room, pendingNow, playerSuggestedTargets);
          if (validationError) {
            if (nightTraceId) {
              const rec = updateInvocation(room, nightTraceId, {
                status: 'fallback',
                behavior: `fallback_due_to_invalid_night_targets:${validationError}`,
              });
              if (rec) sendAiTrace(rid, seatIndex, rec);
            }
            continue;
          }
          const finalTargets = playerSuggestedTargets;
          const pendingBefore = room.pendingNightAction;
          const result = adjudicateAndApplyNightAction(room, seatIndex, finalTargets, 'ai_player');
          if (result.ok) {
            if (nightTraceId) {
              const rec = updateInvocation(room, nightTraceId, {
                status: 'applied',
                behavior: `player_suggested_targets=${JSON.stringify(playerSuggestedTargets)}; storyteller_final_targets=${JSON.stringify(finalTargets)}`,
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
