// 快速测试：通过 API 运行 3 局 5 人 AI 自对局
import { runSimulation } from './src/runner/simulation.js';
import { generateReport, formatReport } from './src/runner/report.js';

(async () => {
  console.log('开始 AI 自对局测试...');
  try {
    const results = await runSimulation({
      playerCount: 5,
      aiPlayerCount: 5,
      maxDays: 5,
      iterations: 3,
    });
    console.log('对局结果:');
    console.log(JSON.stringify(results, null, 2));
    const report = generateReport(results);
    console.log('\n\n分析报告:');
    console.log(formatReport(report));
  } catch (e) {
    console.error('测试出错:', e);
  }
})();
