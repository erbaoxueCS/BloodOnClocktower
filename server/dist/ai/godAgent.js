import { advanceNight, computeChefPairsForSeat, computeEmpathCountForSeat, distortWasherLibrarianInvestigatorDecision, findAliveSeatByCharacter, formatUndertakerInfoForSeat, formatWasherLibrarianInvestigator, getCurrentNightStep, resolveRavenkeeperNightInfo, } from '../game/gameEngine.js';
import { getStorytellerDecision } from './storyteller.js';
/**
 * GodAgent：夜晚流程导演智能体。
 * 目标：
 * - 将“按夜序推进 + 信息发放 + 说书人裁量”状态集中管理；
 * - 让后续“信息步确认/超时策略/可解释裁量”扩展有单一落点。
 */
export class GodAgent {
    roomId;
    constructor(roomId) {
        this.roomId = roomId;
    }
    sentInfoOnce(room, stepId, seatIndex) {
        const key = `night_info_once|phase=${room.phase}|day=${room.dayNumber}|step=${stepId}|seat=${seatIndex}`;
        if (room.storytellerDecisions.get(key) === true)
            return true;
        room.storytellerDecisions.set(key, true);
        return false;
    }
    async tickNight(room, options) {
        const { sendNightInfo } = options;
        const maxStepsPerRun = Math.max(1, Math.min(20, Number(options.maxStepsPerRun ?? 1)));
        let advancedSteps = 0;
        for (;;) {
            if (advancedSteps >= maxStepsPerRun)
                break;
            if (room.pendingNightAction)
                break;
            if (room.awaitingNightInfoConfirm)
                break;
            if (room.awaitingNightConfirm)
                break;
            const stepId = getCurrentNightStep(room);
            if (!stepId) {
                advanceNight(room);
                advancedSteps++;
                if (room.phase === 'day' || room.phase === 'waiting')
                    break;
                if (room.awaitingNightConfirm)
                    break;
                break;
            }
            if (stepId === 'chef') {
                const seat = findAliveSeatByCharacter(room, 'chef');
                if (seat != null && !this.sentInfoOnce(room, stepId, seat)) {
                    sendNightInfo(this.roomId, room, seat, `厨师：你得知相邻两名邪恶玩家的数量为 ${computeChefPairsForSeat(room, seat)}。`);
                }
                room.nightStepIndex++;
                advancedSteps++;
                break;
            }
            if (stepId === 'empath') {
                const seat = findAliveSeatByCharacter(room, 'empath');
                if (seat != null && !this.sentInfoOnce(room, stepId, seat)) {
                    sendNightInfo(this.roomId, room, seat, `共情者：你得知相邻邪恶玩家数量为 ${computeEmpathCountForSeat(room, seat)}。`);
                }
                room.nightStepIndex++;
                advancedSteps++;
                break;
            }
            if (stepId === 'undertaker') {
                const seat = findAliveSeatByCharacter(room, 'undertaker');
                if (seat != null && !this.sentInfoOnce(room, stepId, seat)) {
                    sendNightInfo(this.roomId, room, seat, formatUndertakerInfoForSeat(room, seat));
                }
                room.nightStepIndex++;
                advancedSteps++;
                break;
            }
            if (stepId === 'ravenkeeper') {
                for (const vSeat of room.lastNightDeaths) {
                    if (room.players[vSeat]?.characterId !== 'ravenkeeper')
                        continue;
                    const msg = resolveRavenkeeperNightInfo(room, vSeat);
                    if (msg)
                        sendNightInfo(this.roomId, room, vSeat, msg);
                }
                room.nightStepIndex++;
                advancedSteps++;
                break;
            }
            if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
                const seat = findAliveSeatByCharacter(room, stepId);
                const stepNameZh = room.script.characters.find((c) => c.id === stepId)?.nameZh ?? stepId;
                const raw = (await getStorytellerDecision(room, stepId, stepNameZh, room.aiStorytellerEnabled, (debug) => options.onStorytellerDebug?.({
                    roomId: this.roomId,
                    seatIndex: seat,
                    stepId,
                    phase: room.phase,
                    debug,
                })));
                let decision = raw;
                if (seat != null && raw && Array.isArray(raw.players) && raw.players.length === 2 && typeof raw.characterId === 'string') {
                    decision = distortWasherLibrarianInvestigatorDecision(room, seat, { players: raw.players, characterId: raw.characterId });
                }
                options.onStorytellerDebug?.({
                    roomId: this.roomId,
                    seatIndex: seat,
                    stepId,
                    phase: room.phase,
                    debug: { kind: 'response', stepId, model: process.env.OPENAI_MODEL ?? 'qwen3.5-plus', rawResponse: JSON.stringify(raw) },
                    appliedDecision: decision,
                });
                room.storytellerDecisions.set(stepId, decision);
                if (seat != null && !this.sentInfoOnce(room, stepId, seat)) {
                    sendNightInfo(this.roomId, room, seat, formatWasherLibrarianInvestigator(room, stepId, decision));
                }
                room.nightStepIndex++;
                advancedSteps++;
                break;
            }
            advanceNight(room);
            advancedSteps++;
            if (room.phase === 'day' || room.phase === 'waiting')
                break;
            if (room.pendingNightAction)
                break;
            if (room.awaitingNightConfirm)
                break;
            break;
        }
    }
}
const GOD_AGENT_BY_ROOM = new Map();
export function getOrCreateGodAgent(roomId) {
    const found = GOD_AGENT_BY_ROOM.get(roomId);
    if (found)
        return found;
    const a = new GodAgent(roomId);
    GOD_AGENT_BY_ROOM.set(roomId, a);
    return a;
}
