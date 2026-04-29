import type { Room } from '../game/types.js';
import { acquireLlmSlot } from './llmLimiter.js';
import { getOrCreateSeatAgent, PlayerSeatAgent } from './playerSeatAgent.js';

// AI 玩家与 AI 说书人解耦：仅由 USE_AI_PLAYER 控制；默认开启（除非显式设为 false/0）
const USE_AI_PLAYER_RAW = (process.env.USE_AI_PLAYER ?? '').trim().toLowerCase();
const USE_AI_PLAYER = USE_AI_PLAYER_RAW
  ? (USE_AI_PLAYER_RAW === 'true' || USE_AI_PLAYER_RAW === '1')
  : true;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'qwen3.5-plus';
// 不要带 /v1，否则会与默认 path /v1/chat/completions 拼成 /v1/v1/...
/** 与 OpenAI SDK 一致：base 不含 /v1；DashScope 兼容模式为 …/compatible-mode + /v1/chat/completions */
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com').replace(/\/+$/, '');
const AI_PLAYER_LLM_LOG = process.env.AI_PLAYER_LLM_LOG === 'true' || process.env.AI_PLAYER_LLM_LOG === '1';

function fastResponseOptions() {
  return {
    // 显式关闭流式输出，减少首包等待与解析复杂度
    stream: false,
    // 对支持该参数的兼容模型关闭“思考过程”
    enable_thinking: false,
  };
}

function getApiKey(): string {
  // 兼容常见命名：OPENAI_API_KEY / DASHSCOPE_API_KEY
  return (process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '').trim();
}

export interface LlmKeyInfo {
  present: boolean;
  source: 'OPENAI_API_KEY' | 'DASHSCOPE_API_KEY' | 'none';
  length: number;
  last4: string;
}

export function getAiPlayerLlmKeyInfo(): LlmKeyInfo {
  const k1 = (process.env.OPENAI_API_KEY ?? '').trim();
  const k2 = (process.env.DASHSCOPE_API_KEY ?? '').trim();
  const key = k1 || k2 || '';
  const source = k1 ? 'OPENAI_API_KEY' : k2 ? 'DASHSCOPE_API_KEY' : 'none';
  return {
    present: !!key,
    source,
    length: key.length,
    last4: key.length >= 4 ? key.slice(-4) : '',
  };
}

export async function aiPlayerLlmSelfTest(params?: {
  prompt?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; ms: number; baseUrl: string; model: string; key: LlmKeyInfo; raw?: unknown; error?: string }> {
  const startedAt = Date.now();
  const key = getAiPlayerLlmKeyInfo();
  if (!key.present) return { ok: false, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, error: 'missing_api_key' };
  const apiKey = getApiKey();
  const prompt = (params?.prompt ?? '请只输出 JSON：{"ok":true,"who":"ai_player"}').slice(0, 500);
  const timeoutMs = Math.max(1000, Math.min(30_000, params?.timeoutMs ?? 12_000));

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: '你是测试助手。只输出合法 JSON，不要解释。' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        ...fastResponseOptions(),
      }),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, error: `${res.status} ${body}` };
    }
    const data = (await res.json()) as unknown;
    return { ok: true, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, raw: data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, error: msg };
  }
}

function heuristicMemorySummary(previousSummary: string, recentEvents: string[], maxChars: number): string {
  const prev = String(previousSummary ?? '').trim();
  const tail = recentEvents.slice(-18).map((x) => String(x).trim()).filter(Boolean);
  const merged = [
    prev ? `【已有认知】${prev}` : '',
    tail.length > 0 ? `【近期事件】${tail.join(' || ')}` : '【近期事件】暂无',
    '【行动建议】优先围绕公开矛盾与票型推进可执行目标，避免长期空转。',
  ].filter(Boolean).join('\n');
  return merged.slice(0, Math.max(200, maxChars));
}

export async function refineAiPlayerMemorySummary(params: {
  seatIndex: number;
  previousSummary: string;
  recentEvents: string[];
  maxChars?: number;
}): Promise<string> {
  const apiKey = getApiKey();
  const maxChars = Math.max(300, Math.min(2200, Number(params.maxChars ?? 1200)));
  if (!apiKey || !USE_AI_PLAYER) {
    return heuristicMemorySummary(params.previousSummary, params.recentEvents, maxChars);
  }
  const systemPrompt = [
    '你是《血染钟楼》玩家记忆整理助手。',
    '任务：把“已有摘要 + 最近事件”整理成更短、更清晰、可行动的记忆。',
    '要求：只基于输入，不编造事实；保留关键矛盾、阵营线索、票型线索。',
    '输出纯文本，不要 markdown，不要 JSON。',
  ].join('\n');
  const userPrompt = JSON.stringify({
    seatIndex: params.seatIndex,
    maxChars,
    formatGuide: [
      '事实：谁说了什么、谁提名谁、关键投票结果',
      '关系：谁互保/对立、谁可疑',
      '风险：可能中毒/伪装/误导点',
      '下一步：一句可执行策略',
    ],
    previousSummary: String(params.previousSummary ?? '').slice(0, 3000),
    recentEvents: (params.recentEvents ?? []).slice(-40),
  });
  try {
    const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 240_000;
    const maxAttempts = Math.max(1, Math.min(4, Number(process.env.AI_LLM_MAX_RETRIES ?? '') || 2));
    let data: { choices?: Array<{ message?: { content?: string } }> } | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const slot = await acquireLlmSlot();
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.2,
            ...fastResponseOptions(),
          }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const status = res.status;
          if (attempt < maxAttempts && isRetryableStatus(status)) {
            await sleep(computeBackoffMs(attempt - 1));
            continue;
          }
          return heuristicMemorySummary(params.previousSummary, params.recentEvents, maxChars);
        }
        data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        break;
      } finally {
        clearTimeout(timeout);
        slot.release();
      }
    }
    if (!data) return heuristicMemorySummary(params.previousSummary, params.recentEvents, maxChars);
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return heuristicMemorySummary(params.previousSummary, params.recentEvents, maxChars);
    return content.slice(0, maxChars);
  } catch {
    return heuristicMemorySummary(params.previousSummary, params.recentEvents, maxChars);
  }
}

export type AiPlayerAction =
  | { type: 'noop' }
  | { type: 'chat_public'; text: string }
  | { type: 'chat_dm'; toSeat: number; text: string }
  | { type: 'chat_god'; text: string }
  | { type: 'nominate'; nominatedSeat: number }
  | { type: 'skip_nomination' }
  | { type: 'vote'; inFavor: boolean }
  | { type: 'day_action'; actionId: string; targetSeat?: number }
  | { type: 'night_action'; targets: number[] }
  | { type: 'night_confirm' };

export interface AiPlayerContext {
  /** 只提供“这个座位本该知道的信息” */
  roomView: unknown;
  yourSeatIndex: number;
  yourRole: unknown;
  yourCharacterId: string | null;
  /** 该座位的“说话画像/表达偏好”（由服务端生成，用于减少同质化） */
  voiceProfile?: string;
  /** 真实阵营（用于胜利目标），以及邪恶阵营可用的伪装身份池 */
  yourAlignment?: 'good' | 'evil';
  demonBluffs?: string[] | null;
  /** 该座位可见聊天（已过滤：god=本人，dm=双方，public=全员） */
  chatLog: Array<{ scope: string; fromSeat: number; toSeat?: number; text: string; at: number }>;
  /** 全场聊天：包含 public / dm / god 全量记录（按用户要求用于全局推理） */
  allChatLog?: Array<{ scope: string; fromSeat: number; toSeat?: number; text: string; at: number; dayNumber?: number; phase?: string }>;
  /** 该座位的“局势记忆摘要”（由服务端整理，仅含该座位可见或可推断信息） */
  playerMemory?: string;
  /** 该座位收到的夜间信息（仅自己的 night_info 文本列表） */
  nightInfo: string[];
  /** 当前投票快照与提名进度 */
  voteSnapshot?: {
    currentNomination: { nominator: number; nominated: number } | null;
    votes: Array<{ seatIndex: number; inFavor: boolean }>;
    nominationsToday: Array<{ nominator: number; nominated: number }>;
    skippedNominationsToday: number[];
    aliveSeatIndices: number[];
    deadSeatIndices: number[];
  };
  /** 近期投票/处决回放摘要（用于拉票与复盘） */
  recentVoteEvents?: string[];
  /** 当前是否轮到该座位夜晚行动（若是，提供 pick 与可选存活座位） */
  nightPrompt?: { stepId: string; pick: 1 | 2; aliveSeatIndices: number[] } | null;
  /** 当前提名（若有） */
  currentNomination?: { nominator: number; nominated: number } | null;
  /** 玩家决策提示词倾向（可由外部注入） */
  promptStyle?: string;
}

export interface AiPlayerDebugEvent {
  stage: 'day_plan' | 'day_dialogue' | 'night_action';
  kind: 'request' | 'response' | 'error';
  seatIndex: number;
  systemPrompt?: string;
  userPrompt?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  rawResponse?: string;
  elapsedMs?: number;
  error?: string;
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

export type AiPlayerDayPlan =
  | {
    type: 'day_plan';
    godQuestion?: { text: string };
    /** 白天固定编排：先私聊（按需给若干目标座位），再公开发言（1 条） */
    dm: Array<{ toSeat: number; text: string }>;
    public: { text: string };
    /** 提名倾向：当轮到自己选择“提名/不提名”时使用 */
    nomination: { type: 'nominate'; targetSeat: number } | { type: 'skip' };
    /** 投票倾向：当轮到自己投票时使用 */
    vote: { inFavor: boolean; reason?: string; priorityExecuteSeats?: number[] };
  }
  | { type: 'noop' };

type AiPromptStyle = 'balanced' | 'assertive' | 'deceptive' | 'chaotic';

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

function buildDefaultPublicText(ctx: AiPlayerContext): string {
  const nightInfoLen = Array.isArray(ctx.nightInfo) ? ctx.nightInfo.length : 0;
  if (ctx.yourAlignment === 'good' && nightInfoLen > 0) {
    return '我这边有夜间信息支撑，今天建议优先推进一名高嫌疑目标进入提名和投票。';
  }
  if (ctx.yourAlignment === 'evil') {
    return '我先给出当前判断：优先处理发言矛盾最大的目标，避免分票。';
  }
  return '先对齐关键信息，再集中推进一个最高嫌疑目标。';
}

function validateAction(room: Room, seatIndex: number, raw: unknown): AiPlayerAction {
  if (!raw || typeof raw !== 'object') return { type: 'noop' };
  const a = raw as Record<string, unknown>;
  const t = String(a.type ?? 'noop');
  const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));

  if (t === 'chat_public') {
    const text = String(a.text ?? '').trim();
    return text ? { type: 'chat_public', text: text.slice(0, 500) } : { type: 'noop' };
  }
  if (t === 'chat_god') {
    const text = String(a.text ?? '').trim();
    return text ? { type: 'chat_god', text: text.slice(0, 200) } : { type: 'noop' };
  }
  if (t === 'chat_dm') {
    const text = String(a.text ?? '').trim();
    const toSeatRaw = a.toSeat as number | undefined;
    if (!text || !Number.isInteger(toSeatRaw)) return { type: 'noop' };
    const toSeat = toSeatRaw as number;
    if (toSeat === seatIndex) return { type: 'noop' };
    if (!room.players[toSeat]) return { type: 'noop' };
    return { type: 'chat_dm', toSeat, text: text.slice(0, 500) };
  }
  if (t === 'nominate') {
    const nominatedSeatRaw = a.nominatedSeat as number | undefined;
    if (!Number.isInteger(nominatedSeatRaw)) return { type: 'noop' };
    const nominatedSeat = nominatedSeatRaw as number;
    if (!aliveSeats.has(nominatedSeat)) return { type: 'noop' };
    return { type: 'nominate', nominatedSeat };
  }
  if (t === 'skip_nomination') return { type: 'skip_nomination' };
  if (t === 'vote') {
    const inFavor = !!a.inFavor;
    return { type: 'vote', inFavor };
  }
  if (t === 'day_action') {
    const actionId = String(a.actionId ?? '');
    const targetSeat = a.targetSeat as number | undefined;
    if (!actionId) return { type: 'noop' };
    if (targetSeat !== undefined && !Number.isInteger(targetSeat)) return { type: 'noop' };
    return { type: 'day_action', actionId, targetSeat };
  }
  if (t === 'night_action') {
    const targets = a.targets as number[] | undefined;
    if (!Array.isArray(targets) || targets.some((x) => !Number.isInteger(x) || !aliveSeats.has(x))) return { type: 'noop' };
    return { type: 'night_action', targets };
  }
  if (t === 'night_confirm') return { type: 'night_confirm' };
  return { type: 'noop' };
}

function validateDayPlan(room: Room, seatIndex: number, raw: unknown, ctx: AiPlayerContext): AiPlayerDayPlan {
  if (!raw || typeof raw !== 'object') return { type: 'noop' };
  const a = raw as Record<string, unknown>;
  if (String(a.type ?? '') !== 'day_plan') return { type: 'noop' };
  const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));

  const dmRaw = Array.isArray(a.dm) ? (a.dm as unknown[]) : [];
  const dmMap = new Map<number, string>();
  for (const x of dmRaw) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const toSeat = Number(r.toSeat);
    const text = String(r.text ?? '').trim();
    if (!Number.isInteger(toSeat) || !text) continue;
    if (toSeat === seatIndex) continue;
    if (!room.players[toSeat]) continue;
    dmMap.set(toSeat, text.slice(0, 500));
  }
  const dm = Array.from(dmMap.entries()).map(([toSeat, text]) => ({ toSeat, text }));

  const pubText = String((a.public as any)?.text ?? '').trim().slice(0, 500);
  const dayNumber = Number((ctx.roomView as { dayNumber?: unknown } | undefined)?.dayNumber ?? -1);
  const isEarlyDay = Number.isFinite(dayNumber) && dayNumber <= 2;
  const selfEvilReveal = /(我是|我就是|身份是).*(恶魔|爪牙|imp|poisoner|baron|scarlet_woman|spy)/i.test(pubText);
  const publicPart = pubText
    ? {
      text: (ctx.yourAlignment === 'evil' && isEarlyDay && selfEvilReveal)
        ? '我先不做身份自证，先按发言矛盾和票型推进一个可执行目标。'
        : pubText,
    }
    : { text: buildDefaultPublicText(ctx) };
  const godText = String((a.godQuestion as any)?.text ?? '').trim().slice(0, 200);

  const nominationRaw = a.nomination as any;
  let nomination: { type: 'nominate'; targetSeat: number } | { type: 'skip' };
  if (nominationRaw && typeof nominationRaw === 'object' && String(nominationRaw.type ?? '') === 'nominate') {
    const targetSeat = nominationRaw.targetSeat as number | undefined;
    const tOk = Number.isInteger(targetSeat) && aliveSeats.has(targetSeat as number);
    nomination = tOk ? { type: 'nominate', targetSeat: targetSeat as number } : { type: 'skip' };
  } else {
    nomination = { type: 'skip' };
  }

  const voteRaw = a.vote as any;
  const inFavor = !!(voteRaw && typeof voteRaw === 'object' ? voteRaw.inFavor : false);
  const reason = voteRaw && typeof voteRaw === 'object' ? String(voteRaw.reason ?? '').slice(0, 120) : '';
  const priorityExecuteSeats = voteRaw && typeof voteRaw === 'object' && Array.isArray(voteRaw.priorityExecuteSeats)
    ? (voteRaw.priorityExecuteSeats as unknown[])
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && aliveSeats.has(x))
      .slice(0, 3)
    : [];

  return {
    type: 'day_plan',
    godQuestion: godText ? { text: godText } : undefined,
    dm,
    public: publicPart,
    nomination,
    vote: { inFavor, reason: reason || undefined, priorityExecuteSeats },
  };
}

export function aiPlayerLlmAvailable(): boolean {
  return !!getApiKey() && !!USE_AI_PLAYER;
}

export async function decideAiPlayerDayPlan(
  room: Room,
  seatIndex: number,
  ctx: AiPlayerContext,
  temperature: number,
  onDebug?: (e: AiPlayerDebugEvent) => void,
): Promise<AiPlayerDayPlan> {
  const apiKey = getApiKey();
  if (!apiKey || !USE_AI_PLAYER) return { type: 'noop' };

  const inflightKey = `ai_player_dayplan_inflight_${seatIndex}`;
  if (room.storytellerDecisions.get(inflightKey) === true) return { type: 'noop' };
  room.storytellerDecisions.set(inflightKey, true);
  try {
    const agent = getOrCreateSeatAgent(room, seatIndex, () => new PlayerSeatAgent({
      seatIndex,
      apiKey,
      baseUrl: OPENAI_BASE_URL,
      model: OPENAI_MODEL,
      enabled: USE_AI_PLAYER,
      aiLog: AI_PLAYER_LLM_LOG,
    }));

    const { raw } = await agent.decideDayPlan(ctx, temperature, onDebug);
    let parsed: unknown = raw;
    // 兼容模型常见输出：{"day_plan":{...}} / {"noop":{...}}
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      if (o.day_plan && typeof o.day_plan === 'object') {
        parsed = { ...(o.day_plan as Record<string, unknown>), type: 'day_plan' };
      } else if (o.noop && typeof o.noop === 'object') {
        parsed = { type: 'noop' };
      } else {
        // 兼容模型遗漏 type：只要结构明显像 day_plan，就补齐 type
        const hasPublic = !!(o.public && typeof o.public === 'object');
        const hasDm = Array.isArray(o.dm);
        const hasNomination = !!(o.nomination && typeof o.nomination === 'object');
        const hasVote = !!(o.vote && typeof o.vote === 'object');
        if (hasPublic || hasDm || hasNomination || hasVote) {
          parsed = { ...o, type: 'day_plan' };
        }
      }
    }
    return validateDayPlan(room, seatIndex, parsed, ctx);
  } catch (e) {
    onDebug?.({
      stage: 'day_plan',
      kind: 'error',
      seatIndex,
      error: formatThrownError(e, Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 240_000),
    });
    return { type: 'noop' };
  } finally {
    room.storytellerDecisions.set(inflightKey, false);
  }
}

/**
 * 夜晚轮到本座行动时专用：仅允许 `night_action`，避免在同一轮 LLM 中混出聊天/投票等行为。
 */
export async function decideAiPlayerNightTargets(
  room: Room,
  seatIndex: number,
  ctx: AiPlayerContext,
  temperature: number,
  onDebug?: (e: AiPlayerDebugEvent) => void,
): Promise<AiPlayerAction> {
  const apiKey = getApiKey();
  if (!apiKey || !USE_AI_PLAYER) return { type: 'noop' };
  if (!ctx.nightPrompt) return { type: 'noop' };

  const inflightKey = `ai_player_night_inflight_${seatIndex}`;
  if (room.storytellerDecisions.get(inflightKey) === true) return { type: 'noop' };
  room.storytellerDecisions.set(inflightKey, true);
  try {
    const agent = getOrCreateSeatAgent(room, seatIndex, () => new PlayerSeatAgent({
      seatIndex,
      apiKey,
      baseUrl: OPENAI_BASE_URL,
      model: OPENAI_MODEL,
      enabled: USE_AI_PLAYER,
      aiLog: AI_PLAYER_LLM_LOG,
    }));
    const { raw } = await agent.decideNightTargets(ctx, temperature, onDebug);
    const parsed: unknown = raw;

    const act = validateAction(room, seatIndex, parsed);
    const pick = ctx.nightPrompt.pick;
    if (act.type !== 'night_action') return { type: 'noop' };
    if (act.targets.length !== pick) return { type: 'noop' };
    if (pick === 2 && act.targets[0] === act.targets[1]) return { type: 'noop' };
    return act;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ai_player] night_targets failed seat=${seatIndex}: ${msg}`);
    onDebug?.({
      stage: 'night_action',
      kind: 'error',
      seatIndex,
      error: formatThrownError(e, Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 240_000),
    });
    return { type: 'noop' };
  } finally {
    room.storytellerDecisions.set(inflightKey, false);
  }
}

export async function answerPostGamePlayerQuestion(
  room: Room,
  targetSeatIndex: number,
  askerSeatIndex: number,
  question: string,
): Promise<string> {
  const q = String(question ?? '').trim();
  if (!q) return '该玩家：你的问题是空的，请具体一点。';
  const target = room.players[targetSeatIndex];
  if (!target) return '该玩家：目标座位不存在。';

  const apiKey = getApiKey();
  if (!apiKey) {
    return '该玩家：当前未配置大模型密钥，无法生成复盘解释。';
  }

  const roleMeta = target.characterId
    ? room.script.characters.find((c) => c.id === target.characterId)
    : null;
  const roleNameZh = roleMeta?.nameZh ?? target.characterId ?? '未知身份';
  const alignment = roleMeta?.alignment ?? 'unknown';
  const selfNightInfo = (room.storytellerDecisions.get('night_info_log_by_seat') as Map<number, string[]> | undefined)?.get(targetSeatIndex) ?? [];
  const targetChat = room.chatLog
    .filter((e) => e.fromSeat === targetSeatIndex || e.toSeat === targetSeatIndex)
    .slice(-200);

  const systemPrompt = [
    '你是在复盘阶段回答问题的 AI 玩家。',
    `你现在扮演座位 #${targetSeatIndex + 1}，真实身份是「${roleNameZh}」，阵营是「${alignment}」。`,
    '对局已经结束。请基于真实记录解释你当时为什么这么做。',
    '回答要像玩家复盘，不要编造不存在的事件。',
    '请输出纯文本，不要 markdown。',
  ].join('\n');

  const userPrompt = JSON.stringify({
    question: q,
    askerSeatIndex,
    targetSeatIndex,
    scriptNameZh: room.script.nameZh,
    finalState: {
      status: room.status,
      phase: room.phase,
      dayNumber: room.dayNumber,
    },
    targetPlayer: {
      seatIndex: targetSeatIndex,
      nickname: target.nickname,
      isAlive: target.isAlive,
      characterId: target.characterId ?? null,
      characterNameZh: roleNameZh,
      alignment,
    },
    targetVisibleNightInfo: selfNightInfo,
    targetRelatedChat: targetChat,
    replayLog: room.replayLog.slice(-500),
    votes: Array.from(room.votes.entries()).map(([seat, inFavor]) => ({ seatIndex: seat, inFavor })),
    nominationsToday: Array.from(room.nominationsToday.entries()).map(([nominator, nominated]) => ({ nominator, nominated })),
    requirement: [
      '直接回答“为什么这么做”',
      '给出1-3条关键依据（聊天、提名、投票、夜间信息）',
      '若问题前提不成立要指出',
    ],
  });

  const ac = new AbortController();
  const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 240_000;
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.3,
        ...fastResponseOptions(),
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return `该玩家：复盘回答失败（${res.status}）。${t.slice(0, 120)}`;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return '该玩家：我这次没能组织出有效复盘答案。';
    return content.slice(0, 3000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `该玩家：复盘回答异常（${msg}）。`;
  } finally {
    clearTimeout(timeout);
  }
}

export async function decideAiPlayerAction(room: Room, seatIndex: number, ctx: AiPlayerContext, temperature: number): Promise<AiPlayerAction> {
  const apiKey = getApiKey();
  if (!apiKey || !USE_AI_PLAYER) return { type: 'noop' };

  if (ctx.nightPrompt != null) {
    return { type: 'noop' };
  }

  // 单座位串行：同一个座位上一请求未结束，不再发起下一次调用
  const inflightKey = `ai_player_inflight_${seatIndex}`;
  if (room.storytellerDecisions.get(inflightKey) === true) return { type: 'noop' };
  room.storytellerDecisions.set(inflightKey, true);

  // 每个座位独立线程：放在 room.storytellerDecisions，避免跨座位泄露
  try {
    const agent = getOrCreateSeatAgent(room, seatIndex, () => new PlayerSeatAgent({
      seatIndex,
      apiKey,
      baseUrl: OPENAI_BASE_URL,
      model: OPENAI_MODEL,
      enabled: USE_AI_PLAYER,
      aiLog: AI_PLAYER_LLM_LOG,
    }));
    const { raw } = await agent.decideSingleAction(ctx, temperature);
    return validateAction(room, seatIndex, raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && 'cause' in e ? (e as Error & { cause?: unknown }).cause : undefined;
    const causeStr =
      cause instanceof Error ? cause.message : cause != null ? String(cause) : '';
    console.warn(
      `[ai_player] llm request failed seat=${seatIndex}: ${msg}${causeStr ? ` | cause: ${causeStr}` : ''} url=${OPENAI_BASE_URL}/v1/chat/completions`,
    );
    return { type: 'noop' };
  } finally {
    room.storytellerDecisions.set(inflightKey, false);
  }
}

export async function decideAiPlayerConstrainedAction(
  room: Room,
  seatIndex: number,
  ctx: AiPlayerContext,
  temperature: number,
  params: {
    allowedActions: Array<'noop' | 'chat_public' | 'chat_dm' | 'chat_god'>;
    instruction: string;
    outputSchema: Record<string, unknown>;
    stageHint: 'god_dialogue' | 'private_dialogue' | 'public_speech';
  },
  onDebug?: (e: AiPlayerDebugEvent) => void,
): Promise<AiPlayerAction> {
  const apiKey = getApiKey();
  if (!apiKey || !USE_AI_PLAYER) return { type: 'noop' };

  const inflightKey = `ai_player_constrained_inflight_${params.stageHint}_${seatIndex}`;
  if (room.storytellerDecisions.get(inflightKey) === true) return { type: 'noop' };
  room.storytellerDecisions.set(inflightKey, true);

  try {
    const agent = getOrCreateSeatAgent(room, seatIndex, () => new PlayerSeatAgent({
      seatIndex,
      apiKey,
      baseUrl: OPENAI_BASE_URL,
      model: OPENAI_MODEL,
      enabled: USE_AI_PLAYER,
      aiLog: AI_PLAYER_LLM_LOG,
    }));
    const { raw } = await agent.decideConstrainedAction({
      ctx,
      temperature,
      allowedActions: params.allowedActions,
      instruction: params.instruction,
      outputSchema: params.outputSchema,
      stageHint: params.stageHint,
    }, onDebug);
    const act = validateAction(room, seatIndex, raw);
    if (!params.allowedActions.includes(act.type as any)) return { type: 'noop' };
    return act;
  } catch {
    return { type: 'noop' };
  } finally {
    room.storytellerDecisions.set(inflightKey, false);
  }
}

