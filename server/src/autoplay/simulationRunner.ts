// ============================================================
// 自动模拟运行器：全 AI 对局的批量化执行引擎
// ============================================================

import { configureLlm } from '../llm/llmClient.js';
import { createRoom, setReady } from '../game/roomManager.js';
import { troubleBrewing } from '../scripts/troubleBrewing.js';
import {
  initGame, getEffectiveCharacterId, getShownCharacterId,
  computeChefPairs, computeEmpathCount, checkFortuneTellerTargets,
  resolveDemonKill, isPoisonedOrDrunk, findDemon, findAliveMinions,
  getCurrentNightStep, nominate, skipNomination, vote, tallyVotes, tryEndDay,
  checkWin, checkScarletWoman,
  buildWorldView, gotoDay, gotoNight,
} from '../engine/gameEngine.js';
import type {
  GameState, Room, PlayerState, Alignment, YourRoleInfo, WorldView, InfoRoleResult,
} from '../engine/types.js';
import { buildGameRecord, writeGameRecord } from '../engine/gameRecord.js';
import { getOrCreatePlayerAgent, clearPlayerAgent } from '../agents/player/playerAgent.js';
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

export async function runSingleSimulation(playerCount: number = 5, gameId?: string): Promise<SimulationResult> {
  const startTime = Date.now();
  const gid = gameId ?? nextGameId();
  let aiCallCount = 0;
  const narrative: string[] = [];

  // Configure LLM if running standalone
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

  initGame(room.game);
  (room as any).status = 'playing';

  const r = room.game.players.map(p => {
    const d = p.characterId ? room.game.script.characters.find(c => c.id === p.characterId) : undefined;
    return `#${p.seatIndex + 1}=${d?.nameZh ?? '?'}(${d?.alignment === 'evil' ? '恶' : '善'})`;
  });
  narrative.push(`[${gid}] ${r.join(' ')}`);

  try {
    for (let iter = 0; iter < 100; iter++) {
      if ((room as any).status !== 'playing') break;

      const phase = (room.game as any).phase as string;
      if (phase === 'first_night' || phase === 'night') {
        await runNightLoopSim(room, gid, narrative, () => aiCallCount++);
        if ((room as any).status === 'ended') break;

        if (room.game.awaitingNightConfirm) {
          for (const p of room.game.players) room.game.nightConfirmations.add(p.seatIndex);
          const deaths = room.game.lastNightDeaths.length > 0
            ? room.game.lastNightDeaths.map(s => `#${s + 1}`).join(',') : '无';
          narrative.push(`[${gid}] 天亮 死:${deaths}`);
          gotoDay(room.game);
          narrative.push(`[${gid}] D${room.game.dayNumber}`);
          const w = checkWin(room.game);
          if (w) { narrative.push(`[${gid}] ${w === 'good' ? '善' : '恶'}胜`); (room as any).status = 'ended'; break; }
        }
      }

      if ((room.game as any).phase === 'day') {
        const dr = await runDayLoopSim(room, gid, narrative, () => aiCallCount++);
        if (dr === 'ended') break;
        if (dr === 'error') { narrative.push(`[${gid}] 白天异常`); break; }
      }

      if ((room as any).status === 'ended') break;
      const w = checkWin(room.game);
      if (w) { narrative.push(`[${gid}] ${w === 'good' ? '善' : '恶'}中胜`); (room as any).status = 'ended'; break; }
    }
    if ((room as any).status === 'playing') narrative.push(`[${gid}] 超时`);
  } catch (e) {
    narrative.push(`[${gid}] 异常:${(e as Error).message?.slice(0, 100)}`);
  }

  const fw = checkWin(room.game);
  const winner: 'good' | 'evil' = fw === 'good' ? 'good' : 'evil';
  narrative.push(`[${gid}] ${winner === 'good' ? '善' : '恶'}胜`);

  try { const rec = buildGameRecord(room, winner); writeGameRecord(rec); } catch {}
  for (const p of room.game.players) clearPlayerAgent(`${room.id}_${p.seatIndex}`);

  return {
    gameId: gid, playerCount: room.game.players.length, winner,
    daysElapsed: room.game.dayNumber,
    totalNightActions: 0, totalDayActions: 0,
    aiCallCount, durationMs: Date.now() - startTime,
    roles: room.game.players.map(p => {
      const d = p.characterId ? room.game.script.characters.find(c => c.id === p.characterId) : undefined;
      return { seatIndex: p.seatIndex, nickname: p.nickname, characterId: p.characterId ?? '?', characterNameZh: d?.nameZh ?? '?', alignment: d?.alignment ?? 'good', survived: p.isAlive };
    }),
    narrative,
  };
}

// ===== NIGHT =====

async function runNightLoopSim(room: Room, gid: string, narrative: string[], countCall: () => void): Promise<void> {
  const game = room.game;
  for (let s = 0; s < 50; s++) {
    if (game.phase !== 'first_night' && game.phase !== 'night') break;
    const stepId = getCurrentNightStep(game);
    if (!stepId) { game.awaitingNightConfirm = true; break; }
    const cd = game.script.characters.find(c => c.id === stepId);
    if (!cd) { game.nightStepIndex++; continue; }
    const actor = game.players.find(p => p.isAlive && getEffectiveCharacterId(p) === stepId);
    if (cd.infoSource === 'rule') { game.nightStepIndex++; continue; }
    if (stepId === 'demon_info' || stepId === 'minion_info') { game.nightStepIndex++; continue; }
    if (cd.infoSource === 'storyteller' && actor) {
      countCall();
      const dec = await simStorytellerDecision(game, stepId);
      if (dec) game.storytellerDecisions.set(stepId, dec);
      game.nightStepIndex++; continue;
    }
    if (cd.requiresPlayerChoice && actor) {
      if (game.phase === 'first_night') { game.nightStepIndex++; continue; }
      game.pendingNightAction = { stepId, actorSeatIndex: actor.seatIndex, pick: (cd.pickCount ?? 1) as 1 | 2 };
      countCall();
      await handleNightAction(room, actor.seatIndex, narrative);
      continue;
    }
    game.nightStepIndex++;
  }
}

// ===== DAY =====

async function runDayLoopSim(room: Room, gid: string, narrative: string[], countCall: () => void): Promise<'continue' | 'ended' | 'error'> {
  const game = room.game;

  // Discussion
  game.daySubPhase = 'discussion';
  for (const p of game.players) {
    if (!p.isAlive) continue;
    countCall();
    try {
      const wv = buildWorldView(game, p.seatIndex);
      const agent = makeAgent(room, p, game);
      agent.perceive(wv);
      const plan = await agent.decideDayPlan(wv);
      if (plan.publicSpeech?.trim()) narrative.push(`[${gid}] S#${p.seatIndex + 1}:${plan.publicSpeech.slice(0, 60)}`);
    } catch { narrative.push(`[${gid}] S#${p.seatIndex + 1}:err`); }
  }
  if ((room as any).status === 'ended') return 'ended';
  if (checkWin(game)) { (room as any).status = 'ended'; return 'ended'; }

  // Nomination
  game.daySubPhase = 'nomination';
  for (const p of shuffle([...game.players]).filter(x => x.isAlive)) {
    if (game.nominationsToday.has(p.seatIndex) || game.skippedNominationsToday.has(p.seatIndex)) continue;
    countCall();
    try {
      const wv = buildWorldView(game, p.seatIndex);
      const agent = makeAgent(room, p, game);
      agent.perceive(wv);
      const nd = await agent.decideNomination(wv);
      if (!nd.shouldSkip && nd.nominatedSeat != null && nominate(game, p.seatIndex, nd.nominatedSeat)) {
        narrative.push(`[${gid}] N#${p.seatIndex + 1}→#${nd.nominatedSeat + 1}`);
        await doVoting(room, gid, narrative, countCall);
      } else { skipNomination(game, p.seatIndex); }
    } catch { skipNomination(game, p.seatIndex); }
  }

  const dr = tryEndDay(game);
  if (dr === 'ended') { narrative.push(`[${gid}] 圣徒毙`); (room as any).status = 'ended'; return 'ended'; }
  if (dr === 'goto_night') {
    narrative.push(`[${gid}] ${game.lastExecutedSeatIndex != null ? `处决#${game.lastExecutedSeatIndex + 1}` : '无人处决'}`);
    checkScarletWoman(game);
    gotoNight(game);
    if (checkWin(game)) { (room as any).status = 'ended'; return 'ended'; }
    return 'continue';
  }
  return 'continue';
}

// ===== VOTING =====

async function doVoting(room: Room, gid: string, narrative: string[], countCall: () => void): Promise<void> {
  const game = room.game;
  if (!game.currentNomination) return;
  for (const p of shuffle([...game.players].filter(x => x.isAlive || x.hasGhostVote))) {
    countCall();
    try {
      const wv = buildWorldView(game, p.seatIndex);
      const agent = makeAgent(room, p, game);
      agent.perceive(wv);
      const v = await agent.decideVote(wv, game.currentNomination);
      vote(game, p.seatIndex, v.inFavor);
    } catch {
      vote(game, p.seatIndex, (game.script.characters.find(c => c.id === p.characterId)?.alignment === 'evil') ? false : true);
    }
  }
  const { passed, votesFor } = tallyVotes(game);
  narrative.push(`[${gid}] V${passed ? '通过' : '未过'}(${votesFor})`);
}

// ===== NIGHT ACTION =====

async function handleNightAction(room: Room, seatIdx: number, narrative: string[]): Promise<void> {
  const game = room.game;
  const pending = game.pendingNightAction;
  if (!pending || pending.actorSeatIndex !== seatIdx) return;
  const others = game.players.filter(p => p.isAlive && p.seatIndex !== seatIdx).map(p => p.seatIndex);

  try {
    const wv = buildWorldView(game, seatIdx);
    const agent = makeAgent(room, game.players[seatIdx], game);
    agent.perceive(wv);
    const r = await agent.decideNightTargets(pending.stepId, pending.pick, others, wv);
    const valid = r.targets.filter((t: number) => others.includes(t));
    if (valid.length === pending.pick) { await settleNightAction(room, seatIdx, valid, narrative); return; }
  } catch {}

  await settleNightAction(room, seatIdx, shuffle(others).slice(0, pending.pick), narrative);
}

async function settleNightAction(room: Room, seatIdx: number, targets: number[], narrative: string[]): Promise<void> {
  const game = room.game;
  const pending = game.pendingNightAction;
  if (!pending) return;
  if (pending.stepId === 'imp' && targets[0] != null) {
    resolveDemonKill(game, targets[0], seatIdx);
    narrative.push(`[夜] 魔#${seatIdx + 1}→#${targets[0] + 1}`);
    checkScarletWoman(game);
  } else if (pending.stepId === 'poisoner' && targets[0] != null) {
    game.poisonedSeatIndex = targets[0];
  } else if (pending.stepId === 'monk' && targets[0] != null) {
    game.protectedSeatIndex = targets[0];
  } else if (pending.stepId === 'fortune_teller' && targets.length === 2) {
    checkFortuneTellerTargets(game, targets, seatIdx);
  }
  game.pendingNightAction = null;
  game.nightStepIndex++;
}

// ===== STORYTELLER =====

async function simStorytellerDecision(game: GameState, stepId: string): Promise<InfoRoleResult | null> {
  const alive = game.players.filter(p => p.isAlive).map(p => p.seatIndex);
  if (alive.length < 2 || !game.script.characters.find(c => c.id === stepId)) return null;
  try {
    const cd = game.script.characters.find(c => c.id === stepId)!;
    const { systemPrompt, userPrompt } = buildStorytellerPrompts(game, stepId, cd);
    const r = await callLlm(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: 0.7, jsonMode: true, maxAttempts: 2, timeoutMs: 15000 },
    );
    if (r.json) {
      const j = r.json as any;
      const a = Number(j.players?.[0] ?? -1), b = Number(j.players?.[1] ?? -1);
      if (alive.includes(a) && alive.includes(b) && a !== b && j.characterId) {
        const cid = String(j.characterId);
        if (stepId === 'washerwoman' && game.script.characters.some(c => c.type === 'townsfolk' && c.id === cid))
          return { type: 'washerwoman_result', players: [a, b], characterId: cid } as any;
        if (stepId === 'librarian') {
          if (j.noOutsider === true) return { type: 'librarian_result', players: [a, b], characterId: 'no_outsider', noOutsider: true } as any;
          if (game.script.characters.some(c => c.type === 'outsider' && c.id === cid))
            return { type: 'librarian_result', players: [a, b], characterId: cid } as any;
        }
        if (stepId === 'investigator' && game.script.characters.some(c => c.type === 'minion' && c.id === cid))
          return { type: 'investigator_result', players: [a, b], characterId: cid } as any;
      }
    }
  } catch {}
  return null;
}

// ===== BATCH =====

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

// ===== HELPERS =====

function makeAgent(room: Room, p: PlayerState, game: GameState) {
  const sid = getShownCharacterId(p);
  const c = sid ? game.script.characters.find(x => x.id === sid) : undefined;
  return getOrCreatePlayerAgent(
    `${room.id}_${p.seatIndex}`, p.seatIndex,
    { characterId: sid ?? '?', characterName: c?.name ?? '?', characterNameZh: c?.nameZh ?? '?', ability: c?.ability ?? '', abilityZh: c?.abilityZh ?? '', alignment: (game.script.characters.find(x => x.id === p.characterId)?.alignment as Alignment) ?? 'good', type: c?.type ?? 'townsfolk', infoSource: c?.infoSource ?? 'none' },
    (game.script.characters.find(x => x.id === p.characterId)?.alignment as Alignment) ?? 'good',
  );
}

function joinRoomInternal(room: Room, nickname: string): { room: Room; seatIndex: number } | null {
  if (room.game.players.length >= room.game.script.maxPlayers) return null;
  const si = room.game.players.length;
  room.game.players.push({ id: `ai_${room.id}_${si}`, seatIndex: si, nickname, isReady: false, isAlive: true, hasGhostVote: true, usedDayActions: [] });
  return { room, seatIndex: si };
}
