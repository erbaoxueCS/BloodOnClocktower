import type { Room } from '../game/types.js';
import type { StorytellerRequest, StorytellerDecision, ChoiceTwoPlayersOneCharacter } from './types.js';
import { buildStorytellerRequest } from './adapter.js';
import { randomStorytellerDecision } from '../game/gameEngine.js';

/** 供 AI 使用的请求上下文中需包含可选善良角色 id 列表 */
export interface StorytellerContext extends StorytellerRequest {
  goodCharacterIds: string[];
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

const USE_AI = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'qwen3.5-plus';
// 不要带 /v1，否则会与默认 path /v1/chat/completions 拼成 /v1/v1/...
// DashScope 实测：coding 网关对部分 key 生效；兼容模式域名在部分场景会 401
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com').replace(/\/+$/, '');
const AI_STORYTELLER_LLM_LOG = process.env.AI_STORYTELLER_LLM_LOG === 'true' || process.env.AI_STORYTELLER_LLM_LOG === '1';

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
    const type = `${stepId}_result` as keyof ChoiceTwoPlayersOneCharacter;
    const players = d.players as number[] | undefined;
    const characterId = d.characterId as string | undefined;
    if (!Array.isArray(players) || players.length !== 2 || typeof characterId !== 'string') return null;
    const [a, b] = players;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return null;
    if (!aliveSeats.has(a) || !aliveSeats.has(b)) return null;
    const char = room.script.characters.find((c) => c.id === characterId);
    if (!char || char.alignment !== 'good') return null;
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
  void room;
  void stepId;
  switch (validated.type) {
    case 'imp_kill':
      return validated.targetSeatIndex;
    case 'librarian_result':
      if ('noOutsider' in validated && validated.noOutsider) {
        return { type: 'librarian_result', noOutsider: true };
      }
      if ('players' in validated && 'characterId' in validated) {
        return { type: validated.type, players: validated.players, characterId: validated.characterId };
      }
      return { type: 'librarian_result', noOutsider: true };
    case 'washerwoman_result':
    case 'investigator_result':
      return { type: validated.type, players: validated.players, characterId: validated.characterId };
    default: {
      const _exhaustive: never = validated;
      return _exhaustive;
    }
  }
}

/**
 * 调用 AI 获取说书人决策；失败或未配置时回退到随机
 */
export async function getStorytellerDecision(
  room: Room,
  stepId: string,
  stepNameZh: string,
  forceAi = false,
  onDebug?: (event: StorytellerDebugEvent) => void,
): Promise<unknown> {
  const req = buildStorytellerRequest(room, stepId, stepNameZh);
  const goodCharacterIds = room.script.characters.filter((c) => c.alignment === 'good').map((c) => c.id);
  const ctx: StorytellerContext = { ...req, goodCharacterIds };
  let raw: unknown = null;

  const apiKey = getApiKey();
  if ((USE_AI || forceAi) && apiKey) {
    try {
      raw = await callOpenAI(ctx, stepId, apiKey, onDebug);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onDebug?.({ kind: 'error', stepId, model: OPENAI_MODEL, error: message });
      console.warn('AI storyteller request failed, using random:', message);
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
  onDebug?: (event: StorytellerDebugEvent) => void,
): Promise<unknown> {
  const isTwoPlayersOneChar = ['washerwoman', 'librarian', 'investigator'].includes(stepId);
  const schema = isTwoPlayersOneChar
    ? { type: 'object', properties: { players: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, characterId: { type: 'string' } }, required: ['players', 'characterId'] }
    : { type: 'object', properties: { targetSeatIndex: { type: 'integer' } }, required: ['targetSeatIndex'] };

  const systemPrompt = `你是血染钟楼的说书人。请根据「平衡局势、增进体验、让对局更跌宕起伏」的原则做选择。只输出合法 JSON，不要解释。`;
  const poisonHint =
    req.poisonedSeatIndex != null ? `注意：座位 ${req.poisonedSeatIndex} 当晚可能因投毒而不清醒（仅据此调整叙事节奏，勿在回复中提及「中毒」字样）。` : '';
  const goodIdList = req.goodCharacterIds?.length ? `合法 characterId 只能从下列善良方角色中选：${req.goodCharacterIds.join(',')}。` : '';
  const userPrompt = isTwoPlayersOneChar
    ? `剧本：${req.scriptNameZh}。当前为第${req.dayNumber}天夜晚，步骤：${getStepNameZh(stepId)}。需要选择两名存活玩家（座位号）和其中一个善良方角色 identity（characterId）。存活座位号：${req.aliveSeatIndices.join(',')}。${goodIdList}${poisonHint}回复格式：{"players":[座位1,座位2],"characterId":"角色id"}`
    : `剧本：${req.scriptNameZh}。恶魔选择一名存活玩家杀害（可选择自己自杀以传位爪牙）。存活座位号：${req.aliveSeatIndices.join(',')}。${poisonHint}回复格式：{"targetSeatIndex":座位号}`;
  onDebug?.({
    kind: 'request',
    stepId,
    model: OPENAI_MODEL,
    systemPrompt,
    userPrompt,
  });

  const ac = new AbortController();
  const timeoutMs = Number(process.env.AI_STORYTELLER_TIMEOUT_MS ?? '') || 180_000;
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

export async function answerPostGameQuestion(
  room: Room,
  askerSeatIndex: number,
  question: string,
): Promise<string> {
  const q = String(question ?? '').trim();
  if (!q) return '上帝：你的问题是空的，请具体一点。';

  const asker = room.players[askerSeatIndex];
  if (!asker) return '上帝：提问玩家不存在。';

  const apiKey = getApiKey();
  if (!apiKey) return '上帝：当前未配置大模型密钥，无法生成复盘解释。';

  const systemPrompt = [
    '你是血染钟楼对局结束后的上帝复盘助手。',
    '请基于真实对局记录回答玩家问题，解释关键决策和信息流。',
    '不要编造不存在的事件；如果记录不足就明确说明不确定。',
    '回答风格清晰、简洁，输出纯文本，不要 markdown。',
  ].join('\n');

  const userPrompt = JSON.stringify({
    question: q,
    askerSeatIndex,
    scriptNameZh: room.script.nameZh,
    finalState: {
      status: room.status,
      phase: room.phase,
      dayNumber: room.dayNumber,
    },
    players: room.players.map((p) => ({
      seatIndex: p.seatIndex,
      nickname: p.nickname,
      isAlive: p.isAlive,
      characterId: p.characterId ?? null,
    })),
    chatTail: room.chatLog.slice(-300),
  });

  const ac = new AbortController();
  const timeoutMs = Number(process.env.AI_STORYTELLER_TIMEOUT_MS ?? '') || 180_000;
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return `上帝：复盘回答失败（${res.status}）。${t.slice(0, 120)}`;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return '上帝：我这次没能组织出有效复盘答案。';
    return content.slice(0, 3000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `上帝：复盘回答异常（${msg}）。`;
  } finally {
    clearTimeout(timeout);
  }
}
