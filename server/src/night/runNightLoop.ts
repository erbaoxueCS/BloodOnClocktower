import type { Room } from '../game/types.js';
import {
  advanceNight,
  computeChefPairsForSeat,
  computeEmpathCountForSeat,
  distortWasherLibrarianInvestigatorDecision,
  findAliveSeatByCharacter,
  formatUndertakerInfoForSeat,
  formatWasherLibrarianInvestigator,
  getCurrentNightStep,
  resolveRavenkeeperNightInfo,
} from '../game/gameEngine.js';
import { getStorytellerDecision } from '../ai/storyteller.js';
import type { StorytellerDebugEvent } from '../ai/storyteller.js';

/** 由宿主注入：写入复盘、去重、`night_info` 下发 */
export type NightLoopSendNightInfo = (roomId: string, room: Room, seatIndex: number, message: string) => void;

export interface RunNightLoopOptions {
  sendNightInfo: NightLoopSendNightInfo;
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
  const { sendNightInfo } = options;
  const sentInfoOnce = (stepId: string, seatIndex: number): boolean => {
    const key = `night_info_once|phase=${room.phase}|day=${room.dayNumber}|step=${stepId}|seat=${seatIndex}`;
    if (room.storytellerDecisions.get(key) === true) return true;
    room.storytellerDecisions.set(key, true);
    return false;
  };
  for (;;) {
    if (room.pendingNightAction) break;
    if (room.awaitingNightConfirm) break;
    const stepId = getCurrentNightStep(room);
    if (!stepId) {
      advanceNight(room);
      if (room.phase === 'day' || room.phase === 'waiting') break;
      if (room.awaitingNightConfirm) break;
      continue;
    }

    if (stepId === 'chef') {
      const seat = findAliveSeatByCharacter(room, 'chef');
      if (seat != null && !sentInfoOnce(stepId, seat)) {
        sendNightInfo(roomId, room, seat, `厨师：你得知相邻两名邪恶玩家的数量为 ${computeChefPairsForSeat(room, seat)}。`);
      }
      room.nightStepIndex++;
      continue;
    }
    if (stepId === 'empath') {
      const seat = findAliveSeatByCharacter(room, 'empath');
      if (seat != null && !sentInfoOnce(stepId, seat)) {
        sendNightInfo(roomId, room, seat, `共情者：你得知相邻邪恶玩家数量为 ${computeEmpathCountForSeat(room, seat)}。`);
      }
      room.nightStepIndex++;
      continue;
    }
    if (stepId === 'undertaker') {
      const seat = findAliveSeatByCharacter(room, 'undertaker');
      if (seat != null && !sentInfoOnce(stepId, seat)) {
        sendNightInfo(roomId, room, seat, formatUndertakerInfoForSeat(room, seat));
      }
      room.nightStepIndex++;
      continue;
    }

    if (stepId === 'ravenkeeper') {
      for (const vSeat of room.lastNightDeaths) {
        if (room.players[vSeat]?.characterId !== 'ravenkeeper') continue;
        const msg = resolveRavenkeeperNightInfo(room, vSeat);
        if (msg) sendNightInfo(roomId, room, vSeat, msg);
      }
      room.nightStepIndex++;
      continue;
    }

    if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
      const seat = findAliveSeatByCharacter(room, stepId);
      const stepNameZh = room.script.characters.find((c) => c.id === stepId)?.nameZh ?? stepId;
      const raw = (await getStorytellerDecision(
        room,
        stepId,
        stepNameZh,
        room.aiStorytellerEnabled,
        (debug) => options.onStorytellerDebug?.({
          roomId,
          seatIndex: seat,
          stepId,
          phase: room.phase,
          debug,
        }),
      )) as any;
      let decision = raw;
      if (seat != null && raw && Array.isArray(raw.players) && raw.players.length === 2 && typeof raw.characterId === 'string') {
        decision = distortWasherLibrarianInvestigatorDecision(room, stepId, seat, { players: raw.players, characterId: raw.characterId });
      }
      options.onStorytellerDebug?.({
        roomId,
        seatIndex: seat,
        stepId,
        phase: room.phase,
        debug: { kind: 'response', stepId, model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus', rawResponse: JSON.stringify(raw) },
        appliedDecision: decision,
      });
      room.storytellerDecisions.set(stepId, decision);
      if (seat != null && !sentInfoOnce(stepId, seat)) {
        sendNightInfo(roomId, room, seat, formatWasherLibrarianInvestigator(room, stepId, decision));
      }
      room.nightStepIndex++;
      continue;
    }

    advanceNight(room);
    if (room.phase === 'day' || room.phase === 'waiting') break;
    if (room.pendingNightAction) break;
    if (room.awaitingNightConfirm) break;
  }
}
