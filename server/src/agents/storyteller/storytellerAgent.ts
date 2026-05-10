// ============================================================
// 说书人 Agent：游戏流程编排 + 裁量决策
//
// 负责：
//   1. 夜序推进：按 firstNightOrder / otherNightOrder 逐步执行
//   2. 信息分发：规则确定性信息直接计算，说书人裁量信息调 LLM
//   3. 白天流程管理：讨论→提名→投票→处决→入夜
//   4. 全程日志（public log + replay log）
//
// 核心区分：
//   - 规则确定性 (infoSource='rule') → 引擎计算，说书人直接下发
//   - 说书人裁量 (infoSource='storyteller') → LLM 辅助裁量
// ============================================================

import type {
  GameState, WorldView, ChatEntry, ReplayLogEntry, PublicLogEntry,
  InfoRoleResult, WasherwomanResult, LibrarianResult, InvestigatorResult,
} from '../../engine/types.js';
import {
  getCurrentNightStep, getCurrentNightOrder,
  findAliveByCharacter, findDemon, findAliveMinions,
  computeChefPairs, computeEmpathCount,
  checkFortuneTellerTargets, resolveUndertakerInfo, resolveRavenkeeperInfo,
  resolveDemonKill, isPoisonedOrDrunk, getEffectiveCharacterId,
  nominate, skipNomination, vote, tallyVotes, tryEndDay,
  checkWin, checkSaintExecutionLoss, checkScarletWoman,
  executeSlayerShot, checkVirginTrigger, shouldMayorBounce,
  pushPublicLog, pushReplayLog, buildWorldView, buildReplayIdentities,
  gotoDay, gotoNight,
} from '../../engine/gameEngine.js';
import type { CharacterDef } from '../../engine/types.js';
import { callLlm } from '../../llm/llmClient.js';
import { buildStorytellerPrompts } from './prompts.js';

// ----- 配置 -----
const STORYTELLER_MODEL = process.env.OPENAI_MODEL ?? 'qwen-plus';
const AI_ST_ENABLED = process.env.USE_AI_STORYTELLER === 'true' || process.env.USE_AI_STORYTELLER === '1';

// ----- 事件广播接口 -----
export interface StorytellerEvents {
  sendToSeat(roomId: string, seatIndex: number, msg: object): void;
  broadcast(roomId: string, msg: object): void;
  sendToAdmins(roomId: string, msg: object): void;
  broadcastRoom(roomId: string, msg: object): void;
  broadcastPhase(roomId: string, phase: string, dayNumber: number): void;
  onDebug?(payload: {
    roomId: string; stepId: string; phase: string;
    kind: 'request' | 'response' | 'error';
    promptSummary?: string; responseSummary?: string;
    elapsedMs?: number; error?: string;
  }): void;
}

type SendNightInfoFn = (roomId: string, roomId2: string, game: GameState, seatIndex: number, message: string) => void;

// ----- 说书人裁量：LLM 辅助决策 -----
async function storytellerDecide(
  game: GameState,
  stepId: string,
  characterDef: CharacterDef,
): Promise<InfoRoleResult | null> {
  if (!AI_ST_ENABLED) {
    return fallbackDecision(game, stepId, characterDef);
  }

  const characters = game.script.characters;
  const aliveSeats = game.players.filter(p => p.isAlive).map(p => p.seatIndex);
  const { systemPrompt, userPrompt } = buildStorytellerPrompts(game, stepId, characterDef);

  try {
    const result = await callLlm(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.7, jsonMode: true, maxAttempts: 3, timeoutMs: 20000 },
    );

    if (result.json) {
      return validateAndCoerceDecision(result.json, stepId, aliveSeats, characters);
    }
  } catch {
    // 兜底
  }

  return fallbackDecision(game, stepId, characterDef);
}

function validateAndCoerceDecision(
  json: Record<string, unknown>,
  stepId: string,
  aliveSeats: number[],
  characters: CharacterDef[],
): InfoRoleResult | null {
  const players = json.players as number[] | undefined;
  const characterId = json.characterId as string | undefined;
  const noOutsider = json.noOutsider as boolean | undefined;

  if (stepId === 'washerwoman' || stepId === 'librarian' || stepId === 'investigator') {
    const coercedPlayers: [number, number] = [
      typeof players?.[0] === 'number' ? players[0] : aliveSeats[0] ?? 0,
      typeof players?.[1] === 'number' ? players[1] : aliveSeats[1] ?? aliveSeats[0] ?? 0,
    ];
    let charId = typeof characterId === 'string' ? characterId : 'washerwoman';

    if (stepId === 'washerwoman') {
      const valid = characters.filter(c => c.type === 'townsfolk');
      if (!valid.some(c => c.id === charId)) charId = valid[0]?.id ?? 'washerwoman';
      return { type: 'washerwoman_result', players: coercedPlayers, characterId: charId };
    }
    if (stepId === 'librarian') {
      if (noOutsider) return { type: 'librarian_result', players: coercedPlayers, characterId: 'no_outsider', noOutsider: true };
      const valid = characters.filter(c => c.type === 'outsider');
      if (!valid.some(c => c.id === charId)) charId = valid[0]?.id ?? 'drunk';
      return { type: 'librarian_result', players: coercedPlayers, characterId: charId };
    }
    if (stepId === 'investigator') {
      const valid = characters.filter(c => c.type === 'minion');
      if (!valid.some(c => c.id === charId)) charId = valid[0]?.id ?? 'poisoner';
      return { type: 'investigator_result', players: coercedPlayers, characterId: charId };
    }
  }

  return null;
}

function fallbackDecision(
  game: GameState,
  stepId: string,
  characterDef: CharacterDef,
): InfoRoleResult | null {
  const aliveSeats = game.players.filter(p => p.isAlive).map(p => p.seatIndex);
  const characters = game.script.characters;

  if (stepId === 'washerwoman') {
    const townsfolk = characters.filter(c => c.type === 'townsfolk' && c.id !== 'drunk');
    if (aliveSeats.length < 2 || townsfolk.length === 0) return null;
    const [a, b] = shuffle(aliveSeats).slice(0, 2) as [number, number];
    const char = townsfolk[Math.floor(Math.random() * townsfolk.length)];
    return { type: 'washerwoman_result', players: [a, b], characterId: char.id };
  }
  if (stepId === 'librarian') {
    const outsiders = characters.filter(c => c.type === 'outsider');
    const inPlay = game.players.some(p => p.characterId && characters.find(c => c.id === p.characterId)?.type === 'outsider');
    if (!inPlay) {
      const [a, b] = shuffle(aliveSeats).slice(0, 2) as [number, number];
      return { type: 'librarian_result', players: [a, b], characterId: 'no_outsider', noOutsider: true };
    }
    if (aliveSeats.length < 2 || outsiders.length === 0) return null;
    const [a, b] = shuffle(aliveSeats).slice(0, 2) as [number, number];
    const char = outsiders[Math.floor(Math.random() * outsiders.length)];
    return { type: 'librarian_result', players: [a, b], characterId: char.id };
  }
  if (stepId === 'investigator') {
    const minions = characters.filter(c => c.type === 'minion');
    if (aliveSeats.length < 2 || minions.length === 0) return null;
    const [a, b] = shuffle(aliveSeats).slice(0, 2) as [number, number];
    const char = minions[Math.floor(Math.random() * minions.length)];
    return { type: 'investigator_result', players: [a, b], characterId: char.id };
  }
  return null;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// StorytellerAgent
// ============================================================

export class StorytellerAgent {
  private roomId: string;
  private events: StorytellerEvents;
  private sentInfoOnce: Set<string> = new Set();

  constructor(roomId: string, events: StorytellerEvents) {
    this.roomId = roomId;
    this.events = events;
  }

  // ----- 日志 -----
  private logPublic(game: GameState, line: string): void {
    pushPublicLog(game, line);
    this.events.broadcastRoom(this.roomId, { type: 'room', // 触发广播刷新
    });
  }

  private logReplay(game: GameState, groupKey: string, groupTitle: string, line: string): void {
    pushReplayLog(game, groupKey, groupTitle, line);
  }

  // ===== 夜晚流程 =====

  /** 推进夜晚一个步骤。返回 true 表示需要等待玩家输入。 */
  async tickNight(game: GameState): Promise<{
    waitingForAction: boolean;
    waitingForStoryteller: boolean;
    nightComplete: boolean;
  }> {
    // 如果正在等待玩家行动，不推进
    if (game.pendingNightAction) return { waitingForAction: true, waitingForStoryteller: false, nightComplete: false };
    if (game.awaitingNightInfoConfirm) return { waitingForAction: false, waitingForStoryteller: false, nightComplete: false };
    if (game.awaitingNightConfirm) return { waitingForAction: false, waitingForStoryteller: false, nightComplete: false };

    const stepId = getCurrentNightStep(game);
    if (!stepId) {
      // 夜序结束，进入等待天亮确认
      game.awaitingNightConfirm = true;
      game.nightConfirmations = new Set();
      this.logPublic(game, `第 ${game.dayNumber + 1} 夜结束，等待所有玩家确认进入白天…`);
      return { waitingForAction: false, waitingForStoryteller: false, nightComplete: true };
    }

    const chars = game.script.characters;
    const charDef = chars.find(c => c.id === stepId);

    // --- 恶魔信息（首夜）---
    if (stepId === 'demon_info') {
      this.executeDemonInfo(game);
      game.nightStepIndex++;
      return { waitingForAction: false, waitingForStoryteller: false, nightComplete: false };
    }

    // --- 爪牙信息（首夜）---
    if (stepId === 'minion_info') {
      this.executeMinionInfo(game);
      game.nightStepIndex++;
      return { waitingForAction: false, waitingForStoryteller: false, nightComplete: false };
    }

    // --- 规则信息角色：直接计算后下发 ---
    if (charDef && charDef.infoSource === 'rule') {
      this.executeRuleInfoStep(game, stepId, charDef);
      game.nightStepIndex++;
      return { waitingForAction: false, waitingForStoryteller: false, nightComplete: false };
    }

    // --- 说书人裁量角色：调 LLM 决策 ---
    if (charDef && charDef.infoSource === 'storyteller') {
      await this.executeStorytellerInfoStep(game, stepId, charDef);
      game.nightStepIndex++;
      return { waitingForAction: false, waitingForStoryteller: true, nightComplete: false };
    }

    // --- 需要玩家选择目标的角色 ---
    if (charDef && charDef.requiresPlayerChoice) {
      const actor = game.players.find(p =>
        p.isAlive && getEffectiveCharacterId(p) === stepId
      );
      if (actor && !isPoisonedOrDrunk(game, actor.seatIndex)) {
        // 中毒者不叫醒（能力失灵）
        const actuallyWakes = stepId !== 'imp' || game.phase !== 'first_night';  // 恶魔首夜不刀
        if (actuallyWakes) {
          game.pendingNightAction = {
            stepId,
            actorSeatIndex: actor.seatIndex,
            pick: (charDef.pickCount ?? 1) as 1 | 2,
          };
          return { waitingForAction: true, waitingForStoryteller: false, nightComplete: false };
        }
      }
      // 角色不在场、已死或无合法目标，跳过
      game.nightStepIndex++;
      return { waitingForAction: false, waitingForStoryteller: false, nightComplete: false };
    }

    // --- 间谍看魔典 ---
    if (stepId === 'spy') {
      const spySeat = findAliveByCharacter(game, 'spy');
      if (spySeat != null && !isPoisonedOrDrunk(game, spySeat)) {
        const grimoire = this.buildGrimoireForSpy(game);
        const sendNightInfo = this.events.sendToSeat;
        sendNightInfo(this.roomId, spySeat, { type: 'spy_grimoire', grimoire });
      }
      game.nightStepIndex++;
      return { waitingForAction: false, waitingForStoryteller: false, nightComplete: false };
    }

    // 未知步骤，跳过
    game.nightStepIndex++;
    return { waitingForAction: false, waitingForStoryteller: false, nightComplete: false };
  }

  // --- 恶魔信息 ---
  private executeDemonInfo(game: GameState): void {
    const demon = findDemon(game);
    if (!demon) return;

    const minionSeats = findAliveMinions(game).map(m => m.seatIndex);
    const bluffs = game.demonBluffs;

    const sendNightInfo = this.events.sendToSeat;
    sendNightInfo(this.roomId, demon.seatIndex, {
      type: 'night_info',
      message: `你是恶魔（小恶魔）。${
        minionSeats.length > 0
          ? `你的爪牙是：${minionSeats.map(s => `#${s + 1}`).join('、')}。`
          : '本局无爪牙。'
      }不在场身份（bluff）：${bluffs.map(id => {
        const c = game.script.characters.find(x => x.id === id);
        return c ? `${c.nameZh}(${c.name})` : id;
      }).join('、')}。`,
    });

    // 爪牙互相知道彼此和恶魔
    for (const ms of minionSeats) {
      sendNightInfo(this.roomId, ms, {
        type: 'night_info',
        message: `你的恶魔是 #${demon.seatIndex + 1}。${
          minionSeats.length > 1
            ? `其他爪牙：${minionSeats.filter(s => s !== ms).map(s => `#${s + 1}`).join('、')}。`
            : '你是唯一的爪牙。'
        }`,
      });
    }

    const allEvil = [demon.seatIndex, ...minionSeats];
    for (const seat of allEvil) {
      game.pendingNightInfoConfirmSeats.add(seat);
    }
    game.awaitingNightInfoConfirm = true;

    this.logReplay(game, 'demon_info', '恶魔与爪牙互相认识',
      `恶魔 #${demon.seatIndex + 1} 得知爪牙：${minionSeats.map(s => `#${s + 1}`).join('、') || '无爪牙'}`);
  }

  private executeMinionInfo(game: GameState): void {
    // 已在 demon_info 中一起处理
  }

  // --- 规则信息角色 ---
  private executeRuleInfoStep(game: GameState, stepId: string, def: CharacterDef): void {
    const seat = findAliveByCharacter(game, stepId);
    if (seat == null) return;

    // 防止重复下发
    const dedupKey = `info|${game.phase}|${game.dayNumber}|${stepId}|${seat}`;
    if (this.sentInfoOnce.has(dedupKey)) return;
    this.sentInfoOnce.add(dedupKey);

    const sendNightInfo = this.events.sendToSeat;
    const poisoned = isPoisonedOrDrunk(game, seat);

    if (stepId === 'chef') {
      const truePairs = computeChefPairs(game);
      const shown = poisoned ? randomPlausibleNumber(0, Math.min(Math.floor(game.players.length / 2), 4)) : truePairs;
      const msg = `厨师：你得知相邻邪恶玩家对数为 ${shown}。`;
      sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
      this.logReplay(game, 'chef', '厨师', `${msg}（真实值：${truePairs}${poisoned ? '，因中毒/醉酒返回假信息' : ''}）`);
    }

    if (stepId === 'empath') {
      const trueCount = computeEmpathCount(game, seat);
      const shown = poisoned ? randomPlausibleNumber(0, 2) : trueCount;
      const msg = `共情者：你的两名存活邻居中有 ${shown} 名邪恶玩家。`;
      sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
      this.logReplay(game, 'empath', '共情者', `${msg}（真实值：${trueCount}${poisoned ? '，因中毒/醉酒返回假信息' : ''}）`);
    }

    if (stepId === 'fortune_teller') {
      // 占卜师需要玩家选人——已在 requiresPlayerChoice 分支处理
    }

    if (stepId === 'undertaker') {
      const info = resolveUndertakerInfo(game);
      if (info) {
        const def2 = game.script.characters.find(c => c.id === info.characterId);
        const shown = poisoned
          ? game.script.characters[Math.floor(Math.random() * game.script.characters.length)]
          : def2;
        const msg = `掘墓人：今日被处决的 #${info.seatIndex + 1} 是「${shown?.nameZh ?? info.characterId}」。`;
        sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
        this.logReplay(game, 'undertaker', '掘墓人',
          `${msg}（真实：${def2?.nameZh ?? info.characterId}${poisoned ? '，因中毒/醉酒返回假信息' : ''}）`);
      }
    }

    if (stepId === 'ravenkeeper') {
      // 守鸦人在 demon kill 结算后处理
      const rkSeat = game.lastNightDeaths.find(s => game.players[s]?.characterId === 'ravenkeeper');
      if (rkSeat != null) {
        const attacker = resolveRavenkeeperInfo(game, rkSeat);
        if (attacker != null && !poisoned) {
          const attackerDef = game.script.characters.find(c => c.id === game.players[attacker]?.characterId);
          const msg = `守鸦人：杀害你的是 #${attacker + 1}，其身份为「${attackerDef?.nameZh ?? '未知'}」。`;
          sendNightInfo(this.roomId, rkSeat, { type: 'night_info', message: msg });
        } else if (poisoned) {
          const randomSeat = game.players.filter(p => p.isAlive)[Math.floor(Math.random() * game.players.filter(p => p.isAlive).length)];
          const msg = `守鸦人：杀害你的是 #${(randomSeat?.seatIndex ?? 0) + 1}，其身份为「${game.script.characters[Math.floor(Math.random() * game.script.characters.length)]?.nameZh ?? '?'}」。（信息可能为假）`;
          sendNightInfo(this.roomId, rkSeat, { type: 'night_info', message: msg });
        }
      }
    }
  }

  // --- 说书人裁量信息角色 ---
  private async executeStorytellerInfoStep(game: GameState, stepId: string, def: CharacterDef): Promise<void> {
    const seat = findAliveByCharacter(game, stepId);
    if (seat == null) return;

    const dedupKey = `info|${game.phase}|${game.dayNumber}|${stepId}|${seat}`;
    if (this.sentInfoOnce.has(dedupKey)) return;
    this.sentInfoOnce.add(dedupKey);

    const poisoned = isPoisonedOrDrunk(game, seat);
    const sendNightInfo = this.events.sendToSeat;

    // 调用 LLM 做裁量
    const decision = await storytellerDecide(game, stepId, def);

    if (stepId === 'washerwoman' && decision?.type === 'washerwoman_result') {
      const d = decision as WasherwomanResult;
      const charName = game.script.characters.find(c => c.id === d.characterId)?.nameZh ?? d.characterId;

      if (poisoned) {
        // 中毒/醉酒：给出假信息
        const fakePlayers = shuffle(game.players.filter(p => p.isAlive).map(p => p.seatIndex)).slice(0, 2) as [number, number];
        const fakeChar = game.script.characters.filter(c => c.type === 'townsfolk')[Math.floor(Math.random() * game.script.characters.filter(c => c.type === 'townsfolk').length)];
        const msg = `洗衣妇：在 #${fakePlayers[0] + 1} 与 #${fakePlayers[1] + 1} 中，有一位是「${fakeChar?.nameZh ?? '镇民'}」。`;
        sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
        this.logReplay(game, 'washerwoman', '洗衣妇',
          `真实应显示：在 #${d.players[0] + 1} 与 #${d.players[1] + 1} 中一位是${charName}。因中毒/醉酒返回假信息。`);
      } else {
        const msg = `洗衣妇：在 #${d.players[0] + 1} 与 #${d.players[1] + 1} 中，有一位是「${charName}」。`;
        sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
        this.logReplay(game, 'washerwoman', '洗衣妇', msg);
      }
      game.storytellerDecisions.set('washerwoman', d);
    }

    if (stepId === 'librarian' && decision?.type === 'librarian_result') {
      const d = decision as LibrarianResult;
      if (poisoned) {
        const fakePlayers = shuffle(game.players.filter(p => p.isAlive).map(p => p.seatIndex)).slice(0, 2) as [number, number];
        const fakeChar = game.script.characters.filter(c => c.type === 'outsider')[0];
        const msg = `图书管理员：在 #${fakePlayers[0] + 1} 与 #${fakePlayers[1] + 1} 中，有一位是「${fakeChar?.nameZh ?? '外来者'}」。`;
        sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
      } else if (d.noOutsider) {
        const msg = '图书管理员：本局没有外来者。';
        sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
      } else {
        const charName = game.script.characters.find(c => c.id === d.characterId)?.nameZh ?? d.characterId;
        const msg = `图书管理员：在 #${d.players[0] + 1} 与 #${d.players[1] + 1} 中，有一位是「${charName}」。`;
        sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
      }
      game.storytellerDecisions.set('librarian', d);
      this.logReplay(game, 'librarian', '图书管理员', `裁量结果已记录`);
    }

    if (stepId === 'investigator' && decision?.type === 'investigator_result') {
      const d = decision as InvestigatorResult;
      if (poisoned) {
        const fakePlayers = shuffle(game.players.filter(p => p.isAlive).map(p => p.seatIndex)).slice(0, 2) as [number, number];
        const fakeChar = game.script.characters.filter(c => c.type === 'minion')[0];
        const msg = `调查员：在 #${fakePlayers[0] + 1} 与 #${fakePlayers[1] + 1} 中，有一位是「${fakeChar?.nameZh ?? '爪牙'}」。`;
        sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
      } else {
        const charName = game.script.characters.find(c => c.id === d.characterId)?.nameZh ?? d.characterId;
        const msg = `调查员：在 #${d.players[0] + 1} 与 #${d.players[1] + 1} 中，有一位是「${charName}」。`;
        sendNightInfo(this.roomId, seat, { type: 'night_info', message: msg });
      }
      game.storytellerDecisions.set('investigator', d);
      this.logReplay(game, 'investigator', '调查员', `裁量结果已记录`);
    }
  }

  // --- 间谍魔典 ---
  private buildGrimoireForSpy(game: GameState): Array<{ seatIndex: number; nickname: string; character: string }> {
    return game.players.map(p => ({
      seatIndex: p.seatIndex,
      nickname: p.nickname,
      character: p.characterId
        ? (game.script.characters.find(c => c.id === p.characterId)?.nameZh ?? p.characterId)
        : '未知',
    }));
  }

  // ===== 夜晚行动结算 =====

  /** 收到玩家夜晚行动后结算 */
  processNightAction(game: GameState, actorSeat: number, targets: number[]): {
    ok: boolean;
    error?: string;
    info?: string;
  } {
    const pending = game.pendingNightAction;
    if (!pending) return { ok: false, error: 'no_pending_action' };
    if (pending.actorSeatIndex !== actorSeat) return { ok: false, error: 'not_your_turn' };
    if (targets.length !== pending.pick) return { ok: false, error: 'invalid_target_count' };

    const actor = game.players[actorSeat];
    if (!actor?.isAlive) return { ok: false, error: 'actor_not_alive' };

    const aliveSeats = new Set(game.players.filter(p => p.isAlive).map(p => p.seatIndex));
    for (const t of targets) {
      if (!aliveSeats.has(t)) return { ok: false, error: 'invalid_target' };
    }

    const stepId = pending.stepId;
    let info: string | undefined;

    if (stepId === 'imp') {
      game.storytellerDecisions.set('imp_kill', targets[0]);
      const result = resolveDemonKill(game, targets[0], actorSeat);
      if (!result.killed) {
        info = result.blockedByMonk ? '目标受到僧侣保护，无人死亡。' : result.blockedBySoldier ? '目标为士兵，免疫恶魔杀害。' : '无人死亡。';
      } else {
        info = targets[0] === actorSeat ? '恶魔自杀了…' : undefined;
      }
    } else if (stepId === 'monk') {
      game.protectedSeatIndex = isPoisonedOrDrunk(game, actorSeat) ? null : targets[0];
      game.storytellerDecisions.set('monk_protect', targets[0]);
    } else if (stepId === 'poisoner') {
      const actual = isPoisonedOrDrunk(game, actorSeat)
        ? game.players.filter(p => p.isAlive)[Math.floor(Math.random() * game.players.filter(p => p.isAlive).length)]?.seatIndex
        : targets[0];
      if (actual != null) game.poisonedSeatIndex = actual;
      game.storytellerDecisions.set('poisoner_poison', actual ?? targets[0]);
    } else if (stepId === 'fortune_teller') {
      game.storytellerDecisions.set('fortune_teller_pick', targets);
      const redHerring = game.storytellerDecisions.get('fortune_teller_red_herring') as number | null;
      const hasDemon = checkFortuneTellerTargets(game, targets, redHerring);
      const resultText = hasDemon ? '是（其中有恶魔）' : '否（其中没有恶魔）';
      info = `占卜师：你选择了 #${targets[0] + 1} 与 #${targets[1] + 1}，结果为「${resultText}」。`;
    }

    game.pendingNightAction = null;
    game.nightStepIndex++;

    // 该座位收到过信息则需确认
    if (info) {
      game.pendingNightInfoConfirmSeats.add(actorSeat);
      game.awaitingNightInfoConfirm = true;
    }

    return { ok: true, info };
  }

  // ===== 白天流程 =====

  /** 推进白天流程 */
  processDayAction(
    game: GameState,
    action: { type: string; seatIndex: number; payload: Record<string, unknown> },
  ): { ok: boolean; error?: string; info?: string } {
    const { type, seatIndex, payload } = action;

    if (type === 'nominate') {
      const nominated = payload.nominatedSeat as number;
      // 先检查处女触发
      const virginResult = checkVirginTrigger(game, nominated, seatIndex);
      if (virginResult.triggered) {
        this.logPublic(game, `处女 #${nominated + 1} 被 #${seatIndex + 1} 提名触发！提名者 #${seatIndex + 1} 被立即处决！`);
        const win = checkWin(game);
        if (win) return { ok: true, info: `游戏结束：${win === 'good' ? '善良阵营获胜' : '邪恶阵营获胜'}` };
        return { ok: true, info: `处女触发！提名者 #${seatIndex + 1}（镇民）被立即处决。` };
      }

      const ok = nominate(game, seatIndex, nominated);
      if (!ok) return { ok: false, error: 'nomination_failed' };

      this.logPublic(game, `#${seatIndex + 1} 提名 #${nominated + 1}`);
      return { ok: true };
    }

    if (type === 'skip_nomination') {
      const ok = skipNomination(game, seatIndex);
      if (!ok) return { ok: false, error: 'skip_nomination_failed' };
      this.logPublic(game, `#${seatIndex + 1} 本轮不提名`);

      // 检查是否所有人已完成提名
      const dayResult = tryEndDay(game);
      if (dayResult === 'goto_night') {
        gotoNight(game);
        this.logPublic(game, `白天结束，进入第 ${game.dayNumber + 1} 夜…`);
      } else if (dayResult === 'ended') {
        this.logPublic(game, '圣徒被处决，善良阵营失败！游戏结束。');
      }
      return { ok: true };
    }

    if (type === 'vote') {
      const inFavor = !!payload.inFavor;
      const ok = vote(game, seatIndex, inFavor);
      if (!ok) return { ok: false, error: 'vote_failed' };

      // 投票后检查是否该结束此提名（所有人投完）
      const result = tallyVotes(game);
      const voteWord = inFavor ? '赞成' : '反对';
      this.logPublic(game, `#${seatIndex + 1} 投票${voteWord}（赞成 ${result.votesFor}/${Math.ceil(game.players.filter(p => p.isAlive).length / 2)} 票）`);

      return { ok: true, info: `投票${voteWord}，当前赞成 ${result.votesFor} 票，${result.passed ? '通过' : '未通过'}` };
    }

    if (type === 'day_action') {
      const actionId = payload.actionId as string;
      const targetSeat = payload.targetSeat as number;

      if (actionId === 'slayer_shot') {
        const result = executeSlayerShot(game, seatIndex, targetSeat);
        if (!result.success) return { ok: false, error: 'slayer_shot_failed' };
        if (result.killedDemon) {
          this.logPublic(game, `杀手 #${seatIndex + 1} 开枪射击 #${targetSeat + 1}！恶魔死亡！`);
          const win = checkWin(game);
          return { ok: true, info: win ? `游戏结束：${win === 'good' ? '善良阵营获胜' : '邪恶阵营获胜'}` : '恶魔被杀！' };
        }
        this.logPublic(game, `杀手 #${seatIndex + 1} 宣称开枪射击 #${targetSeat + 1}——无事发生。`);
        return { ok: true, info: '无事发生。' };
      }
    }

    return { ok: false, error: 'unknown_day_action' };
  }

  // ===== 天亮 =====
  finishNightAndGotoDay(game: GameState): void {
    if (!game.awaitingNightConfirm) return;
    game.awaitingNightConfirm = false;
    game.nightConfirmations = new Set();

    // 公布死亡
    if (game.lastNightDeaths.length > 0) {
      const names = game.lastNightDeaths.map(s => `#${s + 1}`).join('、');
      this.logPublic(game, `天亮——昨夜死亡：${names}`);
    } else {
      this.logPublic(game, '天亮——昨夜无人死亡。');
    }

    // 清除该夜信息去重
    this.sentInfoOnce.clear();

    gotoDay(game);

    // 检查是否直接游戏结束
    const win = checkWin(game);
    if (win) {
      this.logPublic(game, `游戏结束：${win === 'good' ? '善良阵营获胜' : '邪恶阵营获胜'}`);
    }
  }

  // ===== 游戏结束 =====
  async endGame(game: GameState): Promise<{
    winner: 'good' | 'evil';
    winnerZh: string;
    identities: Array<{ seatIndex: number; nickname: string; characterId: string; characterName: string; characterZh: string; ability: string; alignment: string; survived: boolean }>;
    entries: ReplayLogEntry[];
  }> {
    const win = checkWin(game) || 'evil';
    const identities = buildReplayIdentities(game);
    return {
      winner: win,
      winnerZh: win === 'good' ? '善良阵营' : '邪恶阵营',
      identities,
      entries: game.replayLog,
    };
  }
}

// 工具
function randomPlausibleNumber(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
