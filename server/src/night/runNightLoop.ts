import type { Room } from '../game/types.js';
import { getOrCreateGodAgent } from '../ai/godAgent.js';
import type { StorytellerDebugEvent } from '../ai/storyteller.js';

/** 由宿主注入：写入复盘、去重、`night_info` 下发 */
export type NightLoopSendNightInfo = (roomId: string, room: Room, seatIndex: number, message: string) => void;

export interface RunNightLoopOptions {
  sendNightInfo: NightLoopSendNightInfo;
  /** 每次夜晚循环最多推进多少个步骤（默认 1，确保按序可观测推进） */
  maxStepsPerRun?: number;
  onStorytellerDebug?: (payload: {
    roomId: string;
    seatIndex: number | null;
    stepId: string;
    phase: string;
    debug: StorytellerDebugEvent;
    appliedDecision?: unknown;
  }) => void;
}

/**
 * 推进夜晚直到：需要玩家 night_action、等待天亮确认、或进入白天/结束。
 * 信息步顺序严格跟随 `room.script.firstNightOrder` / `otherNightOrder` 与 `room.nightStepIndex`。
 */
export async function runNightLoop(roomId: string, room: Room, options: RunNightLoopOptions): Promise<void> {
  const godAgent = getOrCreateGodAgent(roomId);
  await godAgent.tickNight(room, {
    sendNightInfo: options.sendNightInfo,
    maxStepsPerRun: options.maxStepsPerRun,
    onStorytellerDebug: options.onStorytellerDebug,
  });
}
