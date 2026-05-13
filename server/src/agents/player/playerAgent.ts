/** agents/player/playerAgent.ts - AI 玩家代理 */
export * from '../../ai/playerAgent.js';

import type { Room } from '../../game/types.js';
import type { WorldView, YourRoleInfo, AiBehaviorStyle } from '../../engine/types.js';

export interface PlayerAgent {
  perceive(wv: WorldView): void;
  decideNightTargets(
    stepId: string, pick: number, aliveChoices: number[], wv: WorldView,
  ): Promise<{ targets: number[]; reasoning: string }>;
  decideDayPlan(wv: WorldView): Promise<{
    publicSpeech?: string; publicMessage?: string;
    dmTarget?: number; dmTargets?: number[]; dmText?: string;
    decision?: string; reasoning: string;
  }>;
  decideNomination(wv: WorldView): Promise<{
    targetSeat: number | null; nominatedSeat: number | null;
    shouldSkip: boolean; reasoning: string;
  }>;
  decideVote(wv: WorldView, currentNomination?: { nominator: number; nominated: number } | null): Promise<{ inFavor: boolean; reasoning: string }>;
}

const agentCache = new Map<string, PlayerAgent>();

export function getOrCreatePlayerAgent(
  _playerKey: string, seatIndex: number,
  _yourRole?: YourRoleInfo, _alignment?: string, _style?: AiBehaviorStyle,
): PlayerAgent {
  const key = `_playerKey-${seatIndex}`;
  let agent = agentCache.get(key);
  if (!agent) {
    agent = createStubAgent(seatIndex);
    agentCache.set(key, agent);
  }
  return agent;
}

export function clearPlayerAgent(roomId: string, seatIndex?: number): void {
  if (seatIndex !== undefined) {
    agentCache.delete(`${roomId}-${seatIndex}`);
  } else {
    for (const key of agentCache.keys()) {
      if (key.startsWith(`${roomId}-`)) agentCache.delete(key);
    }
  }
}

function createStubAgent(seatIndex: number): PlayerAgent {
  return {
    perceive(_wv: WorldView): void {},
    async decideNightTargets(stepId: string, pick: number, aliveChoices: number[], _wv: WorldView) {
      // 简化：随机选择
      const targets: number[] = [];
      const choices = [...aliveChoices];
      for (let i = 0; i < Math.min(pick, choices.length); i++) {
        const idx = Math.floor(Math.random() * choices.length);
        targets.push(choices.splice(idx, 1)[0]);
      }
      return { targets, reasoning: `[${seatIndex}] 随机选择: ${stepId}` };
    },
    async decideDayPlan(_wv: WorldView) {
      return { publicSpeech: '', dmTargets: [], reasoning: `[${seatIndex}] 无计划` };
    },
    async decideNomination(_wv: WorldView) {
      return { targetSeat: null, nominatedSeat: null, shouldSkip: true, reasoning: `[${seatIndex}] 跳过提名` };
    },
    async decideVote(_wv: WorldView, _currentNomination?) {
      return { inFavor: Math.random() > 0.5, reasoning: `[${seatIndex}] 随机投票` };
    },
  };
}
