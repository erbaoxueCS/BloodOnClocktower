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
}

/** 洗衣妇/图书管理员/调查员类决策：两名玩家 + 一个身份 */
export interface ChoiceTwoPlayersOneCharacter {
  type: 'washerwoman_result' | 'librarian_result' | 'investigator_result';
  players: [number, number];
  characterId: string;
}

/** 图书管理员在无外来者时的结果 */
export interface LibrarianNoOutsiderChoice {
  type: 'librarian_result';
  noOutsider: true;
}

/** 恶魔杀人决策 */
export interface DemonKillChoice {
  type: 'imp_kill';
  targetSeatIndex: number;
}

export type StorytellerDecision = ChoiceTwoPlayersOneCharacter | LibrarianNoOutsiderChoice | DemonKillChoice;
