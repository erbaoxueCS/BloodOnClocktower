// [MODIFIED] 扩展 AI 类型定义
// 原有类型保留，新增说书人更多裁量点和 AI 玩家类型

/** AI 说书人决策请求（适配层输出） */
export interface StorytellerRequest {
  scriptName: string;
  scriptNameZh: string;
  phase: 'first_night' | 'night';
  dayNumber: number;
  stepId: string;
  stepNameZh: string;
  aliveSeatIndices: number[];
  deadSeatIndices: number[];
  playerCount: number;
  /** 可选：醉酒/中毒等，后续扩展 */
  drunkOrPoisoned?: number[];
  /** 本夜当前投毒目标座位（仅给 AI 编排信息，不对外暴露） */
  poisonedSeatIndex?: number | null;
  // [NEW] 额外上下文
  /** 历史决策记录（用于保持一致性） */
  pastDecisions?: Record<string, unknown>;
  /** 聊天摘要（白天玩家讨论的重点） */
  chatSummary?: string;
  /** 当前局势评估 */
  gameBalance?: 'good_advantage' | 'evil_advantage' | 'even';
}

/** 洗衣妇/图书管理员/调查员类决策：两名玩家 + 一个身份 */
export interface ChoiceTwoPlayersOneCharacter {
  type: 'washerwoman_result' | 'librarian_result' | 'investigator_result';
  players: [number, number];
  characterId: string;
}

/** 恶魔杀人决策 */
export interface DemonKillChoice {
  type: 'imp_kill';
  targetSeatIndex: number;
}

// [NEW] 投毒者决策
export interface PoisonerChoice {
  type: 'poisoner_target';
  targetSeatIndex: number;
}

// [NEW] 占卜师结果
export interface FortuneTellerChoice {
  type: 'fortune_teller_result';
  targetSeats: [number, number];
  hasDemon: boolean;
}

// [NEW] 僧侣保护决策
export interface MonkChoice {
  type: 'monk_protect';
  targetSeatIndex: number;
}

// [NEW] 恶魔 bluff 决策（分配不在场身份）
export interface DemonBluffChoice {
  type: 'demon_bluff';
  bluffCharacterIds: string[];
}

export type StorytellerDecision =
  | ChoiceTwoPlayersOneCharacter
  | DemonKillChoice
  | PoisonerChoice
  | FortuneTellerChoice
  | MonkChoice
  | DemonBluffChoice;
