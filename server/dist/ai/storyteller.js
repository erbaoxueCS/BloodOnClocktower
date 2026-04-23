import { buildStorytellerRequest } from './adapter.js';
import { randomStorytellerDecision } from '../game/gameEngine.js';
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
function getApiKey() {
    return (process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '').trim();
}
export function getStorytellerLlmKeyInfo() {
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
export async function storytellerLlmSelfTest(params) {
    const startedAt = Date.now();
    const key = getStorytellerLlmKeyInfo();
    if (!key.present)
        return { ok: false, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, error: 'missing_api_key' };
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
        const data = (await res.json());
        return { ok: true, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, raw: data };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, error: msg };
    }
}
/**
 * 校验决策：玩家座位合法、角色在剧本中
 */
export function validateDecision(room, stepId, decision) {
    if (!decision || typeof decision !== 'object')
        return null;
    const d = decision;
    const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));
    if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
        if (stepId === 'librarian' && d.noOutsider === true) {
            const noOutsider = { type: 'librarian_result', noOutsider: true };
            return noOutsider;
        }
        const type = `${stepId}_result`;
        const players = d.players;
        const characterId = d.characterId;
        if (!Array.isArray(players) || players.length !== 2 || typeof characterId !== 'string')
            return null;
        const [a, b] = players;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a === b)
            return null;
        if (!aliveSeats.has(a) || !aliveSeats.has(b))
            return null;
        const char = room.script.characters.find((c) => c.id === characterId);
        if (!char)
            return null;
        if (stepId === 'washerwoman' && !(char.alignment === 'good' && char.type === 'townsfolk'))
            return null;
        if (stepId === 'librarian' && !(char.alignment === 'good' && char.type === 'outsider'))
            return null;
        if (stepId === 'investigator' && !(char.alignment === 'evil' && char.type === 'minion'))
            return null;
        return { type: `${stepId}_result`, players: [a, b], characterId };
    }
    if (stepId === 'imp') {
        const targetSeatIndex = d.targetSeatIndex;
        if (typeof targetSeatIndex !== 'number' || !aliveSeats.has(targetSeatIndex))
            return null;
        return { type: 'imp_kill', targetSeatIndex };
    }
    return null;
}
/**
 * 将引擎使用的 decision 格式转为 storytellerDecisions 写入格式
 */
export function toEngineDecision(room, stepId, validated) {
    if (stepId === 'librarian' && 'noOutsider' in validated && validated.noOutsider === true) {
        return { type: 'librarian_result', noOutsider: true };
    }
    if (validated.type === 'imp_kill')
        return validated.targetSeatIndex;
    return {
        type: validated.type,
        players: validated.players,
        characterId: validated.characterId,
    };
}
/**
 * 调用 AI 获取说书人决策；失败或未配置时回退到随机
 */
export async function getStorytellerDecision(room, stepId, stepNameZh, forceAi = false, onDebug) {
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
    const ctx = {
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
    let raw = null;
    const apiKey = getApiKey();
    if ((USE_AI || forceAi) && apiKey) {
        try {
            raw = await callOpenAI(ctx, stepId, apiKey, onDebug);
        }
        catch (e) {
            onDebug?.({
                kind: 'error',
                stepId,
                model: OPENAI_MODEL,
                error: e instanceof Error ? e.message : String(e),
            });
            console.warn('AI storyteller request failed, using random:', e.message);
        }
    }
    const validated = raw ? validateDecision(room, stepId, raw) : null;
    if (validated) {
        return toEngineDecision(room, stepId, validated);
    }
    return randomStorytellerDecision(room);
}
const STEP_NAMES = {
    washerwoman: '洗衣妇',
    librarian: '图书管理员',
    investigator: '调查员',
};
function getStepNameZh(stepId) {
    return STEP_NAMES[stepId] ?? stepId;
}
/**
 * 调用 OpenAI Chat Completions（JSON mode）
 */
async function callOpenAI(req, stepId, apiKey, onDebug) {
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
    const poisonHint = req.poisonedSeatIndex != null ? `注意：座位 ${req.poisonedSeatIndex} 当晚可能因投毒而不清醒（仅据此调整叙事节奏，勿在回复中提及「中毒」字样）。` : '';
    const typeScopedIds = stepId === 'washerwoman'
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
    const data = (await res.json());
    const content = data.choices?.[0]?.message?.content;
    if (!content)
        throw new Error('Empty AI response');
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
    return JSON.parse(content);
}
function validateNightTargets(input, raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const d = raw;
    const targets = d.targets;
    if (!Array.isArray(targets) || targets.length !== input.pick)
        return null;
    const alive = new Set(input.aliveSeatIndices);
    for (const t of targets) {
        if (!Number.isInteger(t) || !alive.has(t))
            return null;
    }
    if (input.pick === 2 && targets[0] === targets[1])
        return null;
    return targets;
}
function randomNightTargets(input) {
    const alive = [...input.aliveSeatIndices];
    const out = [];
    for (let i = 0; i < input.pick; i++) {
        const remain = alive.filter((x) => !out.includes(x));
        if (remain.length === 0)
            break;
        out.push(remain[Math.floor(Math.random() * remain.length)]);
    }
    return out.length === input.pick ? out : alive.slice(0, input.pick);
}
export async function getStorytellerMediatedNightTargets(room, input, forceAi = false, onDebug) {
    const apiKey = getApiKey();
    const enabled = (USE_AI || forceAi) && !!apiKey;
    const fallback = Array.isArray(input.playerSuggestedTargets)
        && input.playerSuggestedTargets.length === input.pick
        ? input.playerSuggestedTargets
        : randomNightTargets(input);
    if (!enabled || !apiKey)
        return fallback;
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
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content;
        if (!content)
            throw new Error('Empty AI response');
        onDebug?.({
            kind: 'response',
            stepId: input.stepId,
            model: OPENAI_MODEL,
            rawResponse: content,
            elapsedMs: Date.now() - startedAt,
        });
        let parsed = null;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            parsed = null;
        }
        const v = validateNightTargets(input, parsed);
        return v ?? fallback;
    }
    catch (e) {
        onDebug?.({
            kind: 'error',
            stepId: input.stepId,
            model: OPENAI_MODEL,
            error: e instanceof Error ? e.message : String(e),
        });
        return fallback;
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function answerPostGameQuestion(room, seatIndex, question) {
    const q = String(question ?? '').trim();
    if (!q)
        return '上帝：你的问题是空的，请具体描述你想复盘的环节。';
    const apiKey = getApiKey();
    if (!apiKey) {
        return '上帝：当前未配置大模型密钥，无法生成复盘解释。你可以先配置 OPENAI_API_KEY 后再提问。';
    }
    const systemPrompt = [
        '你是《血染钟楼》的复盘上帝。',
        '对局已经结束，现在只做事实复盘与规则解释，不接管游戏流程。',
        '你必须基于提供的真实身份、聊天记录、投票与复盘日志作答。',
        '回答要具体、可核查，必要时点明“是哪一晚/哪一步/哪个座位”导致差异。',
        '请输出纯文本，不要 markdown。',
    ].join('\n');
    const players = room.players.map((p) => {
        const meta = p.characterId ? room.script.characters.find((c) => c.id === p.characterId) : null;
        return {
            seatIndex: p.seatIndex,
            nickname: p.nickname,
            isAlive: p.isAlive,
            characterId: p.characterId ?? null,
            characterNameZh: meta?.nameZh ?? null,
            alignment: meta?.alignment ?? null,
        };
    });
    const userPrompt = JSON.stringify({
        question: q,
        roomId: room.id,
        scriptNameZh: room.script.nameZh,
        askerSeatIndex: seatIndex,
        endedState: {
            status: room.status,
            phase: room.phase,
            dayNumber: room.dayNumber,
        },
        truth: {
            players,
            demonBluffs: room.demonBluffs ?? [],
        },
        fullChatLog: room.chatLog.slice(-300),
        replayLog: room.replayLog.slice(-500),
        voteSnapshot: {
            currentNomination: room.currentNomination,
            votes: Array.from(room.votes.entries()).map(([s, v]) => ({ seatIndex: s, inFavor: v })),
            nominationsToday: Array.from(room.nominationsToday.entries()).map(([nominator, nominated]) => ({ nominator, nominated })),
            skippedNominationsToday: Array.from(room.skippedNominationsToday.values()),
        },
        requirement: [
            '先直接回答问题结论',
            '再给出依据（关键事件/日志）',
            '若问题前提有误，请指出并纠正',
        ],
    });
    const ac = new AbortController();
    const timeoutMs = Number(process.env.AI_STORYTELLER_TIMEOUT_MS ?? '') || 240_000;
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
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                temperature: 0.3,
                ...fastResponseOptions(),
            }),
            signal: ac.signal,
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            return `上帝：复盘回答失败（${res.status}）。${t.slice(0, 120)}`;
        }
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content)
            return '上帝：我没有生成有效答案，请换个问法再试一次。';
        return content.slice(0, 3000);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `上帝：复盘回答异常（${msg}）。请稍后重试。`;
    }
    finally {
        clearTimeout(timeout);
    }
}
