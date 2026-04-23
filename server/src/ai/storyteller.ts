import type { Room } from '../game/types.js';
import type { StorytellerRequest, StorytellerDecision, ChoiceTwoPlayersOneCharacter, LibrarianNoOutsiderChoice } from './types.js';
import { buildStorytellerRequest } from './adapter.js';
import { randomStorytellerDecision } from '../game/gameEngine.js';

/** 供 AI 使用的请求上下文中需包含可选善良角色 id 列表 */
export interface StorytellerContext extends StorytellerRequest {
  goodCharacterIds: string[];
  allCharacterIds: string[];
  townsfolkIds: string[];
  outsiderIds: string[];
  minionIds: string[];
  omniscientPlayers: Array<{
    seatIndex: number;
    isAlive: boolean;
    characterId: string | null;
    alignment: 'good' | 'evil' | null;
  }>;
  fullChatLog: Array<{
    scope: string;
    fromSeat: number;
    toSeat?: number;
    text: string;
    at: number;
    dayNumber?: number;
    phase?: string;
  }>;
  currentNomination: { nominator: number; nominated: number } | null;
  nominationsToday: Array<{ nominator: number; nominated: number }>;
  votes: Array<{ seatIndex: number; inFavor: boolean }>;
}

export interface StorytellerDebugEvent {
  kind: 'request' | 'response' | 'error';
  stepId: string;
  model: string;
  systemPrompt?: string;
  userPrompt?: string;
  rawResponse?: string;
  elapsedMs?: number;
  error?: string;
}

export interface NightMediationInput {
  stepId: 'imp' | 'monk' | 'poisoner' | 'fortune_teller';
  actorSeatIndex: number;
  pick: 1 | 2;
  aliveSeatIndices: number[];
  playerSuggestedTargets?: number[];
}

const USE_AI = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'qwen3.5-plus';
// 不要带 /v1，否则会与默认 path /v1/chat/completions 拼成 /v1/v1/...
// DashScope 实测：coding 网关对部分 key 生效；兼容模式域名在部分场景会 401
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com').replace(/\/+$/, '');
const AI_STORYTELLER_LLM_LOG = process.env.AI_STORYTELLER_LLM_LOG === 'true' || process.env.AI_STORYTELLER_LLM_LOG === '1';

function fastResponseOptions() {
  return {
    // 明确禁用流式，降低等待时间
    stream: false,
    // 对支持该参数的模型关闭思考过程
    enable_thinking: false,
  };
}

function getApiKey(): string {
  return (process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '').trim();
}

export interface LlmKeyInfo {
  present: boolean;
  source: 'OPENAI_API_KEY' | 'DASHSCOPE_API_KEY' | 'none';
  length: number;
  last4: string;
}

export function getStorytellerLlmKeyInfo(): LlmKeyInfo {
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

export async function storytellerLlmSelfTest(params?: {
  prompt?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; ms: number; baseUrl: string; model: string; key: LlmKeyInfo; raw?: unknown; error?: string }> {
  const startedAt = Date.now();
  const key = getStorytellerLlmKeyInfo();
  if (!key.present) return { ok: false, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, error: 'missing_api_key' };
  const apiKey = (process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '').trim();
  const prompt = (params?.prompt ?? '请只输出 JSON：{"ok":true,"who":"storyteller"}').slice(0, 500);
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

/**
 * 校验决策：玩家座位合法、角色在剧本中
 */
export function validateDecision(room: Room, stepId: string, decision: unknown): StorytellerDecision | null {
  if (!decision || typeof decision !== 'object') return null;
  const d = decision as Record<string, unknown>;
  const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));

  if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
    if (stepId === 'librarian' && d.noOutsider === true) {
      const noOutsider: LibrarianNoOutsiderChoice = { type: 'librarian_result', noOutsider: true };
      return noOutsider;
    }
    const type = `${stepId}_result` as keyof ChoiceTwoPlayersOneCharacter;
    const players = d.players as number[] | undefined;
    const characterId = d.characterId as string | undefined;
    if (!Array.isArray(players) || players.length !== 2 || typeof characterId !== 'string') return null;
    const [a, b] = players;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return null;
    if (!aliveSeats.has(a) || !aliveSeats.has(b)) return null;
    const char = room.script.characters.find((c) => c.id === characterId);
    if (!char) return null;
    if (stepId === 'washerwoman' && !(char.alignment === 'good' && char.type === 'townsfolk')) return null;
    if (stepId === 'librarian' && !(char.alignment === 'good' && char.type === 'outsider')) return null;
    if (stepId === 'investigator' && !(char.alignment === 'evil' && char.type === 'minion')) return null;
    return { type: `${stepId}_result` as ChoiceTwoPlayersOneCharacter['type'], players: [a, b], characterId };
  }

  if (stepId === 'imp') {
    const targetSeatIndex = d.targetSeatIndex as number | undefined;
    if (typeof targetSeatIndex !== 'number' || !aliveSeats.has(targetSeatIndex)) return null;
    return { type: 'imp_kill', targetSeatIndex };
  }

  return null;
}

/**
 * 将引擎使用的 decision 格式转为 storytellerDecisions 写入格式
 */
export function toEngineDecision(room: Room, stepId: string, validated: StorytellerDecision): unknown {
  if (stepId === 'librarian' && 'noOutsider' in validated && validated.noOutsider === true) {
    return { type: 'librarian_result', noOutsider: true };
  }
  if (validated.type === 'imp_kill') return validated.targetSeatIndex;
  return {
    type: validated.type,
    players: (validated as ChoiceTwoPlayersOneCharacter).players,
    characterId: (validated as ChoiceTwoPlayersOneCharacter).characterId,
  };
}

/**
 * 调用 AI 获取说书人决策；失败或未配置时回退到随机
 */
export async function getStorytellerDecision(
  room: Room,
  stepId: string,
  stepNameZh: string,
  forceAi = false,
  onDebug?: (e: StorytellerDebugEvent) => void,
): Promise<unknown> {
  const req = buildStorytellerRequest(room, stepId, stepNameZh);
  const goodCharacterIds = room.script.characters.filter((c) => c.alignment === 'good').map((c) => c.id);
  const allCharacterIds = room.script.characters.map((c) => c.id);
  const townsfolkIds = room.script.characters.filter((c) => c.alignment === 'good' && c.type === 'townsfolk').map((c) => c.id);
  const outsiderIds = room.script.characters.filter((c) => c.alignment === 'good' && c.type === 'outsider').map((c) => c.id);
  const minionIds = room.script.characters.filter((c) => c.alignment === 'evil' && c.type === 'minion').map((c) => c.id);
  const omniscientPlayers = room.players.map((p) => {
    const meta = p.characterId ? room.script.characters.find((c) => c.id === p.characterId) : null;
    return {
      seatIndex: p.seatIndex,
      isAlive: p.isAlive,
      characterId: p.characterId ?? null,
      alignment: meta?.alignment ?? null,
    };
  });
  const fullChatLog = room.chatLog.slice(-200).map((e) => ({
    scope: e.scope,
    fromSeat: e.fromSeat,
    toSeat: e.toSeat,
    text: e.text,
    at: e.at,
    dayNumber: e.dayNumber,
    phase: e.phase,
  }));
  const ctx: StorytellerContext = {
    ...req,
    goodCharacterIds,
    allCharacterIds,
    townsfolkIds,
    outsiderIds,
    minionIds,
    omniscientPlayers,
    fullChatLog,
    currentNomination: room.currentNomination,
    nominationsToday: Array.from(room.nominationsToday.entries()).map(([nominator, nominated]) => ({ nominator, nominated })),
    votes: Array.from(room.votes.entries()).map(([seatIndex, inFavor]) => ({ seatIndex, inFavor })),
  };
  let raw: unknown = null;

  const apiKey = getApiKey();
  if ((USE_AI || forceAi) && apiKey) {
    try {
      raw = await callOpenAI(ctx, stepId, apiKey, onDebug);
    } catch (e) {
      onDebug?.({
        kind: 'error',
        stepId,
        model: OPENAI_MODEL,
        error: e instanceof Error ? e.message : String(e),
      });
      console.warn('AI storyteller request failed, using random:', (e as Error).message);
    }
  }

  const validated = raw ? validateDecision(room, stepId, raw) : null;
  if (validated) {
    return toEngineDecision(room, stepId, validated);
  }
  return randomStorytellerDecision(room);
}

const STEP_NAMES: Record<string, string> = {
  washerwoman: '洗衣妇',
  librarian: '图书管理员',
  investigator: '调查员',
};

function getStepNameZh(stepId: string): string {
  return STEP_NAMES[stepId] ?? stepId;
}

/**
 * 调用 OpenAI Chat Completions（JSON mode）
 */
async function callOpenAI(
  req: StorytellerContext,
  stepId: string,
  apiKey: string,
  onDebug?: (e: StorytellerDebugEvent) => void,
): Promise<unknown> {
  const isTwoPlayersOneChar = ['washerwoman', 'librarian', 'investigator'].includes(stepId);
  const schema = isTwoPlayersOneChar
    ? { type: 'object', properties: { players: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, characterId: { type: 'string' } }, required: ['players', 'characterId'] }
    : { type: 'object', properties: { targetSeatIndex: { type: 'integer' } }, required: ['targetSeatIndex'] };

  const systemPrompt = [
    '你是《血染钟楼》的说书人裁量助手。',
    '你只负责当前 stepId 的裁量 JSON，不是玩家，不推进流程，不修改状态。',
    '目标：在规则允许下平衡局势、保留悬念、提升对局体验。',
    '规则范围内存在多种可行裁量，请结合上下文选择其一。',
    '请输出合法 JSON，不要解释、markdown 或额外字段。',
  ].join('');
  const poisonHint =
    req.poisonedSeatIndex != null ? `注意：座位 ${req.poisonedSeatIndex} 当晚可能因投毒而不清醒（仅据此调整叙事节奏，勿在回复中提及「中毒」字样）。` : '';
  const typeScopedIds =
    stepId === 'washerwoman'
      ? req.townsfolkIds
      : stepId === 'librarian'
        ? req.outsiderIds
        : stepId === 'investigator'
          ? req.minionIds
          : req.goodCharacterIds;
  const userPrompt = JSON.stringify({
    instruction: isTwoPlayersOneChar
      ? `当前步骤：${getStepNameZh(stepId)}。请基于全场真实上下文生成首夜信息裁定。`
      : '当前步骤：imp，请基于全场真实上下文裁定本夜击杀目标。',
    outputSchema: isTwoPlayersOneChar
      ? (stepId === 'librarian'
        ? { oneOf: [{ players: '[seatA, seatB]', characterId: 'string' }, { noOutsider: true }] }
        : { players: '[seatA, seatB]', characterId: 'string' })
      : { targetSeatIndex: 'number' },
    constraints: isTwoPlayersOneChar
      ? [
        `players 必须是两个不同且存活座位，仅可从 ${req.aliveSeatIndices.join(',')} 中选`,
        `characterId 仅可从以下集合选择：${typeScopedIds.join(',')}`,
        ...(stepId === 'librarian' ? ['若场上没有外来者，可返回 {"noOutsider":true}。'] : []),
        '只返回 JSON 对象，不要解释',
      ]
      : [
        `targetSeatIndex 必须是存活座位，仅可从 ${req.aliveSeatIndices.join(',')} 中选（可按规则自刀）`,
        '只返回 JSON 对象，不要解释',
      ],
    poisonHint,
    storytellerOmniscientContext: {
      scriptNameZh: req.scriptNameZh,
      dayNumber: req.dayNumber,
      phase: req.phase,
      players: req.omniscientPlayers,
      fullChatLog: req.fullChatLog,
      currentNomination: req.currentNomination,
      nominationsToday: req.nominationsToday,
      votes: req.votes,
    },
  });
  onDebug?.({
    kind: 'request',
    stepId,
    model: OPENAI_MODEL,
    systemPrompt,
    userPrompt,
  });

  const ac = new AbortController();
  const timeoutMs = Number(process.env.AI_STORYTELLER_TIMEOUT_MS ?? '') || 240_000;
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = Date.now();
  if (AI_STORYTELLER_LLM_LOG) {
    const keyLast4 = apiKey.length >= 4 ? apiKey.slice(-4) : '';
    console.log('[ai_storyteller] llm input', {
      stepId,
      dayNumber: req.dayNumber,
      baseUrl: OPENAI_BASE_URL,
      model: OPENAI_MODEL,
      timeoutMs,
      keyLast4,
      aliveCount: req.aliveSeatIndices.length,
      poisonedSeatIndex: req.poisonedSeatIndex ?? null,
    });
    console.log('[ai_storyteller] llm input_prompt', userPrompt.slice(0, 2400));
  }
  const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      ...fastResponseOptions(),
    }),
    signal: ac.signal,
  });
  clearTimeout(timeout);
  if (!res.ok) {
    const t = await res.text();
    if (AI_STORYTELLER_LLM_LOG) {
      console.log('[ai_storyteller] llm not ok', { stepId, status: res.status, ms: Date.now() - startedAt, body: t.slice(0, 600) });
    }
    throw new Error(`${res.status} ${t}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty AI response');
  onDebug?.({
    kind: 'response',
    stepId,
    model: OPENAI_MODEL,
    rawResponse: content,
    elapsedMs: Date.now() - startedAt,
  });
  if (AI_STORYTELLER_LLM_LOG) {
    console.log('[ai_storyteller] llm output', { stepId, ms: Date.now() - startedAt, content: content.slice(0, 2400) });
  }
  return JSON.parse(content) as unknown;
}

function validateNightTargets(
  input: NightMediationInput,
  raw: unknown,
): number[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const targets = d.targets as number[] | undefined;
  if (!Array.isArray(targets) || targets.length !== input.pick) return null;
  const alive = new Set(input.aliveSeatIndices);
  for (const t of targets) {
    if (!Number.isInteger(t) || !alive.has(t)) return null;
  }
  if (input.pick === 2 && targets[0] === targets[1]) return null;
  return targets;
}

function randomNightTargets(input: NightMediationInput): number[] {
  const alive = [...input.aliveSeatIndices];
  const out: number[] = [];
  for (let i = 0; i < input.pick; i++) {
    const remain = alive.filter((x) => !out.includes(x));
    if (remain.length === 0) break;
    out.push(remain[Math.floor(Math.random() * remain.length)]);
  }
  return out.length === input.pick ? out : alive.slice(0, input.pick);
}

export async function getStorytellerMediatedNightTargets(
  room: Room,
  input: NightMediationInput,
  forceAi = false,
  onDebug?: (e: StorytellerDebugEvent) => void,
): Promise<number[]> {
  const apiKey = getApiKey();
  const enabled = (USE_AI || forceAi) && !!apiKey;
  const fallback =
    Array.isArray(input.playerSuggestedTargets)
      && input.playerSuggestedTargets.length === input.pick
      ? input.playerSuggestedTargets
      : randomNightTargets(input);
  if (!enabled || !apiKey) return fallback;

  const systemPrompt = [
    '你是《血染钟楼》的说书人裁定助手。',
    '当前是夜晚玩家行动中转环节：玩家先给建议目标，你再根据规则与局势做最终裁定。',
    '规则范围内允许多种裁定方案，请选择你认为收益更高的一种。',
    '请只返回 JSON：{"targets":[...]}，长度等于 pick，且都在 aliveSeatIndices 中。',
    '不要输出解释文本或额外字段。',
  ].join('');
  const userPrompt = JSON.stringify({
    scriptNameZh: room.script.nameZh,
    dayNumber: room.dayNumber,
    phase: room.phase,
    stepId: input.stepId,
    actorSeatIndex: input.actorSeatIndex,
    pick: input.pick,
    aliveSeatIndices: input.aliveSeatIndices,
    playerSuggestedTargets: input.playerSuggestedTargets ?? [],
    outputSchema: { targets: `number[${input.pick}]` },
    storytellerOmniscientContext: {
      players: room.players.map((p) => {
        const meta = p.characterId ? room.script.characters.find((c) => c.id === p.characterId) : null;
        return {
          seatIndex: p.seatIndex,
          isAlive: p.isAlive,
          characterId: p.characterId ?? null,
          alignment: meta?.alignment ?? null,
        };
      }),
      fullChatLog: room.chatLog.slice(-200),
      currentNomination: room.currentNomination,
      nominationsToday: Array.from(room.nominationsToday.entries()).map(([nominator, nominated]) => ({ nominator, nominated })),
      votes: Array.from(room.votes.entries()).map(([seatIndex, inFavor]) => ({ seatIndex, inFavor })),
    },
  });
  onDebug?.({
    kind: 'request',
    stepId: input.stepId,
    model: OPENAI_MODEL,
    systemPrompt,
    userPrompt,
  });

  const ac = new AbortController();
  const timeoutMs = Number(process.env.AI_STORYTELLER_TIMEOUT_MS ?? '') || 240_000;
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        ...fastResponseOptions(),
      }),
      signal: ac.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`${res.status} ${t}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty AI response');
    onDebug?.({
      kind: 'response',
      stepId: input.stepId,
      model: OPENAI_MODEL,
      rawResponse: content,
      elapsedMs: Date.now() - startedAt,
    });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    const v = validateNightTargets(input, parsed);
    return v ?? fallback;
  } catch (e) {
    onDebug?.({
      kind: 'error',
      stepId: input.stepId,
      model: OPENAI_MODEL,
      error: e instanceof Error ? e.message : String(e),
    });
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
