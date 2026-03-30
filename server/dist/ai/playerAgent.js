const USE_AI = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
// 不要带 /v1，否则会与默认 path /v1/chat/completions 拼成 /v1/v1/...
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com').replace(/\/+$/, '');
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
export function aiPlayerLlmAvailable() {
    return !!OPENAI_API_KEY && !!USE_AI;
}
export async function decideAiPlayerAction(room, seatIndex, ctx, temperature) {
    if (!OPENAI_API_KEY || !USE_AI)
        return { type: 'noop' };
    // 每个座位独立线程：放在 room.storytellerDecisions，避免跨座位泄露
    const threadKey = `ai_player_thread_${seatIndex}`;
    const v = room.storytellerDecisions.get(threadKey);
    const thread = Array.isArray(v) ? v : [];
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
        { role: 'system', content: systemPrompt },
        ...thread.slice(-8),
        { role: 'user', content: userPrompt },
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
    if (!res.ok)
        return { type: 'noop' };
    const data = (await res.json());
    const content = data.choices?.[0]?.message?.content;
    if (!content)
        return { type: 'noop' };
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
