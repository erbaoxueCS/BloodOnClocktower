// [NEW] AI 玩家记忆管理系统
// 负责短期记忆、长期记忆、怀疑度追踪和心路历程持久化
import type { AiPlayerMemory, AiThoughtEntry, Room } from '../game/types.js';

/**
 * 创建空的 AI 玩家记忆
 */
export function createAiMemory(): AiPlayerMemory {
  return {
    shortTerm: [],
    longTerm: [],
    suspicion: new Map<number, number>(),
    allyTrust: new Map<number, number>(),
  };
}

/**
 * 添加短期记忆条目
 */
export function addShortTermMemory(
  memory: AiPlayerMemory,
  day: number,
  phase: string,
  event: string,
  source: AiPlayerMemory['shortTerm'][0]['source'],
  maxEntries = 50
): void {
  memory.shortTerm.push({
    day,
    phase,
    event,
    source,
    at: Date.now(),
  });

  // 保持短期记忆在合理范围内
  if (memory.shortTerm.length > maxEntries) {
    memory.shortTerm = memory.shortTerm.slice(-maxEntries);
  }
}

/**
 * 生成当日长期记忆总结
 */
export function summarizeDay(
  memory: AiPlayerMemory,
  day: number,
  summary: string
): void {
  memory.longTerm.push({ day, summary });
  // 清理当天的短期记忆（保留最近的）
  memory.shortTerm = memory.shortTerm.filter(m => m.day !== day || m.source === 'death');
}

/**
 * 更新对某座位的怀疑度
 * @param delta 变化量 (-0.3 ~ +0.3)
 */
export function updateSuspicion(
  memory: AiPlayerMemory,
  targetSeat: number,
  delta: number
): void {
  const current = memory.suspicion.get(targetSeat) ?? 0.3; // 初始中立
  const newValue = Math.max(0, Math.min(1, current + delta));
  memory.suspicion.set(targetSeat, newValue);
}

/**
 * 批量更新怀疑度（根据夜间信息或投票结果）
 */
export function updateSuspicionBatch(
  memory: AiPlayerMemory,
  updates: Map<number, number>
): void {
  for (const [seat, delta] of updates) {
    updateSuspicion(memory, seat, delta);
  }
}

/**
 * 更新对某座位的信任度（善良阵营内部）
 */
export function updateAllyTrust(
  memory: AiPlayerMemory,
  targetSeat: number,
  delta: number
): void {
  const current = memory.allyTrust.get(targetSeat) ?? 0.5;
  const newValue = Math.max(0, Math.min(1, current + delta));
  memory.allyTrust.set(targetSeat, newValue);
}

/**
 * 获取怀疑度排序（从高到低）
 */
export function getSuspicionRanking(memory: AiPlayerMemory): Array<{ seat: number; suspicion: number }> {
  return Array.from(memory.suspicion.entries())
    .map(([seat, suspicion]) => ({ seat, suspicion }))
    .sort((a, b) => b.suspicion - a.suspicion);
}

/**
 * 获取最怀疑的 N 个座位
 */
export function getMostSuspicious(memory: AiPlayerMemory, count = 2): number[] {
  return getSuspicionRanking(memory).slice(0, count).map(s => s.seat);
}

/**
 * 记录 AI 心路历程到房间日志
 */
export function recordAiThought(
  room: Room,
  seatIndex: number,
  characterId: string,
  trigger: string,
  context: AiThoughtEntry['context'],
  reasoning: string,
  decision: string,
  emotion?: string
): void {
  const entry: AiThoughtEntry = {
    roomId: room.id,
    dayNumber: room.dayNumber,
    phase: room.phase === 'first_night' ? 'first_night' : room.phase,
    seatIndex,
    characterId,
    trigger,
    context,
    reasoning,
    decision,
    emotion,
    timestamp: Date.now(),
  };

  room.aiThoughtLog.push(entry);

  // 限制日志大小，保留最近 500 条
  if (room.aiThoughtLog.length > 500) {
    room.aiThoughtLog = room.aiThoughtLog.slice(-500);
  }
}

/**
 * 获取某座位的心路历程
 */
export function getThoughtsBySeat(room: Room, seatIndex: number): AiThoughtEntry[] {
  return room.aiThoughtLog.filter(t => t.seatIndex === seatIndex);
}

/**
 * 获取某天的所有心路历程
 */
export function getThoughtsByDay(room: Room, dayNumber: number): AiThoughtEntry[] {
  return room.aiThoughtLog.filter(t => t.dayNumber === dayNumber);
}

/**
 * 导出心路历程为 JSON 字符串（用于持久化）
 */
export function exportThoughtLog(room: Room): string {
  return JSON.stringify(room.aiThoughtLog, null, 2);
}
