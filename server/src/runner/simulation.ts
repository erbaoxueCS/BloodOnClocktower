// [NEW] Headless 纯 AI 自对局引擎
// 支持无人值守自动开房、AI 对局、多局运行、漏洞挖掘
import type { Room, PlayerSeat, AiThoughtEntry } from '../game/types.js';
import { createRoom, rooms } from '../game/roomManager.js';
import { startGame, nominate, skipNomination, vote, tallyVotes, execute, maybeFinishDay, submitNightAction, advanceNight, getCurrentNightStep, findAliveSeatByCharacter, checkWin, finishNightAndGotoDay } from '../game/gameEngine.js';
import { buildYourRolePayload } from '../game/yourRole.js';
import { getStorytellerDecision } from '../ai/storyteller.js';
import { pushReplay, buildReplayBundle, seatLabel, pushPublic } from '../game/replay.js';
import { troubleBrewing } from '../script/troubleBrewing.js';
import { HeadlessAiPlayer } from './aiPlayerWrapper.js';
import { generateReport, SimulationReport } from './report.js';
import { resetProgress, updateSimulationPhase, completeProgress } from './simulationProgress.js';
import { resetSimulationProgress, setSimulationProgress, updateAiPlayerStatus, completeSimulation } from './simulationProgress.js';

export interface SimulationConfig {
  playerCount: number;       // 玩家数量
  aiPlayerCount: number;     // AI 玩家数量（包含说书人控制的座位）
  maxDays: number;           // 最大天数（超时则强制结束）
  iterations: number;        // 运行局数
  delayMs?: number;          // 每步延迟（毫秒）
}

export interface SimulationResult {
  gameIndex: number;
  winner: 'good' | 'evil' | 'timeout';
  dayCount: number;
  playerCount: number;
  thoughts: AiThoughtEntry[];
  replayLog: Array<{ seq: number; groupTitle: string; line: string }>;
  anomalies: string[];       // 检测到的异常/漏洞
}

/**
 * 运行纯 AI 自对局模拟
 */
export async function runSimulation(config: SimulationConfig): Promise<SimulationResult[]> {
  const results: SimulationResult[] = [];

  // [NEW] 初始化进度
  resetSimulationProgress(config.iterations);

  for (let i = 0; i < config.iterations; i++) {
    console.log(`\n========== 开始第 ${i + 1}/${config.iterations} 局 ==========`);
    setSimulationProgress({ currentGame: i + 1 });

    try {
      const result = await runSingleGame(config, i + 1);
      results.push(result);

      console.log(`第 ${i + 1} 局结束：${result.winner} 获胜，共 ${result.dayCount} 天`);
      if (result.anomalies.length > 0) {
        console.log(`⚠️ 检测到 ${result.anomalies.length} 个异常：`);
        result.anomalies.forEach(a => console.log(`  - ${a}`));
      }
    } catch (e) {
      console.error(`第 ${i + 1} 局出错：`, (e as Error).message);
      results.push({
        gameIndex: i + 1,
        winner: 'timeout',
        dayCount: 0,
        playerCount: config.playerCount,
        thoughts: [],
        replayLog: [],
        anomalies: [`游戏出错：${(e as Error).message}`],
      });
    }
  }

  // [NEW] 完成
  completeSimulation();
  return results;
}

/**
 * 运行单局游戏（无头模式）
 */
async function runSingleGame(config: SimulationConfig, gameIndex: number): Promise<SimulationResult> {
  // 1. 创建房间
  const room = createRoom('trouble_brewing');
  const roomId = room.id;
  rooms.set(roomId, room);

  console.log(`房间创建：${roomId}，${config.playerCount} 人`);

  // 2. 添加 AI 玩家
  const aiPlayerNames = Array.from({ length: config.playerCount }, (_, i) => `AI-${i + 1}`);
  for (let i = 0; i < config.playerCount; i++) {
    room.players.push({
      id: `ai-player-${i}`,
      seatIndex: i,
      nickname: aiPlayerNames[i],
      isReady: true,
      isAlive: true,
      hasDeadVote: true,
      characterId: undefined,
      drunkPretendCharacterId: null,
      usedDayActions: [],
    });

    // 启用 AI 托管
    room.aiPlayerEnabledBySeat.set(i, true);
    room.aiPlayerTemperatureBySeat.set(i, 0.6 + Math.random() * 0.3); // 0.6~0.9

    // [NEW] 初始化进度状态
    updateAiPlayerStatus(i, 'idle', '等待游戏开始');
  }

  // 3. 开始游戏
  const startOk = startGame(room);
  if (!startOk) {
    throw new Error('游戏无法开始');
  }

  console.log('游戏开始，进入首夜...');
  setSimulationProgress({ currentDay: 1, currentPhase: 'first_night' });

  // 4. 运行夜晚循环（无头模式）
  const aiPlayer = new HeadlessAiPlayer({
    maxParallelism: 2,    // 最多 2 个并发，避免 429 限流
    timeoutMs: 60000,     // 60 秒超时
  });
  let dayCount = 0;
  const anomalies: string[] = [];

  while (room.status === 'playing' && dayCount < config.maxDays) {
    // 处理夜晚
    setSimulationProgress({ currentPhase: 'night', currentStep: '夜晚阶段' });
    await runNightPhase(room, aiPlayer, anomalies);

    if (room.status !== 'playing') break;

    // 进入白天
    finishNightAndGotoDay(room);
    dayCount = room.dayNumber;
    console.log(`第 ${dayCount} 天开始`);
    setSimulationProgress({ currentDay: dayCount, currentPhase: 'day', currentStep: '白天阶段' });

    // 白天 AI 自动操作
    await runDayPhase(room, aiPlayer, anomalies);

    // 检查胜负
    const winner = checkWin(room);
    if (winner) {
      room.status = 'ended';
      pushReplay(room, 'result', '游戏结束', `${winner === 'good' ? '善良阵营' : '邪恶阵营'} 获胜。`);

      // 生成每日总结
      await aiPlayer.generateDaySummary(room);

      return {
        gameIndex,
        winner,
        dayCount,
        playerCount: config.playerCount,
        thoughts: room.aiThoughtLog,
        replayLog: room.replayLog.map(e => ({ seq: e.seq, groupTitle: e.groupTitle, line: e.line })),
        anomalies,
      };
    }
  }

  // 超时或异常结束
  const winner = room.status === 'ended' ? 'timeout' : (checkWin(room) ?? 'timeout');
  room.status = 'ended';

  return {
    gameIndex,
    winner,
    dayCount,
    playerCount: config.playerCount,
    thoughts: room.aiThoughtLog,
    replayLog: room.replayLog.map(e => ({ seq: e.seq, groupTitle: e.groupTitle, line: e.line })),
    anomalies: [...anomalies, dayCount >= config.maxDays ? `超过最大天数 ${config.maxDays}` : ''],
  };
}

/**
 * 运行夜晚阶段（无头模式）
 */
async function runNightPhase(room: Room, aiPlayer: HeadlessAiPlayer, anomalies: string[]): Promise<void> {
  const aiEnabledSeats = Array.from(room.aiPlayerEnabledBySeat.entries())
    .filter(([_, enabled]) => enabled)
    .map(([seat]) => seat);

  while ((room.phase === 'first_night' || room.phase === 'night') && room.status === 'playing') {
    const stepId = getCurrentNightStep(room);
    if (!stepId) break;

    console.log(`  [夜晚] 步骤：${stepId}`);

    // 信息型角色（直接处理）
    if (['demon_info', 'minion_info', 'chef', 'empath', 'undertaker'].includes(stepId)) {
      advanceNight(room);
      continue;
    }

    // [FIX] 守鸦人：需要手动推进索引，因为 advanceNight 遇到 ravenkeeper 返回 false（requiresStorytellerChoice）
    if (stepId === 'ravenkeeper') {
      room.nightStepIndex++;
      advanceNight(room);
      continue;
    }

    // 说书人裁量型
    if (['washerwoman', 'librarian', 'investigator'].includes(stepId)) {
      const seat = findAliveSeatByCharacter(room, stepId);
      const stepNameZh = room.script.characters.find(c => c.id === stepId)?.nameZh ?? stepId;

      if (seat != null) {
        const raw = await getStorytellerDecision(room, stepId, stepNameZh, room.aiStorytellerEnabled);
        // 存储决策
        room.storytellerDecisions.set(stepId, raw);
      }

      // [FIX] 手动推进索引，因为 advanceNight 遇到 requiresStorytellerChoice 会直接返回而不增加索引
      room.nightStepIndex++;
      advanceNight(room);
      continue;
    }

    // 操作型角色 - 交给 AI 玩家
    if (room.pendingNightAction && room.pendingNightAction.actorSeatIndex != null) {
      const actorSeat = room.pendingNightAction.actorSeatIndex;

      // AI 自动行动
      if (aiEnabledSeats.includes(actorSeat)) {
        const actions = await aiPlayer.processAllSeats(room, [actorSeat]);
        const action = actions.get(actorSeat);

        if (action && action.type === 'night_action' && action.targets.length > 0) {
          submitNightAction(room, actorSeat, action.targets);
          console.log(`    AI #${actorSeat + 1} 行动：${action.type} -> ${action.targets.map(t => `#${t + 1}`).join(', ')}`);
        } else {
          // [FIX] AI 返回 noop 时跳过该夜晚步骤，避免卡住。
          // 必须手动推进索引，因为 advanceNight 遇到当前步骤有存活角色时会重新设置 pendingNightAction
          console.log(`    AI #${actorSeat + 1} 夜晚无动作，跳过步骤 ${room.pendingNightAction.stepId}`);
          room.pendingNightAction = null;
          room.nightStepIndex++;
          advanceNight(room);
        }
      } else {
        // 非 AI 玩家，使用默认行动（随机或跳过）
        advanceNight(room);
      }

      if (room.phase !== 'first_night' && room.phase !== 'night') break;
      continue;
    }

    advanceNight(room);
  }

  // 检查夜间死亡
  if (room.lastNightDeaths.length > 0) {
    const deadNames = room.lastNightDeaths.map(s => seatLabel(room, s)).join(', ');
    console.log(`  [夜晚结束] 死亡：${deadNames}`);

    // 检测异常：如果恶魔未中毒但没人死，可能是 bug
    const demonSeat = findAliveSeatByCharacter(room, 'imp');
    const isDemonPoisoned = room.poisonedSeatIndex === demonSeat;
    if (room.lastNightDeaths.length === 0 && !isDemonPoisoned && room.dayNumber > 0) {
      anomalies.push(`第 ${room.dayNumber} 夜：恶魔未中毒但无人死亡，可能为规则漏洞`);
    }
  }
}

/**
 * 运行白天阶段（无头模式）
 */
async function runDayPhase(room: Room, aiPlayer: HeadlessAiPlayer, anomalies: string[]): Promise<void> {
  const aiEnabledSeats = Array.from(room.aiPlayerEnabledBySeat.entries())
    .filter(([_, enabled]) => enabled)
    .map(([seat]) => seat);

  let maxIterations = 50; // 防止无限循环
  while (room.phase === 'day' && room.status === 'playing' && maxIterations-- > 0) {
    // 处理提名
    if (!room.currentNomination) {
      // 找到需要提名的存活 AI 玩家
      const aliveAiSeats = aiEnabledSeats.filter(s =>
        room.players[s]?.isAlive &&
        !room.nominationsToday.has(s) &&
        !room.skippedNominationsToday.has(s)
      );

      if (aliveAiSeats.length > 0) {
        const seat = aliveAiSeats[0];
        const actions = await aiPlayer.processAllSeats(room, [seat]);
        const action = actions.get(seat);

        if (action) {
          if (action.type === 'nominate' && action.nominatedSeat !== seat) {
            const ok = nominate(room, seat, action.nominatedSeat);
            if (ok) {
              console.log(`  [白天] AI #${seat + 1} 提名 #${action.nominatedSeat + 1}`);
              pushPublic(room, `#${seat + 1} 提名 #${action.nominatedSeat + 1}`);
            }
          } else if (action.type === 'skip_nomination') {
            skipNomination(room, seat);
            console.log(`  [白天] AI #${seat + 1} 跳过提名`);
          } else {
            // [FIX] AI 返回 noop 或其他非提名动作时，自动视为跳过提名，避免死循环
            skipNomination(room, seat);
            console.log(`  [白天] AI #${seat + 1} 无提名动作，自动跳过`);
          }
        } else {
          // [FIX] AI 没返回任何动作，自动跳过
          skipNomination(room, seat);
          console.log(`  [白天] AI #${seat + 1} 无返回，自动跳过`);
        }
      } else {
        // 所有玩家都已提名或跳过，结束白天
        const fin = maybeFinishDay(room);
        if (fin.ended) {
          if (fin.executedSeatIndex != null) {
            execute(room);
            console.log(`  [处决] #${fin.executedSeatIndex + 1} 被处决`);
            pushPublic(room, `#${fin.executedSeatIndex + 1} 被处决`);
          }
          break;
        }
      }
    } else {
      // 处理投票
      const eligibleVoters = room.players.filter(p => p.isAlive || p.hasDeadVote).map(p => p.seatIndex);
      const allVoted = eligibleVoters.every(s => room.votes.has(s));

      if (allVoted) {
        const { passed, votesFor, votes: vv } = tallyVotes(room);
        console.log(`  [投票结束] ${passed ? '通过' : '未通过'}（赞成 ${votesFor} 票）`);

        // 检测异常：如果投票结果不符合预期
        const aliveCount = room.players.filter(p => p.isAlive).length;
        const requiredVotes = Math.ceil(aliveCount / 2);
        if (passed && votesFor < requiredVotes) {
          anomalies.push(`投票异常：赞成票 ${votesFor} < 所需 ${requiredVotes}，但仍然通过`);
        }

        room.currentNomination = null;
        room.votes.clear();
      } else {
        // AI 自动投票
        const needVoteSeats = eligibleVoters.filter(s => !room.votes.has(s) && aiEnabledSeats.includes(s));
        if (needVoteSeats.length > 0) {
          const actions = await aiPlayer.processAllSeats(room, needVoteSeats);
          for (const seat of needVoteSeats) {
            const action = actions.get(seat);
            if (action && action.type === 'vote') {
              vote(room, seat, action.inFavor);
            } else {
              // [FIX] AI 返回 noop 或其他非投票动作时，默认投反对票
              vote(room, seat, false);
            }
          }
        } else {
          // 非 AI 玩家，默认反对
          for (const seat of eligibleVoters) {
            if (!room.votes.has(seat)) {
              vote(room, seat, false);
            }
          }
        }
      }
    }
  }
}
