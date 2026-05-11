// ============================================================
// 血染钟楼 服务端入口
// 三层架构：Transport (WS/HTTP) → Agent → Engine
// ============================================================

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { configureLlm, getLlmConfig } from './llm/llmClient.js';
import {
  createRoom, getRoom, joinRoom, getRoomView, setReady,
  bindConnection, unbindConnection, rooms,
} from './game/roomManager.js';
import {
  initGame, assignCharacters, getEffectiveCharacterId, getShownCharacterId,
  computeChefPairs, computeEmpathCount, checkFortuneTellerTargets,
  resolveUndertakerInfo, resolveRavenkeeperInfo, resolveDemonKill,
  isPoisonedOrDrunk, findDemon, findAliveMinions,
  getCurrentNightStep, getCurrentNightOrder,
  nominate, skipNomination, vote, tallyVotes, tryEndDay,
  checkWin, checkSaintExecutionLoss, checkScarletWoman, shouldMayorBounce,
  executeSlayerShot, checkVirginTrigger,
  pushPublicLog, pushReplayLog, buildWorldView, buildReplayIdentities,
  gotoDay, gotoNight,
} from './engine/gameEngine.js';
import type {
  GameState, Room, ScriptDef, PlayerState, Nomination,
  GamePhase, DaySubPhase, ChatEntry, PublicLogEntry, ReplayLogEntry,
  WorldView, YourRoleInfo, Alignment,
  PendingNightAction, InfoRoleResult, AiDecisionEntry,
} from './engine/types.js';
import { troubleBrewing } from './scripts/troubleBrewing.js';
import { buildGameRecord, writeGameRecord } from './engine/gameRecord.js';

// ============================================================
// 配置
// ============================================================

const AI_STORYTELLER_ENABLED = (process.env.USE_AI_STORYTELLER ?? 'true').trim().toLowerCase() !== 'false';
const AI_PLAYER_ENABLED = (process.env.USE_AI_PLAYER ?? 'true').trim().toLowerCase() !== 'false';
const AI_STORYTELLER_MODEL = process.env.OPENAI_MODEL ?? 'qwen-plus';

configureLlm({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode',
  model: AI_STORYTELLER_MODEL,
  enabled: !!(process.env.OPENAI_API_KEY),
});

// ============================================================
// 工具函数
// ============================================================

function seatLabel(game: GameState, seatIndex: number): string {
  const p = game.players[seatIndex];
  return p ? `#${seatIndex + 1} ${p.nickname}` : `#${seatIndex + 1}`;
}

function pushPublic(game: GameState, line: string): void {
  pushPublicLog(game, line);
}

function pushReplay(game: GameState, groupKey: string, groupTitle: string, line: string): void {
  pushReplayLog(game, groupKey, groupTitle, line);
}

function pushChatLog(game: GameState, entry: Omit<ChatEntry, 'id'>): ChatEntry {
  const full: ChatEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
  game.chatLog.push(full);
  if (game.chatLog.length > 500) game.chatLog = game.chatLog.slice(-500);
  return full;
}

function logAiDecision(
  game: GameState, seatIndex: number,
  type: AiDecisionEntry['type'], decision: unknown, reasoning: string,
): void {
  game.aiDecisionLog.push({
    at: Date.now(), dayNumber: game.dayNumber, phase: game.phase,
    seatIndex, type, decision, reasoning: reasoning.slice(0, 300),
  });
  if (game.aiDecisionLog.length > 500) game.aiDecisionLog = game.aiDecisionLog.slice(-400);
}

function nightReplayTitle(game: GameState): { key: string; title: string } {
  if (game.phase === 'first_night') return { key: 'first_night', title: '首夜' };
  const nightOrdinal = game.dayNumber + 1;
  return { key: `night_${nightOrdinal}`, title: `第 ${nightOrdinal} 夜` };
}

function dayReplayTitle(game: GameState): { key: string; title: string } {
  return { key: `day_${game.dayNumber}`, title: `第 ${game.dayNumber} 天 · 白天` };
}

// ============================================================
// 上帝问答（确定性，非 AI）
// ============================================================

function normalizeGodQuery(text: string): string {
  return text.trim().replace(/\s+/g, '');
}

function makeGodReply(game: GameState, seatIndex: number, queryRaw: string): string {
  const query = normalizeGodQuery(queryRaw);
  const p = game.players[seatIndex];
  if (!p) return '上帝：……';
  if (query !== '今晚信息' && query !== '信息' && query !== '今晚' && query !== '结果')
    return '上帝：你现在得不到更多信息。';
  if (!p.isAlive) return '上帝：你已死亡。';

  const shown = getShownCharacterId(p);
  if (!shown) return '上帝：……';

  if (shown === 'chef') {
    return `厨师：你得知相邻两名邪恶玩家的数量为 ${computeChefPairs(game)}。`;
  }
  if (shown === 'empath') {
    return `共情者：你得知相邻邪恶玩家数量为 ${computeEmpathCount(game, seatIndex)}。`;
  }
  if (shown === 'undertaker') {
    const info = resolveUndertakerInfo(game);
    if (!info) return '掘墓人：无信息';
    const char = game.script.characters.find(c => c.id === info.characterId);
    return `掘墓人：今日被处决的是 #${info.seatIndex + 1}，其身份为「${char?.nameZh ?? info.characterId}」。`;
  }
  if (shown === 'ravenkeeper') {
    const attacker = resolveRavenkeeperInfo(game, seatIndex);
    if (attacker == null) return '守鸦人：无信息';
    const ap = game.players[attacker];
    const aCharId = getShownCharacterId(ap);
    const aChar = aCharId ? game.script.characters.find(c => c.id === aCharId) : undefined;
    return `守鸦人：杀害你的是 #${attacker + 1}，其身份为「${aChar?.nameZh ?? aCharId ?? '未知'}」。`;
  }
  if (shown === 'washerwoman' || shown === 'librarian' || shown === 'investigator') {
    const decision = game.storytellerDecisions.get(shown) as InfoRoleResult | undefined;
    if (!decision) return `${game.script.characters.find(c => c.id === shown)?.nameZh ?? shown}：无信息`;
    return formatInfoRoleResult(game, shown, decision);
  }
  if (shown === 'fortune_teller') {
    return '占卜师：请等待夜晚行动结束后获取信息。';
  }

  return '上帝：你现在得不到更多信息。';
}

function formatInfoRoleResult(game: GameState, stepId: string, decision: InfoRoleResult): string {
  const charName = game.script.characters.find(c => c.id === stepId)?.nameZh ?? stepId;
  if (decision.type === 'washerwoman_result') {
    const roleName = game.script.characters.find(c => c.id === decision.characterId)?.nameZh ?? decision.characterId;
    return `${charName}：在 #${decision.players[0] + 1} 与 #${decision.players[1] + 1} 中，有一位是「${roleName}」。`;
  }
  if (decision.type === 'librarian_result') {
    if (decision.noOutsider) return `${charName}：本局没有外来者。`;
    const roleName = game.script.characters.find(c => c.id === decision.characterId)?.nameZh ?? decision.characterId;
    return `${charName}：在 #${decision.players[0] + 1} 与 #${decision.players[1] + 1} 中，有一位是「${roleName}」。`;
  }
  if (decision.type === 'investigator_result') {
    const roleName = game.script.characters.find(c => c.id === decision.characterId)?.nameZh ?? decision.characterId;
    return `${charName}：在 #${decision.players[0] + 1} 与 #${decision.players[1] + 1} 中，有一位是「${roleName}」。`;
  }
  return `${charName}：无信息`;
}

// ============================================================
// 复盘
// ============================================================

function buildReplayBundle(game: GameState, winner: 'good' | 'evil'): object {
  const identities = game.players.map(p => {
    const charId = p.characterId ?? 'unknown';
    const char = game.script.characters.find(c => c.id === charId);
    return {
      seatIndex: p.seatIndex,
      nickname: p.nickname,
      characterId: charId,
      characterName: char?.name ?? charId,
      characterZh: char?.nameZh ?? charId,
      ability: char?.ability ?? '',
      alignment: char?.alignment ?? 'good',
      survived: p.isAlive,
    };
  });
  return {
    version: '2.0',
    winner,
    winnerZh: winner === 'good' ? '善良阵营' : '邪恶阵营',
    identities,
    entries: game.replayLog,
  };
}

// ============================================================
// 构建你的角色信息
// ============================================================

function buildYourRole(game: GameState, seatIndex: number): YourRoleInfo | null {
  const p = game.players[seatIndex];
  if (!p?.characterId) return null;
  const shownId = getShownCharacterId(p);
  if (!shownId) return null;
  const char = game.script.characters.find(c => c.id === shownId);
  if (!char) return null;
  return {
    characterId: shownId,
    characterName: char.name,
    characterNameZh: char.nameZh,
    ability: char.ability,
    abilityZh: char.abilityZh,
    alignment: char.alignment,
    type: char.type,
    infoSource: char.infoSource,
  };
}

// ============================================================
// Express HTTP 路由
// ============================================================

const app = express();
app.use(cors());
app.use(express.json());

const HTTP_PORT = Number(process.env.PORT ?? '') || 3001;

app.get('/api/scripts', (_req, res) => {
  res.json([{
    id: troubleBrewing.id,
    name: troubleBrewing.name,
    nameZh: troubleBrewing.nameZh,
    minPlayers: troubleBrewing.minPlayers,
    maxPlayers: troubleBrewing.maxPlayers,
  }]);
});

app.post('/api/rooms', (req, res) => {
  const scriptId = (req.body?.scriptId as string) || troubleBrewing.id;
  const room = createRoom(scriptId);
  res.json({ roomId: room.id, scriptId: room.game.scriptId, hostSecret: room.hostSecret });
});

app.post('/api/rooms/:roomId/join', (req, res) => {
  const { roomId } = req.params;
  const nickname = (req.body?.nickname as string) || 'Player';
  const result = joinRoom(roomId, nickname);
  if (!result) return res.status(400).json({ error: 'Cannot join room' });
  const view = getRoomView(result.room);
  res.json({
    roomId, seatIndex: result.seatIndex,
    playerId: result.room.game.players[result.seatIndex].id,
    room: view,
  });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(getRoomView(room));
});

app.get('/api/storyteller-ai', (_req, res) => {
  const cfg = getLlmConfig();
  res.json({
    enabled: AI_STORYTELLER_ENABLED && cfg.enabled,
    useAiFlag: AI_STORYTELLER_ENABLED,
    hasApiKey: cfg.apiKey !== '(empty)',
    baseUrl: cfg.baseUrl,
    model: cfg.model,
  });
});

// 开发辅助：LLM 健康检查
app.get('/api/dev/llm/health', (_req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  const cfg = getLlmConfig();
  res.json({
    storyteller: { enabled: cfg.enabled, model: cfg.model },
    aiPlayer: { enabled: cfg.enabled, model: process.env.AI_PLAYER_MODEL ?? cfg.model },
    baseUrl: cfg.baseUrl,
    model: cfg.model,
  });
});

// 开发辅助：快速开局
app.post('/api/dev/quickstart', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });

  const scriptId = (req.body?.scriptId as string) || troubleBrewing.id;
  const playerCount = Number.isInteger(req.body?.playerCount) ? (req.body.playerCount as number) : 5;
  const start = req.body?.start !== false;

  const room = createRoom(scriptId);
  const nickPrefix = ['夜行', '钟声', '雾隐', '火漆', '预言', '静默', '迷踪', '秘钥', '月影', '余烬'];
  const nickSuffix = ['守夜人', '提名王', '验人师', '反转侠', '沉默狼', '谜语客', '夜鸦', '推理官', '投票手', '烛火'];
  const players: Array<{ seatIndex: number; nickname: string }> = [];

  for (let i = 0; i < playerCount; i++) {
    const nickname = `${nickPrefix[i % nickPrefix.length]}${nickSuffix[i % nickSuffix.length]}${Math.floor(Math.random() * 90) + 10}`;
    const j = joinRoom(room.id, nickname);
    if (!j) break;
    setReady(room, j.seatIndex, true);
    players.push({ seatIndex: j.seatIndex, nickname });
  }

  if (start) {
    startGameInternal(room);
    const phaseBefore = room.game.phase;
    await runNightLoop(room);
    sendEvilInfo(room);
    sendNightPromptToPending(room);
    broadcastAfterNight(room, phaseBefore);
    broadcastNightConfirmStatus(room);
  }

  const origin = (req.headers.origin as string | undefined) ?? '';
  let base = origin || 'http://localhost:5173';
  if (/:(3001)$/.test(String(req.get('host') ?? '')) && !/:(5173|5174)$/.test(base))
    base = 'http://localhost:5173';

  const joinUrls = players.map(p =>
    `${base}/?autoJoin=1&autoAi=1&roomId=${encodeURIComponent(room.id)}&nickname=${encodeURIComponent(p.nickname)}`);
  const adminUrl = `${base}/?admin=1&roomId=${encodeURIComponent(room.id)}&hostSecret=${encodeURIComponent(room.hostSecret)}`;

  res.json({ roomId: room.id, hostSecret: room.hostSecret, players, joinUrls, adminUrl, started: start });
});

// 开发辅助：快速进入已有座位
app.post('/api/dev/take-seat', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  const rid = String(req.body?.roomId ?? '');
  const nickname = String(req.body?.nickname ?? '').trim();
  if (!rid || !nickname) return res.status(400).json({ error: 'roomId and nickname required' });
  const room = getRoom(rid);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const seatIndex = room.game.players.find(p => p.nickname === nickname)?.seatIndex;
  if (seatIndex == null) return res.status(404).json({ error: 'Seat not found' });
  const view = getRoomView(room);
  res.json({ roomId: rid, seatIndex, room: view });
});

// ============================================================
// WebSocket 服务
// ============================================================

const server = createServer(app);
const wss = new WebSocketServer({ server });

type ClientMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'start' }
  | { type: 'nominate'; nominatedSeat: number }
  | { type: 'skip_nomination' }
  | { type: 'vote'; inFavor: boolean }
  | { type: 'chat_send'; scope: 'god' | 'dm' | 'public'; toSeat?: number; text: string }
  | { type: 'toggle_ai_player'; enabled: boolean }
  | { type: 'toggle_ai_storyteller'; enabled: boolean }
  | { type: 'night_confirm' }
  | { type: 'night_action'; targets: number[] }
  | { type: 'day_action'; actionId: string; targetSeat?: number }
  | { type: 'ping' };

// ============================================================
// 游戏流程
// ============================================================

function startGameInternal(room: Room): boolean {
  const game = room.game;
  if (game.players.length < game.script.minPlayers) return false;
  if (game.players.some(p => !p.isReady)) return false;

  initGame(game);
  room.status = 'playing';

  // 默认所有真人玩家启用 AI 托管
  if (AI_PLAYER_ENABLED) {
    for (const p of game.players) {
      room.aiPlayerEnabledBySeat.set(p.seatIndex, true);
    }
  }

  pushReplay(game, 'setup', '对局',
    `游戏开始：${game.players.length} 人，剧本「${game.script.nameZh}」。`);
  pushPublic(game,
    `游戏开始：${game.players.length} 人，剧本「${game.script.nameZh}」。`);
  pushReplay(game, 'first_night', '首夜', '进入首夜。');
  pushReplay(game, 'first_night', '首夜',
    '本夜仅有信息步骤；恶魔首次刀人在下一普通夜。');

  return true;
}

async function runNightLoop(room: Room): Promise<void> {
  const game = room.game;

  for (;;) {
    if (game.phase !== 'first_night' && game.phase !== 'night') break;

    const stepId = getCurrentNightStep(game);
    if (!stepId) {
      // 所有步骤完成，进入等待确认
      game.awaitingNightConfirm = true;
      break;
    }

    const charDef = game.script.characters.find(c => c.id === stepId);
    if (!charDef) {
      game.nightStepIndex++;
      continue;
    }

    const actorSeat = game.players.find(
      p => p.isAlive && (
        getEffectiveCharacterId(p) === stepId ||
        // 间谍在所有夜晚步骤中都有行动机会
        (getEffectiveCharacterId(p) === 'spy' && stepId === 'spy')
      )
    );

    const poisoned = actorSeat ? isPoisonedOrDrunk(game, actorSeat.seatIndex) : false;

    // ----- 信息步骤（规则计算） -----
    if (charDef.infoSource === 'rule') {
      if (stepId === 'chef') {
        const chefSeat = game.players.find(
          p => p.isAlive && getEffectiveCharacterId(p) === 'chef');
        if (chefSeat && !isPoisonedOrDrunk(game, chefSeat.seatIndex)) {
          const count = computeChefPairs(game);
          const msg = `厨师：相邻的邪恶玩家对数为 ${count}。`;
          pushReplay(game, nightReplayTitle(game).key, nightReplayTitle(game).title,
            `[夜间信息] ${seatLabel(game, chefSeat.seatIndex)}：${msg}`);
          sendToSeat(room.id, chefSeat.seatIndex, { type: 'night_info', message: msg });
        }
      } else if (stepId === 'empath') {
        const empathSeat = game.players.find(
          p => p.isAlive && getEffectiveCharacterId(p) === 'empath');
        if (empathSeat && !isPoisonedOrDrunk(game, empathSeat.seatIndex)) {
          const count = computeEmpathCount(game, empathSeat.seatIndex);
          const msg = `共情者：你相邻的邪恶玩家数量为 ${count}。`;
          pushReplay(game, nightReplayTitle(game).key, nightReplayTitle(game).title,
            `[夜间信息] ${seatLabel(game, empathSeat.seatIndex)}：${msg}`);
          sendToSeat(room.id, empathSeat.seatIndex, { type: 'night_info', message: msg });
        }
      }
      game.nightStepIndex++;
      continue;
    }

    // ----- 恶魔/爪牙信息（首夜） -----
    if (stepId === 'demon_info') {
      const demon = findDemon(game);
      if (demon) {
        const minions = findAliveMinions(game);
        const minionList = minions.map(m => `#${m.seatIndex + 1}`).join('、') || '无';
        const bluffs = game.demonBluffs.join('、');
        const msg = `你是恶魔。爪牙：${minionList}。不在场善良身份：${bluffs}`;
        pushReplay(game, nightReplayTitle(game).key, nightReplayTitle(game).title,
          `[夜间信息] ${seatLabel(game, demon.seatIndex)}：恶魔获知同伴与bluff`);
        sendToSeat(room.id, demon.seatIndex, { type: 'night_info', message: msg });
      }
      game.nightStepIndex++;
      continue;
    }

    if (stepId === 'minion_info') {
      const demon = findDemon(game);
      if (demon) {
        const minions = findAliveMinions(game);
        for (const m of minions) {
          const msg = `你是爪牙。恶魔：#${demon.seatIndex + 1}。`;
          sendToSeat(room.id, m.seatIndex, { type: 'night_info', message: msg });
        }
      }
      game.nightStepIndex++;
      continue;
    }

    // ----- 间谍特殊：看魔典 -----
    if (stepId === 'spy') {
      const spySeat = game.players.find(
        p => p.isAlive && getEffectiveCharacterId(p) === 'spy');
      if (spySeat) {
        // 间谍看到完整角色分配
        const grimoire = game.players.map(p => {
          const char = game.script.characters.find(c => c.id === p.characterId);
          return `#${p.seatIndex + 1}: ${char?.nameZh ?? '?'}(${p.isAlive ? '存活' : '死亡'})`;
        }).join(', ');
        sendToSeat(room.id, spySeat.seatIndex, {
          type: 'night_info',
          message: `间谍魔典：${grimoire}`,
        });
      }
      game.nightStepIndex++;
      continue;
    }

    // ----- 说书人裁量信息步骤 -----
    if (charDef.infoSource === 'storyteller') {
      if (!actorSeat) { game.nightStepIndex++; continue; }

      const decision = await storytellerDecision(room, stepId, charDef, actorSeat.seatIndex);
      if (decision) {
        game.storytellerDecisions.set(stepId, decision);
        const msg = formatInfoRoleResult(game, stepId, decision);
        pushReplay(game, nightReplayTitle(game).key, nightReplayTitle(game).title,
          `[夜间信息] ${seatLabel(game, actorSeat.seatIndex)}：${msg}`);
        sendToSeat(room.id, actorSeat.seatIndex, { type: 'night_info', message: msg });
      }
      game.nightStepIndex++;
      continue;
    }

    // ----- 玩家选择步骤（恶魔杀人、僧侣保护等） -----
    if (charDef.requiresPlayerChoice && actorSeat) {
      // 恶魔首夜不杀人
      if (stepId === 'imp' && game.phase === 'first_night') {
        game.nightStepIndex++;
        continue;
      }

      if (poisoned) {
        // 中毒/酒鬼：跳过行动但可能给虚假信息
        game.nightStepIndex++;
        continue;
      }

      game.pendingNightAction = {
        stepId,
        actorSeatIndex: actorSeat.seatIndex,
        pick: (charDef.pickCount ?? 1) as 1 | 2,
      };

      // 如果是 AI 玩家，立刻自动处理
      if (room.aiPlayerEnabledBySeat.get(actorSeat.seatIndex)) {
        await handleAiNightAction(room, actorSeat.seatIndex);
        continue;
      }

      // 人类玩家：等待输入
      break;
    }

    game.nightStepIndex++;
  }
}

async function storytellerDecision(
  room: Room,
  stepId: string,
  charDef: { id: string; name: string; nameZh: string },
  targetSeat: number,
): Promise<InfoRoleResult | null> {
  const game = room.game;
  const aliveSeats = game.players.filter(p => p.isAlive).map(p => p.seatIndex);

  if (!AI_STORYTELLER_ENABLED) {
    return storytellerFallback(game, stepId, aliveSeats);
  }

  try {
    const { buildStorytellerPrompts } = await import('./agents/storyteller/prompts.js');
    const { callLlm } = await import('./llm/llmClient.js');

    const { systemPrompt, userPrompt } = buildStorytellerPrompts(game, stepId, charDef as any);

    const result = await callLlm(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.7, jsonMode: true, maxAttempts: 3, timeoutMs: 20000 },
    );

    if (result.json) {
      const validated = validateStorytellerDecision(result.json, stepId, aliveSeats, game.script);
      if (validated) return validated;
    }
  } catch {
    // fall through to fallback
  }

  return storytellerFallback(game, stepId, aliveSeats);
}

function storytellerFallback(
  game: GameState,
  stepId: string,
  aliveSeats: number[],
): InfoRoleResult | null {
  const pick2 = randomPick(aliveSeats, 2) as [number, number];

  if (stepId === 'washerwoman') {
    const townsfolk = game.script.characters.filter(c => c.type === 'townsfolk');
    const charId = townsfolk[Math.floor(Math.random() * townsfolk.length)].id;
    return { type: 'washerwoman_result', players: pick2, characterId: charId };
  }
  if (stepId === 'librarian') {
    const outsiders = game.script.characters.filter(c => c.type === 'outsider');
    const hasOutsider = game.players.some(p => {
      const cid = getEffectiveCharacterId(p);
      return cid && game.script.characters.find(c => c.id === cid)?.type === 'outsider';
    });
    if (!hasOutsider) {
      return { type: 'librarian_result', players: pick2, characterId: 'drunk', noOutsider: true };
    }
    const charId = outsiders[Math.floor(Math.random() * outsiders.length)].id;
    return { type: 'librarian_result', players: pick2, characterId: charId };
  }
  if (stepId === 'investigator') {
    const minions = game.script.characters.filter(c => c.type === 'minion');
    const charId = minions[Math.floor(Math.random() * minions.length)].id;
    return { type: 'investigator_result', players: pick2, characterId: charId };
  }
  return null;
}

function validateStorytellerDecision(
  json: Record<string, unknown>,
  stepId: string,
  aliveSeats: number[],
  script: ScriptDef,
): InfoRoleResult | null {
  const players = json.players as number[] | undefined;
  if (!Array.isArray(players) || players.length !== 2) return null;
  const [a, b] = players.map(Number);
  if (!aliveSeats.includes(a) || !aliveSeats.includes(b) || a === b) return null;

  const characterId = json.characterId as string | undefined;
  if (!characterId) return null;

  if (stepId === 'washerwoman') {
    const char = script.characters.find(c => c.id === characterId);
    if (!char || char.type !== 'townsfolk') return null;
    return { type: 'washerwoman_result', players: [a, b], characterId };
  }
  if (stepId === 'librarian') {
    if (json.noOutsider === true) {
      return { type: 'librarian_result', players: [a, b], characterId, noOutsider: true };
    }
    const char = script.characters.find(c => c.id === characterId);
    if (!char || char.type !== 'outsider') return null;
    return { type: 'librarian_result', players: [a, b], characterId };
  }
  if (stepId === 'investigator') {
    const char = script.characters.find(c => c.id === characterId);
    if (!char || char.type !== 'minion') return null;
    return { type: 'investigator_result', players: [a, b], characterId };
  }
  return null;
}

function randomPick(arr: number[], count: number): number[] {
  const pool = [...arr];
  const result: number[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

// ============================================================
// AI 夜晚行动处理
// ============================================================

async function handleAiNightAction(room: Room, seatIndex: number): Promise<void> {
  const game = room.game;
  const pending = game.pendingNightAction;
  if (!pending || pending.actorSeatIndex !== seatIndex) return;

  const aliveAll = game.players.filter(p => p.isAlive).map(p => p.seatIndex);
  const aliveChoices = pending.stepId === 'imp'
    ? aliveAll.filter(s => s !== seatIndex)
    : aliveAll;

  // 尝试调用 PlayerAgent
  let targets: number[] = [];
  if (AI_PLAYER_ENABLED) {
    try {
      const wv = buildWorldView(game, seatIndex);
      const playerKey = `${room.id}_${seatIndex}`;

      const { getOrCreatePlayerAgent } = await import('./agents/player/playerAgent.js');
      const p = game.players[seatIndex];
      const shownId = getShownCharacterId(p);
      const char = shownId ? game.script.characters.find(c => c.id === shownId) : undefined;
      const alignment = char?.alignment ?? 'good';

      const yourRole: YourRoleInfo = {
        characterId: shownId ?? 'unknown',
        characterName: char?.name ?? 'unknown',
        characterNameZh: char?.nameZh ?? '未知',
        ability: char?.ability ?? '',
        abilityZh: char?.abilityZh ?? '',
        alignment,
        type: char?.type ?? 'townsfolk',
        infoSource: char?.infoSource ?? 'none',
      };

      const agent = getOrCreatePlayerAgent(
        playerKey, seatIndex, yourRole, alignment,
        room.aiPlayerBehaviorStyleBySeat.get(seatIndex),
      );
      agent.perceive(wv);
      const result = await agent.decideNightTargets(
        pending.stepId, pending.pick, aliveChoices, wv,
      );
      targets = result.targets;
      logAiDecision(game, seatIndex, 'night_action', { stepId: pending.stepId, targets: result.targets }, result.reasoning);
    } catch (e) {
      console.error(`[AI] decideNightTargets error seat ${seatIndex}:`, (e as Error).message);
      // fallback to random
    }
  }

  // 确保合法的 targets：数量正确且在存活列表中
  const validTargets = targets.filter(t =>
    typeof t === 'number' && Number.isFinite(t) && aliveChoices.includes(t));
  if (validTargets.length !== pending.pick) {
    console.warn(`[AI] night targets invalid (got ${JSON.stringify(targets)}, expected ${pending.pick} from ${JSON.stringify(aliveChoices)}), fallback to random`);
    targets = randomPick(aliveChoices, pending.pick);
  } else {
    targets = validTargets;
  }

  await processNightAction(room, seatIndex, targets);
}

async function processNightAction(
  room: Room, seatIndex: number, targets: number[],
): Promise<void> {
  const game = room.game;
  const pending = game.pendingNightAction;
  if (!pending) return;

  const { key, title } = nightReplayTitle(game);

  if (pending.stepId === 'imp' && targets[0] !== undefined) {
    resolveDemonKill(game, targets[0], seatIndex);
    pushReplay(game, key, title,
      `${seatLabel(game, seatIndex)}（恶魔）选择杀害 ${seatLabel(game, targets[0])}。`);
    // 检查绯红寡妇继位
    checkScarletWoman(game);
  } else if (pending.stepId === 'monk' && targets[0] !== undefined) {
    game.protectedSeatIndex = targets[0];
    pushReplay(game, key, title,
      `${seatLabel(game, seatIndex)}（僧侣）选择保护 ${seatLabel(game, targets[0])}。`);
  } else if (pending.stepId === 'poisoner' && targets[0] !== undefined) {
    game.poisonedSeatIndex = targets[0];
    pushReplay(game, key, title,
      `${seatLabel(game, seatIndex)}（投毒者）选择毒害 ${seatLabel(game, targets[0])}。`);
  } else if (pending.stepId === 'fortune_teller' && targets.length === 2) {
    const isDemon = checkFortuneTellerTargets(game, targets, seatIndex);
    pushReplay(game, key, title,
      `${seatLabel(game, seatIndex)}（占卜师）选择查验 ${seatLabel(game, targets[0])} 与 ${seatLabel(game, targets[1])}。`);
    const msg = `占卜师：你选择了 #${targets[0] + 1} 与 #${targets[1] + 1}，结果为「${isDemon ? '是' : '否'}」。`;
    sendToSeat(room.id, seatIndex, { type: 'night_info', message: msg });
  }

  game.pendingNightAction = null;
  game.nightStepIndex++;

  // 继续推进夜序
  await runNightLoop(room);

  // 发送下一等待 (如果有)
  sendNightPromptToPending(room);
}

// ============================================================
// 白天结束处理
// ============================================================

async function handleDayEnd(
  room: Room, executedSeatIndex: number | null,
): Promise<void> {
  const game = room.game;

  if (room.status === 'ended') {
    const win = checkWin(game);
    if (win) emitGameOver(room, win);
    return;
  }

  const { key, title } = dayReplayTitle(game);
  if (executedSeatIndex != null) {
    pushReplay(game, key, title,
      `处决执行：${seatLabel(game, executedSeatIndex)} 死亡。`);
    pushPublic(game, `处决执行：${seatLabel(game, executedSeatIndex)} 死亡。`);
  } else {
    pushReplay(game, key, title, '今日无人被处决。');
    pushPublic(game, '今日无人被处决。');
  }

  // 检查猩红寡妇
  checkScarletWoman(game);

  // 进入夜晚
  gotoNight(game);
  pushReplay(game, nightReplayTitle(game).key, nightReplayTitle(game).title, '进入夜晚。');
  pushPublic(game, '进入夜晚。');

  // 推进夜序
  await runNightLoop(room);
  sendNightPromptToPending(room);
  broadcastAfterNight(room, game.phase);
  broadcastNightConfirmStatus(room);
}

// ============================================================
// 邪恶阵营信息分发
// ============================================================

function sendEvilInfo(room: Room): void {
  const game = room.game;
  if (game.phase !== 'first_night') return;

  // demon_info 和 minion_info 步骤已在 runNightLoop 中处理
  // 这里只处理特殊情况
}

// ============================================================
// 广播函数
// ============================================================

function broadcast(roomId: string, payload: object, excludeConnectionId?: string): void {
  const room = getRoom(roomId);
  if (!room) return;
  (wss as any).clients?.forEach((ws: any) => {
    if (ws.roomId !== roomId || ws.connectionId === excludeConnectionId || ws.readyState !== 1) return;
    let p = payload as Record<string, unknown>;
    if (payload && typeof payload === 'object') {
      const type = (payload as any).type;
      const seatIndex = ws.seatIndex as number;
      if (typeof seatIndex === 'number' && (type === 'room' || type === 'game_over') && (payload as any).room) {
        const yourCharId = getShownCharacterId(room.game.players[seatIndex]);
        const yourRole = buildYourRole(room.game, seatIndex);
        p = {
          ...(payload as object),
          room: getRoomView(room, seatIndex, false),
          yourCharacterId: yourCharId,
          yourRole,
          yourSeatIndex: seatIndex,
          isHost: !!ws.isHost,
        } as Record<string, unknown>;
      } else if ((type === 'room' || type === 'game_over') && (payload as any).room && ws.isAdmin) {
        p = {
          ...(payload as object),
          room: getRoomView(room, undefined, true),
          isHost: !!ws.isHost,
          isAdmin: true,
        } as Record<string, unknown>;
      }
    }
    ws.send(JSON.stringify(p));
  });
}

function sendToSeat(roomId: string, seatIndex: number, payload: object): void {
  const room = getRoom(roomId);
  if (!room) return;
  (wss as any).clients?.forEach((ws: any) => {
    if (ws.roomId !== roomId || ws.readyState !== 1) return;
    if (ws.seatIndex !== seatIndex) return;
    let p = payload as Record<string, unknown>;
    if (payload && typeof payload === 'object' && (payload as any).type === 'room' && (payload as any).room) {
      const yourCharId = getShownCharacterId(room.game.players[seatIndex]);
      const yourRole = buildYourRole(room.game, seatIndex);
      p = {
        ...(payload as object),
        yourCharacterId: yourCharId,
        yourRole,
        yourSeatIndex: seatIndex,
        isHost: !!ws.isHost,
      } as Record<string, unknown>;
    }
    ws.send(JSON.stringify(p));
  });
}

function broadcastChat(roomId: string, entry: ChatEntry): void {
  if (entry.scope === 'god') {
    sendToSeat(roomId, entry.fromSeat, { type: 'chat_event', entry });
    return;
  }
  if (entry.scope === 'dm') {
    sendToSeat(roomId, entry.fromSeat, { type: 'chat_event', entry });
    if (typeof entry.toSeat === 'number') sendToSeat(roomId, entry.toSeat, { type: 'chat_event', entry });
    return;
  }
  if (entry.scope === 'public') {
    broadcast(roomId, { type: 'chat_event', entry });
  }
}

function sendNightPromptToPending(room: Room): void {
  const game = room.game;
  if (!game.pendingNightAction) return;
  const a = game.pendingNightAction;
  sendToSeat(room.id, a.actorSeatIndex, {
    type: 'night_prompt',
    stepId: a.stepId,
    actorSeatIndex: a.actorSeatIndex,
    pick: a.pick,
    aliveSeatIndices: game.players.filter(p => p.isAlive).map(p => p.seatIndex),
  });
}

function broadcastNightConfirmStatus(room: Room): void {
  broadcast(room.id, {
    type: 'night_confirm_update',
    awaiting: room.game.awaitingNightConfirm,
    confirmedSeats: Array.from(room.game.nightConfirmations),
  });
}

function broadcastAfterNight(room: Room, phaseBefore: GamePhase): void {
  const game = room.game;

  if (phaseBefore === 'night' || phaseBefore === 'first_night') {
    const dawnLike = game.phase === 'day' || (room.status === 'ended' && game.phase === 'waiting');
    if (dawnLike) {
      const mk = `dawn_logged_day_${game.dayNumber}`;
      if (game.storytellerDecisions.get(mk) !== true) {
        game.storytellerDecisions.set(mk, true);
        const dead = game.lastNightDeaths.length > 0
          ? `天亮公布：昨夜死亡 ${game.lastNightDeaths.map(s => seatLabel(game, s)).join('、')}`
          : '天亮公布：昨夜无人死亡';
        pushReplay(game, dayReplayTitle(game).key, dayReplayTitle(game).title, dead);
      }
    }
  }

  if (room.status === 'ended') {
    const win = checkWin(game);
    if (win) emitGameOver(room, win);
    return;
  }

  broadcast(room.id, { type: 'room', room: getRoomView(room) });
  broadcast(room.id, { type: 'phase', phase: game.phase, dayNumber: game.dayNumber });
}

function emitGameOver(room: Room, winner: 'good' | 'evil'): void {
  const game = room.game;
  const k = 'game_over_sent';
  if (game.storytellerDecisions.get(k) === true) return;
  game.storytellerDecisions.set(k, true);

  room.status = 'ended';
  for (const p of game.players) p.isReady = false;

  pushReplay(game, 'result', '游戏结束',
    `${winner === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);

  // 输出复盘文件
  try {
    const record = buildGameRecord(room, winner);
    writeGameRecord(record);
  } catch (e) {
    console.error('[BOTC] Failed to write game record:', (e as Error).message);
  }

  const replay = buildReplayBundle(game, winner);
  broadcast(room.id, {
    type: 'game_over', winner,
    room: getRoomView(room), replay,
  });
}

// ============================================================
// WebSocket 连接处理
// ============================================================

wss.on('connection', (ws: any, req) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const roomId = url.searchParams.get('roomId');
  const seatIndexStr = url.searchParams.get('seatIndex');
  const hostSecret = url.searchParams.get('hostSecret');
  const adminMode = url.searchParams.get('admin') === '1';
  const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  ws.connectionId = connectionId;
  ws.roomId = roomId;
  ws.seatIndex = seatIndexStr !== null ? parseInt(seatIndexStr, 10) : null;
  ws.isHost = false;
  ws.isAdmin = adminMode;

  if (!roomId || (!adminMode && seatIndexStr === null)) {
    ws.send(JSON.stringify({ type: 'error', message: 'roomId required; seatIndex required unless admin=1' }));
    ws.close();
    return;
  }

  const room = getRoom(roomId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    ws.close();
    return;
  }

  if (hostSecret && hostSecret === room.hostSecret) ws.isHost = true;

  if (!adminMode) {
    const si = parseInt(seatIndexStr!, 10);
    bindConnection(room, connectionId, si);
    ws.send(JSON.stringify({
      type: 'room',
      room: getRoomView(room),
      yourSeatIndex: si,
      yourCharacterId: getShownCharacterId(room.game.players[si]),
      yourRole: buildYourRole(room.game, si),
      isHost: ws.isHost,
      isAdmin: false,
    }));
  } else {
    ws.send(JSON.stringify({
      type: 'room',
      room: getRoomView(room, undefined, true),
      isHost: ws.isHost,
      isAdmin: true,
    }));
  }

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as ClientMessage;
      const room = getRoom(roomId);
      if (!room) return;
      const game = room.game;
      const seatIndex = seatIndexStr !== null ? parseInt(seatIndexStr, 10) : -1;
      const isHost = !!ws.isHost;
      const isAdmin = !!ws.isAdmin;

      // --- 准备 ---
      if (msg.type === 'ready') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_ready' })); return; }
        setReady(room, seatIndex, msg.ready);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }

      // --- 开始游戏 ---
      if (msg.type === 'start') {
        if (!isHost) { ws.send(JSON.stringify({ type: 'error', message: 'host_only:start' })); return; }
        if (!startGameInternal(room)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot start game' }));
          return;
        }
        const phaseBefore = game.phase;
        await runNightLoop(room);
        sendEvilInfo(room);
        sendNightPromptToPending(room);
        broadcastAfterNight(room, phaseBefore);
        broadcastNightConfirmStatus(room);
        return;
      }

      // --- 提名 ---
      if (msg.type === 'nominate') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_nominate' })); return; }
        const ok = nominate(game, seatIndex, msg.nominatedSeat);
        if (!ok) { ws.send(JSON.stringify({ type: 'error', message: 'Nomination not allowed' })); return; }
        const { key, title } = dayReplayTitle(game);
        pushReplay(game, key, title,
          `${seatLabel(game, seatIndex)} 提名 ${seatLabel(game, msg.nominatedSeat)}。`);
        pushPublic(game,
          `${seatLabel(game, seatIndex)} 提名 ${seatLabel(game, msg.nominatedSeat)}。`);

        // 处女触发
        if (!game.players[seatIndex]?.isAlive) {
          pushReplay(game, key, title,
            `处女触发：提名者 ${seatLabel(game, seatIndex)} 立即被处决。`);
          pushPublic(game,
            `处女触发：提名者 ${seatLabel(game, seatIndex)} 立即被处决。`);
          if (room.status === 'ended') {
            const win = checkWin(game);
            if (win) {
              emitGameOver(room, win);
              return;
            }
          }
        }
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }

      // --- 跳过提名 ---
      if (msg.type === 'skip_nomination') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_skip_nomination' })); return; }
        const ok = skipNomination(game, seatIndex);
        if (!ok) { ws.send(JSON.stringify({ type: 'error', message: 'Skip nomination not allowed' })); return; }
        const { key, title } = dayReplayTitle(game);
        pushReplay(game, key, title,
          `${seatLabel(game, seatIndex)} 选择本轮不提名。`);
        pushPublic(game, `${seatLabel(game, seatIndex)} 选择本轮不提名。`);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });

        const result = tryEndDay(game);
        if (result === 'ended' || result === 'goto_night') {
          const executed = game.lastExecutedSeatIndex;
          await handleDayEnd(room, executed);
          return;
        }
        return;
      }

      // --- 投票 ---
      if (msg.type === 'vote') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_vote' })); return; }
        vote(game, seatIndex, msg.inFavor);

        // 自动结算
        if (game.currentNomination) {
          const eligible = game.players.filter(p => p.isAlive || p.hasGhostVote).map(p => p.seatIndex);
          const allVoted = eligible.every(s => game.votes.has(s));
          if (allVoted) {
            const { passed, votesFor, votes } = tallyVotes(game);
            const { key, title } = dayReplayTitle(game);
            const voteLines = votes.map(v =>
              `${seatLabel(game, v.seatIndex)}：${v.inFavor ? '赞成' : '反对'}`).join('；');
            pushReplay(game, key, title,
              `投票结束：${passed ? '达到处决条件' : '未达到处决条件'}（赞成 ${votesFor} 票）。票型：${voteLines || '（无人投票记录）'}`);
            pushPublic(game,
              `投票结束：${passed ? '达到处决条件' : '未达到处决条件'}（赞成 ${votesFor} 票）。`);
            broadcast(roomId, { type: 'vote_result', passed, votesFor, votes });
          }
        }
        broadcast(roomId, { type: 'room', room: getRoomView(room) });

        const result = tryEndDay(game);
        if (result === 'ended' || result === 'goto_night') {
          const executed = game.lastExecutedSeatIndex;
          await handleDayEnd(room, executed);
          return;
        }
        return;
      }

      // --- 聊天 ---
      if (msg.type === 'chat_send') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_chat_send' })); return; }
        if (room.status !== 'playing') { ws.send(JSON.stringify({ type: 'error', message: 'chat_not_allowed' })); return; }
        const text = String(msg.text ?? '').trim();
        if (!text) { ws.send(JSON.stringify({ type: 'error', message: 'chat_empty' })); return; }
        if (text.length > 500) { ws.send(JSON.stringify({ type: 'error', message: 'chat_too_long' })); return; }

        if (msg.scope === 'dm') {
          const toSeat = msg.toSeat;
          if (!Number.isInteger(toSeat)) { ws.send(JSON.stringify({ type: 'error', message: 'chat_dm_missing_toSeat' })); return; }
          if (toSeat === seatIndex) { ws.send(JSON.stringify({ type: 'error', message: 'chat_dm_to_self' })); return; }
          if (!game.players[toSeat as number]) { ws.send(JSON.stringify({ type: 'error', message: 'chat_dm_invalid_toSeat' })); return; }
          const entry = pushChatLog(game, {
            at: Date.now(), scope: 'dm', phase: game.phase,
            dayNumber: game.dayNumber, fromSeat: seatIndex, toSeat: toSeat as number, text,
          });
          broadcastChat(roomId, entry);
          return;
        }
        if (msg.scope === 'god') {
          const entry = pushChatLog(game, {
            at: Date.now(), scope: 'god', phase: game.phase,
            dayNumber: game.dayNumber, fromSeat: seatIndex, text,
          });
          broadcastChat(roomId, entry);

          const replyText = makeGodReply(game, seatIndex, text);
          const reply = pushChatLog(game, {
            at: Date.now(), scope: 'god', phase: game.phase,
            dayNumber: game.dayNumber, fromSeat: seatIndex, text: replyText,
          });
          broadcastChat(roomId, reply);
          return;
        }
        if (msg.scope === 'public') {
          const entry = pushChatLog(game, {
            at: Date.now(), scope: 'public', phase: game.phase,
            dayNumber: game.dayNumber, fromSeat: seatIndex, text,
          });
          pushPublic(game, `公开发言：${seatLabel(game, seatIndex)}：${text}`);
          broadcastChat(roomId, entry);
          broadcast(roomId, { type: 'room', room: getRoomView(room) });
          return;
        }
        ws.send(JSON.stringify({ type: 'error', message: 'chat_unknown_scope' }));
        return;
      }

      // --- 夜晚确认 ---
      if (msg.type === 'night_confirm') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_night_confirm' })); return; }
        if (room.status !== 'playing' || (game.phase !== 'night' && game.phase !== 'first_night')) {
          ws.send(JSON.stringify({ type: 'error', message: 'night_confirm_not_in_night' })); return;
        }
        if (!game.awaitingNightConfirm) {
          ws.send(JSON.stringify({ type: 'error', message: 'night_confirm_not_waiting' })); return;
        }
        game.nightConfirmations.add(seatIndex);
        broadcastNightConfirmStatus(room);

        if (game.nightConfirmations.size >= game.players.length) {
          const { key, title } = nightReplayTitle(game);
          pushReplay(game, key, title, '全员确认夜晚结束，天亮。');
          pushPublic(game, '全员确认夜晚结束，天亮。');
          gotoDay(game);

          if (checkWin(game)) {
            const win = checkWin(game);
            if (win) { emitGameOver(room, win); return; }
          }

          broadcast(roomId, { type: 'room', room: getRoomView(room) });
          broadcast(roomId, { type: 'phase', phase: game.phase, dayNumber: game.dayNumber });
        }
        return;
      }

      // --- 夜晚行动 ---
      if (msg.type === 'night_action') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_night_action' })); return; }
        const targets = msg.targets ?? [];
        if (!game.pendingNightAction || game.pendingNightAction.actorSeatIndex !== seatIndex) {
          ws.send(JSON.stringify({ type: 'error', message: 'night_action_not_pending' }));
          return;
        }
        await processNightAction(room, seatIndex, targets);
        sendNightPromptToPending(room);
        broadcastAfterNight(room, game.phase);
        broadcastNightConfirmStatus(room);
        return;
      }

      // --- 白天技能 ---
      if (msg.type === 'day_action') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_day_action' })); return; }
        if (room.status !== 'playing' || game.phase !== 'day') {
          ws.send(JSON.stringify({ type: 'error', message: 'day_action_not_allowed' })); return;
        }
        const actor = game.players[seatIndex];
        if (!actor?.isAlive) { ws.send(JSON.stringify({ type: 'error', message: 'day_action_actor_not_alive' })); return; }

        if (msg.actionId === 'slayer_shot') {
          const targetSeat = msg.targetSeat;
          if (!Number.isInteger(targetSeat)) {
            ws.send(JSON.stringify({ type: 'error', message: 'day_action_invalid_target' })); return;
          }
          const target = game.players[targetSeat as number];
          if (!target?.isAlive) {
            ws.send(JSON.stringify({ type: 'error', message: 'day_action_target_not_alive' })); return;
          }
          const used = game.usedDayActionsBySeat.get(seatIndex) ?? new Set();
          if (used.has('slayer_shot')) {
            ws.send(JSON.stringify({ type: 'error', message: 'day_action_limit_reached:slayer_shot' })); return;
          }

          const { key, title } = dayReplayTitle(game);
          pushReplay(game, key, title,
            `[白天技能] ${seatLabel(game, seatIndex)} 宣称是「杀手」并向 ${seatLabel(game, targetSeat as number)} 开枪。`);
          pushPublic(game,
            `${seatLabel(game, seatIndex)} 宣称是「杀手」并向 ${seatLabel(game, targetSeat as number)} 开枪。`);
          used.add('slayer_shot');
          game.usedDayActionsBySeat.set(seatIndex, used);

          const result = executeSlayerShot(game, seatIndex, targetSeat as number);
          if (result.killedDemon) {
            pushReplay(game, key, title, `枪击命中：${seatLabel(game, targetSeat as number)}（恶魔）死亡。`);
            pushPublic(game, `枪击命中：${seatLabel(game, targetSeat as number)} 死亡。`);
            const win = checkWin(game);
            if (win) {
              room.status = 'ended';
              game.phase = 'waiting';
              emitGameOver(room, win);
              return;
            }
          } else {
            pushReplay(game, key, title, '枪击结果：无事发生。');
            pushPublic(game, '枪击结果：无事发生。');
          }
          broadcast(roomId, { type: 'room', room: getRoomView(room) });
          return;
        }
        ws.send(JSON.stringify({ type: 'error', message: 'day_action_unknown' }));
        return;
      }

      // --- AI 玩家开关 ---
      if (msg.type === 'toggle_ai_player') {
        if (isAdmin) { ws.send(JSON.stringify({ type: 'error', message: 'admin_cannot_toggle_ai_player' })); return; }
        if (room.status !== 'playing') {
          ws.send(JSON.stringify({ type: 'error', message: 'toggle_ai_player_not_allowed' })); return;
        }
        room.aiPlayerEnabledBySeat.set(seatIndex, !!msg.enabled);
        const tip = msg.enabled
          ? `AI 托管已开启：${seatLabel(game, seatIndex)}。`
          : `AI 托管已关闭：${seatLabel(game, seatIndex)}。`;
        pushPublic(game, tip);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }

      // --- AI 说书人开关 ---
      if (msg.type === 'toggle_ai_storyteller') {
        if (!isHost) { ws.send(JSON.stringify({ type: 'error', message: 'host_only:toggle_ai_storyteller' })); return; }
        room.aiStorytellerEnabled = !!msg.enabled;
        const tip = room.aiStorytellerEnabled
          ? 'AI 说书人已接管流程。'
          : 'AI 说书人已关闭，切回人工控制。';
        pushPublic(game, tip);
        broadcast(roomId, { type: 'room', room: getRoomView(room) });
        return;
      }

      // --- Ping ---
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: (e as Error).message }));
    }
  });

  ws.on('close', () => {
    const room = getRoom(roomId ?? '');
    if (room && !ws.isAdmin) unbindConnection(room, connectionId);
  });
});

// ============================================================
// 定时循环：AI 托管白天行动 + 夜晚行动继续
// ============================================================

// 防止同一座位重复进入异步处理（LLM 调用可能超过定时器间隔）
const pendingAiActions = new Map<string, Set<number>>();

setInterval(async () => {
  for (const [rid, room] of rooms.entries()) {
    if (room.status !== 'playing') continue;
    const game = room.game;

    // --- AI 说书人：夜晚自动推进 ---
    if (room.aiStorytellerEnabled) {
      if ((game.phase === 'night' || game.phase === 'first_night') && !game.pendingNightAction) {
        await runNightLoop(room);
        sendNightPromptToPending(room);
        broadcastAfterNight(room, game.phase);
        broadcastNightConfirmStatus(room);
      }
    }

    // --- AI 玩家托管 ---
    for (const p of game.players) {
      const seatIndex = p.seatIndex;
      if (!(room.aiPlayerEnabledBySeat.get(seatIndex) ?? false)) continue;

      // 防重入：同一座位正在处理中则跳过
      const pendingSet = pendingAiActions.get(rid) ?? new Set<number>();
      if (pendingSet.has(seatIndex)) continue;

      // 夜晚确认：AI 自动确认
      if (game.awaitingNightConfirm && (game.phase === 'night' || game.phase === 'first_night')) {
        if (!game.nightConfirmations.has(seatIndex)) {
          game.nightConfirmations.add(seatIndex);
          broadcastNightConfirmStatus(room);
          if (game.nightConfirmations.size >= game.players.length) {
            const { key, title } = nightReplayTitle(game);
            pushReplay(game, key, title, '全员确认夜晚结束，天亮。');
            pushPublic(game, '全员确认夜晚结束，天亮。');
            gotoDay(game);
            if (checkWin(game)) { const w = checkWin(game); if (w) emitGameOver(room, w); continue; }
            broadcast(rid, { type: 'room', room: getRoomView(room) });
            broadcast(rid, { type: 'phase', phase: game.phase, dayNumber: game.dayNumber });
          }
        }
        continue;
      }

      // 夜晚行动：AI 自动选择目标
      if (game.pendingNightAction && game.pendingNightAction.actorSeatIndex === seatIndex) {
        pendingSet.add(seatIndex);
        pendingAiActions.set(rid, pendingSet);
        try {
          await handleAiNightAction(room, seatIndex);
        } catch (e) {
          console.error(`[AI] night action error seat ${seatIndex}:`, (e as Error).message);
        } finally {
          pendingAiActions.get(rid)?.delete(seatIndex);
        }
        sendNightPromptToPending(room);
        broadcastAfterNight(room, game.phase);
        broadcastNightConfirmStatus(room);
        continue;
      }

      // 白天 AI 决策
      if (game.phase === 'day') {
        pendingSet.add(seatIndex);
        pendingAiActions.set(rid, pendingSet);
        try {
          await handleAiDayAction(room, rid, seatIndex);
        } catch (e) {
          console.error(`[AI] day action error seat ${seatIndex}:`, (e as Error).message);
        } finally {
          pendingAiActions.get(rid)?.delete(seatIndex);
        }
      }
    }

    // --- 白天阶段推进 ---
    if (game.phase === 'day') {
      if (game.currentNomination) {
        // 有活跃提名：检查是否所有人都投了票
        const eligible = game.players.filter(p => p.isAlive || p.hasGhostVote).map(p => p.seatIndex);
        if (eligible.every(s => game.votes.has(s))) {
          const { passed, votesFor, votes } = tallyVotes(game);
          broadcast(rid, { type: 'vote_result', passed, votesFor, votes });
          broadcast(rid, { type: 'room', room: getRoomView(room) });
          const result = tryEndDay(game);
          if (result === 'ended' || result === 'goto_night') {
            await handleDayEnd(room, game.lastExecutedSeatIndex);
          }
        }
      } else if (game.daySubPhase === 'discussion') {
        // 讨论阶段：所有存活玩家发言后进入提名阶段
        const speechKey = `ai_spoke_day_${game.dayNumber}`;
        const spokeSet = (game.storytellerDecisions.get(speechKey) ?? new Set<number>()) as Set<number>;
        const allAliveSpoke = game.players.filter(p => p.isAlive).every(p => spokeSet.has(p.seatIndex));
        if (allAliveSpoke && game.players.filter(p => p.isAlive).length > 0) {
          game.daySubPhase = 'nomination';
          game.dayFlowStage = 'nomination_vote';
          pushPublic(game, '进入白天阶段：提名与投票。');
          broadcast(rid, { type: 'room', room: getRoomView(room) });
        }
      } else if (game.daySubPhase === 'nomination') {
        // 提名阶段：所有存活玩家已提名/跳过 → 结束白天
        const alive = game.players.filter(p => p.isAlive);
        const allDecided = alive.every(p =>
          game.nominationsToday.has(p.seatIndex) || game.skippedNominationsToday.has(p.seatIndex));
        if (allDecided) {
          const result = tryEndDay(game);
          if (result === 'ended' || result === 'goto_night') {
            await handleDayEnd(room, game.lastExecutedSeatIndex);
          }
        }
      }
    }
  }
}, 2000);

// ============================================================
// AI 白天行动处理
// ============================================================

async function handleAiDayAction(room: Room, rid: string, seatIndex: number): Promise<void> {
  const game = room.game;
  const p = game.players[seatIndex];
  if (!p) return;
  const isAlive = p.isAlive;

  // 公开发言 + 提名（仅存活玩家）
  if (isAlive) {
  // 公开发言（讨论阶段每人每天发言一次）
  const speechKey = `ai_spoke_day_${game.dayNumber}`;
  const spokeSet = (game.storytellerDecisions.get(speechKey) ?? new Set<number>()) as Set<number>;

  if (!spokeSet.has(seatIndex)) {
    spokeSet.add(seatIndex);
    game.storytellerDecisions.set(speechKey, spokeSet);

    try {
      const wv = buildWorldView(game, seatIndex);
      const shownId = getShownCharacterId(p);
      const char = shownId ? game.script.characters.find(c => c.id === shownId) : undefined;
      const alignment = char?.alignment ?? 'good';

      const yourRole: YourRoleInfo = {
        characterId: shownId ?? 'unknown',
        characterName: char?.name ?? 'unknown',
        characterNameZh: char?.nameZh ?? '未知',
        ability: char?.ability ?? '',
        abilityZh: char?.abilityZh ?? '',
        alignment,
        type: char?.type ?? 'townsfolk',
        infoSource: char?.infoSource ?? 'none',
      };

      const { getOrCreatePlayerAgent } = await import('./agents/player/playerAgent.js');
      const playerKey = `${room.id}_${seatIndex}`;
      const agent = getOrCreatePlayerAgent(
        playerKey, seatIndex, yourRole, alignment,
        room.aiPlayerBehaviorStyleBySeat.get(seatIndex),
      );
      agent.perceive(wv);
      const plan = await agent.decideDayPlan(wv);
      logAiDecision(game, seatIndex, 'speech', { decision: plan.decision, publicSpeech: plan.publicSpeech?.slice(0, 100) }, plan.reasoning);

      if (plan.publicSpeech && plan.publicSpeech.trim()) {
        const text = plan.publicSpeech.trim().slice(0, 500);
        const entry = pushChatLog(game, {
          at: Date.now(), scope: 'public', phase: game.phase,
          dayNumber: game.dayNumber, fromSeat: seatIndex, text,
        });
        pushPublic(game, `公开发言：${seatLabel(game, seatIndex)}：${text}`);
        broadcastChat(rid, entry);
      }

      if (plan.dmTarget != null && plan.dmText && plan.dmText.trim()) {
        const text = plan.dmText.trim().slice(0, 500);
        const entry = pushChatLog(game, {
          at: Date.now(), scope: 'dm', phase: game.phase,
          dayNumber: game.dayNumber, fromSeat: seatIndex, toSeat: plan.dmTarget, text,
        });
        broadcastChat(rid, entry);
      }

      broadcast(rid, { type: 'room', room: getRoomView(room) });
    } catch (e) {
      console.error(`[AI] decideDayPlan error seat ${seatIndex}:`, (e as Error).message);
    }
  }

  // 提名阶段：每个存活玩家必须提名或跳过
  if (game.daySubPhase === 'nomination' && game.currentNomination === null) {
    const decided = game.nominationsToday.has(seatIndex) || game.skippedNominationsToday.has(seatIndex);
    if (!decided) {
      try {
        const wv = buildWorldView(game, seatIndex);
        const shownId = getShownCharacterId(p);
        const char = shownId ? game.script.characters.find(c => c.id === shownId) : undefined;
        const alignment = char?.alignment ?? 'good';
        const yourRole: YourRoleInfo = {
          characterId: shownId ?? 'unknown',
          characterName: char?.name ?? 'unknown',
          characterNameZh: char?.nameZh ?? '未知',
          ability: char?.ability ?? '',
          abilityZh: char?.abilityZh ?? '',
          alignment,
          type: char?.type ?? 'townsfolk',
          infoSource: char?.infoSource ?? 'none',
        };

        const { getOrCreatePlayerAgent } = await import('./agents/player/playerAgent.js');
        const playerKey = `${room.id}_${seatIndex}`;
        const agent = getOrCreatePlayerAgent(
          playerKey, seatIndex, yourRole, alignment,
          room.aiPlayerBehaviorStyleBySeat.get(seatIndex),
        );
        agent.perceive(wv);
        const nomDecision = await agent.decideNomination(wv);
        logAiDecision(game, seatIndex, 'nominate', { shouldSkip: nomDecision.shouldSkip, nominatedSeat: nomDecision.nominatedSeat }, nomDecision.reasoning);

        if (!nomDecision.shouldSkip && nomDecision.nominatedSeat != null) {
          const ok = nominate(game, seatIndex, nomDecision.nominatedSeat);
          if (ok) {
            const { key, title } = dayReplayTitle(game);
            pushReplay(game, key, title,
              `${seatLabel(game, seatIndex)}（AI）提名 ${seatLabel(game, nomDecision.nominatedSeat)}。`);
            pushPublic(game,
              `${seatLabel(game, seatIndex)} 提名 ${seatLabel(game, nomDecision.nominatedSeat)}。`);
            broadcast(rid, { type: 'room', room: getRoomView(room) });
          } else {
            const ok2 = skipNomination(game, seatIndex);
            if (ok2) {
              pushPublic(game, `${seatLabel(game, seatIndex)} 的提名被拒（目标已提名），自动跳过。`);
              broadcast(rid, { type: 'room', room: getRoomView(room) });
            }
          }
        } else {
          const ok = skipNomination(game, seatIndex);
          if (ok) {
            const { key, title } = dayReplayTitle(game);
            pushReplay(game, key, title,
              `${seatLabel(game, seatIndex)}（AI）选择本轮不提名。`);
            pushPublic(game, `${seatLabel(game, seatIndex)} 选择本轮不提名。`);
            broadcast(rid, { type: 'room', room: getRoomView(room) });
          }
        }
      } catch (e) {
        console.error(`[AI] decideNomination error seat ${seatIndex}:`, (e as Error).message);
        // fallback: skip nomination
        const ok = skipNomination(game, seatIndex);
        if (ok) {
          pushPublic(game, `${seatLabel(game, seatIndex)} 选择本轮不提名。`);
          broadcast(rid, { type: 'room', room: getRoomView(room) });
        }
      }
    }
  }
  } // end if (isAlive)

  // 投票（存活玩家 + 幽灵票）
  if (game.currentNomination && !game.votes.has(seatIndex)) {
    const canVote = p.isAlive || p.hasGhostVote;
    if (canVote) {
      try {
        const wv = buildWorldView(game, seatIndex);
        const shownId = getShownCharacterId(p);
        const char = shownId ? game.script.characters.find(c => c.id === shownId) : undefined;
        const alignment = char?.alignment ?? 'good';
        const yourRole: YourRoleInfo = {
          characterId: shownId ?? 'unknown',
          characterName: char?.name ?? 'unknown',
          characterNameZh: char?.nameZh ?? '未知',
          ability: char?.ability ?? '',
          abilityZh: char?.abilityZh ?? '',
          alignment,
          type: char?.type ?? 'townsfolk',
          infoSource: char?.infoSource ?? 'none',
        };

        const { getOrCreatePlayerAgent } = await import('./agents/player/playerAgent.js');
        const playerKey = `${room.id}_${seatIndex}`;
        const agent = getOrCreatePlayerAgent(
          playerKey, seatIndex, yourRole, alignment,
          room.aiPlayerBehaviorStyleBySeat.get(seatIndex),
        );
        agent.perceive(wv);
        const voteDecision = await agent.decideVote(wv, game.currentNomination);
        logAiDecision(game, seatIndex, 'vote', { inFavor: voteDecision.inFavor }, voteDecision.reasoning);
        vote(game, seatIndex, voteDecision.inFavor);
        broadcast(rid, { type: 'room', room: getRoomView(room) });
      } catch (e) {
        console.error(`[AI] decideVote error seat ${seatIndex}:`, (e as Error).message);
        vote(game, seatIndex, Math.random() < 0.5);
      }
    }
  }

}

// ============================================================
// 启动
// ============================================================

server.listen(HTTP_PORT, () => {
  console.log(`[BOTC] Server on http://localhost:${HTTP_PORT}`);
  console.log(`[BOTC] LLM: ${getLlmConfig().enabled ? 'enabled' : 'disabled'}, model: ${getLlmConfig().model}`);
  console.log(`[BOTC] AI Storyteller: ${AI_STORYTELLER_ENABLED ? 'enabled' : 'disabled'}`);
  console.log(`[BOTC] AI Players: ${AI_PLAYER_ENABLED ? 'enabled' : 'disabled'}`);
});
