import type { Room } from '../game/types.js';
import { acquireLlmSlot } from './llmLimiter.js';

import type { AiPlayerAction, AiPlayerContext, AiPlayerDayPlan, AiPlayerDebugEvent } from './playerAgent.js';

type RoleMsg = { role: 'system' | 'user' | 'assistant'; content: string };

type AiPromptStyle = 'balanced' | 'assertive' | 'deceptive' | 'chaotic';

type SeenKey = string;

interface SeatBelief {
  /** 越高越可疑（0~1） */
  suspicion: number;
  /** 越高越可信（0~1） */
  trust: number;
  /** 轻量标签（仅用于提示词摘要，不作强逻辑） */
  tags: string[];
}

interface SeatAgentState {
  /** 该座位可见的“事件时间线”（裁剪存储） */
  timeline: Array<{ at: number; line: string }>;
  /** 去重集合：避免同一条 chat/vote 反复进入时间线 */
  seen: Set<SeenKey>;
  /** 最近一次构造出的记忆摘要（短文本，给模型用） */
  memorySummary: string;
  /** 仅内部信念：对各座位的嫌疑/信任（极简版本，后续可替换为更强的 world model） */
  beliefBySeat: Map<number, SeatBelief>;
  /** 私聊收件箱：fromSeat -> 最近一条收到的私聊 */
  dmInboxBySeat: Map<number, { at: number; fromSeat: number; text: string }>;
  /** 私聊已回复时间：对每个 fromSeat 的最近一次回复时间（用于判断“未回复”） */
  dmLastRepliedAtBySeat: Map<number, number>;
  /** 最近一次观测到的 voteSnapshot（用于“票型在我心中”的持久化） */
  lastVoteSnapshot?: AiPlayerContext['voteSnapshot'];
  /** 最近一次观测到的 nominationsToday（便于白天自洽） */
  lastNominationsToday?: Array<{ nominator: number; nominated: number }>;
  /** 最近一次观测到的 skippedNominationsToday */
  lastSkippedNominationsToday?: number[];
}

function fastResponseOptions() {
  return {
    stream: false,
    enable_thinking: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status === 409 || status === 425 || (status >= 500 && status <= 599);
}

function computeBackoffMs(attemptIndex: number): number {
  const base = 450;
  const cap = 5000;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attemptIndex));
  const jitter = Math.floor(Math.random() * 220);
  return Math.min(cap, exp + jitter);
}

function normalizePromptStyle(raw: unknown): AiPromptStyle {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'assertive') return 'assertive';
  if (s === 'deceptive') return 'deceptive';
  if (s === 'chaotic') return 'chaotic';
  return 'balanced';
}

function getPromptStyleGuidance(style: AiPromptStyle, alignment: 'good' | 'evil' | undefined): string {
  if (style === 'assertive') {
    return alignment === 'good'
      ? '风格=assertive：更积极推进提名与处决共识，减少空转与长期观望。'
      : '风格=assertive：更积极主导讨论节奏，推动对己方有利的提名与票型。';
  }
  if (style === 'deceptive') {
    return alignment === 'good'
      ? '风格=deceptive：可适度保留信息与试探，但避免无意义误导己方。'
      : '风格=deceptive：优先维持伪装一致性，通过话术与票型制造信息噪音。';
  }
  if (style === 'chaotic') {
    return '风格=chaotic：允许非常规策略与反常规节奏，但行动必须自洽且不违反规则。';
  }
  return '风格=balanced：在信息价值、风险和节奏之间取平衡，不盲动也不长期保守。';
}

function buildSystemPromptModules(params: {
  stage: 'day_plan' | 'night_action' | 'single_action';
  styleGuidance?: string;
  pick?: 1 | 2;
  extraConstraints?: string[];
}): string {
  const identity = [
    '你是《血染钟楼（暗流涌动）》中的单座位 AI 玩家。',
    '你只代表自己的座位，不是上帝，不是裁判，不可修改游戏状态。',
    '核心目标：在“当前阶段合法动作”内，提高己方阵营胜率，同时保持发言与行动自洽。',
    '胜利条件：善良=恶魔死亡；邪恶=存活玩家<=2且善良未先胜。',
    '你只能使用当前局内输入，不得使用跨局长期记忆或臆测隐藏信息。',
  ];

  const comms = [
    '沟通要求（很重要）：公聊/私聊要“可被说服”。给出 1~3 条可核验理由（引用公开发言、投票、存活变化、你自己的夜间信息）。',
    '避免命令式拉票（例如“都听我”“无脑投我”）。更像真人：表达不确定性、邀请对方补充信息、允许对方反驳。',
    '私聊建议：先问对方信息/立场，再给出你的推断与合作提议；不要直接要求对方服从。',
    '差异化表达（很重要）：同一句式不要反复出现。请根据 voiceProfile 调整语气、长度与开场方式（谨慎型/质询型/条理型/幽默型/情绪化/冷静型）。',
  ];

  const safety = [
    '严格遵守游戏信息边界：不要暗示你知道未提供的信息。',
    'demonBluffs 是私有伪装参考，不应公开成“信息来源”。',
    '策略建议：开局阶段（尤其 Day1）公开自曝恶魔/爪牙通常是低收益；只有在明确高收益场景才考虑反向自曝/替挡刀。',
  ];

  const output = ['请输出可执行 JSON（不需要解释文本和 markdown）。'];

  const stageConstraint =
    params.stage === 'night_action'
      ? [
        '你当前只允许做一件事：输出 night_action 目标选择。',
        '仅输出 JSON：{"type":"night_action","targets":[...]}。',
        `targets 数量必须等于 ${params.pick ?? 1}，且都在 nightPrompt.aliveSeatIndices 内。`,
        '当 pick=2 时，两个目标必须不同。',
        '禁止输出聊天、提名、投票、night_confirm、noop 或其他 type。',
      ]
      : params.stage === 'single_action'
        ? [
          '你要做的事：理解自己获得的信息，与他人交流（公开/私聊/上帝），并在允许时提名、投票、使用白天能力。',
          '注意：夜晚选目标仅通过专用流程处理；此处不要输出 night_action / night_confirm。',
          '只输出 JSON（不要解释）。',
        ]
        : [
          '白天计划应尽量保持人设与立场一致，可渐进调整。',
          '邪恶阵营可使用 demonBluffs 维持伪装一致性，但不可自相矛盾。',
          '若你是有信息的好人且已有夜间信息，默认应更主动推进：公开关键矛盾、推动提名、推动形成处决共识。',
        ];

  return [
    ...identity,
    ...comms,
    ...safety,
    ...(params.styleGuidance ? [params.styleGuidance] : []),
    ...stageConstraint,
    ...((params.extraConstraints ?? []).filter(Boolean)),
    ...output,
  ].join('\n');
}

function formatHttpNotOk(status: number, body: string): string {
  const b = String(body ?? '').replace(/\s+/g, ' ').trim();
  return `http_${status}${b ? ` body="${b.slice(0, 600)}"` : ''}`;
}

function formatThrownError(e: unknown, timeoutMs?: number): string {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'AbortError') return `timeout_after_${timeoutMs ?? 'unknown'}ms`;
  return msg || 'unknown_error';
}

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function heuristicSummary(previousSummary: string, recentLines: string[], maxChars: number): string {
  const prev = String(previousSummary ?? '').trim();
  const tail = recentLines.map((x) => String(x).trim()).filter(Boolean).slice(-18);
  const merged = [
    prev ? `【已有认知】${prev}` : '',
    tail.length > 0 ? `【近期事件】${tail.join(' || ')}` : '【近期事件】暂无',
    '【行动建议】围绕公开矛盾与票型推进可执行目标，避免长期空转。',
  ].filter(Boolean).join('\n');
  return merged.slice(0, Math.max(200, maxChars));
}

function seatBeliefInit(): SeatBelief {
  return { suspicion: 0.5, trust: 0.5, tags: [] };
}

function normalizeLine(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function makeSeenKey(parts: Array<string | number | null | undefined>): SeenKey {
  return parts.map((x) => String(x ?? '')).join('|');
}

function extractSeatRefs(text: string): number[] {
  const s = String(text ?? '');
  const out = new Set<number>();
  // 形如：#3、#12
  for (const m of s.matchAll(/#\s*(\d{1,2})/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 20) out.add(n - 1);
  }
  // 形如：3号、12号
  for (const m of s.matchAll(/(\d{1,2})\s*号/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 20) out.add(n - 1);
  }
  return Array.from(out.values()).slice(0, 6);
}

function pushTagUnique(tags: string[], tag: string): void {
  if (!tag) return;
  if (!tags.includes(tag)) tags.push(tag);
}

/**
 * 每个座位一个实例：线程、偏好、缓存都在实例内部，不与其他 seat 共享。
 * 注意：实例本身仍绑定在同一个 Node 进程内；“彼此独立”的含义是状态与上下文隔离。
 */
export class PlayerSeatAgent {
  private readonly seatIndex: number;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly aiLog: boolean;
  private readonly useEnabled: boolean;

  private threadByStage: Record<'day_plan' | 'night_action' | 'single_action', RoleMsg[]> = {
    day_plan: [],
    night_action: [],
    single_action: [],
  };

  private state: SeatAgentState = {
    timeline: [],
    seen: new Set(),
    memorySummary: '',
    beliefBySeat: new Map(),
    dmInboxBySeat: new Map(),
    dmLastRepliedAtBySeat: new Map(),
  };

  constructor(params: {
    seatIndex: number;
    apiKey: string;
    baseUrl: string;
    model: string;
    enabled: boolean;
    aiLog: boolean;
  }) {
    this.seatIndex = params.seatIndex;
    this.apiKey = params.apiKey;
    this.baseUrl = params.baseUrl.replace(/\/+$/, '');
    this.model = params.model;
    this.aiLog = params.aiLog;
    this.useEnabled = params.enabled;
  }

  /**
   * 增量吸收：把本次 ctx 里“该座位可见的信息”写入 agent 的私有 state。
   * 目标：让 agent 像真人一样“心里有秤”，后续提示词只用摘要/尾部关键事件，而非整包日志。
   */
  private ingestFromContext(ctx: AiPlayerContext): void {
    const now = Date.now();

    // 1) 吸收可见聊天（只用 ctx.chatLog；不吃 allChatLog，避免越权全知）
    const chat = Array.isArray(ctx.chatLog) ? ctx.chatLog : [];
    for (const e of chat) {
      const scope = String((e as any).scope ?? '');
      const fromSeat = Number((e as any).fromSeat);
      const toSeat = (e as any).toSeat;
      const at = Number((e as any).at ?? now);
      const text = normalizeLine(String((e as any).text ?? '').slice(0, 500));
      if (!Number.isInteger(fromSeat) || !text) continue;

      const key = makeSeenKey(['chat', scope, fromSeat, typeof toSeat === 'number' ? toSeat : '', at, text]);
      if (this.state.seen.has(key)) continue;
      this.state.seen.add(key);

      const label =
        scope === 'dm'
          ? `私聊 #${fromSeat + 1}${typeof toSeat === 'number' ? `->#${toSeat + 1}` : ''}`
          : scope === 'god'
            ? `上帝问答 #${fromSeat + 1}`
            : `公开发言 #${fromSeat + 1}`;
      this.state.timeline.push({ at, line: `${label}：${text.slice(0, 140)}` });

      // 私聊线程：记录“我收到的 DM”以及“我给谁回过”
      if (scope === 'dm') {
        const to = typeof toSeat === 'number' ? Number(toSeat) : null;
        // 收到：对方 -> 我
        if (to === this.seatIndex && fromSeat !== this.seatIndex) {
          const prev = this.state.dmInboxBySeat.get(fromSeat);
          if (!prev || at >= prev.at) {
            this.state.dmInboxBySeat.set(fromSeat, { at, fromSeat, text: text.slice(0, 220) });
          }
        }
        // 发出：我 -> 对方（视为“我已回复/触达该座位”）
        if (fromSeat === this.seatIndex && typeof toSeat === 'number' && Number.isInteger(toSeat)) {
          this.state.dmLastRepliedAtBySeat.set(Number(toSeat), Math.max(at, this.state.dmLastRepliedAtBySeat.get(Number(toSeat)) ?? 0));
        }
      }

      // 轻量“立场信号”抽取：从公开/私聊文本里提取对某些座位的怀疑/信任倾向
      // 说明：这不是严格推理，只是把“我观察到谁在怀疑谁/站边谁”记账，供后续策略层与话术层参考。
      const refs = extractSeatRefs(text);
      if (refs.length > 0) {
        const lower = text.toLowerCase();
        const isSuspiciousCue = /怀疑|可疑|像恶|是恶|狼|刀|爪牙|恶魔|假|不信|有问题|矛盾/.test(text) || /(evil|demon|minion|sus)/i.test(lower);
        const isTrustCue = /像好|是好|可信|相信|互保|站边|同意|支持|帮我|合作/.test(text) || /(good|trust|clear)/i.test(lower);
        for (const seatRef of refs) {
          if (!Number.isInteger(seatRef) || seatRef < 0) continue;
          const b = this.state.beliefBySeat.get(seatRef) ?? seatBeliefInit();
          if (isSuspiciousCue && !isTrustCue) {
            b.suspicion = clamp01(b.suspicion + 0.06);
            b.trust = clamp01(b.trust - 0.03);
            pushTagUnique(b.tags, '被点名可疑');
          } else if (isTrustCue && !isSuspiciousCue) {
            b.trust = clamp01(b.trust + 0.06);
            b.suspicion = clamp01(b.suspicion - 0.03);
            pushTagUnique(b.tags, '被点名像好');
          }
          this.state.beliefBySeat.set(seatRef, b);
        }
      }
    }

    // 2) 吸收夜间信息（仅自己的 nightInfo 文本）
    const nightInfo = Array.isArray(ctx.nightInfo) ? ctx.nightInfo : [];
    for (const x of nightInfo) {
      const text = normalizeLine(String(x ?? '').slice(0, 260));
      if (!text) continue;
      const key = makeSeenKey(['night_info', this.seatIndex, text]);
      if (this.state.seen.has(key)) continue;
      this.state.seen.add(key);
      this.state.timeline.push({ at: now, line: `夜间信息（我）：${text}` });
    }

    // 3) 吸收投票/提名快照与近期回放（作为“我心中票型”）
    if (ctx.voteSnapshot) {
      this.state.lastVoteSnapshot = ctx.voteSnapshot;
      this.state.lastNominationsToday = ctx.voteSnapshot.nominationsToday ?? [];
      this.state.lastSkippedNominationsToday = ctx.voteSnapshot.skippedNominationsToday ?? [];

      // 投票行为入时间线（仅记录，不做“投赞成=可疑”的粗暴推断）
      const votes = Array.isArray(ctx.voteSnapshot.votes) ? ctx.voteSnapshot.votes : [];
      for (const v of votes) {
        const s = Number((v as any).seatIndex);
        const inFavor = !!(v as any).inFavor;
        if (!Number.isInteger(s)) continue;
        const key = makeSeenKey([
          'vote',
          ctx.voteSnapshot.currentNomination?.nominator ?? '',
          ctx.voteSnapshot.currentNomination?.nominated ?? '',
          s,
          inFavor ? 1 : 0,
        ]);
        if (this.state.seen.has(key)) continue;
        this.state.seen.add(key);
        this.state.timeline.push({ at: now, line: `投票：#${s + 1} ${inFavor ? '赞成' : '反对'}` });
        const b = this.state.beliefBySeat.get(s) ?? seatBeliefInit();
        pushTagUnique(b.tags, inFavor ? '曾投赞成' : '曾投反对');
        this.state.beliefBySeat.set(s, b);
      }
    }
    const recentVoteEvents = Array.isArray(ctx.recentVoteEvents) ? ctx.recentVoteEvents : [];
    for (const lineRaw of recentVoteEvents.slice(-24)) {
      const line = normalizeLine(String(lineRaw ?? '').slice(0, 240));
      if (!line) continue;
      const key = makeSeenKey(['vote_event', this.seatIndex, line]);
      if (this.state.seen.has(key)) continue;
      this.state.seen.add(key);
      this.state.timeline.push({ at: now, line: `票型回放：${line}` });
    }

    // 4) 裁剪 timeline，避免无上限增长
    this.state.timeline.sort((a, b) => a.at - b.at);
    if (this.state.timeline.length > 420) this.state.timeline = this.state.timeline.slice(-420);

    // 5) 极简信念更新（先把“记账”从 LLM 拿出来；后续可扩展规则）
    //    当前策略：只根据“被提名/提名人”做轻量标签，不做强推理，避免误导。
    const nominations = this.state.lastNominationsToday ?? [];
    for (const n of nominations.slice(-12)) {
      const nominator = (n as any).nominator;
      const nominated = (n as any).nominated;
      if (!Number.isInteger(nominator) || !Number.isInteger(nominated)) continue;
      const b1 = this.state.beliefBySeat.get(nominator) ?? seatBeliefInit();
      const b2 = this.state.beliefBySeat.get(nominated) ?? seatBeliefInit();
      pushTagUnique(b1.tags, '今日提名过人');
      pushTagUnique(b2.tags, '今日被提名');
      this.state.beliefBySeat.set(nominator, b1);
      this.state.beliefBySeat.set(nominated, b2);
    }

    // 6) 生成/更新记忆摘要（本地启发式；不依赖额外 LLM 调用）
    const recentLines = this.state.timeline.slice(-30).map((x) => x.line);
    this.state.memorySummary = heuristicSummary(this.state.memorySummary, recentLines, 1200);

    // 7) 微调：若 playerMemory（外部）存在，优先把它吸收成“已有认知”
    //    这样即使 agent 初次创建，也不会完全失忆。
    const external = normalizeLine(String(ctx.playerMemory ?? '').slice(0, 1400));
    if (external) {
      // 仅在内部摘要为空或明显更短时融合，避免每次重复覆盖
      if (!this.state.memorySummary || this.state.memorySummary.length < 240) {
        this.state.memorySummary = heuristicSummary(external, recentLines, 1200);
      }
    }
  }

  private buildCompressedContext(ctx: AiPlayerContext): unknown {
    const tail = this.state.timeline.slice(-18).map((x) => x.line);
    const alive = (this.state.lastVoteSnapshot?.aliveSeatIndices ?? []).slice(0, 20);
    const dead = (this.state.lastVoteSnapshot?.deadSeatIndices ?? []).slice(0, 20);

    // 取 3 个“最需要关注”的座位：优先被提名/提名过人（仅标签层面）
    const focusSeats = Array.from(this.state.beliefBySeat.entries())
      .map(([seat, b]) => ({ seat, b }))
      .filter(({ seat }) => seat !== this.seatIndex)
      .filter(({ b }) => (b.tags?.length ?? 0) > 0)
      .slice(0, 6)
      .map(({ seat, b }) => ({ seat, suspicion: clamp01(b.suspicion), trust: clamp01(b.trust), tags: (b.tags ?? []).slice(0, 3) }));

    const dmInbox = Array.from(this.state.dmInboxBySeat.entries())
      .map(([fromSeat, msg]) => {
        const repliedAt = this.state.dmLastRepliedAtBySeat.get(fromSeat) ?? 0;
        const needsReply = msg.at > repliedAt;
        return { fromSeat, at: msg.at, text: msg.text, needsReply };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 4);

    return {
      roomView: ctx.roomView,
      yourSeatIndex: ctx.yourSeatIndex,
      yourRole: ctx.yourRole,
      yourCharacterId: ctx.yourCharacterId,
      yourAlignment: ctx.yourAlignment,
      voiceProfile: ctx.voiceProfile,
      promptStyle: ctx.promptStyle,
      demonBluffs: ctx.demonBluffs,
      nightPrompt: ctx.nightPrompt,
      currentNomination: ctx.currentNomination,
      voteSnapshot: ctx.voteSnapshot,
      // 核心变化：不再喂全量 chatLog，而是喂“私有摘要 + 尾部关键事件”
      playerMemory: String(this.state.memorySummary ?? '').slice(0, 900),
      recentVisibleEvents: tail.map((x) => String(x).slice(0, 180)),
      focusSeats,
      dmInbox,
      aliveSeatIndices: alive,
      deadSeatIndices: dead,
      myNightInfo: (Array.isArray(ctx.nightInfo) ? ctx.nightInfo : []).slice(-8),
    };
  }

  private clampMaxTokens(raw: number | undefined): number | undefined {
    if (!Number.isFinite(raw)) return undefined;
    const n = Math.floor(Number(raw));
    if (n <= 0) return undefined;
    // 给兼容模型留余地，但也避免离谱的大输出
    return Math.max(24, Math.min(1200, n));
  }

  private async callJsonMode(params: {
    stage: 'day_plan' | 'night_action' | 'single_action';
    debugStage?: 'day_plan' | 'day_dialogue' | 'night_action';
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    timeoutMs: number;
    maxAttempts: number;
    maxTokens?: number;
    onDebug?: (e: AiPlayerDebugEvent) => void;
    pick?: 1 | 2;
  }): Promise<{ content: string | null; err?: string }> {
    const startedAt = Date.now();
    const thread = this.threadByStage[params.stage];
    const messages: RoleMsg[] = [
      { role: 'system', content: params.systemPrompt },
      ...thread.slice(-6),
      { role: 'user', content: params.userPrompt },
    ];

    const debugStage: AiPlayerDebugEvent['stage'] =
      params.debugStage
      ?? (params.stage === 'night_action' ? 'night_action' : 'day_plan');

    params.onDebug?.({
      stage: debugStage,
      kind: 'request',
      seatIndex: this.seatIndex,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      messages,
    });

    let lastNotOk: { status: number; body: string; attempt: number; queueWaitMs: number } | null = null;
    let data: { choices?: Array<{ message?: { content?: string } }> } | null = null;

    for (let attempt = 1; attempt <= params.maxAttempts; attempt++) {
      const slot = await acquireLlmSlot();
      const queueWaitMs = slot.waitMs;
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), params.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages,
            response_format: { type: 'json_object' },
            temperature: Math.min(1, Math.max(0, params.temperature)),
            // 关键：从请求层面限制输出 tokens，保证响应更快更稳定
            ...(this.clampMaxTokens(params.maxTokens) ? { max_tokens: this.clampMaxTokens(params.maxTokens) } : {}),
            ...fastResponseOptions(),
          }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          lastNotOk = { status: res.status, body: t, attempt, queueWaitMs };
          if (attempt < params.maxAttempts && isRetryableStatus(res.status)) {
            await sleep(computeBackoffMs(attempt - 1));
            continue;
          }
          break;
        }
        data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        break;
      } finally {
        clearTimeout(timeout);
        slot.release();
      }
    }

    if (!data) {
      const msg = lastNotOk
        ? `${formatHttpNotOk(lastNotOk.status, lastNotOk.body)} attempt=${lastNotOk.attempt}/${params.maxAttempts} queueWaitMs=${lastNotOk.queueWaitMs}`
        : `llm_no_response attempt=0/${params.maxAttempts}`;
      params.onDebug?.({
        stage: debugStage,
        kind: 'error',
        seatIndex: this.seatIndex,
        elapsedMs: Date.now() - startedAt,
        error: msg,
      });
      return { content: null, err: msg };
    }

    const content = data.choices?.[0]?.message?.content ?? null;
    if (!content) return { content: null, err: 'empty_response' };

    params.onDebug?.({
      stage: debugStage,
      kind: 'response',
      seatIndex: this.seatIndex,
      rawResponse: content,
      elapsedMs: Date.now() - startedAt,
    });

    // 线程隔离：只把本 stage 的对话写回本实例的 thread
    thread.push({ role: 'user', content: params.userPrompt });
    thread.push({ role: 'assistant', content });
    this.threadByStage[params.stage] = thread.slice(-12);

    return { content };
  }

  /**
   * 白天：产出 day_plan（包含 dm/public/nomination/vote），提示词由模块拼装。
   * 具体 JSON 校验与兜底仍在外层 `playerAgent.ts` 里做（保持行为一致）。
   */
  async decideDayPlan(
    ctx: AiPlayerContext,
    temperature: number,
    onDebug?: (e: AiPlayerDebugEvent) => void,
  ): Promise<{ systemPrompt: string; userPrompt: string; raw: unknown | null; err?: string }> {
    if (!this.apiKey || !this.useEnabled) return { systemPrompt: '', userPrompt: '', raw: null, err: 'disabled' };

    this.ingestFromContext(ctx);
    const promptStyle = normalizePromptStyle(ctx.promptStyle);
    const systemPrompt = buildSystemPromptModules({
      stage: 'day_plan',
      styleGuidance: getPromptStyleGuidance(promptStyle, ctx.yourAlignment),
    });
    const userPrompt = JSON.stringify({
      instruction: '现在是白天，请输出 day_plan：先私聊(0~2条)→公开发言(1条)→提名倾向→投票倾向。优先基于 playerMemory 决策，原始日志只做补充验证。',
      promptStyle,
      outputSchema: {
        type: 'day_plan|noop',
        godQuestion: { text: 'string(optional)' },
        dm: [{ toSeat: 'number', text: 'string' }],
        public: { text: 'string' },
        nomination: { type: 'nominate|skip', targetSeat: 'number(if nominate)' },
        vote: { inFavor: 'boolean', reason: 'string(optional)', priorityExecuteSeats: 'number[](optional, 1~3)' },
      },
      outputRules: [
        '重要：输出必须是“顶层对象”，禁止包一层 {day_plan:{...}} 或 {noop:{...}}。',
        '必须包含顶层字段 type，且 type 只能是 "day_plan" 或 "noop"。',
        'dm 用于私聊策略：按需给出若干 {toSeat,text}。只给“你确实想沟通”的对象；没必要沟通的人可不写。',
        '同一个 toSeat 最多提供一条核心私聊内容，文本简短具体（建议包含：一个问题 + 一个推断/理由 + 一个合作提议）。',
        '为匹配当前引擎编排，请给出 1 条 public（可简短保守）。',
        'public 建议结构：1) 你观察到的事实（含你自己的夜间信息，若愿意公开） 2) 你的推断（谁更可疑/为什么） 3) 你希望大家做的下一步（提名/反问/对票型的建议）。',
        '发言差异化：尽量不要和其他玩家用同样开头（如“我建议大家…”），可以用“我担心/我注意到/我想确认/我有个疑问/我先给出两点理由/先抛一个假设”等多样表达。',
        'nominate 时 targetSeat 需是合法存活座位；否则选择 skip。',
        'vote 需给出 priorityExecuteSeats（1~3个优先出人目标）；投票时应优先按该名单决定是否赞成处决。',
        '若你是邪恶阵营：白天早期 public 发言一般不建议自曝恶魔/爪牙，也不建议公开三张不在场角色来源。',
        '若你是有信息的好人且已有夜间信息：nomination 默认倾向 nominate，而不是长期 skip。',
        '只输出 JSON。',
      ],
      context: this.buildCompressedContext(ctx),
    });

    const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 240_000;
    const maxAttempts = Math.max(1, Math.min(4, Number(process.env.AI_LLM_MAX_RETRIES ?? '') || 3));
    // day_plan 需要包含 dm/public/nomination/vote：给足但仍有限制
    const maxTokens = Number(process.env.AI_PLAYER_DAYPLAN_MAX_TOKENS ?? '') || 520;
    const r = await this.callJsonMode({
      stage: 'day_plan',
      systemPrompt,
      userPrompt,
      temperature,
      timeoutMs,
      maxAttempts,
      maxTokens,
      onDebug,
    });
    return { systemPrompt, userPrompt, raw: r.content ? safeJsonParse(r.content) : null, err: r.err };
  }

  /**
   * 夜晚：仅选择 targets。输出校验与合法性检查在外层做。
   */
  async decideNightTargets(
    ctx: AiPlayerContext,
    temperature: number,
    onDebug?: (e: AiPlayerDebugEvent) => void,
  ): Promise<{ systemPrompt: string; userPrompt: string; raw: unknown | null; err?: string }> {
    if (!this.apiKey || !this.useEnabled) return { systemPrompt: '', userPrompt: '', raw: null, err: 'disabled' };
    if (!ctx.nightPrompt) return { systemPrompt: '', userPrompt: '', raw: null, err: 'no_night_prompt' };

    this.ingestFromContext(ctx);
    const pick = ctx.nightPrompt.pick;
    const systemPrompt = buildSystemPromptModules({ stage: 'night_action', pick });
    const userPrompt = JSON.stringify({
      instruction: `当前夜晚步骤：${ctx.nightPrompt.stepId}。请选择能力目标。`,
      outputSchema: { night_action: { type: 'night_action', targets: `number[${pick}]` } },
      nightPrompt: ctx.nightPrompt,
      context: this.buildCompressedContext(ctx),
    });

    const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 240_000;
    const maxAttempts = Math.max(1, Math.min(4, Number(process.env.AI_LLM_MAX_RETRIES ?? '') || 3));
    // 夜晚只要 targets：极小输出即可
    const maxTokens = Number(process.env.AI_PLAYER_NIGHT_MAX_TOKENS ?? '') || 80;
    const r = await this.callJsonMode({
      stage: 'night_action',
      systemPrompt,
      userPrompt,
      temperature,
      timeoutMs,
      maxAttempts,
      maxTokens,
      onDebug,
      pick,
    });
    return { systemPrompt, userPrompt, raw: r.content ? safeJsonParse(r.content) : null, err: r.err };
  }

  /**
   * 单动作：保留旧入口的行为（用于非结构化流程/调试），同样走模块化系统提示词。
   */
  async decideSingleAction(
    ctx: AiPlayerContext,
    temperature: number,
  ): Promise<{ systemPrompt: string; userPrompt: string; raw: unknown | null; err?: string }> {
    if (!this.apiKey || !this.useEnabled) return { systemPrompt: '', userPrompt: '', raw: null, err: 'disabled' };

    this.ingestFromContext(ctx);
    const systemPrompt = buildSystemPromptModules({ stage: 'single_action' });
    const userPrompt = JSON.stringify({
      instruction: '根据上下文选择下一步“单个动作”。如果没必要动作，输出 {"type":"noop"}。',
      allowedActions: ['noop', 'chat_public', 'chat_dm', 'chat_god', 'nominate', 'skip_nomination', 'vote', 'day_action'],
      context: this.buildCompressedContext(ctx),
      outputSchema: {
        chat_public: { type: 'chat_public', text: 'string' },
        chat_dm: { type: 'chat_dm', toSeat: 'number', text: 'string' },
        chat_god: { type: 'chat_god', text: 'string' },
        nominate: { type: 'nominate', nominatedSeat: 'number' },
        skip_nomination: { type: 'skip_nomination' },
        vote: { type: 'vote', inFavor: 'boolean' },
        day_action: { type: 'day_action', actionId: 'string', targetSeat: 'number(optional)' },
        noop: { type: 'noop' },
      },
    });

    const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 180_000;
    const maxAttempts = 1;
    const maxTokens = Number(process.env.AI_PLAYER_SINGLE_ACTION_MAX_TOKENS ?? '') || 180;
    const r = await this.callJsonMode({
      stage: 'single_action',
      systemPrompt,
      userPrompt,
      temperature,
      timeoutMs,
      maxAttempts,
      maxTokens,
    });
    return { systemPrompt, userPrompt, raw: r.content ? safeJsonParse(r.content) : null, err: r.err };
  }

  /**
   * 受限动作：用于白天结构化阶段的“微决策”（上帝问答/私聊/公聊），允许多次调用但强约束 action 类型。
   * 注意：这里只做提示词约束；外层仍应二次校验 action.type 是否在 allowedActions 内。
   */
  async decideConstrainedAction(params: {
    ctx: AiPlayerContext;
    temperature: number;
    allowedActions: Array<'noop' | 'chat_public' | 'chat_dm' | 'chat_god'>;
    instruction: string;
    outputSchema: Record<string, unknown>;
    stageHint: 'god_dialogue' | 'private_dialogue' | 'public_speech';
  }, onDebug?: (e: AiPlayerDebugEvent) => void): Promise<{ systemPrompt: string; userPrompt: string; raw: unknown | null; err?: string }> {
    if (!this.apiKey || !this.useEnabled) return { systemPrompt: '', userPrompt: '', raw: null, err: 'disabled' };
    this.ingestFromContext(params.ctx);

    const allowed = params.allowedActions;
    const extraConstraints: string[] = [
      `你当前阶段=${params.stageHint}。你只能输出 allowedActions 之一：${allowed.join(',')}。`,
      '若不确定或没有必要行动，输出 {"type":"noop"}。',
      allowed.includes('chat_public') ? '若输出 chat_public：只说一条简短可被回应的话（<=200字），避免长篇总结。' : '',
      allowed.includes('chat_dm') ? '若输出 chat_dm：只私聊一个对象，内容包含一个问题或试探点（<=200字）。' : '',
      allowed.includes('chat_god') ? '若输出 chat_god：只问一个具体问题（<=80字），不要要求上帝透露规则外信息。' : '',
      params.stageHint === 'private_dialogue'
        ? '私聊策略提示：优先回复 dmInbox 中 needsReply=true 的最新一条私聊（若存在），更像真人互动。若都已回复，可选择你最需要试探/交换信息的对象。'
        : '',
      '真实性约束（很重要）：不要声称“我是某具体角色/昨晚得知某信息/我查验了谁”等具体断言，除非这些断言与 context.yourCharacterId 或 context.myNightInfo 明确一致；否则请用提问/试探/不确定表述替代（例如“我倾向…但不确定”“我想确认…”）。',
      '禁止输出 nominate/vote/day_action/night_action/night_confirm/skip_nomination 等其他 type。',
    ].filter(Boolean);

    const systemPrompt = buildSystemPromptModules({ stage: 'single_action', extraConstraints });
    const userPrompt = JSON.stringify({
      instruction: params.instruction,
      allowedActions: allowed,
      context: this.buildCompressedContext(params.ctx),
      outputSchema: params.outputSchema,
    });

    const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 60_000;
    const maxAttempts = 1;
    // 白天微决策（问一句/私聊一句/公聊一句）：严格控字数与 tokens，优先速度
    const maxTokens = Number(process.env.AI_PLAYER_DIALOGUE_MAX_TOKENS ?? '') || 120;
    const r = await this.callJsonMode({
      stage: 'single_action',
      debugStage: 'day_dialogue',
      systemPrompt,
      userPrompt,
      temperature: params.temperature,
      timeoutMs,
      maxAttempts,
      maxTokens,
      onDebug,
    });
    return { systemPrompt, userPrompt, raw: r.content ? safeJsonParse(r.content) : null, err: r.err };
  }

  clearThreads(): void {
    this.threadByStage = { day_plan: [], night_action: [], single_action: [] };
  }
}

export function getOrCreateSeatAgent(room: Room, seatIndex: number, create: () => PlayerSeatAgent): PlayerSeatAgent {
  const key = `ai_player_agent_v1_${seatIndex}`;
  const v = room.storytellerDecisions.get(key);
  if (v instanceof PlayerSeatAgent) return v as PlayerSeatAgent;
  const a = create();
  room.storytellerDecisions.set(key, a);
  return a;
}

