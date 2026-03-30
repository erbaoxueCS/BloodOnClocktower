import type { Room } from '../game/types.js';

const USE_AI = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
// 不要带 /v1，否则会与默认 path /v1/chat/completions 拼成 /v1/v1/...
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com').replace(/\/+$/, '');

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
  /** 该座位可见聊天（已过滤：god=本人，dm=双方，public=全员） */
  chatLog: Array<{ scope: string; fromSeat: number; toSeat?: number; text: string; at: number }>;
  /** 该座位收到的夜间信息（仅自己的 night_info 文本列表） */
  nightInfo: string[];
  /** 当前是否轮到该座位夜晚行动（若是，提供 pick 与可选存活座位） */
  nightPrompt?: { stepId: string; pick: 1 | 2; aliveSeatIndices: number[] } | null;
  /** 当前提名（若有） */
  currentNomination?: { nominator: number; nominated: number } | null;
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

export function aiPlayerLlmAvailable(): boolean {
  return !!OPENAI_API_KEY && !!USE_AI;
}

export async function decideAiPlayerAction(room: Room, seatIndex: number, ctx: AiPlayerContext, temperature: number): Promise<AiPlayerAction> {
  if (!OPENAI_API_KEY || !USE_AI) return { type: 'noop' };

  // 每个座位独立线程：放在 room.storytellerDecisions，避免跨座位泄露
  const threadKey = `ai_player_thread_${seatIndex}`;
  const v = room.storytellerDecisions.get(threadKey);
  const thread: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = Array.isArray(v) ? (v as any) : [];

  const systemPrompt = [
    '你是血染钟楼的“AI 玩家”，你只代表一个座位行动。',
    '重要：你只能使用提供给你的上下文（roomView/yourRole/chatLog/nightInfo/nightPrompt）。',
    '你不知道其他玩家的真实身份，也看不到其他人的上帝私聊与私聊内容（除非在 chatLog 中出现）。',
    '你必须严格避免暗示你知道未提供的信息。',
    '你要做的事：理解自己获得的信息，与他人交流（公开/私聊/上帝），并在允许时提名、投票、使用能力、夜晚行动、确认夜晚结束。',
    '策略偏好：尽量像普通玩家而非“完美玩家”。通常情况下，被提名者更倾向投反对，除非你有明确策略（例如自证）。',
    '胜利条件：善良=恶魔死亡；邪恶=存活人数<=2 或保持恶魔存活到终局。',
    '只输出 JSON（不要解释），格式见 user prompt。',
  ].join('\n');

  const userPrompt = JSON.stringify({
    instruction: '根据上下文选择下一步“单个动作”。如果没必要动作，输出 {"type":"noop"}。',
    allowedActions: [
      'noop',
      'chat_public',
      'chat_dm',
      'chat_god',
      'nominate',
      'skip_nomination',
      'vote',
      'day_action',
      'night_action',
      'night_confirm',
    ],
    context: ctx,
    outputSchema: {
      chat_public: { type: 'chat_public', text: 'string' },
      chat_dm: { type: 'chat_dm', toSeat: 'number', text: 'string' },
      chat_god: { type: 'chat_god', text: 'string' },
      nominate: { type: 'nominate', nominatedSeat: 'number' },
      skip_nomination: { type: 'skip_nomination' },
      vote: { type: 'vote', inFavor: 'boolean' },
      day_action: { type: 'day_action', actionId: 'string', targetSeat: 'number(optional)' },
      night_action: { type: 'night_action', targets: 'number[]' },
      night_confirm: { type: 'night_confirm' },
      noop: { type: 'noop' },
    },
  });

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...thread.slice(-8),
    { role: 'user' as const, content: userPrompt },
  ];

  const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      response_format: { type: 'json_object' },
      temperature: Math.min(1, Math.max(0, temperature)),
    }),
  });
  if (!res.ok) return { type: 'noop' };
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return { type: 'noop' };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }

  // 保存线程（独立通道）
  thread.push({ role: 'user', content: userPrompt });
  thread.push({ role: 'assistant', content });
  room.storytellerDecisions.set(threadKey, thread.slice(-16));

  return validateAction(room, seatIndex, parsed);
}

