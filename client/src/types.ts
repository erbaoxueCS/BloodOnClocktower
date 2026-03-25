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
  lastNightDeaths: number[];
  lastNightRevivals: number[];
  minPlayers: number;
  maxPlayers: number;
}
