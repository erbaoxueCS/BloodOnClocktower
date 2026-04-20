// [MODIFIED] AI 说书人决策器 - 扩展裁量点
// 原则：不干预固定能力的事实（如恶魔未中毒则 100% 刀中）
import type { Room } from '../game/types.js';
import type { StorytellerRequest, StorytellerDecision, ChoiceTwoPlayersOneCharacter, DemonKillChoice, PoisonerChoice, FortuneTellerChoice, MonkChoice } from './types.js';
import { buildStorytellerRequest } from './adapter.js';
import { randomStorytellerDecision } from '../game/gameEngine.js';

/** 供 AI 使用的请求上下文中需包含可选善良角色 id 列表 */
export interface StorytellerContext extends StorytellerRequest {
  goodCharacterIds: string[];
}

const USE_AI = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'qwen3.6-plus';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com').replace(/\/+$/, '');

// [NEW] 扩展校验逻辑
export function validateDecision(room: Room, stepId: string, decision: unknown): StorytellerDecision | null {
  if (!decision || typeof decision !== 'object') return null;
  const d = decision as Record<string, unknown>;
  const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));

  // 洗衣妇/图书管理员/调查员
  if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
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

  // [NEW] 恶魔杀人
  if (stepId === 'imp') {
    const targetSeatIndex = d.targetSeatIndex as number | undefined;
    if (typeof targetSeatIndex !== 'number' || !aliveSeats.has(targetSeatIndex)) return null;
    return { type: 'imp_kill', targetSeatIndex } as DemonKillChoice;
  }

  // [NEW] 投毒者
  if (stepId === 'poisoner') {
    const targetSeatIndex = d.targetSeatIndex as number | undefined;
    if (typeof targetSeatIndex !== 'number' || !aliveSeats.has(targetSeatIndex)) return null;
    return { type: 'poisoner_target', targetSeatIndex } as PoisonerChoice;
  }

  // [NEW] 占卜师结果
  if (stepId === 'fortune_teller') {
    const targetSeats = d.targetSeats as number[] | undefined;
    const hasDemon = d.hasDemon as boolean | undefined;
    if (!Array.isArray(targetSeats) || targetSeats.length !== 2 || typeof hasDemon !== 'boolean') return null;
    const [a, b] = targetSeats;
    if (!aliveSeats.has(a) || !aliveSeats.has(b)) return null;
    return { type: 'fortune_teller_result', targetSeats: [a, b], hasDemon } as FortuneTellerChoice;
  }

  // [NEW] 僧侣保护
  if (stepId === 'monk') {
    const targetSeatIndex = d.targetSeatIndex as number | undefined;
    if (typeof targetSeatIndex !== 'number' || !aliveSeats.has(targetSeatIndex)) return null;
    return { type: 'monk_protect', targetSeatIndex } as MonkChoice;
  }

  return null;
}

export function toEngineDecision(room: Room, stepId: string, validated: StorytellerDecision): unknown {
  if (validated.type === 'imp_kill') return validated.targetSeatIndex;
  if (validated.type === 'poisoner_target') return validated.targetSeatIndex;
  if (validated.type === 'fortune_teller_result') return validated.hasDemon;
  if (validated.type === 'monk_protect') return validated.targetSeatIndex;
  if (validated.type === 'demon_bluff') return validated.bluffCharacterIds;
  // 洗衣妇/图书管理员/调查员
  if ('players' in validated && 'characterId' in validated) {
    return { type: validated.type, players: (validated as ChoiceTwoPlayersOneCharacter).players, characterId: (validated as ChoiceTwoPlayersOneCharacter).characterId };
  }
  return validated;
}

/**
 * 调用 AI 获取说书人决策；失败或未配置时回退到随机
 * [MODIFIED] 支持更多步骤类型
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
  // [NEW]
  poisoner: '投毒者',
  fortune_teller: '占卜师',
  monk: '僧侣',
  imp: '恶魔（小恶魔）',
};

function getStepNameZh(stepId: string): string {
  return STEP_NAMES[stepId] ?? stepId;
}

/**
 * 调用 OpenAI Chat Completions（JSON mode）
 * [MODIFIED] 支持更多步骤类型的 prompt
 */
async function callOpenAI(req: StorytellerContext, stepId: string): Promise<unknown> {
  // 确定 schema
  let schema: Record<string, unknown>;
  let userPrompt: string;

  if (['washerwoman', 'librarian', 'investigator'].includes(stepId)) {
    schema = {
      type: 'object',
      properties: {
        players: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        characterId: { type: 'string' }
      },
      required: ['players', 'characterId']
    };
    const goodIdList = req.goodCharacterIds?.length ? `合法 characterId 只能从下列善良方角色中选：${req.goodCharacterIds.join(',')}。` : '';
    userPrompt = `剧本：${req.scriptNameZh}。当前为第${req.dayNumber}天夜晚，步骤：${getStepNameZh(stepId)}。需要选择两名存活玩家（座位号）和其中一个善良方角色 identity（characterId）。存活座位号：${req.aliveSeatIndices.join(',')}。${goodIdList}${req.poisonedSeatIndex != null ? `\n注意：座位 ${req.poisonedSeatIndex} 当晚可能因投毒而不清醒。` : ''}\n回复格式：{"players":[座位1,座位2],"characterId":"角色id"}`;
  } else if (stepId === 'imp') {
    schema = {
      type: 'object',
      properties: { targetSeatIndex: { type: 'integer' } },
      required: ['targetSeatIndex']
    };
    userPrompt = `剧本：${req.scriptNameZh}。恶魔选择一名存活玩家杀害（可选择自己自杀以传位爪牙）。存活座位号：${req.aliveSeatIndices.join(',')}。${req.poisonedSeatIndex != null ? `\n注意：恶魔座位 ${req.poisonedSeatIndex} 被投毒，刀人不可靠。` : '恶魔未中毒，刀人 100% 成功。'}\n回复格式：{"targetSeatIndex":座位号}`;
  } else if (stepId === 'poisoner') {
    schema = {
      type: 'object',
      properties: { targetSeatIndex: { type: 'integer' } },
      required: ['targetSeatIndex']
    };
    userPrompt = `剧本：${req.scriptNameZh}。投毒者选择一名存活玩家投毒。存活座位号：${req.aliveSeatIndices.join(',')}。投毒后该玩家当晚能力失效/信息错误。\n回复格式：{"targetSeatIndex":座位号}`;
  } else if (stepId === 'fortune_teller') {
    schema = {
      type: 'object',
      properties: {
        targetSeats: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        hasDemon: { type: 'boolean' }
      },
      required: ['targetSeats', 'hasDemon']
    };
    userPrompt = `剧本：${req.scriptNameZh}。占卜师选择了两名玩家，你需要决定告诉他是否有恶魔。存活座位号：${req.aliveSeatIndices.join(',')}。如果占卜师被投毒，应返回错误信息。\n回复格式：{"targetSeats":[座位1,座位2],"hasDemon":true/false}`;
  } else if (stepId === 'monk') {
    schema = {
      type: 'object',
      properties: { targetSeatIndex: { type: 'integer' } },
      required: ['targetSeatIndex']
    };
    userPrompt = `剧本：${req.scriptNameZh}。僧侣选择一名存活玩家保护（恶魔无法杀死该玩家）。存活座位号：${req.aliveSeatIndices.join(',')}。\n回复格式：{"targetSeatIndex":座位号}`;
  } else {
    // 默认 schema
    schema = {
      type: 'object',
      properties: { targetSeatIndex: { type: 'integer' } },
      required: ['targetSeatIndex']
    };
    userPrompt = `剧本：${req.scriptNameZh}。当前步骤：${getStepNameZh(stepId)}。存活座位号：${req.aliveSeatIndices.join(',')}。\n回复格式：{"targetSeatIndex":座位号}`;
  }

  const systemPrompt = `你是血染钟楼的说书人。请根据「平衡局势、增进体验、让对局更跌宕起伏」的原则做选择。
重要原则：
1. 不要干预固定能力的事实（如恶魔未中毒则 100% 刀中，僧侣保护的人恶魔杀不死）。
2. 中毒/醉酒时，可以返回错误信息或随机目标。
3. 尽量让局势保持悬念，不要让一方过早锁定胜局。
4. 参考历史决策保持一致性。
只输出合法 JSON，不要解释。`;

  const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt + '\n重要：你必须只输出合法的 JSON 对象，不要输出任何其他文字。' },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,
      enable_thinking: false,  // [NEW] 关闭思维链，加快响应速度
    }),
  });

  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');

  // [NEW] 处理 markdown 代码块包裹
  content = content.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

  return JSON.parse(content);
}
