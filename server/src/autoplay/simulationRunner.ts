// ============================================================
// 自动模拟运行器：全 AI 对局的批量化执行引擎
// ============================================================

import { configureLlm } from '../llm/llmClient.js';
import { createRoom, setReady } from '../game/roomManager.js';
import { troubleBrewing } from '../scripts/troubleBrewing.js';
import {
  startGame, getEffectiveCharacterId, getShownCharacterId,
  getCurrentNightStep, nominate, skipNomination, vote, tallyVotes,
  execute, maybeFinishDay, finishNightAndGotoDay,
  submitNightAction, checkWin, isPoisoned, assignRoles,
} from '../game/gameEngine.js';
import type { Room, PlayerSeat, Alignment, ChatEntry, ReplayLogEntry } from '../game/types.js';
import { buildGameRecord, writeGameRecord } from '../engine/gameRecord.js';
import {
  decideAiPlayerDayPlan, decideAiPlayerNightTargets,
  type AiPlayerContext,
} from '../ai/playerAgent.js';
import { buildStorytellerPrompts } from '../agents/storyteller/prompts.js';
import { callLlm } from '../llm/llmClient.js';

const AI_STORYTELLER_ENABLED = (process.env.USE_AI_STORYTELLER ?? 'true').trim().toLowerCase() !== 'false';

export interface SimulationResult {
  gameId: string;
  playerCount: number;
  winner: 'good' | 'evil';
  daysElapsed: number;
  totalNightActions: number;
  totalDayActions: number;
  aiCallCount: number;
  durationMs: number;
  roles: Array<{ seatIndex: number; nickname: string; characterId: string; characterNameZh: string; alignment: string; survived: boolean }>;
  narrative: string[];
  error?: string;
}

export interface BatchSimulationStats {
  totalGames: number; goodWins: number; evilWins: number;
  goodWinRate: number; evilWinRate: number;
  avgDays: number; avgDurationMs: number;
  results: SimulationResult[];
}

// ============================================================
// Simple WorldView built from flat Room
// ============================================================

interface SimWorldView {
  seatIndex: number;
  phase: string;
  dayNumber: number;
  daySubPhase: string | null;
  aliveSeatIndices: number[];
  deadSeatIndices: number[];
  players: Array<{ seatIndex: number; nickname: string; isAlive: boolean }>;
  yourRole?: { characterId: string; characterNameZh: string; ability: string; alignment: Alignment };
  publicLog: Array<{ seq: number; at: number; line: string }>;
  chatLog: ChatEntry[];
  lastNightDeaths: number[];
  currentNomination: { nominator: number; nominated: number } | null;
  nominationsToday: Array<{ nominator: number; nominated: number }>;
  pendingExecution: number | null;
}

function buildSimWorldView(room: Room, seatIndex: number): SimWorldView {
  const p = room.players[seatIndex];
  if (!p) throw new Error(`invalid seat ${seatIndex}`);

  const shownId = getShownCharacterId(p);
  const shownMeta = shownId ? room.script.characters.find(c => c.id === shownId) : undefined;
  const realMeta = p.characterId ? room.script.characters.find(c => c.id === p.characterId) : undefined;

  return {
    seatIndex,
    phase: room.phase,
    dayNumber: room.dayNumber,
    daySubPhase: room.daySubPhase,
    aliveSeatIndices: room.players.filter(x => x.isAlive).map(x => x.seatIndex),
    deadSeatIndices: room.players.filter(x => !x.isAlive).map(x => x.seatIndex),
    players: room.players.map(x => ({ seatIndex: x.seatIndex, nickname: x.nickname, isAlive: x.isAlive })),
    yourRole: shownId ? {
      characterId: shownId,
      characterNameZh: shownMeta?.nameZh ?? shownId,
      ability: shownMeta?.ability ?? '',
      alignment: (realMeta?.alignment ?? 'good') as Alignment,
    } : undefined,
    publicLog: room.publicLog,
    chatLog: room.chatLog,
    lastNightDeaths: room.lastNightDeaths,
    currentNomination: room.currentNomination,
    nominationsToday: Array.from(room.nominationsToday.entries()).map(([a, b]) => ({ nominator: a, nominated: b })),
    pendingExecution: room.pendingExecution,
  };
}

function buildAiPlayerContext(room: Room, seatIndex: number): AiPlayerContext {
  const p = room.players[seatIndex];
  const realMeta = p.characterId ? room.script.characters.find(c => c.id === p.characterId) : undefined;
  const chatLog: Array<{ scope: string; fromSeat: number; toSeat?: number; text: string; at: number }> =
    room.chatLog.map(c => ({ scope: c.scope, fromSeat: c.fromSeat, toSeat: c.toSeat, text: c.text, at: c.at }));

  // Gather night info for this seat (simplified: from replayLog)
  const nightInfo: string[] = [];
  const pna = room.pendingNightAction;
  if (pna && pna.actorSeatIndex === seatIndex) {
    const stepZh = room.script.characters.find(c => c.id === pna.stepId)?.nameZh ?? pna.stepId;
    nightInfo.push(`轮到你的夜晚行动：${stepZh}，选择 ${pna.pick} 个目标。`);
  }

  const voteSnapshot = room.currentNomination ? {
    currentNomination: room.currentNomination,
    votes: Array.from(room.votes.entries()).map(([s, v]) => ({ seatIndex: s, inFavor: v })),
    nominationsToday: Array.from(room.nominationsToday.entries()).map(([a, b]) => ({ nominator: a, nominated: b })),
    skippedNominationsToday: Array.from(room.skippedNominationsToday),
    aliveSeatIndices: room.players.filter(x => x.isAlive).map(x => x.seatIndex),
    deadSeatIndices: room.players.filter(x => !x.isAlive).map(x => x.seatIndex),
  } : undefined;

  const nightPrompt = room.pendingNightAction?.actorSeatIndex === seatIndex
    ? { stepId: room.pendingNightAction.stepId, pick: room.pendingNightAction.pick, aliveSeatIndices: room.players.filter(x => x.isAlive).map(x => x.seatIndex) }
    : null;

  return {
    roomView: { id: room.id, phase: room.phase, dayNumber: room.dayNumber, daySubPhase: room.daySubPhase },
    yourSeatIndex: seatIndex,
    yourRole: {
      characterId: getShownCharacterId(p) ?? p.characterId ?? '?',
      alignment: realMeta?.alignment ?? 'good',
    },
    yourCharacterId: p.characterId ?? null,
    yourAlignment: realMeta?.alignment ?? 'good',
    demonBluffs: room.demonBluffs,
    chatLog,
    allChatLog: room.chatLog.map(c => ({
      scope: c.scope, fromSeat: c.fromSeat, toSeat: c.toSeat, text: c.text, at: c.at,
      dayNumber: room.dayNumber, phase: room.phase,
    })),
    nightInfo,
    voteSnapshot,
    nightPrompt,
    currentNomination: room.currentNomination,
  };
}

// ============================================================
// ID & nickname helpers
// ============================================================

let simCounter = 0;
function nextGameId(): string { simCounter++; return `sim_${Date.now()}_${simCounter}`; }

const PREFIXES = ['夜行','钟声','雾隐','火漆','预言','静默','迷踪','秘钥','月影','余烬'];
const SUFFIXES = ['守夜人','提名王','验人师','反转侠','沉默狼','谜语客','夜鸦','推理官','投票手','烛火'];

function randomNickname(i: number): string {
  return `${PREFIXES[i % PREFIXES.length]}${SUFFIXES[i % SUFFIXES.length]}${Math.floor(Math.random() * 90) + 10}`;
}
function shuffle<T>(a: T[]): T[] {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

// ============================================================
// Main simulation
// ============================================================

export async function runSingleSimulation(playerCount: number = 5, gameId?: string): Promise<SimulationResult> {
  const startTime = Date.now();
  const gid = gameId ?? nextGameId();
  let aiCallCount = 0;
  const narrative: string[] = [];

  configureLlm({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: (process.env.OPENAI_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode').replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL ?? 'qwen-plus',
    enabled: !!(process.env.OPENAI_API_KEY),
  });

  narrative.push(`[${gid}] 开始:${playerCount}人`);

  const room = createRoom(troubleBrewing.id);
  for (let i = 0; i < playerCount; i++) {
    const j = joinRoomInternal(room, randomNickname(i));
    if (!j) break;
    setReady(room, j.seatIndex, true);
  }

  startGame(room);

  const roleSummary = room.players.map(p => {
    const d = p.characterId ? room.script.characters.find(c => c.id === p.characterId) : undefined;
    return `#${p.seatIndex + 1}=${d?.nameZh ?? '?'}(${d?.alignment === 'evil' ? '恶' : '善'})`;
  });
  narrative.push(`[${gid}] ${roleSummary.join(' ')}`);

  try {
    for (let iter = 0; iter < 100; iter++) {
      if ((room.status as string) !== 'playing') break;

      if (room.phase === 'first_night' || room.phase === 'night') {
        await runNightLoopSim(room, gid, narrative, () => aiCallCount++);
        if ((room.status as string) === 'ended') break;

        if (room.awaitingNightConfirm) {
          for (const p of room.players) room.nightConfirmations.add(p.seatIndex);
          const deaths = room.lastNightDeaths.length > 0
            ? room.lastNightDeaths.map(s => `#${s + 1}`).join(',') : '无';
          narrative.push(`[${gid}] 天亮 死:${deaths}`);
          finishNightAndGotoDay(room);
          if ((room.status as string) !== 'ended') {
            narrative.push(`[${gid}] D${room.dayNumber}`);
            const w = checkWin(room);
            if (w) { narrative.push(`[${gid}] ${w === 'good' ? '善' : '恶'}胜`); (room as any).status = 'ended'; break; }
          }
        }
      }

      if (room.phase === 'day') {
        const dr = await runDayLoopSim(room, gid, narrative, () => aiCallCount++);
        if (dr === 'ended') break;
        if (dr === 'error') { narrative.push(`[${gid}] 白天异常`); break; }
      }

      if ((room.status as string) === 'ended') break;
      const w = checkWin(room);
      if (w) { narrative.push(`[${gid}] ${w === 'good' ? '善' : '恶'}中胜`); (room as any).status = 'ended'; break; }
    }
    if ((room.status as string) === 'playing') narrative.push(`[${gid}] 超时`);
  } catch (e) {
    narrative.push(`[${gid}] 异常:${(e as Error).message?.slice(0, 100)}`);
  }

  const fw = checkWin(room);
  const winner: 'good' | 'evil' = fw === 'good' ? 'good' : 'evil';
  narrative.push(`[${gid}] ${winner === 'good' ? '善' : '恶'}胜`);

  try { const rec = buildGameRecord(room, winner); writeGameRecord(rec); } catch {}
  for (const p of room.players) {
    // Clear AI player threads from storytellerDecisions
    const keysToRemove: string[] = [];
    for (const [k] of room.storytellerDecisions) {
      if (k.includes(`_seat_${p.seatIndex}`) || k.startsWith(`ai_player`)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) room.storytellerDecisions.delete(k);
  }

  return {
    gameId: gid, playerCount: room.players.length, winner,
    daysElapsed: room.dayNumber,
    totalNightActions: 0, totalDayActions: 0,
    aiCallCount, durationMs: Date.now() - startTime,
    roles: room.players.map(p => {
      const d = p.characterId ? room.script.characters.find(c => c.id === p.characterId) : undefined;
      return { seatIndex: p.seatIndex, nickname: p.nickname, characterId: p.characterId ?? '?', characterNameZh: d?.nameZh ?? '?', alignment: d?.alignment ?? 'good', survived: p.isAlive };
    }),
    narrative,
  };
}

// ============================================================
// NIGHT LOOP
// ============================================================

async function runNightLoopSim(room: Room, gid: string, narrative: string[], countCall: () => void): Promise<void> {
  for (let s = 0; s < 50; s++) {
    if (room.phase !== 'first_night' && room.phase !== 'night') break;
    const stepId = getCurrentNightStep(room);
    if (!stepId) { room.awaitingNightConfirm = true; break; }
    const cd = room.script.characters.find(c => c.id === stepId);
    if (!cd) { room.nightStepIndex++; continue; }
    const actor = room.players.find(p => p.isAlive && getEffectiveCharacterId(p) === stepId);
    if (cd.id === 'washerwoman' || cd.id === 'librarian' || cd.id === 'investigator') {
      countCall();
      const dec = await simStorytellerDecision(room, stepId);
      if (dec) room.storytellerDecisions.set(stepId, dec);
      room.nightStepIndex++; continue;
    }
    if (stepId === 'demon_info' || stepId === 'minion_info') { room.nightStepIndex++; continue; }
    if (room.pendingNightAction && actor) {
      countCall();
      await handleNightAction(room, actor.seatIndex, narrative, countCall);
      continue;
    }
    room.nightStepIndex++;
  }
}

// ============================================================
// DAY LOOP
// ============================================================

async function runDayLoopSim(room: Room, gid: string, narrative: string[], countCall: () => void): Promise<'continue' | 'ended' | 'error'> {
  // Discussion
  room.daySubPhase = 'discussion';
  room.dayFlowStage = 'public_speech';
  for (const p of room.players) {
    if (!p.isAlive) continue;
    countCall();
    try {
      const wv = buildSimWorldView(room, p.seatIndex);
      const ctx = buildAiPlayerContext(room, p.seatIndex);
      const plan = await decideAiPlayerDayPlan(room, p.seatIndex, ctx, 0.7);
      if (plan.type === 'day_plan' && plan.public?.text?.trim()) {
        narrative.push(`[${gid}] S#${p.seatIndex + 1}:${plan.public.text.slice(0, 60)}`);
      }
    } catch { narrative.push(`[${gid}] S#${p.seatIndex + 1}:err`); }
  }
  if (room.status === 'ended') return 'ended';
  if (checkWin(room)) { room.status = 'ended'; return 'ended'; }

  // Nomination
  room.daySubPhase = 'nomination';
  for (const p of shuffle([...room.players]).filter(x => x.isAlive)) {
    if (room.nominationsToday.has(p.seatIndex) || room.skippedNominationsToday.has(p.seatIndex)) continue;
    countCall();
    try {
      const ctx = buildAiPlayerContext(room, p.seatIndex);
      const plan = await decideAiPlayerDayPlan(room, p.seatIndex, ctx, 0.7);
      if (plan.type === 'day_plan' && plan.nomination?.type === 'nominate') {
        const target = plan.nomination.targetSeat;
        if (nominate(room, p.seatIndex, target)) {
          narrative.push(`[${gid}] N#${p.seatIndex + 1}→#${target + 1}`);
          await doVoting(room, gid, narrative, countCall);
        } else { skipNomination(room, p.seatIndex); }
      } else { skipNomination(room, p.seatIndex); }
    } catch { skipNomination(room, p.seatIndex); }
  }

  // Try to end day
  const dr = maybeFinishDay(room);
  if (dr.ended) {
    if (room.pendingExecution != null) {
      narrative.push(`[${gid}] 处决#${room.pendingExecution + 1}`);
    } else {
      narrative.push(`[${gid}] 无人处决`);
    }
    if (checkWin(room)) { room.status = 'ended'; return 'ended'; }
    return 'continue';
  }

  // If all players handled but day not ended, force transition
  if (room.phase === 'day' && room.daySubPhase !== null) {
    room.daySubPhase = 'discussion';
    room.phase = 'night';
    room.dayFlowStage = null;
    room.dayFlowStartSeat = null;
    room.poisonedSeatIndex = null;
    room.nightStepIndex = 0;
    room.pendingNightAction = null;
    room.protectedSeatIndex = null;
    room.lastNightDeaths = [];
    room.lastNightRevivals = [];
    room.nightKillAttackerByVictim = new Map();
  }

  return 'continue';
}

// ============================================================
// VOTING
// ============================================================

async function doVoting(room: Room, gid: string, narrative: string[], countCall: () => void): Promise<void> {
  if (!room.currentNomination) return;
  for (const p of shuffle([...room.players].filter(x => x.isAlive || x.hasDeadVote))) {
    countCall();
    try {
      const ctx = buildAiPlayerContext(room, p.seatIndex);
      const plan = await decideAiPlayerDayPlan(room, p.seatIndex, ctx, 0.7);
      if (plan.type === 'day_plan') {
        vote(room, p.seatIndex, plan.vote.inFavor);
      } else {
        vote(room, p.seatIndex, true);
      }
    } catch {
      // Default: good votes yes, evil votes no
      const realMeta = p.characterId ? room.script.characters.find(c => c.id === p.characterId) : undefined;
      vote(room, p.seatIndex, realMeta?.alignment !== 'evil');
    }
  }
  const { passed, votesFor } = tallyVotes(room);
  narrative.push(`[${gid}] V${passed ? '通过' : '未过'}(${votesFor})`);
}

// ============================================================
// NIGHT ACTION
// ============================================================

async function handleNightAction(room: Room, seatIdx: number, narrative: string[], countCall: () => void): Promise<void> {
  const pending = room.pendingNightAction;
  if (!pending || pending.actorSeatIndex !== seatIdx) return;
  const others = room.players.filter(p => p.isAlive && p.seatIndex !== seatIdx).map(p => p.seatIndex);

  try {
    countCall();
    const ctx = buildAiPlayerContext(room, seatIdx);
    const action = await decideAiPlayerNightTargets(room, seatIdx, ctx, 0.7);
    if (action.type === 'night_action') {
      const valid = action.targets.filter((t: number) => others.includes(t));
      if (valid.length === pending.pick) {
        await settleNightAction(room, seatIdx, valid, narrative);
        return;
      }
    }
  } catch {}

  // Fallback: random valid targets
  const shuffled = shuffle(others).slice(0, pending.pick);
  await settleNightAction(room, seatIdx, shuffled, narrative);
}

async function settleNightAction(room: Room, seatIdx: number, targets: number[], narrative: string[]): Promise<void> {
  const pending = room.pendingNightAction;
  if (!pending) return;

  if (pending.stepId === 'imp' && targets[0] != null) {
    room.storytellerDecisions.set('imp_kill', targets[0]);
    narrative.push(`[夜] 魔#${seatIdx + 1}→#${targets[0] + 1}`);
  } else if (pending.stepId === 'poisoner' && targets[0] != null) {
    room.poisonedSeatIndex = targets[0];
    room.storytellerDecisions.set('poisoner_poison', targets[0]);
  } else if (pending.stepId === 'monk' && targets[0] != null) {
    room.protectedSeatIndex = targets[0];
    room.storytellerDecisions.set('monk_protect', targets[0]);
  } else if (pending.stepId === 'fortune_teller' && targets.length === 2) {
    room.storytellerDecisions.set('fortune_teller_pick', targets);
  }

  room.pendingNightAction = null;
  room.nightStepIndex++;
}

// ============================================================
// STORYTELLER DECISION (LLM)
// ============================================================

interface SimInfoRoleResult {
  type: string;
  players: [number, number];
  characterId: string;
  noOutsider?: boolean;
}

async function simStorytellerDecision(room: Room, stepId: string): Promise<SimInfoRoleResult | null> {
  const alive = room.players.filter(p => p.isAlive).map(p => p.seatIndex);
  if (alive.length < 2 || !room.script.characters.find(c => c.id === stepId)) return null;
  try {
    const cd = room.script.characters.find(c => c.id === stepId)!;
    const { systemPrompt, userPrompt } = buildStorytellerPrompts(room as any, stepId, cd);
    const r = await callLlm(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: 0.7, jsonMode: true, maxAttempts: 2, timeoutMs: 15000 },
    );
    if (r.json) {
      const j = r.json as any;
      const a = Number(j.players?.[0] ?? -1), b = Number(j.players?.[1] ?? -1);
      if (alive.includes(a) && alive.includes(b) && a !== b && j.characterId) {
        const cid = String(j.characterId);
        if (stepId === 'washerwoman' && room.script.characters.some(c => c.type === 'townsfolk' && c.id === cid))
          return { type: 'washerwoman_result', players: [a, b], characterId: cid };
        if (stepId === 'librarian') {
          if (j.noOutsider === true) return { type: 'librarian_result', players: [a, b], characterId: 'no_outsider', noOutsider: true };
          if (room.script.characters.some(c => c.type === 'outsider' && c.id === cid))
            return { type: 'librarian_result', players: [a, b], characterId: cid };
        }
        if (stepId === 'investigator' && room.script.characters.some(c => c.type === 'minion' && c.id === cid))
          return { type: 'investigator_result', players: [a, b], characterId: cid };
      }
    }
  } catch {}
  return null;
}

// ============================================================
// BATCH SIMULATION
// ============================================================

export async function runBatchSimulation(
  count: number, playerCount: number = 5, onProgress?: (done: number, total: number) => void,
): Promise<BatchSimulationStats> {
  const results: SimulationResult[] = [];
  for (let i = 0; i < count; i++) {
    results.push(await runSingleSimulation(playerCount));
    if (onProgress) onProgress(i + 1, count);
  }
  const gw = results.filter(r => r.winner === 'good').length;
  return {
    totalGames: count, goodWins: gw, evilWins: count - gw,
    goodWinRate: count > 0 ? gw / count : 0,
    evilWinRate: count > 0 ? (count - gw) / count : 0,
    avgDays: results.reduce((s, r) => s + r.daysElapsed, 0) / results.length,
    avgDurationMs: results.reduce((s, r) => s + r.durationMs, 0) / results.length,
    results,
  };
}

// ============================================================
// HELPERS
// ============================================================

function joinRoomInternal(room: Room, nickname: string): { room: Room; seatIndex: number } | null {
  if (room.players.length >= room.script.maxPlayers) return null;
  const si = room.players.length;
  room.players.push({
    id: `ai_${room.id}_${si}`,
    seatIndex: si,
    nickname,
    isReady: false,
    isAlive: true,
    hasDeadVote: true,
    usedDayActions: [],
  });
  return { room, seatIndex: si };
}
