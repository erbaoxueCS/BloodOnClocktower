// [NEW] 对局分析报告生成器
// 基于多局 AI 自对局结果，生成结构化分析报告
import type { AiThoughtEntry } from '../game/types.js';
import type { SimulationResult } from './simulation.js';

export interface SimulationReport {
  totalGames: number;
  goodWins: number;
  evilWins: number;
  timeouts: number;
  avgDayCount: number;
  anomalies: string[];
  characterStats: Record<string, CharacterStat>;
  thoughtAnalysis: ThoughtAnalysis;
  recommendations: string[];
}

export interface CharacterStat {
  characterId: string;
  characterNameZh: string;
  playedCount: number;
  winCount: number;
  winRate: number;
  avgDeathDay: number | null; // null = 存活到结束
  deathReasons: Record<string, number>;
}

export interface ThoughtAnalysis {
  avgThinkingLength: number;       // 平均思考长度（字符数）
  commonEmotions: Record<string, number>;
  suspicionAccuracy: number;       // 怀疑准确率（如果可评估）
  commonStrategies: string[];
  inconsistencies: string[];       // AI 行为不一致的地方
}

/**
 * 生成模拟报告
 */
export function generateReport(results: SimulationResult[]): SimulationReport {
  const totalGames = results.length;
  const goodWins = results.filter(r => r.winner === 'good').length;
  const evilWins = results.filter(r => r.winner === 'evil').length;
  const timeouts = results.filter(r => r.winner === 'timeout').length;

  const totalDays = results.reduce((sum, r) => sum + r.dayCount, 0);
  const avgDayCount = totalGames > 0 ? Math.round(totalDays / totalGames * 10) / 10 : 0;

  // 收集所有异常
  const allAnomalies = [...new Set(results.flatMap(r => r.anomalies).filter(Boolean))];

  // 角色统计
  const characterStats = analyzeCharacterStats(results);

  // 思考分析
  const thoughtAnalysis = analyzeThoughts(results);

  // 生成建议
  const recommendations = generateRecommendations({
    goodWins,
    evilWins,
    timeouts,
    avgDayCount,
    anomalies: allAnomalies,
    characterStats,
    thoughtAnalysis,
  });

  return {
    totalGames,
    goodWins,
    evilWins,
    timeouts,
    avgDayCount,
    anomalies: allAnomalies,
    characterStats,
    thoughtAnalysis,
    recommendations,
  };
}

/**
 * 分析角色统计数据
 */
function analyzeCharacterStats(results: SimulationResult[]): Record<string, CharacterStat> {
  const stats: Record<string, CharacterStat> = {};

  for (const result of results) {
    // 从 replayLog 中提取角色信息
    for (const entry of result.replayLog) {
      // 解析角色分配记录
      const roleMatch = entry.line.match(/(#\d+)：(.+)/);
      if (roleMatch) {
        // 这里需要更复杂的解析逻辑
      }
    }

    // 从心路历程中提取角色信息
    for (const thought of result.thoughts) {
      const charId = thought.characterId;
      if (!stats[charId]) {
        // 需要从剧本中查找中文名，这里简化处理
        stats[charId] = {
          characterId: charId,
          characterNameZh: charId,
          playedCount: 0,
          winCount: 0,
          winRate: 0,
          avgDeathDay: null,
          deathReasons: {},
        };
      }
    }
  }

  return stats;
}

/**
 * 分析 AI 思考过程
 */
function analyzeThoughts(results: SimulationResult[]): ThoughtAnalysis {
  const allThoughts = results.flatMap(r => r.thoughts);

  if (allThoughts.length === 0) {
    return {
      avgThinkingLength: 0,
      commonEmotions: {},
      suspicionAccuracy: 0,
      commonStrategies: [],
      inconsistencies: [],
    };
  }

  // 平均思考长度
  const totalLength = allThoughts.reduce((sum, t) => sum + t.reasoning.length, 0);
  const avgThinkingLength = Math.round(totalLength / allThoughts.length);

  // 情绪统计
  const emotionCounts: Record<string, number> = {};
  for (const thought of allThoughts) {
    if (thought.emotion) {
      emotionCounts[thought.emotion] = (emotionCounts[thought.emotion] ?? 0) + 1;
    }
  }

  // 提取常见策略（从推理中提取关键词）
  const strategyKeywords = ['怀疑', '认为', '可能', '应该', '推测', '伪装', '撒谎', '保护', '攻击'];
  const commonStrategies: string[] = [];
  for (const thought of allThoughts.slice(0, 100)) { // 采样前 100 条
    for (const keyword of strategyKeywords) {
      if (thought.reasoning.includes(keyword)) {
        const idx = thought.reasoning.indexOf(keyword);
        const snippet = thought.reasoning.substring(Math.max(0, idx - 10), idx + 30);
        if (!commonStrategies.includes(snippet)) {
          commonStrategies.push(snippet);
        }
      }
    }
    if (commonStrategies.length >= 10) break;
  }

  // 检测不一致
  const inconsistencies: string[] = [];
  // 检查同一座位在不同天的怀疑度是否剧烈变化
  const thoughtsBySeat: Record<number, AiThoughtEntry[]> = {};
  for (const thought of allThoughts) {
    if (!thoughtsBySeat[thought.seatIndex]) {
      thoughtsBySeat[thought.seatIndex] = [];
    }
    thoughtsBySeat[thought.seatIndex].push(thought);
  }

  for (const [seat, thoughts] of Object.entries(thoughtsBySeat)) {
    if (thoughts.length > 5) {
      // 检查是否有矛盾的推理
      const day1Thoughts = thoughts.filter(t => t.dayNumber === 1);
      const day2Thoughts = thoughts.filter(t => t.dayNumber === 2);

      if (day1Thoughts.length > 0 && day2Thoughts.length > 0) {
        const day1Suspicion = day1Thoughts[0]?.context.suspicionSnapshot ?? [];
        const day2Suspicion = day2Thoughts[0]?.context.suspicionSnapshot ?? [];

        // 如果怀疑度排序剧烈变化，记录
        if (day1Suspicion.length > 0 && day2Suspicion.length > 0) {
          const day1Top = day1Suspicion[0]?.seat;
          const day2Top = day2Suspicion[0]?.seat;

          if (day1Top !== undefined && day2Top !== undefined && day1Top !== day2Top) {
            inconsistencies.push(
              `座位 #${Number(seat) + 1}：第 1 天最怀疑 #${day1Top + 1}，第 2 天最怀疑 #${day2Top + 1}，策略变化较大`
            );
          }
        }
      }
    }
  }

  return {
    avgThinkingLength,
    commonEmotions: emotionCounts,
    suspicionAccuracy: 0, // 需要更复杂的评估逻辑
    commonStrategies,
    inconsistencies,
  };
}

/**
 * 基于分析结果生成建议
 */
function generateRecommendations(data: {
  goodWins: number;
  evilWins: number;
  timeouts: number;
  avgDayCount: number;
  anomalies: string[];
  characterStats: Record<string, CharacterStat>;
  thoughtAnalysis: ThoughtAnalysis;
}): string[] {
  const recommendations: string[] = [];

  // 胜率分析
  const total = data.goodWins + data.evilWins + data.timeouts;
  if (total > 0) {
    const goodWinRate = data.goodWins / total;
    const evilWinRate = data.evilWins / total;

    if (goodWinRate > 0.8) {
      recommendations.push('⚠️ 善良阵营胜率过高（>80%），建议增强恶魔 AI 的策略或调整剧本配置');
    } else if (evilWinRate > 0.8) {
      recommendations.push('⚠️ 邪恶阵营胜率过高（>80%），建议增强好人 AI 的推理能力或调整投票逻辑');
    } else if (goodWinRate < 0.2) {
      recommendations.push('⚠️ 善良阵营胜率过低（<20%），可能 AI 玩家投票逻辑有问题');
    }
  }

  // 超时分析
  if (data.timeouts > 0) {
    recommendations.push(`🕒 有 ${data.timeouts} 局超时结束，建议增加最大天数或检查游戏流程卡点`);
  }

  // 平均天数
  if (data.avgDayCount < 2) {
    recommendations.push('📊 平均游戏天数过短（<2天），游戏可能缺乏悬念，建议调整初始配置');
  } else if (data.avgDayCount > 5) {
    recommendations.push('📊 平均游戏天数过长（>5天），可能投票效率低或恶魔太弱');
  }

  // 异常分析
  if (data.anomalies.length > 0) {
    recommendations.push(`🔍 检测到 ${data.anomalies.length} 个异常，建议逐一检查并修复`);
  }

  // AI 思考分析
  if (data.thoughtAnalysis.avgThinkingLength < 50) {
    recommendations.push('🤔 AI 玩家思考过程过短，可能 Prompt 不够详细或模型输出受限');
  }

  if (data.thoughtAnalysis.inconsistencies.length > 0) {
    recommendations.push(`🔄 检测到 ${data.thoughtAnalysis.inconsistencies.length} 处 AI 行为不一致，可能需要增强记忆系统`);
  }

  if (recommendations.length === 0) {
    recommendations.push('✅ 当前配置运行良好，暂无明显问题');
  }

  return recommendations;
}

/**
 * 将报告格式化为可读文本
 */
export function formatReport(report: SimulationReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════');
  lines.push('         血染钟楼 AI 对局分析报告');
  lines.push('═══════════════════════════════════════');
  lines.push('');

  lines.push('📊 总体统计');
  lines.push(`  总对局数：${report.totalGames}`);
  lines.push(`  善良胜利：${report.goodWins} (${report.totalGames > 0 ? Math.round(report.goodWins / report.totalGames * 100) : 0}%)`);
  lines.push(`  邪恶胜利：${report.evilWins} (${report.totalGames > 0 ? Math.round(report.evilWins / report.totalGames * 100) : 0}%)`);
  lines.push(`  超时结束：${report.timeouts}`);
  lines.push(`  平均天数：${report.avgDayCount}`);
  lines.push('');

  if (report.anomalies.length > 0) {
    lines.push('⚠️ 检测到的异常/漏洞');
    for (const anomaly of report.anomalies) {
      lines.push(`  - ${anomaly}`);
    }
    lines.push('');
  }

  if (Object.keys(report.characterStats).length > 0) {
    lines.push('🎭 角色统计');
    for (const [charId, stat] of Object.entries(report.characterStats)) {
      lines.push(`  ${stat.characterNameZh} (${charId})`);
      lines.push(`    出场：${stat.playedCount} 次，胜率：${Math.round(stat.winRate * 100)}%`);
    }
    lines.push('');
  }

  lines.push('🤔 AI 思考分析');
  lines.push(`  平均思考长度：${report.thoughtAnalysis.avgThinkingLength} 字符`);
  lines.push(`  常见情绪：${JSON.stringify(report.thoughtAnalysis.commonEmotions)}`);
  if (report.thoughtAnalysis.commonStrategies.length > 0) {
    lines.push('  常见策略：');
    for (const strategy of report.thoughtAnalysis.commonStrategies.slice(0, 5)) {
      lines.push(`    - ...${strategy}...`);
    }
  }
  if (report.thoughtAnalysis.inconsistencies.length > 0) {
    lines.push('  不一致行为：');
    for (const inc of report.thoughtAnalysis.inconsistencies.slice(0, 5)) {
      lines.push(`    - ${inc}`);
    }
  }
  lines.push('');

  lines.push('💡 建议');
  for (const rec of report.recommendations) {
    lines.push(`  ${rec}`);
  }
  lines.push('');
  lines.push('═══════════════════════════════════════');

  return lines.join('\n');
}
