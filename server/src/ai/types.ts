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

export type StorytellerDecision = ChoiceTwoPlayersOneCharacter | DemonKillChoice;
