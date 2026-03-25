import { v4 as uuidv4 } from 'uuid';
import type { Room, PlayerSeat, RoomView } from './types.js';
import { troubleBrewing } from '../script/troubleBrewing.js';

const rooms = new Map<string, Room>();

function getScript(scriptId: string) {
  if (scriptId === troubleBrewing.id) return troubleBrewing;
  return troubleBrewing;
}

/** 创建房间 */
export function createRoom(scriptId: string): Room {
  const script = getScript(scriptId);
  const room: Room = {
    id: uuidv4(),
    scriptId,
    script,
    players: [],
    status: 'lobby',
    phase: 'waiting',
    dayNumber: 0,
    daySubPhase: null,
    currentNomination: null,
    nominationsToday: new Map(),
    nominatedToday: new Set(),
    votes: new Map(),
    pendingExecution: null,
    nightStepIndex: 0,
    pendingNightAction: null,
    protectedSeatIndex: null,
    lastExecutedSeatIndex: null,
    lastExecutedCharacterId: null,
    lastNightDeaths: [],
    lastNightRevivals: [],
    demonBluffs: null,
    storytellerDecisions: new Map(),
    connections: new Map(),
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

/** 加入房间 */
export function joinRoom(roomId: string, nickname: string): { room: Room; seatIndex: number } | null {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') return null;
  if (room.players.length >= room.script.maxPlayers) return null;
  const seatIndex = room.players.length;
  const player: PlayerSeat = {
    id: uuidv4(),
    seatIndex,
    nickname,
    isReady: false,
    isAlive: true,
    hasDeadVote: true,
  };
  room.players.push(player);
  return { room, seatIndex };
}

/** 获取房间 */
export function getRoom(roomId: string): Room | null {
  return rooms.get(roomId) ?? null;
}

/** 获取房间视图（脱敏，供前端） */
export function getRoomView(room: Room, forSeatIndex?: number): RoomView {
  const players = room.players.map((p) => {
    const { characterId, ...rest } = p;
    return rest;
  });
  return {
    id: room.id,
    scriptId: room.scriptId,
    scriptName: room.script.name,
    scriptNameZh: room.script.nameZh,
    players,
    status: room.status,
    phase: room.phase,
    dayNumber: room.dayNumber,
    daySubPhase: room.daySubPhase,
    currentNomination: room.currentNomination,
    pendingExecution: room.pendingExecution,
    lastNightDeaths: room.lastNightDeaths,
    lastNightRevivals: room.lastNightRevivals,
    minPlayers: room.script.minPlayers,
    maxPlayers: room.script.maxPlayers,
  };
}

/** 准备/取消准备 */
export function setReady(room: Room, seatIndex: number, ready: boolean): boolean {
  const p = room.players[seatIndex];
  if (!p) return false;
  p.isReady = ready;
  return true;
}

/** 绑定连接与座位 */
export function bindConnection(room: Room, connectionId: string, seatIndex: number): void {
  room.connections.set(connectionId, seatIndex);
}

/** 解绑连接 */
export function unbindConnection(room: Room, connectionId: string): void {
  room.connections.delete(connectionId);
}

export { rooms };
