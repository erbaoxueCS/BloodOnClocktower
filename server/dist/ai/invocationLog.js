const STORE_KEY = 'ai_invocation_log_store';
function getStore(room) {
    const v = room.storytellerDecisions.get(STORE_KEY);
    if (v instanceof Map)
        return v;
    const m = new Map();
    room.storytellerDecisions.set(STORE_KEY, m);
    return m;
}
export function createInvocation(room, input) {
    const now = Date.now();
    const rec = {
        id: `${now}-${Math.random().toString(36).slice(2)}`,
        at: now,
        updatedAt: now,
        ...input,
    };
    getStore(room).set(rec.id, rec);
    return rec;
}
export function updateInvocation(room, id, patch) {
    const store = getStore(room);
    const prev = store.get(id);
    if (!prev)
        return null;
    const next = {
        ...prev,
        ...patch,
        updatedAt: Date.now(),
    };
    store.set(id, next);
    return next;
}
export function listInvocations(room) {
    const store = getStore(room);
    return Array.from(store.values()).sort((a, b) => a.at - b.at);
}
