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

    // 兜底：随机选择
    const shuffled = [...aliveSeats].sort(() => Math.random() - 0.5);
    return { targets: shuffled.slice(0, pickCount), reasoning: 'LLM fallback, random selection' };
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

    return { shouldSkip: true, reasoning: 'LLM error, skipping' };
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

    return { inFavor: Math.random() < 0.5, reasoning: 'LLM error, random vote' };
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

  const systemPrompt = `你是血染钟楼玩家 #${seatIndex + 1}。
${getStyleGuidance(style, alignment)}
你的角色：${role.characterNameZh}（${role.characterName}）
角色能力：${role.abilityZh}
${memory.summary}

行动类型：
- publicSpeech：公开发言（所有玩家可见，用于推理、质疑、拉票）
- dmTarget + dmText：私聊某玩家（用于密谋、分享信息）
- godQuery：向上帝提问（仅夜晚可用）
- shouldNominate：如果你想提名某个玩家，给出其 seatIndex
- decision：你的总体策略（如 "speak" 表示要发言, "pass" 表示不做动作）

输出格式（严格 JSON）：
{
  "decision": "speak|pass",
  "publicSpeech": "你的公开发言（自然语言，像真人一样）",
  "dmTarget": 私聊目标 seatIndex,
  "dmText": "私聊内容",
  "godQuery": "对上帝的问题（仅夜晚）",
  "shouldNominate": 提名目标 seatIndex,
  "reasoning": "内部推理（不公开）"
}`;

  const userPrompt = `当前阶段：${
    wv.phase === 'first_night' ? '首夜' :
    wv.phase === 'night' ? '夜晚' :
    '白天（讨论阶段）'
  }
存活玩家：${alive}
已死亡：${dead}
${
  wv.currentNomination
    ? `当前提名：#${wv.currentNomination.nominator + 1} 提名 #${wv.currentNomination.nominated + 1}`
    : '当前无提名'
}
${
  wv.nominationsToday.length > 0
    ? `今日已有提名：${wv.nominationsToday.map(n => `#${n.nominator + 1}→#${n.nominated + 1}`).join(', ')}`
    : ''
}
${
  wv.pendingExecution != null
    ? `待处决：#${wv.pendingExecution + 1}`
    : ''
}

请决定你当前的行动。考虑你的阵营目标和当前局面。`;

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
  const alive = aliveSeats.filter(s => s !== seatIndex).map(s => `#${s + 1}`).join(', ');

  const systemPrompt = `你是血染钟楼玩家 #${seatIndex + 1}。
${getStyleGuidance(style, alignment)}
你的角色：${role.characterNameZh}（${role.characterName}）
角色能力：${role.abilityZh}
${memory.summary}

现在轮到你在夜晚行动：${role.characterNameZh}
你需要选择 ${pickCount} 名存活玩家。

输出格式（严格 JSON）：
{
  "targets": [seatIndex, ...],  // 选中玩家的 seatIndex 数组
  "reasoning": "你的选择理由"
}`;

  const userPrompt = `夜晚行动：${role.characterNameZh}
你可以选择的存活玩家（除自己外）：${alive}
请选择 ${pickCount} 名玩家。`;

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
  const recentLogs = wv.publicLog.slice(-10).map(l => l.line).join('\n');
  const recentDeaths = wv.lastNightDeaths.length > 0
    ? `昨夜死亡：${wv.lastNightDeaths.map(s => `#${s + 1}`).join('、')}`
    : '昨夜无人死亡';
  const aliveList = wv.players.filter(p => p.isAlive).map(p => `#${p.seatIndex + 1}`).join(', ');

  const systemPrompt = `你是血染钟楼玩家 #${seatIndex + 1}。
${getStyleGuidance(style, alignment)}
你的角色：${role.characterNameZh}（${role.characterName}）

重要：血染钟楼中，白天必须有人被处决！如果没有提名，邪恶阵营会自动占据优势。
你应该基于已有信息积极提名可疑玩家，哪怕信息不完全。善良阵营不提名就等于放弃胜利机会。

需要考虑的因素：
- 角色信息（你的角色能力给出的线索）
- 公开发言（谁在撒谎？谁的信息矛盾？）
- 投票记录（谁反对处决可能是同伙）
- 死者身份（被恶魔杀死的通常是善良阵营）
- 存活玩家中必须有恶魔和爪牙

输出格式（严格 JSON）：
{
  "shouldSkip": true/false,
  "nominatedSeat": 目标 seatIndex（优先选择最可疑的存活玩家，必须给出）,
  "reasoning": "你的决策理由"
}`;

  const alreadyNominated = wv.nominationsToday.map(n => `#${n.nominator + 1}→#${n.nominated + 1}`).join(', ');
  const notYetDecided = wv.players
    .filter(p => p.isAlive && !wv.nominationsToday.some(n => n.nominator === p.seatIndex) && !wv.skippedNominationsToday.includes(p.seatIndex))
    .map(p => `#${p.seatIndex + 1}`)
    .join(', ');

  const userPrompt = `=== 提名阶段 ===
${recentDeaths}
存活玩家：${aliveList}
已提名：${alreadyNominated || '暂无'}
尚未提名/跳过：${notYetDecided || '全部已处理'}
${wv.currentNomination ? `当前提名：#${wv.currentNomination.nominator + 1} → #${wv.currentNomination.nominated + 1}` : '当前无提名'}
${wv.pendingExecution != null ? `待处决：#${wv.pendingExecution + 1}` : ''}

最近公开发言：
${recentLogs || '(暂时无发言)'}

基于以上信息，你最怀疑哪个存活玩家？请提名一个人（或跳过）。不要永远跳过——如果你怀疑有人，就应该提名！`;

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
  const systemPrompt = `你是血染钟楼玩家 #${seatIndex + 1}。
${getStyleGuidance(style, alignment)}
你的角色：${role.characterNameZh}（${role.characterName}）

你需要对当前提名投票。记住：
- 善良阵营：如果你认为被提名者可能是恶魔或爪牙，投赞成处决
- 邪恶阵营：如果被提名者是同伴，投反对；如果是善良阵营，投赞成
- 如果完全不确定，可以随机投票

输出格式（严格 JSON）：
{
  "inFavor": true/false,
  "reasoning": "你的投票理由"
}`;

  const aliveCount = wv.players.filter(p => p.isAlive).length;
  const userPrompt = `投票决定：#${nomination.nominator + 1} 提名处决 #${nomination.nominated + 1}
存活人数：${aliveCount}
你投赞成（处决 #${nomination.nominated + 1}）还是反对（放过）？`;

  return { systemPrompt, userPrompt };
}
