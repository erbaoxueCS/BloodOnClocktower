import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayBundle, RoomView, YourRolePayload } from './types';

// HTTP 走 Vite 代理 /api
// 开发环境：前端端口可能是 5173/5174/...，但后端固定 3001
const BACKEND_PORT = import.meta.env.DEV ? '3001' : (location.port || '');
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}${BACKEND_PORT ? `:${BACKEND_PORT}` : ''}`;

interface GameProps {
  roomId: string;
  room: RoomView;
  yourSeatIndex: number;
  yourCharacterId: string | null;
  hostSecret: string | null;
  onLeave: () => void;
  onRoomUpdate: (room: RoomView) => void;
}

type AiTraceEntry = {
  id: string;
  at: number;
  updatedAt?: number;
  actor: 'player' | 'storyteller';
  seatIndex: number | null;
  roomId: string;
  phase: string;
  dayNumber?: number;
  stage: 'day_plan' | 'day_dialogue' | 'night_action' | 'storyteller_decision';
  status: 'started' | 'responded' | 'applied' | 'fallback' | 'error';
  stepId?: string;
  model: string;
  elapsedMs?: number;
  request?: string;
  response?: string;
  behavior?: string;
  error?: string;
};

type PostGameGodQa = {
  question: string;
  answer: string;
  at: number;
};

type PostGamePlayerQa = {
  targetSeatIndex: number;
  question: string;
  answer: string;
  at: number;
};

type FormattedTraceExportItem = {
  id: string;
  time: string;
  actor: string;
  stage: string;
  status: string;
  model: string;
  elapsedMs?: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  behavior?: string;
  error?: string;
};

type AiCallStats = {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  failureReasons: Array<{ reason: string; count: number }>;
};

function parseJsonSafe<T = unknown>(v: string | undefined | null): T | null {
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

function deepParseJsonStrings(input: unknown, depth = 0): unknown {
  if (depth > 4) return input;
  if (typeof input === 'string') {
    const s = input.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      const parsed = parseJsonSafe<unknown>(s);
      if (parsed != null) return deepParseJsonStrings(parsed, depth + 1);
    }
    return input;
  }
  if (Array.isArray(input)) return input.map((x) => deepParseJsonStrings(x, depth + 1));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = deepParseJsonStrings(v, depth + 1);
    }
    return out;
  }
  return input;
}

function toReadableJsonOrText(raw: string | undefined): { isJson: boolean; text: string } {
  if (!raw) return { isJson: false, text: '' };
  const parsed = parseJsonSafe<unknown>(raw);
  if (parsed == null) return { isJson: false, text: raw };
  const normalized = deepParseJsonStrings(parsed);
  return {
    isJson: true,
    text: JSON.stringify(normalized, null, 2),
  };
}

function phaseToText(phase: string, dayNumber?: number): string {
  if (phase === 'first_night') return '首夜';
  if (phase === 'night') return `第 ${typeof dayNumber === 'number' ? dayNumber + 1 : '?'} 夜`;
  if (phase === 'day') return `第 ${typeof dayNumber === 'number' ? dayNumber : '?'} 天白天`;
  return phase;
}

function toStageText(stage: AiTraceEntry['stage']): string {
  if (stage === 'day_plan') return '白天计划';
  if (stage === 'day_dialogue') return '白天对话';
  if (stage === 'night_action') return '夜晚行动';
  return '说书人裁量';
}

function toStatusText(status: AiTraceEntry['status']): string {
  if (status === 'started') return '请求中';
  if (status === 'responded') return '已返回';
  if (status === 'applied') return '已执行';
  if (status === 'fallback') return '兜底';
  return '错误';
}

function buildFormattedTraceItem(entry: AiTraceEntry): FormattedTraceExportItem {
  const requestObj = parseJsonSafe<Record<string, unknown>>(entry.request);
  const responseObj = parseJsonSafe<Record<string, unknown>>(entry.response);
  const userPromptObj =
    requestObj && typeof requestObj.userPrompt === 'string'
      ? parseJsonSafe<Record<string, unknown>>(String(requestObj.userPrompt))
      : null;
  const contextObj = (userPromptObj?.context as Record<string, unknown> | undefined) ?? null;
  const roomView = (contextObj?.roomView as Record<string, unknown> | undefined) ?? null;
  const yourRole = (contextObj?.yourRole as Record<string, unknown> | undefined) ?? null;
  const yourAlignment = (contextObj?.yourAlignment as string | undefined) ?? undefined;
  const chatLog = (contextObj?.chatLog as unknown[] | undefined) ?? [];
  const nightInfo = (contextObj?.nightInfo as unknown[] | undefined) ?? [];
  const players = (roomView?.players as Array<Record<string, unknown>> | undefined) ?? [];
  const aliveSeats = players
    .filter((p) => p && p.isAlive === true && typeof p.seatIndex === 'number')
    .map((p) => Number(p.seatIndex) + 1);
  const deadSeats = players
    .filter((p) => p && p.isAlive === false && typeof p.seatIndex === 'number')
    .map((p) => Number(p.seatIndex) + 1);
  const publicClaims = chatLog
    .filter((c) => c && typeof c === 'object' && (c as any).scope === 'public')
    .slice(-8)
    .map((c) => `#${Number((c as any).fromSeat) + 1}: ${String((c as any).text ?? '').slice(0, 80)}`);

  const input = {
    游戏基础信息: {
      当前游戏剧本: roomView?.scriptNameZh ?? null,
      总玩家人数: players.length || null,
      你的玩家编号: typeof contextObj?.yourSeatIndex === 'number' ? Number(contextObj.yourSeatIndex) + 1 : null,
      你的身份: yourRole?.characterNameZh ?? contextObj?.yourCharacterId ?? null,
      你的阵营: yourAlignment ?? null,
    },
    当前游戏状态: {
      游戏阶段: phaseToText(entry.phase, entry.dayNumber),
      存活玩家列表: aliveSeats.length > 0 ? aliveSeats.join(', ') : '无',
      已死亡玩家列表: deadSeats.length > 0 ? deadSeats.join(', ') : '无',
      当前讨论焦点: publicClaims.length > 0 ? publicClaims.slice(-3).join(' | ') : '无明显焦点',
      最近公开声明: publicClaims.length > 0 ? publicClaims : [],
      你的夜间信息: nightInfo.length > 0 ? nightInfo : [],
    },
  };

  const output = {
    当前身份: yourRole?.characterNameZh ?? contextObj?.yourCharacterId ?? null,
    当前阵营: yourAlignment ?? null,
    模型输出摘要: responseObj ?? (entry.response ? entry.response.slice(0, 500) : null),
    阶段行为: entry.behavior ?? null,
  };

  return {
    id: entry.id,
    time: new Date(entry.at).toISOString(),
    actor: entry.actor === 'player' ? 'AI玩家' : 'AI说书人',
    stage: toStageText(entry.stage),
    status: toStatusText(entry.status),
    model: entry.model,
    elapsedMs: entry.elapsedMs,
    input,
    output,
    behavior: entry.behavior,
    error: entry.error,
  };
}

function toZhError(raw: string): string {
  if (raw.startsWith('night_action_failed:')) {
    return `夜晚行动无效：${raw.replace('night_action_failed:', '')}`;
  }
  if (raw.startsWith('day_action_limit_reached:slayer_shot') || raw.startsWith('day_action_limit_reached:slayer_sho')) {
    return '白天技能已达使用上限：本局你已使用过一次“杀手开枪”';
  }
  if (raw === 'day_action_not_allowed') return '当前阶段不可使用白天技能';
  if (raw === 'day_action_actor_not_alive') return '只有存活玩家可以发动白天技能';
  if (raw === 'day_action_target_not_alive') return '目标已死亡，无法选择';
  if (raw === 'day_action_invalid_target') return '无效目标，请重新选择';
  if (raw === 'day_action_unknown') return '未知白天技能操作';
  return raw;
}

export function Game({ roomId, room: initialRoom, yourSeatIndex, yourCharacterId: initialChar, hostSecret, onLeave, onRoomUpdate }: GameProps) {
  const [room, setRoom] = useState<RoomView>(initialRoom);
  const [characterId, setCharacterId] = useState<string | null>(initialChar);
  const [yourRole, setYourRole] = useState<YourRolePayload | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [lastSendError, setLastSendError] = useState<string>('');
  const [optimisticReady, setOptimisticReady] = useState<boolean | null>(null);
  const [nightPrompt, setNightPrompt] = useState<null | { stepId: string; actorSeatIndex: number; pick: 1 | 2; aliveSeatIndices: number[] }>(null);
  const [nightTargets, setNightTargets] = useState<number[]>([]);
  const [nightLog, setNightLog] = useState<string[]>([]);
  const [chatEntries, setChatEntries] = useState<NonNullable<RoomView['chatLog']>>([]);
  const [chatScope, setChatScope] = useState<'all' | 'god' | 'dm' | 'public'>('all');
  const [chatDmTarget, setChatDmTarget] = useState<number | null>(null);
  const [chatText, setChatText] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [awaitingNightConfirm, setAwaitingNightConfirm] = useState(false);
  const [nightConfirmedSeats, setNightConfirmedSeats] = useState<number[]>([]);
  const [awaitingNightInfoConfirm, setAwaitingNightInfoConfirm] = useState(false);
  const [pendingNightInfoConfirmSeats, setPendingNightInfoConfirmSeats] = useState<number[]>([]);
  const [nightInfoConfirmedSeats, setNightInfoConfirmedSeats] = useState<number[]>([]);
  const [endedReplay, setEndedReplay] = useState<ReplayBundle | null>(null);
  const [slayerTarget, setSlayerTarget] = useState<number | null>(null);
  const [myVoteChoice, setMyVoteChoice] = useState<boolean | null>(null);
  const [isHost, setIsHost] = useState<boolean>(false);
  const [copyTip, setCopyTip] = useState('');
  const [aiTraceEntries, setAiTraceEntries] = useState<AiTraceEntry[]>([]);
  const [traceStageFilter, setTraceStageFilter] = useState<'all' | AiTraceEntry['stage']>('all');
  const [traceStatusFilter, setTraceStatusFilter] = useState<'all' | AiTraceEntry['status']>('all');
  const [traceCurrentDayOnly, setTraceCurrentDayOnly] = useState(false);
  const [traceKeyword, setTraceKeyword] = useState('');
  const [traceNightChainView, setTraceNightChainView] = useState(false);
  const [publicBoardMode, setPublicBoardMode] = useState<'compact' | 'detailed'>('compact');
  const [postGameGodQuestion, setPostGameGodQuestion] = useState('');
  const [postGameGodAsking, setPostGameGodAsking] = useState(false);
  const [postGameGodQaList, setPostGameGodQaList] = useState<PostGameGodQa[]>([]);
  const [postGamePlayerTargetSeat, setPostGamePlayerTargetSeat] = useState<number | null>(null);
  const [postGamePlayerQuestion, setPostGamePlayerQuestion] = useState('');
  const [postGamePlayerAsking, setPostGamePlayerAsking] = useState(false);
  const [postGamePlayerQaList, setPostGamePlayerQaList] = useState<PostGamePlayerQa[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const autoAiTriedRef = useRef(false);
  const unifiedSelectStyle = {
    marginLeft: 6,
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid #3a3a3a',
    background: '#0f172a',
    color: '#e5e7eb',
  };
  const unifiedInputStyle = {
    marginLeft: 6,
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid #3a3a3a',
    background: '#0f172a',
    color: '#e5e7eb',
  };
  const behaviorStyleZh = (s: string | undefined | null): string => {
    if (s === 'analytical') return '理性推理型';
    if (s === 'skeptical') return '质询怀疑型';
    if (s === 'cautious') return '谨慎保守型';
    if (s === 'empathetic') return '共情拉票型';
    if (s === 'deceptive') return '圆滑误导型';
    if (s === 'chaotic') return '反常规搅局型';
    return '未分配';
  };

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(room.id);
      setCopyTip('已复制');
      setTimeout(() => setCopyTip(''), 1200);
    } catch {
      setCopyTip('复制失败');
      setTimeout(() => setCopyTip(''), 1500);
    }
  };

  const exportAiTraceJson = () => {
    if (aiTraceEntries.length === 0) return;
    const formattedEntries = aiTraceEntries.map(buildFormattedTraceItem);
    const payload = {
      exportedAt: new Date().toISOString(),
      roomId: room.id,
      seatIndex: yourSeatIndex,
      summary: {
        total: formattedEntries.length,
        applied: formattedEntries.filter((e) => e.status === '已执行').length,
        fallback: formattedEntries.filter((e) => e.status === '兜底').length,
        error: formattedEntries.filter((e) => e.status === '错误').length,
      },
      entries: formattedEntries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-trace-room-${room.id}-seat-${yourSeatIndex + 1}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getTraceStatusStyle = (status: AiTraceEntry['status']) => {
    if (status === 'applied') return { bg: '#173a22', color: '#8ff0b3', label: '已执行' };
    if (status === 'responded') return { bg: '#21404f', color: '#8fdfff', label: '已返回' };
    if (status === 'started') return { bg: '#1f2d44', color: '#9cc6ff', label: '请求中' };
    if (status === 'fallback') return { bg: '#45361a', color: '#ffd38a', label: '兜底' };
    return { bg: '#4a1f24', color: '#ff9fa8', label: '错误' };
  };

  const replaySections = useMemo(() => {
    if (!endedReplay?.entries?.length) return [];
    const sorted = [...endedReplay.entries].sort((a, b) => a.seq - b.seq);
    const map = new Map<string, { title: string; lines: string[] }>();
    for (const e of sorted) {
      let block = map.get(e.groupKey);
      if (!block) {
        block = { title: e.groupTitle, lines: [] };
        map.set(e.groupKey, block);
      }
      block.lines.push(e.line);
    }
    return Array.from(map.entries()).map(([groupKey, v]) => ({ groupKey, ...v }));
  }, [endedReplay]);

  const filteredAiTraceEntries = useMemo(() => {
    const kw = traceKeyword.trim().toLowerCase();
    return aiTraceEntries.filter((e) => {
      const stageOk = traceStageFilter === 'all' || e.stage === traceStageFilter;
      const statusOk = traceStatusFilter === 'all' || e.status === traceStatusFilter;
      const dayOk = !traceCurrentDayOnly || e.dayNumber === room.dayNumber;
      const keywordOk = !kw || [
        e.request ?? '',
        e.response ?? '',
        e.behavior ?? '',
        e.error ?? '',
      ].join('\n').toLowerCase().includes(kw);
      return stageOk && statusOk && dayOk && keywordOk;
    });
  }, [aiTraceEntries, traceStageFilter, traceStatusFilter, traceCurrentDayOnly, traceKeyword, room.dayNumber]);

  const endedAiCallStats = useMemo<AiCallStats | null>(() => {
    if (room.status !== 'ended') return null;
    if (aiTraceEntries.length === 0) {
      return { totalCalls: 0, successCalls: 0, failedCalls: 0, failureReasons: [] };
    }

    // 同一调用 id 会有多次状态更新，这里按“最后一次状态”统计最终结果。
    const latestById = new Map<string, AiTraceEntry>();
    for (const entry of aiTraceEntries) {
      const prev = latestById.get(entry.id);
      if (!prev) {
        latestById.set(entry.id, entry);
        continue;
      }
      const prevTs = prev.updatedAt ?? prev.at ?? 0;
      const curTs = entry.updatedAt ?? entry.at ?? 0;
      if (curTs >= prevTs) latestById.set(entry.id, entry);
    }

    let successCalls = 0;
    let failedCalls = 0;
    const reasonCounter = new Map<string, number>();

    for (const finalEntry of latestById.values()) {
      const status = finalEntry.status;
      if (status === 'error' || status === 'fallback') {
        failedCalls += 1;
        const reasonBase = String(finalEntry.error ?? finalEntry.behavior ?? 'unknown_failure').trim();
        const reason = reasonBase || 'unknown_failure';
        reasonCounter.set(reason, (reasonCounter.get(reason) ?? 0) + 1);
      } else {
        successCalls += 1;
      }
    }

    const failureReasons = Array.from(reasonCounter.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalCalls: latestById.size,
      successCalls,
      failedCalls,
      failureReasons,
    };
  }, [aiTraceEntries, room.status]);

  const nightMediationChains = useMemo(() => {
    const sorted = [...filteredAiTraceEntries]
      .filter((e) => (e.phase === 'night' || e.phase === 'first_night') && !!e.stepId && (e.stage === 'night_action' || e.stage === 'storyteller_decision'))
      .sort((a, b) => a.at - b.at);
    const map = new Map<string, { key: string; dayNumber?: number; phase: string; seatIndex: number | null; stepId?: string; player?: AiTraceEntry; storyteller?: AiTraceEntry }>();
    for (const e of sorted) {
      const key = `${e.dayNumber ?? -1}|${e.phase}|${e.seatIndex ?? -1}|${e.stepId ?? 'unknown'}`;
      const item = map.get(key) ?? {
        key,
        dayNumber: e.dayNumber,
        phase: e.phase,
        seatIndex: e.seatIndex,
        stepId: e.stepId,
      };
      if (e.stage === 'night_action') item.player = e;
      if (e.stage === 'storyteller_decision') item.storyteller = e;
      map.set(key, item);
    }
    return Array.from(map.values()).sort((a, b) => {
      const ta = Math.max(a.player?.at ?? 0, a.storyteller?.at ?? 0);
      const tb = Math.max(b.player?.at ?? 0, b.storyteller?.at ?? 0);
      return tb - ta;
    });
  }, [filteredAiTraceEntries]);

  const visiblePublicLog = useMemo(() => {
    const all = room.publicLog ?? [];
    if (publicBoardMode === 'detailed') return all.slice(-20);
    const isCompactLine = (line: string): boolean => {
      const t = String(line ?? '');
      return t.startsWith('公开发言：')
        || t.startsWith('进入白天阶段：')
        || t.startsWith('进入夜晚。')
        || t.includes('夜晚结束，天亮');
    };
    return all.filter((e) => isCompactLine(e.line)).slice(-20);
  }, [room.publicLog, publicBoardMode]);

  useEffect(() => {
    const qs = new URLSearchParams({ roomId, seatIndex: String(yourSeatIndex) });
    if (hostSecret) qs.set('hostSecret', hostSecret);
    const ws = new WebSocket(`${WS_URL}?${qs.toString()}`);
    wsRef.current = ws;
    setWsStatus('connecting');
    setLastSendError('');
    setOptimisticReady(null);
    ws.onopen = () => {
      setWsStatus('open');
      // Dev 便捷：URL 带 autoAi=1 时自动开启本座位 AI 托管
      if (!autoAiTriedRef.current) {
        autoAiTriedRef.current = true;
        const qs2 = new URLSearchParams(location.search);
        const autoAi = qs2.get('autoAi') === '1';
        if (autoAi) {
          try {
            ws.send(JSON.stringify({ type: 'toggle_ai_player', enabled: true }));
          } catch {
            // ignore
          }
        }
      }
    };
    ws.onerror = () => setWsStatus('error');
    ws.onclose = () => setWsStatus('closed');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'room') {
          setRoom(msg.room);
          onRoomUpdate(msg.room);
          if (msg.yourCharacterId != null) setCharacterId(msg.yourCharacterId);
          else setCharacterId(null);
          setYourRole(msg.yourRole ?? null);
          setIsHost(!!msg.isHost);
          setChatEntries(Array.isArray(msg.room.chatLog) ? msg.room.chatLog : []);
          setAwaitingNightConfirm(!!msg.room.awaitingNightConfirm);
          setNightConfirmedSeats(Array.isArray(msg.room.nightConfirmedSeats) ? msg.room.nightConfirmedSeats : []);
          setAwaitingNightInfoConfirm(!!msg.room.awaitingNightInfoConfirm);
          setPendingNightInfoConfirmSeats(Array.isArray(msg.room.pendingNightInfoConfirmSeats) ? msg.room.pendingNightInfoConfirmSeats : []);
          setNightInfoConfirmedSeats(Array.isArray(msg.room.nightInfoConfirmedSeats) ? msg.room.nightInfoConfirmedSeats : []);
          // 每局重置：房间回到大厅时，清空本地夜间信息与对话输入状态（避免下一局残留）
          if (msg.room.status === 'lobby') {
            setNightLog([]);
            setChatEntries([]);
            setChatText('');
            setChatScope('god');
            setChatDmTarget(null);
            setAwaitingNightConfirm(false);
            setNightConfirmedSeats([]);
            setAwaitingNightInfoConfirm(false);
            setPendingNightInfoConfirmSeats([]);
            setNightInfoConfirmedSeats([]);
            setEndedReplay(null);
            setAiTraceEntries([]);
            setPostGameGodQaList([]);
            setPostGameGodQuestion('');
            setPostGameGodAsking(false);
            setPostGamePlayerQaList([]);
            setPostGamePlayerQuestion('');
            setPostGamePlayerAsking(false);
            setPostGamePlayerTargetSeat(null);
          }
          if (msg.room.phase === 'day' || msg.room.phase === 'waiting') {
            setNightPrompt(null);
            setNightTargets([]);
          }
          // 一旦收到服务端状态，以服务端为准
          setOptimisticReady(null);
        } else if (msg.type === 'night_prompt') {
          setNightPrompt(msg);
          setNightTargets([]);
        } else if (msg.type === 'night_info') {
          const text = String(msg.message ?? '');
          if (text) setNightLog((prev) => [text, ...prev].slice(0, 50));
        } else if (msg.type === 'chat_event') {
          if (msg.entry && typeof msg.entry === 'object') setChatEntries((prev) => [...prev, msg.entry].slice(-500));
        } else if (msg.type === 'night_confirm_update') {
          setAwaitingNightConfirm(!!msg.awaiting);
          setNightConfirmedSeats(Array.isArray(msg.confirmedSeats) ? msg.confirmedSeats : []);
          setAwaitingNightInfoConfirm(!!msg.awaitingInfo);
          setPendingNightInfoConfirmSeats(Array.isArray(msg.pendingInfoSeats) ? msg.pendingInfoSeats : []);
          setNightInfoConfirmedSeats(Array.isArray(msg.infoConfirmedSeats) ? msg.infoConfirmedSeats : []);
        } else if (msg.type === 'phase') {
          setRoom((r) => ({ ...r, phase: msg.phase, dayNumber: msg.dayNumber ?? r.dayNumber }));
          if (msg.phase === 'day' || msg.phase === 'waiting') {
            setNightPrompt(null);
            setNightTargets([]);
          }
        } else if (msg.type === 'vote_result') {
          setRoom((r) => ({ ...r, currentNomination: null }));
          setMyVoteChoice(null);
          // 票型公开：打印到控制台（后续可做 UI 面板）
          if (Array.isArray(msg.votes)) {
            console.log('vote_result', { passed: msg.passed, votesFor: msg.votesFor, votes: msg.votes });
          }
        } else if (msg.type === 'game_over') {
          setRoom(msg.room);
          setEndedReplay(msg.replay ?? null);
          setYourRole(msg.yourRole ?? null);
          if (msg.yourCharacterId != null) setCharacterId(msg.yourCharacterId);
          setIsHost(!!msg.isHost);
          setNightPrompt(null);
          setNightTargets([]);
          setChatEntries(Array.isArray(msg.room.chatLog) ? msg.room.chatLog : []);
          setAwaitingNightConfirm(!!msg.room.awaitingNightConfirm);
          setNightConfirmedSeats(Array.isArray(msg.room.nightConfirmedSeats) ? msg.room.nightConfirmedSeats : []);
          setAwaitingNightInfoConfirm(!!msg.room.awaitingNightInfoConfirm);
          setPendingNightInfoConfirmSeats(Array.isArray(msg.room.pendingNightInfoConfirmSeats) ? msg.room.pendingNightInfoConfirmSeats : []);
          setNightInfoConfirmedSeats(Array.isArray(msg.room.nightInfoConfirmedSeats) ? msg.room.nightInfoConfirmedSeats : []);
        } else if (msg.type === 'error') {
          console.error(msg.message);
          const raw = String(msg.message ?? '未知错误');
          setLastSendError(toZhError(raw));
          setPostGameGodAsking(false);
          setPostGamePlayerAsking(false);
        } else if (msg.type === 'ai_trace') {
          if (msg.entry && typeof msg.entry === 'object') {
            setAiTraceEntries((prev) => [...prev, msg.entry as AiTraceEntry].slice(-80));
          }
        } else if (msg.type === 'post_game_god_answer') {
          const question = String(msg.question ?? '').trim();
          const answer = String(msg.answer ?? '').trim();
          const at = Number(msg.at ?? Date.now());
          if (question && answer) {
            setPostGameGodQaList((prev) => [...prev, { question, answer, at }].slice(-20));
          }
          setPostGameGodAsking(false);
        } else if (msg.type === 'post_game_player_answer') {
          const question = String(msg.question ?? '').trim();
          const answer = String(msg.answer ?? '').trim();
          const targetSeatIndex = Number(msg.targetSeatIndex);
          const at = Number(msg.at ?? Date.now());
          if (question && answer && Number.isInteger(targetSeatIndex)) {
            setPostGamePlayerQaList((prev) => [...prev, { targetSeatIndex, question, answer, at }].slice(-30));
          }
          setPostGamePlayerAsking(false);
        }
      } catch (_) {}
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [roomId, yourSeatIndex, hostSecret]);

  useEffect(() => {
    if (!room.currentNomination) setMyVoteChoice(null);
  }, [room.currentNomination]);

  const send = (payload: object) => {
    setLastSendError('');
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    } else {
      setLastSendError('未连接到后端（WebSocket 未打开）');
    }
  };
  const canSend = wsStatus === 'open';

  const you = room.players[yourSeatIndex];
  const effectiveReady = optimisticReady ?? you?.isReady ?? false;
  const canStart = room.status === 'lobby' && room.players.length >= room.minPlayers && room.players.every((p) => p.isReady) && isHost;
  const isMyNightTurn = nightPrompt?.actorSeatIndex === yourSeatIndex;
  const inNight = room.phase === 'night' || room.phase === 'first_night';
  const mySeat = yourSeatIndex;
  const dmTabs = useMemo(() => {
    const set = new Set<number>();
    for (const e of (chatEntries ?? [])) {
      if (e.scope !== 'dm') continue;
      const a = e.fromSeat;
      const b = (typeof e.toSeat === 'number') ? e.toSeat : null;
      if (a === mySeat && b != null) set.add(b);
      if (b === mySeat && a != null) set.add(a);
    }
    // 让当前选择的目标也出现在 tabs 里
    if (chatDmTarget != null) set.add(chatDmTarget);
    return Array.from(set.values()).sort((x, y) => x - y);
  }, [chatEntries, chatDmTarget, mySeat]);

  const visibleChat = useMemo(() => {
    const base = [...(chatEntries ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const filtered = base.filter((e) => {
      // “全部”只用于回看公开/上帝信息流；私聊请到“私聊”页查看具体对象对话
      if (chatScope === 'all') return e.scope !== 'dm';
      if (chatScope === 'god') return e.scope === 'god';
      if (chatScope === 'public') return e.scope === 'public';
      if (e.scope !== 'dm') return false;
      if (chatDmTarget == null) return false;
      const a = e.fromSeat;
      const b = (typeof e.toSeat === 'number') ? e.toSeat : null;
      return (a === mySeat && b === chatDmTarget) || (b === mySeat && a === chatDmTarget);
    });
    return filtered.slice(-120);
  }, [chatEntries, chatScope, chatDmTarget, mySeat]);

  // 对话自动滚动：只有在用户本来就在底部附近时才自动滚
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distToBottom < 60) el.scrollTop = el.scrollHeight;
  }, [visibleChat.length, chatScope, chatDmTarget]);

  const trySendChat = () => {
    if (chatSending) return;
    const text = chatText.trim();
    if (!text) return;
    if (!canSend) return;
    if (chatScope === 'dm' && chatDmTarget == null) return;
    if (chatScope === 'god' && !inNight) return;

    setChatSending(true);
    if (chatScope === 'god') send({ type: 'chat_send', scope: 'god', text });
    else if (chatScope === 'public') send({ type: 'chat_send', scope: 'public', text });
    else send({ type: 'chat_send', scope: 'dm', toSeat: chatDmTarget, text });
    setChatText('');
    // 轻量防连点：避免重复发送/重复点击
    setTimeout(() => setChatSending(false), 350);
  };

  const askPostGameGod = () => {
    const q = postGameGodQuestion.trim();
    if (!q) return;
    if (!canSend) return;
    if (room.status !== 'ended') return;
    if (postGameGodAsking) return;
    setPostGameGodAsking(true);
    send({ type: 'post_game_ask_god', question: q });
    setPostGameGodQuestion('');
  };

  const askPostGamePlayer = () => {
    const q = postGamePlayerQuestion.trim();
    if (!q) return;
    if (!canSend) return;
    if (room.status !== 'ended') return;
    if (postGamePlayerAsking) return;
    if (!Number.isInteger(postGamePlayerTargetSeat)) return;
    setPostGamePlayerAsking(true);
    send({ type: 'post_game_ask_player', targetSeatIndex: postGamePlayerTargetSeat, question: q });
    setPostGamePlayerQuestion('');
  };

  return (
    <div className="page">
      <div className="header">
        <div>
          <h1 className="title">Blood on the Clocktower · {room.scriptNameZh}</h1>
          <p className="subtitle">
            房间号：<code className="mono">{room.id}</code>
            <button type="button" style={{ marginLeft: 8 }} onClick={copyRoomId}>复制</button>
            {copyTip && <span style={{ marginLeft: 6 }}>{copyTip}</span>}
            {' '}· 你的座位：{yourSeatIndex + 1}
          </p>
        </div>
        <button className="btn-danger" type="button" onClick={onLeave}>离开房间</button>
      </div>
      <p className="muted">
        当前进度：{' '}
        {room.status === 'lobby'
          ? '大厅'
          : room.status === 'ended'
            ? '对局已结束'
            : room.phase === 'first_night'
              ? '首夜（仅信息，无恶魔刀人）'
              : room.phase === 'night'
                ? `第 ${room.dayNumber + 1} 夜`
                : `第 ${room.dayNumber} 天 · 白天`}
      </p>
      <div className="row">
        <span className={`pill ${wsStatus === 'open' ? 'status-ok' : 'status-danger'}`}>
          连接状态：{wsStatus === 'open' ? '已连接' : wsStatus === 'connecting' ? '连接中' : wsStatus === 'closed' ? '已断开' : '错误'}
        </span>
        {lastSendError && <span className="pill status-danger">{lastSendError}</span>}
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0 }}>AI 调用记录（本座位）</h3>
            <p className="muted" style={{ marginTop: 6 }}>
              对局中所有 AI 调用都会保留；对局结束后仍可导出 JSON 用于 Prompt 复盘。
            </p>
          </div>
          <button type="button" onClick={exportAiTraceJson} disabled={aiTraceEntries.length === 0}>
            导出日志 JSON
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          当前筛选后 {filteredAiTraceEntries.length} / 总计 {aiTraceEntries.length} 条
          {aiTraceEntries.length > 0 ? ` · 最近一条：${new Date(aiTraceEntries[aiTraceEntries.length - 1].at).toLocaleTimeString()}` : ' · 暂无调用记录'}
        </p>
        {aiTraceEntries.length === 0 ? (
          <p className="muted" style={{ marginTop: 8 }}>
            还没有收到 AI 调用事件。先开启 AI 托管或 AI 说书人并推进一轮流程后，这里会实时出现记录。
          </p>
        ) : (
        <div>
          {room.status === 'ended' && endedAiCallStats && (
            <div style={{ marginTop: 8, border: '1px solid #333', borderRadius: 8, padding: 10, background: '#0f172a' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                终局 AI 调用统计：总调用 {endedAiCallStats.totalCalls} 次，成功 {endedAiCallStats.successCalls} 次，失败 {endedAiCallStats.failedCalls} 次
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                失败原因统计（按次数降序）
              </div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.5 }}>
                {endedAiCallStats.failureReasons.length > 0
                  ? endedAiCallStats.failureReasons.map((item, idx) => (
                    <li key={`${item.reason}-${idx}`}>{item.reason} · {item.count} 次</li>
                  ))
                  : <li className="muted">无失败记录</li>}
              </ul>
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <label className="muted">
              阶段：
              <select
                style={unifiedSelectStyle}
                value={traceStageFilter}
                onChange={(e) => setTraceStageFilter(e.target.value as 'all' | AiTraceEntry['stage'])}
              >
                <option value="all">全部</option>
                <option value="day_plan">白天计划</option>
                <option value="day_dialogue">白天对话</option>
                <option value="night_action">夜晚行动</option>
                <option value="storyteller_decision">说书人裁量</option>
              </select>
            </label>
            <label className="muted">
              状态：
              <select
                style={unifiedSelectStyle}
                value={traceStatusFilter}
                onChange={(e) => setTraceStatusFilter(e.target.value as 'all' | AiTraceEntry['status'])}
              >
                <option value="all">全部</option>
                <option value="started">请求中</option>
                <option value="responded">已返回</option>
                <option value="applied">已执行</option>
                <option value="fallback">兜底</option>
                <option value="error">错误</option>
              </select>
            </label>
            <label className="muted">
              <input
                type="checkbox"
                checked={traceCurrentDayOnly}
                onChange={(e) => setTraceCurrentDayOnly(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              仅当前天（Day {room.dayNumber}）
            </label>
            <label className="muted">
              搜索：
              <input
                style={{ ...unifiedInputStyle, minWidth: 180 }}
                value={traceKeyword}
                onChange={(e) => setTraceKeyword(e.target.value)}
                placeholder="关键词（prompt/behavior/error）"
              />
            </label>
            <label className="muted">
              <input
                type="checkbox"
                checked={traceNightChainView}
                onChange={(e) => setTraceNightChainView(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              夜晚中转链路视图
            </label>
            <button
              type="button"
              onClick={() => {
                setTraceStageFilter('all');
                setTraceStatusFilter('all');
                setTraceCurrentDayOnly(false);
                setTraceKeyword('');
                setTraceNightChainView(false);
              }}
            >
              清除筛选
            </button>
          </div>
          <div style={{ marginTop: 8, maxHeight: 340, overflow: 'auto', border: '1px solid #333', borderRadius: 8, padding: 10 }}>
            {traceNightChainView ? nightMediationChains.map((chain) => {
              const p = chain.player;
              const s = chain.storyteller;
              return (
                <article key={chain.key} style={{ marginBottom: 12, padding: 10, border: '1px solid #2f2f2f', borderRadius: 8, background: '#161616' }}>
                  <div style={{ fontSize: 13 }}>
                    <strong>夜晚中转链路</strong>
                    <span className="muted" style={{ marginLeft: 8 }}>
                      [{chain.phase}] · seat #{typeof chain.seatIndex === 'number' ? chain.seatIndex + 1 : '?'} · step {chain.stepId ?? 'unknown'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
                    {[{ label: '玩家模型建议', entry: p }, { label: '上帝模型裁定', entry: s }].map(({ label, entry }) => {
                      const style = entry ? getTraceStatusStyle(entry.status) : null;
                      return (
                        <div key={label} style={{ border: '1px solid #333', borderRadius: 8, padding: 8, background: '#121212' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <strong style={{ fontSize: 12 }}>{label}</strong>
                            {entry && style && (
                              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: style.bg, color: style.color }}>
                                {style.label}
                              </span>
                            )}
                          </div>
                          {!entry && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>当前筛选条件下无记录</div>}
                          {entry && (
                            <>
                              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                {new Date(entry.at).toLocaleTimeString()}
                                {' · '}
                                model: {entry.model}
                                {typeof entry.elapsedMs === 'number' ? ` · ${entry.elapsedMs}ms` : ''}
                              </div>
                              {entry.behavior && <div style={{ marginTop: 6, fontSize: 12 }}>behavior: {entry.behavior}</div>}
                              {entry.response && (
                                <details style={{ marginTop: 6 }}>
                                  <summary style={{ cursor: 'pointer', fontSize: 12 }}>output（模型原始回复）</summary>
                                  <pre style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45 }}>
                                    {toReadableJsonOrText(entry.response).text}
                                  </pre>
                                </details>
                              )}
                              {entry.error && <div style={{ marginTop: 6, fontSize: 12, color: '#ff9fa8' }}>error: {entry.error}</div>}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            }) : [...filteredAiTraceEntries].reverse().map((e) => {
              const statusStyle = getTraceStatusStyle(e.status);
              return (
                <article key={e.id} style={{ marginBottom: 12, padding: 10, border: '1px solid #2f2f2f', borderRadius: 8, background: '#161616' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 13 }}>
                      <strong>
                        {e.stage === 'day_plan'
                          ? '白天计划'
                          : e.stage === 'night_action'
                            ? '夜晚行动'
                            : '说书人裁量'}
                      </strong>
                      <span className="muted" style={{ marginLeft: 8 }}>[{e.phase}] · {new Date(e.at).toLocaleTimeString()}</span>
                    </div>
                    <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: statusStyle.bg, color: statusStyle.color }}>
                      {statusStyle.label}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    actor: {e.actor === 'player' ? 'AI 玩家' : 'AI 说书人'}
                    {e.seatIndex != null ? ` · seat #${e.seatIndex + 1}` : ''}
                    {e.stepId ? ` · step ${e.stepId}` : ''}
                    {' · '}
                    model: {e.model}
                    {typeof e.elapsedMs === 'number' ? ` · ${e.elapsedMs}ms` : ''}
                  </div>
                  {e.request && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12 }}>input（完整 prompt）</summary>
                      <pre style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45 }}>
                        {toReadableJsonOrText(e.request).text}
                      </pre>
                    </details>
                  )}
                  {e.response && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12 }}>output（模型原始回复）</summary>
                      <pre style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.45 }}>
                        {toReadableJsonOrText(e.response).text}
                      </pre>
                    </details>
                  )}
                  {e.behavior && <div style={{ marginTop: 8, fontSize: 12 }}>behavior: {e.behavior}</div>}
                  {e.error && <div style={{ marginTop: 8, fontSize: 12, color: '#ff9fa8' }}>error: {e.error}</div>}
                </article>
              );
            })}
          </div>
          {room.status === 'ended' && (
            <section style={{ marginTop: 10, borderTop: '1px solid #2a2a2a', paddingTop: 10 }}>
              <h4 style={{ margin: '0 0 8px 0' }}>终局复盘问上帝（手动提问）</h4>
              <p className="muted" style={{ marginTop: 4 }}>
                仅在对局结束后可用。上帝会基于真实身份与完整对局记录回答你的问题。
              </p>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <input
                  style={{ ...unifiedInputStyle, marginLeft: 0, flex: 1, minWidth: 220 }}
                  placeholder="例如：为什么图书管理员信息与最终身份不一致？"
                  value={postGameGodQuestion}
                  onChange={(e) => setPostGameGodQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') askPostGameGod();
                  }}
                  disabled={postGameGodAsking || wsStatus !== 'open'}
                />
                <button type="button" onClick={askPostGameGod} disabled={postGameGodAsking || wsStatus !== 'open' || room.status !== 'ended'}>
                  {postGameGodAsking ? '提问中...' : '提问上帝'}
                </button>
              </div>
              {postGameGodQaList.length > 0 && (
                <div style={{ marginTop: 8, maxHeight: 220, overflow: 'auto', border: '1px solid #333', borderRadius: 8, padding: 8 }}>
                  {[...postGameGodQaList].reverse().map((qa, idx) => (
                    <article key={`${qa.at}-${idx}`} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px dashed #333' }}>
                      <div style={{ fontSize: 12, color: '#b7b7b7' }}>
                        {new Date(qa.at).toLocaleTimeString()}
                      </div>
                      <div style={{ marginTop: 4, fontSize: 13 }}><strong>问：</strong>{qa.question}</div>
                      <div style={{ marginTop: 4, fontSize: 13, whiteSpace: 'pre-wrap' }}><strong>答：</strong>{qa.answer}</div>
                    </article>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 14, borderTop: '1px dashed #333', paddingTop: 10 }}>
                <h4 style={{ margin: '0 0 8px 0' }}>终局复盘问玩家（手动提问）</h4>
                <p className="muted" style={{ marginTop: 4 }}>
                  你可以选择任意玩家，追问其策略动机（例如“你为什么提名你的恶魔队友？”）。
                </p>
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <label className="muted">
                    目标玩家：
                    <select
                      style={unifiedSelectStyle}
                      value={postGamePlayerTargetSeat ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPostGamePlayerTargetSeat(v === '' ? null : Number(v));
                      }}
                      disabled={postGamePlayerAsking || room.status !== 'ended'}
                    >
                      <option value="">请选择</option>
                      {room.players.map((p) => (
                        <option key={p.id} value={p.seatIndex}>
                          #{p.seatIndex + 1} {p.nickname}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    style={{ ...unifiedInputStyle, marginLeft: 0, flex: 1, minWidth: 220 }}
                    placeholder="例如：你为什么白天提名 #3？"
                    value={postGamePlayerQuestion}
                    onChange={(e) => setPostGamePlayerQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') askPostGamePlayer();
                    }}
                    disabled={postGamePlayerAsking || wsStatus !== 'open'}
                  />
                  <button
                    type="button"
                    onClick={askPostGamePlayer}
                    disabled={postGamePlayerAsking || wsStatus !== 'open' || room.status !== 'ended' || !Number.isInteger(postGamePlayerTargetSeat)}
                  >
                    {postGamePlayerAsking ? '提问中...' : '提问玩家'}
                  </button>
                </div>
                {postGamePlayerQaList.length > 0 && (
                  <div style={{ marginTop: 8, maxHeight: 220, overflow: 'auto', border: '1px solid #333', borderRadius: 8, padding: 8 }}>
                    {[...postGamePlayerQaList].reverse().map((qa, idx) => (
                      <article key={`${qa.at}-${idx}`} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px dashed #333' }}>
                        <div style={{ fontSize: 12, color: '#b7b7b7' }}>
                          {new Date(qa.at).toLocaleTimeString()} · 玩家 #{qa.targetSeatIndex + 1}
                        </div>
                        <div style={{ marginTop: 4, fontSize: 13 }}><strong>问：</strong>{qa.question}</div>
                        <div style={{ marginTop: 4, fontSize: 13, whiteSpace: 'pre-wrap' }}><strong>答：</strong>{qa.answer}</div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
        )}
      </section>

      {room.status === 'lobby' && (
        <section className="card" style={{ marginTop: 16 }}>
          <h3>大厅准备阶段</h3>
          <button
            className={effectiveReady ? '' : 'btn-primary'}
            type="button"
            onClick={() => {
              const next = !effectiveReady;
              setOptimisticReady(next);
              send({ type: 'ready', ready: next });
            }}
            disabled={wsStatus !== 'open'}
          >
            {effectiveReady ? '已准备（点击取消）' : '准备'}
          </button>
          <span style={{ marginLeft: 8 }} className="muted">你的状态：{effectiveReady ? '已准备' : '未准备'}</span>
          {canStart && <button className="btn-primary" type="button" onClick={() => send({ type: 'start' })} style={{ marginLeft: 8 }}>开始游戏</button>}
          {hostSecret && <span style={{ marginLeft: 8 }} className="muted">（你是房主，可控制进度）</span>}
        </section>
      )}

      {room.status === 'playing' && (
        <>
          <section className="card" style={{ marginTop: 16 }}>
            <h3>AI 托管</h3>
            <p className="muted" style={{ marginTop: 6 }}>
              你可以让 AI 代你理解信息、聊天、提名与投票（每个座位独立通道，不共享私密信息）。
            </p>
            <button
              type="button"
              className={room.aiPlayerEnabled ? 'btn-danger' : 'btn-primary'}
              disabled={wsStatus !== 'open'}
              onClick={() => send({ type: 'toggle_ai_player', enabled: !room.aiPlayerEnabled })}
            >
              {room.aiPlayerEnabled ? '关闭 AI 托管' : '开启 AI 托管'}
            </button>
            {room.aiPlayerEnabled ? <span className="pill status-ok" style={{ marginLeft: 8 }}>已托管</span> : <span className="pill status-warn" style={{ marginLeft: 8 }}>手动</span>}
            <div style={{ marginTop: 10 }}>
              <span className="muted">行为方式：</span>
              <select
                value={String(room.aiPlayerBehaviorStyle ?? '')}
                onChange={(e) => send({ type: 'set_ai_player_behavior_style', style: e.target.value })}
                disabled={wsStatus !== 'open' || !room.aiPlayerEnabled}
                style={{ ...unifiedSelectStyle, marginLeft: 8 }}
              >
                <option value="">（随机/未分配）</option>
                <option value="analytical">理性推理型</option>
                <option value="skeptical">质询怀疑型</option>
                <option value="cautious">谨慎保守型</option>
                <option value="empathetic">共情拉票型</option>
                <option value="deceptive">圆滑误导型</option>
                <option value="chaotic">反常规搅局型</option>
              </select>
              <span className="pill status-warn" style={{ marginLeft: 8 }}>
                当前：{behaviorStyleZh(room.aiPlayerBehaviorStyle)}
              </span>
            </div>
          </section>

          <section className="card" style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>公共大屏（公开信息）</h3>
              <label className="muted">
                展示模式：
                <select
                  style={unifiedSelectStyle}
                  value={publicBoardMode}
                  onChange={(e) => setPublicBoardMode(e.target.value as 'compact' | 'detailed')}
                >
                  <option value="compact">精简（仅公开发言+阶段提示）</option>
                  <option value="detailed">详细（完整事件）</option>
                </select>
              </label>
            </div>
            <p className="muted">
              存活 {room.players.filter((p) => p.isAlive).length}/{room.players.length} · 待处决：{room.pendingExecution != null ? `#${room.pendingExecution + 1}` : '无'}
            </p>
            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
              {visiblePublicLog.map((e) => (
                <li key={`${e.seq}-${e.at}`}>{e.line}</li>
              ))}
              {visiblePublicLog.length === 0 && <li className="muted">（暂无符合当前模式的公开事件）</li>}
            </ol>
          </section>

          {nightLog.length > 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <h3>夜间信息</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {nightLog.map((t, i) => (
                  <li key={`${i}-${t.slice(0, 12)}`}>{t}</li>
                ))}
              </ul>
            </section>
          )}
          {nightPrompt && (
            <section className="card" style={{ marginTop: 16 }}>
              <h3>
                夜晚行动：{yourRole?.characterId === nightPrompt.stepId ? `${yourRole.characterNameZh}（${yourRole.characterName}）` : nightPrompt.stepId}
              </h3>
              {isMyNightTurn && yourRole?.characterId === nightPrompt.stepId && (
                <p style={{ marginTop: 6, opacity: 0.9, lineHeight: 1.55 }}>{yourRole.ability}</p>
              )}
              {isMyNightTurn ? (
                <>
                  <p>轮到你行动。请选择 {nightPrompt.pick} 名存活玩家。</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {room.players
                      .filter((p) => p.isAlive)
                      .map((p) => {
                        const selected = nightTargets.includes(p.seatIndex);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setNightTargets((prev) => {
                                if (prev.includes(p.seatIndex)) return prev.filter((x) => x !== p.seatIndex);
                                if (nightPrompt.pick === 1) return [p.seatIndex];
                                if (prev.length >= 2) return prev;
                                return [...prev, p.seatIndex];
                              });
                            }}
                            style={{ outline: selected ? '2px solid #8f8' : 'none' }}
                          >
                            #{p.seatIndex + 1} {p.nickname}{selected ? ' ✓' : ''}
                          </button>
                        );
                      })}
                  </div>
                  <button
                    type="button"
                    disabled={wsStatus !== 'open' || nightTargets.length !== nightPrompt.pick}
                    onClick={() => {
                      send({ type: 'night_action', targets: nightTargets });
                    }}
                    style={{ marginTop: 12 }}
                  >
                    确认行动
                  </button>
                </>
              ) : (
                <p>说书人正在与 #{(nightPrompt.actorSeatIndex ?? 0) + 1} 号玩家交互中…</p>
              )}
            </section>
          )}
          {(inNight || room.phase === 'day') && (
            <section className="card" style={{ marginTop: 16 }}>
              <h3>对话</h3>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className={chatScope === 'all' ? 'btn-primary' : ''} onClick={() => setChatScope('all')}>
                  全部
                </button>
                <button type="button" className={chatScope === 'god' ? 'btn-primary' : ''} onClick={() => setChatScope('god')}>
                  上帝
                </button>
                <button type="button" className={chatScope === 'public' ? 'btn-primary' : ''} onClick={() => setChatScope('public')}>
                  公开屏幕
                </button>
                <button type="button" className={chatScope === 'dm' ? 'btn-primary' : ''} onClick={() => setChatScope('dm')}>
                  私聊
                </button>
                {chatScope === 'dm' && (
                  <span className="muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    对话：
                    {dmTabs.length === 0 ? (
                      <span className="muted">（暂无私聊）</span>
                    ) : (
                      dmTabs.map((s) => {
                        const active = chatDmTarget === s;
                        const nick = room.players[s]?.nickname ?? `#${s + 1}`;
                        return (
                          <button
                            key={`dm-tab-${s}`}
                            type="button"
                            className={active ? 'btn-primary' : ''}
                            onClick={() => setChatDmTarget(s)}
                          >
                            #{s + 1} {nick}
                          </button>
                        );
                      })
                    )}
                    <span className="muted" style={{ marginLeft: 6 }}>
                      新建：
                      <select
                        value=""
                        onChange={(e) => {
                          const v = e.target.value ? parseInt(e.target.value, 10) : null;
                          if (v == null) return;
                          setChatDmTarget(v);
                        }}
                        style={{ marginLeft: 6 }}
                      >
                        <option value="">选择玩家</option>
                        {room.players
                          .filter((p) => p.seatIndex !== yourSeatIndex)
                          .map((p) => (
                            <option key={`dm-opt-${p.id}`} value={p.seatIndex}>
                              #{p.seatIndex + 1} {p.nickname}
                            </option>
                          ))}
                      </select>
                    </span>
                  </span>
                )}
              </div>

              <div
                ref={chatScrollRef}
                style={{ marginTop: 10, border: '1px solid #333', borderRadius: 8, padding: 10, maxHeight: 220, overflow: 'auto' }}
              >
                {visibleChat.length === 0 ? (
                  <div className="muted">（暂无对话）</div>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                    {visibleChat.map((e) => (
                      <li key={e.id}>
                        <span className="muted">
                          [{e.scope}]
                          {' '}
                          #{(e.fromSeat ?? 0) + 1}
                          {e.scope === 'dm' && typeof e.toSeat === 'number'
                            ? ` → #${e.toSeat + 1}`
                            : e.scope === 'god'
                              ? '（上帝）'
                              : ''}
                          ：
                        </span>{' '}
                        {e.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter 发送；Shift+Enter 交给浏览器（此处是单行 input）
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      trySendChat();
                    }
                  }}
                  placeholder={chatScope === 'god' ? '对上帝说…（例如：今晚信息）' : chatScope === 'public' ? '公开发言…' : '私聊内容…'}
                  style={{ flex: '1 1 240px', minWidth: 200 }}
                />
                <button
                  type="button"
                  disabled={!canSend
                    || !chatText.trim()
                    || chatSending
                    || (chatScope === 'dm' && chatDmTarget == null)
                    || (chatScope === 'god' && !inNight)
                  }
                  onClick={trySendChat}
                >
                  {chatSending ? '发送中…' : '发送'}
                </button>
              </div>
            </section>
          )}

          {inNight && (awaitingNightInfoConfirm || awaitingNightConfirm) && (
            <section className="card" style={{ marginTop: 16 }}>
              <h3>{awaitingNightInfoConfirm ? '夜间信息确认' : '夜晚结束确认'}</h3>
              <p className="muted" style={{ marginTop: 6 }}>
                {awaitingNightInfoConfirm
                  ? `收到夜间信息的玩家需先确认，才会继续夜晚流程。当前已确认：${nightInfoConfirmedSeats.length}/${pendingNightInfoConfirmSeats.length}`
                  : `所有玩家都需要手动确认夜晚结束后，才会进入白天。当前已确认：${nightConfirmedSeats.length}/${room.players.length}`}
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(awaitingNightInfoConfirm
                  ? room.players.filter((p) => pendingNightInfoConfirmSeats.includes(p.seatIndex))
                  : room.players).map((p) => {
                  const ok = awaitingNightInfoConfirm
                    ? nightInfoConfirmedSeats.includes(p.seatIndex)
                    : nightConfirmedSeats.includes(p.seatIndex);
                  return (
                    <span key={`confirm-seat-${p.id}`} className={`pill ${ok ? 'status-ok' : 'status-warn'}`}>
                      #{p.seatIndex + 1} {p.nickname} {ok ? '✓' : '…'}
                    </span>
                  );
                })}
              </div>
              <button type="button" style={{ marginTop: 10 }} onClick={() => send({ type: 'night_confirm' })} disabled={wsStatus !== 'open'}>
                {awaitingNightInfoConfirm ? '我已阅读夜间信息（确认）' : '我已完成夜晚活动（确认）'}
              </button>
            </section>
          )}
          {room.lastNightDeaths?.length > 0 && (
            <p style={{ color: '#f88' }}>昨夜死亡：{room.lastNightDeaths.map((s) => `#${s + 1}`).join('、')}</p>
          )}
          {room.lastNightRevivals?.length > 0 && (
            <p style={{ color: '#8f8' }}>昨夜复活：{room.lastNightRevivals.map((s) => `#${s + 1}`).join('、')}</p>
          )}
          {(yourRole || characterId) && (
            <section className="card" style={{ marginTop: 16 }}>
              <h3>你的角色</h3>
              {yourRole ? (
                <>
                  <p style={{ margin: '0 0 6px' }}>
                    <strong>{yourRole.characterNameZh}</strong>
                    <span className="muted" style={{ marginLeft: 8 }}>{yourRole.characterName}</span>
                  </p>
                  <p style={{ margin: 0, lineHeight: 1.55 }}>{yourRole.ability}</p>
                  <p className="muted" style={{ margin: '10px 0 0', fontSize: 12 }}>角色 id：{yourRole.characterId}</p>
                </>
              ) : (
                <p style={{ margin: 0 }}>
                  你的身份：<strong>{characterId}</strong>（等待完整角色信息…）
                </p>
              )}
            </section>
          )}

          <section className="card" style={{ marginTop: 16 }}>
            <h3>玩家</h3>
            <ul className="list-reset">
              {room.players.map((p) => (
                <li key={p.id} style={{ opacity: p.isAlive ? 1 : 0.5, marginBottom: 8 }}>
                  #{p.seatIndex + 1} {p.nickname} {p.isReady && room.status === 'lobby' && '✓'} {!p.isAlive && '(已死亡)'}
                </li>
              ))}
            </ul>
          </section>

          {room.phase === 'day' && (
            <section className="card" style={{ marginTop: 16 }}>
              <h3>白天</h3>
              {you?.isAlive && (
                <section className="card" style={{ marginTop: 12 }}>
                  <h4 style={{ margin: '0 0 10px' }}>白天主动技能（所有玩家都可宣称发动）</h4>
                  <p style={{ margin: '0 0 10px', opacity: 0.85, lineHeight: 1.5 }}>
                    例如：你可以宣称自己是「杀手」并开枪。若你真实拥有该能力且条件满足，效果才会生效；否则将“无事发生”（但复盘会记录你的宣称）。
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <span style={{ opacity: 0.9 }}>杀手开枪目标：</span>
                    {room.players.filter((p) => p.isAlive).map((p) => (
                      <button
                        key={`slayer-target-${p.id}`}
                        type="button"
                        onClick={() => setSlayerTarget(p.seatIndex)}
                        style={{ outline: slayerTarget === p.seatIndex ? '2px solid #9cf' : 'none' }}
                      >
                        #{p.seatIndex + 1} {p.nickname}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={wsStatus !== 'open' || slayerTarget == null}
                      onClick={() => send({ type: 'day_action', actionId: 'slayer_shot', targetSeat: slayerTarget })}
                    >
                      宣称发动：杀手开枪
                    </button>
                  </div>
                </section>
              )}
              {room.daySubPhase === 'nomination' && room.currentNomination === null && you?.isAlive && (
                <div>
                  提名一名玩家（可提名自己）：
                  {room.players.filter((p) => p.isAlive).map((p) => (
                    <button key={p.id} type="button" onClick={() => send({ type: 'nominate', nominatedSeat: p.seatIndex })} style={{ marginRight: 8 }}>
                      #{p.seatIndex + 1} {p.nickname}{p.seatIndex === yourSeatIndex ? '（我）' : ''}
                    </button>
                  ))}
                  <div style={{ marginTop: 10 }}>
                    <button type="button" onClick={() => send({ type: 'skip_nomination' })}>本轮不提名</button>
                    <span className="muted" style={{ marginLeft: 8 }}>（所有存活玩家都需完成“提名/不提名”，白天才会结束）</span>
                  </div>
                </div>
              )}
              {room.currentNomination && (
                <p>
                  当前提名：#{room.currentNomination.nominator + 1} 提名 #{room.currentNomination.nominated + 1}
                  {(you?.isAlive || you?.hasDeadVote) && (
                    <>
                      <span style={{ marginLeft: 8, opacity: 0.85, fontSize: 13 }}>
                        被提名者也可投票（含投给自己）。死亡玩家可用一次“死人票”（用掉就不能改票/不能再投）。
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setMyVoteChoice(true);
                          send({ type: 'vote', inFavor: true });
                        }}
                        style={{ marginLeft: 8 }}
                      >
                        {myVoteChoice === true ? (you?.isAlive ? '已赞成（可改投）' : '已赞成（死人票已用）') : '投票赞成'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMyVoteChoice(false);
                          send({ type: 'vote', inFavor: false });
                        }}
                      >
                        {myVoteChoice === false ? (you?.isAlive ? '已反对（可改投）' : '已反对（死人票已用）') : '投票反对'}
                      </button>
                      {myVoteChoice !== null && (
                        <span className={`pill ${myVoteChoice ? 'status-ok' : 'status-warn'}`} style={{ marginLeft: 8 }}>
                          你的投票：{myVoteChoice ? '已赞成' : '已反对'}
                        </span>
                      )}
                    </>
                  )}
                </p>
              )}
              {room.pendingExecution != null && (
                <p>
                  待处决（仅标记，白天结束后才会统一结算）：#{room.pendingExecution + 1} {room.players[room.pendingExecution]?.nickname}
                  {room.pendingExecutionVotesFor ? <span className="muted" style={{ marginLeft: 8 }}>最高赞成票：{room.pendingExecutionVotesFor}</span> : null}
                </p>
              )}
              {room.pendingExecution == null && room.pendingExecutionTied && (
                <p className="muted">当前出现“最高票平局”，若后续不再出现更高票，本日将无人被处决。</p>
              )}
            </section>
          )}
        </>
      )}

      {room.status === 'ended' && (
        <section className="card" style={{ marginTop: 16 }}>
          <h3>对话（终局回溯）</h3>
          <p className="muted" style={{ marginTop: 6 }}>
            对局结束后保留聊天记录，便于回溯公聊、上帝私聊与玩家私聊全过程。
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className={chatScope === 'all' ? 'btn-primary' : ''} onClick={() => setChatScope('all')}>
              全部
            </button>
            <button type="button" className={chatScope === 'god' ? 'btn-primary' : ''} onClick={() => setChatScope('god')}>
              上帝
            </button>
            <button type="button" className={chatScope === 'public' ? 'btn-primary' : ''} onClick={() => setChatScope('public')}>
              公开屏幕
            </button>
            <button type="button" className={chatScope === 'dm' ? 'btn-primary' : ''} onClick={() => setChatScope('dm')}>
              私聊
            </button>
            {chatScope === 'dm' && (
              <span className="muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                对话：
                {dmTabs.length === 0 ? (
                  <span className="muted">（暂无私聊）</span>
                ) : (
                  dmTabs.map((s) => {
                    const active = chatDmTarget === s;
                    const nick = room.players[s]?.nickname ?? `#${s + 1}`;
                    return (
                      <button
                        key={`ended-dm-tab-${s}`}
                        type="button"
                        className={active ? 'btn-primary' : ''}
                        onClick={() => setChatDmTarget(s)}
                      >
                        #{s + 1} {nick}
                      </button>
                    );
                  })
                )}
                <span className="muted" style={{ marginLeft: 6 }}>
                  选择：
                  <select
                    value={chatDmTarget ?? ''}
                    onChange={(e) => {
                      const v = e.target.value ? parseInt(e.target.value, 10) : null;
                      setChatDmTarget(v);
                    }}
                    style={{ marginLeft: 6 }}
                  >
                    <option value="">选择玩家</option>
                    {room.players
                      .filter((p) => p.seatIndex !== yourSeatIndex)
                      .map((p) => (
                        <option key={`ended-dm-opt-${p.id}`} value={p.seatIndex}>
                          #{p.seatIndex + 1} {p.nickname}
                        </option>
                      ))}
                  </select>
                </span>
              </span>
            )}
          </div>
          <div
            ref={chatScrollRef}
            style={{ marginTop: 10, border: '1px solid #333', borderRadius: 8, padding: 10, maxHeight: 260, overflow: 'auto' }}
          >
            {visibleChat.length === 0 ? (
              <div className="muted">（暂无对话）</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                {visibleChat.map((e) => (
                  <li key={e.id}>
                    <span className="muted">
                      [{e.scope}] #{(e.fromSeat ?? 0) + 1}
                      {e.scope === 'dm' && typeof e.toSeat === 'number'
                        ? ` → #${e.toSeat + 1}`
                        : e.scope === 'god'
                          ? '（上帝）'
                          : ''}
                      ：
                    </span>{' '}
                    {e.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {room.status === 'ended' && (
        <section className="card" style={{ marginTop: 16 }}>
          <h3>下一局准备</h3>
          <p className="muted">对局结束后无需离开房间，所有玩家可直接准备并开启新一局。</p>
          <button
            className={effectiveReady ? '' : 'btn-primary'}
            type="button"
            onClick={() => {
              const next = !effectiveReady;
              setOptimisticReady(next);
              send({ type: 'ready', ready: next });
            }}
            disabled={wsStatus !== 'open'}
          >
            {effectiveReady ? '已准备（点击取消）' : '准备下一局'}
          </button>
          <span style={{ marginLeft: 8 }} className="muted">你的状态：{effectiveReady ? '已准备' : '未准备'}</span>
        </section>
      )}

      {room.status === 'ended' && endedReplay && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ marginBottom: 8 }}>对局复盘</h2>
          <p style={{ marginTop: 8, fontSize: '1.05rem' }}>
            结果：<strong>{endedReplay.winnerZh}</strong> 获胜
          </p>
          {yourRole && (
            <aside className="card" style={{ marginTop: 14 }}>
              <strong>你本局角色：</strong>
              {yourRole.characterNameZh}（{yourRole.characterName}）— {yourRole.ability}
            </aside>
          )}

          <h3 style={{ marginTop: 20, marginBottom: 8 }}>全员真实身份</h3>
          <div
            style={{
              marginTop: 8,
              border: '1px solid #444',
              borderRadius: 8,
              overflow: 'hidden',
              fontSize: 14,
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#222', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>座位</th>
                  <th style={{ padding: 8 }}>昵称</th>
                  <th style={{ padding: 8 }}>角色（中 / En）</th>
                  <th style={{ padding: 8 }}>能力</th>
                  <th style={{ padding: 8 }}>阵营</th>
                  <th style={{ padding: 8 }}>终局</th>
                </tr>
              </thead>
              <tbody>
                {[...endedReplay.identities]
                  .sort((a, b) => a.seatIndex - b.seatIndex)
                  .map((id) => (
                    <tr key={id.seatIndex} style={{ borderTop: '1px solid #333' }}>
                      <td style={{ padding: 8 }}>#{id.seatIndex + 1}</td>
                      <td style={{ padding: 8 }}>{id.nickname}</td>
                      <td style={{ padding: 8 }}>
                        {id.characterZh || id.characterId || '?'}
                        {id.characterName ? (
                          <span style={{ display: 'block', fontSize: 12, opacity: 0.8 }}>{id.characterName}</span>
                        ) : null}
                      </td>
                      <td style={{ padding: 8, fontSize: 13, lineHeight: 1.4, maxWidth: 280 }}>{id.ability || '—'}</td>
                      <td style={{ padding: 8 }}>
                        {id.alignment === 'evil' ? '邪恶' : id.alignment === 'good' ? '善良' : id.alignment}
                      </td>
                      <td style={{ padding: 8 }}>{id.survived ? '存活' : '已死亡'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <h3 style={{ marginTop: 24 }}>时间线（按阶段）</h3>
          <p style={{ opacity: 0.85, fontSize: 13, marginTop: 4 }}>
            下列条目按对局顺序记录白天、夜晚与私密信息（若有），便于复盘。
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
            {replaySections.map((sec) => (
              <article
                key={sec.groupKey}
                style={{
                  border: '1px solid #333',
                  borderRadius: 8,
                  padding: '12px 14px',
                  background: '#141414',
                }}
              >
                <h4 style={{ margin: '0 0 10px', fontSize: 16, color: '#9cf' }}>{sec.title}</h4>
                <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.55 }}>
                  {sec.lines.map((line, i) => (
                    <li key={`${sec.groupKey}-${i}`}>{line}</li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        </section>
      )}

      {room.status === 'ended' && !endedReplay && (
        <p style={{ marginTop: 16 }}>游戏已结束，但未收到复盘数据（请刷新后重连或检查后端版本）。</p>
      )}
    </div>
  );
}
