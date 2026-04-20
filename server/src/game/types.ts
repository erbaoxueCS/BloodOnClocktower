/** 阵营 */
export type Alignment = 'good' | 'evil';

/** 角色类型：镇民/外来者/爪牙/恶魔 */
export type CharacterType = 'townsfolk' | 'outsider' | 'minion' | 'demon';

// [NEW] ========== AI 玩家相关类型 ==========

/** AI 玩家人设 */
export interface AiPlayerPersona {
  role: Alignment;
  characterId: string;
  characterNameZh: string;
  personality: {
    aggression: number;      // 0~1 攻击性：是否主动提名他人
    bluffing: number;        // 0~1 撒谎倾向（邪恶越高越好）
    trust: number;           // 0~1 轻信他人程度
    social: number;          // 0~1 发言活跃度
    riskTaking: number;      // 0~1 冒险倾向
  };
  strategy: 'logical' | 'emotional' | 'chaos';
  // [NEW] 邪恶角色专属
  evilStrategy?: {
    bluffTarget: string | null;       // 伪装成哪个善良角色 (characterId)
    protectWho: number | null;        // 保护哪个队友（恶魔保护爪牙/爪牙保护恶魔）
    sacrificeWillingness: number;     // 0~1 牺牲队友意愿
  };
}

/** AI 玩家记忆（按座位独立存储） */
export interface AiPlayerMemory {
  shortTerm: Array<{
    day: number;
    phase: string;
    event: string;       // 事件描述
    source: 'night_info' | 'chat_public' | 'chat_dm' | 'chat_god' | 'nomination' | 'vote' | 'death' | 'execution';
    at: number;
  }>;
  longTerm: Array<{
    day: number;
    summary: string;     // 当日总结（由 AI 自己生成）
  }>;
  suspicion: Map<number, number>;  // seatIndex -> 怀疑度 0~1（1=确信是邪恶）
  allyTrust: Map<number, number>;  // seatIndex -> 信任度 0~1（1=确信是善良）
}

/** AI 心路历程条目（持久化存储所有思考过程） */
export interface AiThoughtEntry {
  roomId: string;
  dayNumber: number;
  phase: string;
  seatIndex: number;
  characterId: string;
  trigger: string;           // 触发思考的事件（如「被提名」「夜晚行动」「轮到自己发言」）
  context: {                 // 当时的上下文快照
    publicInfo: string;      // 公开信息摘要
    privateInfo: string;     // 私有信息（夜间信息、私聊等）
    suspicionSnapshot: Array<{ seat: number; suspicion: number }>;
  };
  reasoning: string;         // AI 的完整推理过程
  decision: string;          // 最终决策
  emotion?: string;          // 情绪标签（如「紧张」「自信」「困惑」）
  timestamp: number;
}

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

  // [NEW] AI 玩家人设：seatIndex -> Persona
  aiPersonaBySeat: Map<number, AiPlayerPersona>;
  // [NEW] AI 玩家记忆：seatIndex -> AiPlayerMemory
  aiMemoryBySeat: Map<number, AiPlayerMemory>;
  // [NEW] AI 心路历程日志（全部座位的思考链，持久化存储）
  aiThoughtLog: AiThoughtEntry[];
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
  /** [NEW] AI 玩家心路历程（仅管理员可见） */
  aiThoughtLog?: AiThoughtEntry[];
  minPlayers: number;
  maxPlayers: number;
}
