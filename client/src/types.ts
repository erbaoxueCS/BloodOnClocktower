export type GamePhase = 'waiting' | 'first_night' | 'day' | 'night';
export type DaySubPhase = 'discussion' | 'nomination' | 'voting' | 'execution';
export type RoomStatus = 'lobby' | 'playing' | 'ended';

export interface PlayerSeat {
  id: string;
  seatIndex: number;
  nickname: string;
  isReady: boolean;
  isAlive: boolean;
  hasDeadVote: boolean;
}

export interface ReplayLogEntry {
  seq: number;
  at: number;
  groupKey: string;
  groupTitle: string;
  line: string;
}

export interface YourRolePayload {
  characterId: string;
  characterName: string;
  characterNameZh: string;
  ability: string;
}

export interface ReplayIdentity {
  seatIndex: number;
  nickname: string;
  characterId: string;
  characterName: string;
  characterZh: string;
  ability: string;
  alignment: string;
  survived: boolean;
}

export interface ReplayBundle {
  version: string;
  winner: 'good' | 'evil';
  winnerZh: string;
  identities: ReplayIdentity[];
  entries: ReplayLogEntry[];
}

export interface RoomView {
  id: string;
  scriptId: string;
  scriptName: string;
  scriptNameZh: string;
  players: PlayerSeat[];
  status: RoomStatus;
  phase: GamePhase;
  dayNumber: number;
  daySubPhase: DaySubPhase | null;
  currentNomination: { nominator: number; nominated: number } | null;
  pendingExecution: number | null;
  nominationsToday: Array<{ nominator: number; nominated: number }>;
  skippedNominationsToday: number[];
  pendingExecutionVotesFor: number;
  pendingExecutionTied: boolean;
  lastNightDeaths: number[];
  lastNightRevivals: number[];
  publicLog?: Array<{ seq: number; at: number; line: string }>;
  awaitingNightConfirm?: boolean;
  nightConfirmedSeats?: number[];
  chatLog?: Array<{
    id: string;
    at: number;
    scope: 'god' | 'dm' | 'public';
    phase: GamePhase;
    dayNumber: number;
    fromSeat: number;
    toSeat?: number;
    text: string;
  }>;
  aiPlayerEnabled?: boolean;
  aiPlayerTemperature?: number;
  globalLog?: ReplayLogEntry[];
  aiStorytellerEnabled?: boolean;
  minPlayers: number;
  maxPlayers: number;
}
