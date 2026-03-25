/** 阵营 */
export type Alignment = 'good' | 'evil';

/** 角色类型：镇民/外来者/爪牙/恶魔 */
export type CharacterType = 'townsfolk' | 'outsider' | 'minion' | 'demon';

/** 角色：id、名称、阵营、类型、技能描述、是否仅首夜、是否需要说书人选择 */
export interface Character {
  id: string;
  name: string;
  nameZh: string;
  alignment: Alignment;
  type: CharacterType;
  ability: string;
  firstNightOnly?: boolean;
  requiresStorytellerChoice?: boolean;
}

/** 剧本：id、名称、角色列表、夜晚顺序(首夜/普通夜)、人数区间 */
export interface Script {
  id: string;
  name: string;
  nameZh: string;
  characters: Character[];
  firstNightOrder: string[];
  otherNightOrder: string[];
  minPlayers: number;
  maxPlayers: number;
}

/** 游戏阶段 */
export type GamePhase =
  | 'waiting'       // 等待开始
  | 'first_night'   // 首夜
  | 'day'           // 白天（含公聊、提名、投票、处决子阶段）
  | 'night';        // 后续夜晚

/** 白天子阶段 */
export type DaySubPhase = 'discussion' | 'nomination' | 'voting' | 'execution';

/** 玩家座位信息（公开） */
export interface PlayerSeat {
  id: string;
  seatIndex: number;
  nickname: string;
  isReady: boolean;
  isAlive: boolean;
  hasDeadVote: boolean;  // 死亡玩家是否还有一票
  /** 仅服务端与 AI 知；发给客户端时脱敏 */
  characterId?: string;
}

/** 房间状态 */
export type RoomStatus = 'lobby' | 'playing' | 'ended';

/** 房间（含对局状态） */
export interface Room {
  id: string;
  scriptId: string;
  script: Script;
  players: PlayerSeat[];
  status: RoomStatus;
  phase: GamePhase;
  dayNumber: number;
  daySubPhase: DaySubPhase | null;
  /** 当前提名：提名者 seatIndex，被提名者 seatIndex */
  currentNomination: { nominator: number; nominated: number } | null;
  /** 今日已提名记录：nominator -> nominated */
  nominationsToday: Map<number, number>;
  /** 今日被提名记录 */
  nominatedToday: Set<number>;
  /** 当前投票：seatIndex -> 是否投赞成 */
  votes: Map<number, boolean>;
  /** 待处决的玩家 seatIndex（投票通过后） */
  pendingExecution: number | null;
  /** 夜晚顺序当前步（首夜/普通夜步骤索引） */
  nightStepIndex: number;
  /** 夜晚等待玩家输入的行动（若不为 null，则夜晚流程暂停） */
  pendingNightAction: null | {
    stepId: string;
    actorSeatIndex: number;
    /** 选择目标数量：1 或 2 */
    pick: 1 | 2;
  };
  /** 夜晚保护（如僧侣） */
  protectedSeatIndex: number | null;
  /** 当天处决记录（供掘墓人等使用） */
  lastExecutedSeatIndex: number | null;
  lastExecutedCharacterId: string | null;
  /** 昨夜死亡/复活（天亮时公布） */
  lastNightDeaths: number[];
  lastNightRevivals: number[];
  /** 恶魔已知的「不在场三身份」（7+ 人局） */
  demonBluffs: string[] | null;
  /** 说书人决策缓存：步骤 id -> 决策结果（如洗衣妇验谁） */
  storytellerDecisions: Map<string, unknown>;
  /** 连接 id -> seatIndex */
  connections: Map<string, number>;
  createdAt: number;
}

/** 发给客户端的房间摘要（不含身份） */
export interface RoomView {
  id: string;
  scriptId: string;
  scriptName: string;
  scriptNameZh: string;
  players: Omit<PlayerSeat, 'characterId'>[];
  status: RoomStatus;
  phase: GamePhase;
  dayNumber: number;
  daySubPhase: DaySubPhase | null;
  currentNomination: Room['currentNomination'];
  pendingExecution: number | null;
  lastNightDeaths: number[];
  lastNightRevivals: number[];
  minPlayers: number;
  maxPlayers: number;
}
