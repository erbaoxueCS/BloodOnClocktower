const DEFAULT_MAX = 3;
let inFlight = 0;
const queue = [];
function maxConcurrency() {
    const raw = Number(process.env.AI_LLM_MAX_CONCURRENCY ?? '');
    if (Number.isFinite(raw) && raw > 0)
        return Math.max(1, Math.min(50, Math.floor(raw)));
    return DEFAULT_MAX;
}
export async function acquireLlmSlot() {
    const max = maxConcurrency();
    if (inFlight < max) {
        inFlight++;
        return {
            max,
            inFlight,
            waitMs: 0,
            release: () => releaseOne(),
        };
    }
    const enqueuedAt = Date.now();
    return await new Promise((resolve) => {
        queue.push({
            enqueuedAt,
            grant: () => {
                inFlight++;
                resolve({
                    max,
                    inFlight,
                    waitMs: Date.now() - enqueuedAt,
                    release: () => releaseOne(),
                });
            },
        });
    });
}
function releaseOne() {
    inFlight = Math.max(0, inFlight - 1);
    const next = queue.shift();
    if (!next)
        return;
    // 交给 microtask，避免深递归/同步链条过长
    queueMicrotask(() => next.grant());
}
export function llmLimiterSnapshot() {
    return { inFlight, queued: queue.length, max: maxConcurrency() };
}
