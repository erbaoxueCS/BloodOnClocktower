// [NEW] AI 玩家人设生成器
// 根据角色和阵营生成独特的行为特征
import type { AiPlayerPersona } from '../game/types.js';

const RANDOM_SEED = Math.random() * 10000;

function seededRandom(): number {
  // 简单的伪随机，确保同一局内一致性
  return Math.random();
}

function rand(min: number, max: number): number {
  return Math.round((seededRandom() * (max - min) + min) * 100) / 100;
}

/**
 * 为 AI 玩家生成人设
 * 邪恶角色会获得伪装策略，善良角色获得推理偏好
 */
export function generateAiPersona(
  characterId: string,
  characterNameZh: string,
  alignment: 'good' | 'evil',
  characterType: 'townsfolk' | 'outsider' | 'minion' | 'demon',
  seatIndex: number,
  allSeatIndices: number[]
): AiPlayerPersona {
  const basePersonality = {
    aggression: rand(0.2, 0.8),
    bluffing: rand(0.1, 0.6),
    trust: rand(0.3, 0.7),
    social: rand(0.2, 0.9),
    riskTaking: rand(0.1, 0.7),
  };

  // 根据角色类型调整基础性格
  if (characterType === 'demon') {
    basePersonality.bluffing = rand(0.7, 0.95);
    basePersonality.aggression = rand(0.5, 0.9);
    basePersonality.riskTaking = rand(0.6, 0.9);
  } else if (characterType === 'minion') {
    basePersonality.bluffing = rand(0.6, 0.85);
    basePersonality.aggression = rand(0.4, 0.8);
    basePersonality.social = rand(0.5, 0.9);
  } else if (characterType === 'townsfolk') {
    basePersonality.trust = rand(0.4, 0.7);
    basePersonality.aggression = rand(0.2, 0.6);
  }

  const strategies: Array<'logical' | 'emotional' | 'chaos'> = ['logical', 'emotional', 'chaos'];
  const strategy = strategies[Math.floor(seededRandom() * 3)];

  const persona: AiPlayerPersona = {
    role: alignment,
    characterId,
    characterNameZh,
    personality: basePersonality,
    strategy,
  };

  // 邪恶角色专属策略
  if (alignment === 'evil') {
    const goodRoles = ['washerwoman', 'librarian', 'investigator', 'chef', 'empath', 'fortune_teller', 'undertaker', 'monk', 'ravenkeeper', 'virgin', 'slayer', 'soldier', 'mayor'];
    const randomGoodRole = goodRoles[Math.floor(seededRandom() * goodRoles.length)];

    persona.evilStrategy = {
      bluffTarget: randomGoodRole,
      protectWho: null, // 后续在初始化时根据邪恶队友设置
      sacrificeWillingness: rand(0.1, 0.6),
    };
  }

  return persona;
}

/**
 * 为邪恶角色设置队友保护目标
 */
export function setEvilAllies(
  persona: AiPlayerPersona,
  evilSeatIndices: number[],
  mySeatIndex: number
): void {
  if (persona.role !== 'evil' || !persona.evilStrategy) return;

  const otherEvil = evilSeatIndices.filter(s => s !== mySeatIndex);
  if (otherEvil.length > 0) {
    // 优先保护恶魔（如果是爪牙）或随机保护一个爪牙（如果是恶魔）
    persona.evilStrategy.protectWho = otherEvil[Math.floor(seededRandom() * otherEvil.length)];
  }
}
