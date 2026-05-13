/**
 * engine/gameEngine.ts - 规则引擎桥接
 * 重新导出 game/gameEngine.ts 的函数，包装为接受 GameState 参数
 */

import * as GE from '../game/gameEngine.js';
import type { GameState, Room, PlayerSeat, InfoRoleResult } from '../game/types.js';

// GameState 与 Room 共享相同的属性名（players, script, poisonedSeatIndex 等），
// 所以可以直接将 GameState 当作 Room 传给 gameEngine 函数。
// 这里提供类型别名让 TypeScript 接受。

function asRoom(game: GameState): Room {
  // 构造一个最小 Room 对象，让 gameEngine 函数能正常访问所需属性
  return {
    id: '', scriptId: game.scriptId, script: game.script, players: game.players,
    status: 'playing', phase: game.phase, dayNumber: game.dayNumber,
    daySubPhase: game.daySubPhase, dayFlowStage: game.dayFlowStage,
    dayFlowStartSeat: game.dayFlowStartSeat, currentNomination: game.currentNomination,
    nominationsToday: game.nominationsToday, skippedNominationsToday: game.skippedNominationsToday,
    nominatedToday: game.nominatedToday, votes: game.votes,
    pendingExecution: game.pendingExecution, pendingExecutionVotesFor: game.pendingExecutionVotesFor,
    pendingExecutionTied: game.pendingExecutionTied, nightStepIndex: game.nightStepIndex,
    pendingNightAction: game.pendingNightAction, protectedSeatIndex: game.protectedSeatIndex,
    poisonedSeatIndex: game.poisonedSeatIndex, lastExecutedSeatIndex: game.lastExecutedSeatIndex,
    lastExecutedCharacterId: game.lastExecutedCharacterId,
    lastNightDeaths: game.lastNightDeaths, lastNightRevivals: game.lastNightRevivals,
    demonBluffs: game.demonBluffs, storytellerDecisions: game.storytellerDecisions,
    connections: new Map(), createdAt: 0, game: game as any,
    replayLog: game.replayLog, publicLog: game.publicLog,
    chatLog: game.chatLog, aiStorytellerEnabled: false, aiLastActionAt: 0,
    aiPlayerEnabledBySeat: new Map(), aiPlayerLastActionAtBySeat: new Map(),
    aiPlayerTemperatureBySeat: new Map(), nightConfirmations: game.nightConfirmations,
    awaitingNightConfirm: game.awaitingNightConfirm,
    usedDayActionsBySeat: game.usedDayActionsBySeat,
    nightKillAttackerByVictim: game.nightKillAttackerByVictim,
  } as unknown as Room;
}

// 重新导出 game/gameEngine.ts 的函数（包装为接受 GameState）
export function isPoisonedOrDrunk(game: GameState, seatIndex: number): boolean {
  return GE.isPoisoned(asRoom(game), seatIndex);
}
export function findDemon(game: GameState): number | null {
  return GE.findAliveSeatByCharacter(asRoom(game), 'imp');
}
export function getEffectiveCharacterId(p: PlayerSeat): string | undefined {
  return GE.getEffectiveCharacterId(p);
}
export function getShownCharacterId(p: PlayerSeat): string | undefined {
  return GE.getShownCharacterId(p);
}
export function computeChefPairs(game: GameState): number {
  return GE.computeChefPairs(asRoom(game));
}
export function computeEmpathCount(game: GameState, empathSeatIndex: number): number {
  return GE.computeEmpathCount(asRoom(game), empathSeatIndex);
}
export function checkFortuneTellerTargets(game: GameState, targets: number[], _seatIndex?: number): boolean {
  const room = asRoom(game);
  return GE.formatFortuneTellerResultForSeat(room, _seatIndex ?? 0, targets).includes('是');
}
export function resolveUndertakerInfo(game: GameState): InfoRoleResult {
  // 简化：从游戏状态中提取被处决者信息
  if (!game.lastExecutedSeatIndex && game.lastExecutedSeatIndex !== 0) {
    return { type: 'undertaker', players: [0, 0], characterId: '', noOutsider: false };
  }
  return { type: 'undertaker', players: [game.lastExecutedSeatIndex, game.lastExecutedSeatIndex], characterId: game.lastExecutedCharacterId ?? '', noOutsider: false };
}
export function resolveRavenkeeperInfo(game: GameState, victimSeat: number): InfoRoleResult {
  // 简化：返回攻击者信息
  const attackerSeat = game.nightKillAttackerByVictim.get(victimSeat);
  if (attackerSeat === undefined) return { type: 'ravenkeeper', players: [0, 0], characterId: '', noOutsider: false };
  const attacker = game.players[attackerSeat];
  return { type: 'ravenkeeper', players: [attackerSeat, attackerSeat], characterId: attacker?.characterId ?? '', noOutsider: false };
}
export function assignCharacters(game: GameState): void {
  GE.assignRoles(asRoom(game));
}
export function initGame(game: GameState): boolean {
  return GE.startGame(asRoom(game));
}
export function getCurrentNightStep(game: GameState): string | null {
  return GE.getCurrentNightStep(asRoom(game));
}
export function getCurrentNightOrder(game: GameState): string[] {
  return GE.getCurrentNightOrder(asRoom(game));
}
export function skipNomination(game: GameState, seatIndex: number): boolean {
  return GE.skipNomination(asRoom(game), seatIndex);
}
export function nominate(game: GameState, nominatorSeat: number, nominatedSeat: number): boolean {
  return GE.nominate(asRoom(game), nominatorSeat, nominatedSeat);
}
export function vote(game: GameState, seatIndex: number, inFavor: boolean): boolean {
  return GE.vote(asRoom(game), seatIndex, inFavor);
}
export function tallyVotes(game: GameState): { passed: boolean; votesFor: number; votes: Array<{ seatIndex: number; inFavor: boolean }> } {
  const room = asRoom(game);
  const result = GE.maybeFinishDay(room);
  const votes = Array.from(game.votes.entries()).map(([seatIndex, inFavor]) => ({ seatIndex, inFavor }));
  const votesFor = Array.from(game.votes.values()).filter(v => v).length;
  return { passed: result.ended, votesFor, votes };
}
export function execute(game: GameState, seatIndex: number): void {
  const room = asRoom(game);
  GE.maybeFinishDay(room);
}
export function checkWin(game: GameState): 'good' | 'evil' | null {
  const evilCount = game.players.filter(p => p.isAlive && p.characterId && ['imp', 'poisoner', 'spy', 'baron', 'scarlet_woman'].includes(p.characterId)).length;
  const aliveCount = game.players.filter(p => p.isAlive).length;
  const deadCount = game.players.filter(p => !p.isAlive).length;
  if (evilCount === 0) return 'good';
  if (deadCount >= aliveCount) return 'evil';
  return null;
}

// 这些函数直接操作 GameState
export function gotoDay(game: GameState): void {
  game.phase = 'day';
  game.dayNumber++;
  game.daySubPhase = 'discussion';
  game.currentNomination = null;
  game.nominationsToday = new Map();
  game.skippedNominationsToday = new Set();
  game.nominatedToday = new Set();
  game.votes = new Map();
  game.pendingExecution = null;
  game.pendingExecutionVotesFor = 0;
  game.pendingExecutionTied = false;
}
export function gotoNight(game: GameState): void {
  game.phase = 'night';
  game.daySubPhase = null;
  game.nightStepIndex = 0;
  game.lastNightDeaths = [];
  game.lastNightRevivals = [];
  game.protectedSeatIndex = null;
}

export function findAliveMinions(game: GameState): PlayerSeat[] {
  const MINION_IDS = new Set(['poisoner', 'spy', 'baron', 'scarlet_woman']);
  return game.players.filter(p => p.isAlive && p.characterId && MINION_IDS.has(p.characterId));
}

export function checkScarletWoman(game: GameState): boolean {
  return false;
}
export function checkSaintExecutionLoss(game: GameState): boolean {
  return false;
}
export function shouldMayorBounce(game: GameState): number | null {
  return null;
}
export function tryEndDay(game: GameState): string {
  return 'goto_night';
}

export function resolveDemonKill(
  game: GameState,
  targetSeat: number,
  demonSeat: number,
): { killed: boolean; blockedByMonk: boolean; blockedBySoldier: boolean } {
  const demon = game.players[demonSeat];
  if (!demon?.isAlive) return { killed: false, blockedByMonk: false, blockedBySoldier: false };
  if (targetSeat === demonSeat) {
    const target = game.players[targetSeat];
    if (target) {
      target.isAlive = false;
      game.lastNightDeaths.push(targetSeat);
    }
    return { killed: true, blockedByMonk: false, blockedBySoldier: false };
  }
  if (game.protectedSeatIndex === targetSeat) {
    return { killed: false, blockedByMonk: true, blockedBySoldier: false };
  }
  const target = game.players[targetSeat];
  if (!target) return { killed: false, blockedByMonk: false, blockedBySoldier: false };
  if (target.characterId === 'soldier') {
    return { killed: false, blockedByMonk: false, blockedBySoldier: true };
  }
  target.isAlive = false;
  game.lastNightDeaths.push(targetSeat);
  return { killed: true, blockedByMonk: false, blockedBySoldier: false };
}

export function pushPublicLog(game: GameState, content: string, _meta?: Record<string, unknown>): void {
  const entry = { seq: game.publicLog.length + 1, at: Date.now(), line: content };
  game.publicLog.push(entry);
}

export function pushReplayLog(game: GameState, groupKey: string, _type: string, data: string | Record<string, unknown>): void {
  const line = typeof data === 'string' ? data : JSON.stringify(data);
  const entry = { seq: game.replayLog.length + 1, at: Date.now(), groupKey, groupTitle: groupKey, line };
  game.replayLog.push(entry);
}

export function buildWorldView(game: GameState, seatIndex: number): import('../engine/types.js').WorldView {
  const alive = game.players.filter(p => p.isAlive).map(p => p.seatIndex);
  const dead = game.players.filter(p => !p.isAlive).map(p => p.seatIndex);
  return {
    seatIndex,
    phase: game.phase,
    dayNumber: game.dayNumber,
    daySubPhase: game.daySubPhase,
    aliveSeatNumbers: alive,
    deadSeatNumbers: dead,
    players: game.players.map(p => ({ seatIndex: p.seatIndex, nickname: p.nickname, isAlive: p.isAlive, isReady: p.isReady, id: p.id })),
    publicLog: game.publicLog,
    chatLog: game.chatLog,
    lastNightDeaths: game.lastNightDeaths,
    currentNomination: game.currentNomination,
    nominationsToday: Array.from(game.nominationsToday.entries()).map(([n, d]) => ({ nominator: n, nominated: d })),
    pendingExecution: game.pendingExecution,
  };
}

export function buildReplayIdentities(game: GameState): any[] {
  return game.players.map(p => ({
    seatIndex: p.seatIndex,
    nickname: p.nickname,
    characterId: p.characterId ?? '?',
    characterName: p.characterId ?? '?',
    characterZh: p.characterId ?? '?',
    ability: '',
    alignment: ['imp', 'poisoner', 'spy', 'baron', 'scarlet_woman'].includes(p.characterId ?? '') ? 'evil' : 'good',
    survived: p.isAlive,
  }));
}

export function checkVirginTrigger(game: GameState, nominatorSeat: number): { triggered: boolean; nominatorExecuted: boolean } {
  return { triggered: false, nominatorExecuted: false };
}

export function executeSlayerShot(game: GameState, actorSeat: number, targetSeat: number): { success: boolean; killedDemon: boolean } {
  const actor = game.players[actorSeat];
  if (!actor?.isAlive) return { success: false, killedDemon: false };
  const target = game.players[targetSeat];
  if (!target?.isAlive) return { success: false, killedDemon: false };
  if (target.characterId === 'imp') {
    target.isAlive = false;
    return { success: true, killedDemon: true };
  }
  return { success: true, killedDemon: false };
}
