// ============================================================
// 血染钟楼 核心类型定义
// 区分原则：
//   「规则(RULE)」= 确定性计算，代码直接得出
//   「说书人裁量(STORYTELLER)」= 说书人选择，可能包含误导
// ============================================================

// ----- 阵营与角色类型 -----
export type Alignment = 'good' | 'evil';
export type CharacterType = 'townsfolk' | 'outsider' | 'minion' | 'demon';

/** 角色信息源类型 */
export type InfoSource =
  | 'rule'          // 确定性规则计算（如厨师：相邻邪恶数）
  | 'storyteller'   // 说书人裁量决定（如洗衣妇：选谁+指什么身份）
  | 'none';         // 无信息能力

/** 角色定义 */
export interface CharacterDef {
  id: string;
  name: string;
  nameZh: string;
  alignment: Alignment;
  type: CharacterType;
  ability: string;
  abilityZh: string;
  infoSource: InfoSource;
  firstNightOnly?: boolean;
  /** 是否需要玩家选择目标（如占卜师选两人、僧侣选一人） */
  requiresPlayerChoice?: boolean;
  /** 需要选几个目标 */
  pickCount?: number;
}

/** 夜晚步骤定义 */
export interface NightStepDef {
  characterId: string;
  /** 该步骤性质 */
  stepType: 'info' | 'choice' | 'info_then_choice';
}

// ----- 剧本 -----
export interface ScriptDef {
  id: string;
  name: string;
  nameZh: string;
  characters: CharacterDef[];
  firstNightOrder: string[];   // 步骤按角色id排列
  otherNightOrder: string[];
  minPlayers: number;
  maxPlayers: number;
}

// ----- 游戏阶段 -----
export type GamePhase = 'waiting' | 'first_night' | 'day' | 'night' | 'ended';
export type DaySubPhase = 'discussion' | 'nomination' | 'voting' | 'execution';
export type DayFlowStage = 'god_dialogue' | 'private_dialogue' | 'public_speech' | 'nomination_vote';

// ----- 玩家状态 -----
export interface PlayerState {
  id: string;
  seatIndex: number;
  nickname: string;
  isAlive: boolean;
  /** "幽灵票"：死后可用一次投票 */
  hasGhostVote: boolean;
  /** 就绪状态（大厅用） */
  isReady: boolean;

  // --- 以下为服务端私有字段（不发给玩家） ---
  characterId?: string;
  /** 酒鬼的伪装角色 */
  drunkPretendCharacterId?: string;
  /** 本回合是否中毒（持续到下一黄昏） */
  usedDayActions?: string[];
}

// ----- 游戏状态（引擎管理的完整状态） -----
export interface GameState {
  scriptId: string;
  script: ScriptDef;
  players: PlayerState[];
  phase: GamePhase;
  dayNumber: number;
  daySubPhase: DaySubPhase | null;
  dayFlowStage: DayFlowStage | null;
  dayFlowStartSeat: number | null;

  // 夜晚状态
  nightStepIndex: number;
  pendingNightAction: PendingNightAction | null;
  /** 僧侣保护目标 */
  protectedSeatIndex: number | null;
  /** 投毒者当前目标（持续到下一黄昏） */
  poisonedSeatIndex: number | null;
  /** 本夜死亡/复活（天亮时公布） */
  lastNightDeaths: number[];
  lastNightRevivals: number[];
  /** 杀人者追踪（守鸦人用）：victim -> attacker */
  nightKillAttackerByVictim: Map<number, number>;

  // 白天状态
  currentNomination: Nomination | null;
  /** 今日提名记录：nominator -> nominated */
  nominationsToday: Map<number, number>;
  skippedNominationsToday: Set<number>;
  nominatedToday: Set<number>;
  votes: Map<number, boolean>;
  pendingExecution: number | null;
  pendingExecutionVotesFor: number;
  pendingExecutionTied: boolean;
  /** 上一次处决记录（掘墓人用） */
  lastExecutedSeatIndex: number | null;
  lastExecutedCharacterId: string | null;

  // 确认机制
  awaitingNightConfirm: boolean;
  nightConfirmations: Set<number>;
  awaitingNightInfoConfirm: boolean;
  pendingNightInfoConfirmSeats: Set<number>;
  nightInfoConfirmations: Set<number>;

  // 白天主动技能
  usedDayActionsBySeat: Map<number, Set<string>>;

  // 恶魔知识
  demonBluffs: string[];

  // --- 说书人裁量存储（由 StorytellerAgent 写入，引擎不主动修改） ---
  storytellerDecisions: Map<string, unknown>;

  // --- AI 玩家决策记录（用于复盘） ---
  aiDecisionLog: AiDecisionEntry[];

  // 聊天
  chatLog: ChatEntry[];

  // 日志
  publicLog: PublicLogEntry[];
  replayLog: ReplayLogEntry[];
}

export interface AiDecisionEntry {
  at: number;
  dayNumber: number;
  phase: string;
  seatIndex: number;
  type: 'speech' | 'nominate' | 'vote' | 'night_action';
  decision: unknown;
  reasoning: string;
}

// ----- 提名 -----
export interface Nomination {
  nominator: number;
  nominated: number;
}

// ----- 夜晚等待交互 -----
export interface PendingNightAction {
  stepId: string;
  actorSeatIndex: number;
  pick: 1 | 2;
}

// ----- 对话 -----
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

// ----- 日志 -----
export interface PublicLogEntry {
  seq: number;
  at: number;
  line: string;
}

export interface ReplayLogEntry {
  seq: number;
  at: number;
  groupKey: string;
  groupTitle: string;
  line: string;
}

// ----- 房间（外层包装）-----
export interface Room {
  id: string;
  hostSecret: string;
  connections: Map<string, number>;  // ws connectionId -> seatIndex
  game: GameState;
  status: 'lobby' | 'playing' | 'ended';
  // AI 托管开关
  aiStorytellerEnabled: boolean;
  aiPlayerEnabledBySeat: Map<number, boolean>;
  aiPlayerBehaviorStyleBySeat: Map<number, AiBehaviorStyle>;
  // 创建时间
  createdAt: number;
}

export type AiBehaviorStyle = 'analytical' | 'skeptical' | 'cautious' | 'empathetic' | 'deceptive' | 'chaotic';

// ----- 发送给客户端的视野（脱敏）-----
export interface RoomView {
  id: string;
  scriptId: string;
  scriptName: string;
  scriptNameZh: string;
  players: PublicPlayerView[];
  status: Room['status'];
  phase: GamePhase;
  dayNumber: number;
  daySubPhase: DaySubPhase | null;
  dayFlowStage: DayFlowStage | null;
  dayFlowStartSeat: number | null;
  currentNomination: Nomination | null;
  pendingExecution: number | null;
  pendingExecutionVotesFor: number;
  pendingExecutionTied: boolean;
  nominationsToday: Array<{ nominator: number; nominated: number }>;
  skippedNominationsToday: number[];
  lastNightDeaths: number[];
  lastNightRevivals: number[];
  publicLog: PublicLogEntry[];
  awaitingNightConfirm?: boolean;
  nightConfirmedSeats?: number[];
  awaitingNightInfoConfirm?: boolean;
  pendingNightInfoConfirmSeats?: number[];
  nightInfoConfirmedSeats?: number[];
  chatLog?: ChatEntry[];
  aiPlayerEnabled?: boolean;
  aiPlayerBehaviorStyle?: AiBehaviorStyle;
  aiStorytellerEnabled?: boolean;
  globalLog?: ReplayLogEntry[];
  minPlayers: number;
  maxPlayers: number;
}

export interface PublicPlayerView {
  id: string;
  seatIndex: number;
  nickname: string;
  isReady: boolean;
  isAlive: boolean;
  hasGhostVote: boolean;
}

// ----- Agent 交互类型 -----
/** 世界视野：引擎为某个座位构建的合法可见信息 */
export interface WorldView {
  seatIndex: number;
  phase: GamePhase;
  dayNumber: number;
  daySubPhase: DaySubPhase | null;
  aliveSeats: number[];
  deadSeats: number[];
  players: PublicPlayerView[];
  yourRole?: YourRoleInfo;
  yourAlignment?: Alignment;
  publicLog: PublicLogEntry[];
  chatLog: ChatEntry[];  // 已按权限过滤
  nominationsToday: Array<{ nominator: number; nominated: number }>;
  skippedNominationsToday: number[];
  currentNomination: Nomination | null;
  pendingExecution: number | null;
  lastNightDeaths: number[];
  lastNightRevivals: number[];
}

export interface YourRoleInfo {
  characterId: string;
  characterName: string;
  characterNameZh: string;
  ability: string;
  abilityZh: string;
  alignment: Alignment;
  type: CharacterType;
  infoSource: InfoSource;
}

/** 决策点：引擎要求 Agent 做出决策 */
export interface DecisionPoint {
  type: 'night_action' | 'nominate' | 'vote' | 'day_action' | 'night_confirm' | 'night_info_confirm' | 'chat';
  context: WorldView;
  /** 夜晚行动时提供 */
  nightPrompt?: PendingNightAction;
  /** 可选的合法动作列表 */
  allowedActions?: AllowedAction[];
}

export interface AllowedAction {
  actionId: string;
  label: string;
  params?: Record<string, unknown>;
}

/** Agent 行动 */
export interface AgentAction {
  type: string;
  payload: Record<string, unknown>;
}

// ----- 角色信息结果（引擎计算或说书人决定） -----
export interface WasherwomanResult {
  type: 'washerwoman_result';
  players: [number, number];  // 两名玩家座位
  characterId: string;         // 其中一人的镇民身份
}

export interface LibrarianResult {
  type: 'librarian_result';
  players: [number, number];
  characterId: string;
  noOutsider?: boolean;
}

export interface InvestigatorResult {
  type: 'investigator_result';
  players: [number, number];
  characterId: string;  // 其中一人的爪牙身份
}

export type InfoRoleResult = WasherwomanResult | LibrarianResult | InvestigatorResult;

// ----- 胜负结果 -----
export type WinResult = 'good' | 'evil' | null;

// ----- 复盘 -----
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
