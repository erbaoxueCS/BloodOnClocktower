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
export type DayFlowStage = 'god_dialogue' | 'private_dialogue' | 'public_speech' | 'nomination_vote';

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
  /** 若真实角色为 drunk，则该字段为“伪装镇民角色 id”（客户端会看到它，并按它参与夜序与收信息） */
  drunkPretendCharacterId?: string | null;
  /** 白天一次性主动技能使用标记（例如 slayer_shot） */
  usedDayActions?: string[];
}

/** 房间状态 */
export type RoomStatus = 'lobby' | 'playing' | 'ended';

/** 单行复盘记录（按顺序；前端可按 groupKey/groupTitle 分块展示） */
export interface ReplayLogEntry {
  seq: number;
  at: number;
  groupKey: string;
  groupTitle: string;
  line: string;
}

/** 公开事件日志（所有玩家可见，用于“公共大屏”展示） */
export interface PublicLogEntry {
  seq: number;
  at: number;
  line: string;
}

export type ChatScope = 'god' | 'dm' | 'public';

export interface ChatEntry {
  id: string;
  at: number;
  scope: ChatScope;
  phase: GamePhase;
  dayNumber: number;
  fromSeat: number;
  toSeat?: number;
  text: string;
}

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
  /** 白天固定流程阶段（导演编排） */
  dayFlowStage: DayFlowStage | null;
  /** 当前白天阶段的随机起始座位 */
  dayFlowStartSeat: number | null;
  /** 当前提名：提名者 seatIndex，被提名者 seatIndex */
  currentNomination: { nominator: number; nominated: number } | null;
  /** 今日已提名记录：nominator -> nominated */
  nominationsToday: Map<number, number>;
  /** 今日声明“不提名”的存活玩家 seatIndex 集合 */
  skippedNominationsToday: Set<number>;
  /** 今日被提名记录 */
  nominatedToday: Set<number>;
  /** 当前投票：seatIndex -> 是否投赞成 */
  votes: Map<number, boolean>;
  /** 待处决的玩家 seatIndex（投票通过后） */
  pendingExecution: number | null;
  /** 待处决候选的赞成票数（用于比较更高票） */
  pendingExecutionVotesFor: number;
  /** 待处决是否出现最高票平局（平局则当日无人处决） */
  pendingExecutionTied: boolean;
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
  /** 被投毒的玩家（持续到下一次黄昏/进入夜晚前） */
  poisonedSeatIndex: number | null;
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
  /** 全量复盘日志（服务端记录，游戏结束时一次性下发；进行中不对客户端暴露） */
  replayLog: ReplayLogEntry[];
  /** 公开事件日志（进行中对所有人可见） */
  publicLog: PublicLogEntry[];
  /** 房主控制权限密钥（仅持有者可控制进度） */
  hostSecret: string;
  /** 白天主动技能使用情况：seatIndex -> actionIds */
  usedDayActionsBySeat: Map<number, Set<string>>;
  /** 本夜「恶魔刀人」等：受害者 seatIndex -> 行凶者 seatIndex（守鸦人等用） */
  nightKillAttackerByVictim: Map<number, number>;
  /** 是否启用 AI 说书人接管流程 */
  aiStorytellerEnabled: boolean;
  /** AI 说书人最近一次动作时间（节流） */
  aiLastActionAt: number;

  /** 聊天日志（追加式；仅相关方可见） */
  chatLog: ChatEntry[];

  /** 夜晚是否已进入“等待全员确认天亮”状态 */
  awaitingNightConfirm: boolean;
  /** 已确认“夜晚结束”的座位集合 */
  nightConfirmations: Set<number>;

  /** AI 玩家托管开关：seatIndex -> enabled */
  aiPlayerEnabledBySeat: Map<number, boolean>;
  /** AI 玩家最近一次动作时间（节流）：seatIndex -> at(ms) */
  aiPlayerLastActionAtBySeat: Map<number, number>;
  /** AI 玩家积极程度/温度（0~1）：seatIndex -> temperature */
  aiPlayerTemperatureBySeat: Map<number, number>;
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
  dayFlowStage?: DayFlowStage | null;
  dayFlowStartSeat?: number | null;
  currentNomination: Room['currentNomination'];
  pendingExecution: number | null;
  /** 今日提名记录（用于前端展示/判断） */
  nominationsToday: Array<{ nominator: number; nominated: number }>;
  /** 今日声明“不提名”的玩家 seatIndex 列表 */
  skippedNominationsToday: number[];
  /** 当前“最高票待处决”信息（仅用于提示，不代表会立即处决） */
  pendingExecutionVotesFor: number;
  pendingExecutionTied: boolean;
  lastNightDeaths: number[];
  lastNightRevivals: number[];
  publicLog: PublicLogEntry[];
  /** 夜晚是否正在等待全员确认天亮 */
  awaitingNightConfirm?: boolean;
  /** 已确认夜晚结束的座位 */
  nightConfirmedSeats?: number[];
  /** 当前玩家可见的聊天记录（管理员可见全量） */
  chatLog?: ChatEntry[];
  /** 当前座位是否开启 AI 托管（仅对本人显示） */
  aiPlayerEnabled?: boolean;
  /** 当前座位 AI 积极程度/温度（仅对本人显示） */
  aiPlayerTemperature?: number;
  /** 仅管理员可见：全局记录（含私密与裁定信息） */
  globalLog?: ReplayLogEntry[];
  /** 是否开启 AI 说书人接管 */
  aiStorytellerEnabled?: boolean;
  minPlayers: number;
  maxPlayers: number;
}
