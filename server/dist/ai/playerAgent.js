// AI 玩家与 AI 说书人解耦：默认沿用 USE_AI_STORYTELLER，但可用 USE_AI_PLAYER 单独开关
const USE_AI_PLAYER = (process.env.USE_AI_PLAYER ?? process.env.USE_AI_STORYTELLER ?? '') === 'true'
    || (process.env.USE_AI_PLAYER ?? process.env.USE_AI_STORYTELLER ?? '') === '1';
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
function getApiKey() {
    // 兼容常见命名：OPENAI_API_KEY / DASHSCOPE_API_KEY
    return (process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '').trim();
}
export function getAiPlayerLlmKeyInfo() {
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
export async function aiPlayerLlmSelfTest(params) {
    const startedAt = Date.now();
    const key = getAiPlayerLlmKeyInfo();
    if (!key.present)
        return { ok: false, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, error: 'missing_api_key' };
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
        const data = (await res.json());
        return { ok: true, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, raw: data };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, ms: Date.now() - startedAt, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, key, error: msg };
    }
}
function buildDefaultPublicText(ctx) {
    const nightInfoLen = Array.isArray(ctx.nightInfo) ? ctx.nightInfo.length : 0;
    if (ctx.yourAlignment === 'good' && nightInfoLen > 0) {
        return '我这边有夜间信息支撑，今天建议优先推进一名高嫌疑目标进入提名和投票。';
    }
    if (ctx.yourAlignment === 'evil') {
        return '我先给出当前判断：优先处理发言矛盾最大的目标，避免分票。';
    }
    return '先对齐关键信息，再集中推进一个最高嫌疑目标。';
}
function validateAction(room, seatIndex, raw) {
    if (!raw || typeof raw !== 'object')
        return { type: 'noop' };
    const a = raw;
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
        const toSeatRaw = a.toSeat;
        if (!text || !Number.isInteger(toSeatRaw))
            return { type: 'noop' };
        const toSeat = toSeatRaw;
        if (toSeat === seatIndex)
            return { type: 'noop' };
        if (!room.players[toSeat])
            return { type: 'noop' };
        return { type: 'chat_dm', toSeat, text: text.slice(0, 500) };
    }
    if (t === 'nominate') {
        const nominatedSeatRaw = a.nominatedSeat;
        if (!Number.isInteger(nominatedSeatRaw))
            return { type: 'noop' };
        const nominatedSeat = nominatedSeatRaw;
        if (!aliveSeats.has(nominatedSeat))
            return { type: 'noop' };
        return { type: 'nominate', nominatedSeat };
    }
    if (t === 'skip_nomination')
        return { type: 'skip_nomination' };
    if (t === 'vote') {
        const inFavor = !!a.inFavor;
        return { type: 'vote', inFavor };
    }
    if (t === 'day_action') {
        const actionId = String(a.actionId ?? '');
        const targetSeat = a.targetSeat;
        if (!actionId)
            return { type: 'noop' };
        if (targetSeat !== undefined && !Number.isInteger(targetSeat))
            return { type: 'noop' };
        return { type: 'day_action', actionId, targetSeat };
    }
    if (t === 'night_action') {
        const targets = a.targets;
        if (!Array.isArray(targets) || targets.some((x) => !Number.isInteger(x) || !aliveSeats.has(x)))
            return { type: 'noop' };
        return { type: 'night_action', targets };
    }
    if (t === 'night_confirm')
        return { type: 'night_confirm' };
    return { type: 'noop' };
}
function validateDayPlan(room, seatIndex, raw, ctx) {
    if (!raw || typeof raw !== 'object')
        return { type: 'noop' };
    const a = raw;
    if (String(a.type ?? '') !== 'day_plan')
        return { type: 'noop' };
    const aliveSeats = new Set(room.players.filter((p) => p.isAlive).map((p) => p.seatIndex));
    const dmRaw = Array.isArray(a.dm) ? a.dm : [];
    const dmMap = new Map();
    for (const x of dmRaw) {
        if (!x || typeof x !== 'object')
            continue;
        const r = x;
        const toSeat = Number(r.toSeat);
        const text = String(r.text ?? '').trim();
        if (!Number.isInteger(toSeat) || !text)
            continue;
        if (toSeat === seatIndex)
            continue;
        if (!room.players[toSeat])
            continue;
        dmMap.set(toSeat, text.slice(0, 500));
    }
    const dm = Array.from(dmMap.entries()).map(([toSeat, text]) => ({ toSeat, text }));
    const pubText = String(a.public?.text ?? '').trim().slice(0, 500);
    const dayNumber = Number(ctx.roomView?.dayNumber ?? -1);
    const isEarlyDay = Number.isFinite(dayNumber) && dayNumber <= 2;
    const selfEvilReveal = /(我是|我就是|身份是).*(恶魔|爪牙|imp|poisoner|baron|scarlet_woman|spy)/i.test(pubText);
    const publicPart = pubText
        ? {
            text: (ctx.yourAlignment === 'evil' && isEarlyDay && selfEvilReveal)
                ? '我先不做身份自证，先按发言矛盾和票型推进一个可执行目标。'
                : pubText,
        }
        : { text: buildDefaultPublicText(ctx) };
    const godText = String(a.godQuestion?.text ?? '').trim().slice(0, 200);
    const nominationRaw = a.nomination;
    let nomination;
    if (nominationRaw && typeof nominationRaw === 'object' && String(nominationRaw.type ?? '') === 'nominate') {
        const targetSeat = nominationRaw.targetSeat;
        const tOk = Number.isInteger(targetSeat) && aliveSeats.has(targetSeat);
        nomination = tOk ? { type: 'nominate', targetSeat: targetSeat } : { type: 'skip' };
    }
    else {
        nomination = { type: 'skip' };
    }
    const voteRaw = a.vote;
    const inFavor = !!(voteRaw && typeof voteRaw === 'object' ? voteRaw.inFavor : false);
    const reason = voteRaw && typeof voteRaw === 'object' ? String(voteRaw.reason ?? '').slice(0, 120) : '';
    const priorityExecuteSeats = voteRaw && typeof voteRaw === 'object' && Array.isArray(voteRaw.priorityExecuteSeats)
        ? voteRaw.priorityExecuteSeats
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
export function aiPlayerLlmAvailable() {
    return !!getApiKey() && !!USE_AI_PLAYER;
}
export async function decideAiPlayerDayPlan(room, seatIndex, ctx, temperature, onDebug) {
    const apiKey = getApiKey();
    if (!apiKey || !USE_AI_PLAYER)
        return { type: 'noop' };
    const inflightKey = `ai_player_dayplan_inflight_${seatIndex}`;
    if (room.storytellerDecisions.get(inflightKey) === true)
        return { type: 'noop' };
    room.storytellerDecisions.set(inflightKey, true);
    const threadKey = `ai_player_dayplan_thread_${seatIndex}`;
    const v = room.storytellerDecisions.get(threadKey);
    const thread = Array.isArray(v) ? v : [];
    const systemPrompt = [
        '你是《血染钟楼（暗流涌动）》中的单座位 AI 玩家。',
        '你只代表自己的座位，不是上帝，不是裁判，不可修改游戏状态。',
        '核心目标：在“当前阶段合法动作”内，提高己方阵营胜率，同时保持发言与行动自洽。',
        '胜利条件：善良=恶魔死亡；邪恶=存活玩家<=2且善良未先胜。',
        '你只能使用当前局内输入，不得使用跨局长期记忆或臆测隐藏信息。',
        '本局上下文会提供全场公开/私聊/上帝对话、投票与存活状态，请用这些信息做结构化推理，而不是口号式发言。',
        '请输出可执行 JSON（不需要解释文本和 markdown）。',
        '白天计划应尽量保持人设与立场一致，可渐进调整。',
        '邪恶阵营可使用 demonBluffs 维持伪装一致性，但不可自相矛盾。',
        '策略建议：开局阶段（尤其 Day1）公开自曝恶魔/爪牙通常是低收益；只有在明确高收益场景才考虑反向自曝/替挡刀。',
        'demonBluffs 是私有伪装参考，不应公开成“信息来源”。',
        '规则范围内允许多样博弈，请基于局势做收益判断，不要机械套模板。',
        '若你是有信息的好人（如占卜师/共情者/厨师/送葬者等）且已有夜间信息，默认应更主动推进：公开关键矛盾、推动提名、推动形成处决共识。',
    ].join('\n');
    const userPrompt = JSON.stringify({
        instruction: '现在是白天，请输出 day_plan：先私聊(0~2条)→公开发言(1条)→提名倾向→投票倾向。信息不足时可保守。',
        outputSchema: {
            day_plan: {
                type: 'day_plan',
                godQuestion: { text: 'string(optional)' },
                dm: [{ toSeat: 'number', text: 'string' }],
                public: { text: 'string' },
                nomination: { type: 'nominate|skip', targetSeat: 'number(if nominate)' },
                vote: { inFavor: 'boolean', reason: 'string(optional)', priorityExecuteSeats: 'number[](optional, 1~3)' },
            },
            noop: { type: 'noop' },
        },
        outputRules: [
            'dm 用于私聊策略：按需给出若干 {toSeat,text}。只给“你确实想沟通”的对象；没必要沟通的人可不写。',
            '同一个 toSeat 最多提供一条核心私聊内容，文本简短具体。',
            '为匹配当前引擎编排，请给出 1 条 public（可简短保守）。',
            'nominate 时 targetSeat 需是合法存活座位；否则选择 skip。',
            'vote 需给出 priorityExecuteSeats（1~3个优先出人目标）；投票时应优先按该名单决定是否赞成处决。',
            '若你是邪恶阵营：白天早期 public 发言一般不建议自曝恶魔/爪牙，也不建议公开三张不在场角色来源。',
            '若你是有信息的好人且已有夜间信息：nomination 默认倾向 nominate，而不是长期 skip。',
            '只输出 JSON。',
        ],
        context: ctx,
    });
    const messages = [
        { role: 'system', content: systemPrompt },
        ...thread.slice(-6),
        { role: 'user', content: userPrompt },
    ];
    onDebug?.({
        stage: 'day_plan',
        kind: 'request',
        seatIndex,
        systemPrompt,
        userPrompt,
        messages,
    });
    try {
        const startedAt = Date.now();
        if (AI_PLAYER_LLM_LOG) {
            console.log(`[ai_player] day_plan input seat=${seatIndex}`, {
                dayNumber: ctx.roomView?.dayNumber,
                phase: ctx.roomView?.phase,
                yourAlignment: ctx.yourAlignment,
                hasBluffs: Array.isArray(ctx.demonBluffs) ? ctx.demonBluffs.length : 0,
                baseUrl: OPENAI_BASE_URL,
                model: OPENAI_MODEL,
            });
            // 打印可复现的输入（截断）：便于确认“到底喂给模型了什么”
            console.log(`[ai_player] day_plan input_prompt seat=${seatIndex}`, userPrompt.slice(0, 2400));
        }
        const ac = new AbortController();
        const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 240_000;
        const timeout = setTimeout(() => ac.abort(), timeoutMs);
        const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages,
                response_format: { type: 'json_object' },
                temperature: Math.min(1, Math.max(0, temperature)),
                ...fastResponseOptions(),
            }),
            signal: ac.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            if (AI_PLAYER_LLM_LOG) {
                console.warn(`[ai_player] day_plan not ok seat=${seatIndex} status=${res.status} ms=${Date.now() - startedAt} timeoutMs=${timeoutMs} body=${t.slice(0, 600)}`);
            }
            return { type: 'noop' };
        }
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content;
        if (!content)
            return { type: 'noop' };
        onDebug?.({
            stage: 'day_plan',
            kind: 'response',
            seatIndex,
            rawResponse: content,
            elapsedMs: Date.now() - startedAt,
        });
        if (AI_PLAYER_LLM_LOG) {
            console.log(`[ai_player] day_plan output seat=${seatIndex} ms=${Date.now() - startedAt}`, content.slice(0, 2400));
        }
        let parsed = null;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            parsed = null;
        }
        thread.push({ role: 'user', content: userPrompt });
        thread.push({ role: 'assistant', content });
        room.storytellerDecisions.set(threadKey, thread.slice(-12));
        return validateDayPlan(room, seatIndex, parsed, ctx);
    }
    catch {
        onDebug?.({
            stage: 'day_plan',
            kind: 'error',
            seatIndex,
            error: 'llm_request_failed',
        });
        return { type: 'noop' };
    }
    finally {
        room.storytellerDecisions.set(inflightKey, false);
    }
}
/**
 * 夜晚轮到本座行动时专用：仅允许 `night_action`，避免在同一轮 LLM 中混出聊天/投票等行为。
 */
export async function decideAiPlayerNightTargets(room, seatIndex, ctx, temperature, onDebug) {
    const apiKey = getApiKey();
    if (!apiKey || !USE_AI_PLAYER)
        return { type: 'noop' };
    if (!ctx.nightPrompt)
        return { type: 'noop' };
    const inflightKey = `ai_player_night_inflight_${seatIndex}`;
    if (room.storytellerDecisions.get(inflightKey) === true)
        return { type: 'noop' };
    room.storytellerDecisions.set(inflightKey, true);
    const threadKey = `ai_player_night_thread_${seatIndex}`;
    const v = room.storytellerDecisions.get(threadKey);
    const thread = Array.isArray(v) ? v : [];
    const stepZh = room.script.characters.find((c) => c.id === ctx.nightPrompt.stepId)?.nameZh ?? ctx.nightPrompt.stepId;
    const pick = ctx.nightPrompt.pick;
    const systemPrompt = [
        '你是《血染钟楼（暗流涌动）》中的单座位 AI 玩家。',
        '你当前只允许做一件事：输出 night_action 目标选择。',
        '仅输出 JSON：{"type":"night_action","targets":[...]}。',
        `targets 数量必须等于 ${pick}，且都在 nightPrompt.aliveSeatIndices 内。`,
        '当 pick=2 时，两个目标必须不同。',
        '禁止输出聊天、提名、投票、night_confirm、noop 或其他 type。',
        '策略目标是提高己方阵营胜率，不得假设未提供的信息。',
    ].join('\n');
    const userPrompt = JSON.stringify({
        instruction: `当前夜晚步骤：${stepZh}（${ctx.nightPrompt.stepId}）。请选择能力目标。`,
        outputSchema: { night_action: { type: 'night_action', targets: `number[${pick}]` } },
        nightPrompt: ctx.nightPrompt,
        context: {
            roomView: ctx.roomView,
            yourSeatIndex: ctx.yourSeatIndex,
            yourRole: ctx.yourRole,
            yourCharacterId: ctx.yourCharacterId,
            yourAlignment: ctx.yourAlignment,
            demonBluffs: ctx.demonBluffs,
            nightInfo: ctx.nightInfo,
            chatLog: (ctx.chatLog ?? []).slice(-12),
        },
    });
    const messages = [
        { role: 'system', content: systemPrompt },
        ...thread.slice(-6),
        { role: 'user', content: userPrompt },
    ];
    onDebug?.({
        stage: 'night_action',
        kind: 'request',
        seatIndex,
        systemPrompt,
        userPrompt,
        messages,
    });
    try {
        const startedAt = Date.now();
        if (AI_PLAYER_LLM_LOG) {
            console.log(`[ai_player] night_targets input seat=${seatIndex}`, {
                stepId: ctx.nightPrompt.stepId,
                pick: ctx.nightPrompt.pick,
                ms: Date.now() - startedAt,
            });
            console.log(`[ai_player] night_targets input_prompt seat=${seatIndex}`, userPrompt.slice(0, 2400));
        }
        const ac = new AbortController();
        const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 240_000;
        const timeout = setTimeout(() => ac.abort(), timeoutMs);
        const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages,
                response_format: { type: 'json_object' },
                temperature: Math.min(1, Math.max(0, temperature)),
                ...fastResponseOptions(),
            }),
            signal: ac.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            if (AI_PLAYER_LLM_LOG) {
                console.warn(`[ai_player] night_targets not ok seat=${seatIndex} status=${res.status} body=${t.slice(0, 400)}`);
            }
            return { type: 'noop' };
        }
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content;
        if (!content)
            return { type: 'noop' };
        onDebug?.({
            stage: 'night_action',
            kind: 'response',
            seatIndex,
            rawResponse: content,
            elapsedMs: Date.now() - startedAt,
        });
        if (AI_PLAYER_LLM_LOG) {
            console.log(`[ai_player] night_targets output seat=${seatIndex} ms=${Date.now() - startedAt}`, content.slice(0, 2400));
        }
        let parsed = null;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            parsed = null;
        }
        thread.push({ role: 'user', content: userPrompt });
        thread.push({ role: 'assistant', content });
        room.storytellerDecisions.set(threadKey, thread.slice(-12));
        const act = validateAction(room, seatIndex, parsed);
        if (act.type !== 'night_action')
            return { type: 'noop' };
        if (act.targets.length !== pick)
            return { type: 'noop' };
        if (pick === 2 && act.targets[0] === act.targets[1])
            return { type: 'noop' };
        return act;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[ai_player] night_targets failed seat=${seatIndex}: ${msg}`);
        onDebug?.({
            stage: 'night_action',
            kind: 'error',
            seatIndex,
            error: msg,
        });
        return { type: 'noop' };
    }
    finally {
        room.storytellerDecisions.set(inflightKey, false);
    }
}
export async function answerPostGamePlayerQuestion(room, targetSeatIndex, askerSeatIndex, question) {
    const q = String(question ?? '').trim();
    if (!q)
        return '该玩家：你的问题是空的，请具体一点。';
    const target = room.players[targetSeatIndex];
    if (!target)
        return '该玩家：目标座位不存在。';
    const apiKey = getApiKey();
    if (!apiKey) {
        return '该玩家：当前未配置大模型密钥，无法生成复盘解释。';
    }
    const roleMeta = target.characterId
        ? room.script.characters.find((c) => c.id === target.characterId)
        : null;
    const roleNameZh = roleMeta?.nameZh ?? target.characterId ?? '未知身份';
    const alignment = roleMeta?.alignment ?? 'unknown';
    const selfNightInfo = room.storytellerDecisions.get('night_info_log_by_seat')?.get(targetSeatIndex) ?? [];
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
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content)
            return '该玩家：我这次没能组织出有效复盘答案。';
        return content.slice(0, 3000);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `该玩家：复盘回答异常（${msg}）。`;
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function decideAiPlayerAction(room, seatIndex, ctx, temperature) {
    const apiKey = getApiKey();
    if (!apiKey || !USE_AI_PLAYER)
        return { type: 'noop' };
    if (ctx.nightPrompt != null) {
        return { type: 'noop' };
    }
    // 单座位串行：同一个座位上一请求未结束，不再发起下一次调用
    const inflightKey = `ai_player_inflight_${seatIndex}`;
    if (room.storytellerDecisions.get(inflightKey) === true)
        return { type: 'noop' };
    room.storytellerDecisions.set(inflightKey, true);
    // 每个座位独立线程：放在 room.storytellerDecisions，避免跨座位泄露
    const threadKey = `ai_player_thread_${seatIndex}`;
    const v = room.storytellerDecisions.get(threadKey);
    const thread = Array.isArray(v) ? v : [];
    const systemPrompt = [
        '你是血染钟楼的“AI 玩家”，你只代表一个座位行动。',
        '重要：你只能使用提供给你的上下文（roomView/yourRole/chatLog/nightInfo/nightPrompt）。',
        '你不知道其他玩家的真实身份，也看不到其他人的上帝私聊与私聊内容（除非在 chatLog 中出现）。',
        '你必须严格避免暗示你知道未提供的信息。',
        '你要做的事：理解自己获得的信息，与他人交流（公开/私聊/上帝），并在允许时提名、投票、使用白天能力。',
        '注意：夜晚选目标仅通过专用流程处理；此处不要输出 night_action / night_confirm。',
        '策略偏好：尽量像普通玩家而非“完美玩家”。通常情况下，被提名者更倾向投反对，除非你有明确策略（例如自证）。',
        '胜利条件：善良=恶魔死亡；邪恶=存活人数<=2 或保持恶魔存活到终局。',
        '只输出 JSON（不要解释），格式见 user prompt。',
    ].join('\n');
    const userPrompt = JSON.stringify({
        instruction: '根据上下文选择下一步“单个动作”。如果没必要动作，输出 {"type":"noop"}。',
        allowedActions: ['noop', 'chat_public', 'chat_dm', 'chat_god', 'nominate', 'skip_nomination', 'vote', 'day_action'],
        context: ctx,
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
    const messages = [
        { role: 'system', content: systemPrompt },
        ...thread.slice(-8),
        { role: 'user', content: userPrompt },
    ];
    try {
        const startedAt = Date.now();
        if (AI_PLAYER_LLM_LOG) {
            const ctxMini = {
                phase: ctx.roomView?.phase,
                dayNumber: ctx.roomView?.dayNumber,
                seatIndex,
                temperature: Math.min(1, Math.max(0, temperature)),
                hasNightPrompt: !!ctx.nightPrompt,
                hasCurrentNomination: !!ctx.currentNomination,
                chatLogLen: ctx.chatLog?.length ?? 0,
                nightInfoLen: ctx.nightInfo?.length ?? 0,
            };
            console.log(`[ai_player] llm input seat=${seatIndex}`, ctxMini);
            console.log(`[ai_player] llm input_raw seat=${seatIndex}`, userPrompt.slice(0, 2400));
        }
        const ac = new AbortController();
        const timeoutMs = Number(process.env.AI_PLAYER_TIMEOUT_MS ?? '') || 180_000;
        const timeout = setTimeout(() => ac.abort(), timeoutMs);
        const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages,
                response_format: { type: 'json_object' },
                temperature: Math.min(1, Math.max(0, temperature)),
                ...fastResponseOptions(),
            }),
            signal: ac.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            console.warn(`[ai_player] llm not ok seat=${seatIndex} status=${res.status} body=${t.slice(0, 300)}`);
            return { type: 'noop' };
        }
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content;
        if (!content)
            return { type: 'noop' };
        if (AI_PLAYER_LLM_LOG) {
            console.log(`[ai_player] llm output seat=${seatIndex} ms=${Date.now() - startedAt}`, content.slice(0, 2400));
        }
        let parsed = null;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            parsed = null;
        }
        // 保存线程（独立通道）
        thread.push({ role: 'user', content: userPrompt });
        thread.push({ role: 'assistant', content });
        room.storytellerDecisions.set(threadKey, thread.slice(-16));
        return validateAction(room, seatIndex, parsed);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const cause = e instanceof Error && 'cause' in e ? e.cause : undefined;
        const causeStr = cause instanceof Error ? cause.message : cause != null ? String(cause) : '';
        console.warn(`[ai_player] llm request failed seat=${seatIndex}: ${msg}${causeStr ? ` | cause: ${causeStr}` : ''} url=${OPENAI_BASE_URL}/v1/chat/completions`);
        return { type: 'noop' };
    }
    finally {
        room.storytellerDecisions.set(inflightKey, false);
    }
}
