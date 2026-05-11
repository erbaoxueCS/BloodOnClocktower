// ============================================================
// AI 玩家 Agent：观察→更新信念→推理→行动 四步循环
//
// 每个 AI 托管座位拥有独立的:
//   - 信念系统（嫌疑度/信任度/角色推测）
//   - 记忆系统（情节记忆 + 语义记忆摘要）
//   - 行动决策（对话/提名/投票/夜晚选人）
// ============================================================

import type { WorldView, YourRoleInfo, Alignment, Nomination, PublicPlayerView } from '../../engine/types.js';
import { callLlm } from '../../llm/llmClient.js';

// ----- 配置 -----
const AI_PLAYER_ENABLED = (process.env.USE_AI_PLAYER ?? 'true').trim().toLowerCase() !== 'false';
const AI_PLAYER_MODEL = process.env.AI_PLAYER_MODEL ?? process.env.OPENAI_MODEL ?? 'qwen-plus';

// ----- 信念系统 -----
export interface SeatBelief {
  /** 嫌疑度 0~1 */
  suspicion: number;
  /** 信任度 0~1 */
  trust: number;
  /** 可能角色列表（角色id → 概率 0~1） */
  possibleRoles: Map<string, number>;
  /** 标签 */
  tags: string[];
}

export interface PlayerMemory {
  /** 事件时间线（仅该座位可感知的） */
  timeline: Array<{ at: number; event: string }>;
  /** 语义摘要（可注入 prompt 的认知总结） */
  summary: string;
  /** 对各座位的信念 */
  beliefs: Map<number, SeatBelief>;
  /** 上次投票快照 */
  lastVoteSnapshot?: string;
  /** DM 收件箱 */
  dmInbox: Map<number, Array<{ at: number; from: number; text: string }>>;
  /** 已见过的去重 key */
  seenKeys: Set<string>;
}

// ----- 行为风格 -----
type PromptStyle = 'balanced' | 'assertive' | 'deceptive' | 'chaotic';

function getStyleGuidance(style: PromptStyle, alignment: Alignment | undefined): string {
  const base = alignment === 'evil'
    ? '你是邪恶阵营。你的目标是保护恶魔、误导善良阵营、避免被发现。你可以撒谎、伪装身份、制造混乱。'
    : '你是善良阵营。你的目标是找出恶魔并处决之。基于你的角色信息，推进推理和讨论。';

  const styleGuide: Record<PromptStyle, string> = {
    balanced: '风格：均衡。有时积极有时保守，像正常玩家一样自然。',
    assertive: '风格：积极主导。主动推动提名和投票，积极发表推理。',
    deceptive: alignment === 'evil'
      ? '风格：狡猾误导。巧妙编造"证据"，引导善良阵营怀疑错误目标。'
      : '风格：谨慎揭露。有策略地逐步分享信息，避免过早暴露身份。',
    chaotic: '风格：不可预测。偶尔做出出人意料的行动，增加对局趣味性。有时故意反着来。',
  };

  return base + '\n' + (styleGuide[style] ?? styleGuide.balanced);
}

// ============================================================
// PlayerAgent
// ============================================================

export class PlayerAgent {
  readonly seatIndex: number;
  readonly alignment: Alignment;
  readonly myRole: YourRoleInfo;
  readonly style: PromptStyle;

  private memory: PlayerMemory;
  private initialized = false;

  constructor(
    seatIndex: number,
    myRole: YourRoleInfo,
    alignment: Alignment,
    style?: string,
  ) {
    this.seatIndex = seatIndex;
    this.myRole = myRole;
    this.alignment = alignment;
    this.style = normalizeStyle(style);
    this.memory = {
      timeline: [],
      summary: '',
      beliefs: new Map(),
      dmInbox: new Map(),
      seenKeys: new Set(),
    };
  }

  // ----- 感知世界 -----
  perceive(worldView: WorldView): void {
    // 提取关键事件
    const events = extractEvents(worldView, this.seatIndex, this.memory.seenKeys);

    if (events.length > 0) {
      this.memory.timeline.push(...events);
      // 裁剪时间线
      if (this.memory.timeline.length > 80) {
        this.memory.timeline = this.memory.timeline.slice(-60);
      }
    }

    // 更新信念
    this.updateBeliefs(worldView);

    // 每轮重建语义摘要（轻量，用于 prompt 注入）
    this.memory.summary = buildMemorySummary(this.memory, worldView, this.myRole);

    this.initialized = true;
  }

  // ----- 更新信念 -----
  private updateBeliefs(worldView: WorldView): void {
    for (const p of worldView.players) {
      if (p.seatIndex === this.seatIndex) continue;
      let belief = this.memory.beliefs.get(p.seatIndex);
      if (!belief) {
        belief = { suspicion: 0.3, trust: 0.3, possibleRoles: new Map(), tags: [] };
        this.memory.beliefs.set(p.seatIndex, belief);
      }

      if (!p.isAlive) {
        belief.suspicion = 0.1;
        belief.trust = 0.1;
        belief.tags = ['已死亡'];
        continue;
      }

      // 从公开日志中提取线索更新信念
      for (const log of worldView.publicLog.slice(-10)) {
        const line = log.line;
        // 被提名 → 稍微增加嫌疑
        if (line.includes(`#${p.seatIndex + 1}`) && line.includes('提名')) {
          // 被提名本身不意味着有罪
        }
        // 提名了恶魔相关 → 如果是善良阵营可能增加了嫌疑
        if (line.includes(`#${p.seatIndex + 1} 提名`)) {
          // 积极提名的人可能是善良
          belief.trust = Math.min(1, belief.trust + 0.05);
        }
        // 投票反对处决 → 稍微增加嫌疑
        if (line.includes(`#${p.seatIndex + 1} 投票反对`)) {
          belief.suspicion = Math.min(1, belief.suspicion + 0.03);
        }
      }
    }
  }

  // ===== 决策 =====

  /** 处理白天计划：决定发言/对话方向 */
  async decideDayPlan(worldView: WorldView): Promise<{
    decision: string;
    publicSpeech?: string;
    dmTarget?: number;
    dmText?: string;
    godQuery?: string;
    shouldNominate?: number;
    reasoning: string;
  }> {
    if (!AI_PLAYER_ENABLED) return { decision: 'disabled', reasoning: 'AI player disabled' };

    const { systemPrompt, userPrompt } = buildDayPlanPrompt(
      this.seatIndex, this.myRole, this.alignment, this.style,
      worldView, this.memory,
    );

    try {
      const result = await callLlm(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { temperature: 0.7, jsonMode: true, maxAttempts: 2, timeoutMs: 25000 },
      );

      if (result.json) {
        return {
          decision: (result.json.decision as string) ?? 'pass',
          publicSpeech: result.json.publicSpeech as string | undefined,
          dmTarget: result.json.dmTarget as number | undefined,
          dmText: result.json.dmText as string | undefined,
          godQuery: result.json.godQuery as string | undefined,
          shouldNominate: result.json.shouldNominate as number | undefined,
          reasoning: (result.json.reasoning as string) ?? '',
        };
      }
    } catch { /* fallback */ }

    return { decision: 'pass', reasoning: 'LLM error, passing turn' };
  }

  /** 处理夜晚目标选择 */
  async decideNightTargets(
    stepId: string,
    pickCount: number,
    aliveSeats: number[],
    worldView: WorldView,
  ): Promise<{ targets: number[]; reasoning: string }> {
    if (!AI_PLAYER_ENABLED) return { targets: aliveSeats.slice(0, pickCount), reasoning: 'disabled' };

    const { systemPrompt, userPrompt } = buildNightActionPrompt(
      this.seatIndex, this.myRole, this.alignment, this.style,
      stepId, pickCount, aliveSeats, worldView, this.memory,
    );

    try {
      const result = await callLlm(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { temperature: 0.5, jsonMode: true, maxAttempts: 2, timeoutMs: 20000 },
      );

      if (result.json) {
        const targets = result.json.targets as number[] | undefined;
        if (Array.isArray(targets) && targets.length === pickCount) {
          return {
            targets: targets.map(t => Number(t)),
            reasoning: (result.json.reasoning as string) ?? '',
          };
        }
      }
    } catch { /* fallback */ }

    // 兜底：智能降级策略
    const fallbackTargets = this.getFallbackNightTargets(stepId, pickCount, aliveSeats);
    return { targets: fallbackTargets, reasoning: 'LLM failed, using strategy-aware fallback' };
  }

  /** 处理提名决策 */
  async decideNomination(worldView: WorldView): Promise<{
    shouldSkip: boolean;
    nominatedSeat?: number;
    reasoning: string;
  }> {
    if (!AI_PLAYER_ENABLED) return { shouldSkip: true, reasoning: 'disabled' };

    const { systemPrompt, userPrompt } = buildNominationPrompt(
      this.seatIndex, this.myRole, this.alignment, this.style,
      worldView, this.memory,
    );

    try {
      const result = await callLlm(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { temperature: 0.5, jsonMode: true, maxAttempts: 2, timeoutMs: 15000 },
      );

      if (result.json) {
        return {
          shouldSkip: !!result.json.shouldSkip,
          nominatedSeat: result.json.nominatedSeat as number | undefined,
          reasoning: (result.json.reasoning as string) ?? '',
        };
      }
    } catch { /* fallback */ }

    // 智能降级：根据阵营和怀疑度提名
    return this.getFallbackNomination(worldView);
  }

  /** 处理投票决策 */
  async decideVote(worldView: WorldView, nomination: Nomination): Promise<{
    inFavor: boolean;
    reasoning: string;
  }> {
    if (!AI_PLAYER_ENABLED) return { inFavor: Math.random() < 0.5, reasoning: 'disabled' };

    const { systemPrompt, userPrompt } = buildVotePrompt(
      this.seatIndex, this.myRole, this.alignment, this.style,
      worldView, this.memory, nomination,
    );

    try {
      const result = await callLlm(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { temperature: 0.4, jsonMode: true, maxAttempts: 2, timeoutMs: 10000 },
      );

      if (result.json) {
        return {
          inFavor: !!result.json.inFavor,
          reasoning: (result.json.reasoning as string) ?? '',
        };
      }
    } catch { /* fallback */ }

    // 智能降级：阵营感知投票
    return this.getFallbackVote(nomination);
  }

  /** 终局复盘回答 */
  async answerPostGameQuestion(question: string, worldView: WorldView): Promise<string> {
    if (!AI_PLAYER_ENABLED) return '(AI player disabled)';

    const systemPrompt = `你是血染钟楼玩家 #${this.seatIndex + 1}。
你的真实身份是 ${this.myRole.characterNameZh}（${this.myRole.characterName}），阵营 ${this.alignment === 'good' ? '善良' : '邪恶'}。
现在对局已经结束，有人向你提问。请诚实回答（因为游戏已结束），解释你当时的策略和动机。`;

    try {
      const result = await callLlm(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
        { temperature: 0.7, jsonMode: false, maxAttempts: 2, timeoutMs: 20000 },
      );
      return result.raw;
    } catch {
      return '(无法回答)';
    }
  }

  /** 获取记忆摘要 */
  getMemorySummary(): string {
    return this.memory.summary;
  }

  /** 智能夜晚目标降级（不在随机兜底，基于策略选择） */
  private getFallbackNightTargets(stepId: string, pickCount: number, aliveSeats: number[]): number[] {
    const aliveOthers = aliveSeats.filter(s => s !== this.seatIndex);

    if (stepId === 'imp') {
      // 恶魔：尽量不刀疑似爪牙的玩家（基于信念中低怀疑度的活人）
      const sorted = aliveOthers.sort((a, b) => {
        const ba = this.memory.beliefs.get(a);
        const bb = this.memory.beliefs.get(b);
        // 优先刀信任度高的（很可能是善良阵营）
        return (bb?.trust ?? 0.3) - (ba?.trust ?? 0.3);
      });
      return sorted.slice(0, pickCount);
    }

    if (stepId === 'monk') {
      // 僧侣：保护信任度最高的玩家
      const sorted = aliveOthers.sort((a, b) => {
        const ba = this.memory.beliefs.get(a);
        const bb = this.memory.beliefs.get(b);
        return (bb?.trust ?? 0.3) - (ba?.trust ?? 0.3);
      });
      return sorted.slice(0, pickCount);
    }

    if (stepId === 'poisoner') {
      // 投毒者：毒怀疑度最高的玩家（可能是占卜师等重要角色）
      const sorted = aliveOthers.sort((a, b) => {
        const ba = this.memory.beliefs.get(a);
        const bb = this.memory.beliefs.get(b);
        return (bb?.suspicion ?? 0.3) - (ba?.suspicion ?? 0.3);
      });
      return sorted.slice(0, pickCount);
    }

    if (stepId === 'fortune_teller') {
      // 占卜师：优先查怀疑度最高的
      const sorted = aliveOthers.sort((a, b) => {
        const ba = this.memory.beliefs.get(a);
        const bb = this.memory.beliefs.get(b);
        return (bb?.suspicion ?? 0.3) - (ba?.suspicion ?? 0.3);
      });
      // 占卜师选两个
      const result: number[] = [];
      for (let i = 0; i < pickCount && i < sorted.length; i++) result.push(sorted[i]);
      return result;
    }

    // 默认：选怀疑度最高的
    const sorted = aliveOthers.sort((a, b) => {
      const ba = this.memory.beliefs.get(a);
      const bb = this.memory.beliefs.get(b);
      return (bb?.suspicion ?? 0.3) - (ba?.suspicion ?? 0.3);
    });
    return sorted.slice(0, pickCount);
  }

  /** 智能提名降级 */
  private getFallbackNomination(worldView: WorldView): { shouldSkip: boolean; nominatedSeat?: number; reasoning: string } {
    if (this.alignment === 'evil') {
      // 邪恶阵营：尽量提名非同伴的可疑玩家
      const demonsAndMinions = new Set<number>();
      // 从信念中找出同伴（高信任的可能是同阵营）
      for (const [seat, belief] of this.memory.beliefs) {
        if (belief.trust > 0.6 && worldView.players.some(p => p.seatIndex === seat && p.isAlive)) {
          demonsAndMinions.add(seat);
        }
      }
      const target = worldView.players
        .filter(p => p.isAlive && p.seatIndex !== this.seatIndex && !demonsAndMinions.has(p.seatIndex))
        .sort((a, b) => {
          const ba = this.memory.beliefs.get(a.seatIndex);
          const bb = this.memory.beliefs.get(b.seatIndex);
          return (bb?.suspicion ?? 0.3) - (ba?.suspicion ?? 0.3);
        })[0];
      if (target) return { shouldSkip: false, nominatedSeat: target.seatIndex, reasoning: 'fallback: nominate non-ally suspect' };
      return { shouldSkip: true, reasoning: 'fallback: no good target found' };
    }

    // 善良阵营：提名怀疑度最高的存活玩家
    const target = worldView.players
      .filter(p => p.isAlive && p.seatIndex !== this.seatIndex)
      .sort((a, b) => {
        const ba = this.memory.beliefs.get(a.seatIndex);
        const bb = this.memory.beliefs.get(b.seatIndex);
        return (bb?.suspicion ?? 0.3) - (ba?.suspicion ?? 0.3);
      })[0];
    if (target && (this.memory.beliefs.get(target.seatIndex)?.suspicion ?? 0.3) > 0.5) {
      return { shouldSkip: false, nominatedSeat: target.seatIndex, reasoning: 'fallback: nominate highest suspicion player' };
    }
    return { shouldSkip: true, reasoning: 'fallback: no strong suspect' };
  }

  /** 智能投票降级 */
  private getFallbackVote(nomination: { nominator: number; nominated: number }): { inFavor: boolean; reasoning: string } {
    const nominatedBelief = this.memory.beliefs.get(nomination.nominated);
    const suspicion = nominatedBelief?.suspicion ?? 0.3;

    if (this.alignment === 'evil') {
      // 邪恶阵营：同伴被提名则反对
      const isAlly = nominatedBelief?.trust != null && nominatedBelief.trust > 0.6;
      if (isAlly) return { inFavor: false, reasoning: 'fallback: nominated player is likely ally' };
      // 提名者是恶魔（自己）的提名，强迫投赞成减小嫌疑
      if (nomination.nominator === this.seatIndex) return { inFavor: true, reasoning: 'fallback: voting for own nomination' };
      // 高怀疑度的好人被提名 → 赞成
      if (suspicion < 0.4) return { inFavor: true, reasoning: 'fallback: nominated player likely good' };
      return { inFavor: false, reasoning: 'fallback: avoiding executing a non-ally' };
    }

    // 善良阵营：高怀疑度的投赞成
    if (suspicion > 0.6) return { inFavor: true, reasoning: 'fallback: high suspicion target' };
    // 提名者是高信任的好人 → 跟投
    const nominatorBelief = this.memory.beliefs.get(nomination.nominator);
    if (nominatorBelief?.trust != null && nominatorBelief.trust > 0.6) return { inFavor: true, reasoning: 'fallback: trusting nominator judgment' };
    return { inFavor: false, reasoning: 'fallback: insufficient suspicion' };
  }
}

// ===== Agent 池管理 =====
const agentPool = new Map<string, PlayerAgent>();

export function getOrCreatePlayerAgent(
  key: string,
  seatIndex: number,
  myRole: YourRoleInfo,
  alignment: Alignment,
  style?: string,
): PlayerAgent {
  const existing = agentPool.get(key);
  if (existing) return existing;
  const agent = new PlayerAgent(seatIndex, myRole, alignment, style);
  agentPool.set(key, agent);
  return agent;
}

export function clearPlayerAgent(key: string): void {
  agentPool.delete(key);
}

// ===== 辅助函数 =====

function normalizeStyle(raw?: string): PromptStyle {
  if (raw === 'assertive' || raw === 'deceptive' || raw === 'chaotic') return raw;
  return 'balanced';
}

function extractEvents(
  wv: WorldView,
  mySeat: number,
  seenKeys: Set<string>,
): Array<{ at: number; event: string }> {
  const events: Array<{ at: number; event: string }> = [];
  const now = Date.now();

  for (const log of wv.publicLog.slice(-10)) {
    const key = `pub-${log.seq}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    events.push({ at: log.at, event: `[公开] ${log.line}` });
  }

  for (const chat of wv.chatLog.slice(-10)) {
    const key = `chat-${chat.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const prefix = chat.scope === 'dm' ? '[私聊]'
      : chat.scope === 'god' ? '[上帝]'
      : '[公聊]';
    events.push({ at: chat.at, event: `${prefix} #${chat.fromSeat + 1}: ${chat.text.slice(0, 100)}` });
  }

  if (wv.lastNightDeaths.length > 0) {
    const key = `deaths-${wv.dayNumber}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      events.push({
        at: now,
        event: `[死亡] 昨夜死亡：${wv.lastNightDeaths.map(s => `#${s + 1}`).join('、')}`,
      });
    }
  }

  return events;
}

function buildMemorySummary(
  memory: PlayerMemory,
  wv: WorldView,
  role: YourRoleInfo,
): string {
  const parts: string[] = [];
  parts.push(`身份：${role.characterNameZh}`);
  parts.push(`存活：${wv.aliveSeats.map(s => `#${s + 1}`).join(',')}`);

  if (memory.timeline.length > 0) {
    const recent = memory.timeline.slice(-8).map(e => e.event).join(' | ');
    parts.push(`最近事件：${recent}`);
  }

  return parts.join('\n');
}

// ===== Prompt 构建 =====

const GAME_RULES_SYSTEM = `【血染钟楼·暗流涌动 完整游戏规则】

=== 基础规则 ===
- 游戏分为白天和夜晚两个阶段交替进行。
- 白天：玩家公开讨论、互相提名、投票处决。
- 夜晚：角色按顺序发动技能（信息角色获知线索，恶魔选择杀害目标）。
- 游戏目标：
  - 善良阵营：找出并处决恶魔。
  - 邪恶阵营（恶魔+爪牙）：保护恶魔存活到最后。

=== 角色类型 ===
- 镇民 (Townsfolk)：善良阵营，拥有正面技能帮助找出恶魔。
- 外来者 (Outsider)：善良阵营，但技能通常对善良阵营不利。
- 爪牙 (Minion)：邪恶阵营，拥有干扰性的技能。
- 恶魔 (Demon)：邪恶阵营的核心，每夜选择杀害一名玩家。

=== 白天的流程 ===
1. 讨论阶段：存活玩家公开讨论，可以私聊（DM），可以向"上帝"询问自己已知的信息。
2. 提名阶段：每个存活玩家一次机会，选择提名一名存活玩家（或被提名过一次的不可再次被提名，每人只能作为提名者一次）。
3. 投票：被提名后，所有存活玩家 + 拥有幽灵票的死亡玩家投票。赞成票 >= 存活人数一半 → 进入待处决。
4. 处决：白天结束时，获得赞成票最多的玩家被处决（平局则无人处决）。
5. 特殊：圣徒被处决 → 邪恶阵营立即获胜。

=== 夜晚流程 ===
- 按固定顺序，每个角色依次发动：
  - 首夜顺序：洗衣妇 → 图书管理员 → 调查员 → 厨师 → 共情者（首夜） → 占卜师（首夜） → 间谍 → 爪牙信息 → 恶魔信息
  - 后续夜顺序：共情者 → 占卜师 → 厨师 → 掘墓人 → 僧侣 → 投毒者 → 间谍 → 恶魔小恶魔 → 守鸦人
  - 恶魔击杀：目标存活且不是恶魔本人 → 目标死亡（除非僧侣保护或士兵免疫）

=== 重要机制 ===
- 中毒/醉酒 (Poisoned/Drunk)：角色能力失效或获得虚假信息。
- 酒鬼 (Drunk)：以为自己是某个镇民，但实际上是外来者，所有"信息"都是假的。
- 间谍 (Spy)：邪恶阵营，但被认为善良。可以查看完整魔典。
- 隐士 (Recluse)：善良阵营，但可能被检测为邪恶。
- 红鲱鱼 (Red Herring)：占卜师总会检测红鲱鱼座位为"是"。
- 爪牙晋升：恶魔自杀后，一个爪牙成为新的恶魔。
- 幽灵票：死亡玩家整局有一次投票权。

=== 关键策略提示 ===
- 作为好人，公开分享信息很重要——信息透明度是好人最大的武器。
- 作为恶人，需要伪造合理的信息（bluff），不要暴露同伴。
- 不提名不投票等于放弃——尽量每天处决一个可疑玩家。
- 死人可能有幽灵票，他们的意见也很重要。`;

function buildDayPlanPrompt(
  seatIndex: number,
  role: YourRoleInfo,
  alignment: Alignment | undefined,
  style: PromptStyle,
  wv: WorldView,
  memory: PlayerMemory,
): { systemPrompt: string; userPrompt: string } {
  const alive = wv.aliveSeats.map(s => `#${s + 1}`).join(', ');
  const dead = wv.deadSeats.length > 0 ? wv.deadSeats.map(s => `#${s + 1}`).join(', ') : '无';

  const recentLogs = wv.publicLog.slice(-15).map(l => l.line).join('\n');
  const recentChats = wv.chatLog.filter(c => c.scope === 'public').slice(-10).map(c => `#${c.fromSeat + 1}: ${c.text.slice(0, 150)}`).join('\n');

  const systemPrompt = `你是血染钟楼玩家 #${seatIndex + 1}。

${GAME_RULES_SYSTEM}

${getStyleGuidance(style, alignment)}

=== 你的当前状态 ===
你的角色：${role.characterNameZh}（${role.characterName}）
角色能力：${role.abilityZh}
阵营：${alignment === 'good' ? '善良' : '邪恶'}
${memory.summary}

=== 行动输出格式 ===
根据当前局面，决定你的行动。输出严格的 JSON 对象：

{
  "decision": "speak" 或 "pass",
  "publicSpeech": "你的公开发言（用真人自然语言，推理、质疑、拉票）。如果当前无话可说，设为空字符串。",
  "dmTarget": 私聊目标的 seatIndex（如果你不想私聊设为 null）,
  "dmText": "私聊内容（如果不想私聊设为空字符串）",
  "godQuery": "对上帝的问题（白天可以问上帝你的技能信息），如果不问上帝设为空字符串",
  "shouldNominate": 你想提名处决的玩家 seatIndex（如果不想提名设为 null）,
  "reasoning": "内部推理过程（不公开）——你为什么做出这个决定？你的策略是什么？"
}

重要：你的公开发言应该像真人玩家——可以质疑别人、分享信息、拉票、或套话。不要输出机械化的内容。`;

  const userPrompt = `=== 当前局面 ===
第 ${wv.dayNumber} 天 · 白天（${wv.daySubPhase === 'discussion' ? '讨论阶段' : wv.daySubPhase === 'nomination' ? '提名阶段' : '投票阶段'}）
存活玩家：${alive}
已死亡：${dead}
${
  wv.currentNomination
    ? `当前提名：#${wv.currentNomination.nominator + 1} 提名处决 #${wv.currentNomination.nominated + 1}（等待投票）`
    : '当前无活跃提名'
}
${
  wv.nominationsToday.length > 0
    ? '今日提名：[已完成_' + wv.nominationsToday.map(n => `#${n.nominator + 1}→#${n.nominated + 1}`).join(', ') + ']'
    : '今日尚无提名'
}
${
  wv.pendingExecution != null
    ? `⚠ 待处决：#${wv.pendingExecution + 1}`
    : ''
}
${
  wv.lastNightDeaths.length > 0
    ? `\n☠ 昨夜死亡：#${wv.lastNightDeaths.map(s => `#${s + 1}`).join('、')}`
    : '\n昨夜无人死亡'
}

=== 最近公开事件 ===
${recentLogs || '(无)'}

=== 最近公开发言 ===
${recentChats || '(暂时无人公聊)'}

=== 投票倾向 ===
${
  wv.nominationsToday.length > 0
    ? wv.nominationsToday.map(n => `#${n.nominator + 1} 提名 #${n.nominated + 1}`).join('\n')
    : '尚无投票'
}

请基于以上信息，决定你当前的行动。注意：你是真正的血染钟楼玩家，不是旁观者！你要投入游戏，根据你的真实身份和掌握的信息做出合理决策。`;

  return { systemPrompt, userPrompt };
}

function buildNightActionPrompt(
  seatIndex: number,
  role: YourRoleInfo,
  alignment: Alignment | undefined,
  style: PromptStyle,
  stepId: string,
  pickCount: number,
  aliveSeats: number[],
  wv: WorldView,
  memory: PlayerMemory,
): { systemPrompt: string; userPrompt: string } {
  const alive = aliveSeats.filter(s => s !== seatIndex).map(s => `#${s + 1} (${wv.players.find(p => p.seatIndex === s)?.nickname ?? ''})`).join(', ');

  const stepExplanations: Record<string, string> = {
    imp: '你是恶魔（小恶魔）。选择一名玩家杀害。注意：不要杀害你的爪牙同伴！如果选择自己，你会自杀并将身份传给一个爪牙。',
    monk: '你是僧侣。选择一名玩家保护，该玩家今晚不会被恶魔杀害。',
    poisoner: '你是投毒者。选择一名玩家投毒，该玩家今夜和明天白天的能力失效（获得假信息）。',
    fortune_teller: '你是占卜师。选择两名玩家，说书人会告知你其中是否包含恶魔。注意：红鲱鱼会使你误判其中一个为目标。',
  };

  const recentLogs = wv.publicLog.slice(-8).map(l => l.line).join('\n');

  const systemPrompt = `你是血染钟楼玩家 #${seatIndex + 1}。

${GAME_RULES_SYSTEM}

${getStyleGuidance(style, alignment)}

=== 你的当前状态 ===
你的角色：${role.characterNameZh}（${role.characterName}）
角色能力：${role.abilityZh}
阵营：${alignment === 'good' ? '善良' : '邪恶'}
${memory.summary}

现在轮到你在夜晚行动。

${stepExplanations[stepId] ?? `你的角色需要在夜晚选择 ${pickCount} 名玩家。`}

输出格式（严格 JSON）：
{
  "targets": [seatIndex, seatIndex, ...],  // 选中玩家的 seatIndex 数组，必须选正好 ${pickCount} 个
  "reasoning": "你的选择理由——基于已有信息和当前局面"
}`;

  const userPrompt = `=== 夜晚行动 ===
第 ${wv.phase === 'first_night' ? '1' : wv.dayNumber + 1} 夜
你的行动：${role.characterNameZh}

可选目标（除去自己）：${alive}
需要选择：${pickCount} 名玩家

${
  wv.lastNightDeaths.length > 0
    ? `昨夜死亡：${wv.lastNightDeaths.map(s => `#${s + 1}`).join('、')}`
    : '昨夜无人死亡'
}

最近事件：
${recentLogs || '(无)'}

请选择你的目标。这是基于你角色能力和阵营策略的关键决策！`;

  return { systemPrompt, userPrompt };
}

function buildNominationPrompt(
  seatIndex: number,
  role: YourRoleInfo,
  alignment: Alignment | undefined,
  style: PromptStyle,
  wv: WorldView,
  memory: PlayerMemory,
): { systemPrompt: string; userPrompt: string } {
  const recentLogs = wv.publicLog.slice(-15).map(l => l.line).join('\n');
  const recentChats = wv.chatLog.filter(c => c.scope === 'public').slice(-10).map(c => `#${c.fromSeat + 1}: ${c.text.slice(0, 150)}`).join('\n');
  const recentDeaths = wv.lastNightDeaths.length > 0
    ? `昨夜死亡：${wv.lastNightDeaths.map(s => `#${s + 1}`).join('、')}`
    : '昨夜无人死亡';
  const aliveList = wv.players.filter(p => p.isAlive).map(p => `#${p.seatIndex + 1} (${p.nickname})`).join(', ');

  const systemPrompt = `你是血染钟楼玩家 #${seatIndex + 1}。

${GAME_RULES_SYSTEM}

${getStyleGuidance(style, alignment)}

=== 你的当前状态 ===
你的角色：${role.characterNameZh}（${role.characterName}）
阵营：${alignment === 'good' ? '善良' : '邪恶'}
${memory.summary}

=== 提名决策 ===
现在是提名阶段，你需要决定是否提名一名存活玩家处决。

关键原则：
1. 血染钟楼中，每天处决一名玩家是善良阵营最重要的武器。
2. 不要害怕提名——信息不完全时也可以基于直觉提名。
3. 流浪者/隐士等角色可能会被误判，但总比不处决好。
4. 注意你在投票时的可信度：如果提名了明显的好人，你会失去信任。
${alignment === 'evil' ? '5. 作为邪恶阵营，你可以通过"假提名"伪装成积极的好人，但注意不要提名你的同伴。' : '5. 作为善良阵营，积极提名可疑玩家是责任。'}

输出格式（严格 JSON）：
{
  "shouldSkip": false,  // 如果不想提名设为 true
  "nominatedSeat": 目标 seatIndex,  // 要处决的玩家座位号，如果 shouldSkip 为 true 则设为 null
  "reasoning": "你的决策理由——你为什么怀疑/信任这个人？"
}`;

  const alreadyNominated = wv.nominationsToday.map(n => `#${n.nominator + 1}→#${n.nominated + 1}`).join(', ');
  const notYetDecided = wv.players
    .filter(p => p.isAlive && !wv.nominationsToday.some(n => n.nominator === p.seatIndex) && !wv.skippedNominationsToday.includes(p.seatIndex))
    .map(p => `#${p.seatIndex + 1} (${p.nickname})`)
    .join(', ');

  const userPrompt = `=== 第 ${wv.dayNumber} 天 · 提名阶段 ===
${recentDeaths}
存活玩家：${aliveList}
已提名：${alreadyNominated || '暂无'}
尚未提名/跳过：${notYetDecided || '全部已处理'}
${wv.currentNomination ? `当前提名：#${wv.currentNomination.nominator + 1} → #${wv.currentNomination.nominated + 1}` : '当前无提名'}
${wv.pendingExecution != null ? `⚠ 待处决：#${wv.pendingExecution + 1}` : '今日尚无人达到处决条件'}

最近公开事件（包含信息/死亡/投票记录）：
${recentLogs || '(暂无)'}

最近公开发言记录：
${recentChats || '(暂无公聊记录)'}

你是否要提名某位玩家？基于你掌握的信息，谁最可能是邪恶阵营？记住：如果你不提名，可能永远无法处决恶魔！`;

  return { systemPrompt, userPrompt };
}

function buildVotePrompt(
  seatIndex: number,
  role: YourRoleInfo,
  alignment: Alignment | undefined,
  style: PromptStyle,
  wv: WorldView,
  memory: PlayerMemory,
  nomination: Nomination,
): { systemPrompt: string; userPrompt: string } {
  const aliveCount = wv.players.filter(p => p.isAlive).length;
  const needVotes = Math.ceil(aliveCount / 2);
  const recentLogs = wv.publicLog.slice(-5).map(l => l.line).join('\n');

  const systemPrompt = `你是血染钟楼玩家 #${seatIndex + 1}。

${GAME_RULES_SYSTEM}

${getStyleGuidance(style, alignment)}

=== 你的当前状态 ===
你的角色：${role.characterNameZh}（${role.characterName}）
阵营：${alignment === 'good' ? '善良' : '邪恶'}
${memory.summary}

=== 投票决策 ===
现在是投票阶段。你需要决定是否赞成处决被提名者。

关键投票原则：
- 需要 ${needVotes}/${aliveCount} 赞成票才能处决（超过半数存活者）。
- 作为善良阵营：投赞成 = 你认为被提名者是邪恶的。投反对 = 你认为他可能是好人。
- 作为邪恶阵营：如果被提名的是同伴 → 投反对。如果是好人 → 可以选择投赞成（伪装成好人）或投反对（保护好人）。
- 死亡玩家有幽灵票（每人仅一次），可以影响投票结果。
- 每天处决一个人是对善良阵营最有利的策略。

输出格式（严格 JSON）：
{
  "inFavor": true,   // true=赞成处决, false=反对
  "reasoning": "你的投票理由——你为什么相信/怀疑被提名者？"
}`;

  const userPrompt = `=== 第 ${wv.dayNumber} 天 · 投票 ===
提名者：#${nomination.nominator + 1}
被提名者：#${nomination.nominated + 1}
需要 ${needVotes}/${aliveCount} 赞成票可处决

${
  wv.pendingExecution != null
    ? `当前最高票待处决：#${wv.pendingExecution + 1}`
    : '今日尚无待处决'
}

最近公开事件：
${recentLogs || '(无)'}

你是投赞成（处决 #${nomination.nominated + 1}）还是反对（放过 TA）？考虑你掌握的信息和阵营目标。`;

  return { systemPrompt, userPrompt };
}
