// [MODIFIED] AI 玩家决策器 - 重构版
// 新增：人设驱动、记忆集成、深度思考链持久化、阵营差异化策略
import type { Room, AiPlayerPersona, AiPlayerMemory, AiThoughtEntry } from '../game/types.js';
import { generateAiPersona, setEvilAllies } from './persona.js';
import {
  createAiMemory,
  addShortTermMemory,
  updateSuspicion,
  recordAiThought,
  getSuspicionRanking,
  getMostSuspicious,
} from './aiMemory.js';

const USE_AI = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'qwen3.6-plus';
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
  /** 只提供"这个座位本该知道的信息" */
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
  // [NEW] 额外上下文
  /** 人设信息 */
  persona?: AiPlayerPersona | null;
  /** 记忆快照 */
  memorySnapshot?: {
    suspicionRanking: Array<{ seat: number; suspicion: number }>;
    recentEvents: Array<{ day: number; phase: string; event: string; source: string }>;
    longTermSummaries: Array<{ day: number; summary: string }>;
  } | null;
  // [MODIFIED] 人类可读字段（用于构建 prompt）
  /** 人类可读的聊天列表 */
  visibleChats?: string[];
  /** 人类可读的存活座位列表 */
  aliveSeats?: string[];
  /** 是否轮到该座位夜晚行动 */
  isNightAction?: boolean;
  /** 夜晚行动步骤 ID */
  nightActionStepId?: string;
  /** 夜晚行动需要选择的目标数 */
  nightActionPick?: 1 | 2;
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
    const inFavor = a.inFavor === true;
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

// [NEW] 带 429 重试和超时控制的 fetch 封装
async function fetchWithRetry(url: string, options: RequestInit, maxRetries: number = 2, timeoutMs: number = 25000): Promise<Response | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) return res;
      if (res.status === 429) {
        // 速率限制：指数退避重试
        const waitMs = Math.pow(2, attempt) * 2000 + Math.random() * 1000;
        console.warn(`  ⏳ LLM 请求 429，等待 ${waitMs.toFixed(0)}ms 后重试 (${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      return res; // 非 429 错误直接返回
    } catch (e) {
      const errMsg = (e as Error).name === 'AbortError' ? '请求超时' : (e as Error).message;
      console.warn(`  ❌ LLM 请求异常: ${errMsg}`);
      if (attempt === maxRetries - 1) return null;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return null;
}

// [NEW] 构建用户提示词（人类可读的自然语言格式）
function buildUserPrompt(
  ctx: AiPlayerContext,
  memorySnapshot: {
    suspicionRanking: Array<{ seat: number; suspicion: number }>;
    recentEvents: Array<{ day: number; phase: string; event: string; source: string }>;
    longTermSummaries: Array<{ day: number; summary: string }>;
  },
  trigger: string
): string {
  const lines: string[] = [];

  lines.push(`## 当前局势`);
  lines.push(`- 你的座位号：${ctx.yourSeatIndex + 1}`);
  lines.push(`- 当前阶段：${trigger}`);

  // [MODIFIED] 支持两种夜晚行动上下文格式
  const isNight = ctx.nightPrompt || ctx.isNightAction;
  if (ctx.nightPrompt) {
    lines.push(`- 这是你的夜晚行动步骤：${ctx.nightPrompt.stepId}`);
    lines.push(`- 你需要选择 ${ctx.nightPrompt.pick} 个目标`);
  } else if (ctx.isNightAction) {
    lines.push(`- 这是你的夜晚行动步骤：${ctx.nightActionStepId}`);
    lines.push(`- 你需要选择 ${ctx.nightActionPick} 个目标`);
  } else if (ctx.currentNomination) {
    lines.push(`- 当前提名：#${ctx.currentNomination.nominator + 1} 提名了 #${ctx.currentNomination.nominated + 1}`);
    lines.push(`- 你需要决定是否投票赞成`);
  }

  lines.push('');
  lines.push('## 存活玩家');
  lines.push(ctx.aliveSeats ? ctx.aliveSeats.join('、') : '无');

  lines.push('');
  lines.push('## 最近聊天');
  if (ctx.visibleChats && ctx.visibleChats.length > 0) {
    lines.push(ctx.visibleChats.join('\n'));
  } else {
    lines.push('暂无聊天');
  }

  lines.push('');
  lines.push('## 你的怀疑排名');
  lines.push(ctx.memorySnapshot?.suspicionRanking
    ? ctx.memorySnapshot.suspicionRanking.map(s => `#${s.seat + 1}: ${(s.suspicion * 100).toFixed(0)}%`).join('、')
    : '暂无怀疑');

  lines.push('');
  lines.push('## 近期事件');
  if (ctx.memorySnapshot?.recentEvents && ctx.memorySnapshot.recentEvents.length > 0) {
    lines.push(ctx.memorySnapshot.recentEvents.map(e => `第${e.day}天 ${e.phase}: ${e.event}`).join('\n'));
  } else {
    lines.push('无历史事件');
  }

  lines.push('');
  lines.push('## 请做出决策');
  lines.push('');
  lines.push('⚠️ 重要：你必须根据当前阶段选择最合适的动作，不要总是聊天！');
  lines.push('');
  lines.push('行动优先级（必须遵守）：');
  // [MODIFIED] 支持两种夜晚行动上下文格式
  if (ctx.nightPrompt || ctx.isNightAction) {
    const stepId = ctx.nightPrompt ? ctx.nightPrompt.stepId : ctx.nightActionStepId;
    lines.push(`- ⚠️ 这是你的夜晚行动！必须选择 night_action！步骤：${stepId}`);
    lines.push(`- 选择 1-2 个座位号作为目标`);
  } else if (ctx.currentNomination) {
    lines.push('- ⚠️ 当前有提名在投票！必须选择 vote（true 赞成 / false 反对）');
  } else {
    lines.push('- 白天阶段：你必须选择 nominate（提名一个怀疑对象）或 skip_nomination（跳过）');
    lines.push('- 不要选 chat_public！模拟环境不支持公开聊天，选了会被视为跳过');
    lines.push('- 如果你有足够的理由怀疑某人，就提名他！如果完全没有方向，就跳过');
  }
  lines.push('');
  lines.push('可选动作类型：');
  lines.push('- noop: 无动作（尽量少用）');
  lines.push('- chat_public: 公开聊天（⚠️ 模拟环境不支持，选了也白选）');
  lines.push('- nominate: 提名 { "nominatedSeat": 座位号(从0开始) }');
  lines.push('- skip_nomination: 跳过提名');
  lines.push('- vote: 投票 { "inFavor": true/false }');
  lines.push('- night_action: 夜晚行动 { "targets": [座位号列表] }');

  return lines.join('\n');
}

// [NEW] 获取或创建 AI 玩家人设
export function getOrCreatePersona(room: Room, seatIndex: number): AiPlayerPersona | null {
  const existing = room.aiPersonaBySeat.get(seatIndex);
  if (existing) return existing;

  const player = room.players[seatIndex];
  if (!player || !player.characterId) return null;

  const char = room.script.characters.find(c => c.id === player.characterId);
  if (!char) return null;

  const persona = generateAiPersona(
    player.characterId,
    char.nameZh,
    char.alignment,
    char.type,
    seatIndex,
    room.players.map(p => p.seatIndex)
  );

  // 设置邪恶队友保护
  if (char.alignment === 'evil') {
    const evilSeats = room.players
      .filter(p => {
        const pChar = room.script.characters.find(c => c.id === p.characterId);
        return pChar && pChar.alignment === 'evil' && p.seatIndex !== seatIndex;
      })
      .map(p => p.seatIndex);
    setEvilAllies(persona, evilSeats, seatIndex);
  }

  room.aiPersonaBySeat.set(seatIndex, persona);
  return persona;
}

// [NEW] 获取或创建 AI 玩家记忆
export function getOrCreateMemory(room: Room, seatIndex: number): AiPlayerMemory {
  const existing = room.aiMemoryBySeat.get(seatIndex);
  if (existing) return existing;

  const memory = createAiMemory();
  room.aiMemoryBySeat.set(seatIndex, memory);
  return memory;
}

// [NEW] 构建思考上下文
function buildThoughtContext(room: Room, seatIndex: number, persona: AiPlayerPersona | null, memory: AiPlayerMemory): AiThoughtEntry['context'] {
  const publicInfo: string[] = [];
  const privateInfo: string[] = [];

  // 公开信息
  publicInfo.push(`第 ${room.dayNumber} 天，阶段：${room.phase}`);
  publicInfo.push(`存活玩家：${room.players.filter(p => p.isAlive).map(p => `#${p.seatIndex + 1}`).join(', ')}`);
  publicInfo.push(`死亡玩家：${room.players.filter(p => !p.isAlive).map(p => `#${p.seatIndex + 1}`).join(', ') || '无'}`);

  // 私有信息
  if (persona) {
    privateInfo.push(`你的角色：${persona.characterNameZh}，阵营：${persona.role === 'good' ? '善良' : '邪恶'}`);
    const bluffTarget = persona.evilStrategy?.bluffTarget;
    if (bluffTarget && typeof bluffTarget === 'string') {
      const bluffChar = room.script.characters.find(c => c.id === bluffTarget);
      privateInfo.push(`你计划伪装成：${bluffChar?.nameZh ?? bluffTarget}`);
    }
  }

  // 怀疑度快照
  const suspicionSnapshot = getSuspicionRanking(memory).slice(0, 5);

  return {
    publicInfo: publicInfo.join('。'),
    privateInfo: privateInfo.join('。'),
    suspicionSnapshot,
  };
}

// [NEW] 根据人设生成情绪标签
function determineEmotion(persona: AiPlayerPersona | null, memory: AiPlayerMemory, trigger: string): string | undefined {
  if (!persona) return undefined;

  const topSuspicion = getMostSuspicious(memory, 1);
  const maxSuspicion = topSuspicion.length > 0 ? (memory.suspicion.get(topSuspicion[0]) ?? 0) : 0;

  if (trigger.includes('死亡') || trigger.includes('处决')) {
    return persona.role === 'evil' ? '暗自庆幸' : '悲伤/紧张';
  }
  if (trigger.includes('被提名')) {
    return maxSuspicion > 0.7 ? '被针对的愤怒' : '困惑/防御';
  }
  if (trigger.includes('夜晚')) {
    return persona.role === 'evil' ? '伺机而动' : '谨慎/期待';
  }
  if (maxSuspicion > 0.8) return '确信/果断';
  if (maxSuspicion > 0.5) return '怀疑/试探';
  return persona.personality.trust > 0.6 ? '信任/放松' : '警惕/观察';
}

// [MODIFIED] 核心决策函数 - 增加人设、记忆、深度思考
export async function decideAiPlayerAction(
  room: Room,
  seatIndex: number,
  ctx: AiPlayerContext,
  temperature: number
): Promise<AiPlayerAction> {
  if (!OPENAI_API_KEY || !USE_AI) return { type: 'noop' };

  // [NEW] 获取/创建人设和记忆
  const persona = getOrCreatePersona(room, seatIndex);
  const memory = getOrCreateMemory(room, seatIndex);

  // [NEW] 构建记忆快照
  const memorySnapshot = {
    suspicionRanking: getSuspicionRanking(memory),
    recentEvents: memory.shortTerm.slice(-15),
    longTermSummaries: memory.longTerm.slice(-3),
  };

  // [NEW] 确定触发事件
  let trigger = '常规回合';
  if (ctx.nightPrompt) {
    trigger = `夜晚行动：${ctx.nightPrompt.stepId}`;
  } else if (ctx.currentNomination) {
    if (ctx.currentNomination.nominated === seatIndex) {
      trigger = '被提名，需要投票';
    } else {
      trigger = '投票阶段';
    }
  }

  // [MODIFIED] 系统提示词 - 大幅增加角色感和策略性
  const bluffTargetName = (() => {
    const bt = persona?.evilStrategy?.bluffTarget;
    if (bt && typeof bt === 'string') {
      return room.script.characters.find(c => c.id === bt)?.nameZh ?? bt;
    }
    return '某个镇民';
  })();

  const roleDesc = persona ? (
    persona.role === 'evil'
      ? `你是邪恶阵营。你的角色是「${persona.characterNameZh}」。你的目标是让恶魔存活到终局（存活人数≤2）。
你必须撒谎、伪装、误导好人。你可以假装是任何善良角色（建议伪装成：${bluffTargetName}）。
你的性格特征：攻击性 ${persona.personality.aggression}，撒谎倾向 ${persona.personality.bluffing}，社交活跃度 ${persona.personality.social}。
策略风格：${persona.strategy === 'logical' ? '逻辑严密，善用推理伪装' : persona.strategy === 'emotional' ? '情绪化表演，博取同情' : '制造混乱，转移注意力'}。`
      : `你是善良阵营。你的角色是「${persona.characterNameZh}」。你的目标是找出并处决恶魔。
你的性格特征：攻击性 ${persona.personality.aggression}，信任度 ${persona.personality.trust}，社交活跃度 ${persona.personality.social}。
策略风格：${persona.strategy === 'logical' ? '基于证据推理，交叉验证信息' : persona.strategy === 'emotional' ? '相信直觉和发言感觉' : '保持灵活，随机应变'}。`
  ) : '你是一个普通玩家。';

  const systemPrompt = [
    `你是血染钟楼的 AI 玩家。${roleDesc}`,
    '',
    '重要规则：',
    '1. 你只能使用提供给你的上下文信息。不知道的事情不要编造。',
    '2. 邪恶阵营：必须撒谎！不要暴露真实身份。伪装成善良角色，编造合理的夜间信息。',
    '3. 善良阵营：诚实分享你获得的信息，但要警惕假信息（可能被投毒/醉酒影响）。',
    '4. 你会犯错：有时候判断错误是正常的。不要追求完美。',
    '5. 投票策略：被提名时通常投反对（除非你确定自己是好人且想自证）。',
    '6. 发言风格：像一个真实玩家，可以有犹豫、猜测、情绪变化。',
    '7. 行动优先：白天阶段必须提名或跳过（不要选 chat_public，模拟环境不支持）。夜晚阶段必须执行行动。',
    '',
    '你必须输出 JSON 格式，包含两部分：',
    '- thinking: 你的完整心路历程（推理过程、怀疑对象、策略思考）',
    '- action: 你的动作选择',
  ].join('\n');

  // [MODIFIED] 用户提示词 - 改用人类可读的自然语言格式
  const userPrompt = buildUserPrompt(ctx, memorySnapshot, trigger);

  try {
    const res = await fetchWithRetry(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt + '\n重要：你必须只输出合法的 JSON 对象，包含 "thinking" 和 "action" 两个字段，不要输出任何其他文字。' },
          { role: 'user', content: userPrompt },
        ],
        temperature: Math.max(0.3, temperature),
        enable_thinking: false,  // [NEW] 关闭思维链，加快响应速度
      }),
    });

    if (!res) {
      console.warn('AI player LLM request failed after retries');
      return { type: 'noop' };
    }
    if (!res.ok) {
      console.warn('AI player LLM request failed:', res.status);
      return { type: 'noop' };
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    let content = data.choices?.[0]?.message?.content;
    if (!content) return { type: 'noop' };

    // [NEW] 处理 markdown 代码块包裹
    content = content.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    const parsed = JSON.parse(content) as { thinking?: string; action?: Record<string, unknown> };

    // [NEW] 记录心路历程
    const thoughtContext = buildThoughtContext(room, seatIndex, persona, memory);
    const emotion = determineEmotion(persona, memory, trigger);

    recordAiThought(
      room,
      seatIndex,
      persona?.characterId ?? 'unknown',
      trigger,
      thoughtContext,
      parsed.thinking ?? '（无思考记录）',
      JSON.stringify(parsed.action ?? { type: 'noop' }),
      emotion
    );

    // 添加到短期记忆
    addShortTermMemory(memory, room.dayNumber, room.phase, `AI 决策：${JSON.stringify(parsed.action)}`, 'chat_god');

    // 验证并返回动作
    return validateAction(room, seatIndex, parsed.action ?? { type: 'noop' });

  } catch (e) {
    console.warn('AI player decision error:', (e as Error).message);
    return { type: 'noop' };
  }
}
