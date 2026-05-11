// ============================================================
// 对局复盘生成器：输出完整 JSON 记录
// ============================================================

import type { GameState, Room } from './types.js';
import { getEffectiveCharacterId } from './gameEngine.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GameRecord {
  meta: {
    roomId: string;
    script: string;
    scriptZh: string;
    winner: 'good' | 'evil';
    winnerZh: string;
    totalDays: number;
    startedAt: number;
    endedAt: number;
  };
  players: Array<{
    seatIndex: number;
    nickname: string;
    realCharacterId: string;
    realCharacterZh: string;
    alignment: 'good' | 'evil';
    shownCharacterId: string;
    shownCharacterZh: string;
    abilityZh: string;
    survived: boolean;
    isDrunkOrPoisoned: boolean;
  }>;
  nightLog: Array<{
    nightNumber: number;
    title: string;
    storytellerInfo: Array<{ characterId: string; characterZh: string; decision: unknown; actorSeat: number }>;
    nightActions: Array<{ actorSeat: number; actorRole: string; targetSeats: number[]; description: string }>;
    deaths: number[];
    revivals: number[];
  }>;
  dayLog: Array<{
    dayNumber: number;
    speeches: Array<{ seat: number; text: string }>;
    nominations: Array<{
      nominator: number;
      nominated: number;
      votes: Array<{ seat: number; inFavor: boolean }>;
      passed: boolean;
      votesFor: number;
    }>;
    execution: number | null;
    executedCharacterZh: string | null;
  }>;
  aiDecisions: Array<{
    dayNumber: number;
    phase: string;
    seatIndex: number;
    type: string;
    decision: unknown;
    reasoning: string;
  }>;
  publicLog: string[];
  chatLog: Array<{ scope: string; seat: number; text: string }>;
}

function parseSeat(s: string): number {
  const m = s.match(/#(\d+)/);
  return m ? parseInt(m[1], 10) - 1 : -1;
}

export function buildGameRecord(room: Room, winner: 'good' | 'evil'): GameRecord {
  const game = room.game;
  const now = Date.now();

  // ----- 玩家身份 -----
  const players = game.players.map(p => {
    const realChar = game.script.characters.find(c => c.id === p.characterId);
    const shownId = getEffectiveCharacterId(p) ?? p.characterId ?? 'unknown';
    const shownChar = game.script.characters.find(c => c.id === shownId);
    return {
      seatIndex: p.seatIndex,
      nickname: p.nickname,
      realCharacterId: p.characterId ?? 'unknown',
      realCharacterZh: realChar?.nameZh ?? p.characterId ?? '未知',
      alignment: (realChar?.alignment ?? 'good') as 'good' | 'evil',
      shownCharacterId: shownId,
      shownCharacterZh: shownChar?.nameZh ?? shownId,
      abilityZh: realChar?.abilityZh ?? '',
      survived: p.isAlive,
      isDrunkOrPoisoned: p.characterId === 'drunk' || game.poisonedSeatIndex === p.seatIndex,
    };
  });

  // ----- 夜晚日志 -----
  const nightLog: GameRecord['nightLog'] = [];
  const nightGroups = new Map<string, typeof game.replayLog>();
  for (const entry of game.replayLog) {
    if (entry.groupKey.startsWith('night_') || entry.groupKey === 'first_night') {
      const arr = nightGroups.get(entry.groupKey) ?? [];
      arr.push(entry);
      nightGroups.set(entry.groupKey, arr);
    }
  }

  for (const [groupKey, entries] of nightGroups) {
    const nightNumber = groupKey === 'first_night' ? 0 : parseInt(groupKey.replace('night_', ''), 10);
    const storytellerInfo: GameRecord['nightLog'][0]['storytellerInfo'] = [];
    const nightActions: GameRecord['nightLog'][0]['nightActions'] = [];

    for (const e of entries) {
      const line = e.line;

      // [夜间信息] #N Nickname：消息内容
      const infoMatch = line.match(/^\[夜间信息\] (.+?)：(.+)$/);
      if (infoMatch) {
        const actorSeat = parseSeat(infoMatch[1]);
        storytellerInfo.push({
          characterId: '',
          characterZh: infoMatch[1],
          decision: infoMatch[2],
          actorSeat,
        });
        continue;
      }

      // #N Nickname（角色名）选择 动作 目标...
      const actionMatch = line.match(/^(.+?)（(.+?)）选择(.+)$/);
      if (actionMatch) {
        const actorSeat = parseSeat(actionMatch[1]);
        const actorRole = actionMatch[2];
        const actionDesc = actionMatch[3];
        const targetSeats: number[] = [];
        const seatRe = /#(\d+)/g;
        let sm: RegExpExecArray | null;
        while ((sm = seatRe.exec(actionDesc)) !== null) {
          targetSeats.push(parseInt(sm[1], 10) - 1);
        }

        nightActions.push({
          actorSeat,
          actorRole,
          targetSeats,
          description: line,
        });
      }
    }

    nightLog.push({
      nightNumber,
      title: entries[0]?.groupTitle ?? `Night ${nightNumber}`,
      storytellerInfo,
      nightActions,
      deaths: [],
      revivals: [],
    });
  }

  // 从 replayLog 中搜索 day_N 组的 "天亮公布：昨夜死亡 ..." 行来填充 death
  for (const entry of game.replayLog) {
    if (!entry.groupKey.startsWith('day_')) continue;
    const m = entry.line.match(/天亮公布：昨夜死亡 (.+)/);
    if (m) {
      const seats = m[1].split('、').map(parseSeat).filter(s => s >= 0);
      // 找到对应夜晚：天亮公告出现在 day_N 组，对应 night N（即上一晚）
      const dayNum = parseInt(entry.groupKey.replace('day_', ''), 10);
      const nightEntry = nightLog.find(n => n.nightNumber === dayNum);
      if (nightEntry) nightEntry.deaths = seats;
    }
  }

  // ----- 白天日志 -----
  // 从 publicLog 提取发言和提名，从 replayLog 提取投票详情和处决
  let currentDay = 0;
  const daySpeeches = new Map<number, Array<{ seat: number; text: string }>>();
  const dayNoms = new Map<number, Array<{ nominator: number; nominated: number }>>();

  for (const log of game.publicLog) {
    const line = log.line;

    if (line.includes('进入白天阶段')) {
      currentDay++;
      if (!daySpeeches.has(currentDay)) daySpeeches.set(currentDay, []);
      if (!dayNoms.has(currentDay)) dayNoms.set(currentDay, []);
    }

    const speechMatch = line.match(/公开发言：(#\d+ .+?)：(.+)/);
    if (speechMatch && currentDay > 0) {
      const seatNum = parseSeat(speechMatch[1]);
      daySpeeches.get(currentDay)!.push({ seat: seatNum, text: speechMatch[2] });
    }

    const nomMatch = line.match(/(#\d+ .+?) 提名 (#\d+ .+?)。/);
    if (nomMatch && currentDay > 0 && !line.includes('提名被拒')) {
      const nominator = parseSeat(nomMatch[1]);
      const nominated = parseSeat(nomMatch[2]);
      dayNoms.get(currentDay)!.push({ nominator, nominated });
    }
  }

  // 从 replayLog 提取投票详情和处决（按 day_N 分组）
  const dayVoteGroups = new Map<number, Array<{ votes: Array<{ seat: number; inFavor: boolean }>; passed: boolean; votesFor: number }>>();
  const dayExecMap = new Map<number, { seat: number; characterZh: string }>();

  for (const entry of game.replayLog) {
    if (!entry.groupKey.startsWith('day_')) continue;
    const dayNum = parseInt(entry.groupKey.replace('day_', ''), 10);
    const line = entry.line;

    // 投票结束详情
    const voteMatch = line.match(/投票结束：(达到处决条件|未达到处决条件)（赞成 (\d+) 票）。票型：(.+)/);
    if (voteMatch) {
      const passed = voteMatch[1] === '达到处决条件';
      const votesFor = parseInt(voteMatch[2], 10);
      const voteDetails = voteMatch[3];
      const votes: Array<{ seat: number; inFavor: boolean }> = [];
      for (const part of voteDetails.split('；')) {
        const vm = part.match(/(#\d+ .+?)：(赞成|反对)/);
        if (vm) {
          votes.push({ seat: parseSeat(vm[1]), inFavor: vm[2] === '赞成' });
        }
      }
      if (!dayVoteGroups.has(dayNum)) dayVoteGroups.set(dayNum, []);
      dayVoteGroups.get(dayNum)!.push({ votes, passed, votesFor });
    }

    // 处决
    const execMatch = line.match(/处决 (#\d+ .+?)（(.+?)）。/);
    if (execMatch) {
      dayExecMap.set(dayNum, { seat: parseSeat(execMatch[1]), characterZh: execMatch[2] });
    }
  }

  // 组装 dayLog
  const dayLog: GameRecord['dayLog'] = [];
  const allDays = new Set<number>();
  for (const d of daySpeeches.keys()) allDays.add(d);
  for (const d of dayNoms.keys()) allDays.add(d);
  for (const d of dayVoteGroups.keys()) allDays.add(d);
  for (const d of dayExecMap.keys()) allDays.add(d);

  for (const dayNum of [...allDays].sort((a, b) => a - b)) {
    if (dayNum <= 0) continue;

    const speeches = daySpeeches.get(dayNum) ?? [];
    const rawNoms = dayNoms.get(dayNum) ?? [];
    const voteGroups = dayVoteGroups.get(dayNum) ?? [];
    const exec = dayExecMap.get(dayNum);

    const nominations: GameRecord['dayLog'][0]['nominations'] = rawNoms.map((nom, idx) => {
      const vg = voteGroups[idx] ?? { votes: [], passed: false, votesFor: 0 };
      return {
        nominator: nom.nominator,
        nominated: nom.nominated,
        votes: vg.votes,
        passed: vg.passed,
        votesFor: vg.votesFor,
      };
    });

    dayLog.push({
      dayNumber: dayNum,
      speeches,
      nominations,
      execution: exec?.seat ?? null,
      executedCharacterZh: exec?.characterZh ?? null,
    });
  }

  // ----- AI 决策 -----
  const aiDecisions = game.aiDecisionLog.map(d => ({
    dayNumber: d.dayNumber,
    phase: d.phase,
    seatIndex: d.seatIndex,
    type: d.type,
    decision: d.decision,
    reasoning: d.reasoning,
  }));

  // ----- 公开日志 -----
  const publicLog = game.publicLog.map(l => l.line);

  // ----- 聊天日志 -----
  const chatLog = game.chatLog.map(c => ({
    scope: c.scope,
    seat: c.fromSeat,
    text: c.text,
  }));

  return {
    meta: {
      roomId: room.id,
      script: game.scriptId,
      scriptZh: game.script.nameZh,
      winner,
      winnerZh: winner === 'good' ? '善良阵营' : '邪恶阵营',
      totalDays: game.dayNumber,
      startedAt: game.publicLog[0]?.at ?? 0,
      endedAt: now,
    },
    players,
    nightLog,
    dayLog,
    aiDecisions,
    publicLog,
    chatLog,
  };
}

export function writeGameRecord(record: GameRecord): string {
  const dir = path.resolve('game_records');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${ts}_${record.meta.roomId}_${record.meta.winner}.json`;

  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), 'utf-8');
  console.log(`[BOTC] Game record written: ${path.join(dir, filename)}`);
  return filename;
}
