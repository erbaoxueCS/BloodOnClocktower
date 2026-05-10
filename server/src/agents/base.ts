// ============================================================
// Agent 基类与统一接口
// 无论是人类还是 AI，都通过此接口与游戏引擎交互
// ============================================================

import type { WorldView, DecisionPoint } from '../engine/types.js';

/** Agent 对决策点的响应 */
export interface AgentResponse {
  /** 响应类型：与 DecisionPoint.type 对应 */
  type: string;
  /** 结构化负载 */
  payload: Record<string, unknown>;
  /** 可选：Agent 的推理过程（AI 用于日志/复盘） */
  reasoning?: string;
}

/**
 * 游戏 Agent 统一接口
 *
 * 角色（说书人 or 玩家）通过实现此接口与引擎交互：
 * - 人类 Agent：perceive 推送到前端，等待人类输入作为 response
 * - AI Agent：perceive 构建 prompt，通过 LLM 推理得出 response
 */
export interface GameAgent {
  readonly agentId: string;
  readonly agentType: 'storyteller' | 'player';

  /**
   * 引擎向 Agent 推送当前可感知的世界状态
   * Agent 更新内部记忆/信念
   */
  perceive(worldView: WorldView): void;

  /**
   * 引擎要求 Agent 做出决策
   * @returns Agent 的决策响应
   */
  decide(decisionPoint: DecisionPoint): Promise<AgentResponse>;
}

/** 人类玩家的决策接口：无 AI 调用，通过 WebSocket 等待用户输入 */
export interface HumanAgent extends GameAgent {
  /**
   * 将引擎的 DecisionPoint 转为一个"待处理请求"
   * 由传输层推送给前端，前端渲染为 UI 交互
   * 用户操作后通过 WS 发回，组装成 AgentResponse
   */
  getPendingRequest(): PendingHumanRequest | null;
  resolve(response: AgentResponse): void;
}

export interface PendingHumanRequest {
  decisionPoint: DecisionPoint;
  resolve: (value: AgentResponse) => void;
  reject: (reason: Error) => void;
}

/** 决策点事件（发送给人类前端） */
export interface DecisionPointEvent {
  type: 'night_prompt' | 'vote_prompt' | 'nomination_prompt' | 'night_confirm_prompt' | 'night_info_confirm_prompt';
  decisionPoint: DecisionPoint;
}
