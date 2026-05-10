import { v4 as uuidv4 } from 'uuid';
import type { Room, GameState, PlayerState, RoomView, PublicPlayerView, ChatEntry, AiBehaviorStyle } from '../engine/types.js';
import { troubleBrewing } from '../scripts/troubleBrewing.js';
import type { ScriptDef } from '../engine/types.js';

export const rooms = new Map<string, Room>();

function getScript(scriptId: string): ScriptDef {
  return troubleBrewing;
}

function makeEmptyGame(script: ScriptDef, players: PlayerState[]): GameState {
  return {
    scriptId: script.id, script, players,
    phase: 'waiting', dayNumber: 0, daySubPhase: null,
    dayFlowStage: null, dayFlowStartSeat: null,
    nightStepIndex: 0, pendingNightAction: null,
    protectedSeatIndex: null, poisonedSeatIndex: null,
    lastNightDeaths: [], lastNightRevivals: [],
    nightKillAttackerByVictim: new Map(),
    currentNomination: null,
    nominationsToday: new Map(), skippedNominationsToday: new Set(), nominatedToday: new Set(),
    votes: new Map(), pendingExecution: null, pendingExecutionVotesFor: 0, pendingExecutionTied: false,
    lastExecutedSeatIndex: null, lastExecutedCharacterId: null,
    awaitingNightConfirm: false, nightConfirmations: new Set(),
    awaitingNightInfoConfirm: false, pendingNightInfoConfirmSeats: new Set(), nightInfoConfirmations: new Set(),
    usedDayActionsBySeat: new Map(), demonBluffs: [],
    storytellerDecisions: new Map(),
    chatLog: [], publicLog: [], replayLog: [],
  };
}

export function createRoom(scriptId: string): Room {
  const script = getScript(scriptId);
  const game = makeEmptyGame(script, []);
  const room: Room = {
    id: uuidv4().slice(0, 6).toUpperCase(),
    hostSecret: uuidv4().slice(0, 8),
    connections: new Map(),
    game,
    status: 'lobby',
    aiStorytellerEnabled: false,
    aiPlayerEnabledBySeat: new Map(),
    aiPlayerBehaviorStyleBySeat: new Map(),
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

export function joinRoom(roomId: string, nickname: string): { room: Room; seatIndex: number } | null {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') return null;
  if (room.game.players.length >= room.game.script.maxPlayers) return null;
  const seatIndex = room.game.players.length;
  const player: PlayerState = {
    id: uuidv4(), seatIndex, nickname,
    isReady: false, isAlive: true, hasGhostVote: true, usedDayActions: [],
  };
  room.game.players.push(player);
  return { room, seatIndex };
}

export function getRoom(roomId: string): Room | null {
  return rooms.get(roomId) ?? null;
}

export function setReady(room: Room, seatIndex: number, ready: boolean): boolean {
  const p = room.game.players[seatIndex];
  if (!p) return false;
  if (room.status === 'ended') resetRoom(room);
  p.isReady = ready;
  return true;
}

function resetRoom(room: Room): void {
  const script = room.game.script;
  const players = room.game.players.map(p => ({
    id: p.id, seatIndex: p.seatIndex, nickname: p.nickname,
    isReady: false, isAlive: true, hasGhostVote: true, usedDayActions: [],
  }));
  room.game = makeEmptyGame(script, players);
  room.status = 'lobby';
  room.aiStorytellerEnabled = false;
  room.aiPlayerEnabledBySeat = new Map();
  room.aiPlayerBehaviorStyleBySeat = new Map();
}

export function bindConnection(room: Room, connectionId: string, seatIndex: number): void {
  room.connections.set(connectionId, seatIndex);
}

export function unbindConnection(room: Room, connectionId: string): void {
  room.connections.delete(connectionId);
}

export function getRoomView(room: Room, forSeatIndex?: number, includeGlobalLog?: boolean): RoomView {
  const game = room.game;
  const players: PublicPlayerView[] = game.players.map(p => ({
    id: p.id, seatIndex: p.seatIndex, nickname: p.nickname,
    isReady: p.isReady, isAlive: p.isAlive, hasGhostVote: p.hasGhostVote,
  }));

  const chatLog: ChatEntry[] | undefined = (() => {
    if (includeGlobalLog) return game.chatLog;
    if (forSeatIndex === undefined) return undefined;
    return game.chatLog.filter(e => {
      if (e.scope === 'public') return true;
      if (e.scope === 'god') return e.fromSeat === forSeatIndex;
      if (e.scope === 'dm') return e.fromSeat === forSeatIndex || e.toSeat === forSeatIndex;
      return false;
    });
  })();

  return {
    id: room.id, scriptId: game.scriptId,
    scriptName: game.script.name, scriptNameZh: game.script.nameZh,
    players, status: room.status, phase: game.phase,
    dayNumber: game.dayNumber, daySubPhase: game.daySubPhase,
    dayFlowStage: game.dayFlowStage, dayFlowStartSeat: game.dayFlowStartSeat,
    currentNomination: game.currentNomination,
    pendingExecution: game.pendingExecution,
    pendingExecutionVotesFor: game.pendingExecutionVotesFor,
    pendingExecutionTied: game.pendingExecutionTied,
    nominationsToday: Array.from(game.nominationsToday.entries()).map(([n, d]) => ({ nominator: n, nominated: d })),
    skippedNominationsToday: Array.from(game.skippedNominationsToday),
    lastNightDeaths: game.lastNightDeaths, lastNightRevivals: game.lastNightRevivals,
    publicLog: game.publicLog,
    awaitingNightConfirm: game.awaitingNightConfirm,
    nightConfirmedSeats: Array.from(game.nightConfirmations),
    awaitingNightInfoConfirm: game.awaitingNightInfoConfirm,
    pendingNightInfoConfirmSeats: Array.from(game.pendingNightInfoConfirmSeats),
    nightInfoConfirmedSeats: Array.from(game.nightInfoConfirmations),
    chatLog,
    aiPlayerEnabled: forSeatIndex !== undefined ? (room.aiPlayerEnabledBySeat.get(forSeatIndex) ?? false) : undefined,
    aiPlayerBehaviorStyle: forSeatIndex !== undefined ? (room.aiPlayerBehaviorStyleBySeat.get(forSeatIndex) ?? undefined) : undefined,
    aiStorytellerEnabled: room.aiStorytellerEnabled,
    globalLog: includeGlobalLog ? game.replayLog : undefined,
    minPlayers: game.script.minPlayers, maxPlayers: game.script.maxPlayers,
  };
}
