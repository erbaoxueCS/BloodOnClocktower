import type { Room } from '../game/types.js';
import type { StorytellerRequest, StorytellerDecision, ChoiceTwoPlayersOneCharacter } from './types.js';
import { buildStorytellerRequest } from './adapter.js';
import { randomStorytellerDecision } from '../game/gameEngine.js';

/** 供 AI 使用的请求上下文中需包含可选善良角色 id 列表 */
export interface StorytellerContext extends StorytellerRequest {
  goodCharacterIds: string[];
}

const USE_AI = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
// 不要带 /v1，否则会与默认 path /v1/chat/completions 拼成 /v1/v1/...
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com').replace(/\/+$/, '');

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
  if (validated.type === 'imp_kill') return validated.targetSeatIndex;
  return { type: validated.type, players: validated.players, characterId: validated.characterId };
}

/**
 * 调用 AI 获取说书人决策；失败或未配置时回退到随机
 */
export async function getStorytellerDecision(room: Room, stepId: string, stepNameZh: string, forceAi = false): Promise<unknown> {
  const req = buildStorytellerRequest(room, stepId, stepNameZh);
  const goodCharacterIds = room.script.characters.filter((c) => c.alignment === 'good').map((c) => c.id);
  const ctx: StorytellerContext = { ...req, goodCharacterIds };
  let raw: unknown = null;

  if ((USE_AI || forceAi) && OPENAI_API_KEY) {
    try {
      raw = await callOpenAI(ctx, stepId);
    } catch (e) {
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
async function callOpenAI(req: StorytellerContext, stepId: string): Promise<unknown> {
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

  const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${t}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty AI response');
  return JSON.parse(content) as unknown;
}
