import { getOrCreateGodAgent } from '../ai/godAgent.js';
/**
 * 推进夜晚直到：需要玩家 night_action、等待天亮确认、或进入白天/结束。
 * 信息步顺序严格跟随 `room.script.firstNightOrder` / `otherNightOrder` 与 `room.nightStepIndex`。
 */
export async function runNightLoop(roomId, room, options) {
    const godAgent = getOrCreateGodAgent(roomId);
    await godAgent.tickNight(room, {
        sendNightInfo: options.sendNightInfo,
        maxStepsPerRun: options.maxStepsPerRun,
        onStorytellerDebug: options.onStorytellerDebug,
    });
}
