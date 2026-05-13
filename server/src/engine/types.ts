/**
 * engine/types.ts - 类型桥接
 * 重新导出 game/types.ts 的全部类型，并补充 index.ts / roomManager.ts 需要的类型
 */

export * from '../game/types.js';

// Re-export Room and Script under aliases that existing code expects
export type { Room as EngineRoom } from '../game/types.js';
export type { Script as EngineScript } from '../game/types.js';

/** ScriptDef: alias for Script (roomManager.ts uses ScriptDef) */
export type ScriptDef = import('../game/types.js').Script;

/** PlayerState: alias for PlayerSeat */
export type PlayerState = import('../game/types.js').PlayerSeat;

/** PublicPlayerView: simplified public player view */
export interface PublicPlayerView {
  id?: string;
  seatIndex: number;
  nickname: string;
  isReady?: boolean;
  isAlive: boolean;
  hasDeadVote?: boolean;
}

/** ChatEntry: re-export */
export type ChatEntry = import('../game/types.js').ChatEntry;

/** AiBehaviorStyle: AI 玩家行为风格（9 维概率模型） */
export interface AiBehaviorStyle {
  initiative: number;
  leadership: number;
  privacy: number;
  logicWeight: number;
  detailRetention: number;
  conspiracyWeight: number;
  aggressiveness: number;
  defaultTrust: number;
  hesitation: number;
}

/** GameState: re-export from game/types.js */
export type { GameState } from '../game/types.js';

/** RoomView alias */
export type { RoomView } from '../game/types.js';

/** WorldView: 玩家视角下的游戏状态 */
export interface WorldView {
  seatIndex: number;
  phase: string;
  dayNumber: number;
  daySubPhase: string | null;
  aliveSeatNumbers: number[];
  deadSeatNumbers: number[];
  players: PublicPlayerView[];
  yourRole?: {
    id: string;
    name: string;
    nameZh: string;
    ability: string;
    abilityZh: string;
  };
  publicLog?: Array<{ seq: number; at: number; line: string }>;
  chatLog?: Array<{ id: string; at: number; scope: string; phase: string; dayNumber: number; fromSeat: number; toSeat?: number; text: string }>;
  lastNightDeaths?: number[];
  currentNomination?: { nominator: number; nominated: number } | null;
  nominationsToday?: Array<{ nominator: number; nominated: number }>;
  pendingExecution?: number | null;
}

/** PendingNightAction */
export type PendingNightAction = {
  characterId: string;
  actorSeat: number;
  pickCount: number;
  pickDescription: string;
};

/** InfoRoleResult */
export interface InfoRoleResult {
  type: string;
  players: [number, number];
  characterId: string;
  noOutsider?: boolean;
}

/** AiDecisionEntry: AI 决策日志（index.ts 写入格式） */
export interface AiDecisionEntry {
  type: string;
  at: number;
  dayNumber: number;
  phase: string;
  seatIndex: number;
  decisionType?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  reasoning?: string;
  timestamp?: number;
}

/** YourRoleInfo: 玩家自己的角色信息 */
export interface YourRoleInfo {
  id?: string;
  name?: string;
  nameZh?: string;
  ability?: string;
  abilityZh?: string;
  characterId?: string;
  characterName?: string;
  alignment?: string;
  type?: string;
  infoSource?: string;
}

/** Nomination */
export type Nomination = { nominatorSeat: number; nomineeSeat: number };
