// [MODIFIED] AI 玩家无头模式包装器 - 并行化版本
// 并行调用大模型获取策略，规则引擎加超时保护避免死锁
import type { Room } from '../game/types.js';
import { decideAiPlayerAction, getOrCreatePersona, getOrCreateMemory, AiPlayerAction, aiPlayerLlmAvailable } from '../ai/playerAgent.js';
import { addShortTermMemory, summarizeDay } from '../ai/aiMemory.js';
import { updateAiPlayerStatus, setAiPlayerRole } from './simulationProgress.js';

export interface HeadlessAiPlayerOptions {
  maxParallelism?: number;  // 最大并行数（默认 1，串行避免 429）
  timeoutMs?: number;       // 单个座位 LLM 调用超时（毫秒），默认 120000
}

/**
 * AI 玩家自动操作包装器 - 无头模式
 * 并行调用大模型，规则引擎加超时保护
 */
export class HeadlessAiPlayer {
  private options: Required<HeadlessAiPlayerOptions>;

  constructor(options: HeadlessAiPlayerOptions = {}) {
    this.options = {
      maxParallelism: options.maxParallelism ?? 2,  // 默认 2 并发
      timeoutMs: options.timeoutMs ?? 35000,        // 35 秒超时（仅算 LLM 请求时间）
    };
  }

  /**
   * 为所有启用 AI 的座位执行自动操作（限制并发 + 超时保护）
   * DashScope 有速率限制，不能同时太多请求
   */
  async processAllSeats(room: Room, enabledSeats: number[]): Promise<Map<number, AiPlayerAction>> {
    const results = new Map<number, AiPlayerAction>();
    const maxConcurrency = this.options.maxParallelism; // 由配置决定，默认 2

    // 分批并行处理，每批之间加间隔避免限流
    for (let i = 0; i < enabledSeats.length; i += maxConcurrency) {
      const batch = enabledSeats.slice(i, i + maxConcurrency);
      const promises = batch.map(async (seatIndex) => {
        const action = await this.processSeatWithTimeout(room, seatIndex);
        return { seatIndex, action };
      });

      const batchResults = await Promise.all(promises);
      for (const { seatIndex, action } of batchResults) {
        results.set(seatIndex, action);
      }

      // 每批之间间隔 1 秒，避免 429 限流
      if (i + maxConcurrency < enabledSeats.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return results;
  }

  /**
   * 带超时保护的单个座位处理
   * 注意：超时只计算实际 LLM 请求时间，不包括排队等待时间
   */
  private async processSeatWithTimeout(room: Room, seatIndex: number): Promise<AiPlayerAction> {
    try {
      // 使用 Promise.race 实现超时控制
      const action = await Promise.race([
        this.processSeat(room, seatIndex),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`LLM 调用超时 (${this.options.timeoutMs}ms)`));
          }, this.options.timeoutMs);
        }),
      ]);
      return action;
    } catch (e) {
      const errMsg = (e as Error).message;
      if (errMsg.includes('超时')) {
        console.warn(`  ⏱ AI #${seatIndex + 1} ${errMsg}，fallback 到随机策略`);
      } else {
        console.warn(`  ❌ AI #${seatIndex + 1} 处理异常: ${errMsg}，fallback 到随机策略`);
      }
      return this.fallbackAction(room, seatIndex);
    }
  }

  /**
   * 为单个座位执行自动操作（真正调用大模型）
   */
  private async processSeat(room: Room, seatIndex: number): Promise<AiPlayerAction> {
    const t0 = Date.now();
    console.log(`    [AI #${seatIndex + 1}] 开始处理...`);

    // [NEW] 更新进度：开始思考
    const player = room.players[seatIndex];
    const charName = room.script.characters.find(c => c.id === player?.characterId)?.nameZh ?? '未知';
    updateAiPlayerStatus(seatIndex, 'thinking', `正在思考 (${charName})`);
    setAiPlayerRole(seatIndex, charName);

    if (!aiPlayerLlmAvailable()) {
      updateAiPlayerStatus(seatIndex, 'done', 'LLM 不可用');
      return this.fallbackAction(room, seatIndex);
    }

    if (!player || !player.isAlive) {
      updateAiPlayerStatus(seatIndex, 'idle', '已死亡');
      return { type: 'noop' };
    }

    // 构建上下文（人类可读格式，不用 JSON.stringify 塞一堆）
    console.log(`    [AI #${seatIndex + 1}] 构建人设 (${Date.now() - t0}ms)`);
    const persona = getOrCreatePersona(room, seatIndex);
    const memory = getOrCreateMemory(room, seatIndex);

    // 提取该座位可见的聊天（人类可读）
    const visibleChats = room.chatLog
      .filter(c => {
        if (c.scope === 'public') return true;
        if (c.scope === 'god' && c.fromSeat === seatIndex) return true;
        if (c.scope === 'dm' && (c.fromSeat === seatIndex || c.toSeat === seatIndex)) return true;
        return false;
      })
      .map(c => {
        const from = c.fromSeat != null ? `#${c.fromSeat + 1}` : '说书人';
        const to = c.toSeat != null ? ` -> #${c.toSeat + 1}` : '';
        return `[${from}${to}] ${c.text}`;
      })
      .slice(-20); // 只保留最近 20 条

    // 构建记忆快照
    const suspicionEntries = Array.from(memory.suspicion.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([seat, score]) => `#${seat + 1}: ${(score * 100).toFixed(0)}%`)
      .join(', ');

    const recentEvents = memory.shortTerm
      .slice(-5)
      .map(e => `第${e.day}天 ${e.phase}: ${e.event}`)
      .join('\n');

    // 存活座位人类可读列表
    const aliveSeatsList = room.players
      .filter(p => p.isAlive)
      .map(p => {
        const charName = room.script.characters.find(c => c.id === p.characterId)?.nameZh ?? '未知';
        return `#${p.seatIndex + 1}（${charName}）`;
      });

    // 决策上下文（结构化，不用 JSON.stringify 塞原始对象）
    const ctx = {
      yourSeatIndex: seatIndex,
      yourCharacterId: player.characterId ?? 'unknown',
      visibleChats,
      suspicionRanking: suspicionEntries || '暂无怀疑',
      recentEvents: recentEvents || '无历史事件',
      isNightAction: room.pendingNightAction?.actorSeatIndex === seatIndex,
      nightActionStepId: room.pendingNightAction?.stepId,
      nightActionPick: room.pendingNightAction?.pick,
      aliveSeats: aliveSeatsList,
      currentNomination: room.currentNomination
        ? `#${room.currentNomination.nominator + 1} 提名了 #${room.currentNomination.nominated + 1}`
        : null,
    };

    // 调用大模型（不包兜底，由上层超时控制）
    console.log(`    [AI #${seatIndex + 1}] 调用 LLM (${Date.now() - t0}ms)`);
    const temperature = room.aiPlayerTemperatureBySeat.get(seatIndex) ?? 0.7;
    const action = await decideAiPlayerAction(room, seatIndex, ctx as any, temperature);
    console.log(`    [AI #${seatIndex + 1}] LLM 返回 (${Date.now() - t0}ms): ${action.type}`);

    // [NEW] 更新进度：决策完成
    updateAiPlayerStatus(seatIndex, 'done', action.type, Date.now() - t0);

    // 更新记忆
    if (action.type !== 'noop') {
      addShortTermMemory(memory, room.dayNumber, room.phase, `执行了 ${action.type}`, 'chat_public' as any);
    }

    return action;
  }

  /**
   * Fallback 策略（仅在超时或 LLM 不可用时使用）
   */
  private fallbackAction(room: Room, seatIndex: number): AiPlayerAction {
    const aliveSeats = room.players.filter(p => p.isAlive).map(p => p.seatIndex);
    const others = aliveSeats.filter(s => s !== seatIndex);

    if (room.currentNomination) {
      // 投票：随机投
      return { type: 'vote', inFavor: Math.random() > 0.5 };
    }
    if (room.pendingNightAction?.actorSeatIndex === seatIndex) {
      // 夜晚行动：随机选一个目标
      if (others.length > 0) {
        return { type: 'night_action', targets: [others[Math.floor(Math.random() * others.length)]] };
      }
      return { type: 'night_confirm' };
    }
    // 白天：随机提名或跳过
    if (others.length > 0 && Math.random() > 0.3) {
      return { type: 'nominate', nominatedSeat: others[Math.floor(Math.random() * others.length)] };
    }
    return { type: 'skip_nomination' };
  }

  /**
   * 每日结束后，生成当日总结
   */
  async generateDaySummary(room: Room): Promise<void> {
    if (!aiPlayerLlmAvailable()) return;

    for (const player of room.players) {
      if (!player.isAlive) continue;

      const memory = getOrCreateMemory(room, player.seatIndex);

      const events = memory.shortTerm.filter(m => m.day === room.dayNumber);
      if (events.length === 0) continue;

      const summary = `第 ${room.dayNumber} 天结束。我经历了 ${events.length} 个事件。`;
      summarizeDay(memory, room.dayNumber, summary);
    }
  }
}
