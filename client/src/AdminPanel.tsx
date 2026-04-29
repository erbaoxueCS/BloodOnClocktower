import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomView } from './types';

const BACKEND_PORT = import.meta.env.DEV ? '3001' : (location.port || '');
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}${BACKEND_PORT ? `:${BACKEND_PORT}` : ''}`;

interface AdminPanelProps {
  roomId: string;
  hostSecret: string;
  onLeave: () => void;
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

type ObserverEventType = 'thought' | 'speech' | 'decision';

type ObserverEvent = {
  id: string;
  at: number;
  actorKey: string;
  actorLabel: string;
  type: ObserverEventType;
  content: string;
  source: 'ai_trace' | 'chat' | 'public' | 'global';
};

function phaseZh(phase?: string): string {
  if (phase === 'waiting') return '等待';
  if (phase === 'first_night') return '首夜';
  if (phase === 'day') return '白天';
  if (phase === 'night') return '夜晚';
  return phase ?? '未知';
}

function daySubPhaseZh(sub?: string | null): string {
  if (sub === 'discussion') return '讨论';
  if (sub === 'nomination') return '提名';
  if (sub === 'voting') return '投票';
  if (sub === 'execution') return '处决';
  if (sub == null) return '无';
  return sub;
}

function traceStageZh(stage: AiTraceEntry['stage']): string {
  if (stage === 'day_plan') return '白天计划';
  if (stage === 'day_dialogue') return '白天对话';
  if (stage === 'night_action') return '夜晚行动';
  return '说书人裁量';
}

function getTraceStatusStyle(status: AiTraceEntry['status']): { label: string; bg: string; color: string } {
  if (status === 'started') return { label: '请求中', bg: '#1f2937', color: '#cbd5e1' };
  if (status === 'responded') return { label: '已返回', bg: '#1d4ed8', color: '#dbeafe' };
  if (status === 'applied') return { label: '已执行', bg: '#065f46', color: '#d1fae5' };
  if (status === 'fallback') return { label: '兜底', bg: '#7c2d12', color: '#ffedd5' };
  return { label: '错误', bg: '#7f1d1d', color: '#fee2e2' };
}

function observerTypeZh(type: ObserverEventType): string {
  if (type === 'thought') return '想法';
  if (type === 'speech') return '发言';
  return '决策';
}

function observerTypeColor(type: ObserverEventType): string {
  if (type === 'thought') return '#8b5cf6';
  if (type === 'speech') return '#0ea5e9';
  return '#22c55e';
}

function parseSeatFromText(text: string): number | null {
  const m = text.match(/#(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n - 1;
}

export function AdminPanel({ roomId, hostSecret, onLeave }: AdminPanelProps) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [lastError, setLastError] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [copyTip, setCopyTip] = useState('');
  const [aiTraceEntries, setAiTraceEntries] = useState<AiTraceEntry[]>([]);
  const [observerPlaying, setObserverPlaying] = useState(true);
  const [observerCursor, setObserverCursor] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopyTip('已复制');
      setTimeout(() => setCopyTip(''), 1200);
    } catch {
      setCopyTip('复制失败');
      setTimeout(() => setCopyTip(''), 1500);
    }
  };

  useEffect(() => {
    const qs = new URLSearchParams({ roomId, admin: '1', hostSecret });
    const ws = new WebSocket(`${WS_URL}?${qs.toString()}`);
    wsRef.current = ws;
    setWsStatus('connecting');
    ws.onopen = () => setWsStatus('open');
    ws.onerror = () => setWsStatus('error');
    ws.onclose = () => setWsStatus('closed');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'room') {
          setRoom(msg.room);
          setIsHost(!!msg.isHost);
        } else if (msg.type === 'game_over') {
          setRoom(msg.room);
        } else if (msg.type === 'chat_event') {
          const entry = msg.entry;
          if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
            setRoom((prev) => {
              if (!prev) return prev;
              const list = Array.isArray(prev.chatLog) ? prev.chatLog : [];
              if (list.some((x) => x.id === entry.id)) return prev;
              return { ...prev, chatLog: [...list, entry].slice(-500) };
            });
          }
        } else if (msg.type === 'error') {
          setLastError(String(msg.message ?? '未知错误'));
        } else if (msg.type === 'ai_trace') {
          if (msg.entry && typeof msg.entry === 'object') {
            setAiTraceEntries((prev) => [...prev, msg.entry as AiTraceEntry].slice(-120));
          }
        }
      } catch {
        // ignore
      }
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [roomId, hostSecret]);

  const send = (payload: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setLastError('');
      wsRef.current.send(JSON.stringify(payload));
    } else {
      setLastError('管理员连接未就绪');
    }
  };
  const canSend = wsStatus === 'open';
  const observerEvents = useMemo<ObserverEvent[]>(() => {
    const events: ObserverEvent[] = [];
    for (const e of aiTraceEntries) {
      const actorKey = e.actor === 'storyteller' ? 'god' : `seat:${e.seatIndex ?? -1}`;
      const actorLabel = e.actor === 'storyteller' ? '上帝' : `玩家 #${(e.seatIndex ?? 0) + 1}`;
      if (e.response || e.behavior) {
        events.push({
          id: `thought-${e.id}-${e.updatedAt ?? e.at}`,
          at: e.updatedAt ?? e.at,
          actorKey,
          actorLabel,
          type: 'thought',
          content: (e.behavior || e.response || '').slice(0, 180) || '模型产生思考输出',
          source: 'ai_trace',
        });
      }
      if (e.status === 'applied' || e.stage === 'storyteller_decision') {
        events.push({
          id: `decision-${e.id}-${e.updatedAt ?? e.at}`,
          at: (e.updatedAt ?? e.at) + 1,
          actorKey,
          actorLabel,
          type: 'decision',
          content: e.behavior || `执行 ${traceStageZh(e.stage)}（${getTraceStatusStyle(e.status).label}）`,
          source: 'ai_trace',
        });
      }
    }
    for (const c of room?.chatLog ?? []) {
      const fromSeat = Number.isInteger(c.fromSeat) ? c.fromSeat : 0;
      events.push({
        id: `chat-${c.id}`,
        at: c.at,
        actorKey: c.scope === 'god' ? 'god' : `seat:${fromSeat}`,
        actorLabel: c.scope === 'god' ? '上帝' : `玩家 #${fromSeat + 1}`,
        type: 'speech',
        content: c.text,
        source: 'chat',
      });
    }
    for (const e of room?.publicLog ?? []) {
      const seat = parseSeatFromText(e.line);
      const isDecision = /提名|投票|处决|裁决|执行|淘汰|死亡|进入夜晚|进入白天/.test(e.line);
      events.push({
        id: `public-${e.seq}-${e.at}`,
        at: e.at,
        actorKey: seat == null ? 'god' : `seat:${seat}`,
        actorLabel: seat == null ? '上帝' : `玩家 #${seat + 1}`,
        type: isDecision ? 'decision' : 'speech',
        content: e.line,
        source: 'public',
      });
    }
    for (const e of room?.globalLog ?? []) {
      const seat = parseSeatFromText(e.line);
      if (!/提名|投票|处决|裁决|夜|行动|决定|选择/.test(e.line)) continue;
      events.push({
        id: `global-${e.groupKey}-${e.seq}`,
        at: e.at,
        actorKey: seat == null ? 'god' : `seat:${seat}`,
        actorLabel: seat == null ? '上帝' : `玩家 #${seat + 1}`,
        type: 'decision',
        content: `${e.groupTitle}：${e.line}`,
        source: 'global',
      });
    }
    return events.sort((a, b) => a.at - b.at);
  }, [aiTraceEntries, room?.chatLog, room?.globalLog, room?.publicLog]);

  useEffect(() => {
    setObserverCursor((prev) => {
      if (observerEvents.length === 0) return 0;
      return Math.min(prev, observerEvents.length - 1);
    });
  }, [observerEvents.length]);

  useEffect(() => {
    if (!observerPlaying || observerEvents.length <= 1) return;
    const timer = setInterval(() => {
      setObserverCursor((prev) => (prev + 1) % observerEvents.length);
    }, 1200);
    return () => clearInterval(timer);
  }, [observerPlaying, observerEvents.length]);

  const currentObserverEvent = observerEvents[observerCursor] ?? null;
  const observerActors = useMemo(
    () => [
      { key: 'god', label: '上帝' },
      ...(room?.players ?? []).map((p) => ({ key: `seat:${p.seatIndex}`, label: `#${p.seatIndex + 1} ${p.nickname}` })),
    ],
    [room?.players],
  );

  return (
    <div className="page">
      <div className="header">
        <div>
          <h1 className="title">管理员控制台</h1>
          <p className="subtitle">
            房间 <code className="mono">{roomId}</code>
            <button type="button" style={{ marginLeft: 8 }} onClick={copyRoomId}>复制</button>
            {copyTip && <span style={{ marginLeft: 6 }}>{copyTip}</span>}
            {' '}的流程与日志面板
          </p>
        </div>
        <button className="btn-danger" type="button" onClick={onLeave}>退出管理员页</button>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className={`pill ${wsStatus === 'open' ? 'status-ok' : 'status-danger'}`}>
          连接：{wsStatus}
        </span>
        <span className={`pill ${isHost ? 'status-ok' : 'status-warn'}`}>房主权限：{isHost ? '是' : '否'}</span>
      </div>
      {lastError && <p className="error">{lastError}</p>}

      <div className="grid">
        <section className="card col-12">
          <h3>观众动态效果图（想法 / 发言 / 决策）</h3>
          <p className="muted">
            自动播放全局时间流，实时高亮当前行为者（含上帝），用于向第三方观众展示“谁在想、谁在说、谁在决定”。
          </p>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setObserverPlaying((v) => !v)} disabled={observerEvents.length <= 1}>
              {observerPlaying ? '暂停播放' : '继续播放'}
            </button>
            <button type="button" onClick={() => setObserverCursor((v) => Math.max(0, v - 1))} disabled={observerEvents.length === 0}>
              上一步
            </button>
            <button
              type="button"
              onClick={() => setObserverCursor((v) => (observerEvents.length === 0 ? 0 : Math.min(observerEvents.length - 1, v + 1)))}
              disabled={observerEvents.length === 0}
            >
              下一步
            </button>
            <span className="pill status-warn">
              进度：{observerEvents.length === 0 ? '0/0' : `${observerCursor + 1}/${observerEvents.length}`}
            </span>
          </div>
          <div style={{ marginTop: 12, border: '1px solid #333', borderRadius: 10, padding: 12, background: '#121212' }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              {observerActors.map((actor) => {
                const active = currentObserverEvent?.actorKey === actor.key;
                return (
                  <div
                    key={actor.key}
                    style={{
                      border: active ? '1px solid #8b5cf6' : '1px solid #2f2f2f',
                      borderRadius: 10,
                      padding: '6px 10px',
                      background: active ? '#2b1f4a' : '#1a1a1a',
                      minWidth: 110,
                    }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        background: active ? '#a78bfa' : '#525252',
                        display: 'inline-block',
                        marginRight: 6,
                        animation: active ? 'pulseDot 1s ease-in-out infinite' : 'none',
                      }}
                    />
                    <span style={{ fontSize: 12 }}>{actor.label}</span>
                  </div>
                );
              })}
            </div>
            {currentObserverEvent ? (
              <div style={{ marginTop: 12, borderTop: '1px dashed #333', paddingTop: 12 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {new Date(currentObserverEvent.at).toLocaleTimeString()} · {currentObserverEvent.actorLabel} · 源 {currentObserverEvent.source}
                </div>
                <div style={{ marginTop: 8 }}>
                  <span
                    style={{
                      fontSize: 12,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: observerTypeColor(currentObserverEvent.type),
                      color: '#ffffff',
                    }}
                  >
                    {observerTypeZh(currentObserverEvent.type)}
                  </span>
                </div>
                <p style={{ marginTop: 8, lineHeight: 1.6 }}>{currentObserverEvent.content}</p>
              </div>
            ) : (
              <p className="muted" style={{ marginTop: 12 }}>暂无可播放事件。推进流程后会自动出现动态图内容。</p>
            )}
          </div>
        </section>

        <section className="card col-12">
          <h3>流程控制</h3>
          <div className="row" style={{ marginBottom: 10 }}>
            <span className={`pill ${room?.aiStorytellerEnabled ? 'status-ok' : 'status-warn'}`}>
              AI 说书人：{room?.aiStorytellerEnabled ? '已接管' : '手动'}
            </span>
            <button
              className={room?.aiStorytellerEnabled ? 'btn-danger' : 'btn-primary'}
              type="button"
              disabled={!canSend || !isHost}
              onClick={() => send({ type: 'toggle_ai_storyteller', enabled: !room?.aiStorytellerEnabled })}
            >
              {room?.aiStorytellerEnabled ? '关闭 AI 接管' : '开启 AI 接管'}
            </button>
          </div>
          <div className="row">
            <button className="btn-primary" type="button" disabled={!canSend || !isHost || room?.status !== 'lobby'} onClick={() => send({ type: 'start' })}>
              开始游戏
            </button>
            {!isHost && <span className="muted">（无房主权限，按钮已禁用）</span>}
          </div>
        </section>

        <section className="card col-6">
          <h3>夜晚确认状态</h3>
          <p className="muted">
            awaitingNightConfirm：{room?.awaitingNightConfirm ? 'true' : 'false'}
          </p>
          <p className="muted" style={{ marginTop: 4 }}>
            awaitingNightInfoConfirm：{room?.awaitingNightInfoConfirm ? 'true' : 'false'}
          </p>
          <p className="muted" style={{ marginTop: 4 }}>
            已确认：{room?.nightConfirmedSeats?.length ?? 0}/{room?.players?.length ?? 0}
          </p>
          <p className="muted" style={{ marginTop: 4 }}>
            信息确认：{room?.nightInfoConfirmedSeats?.length ?? 0}/{room?.pendingNightInfoConfirmSeats?.length ?? 0}
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(room?.players ?? []).map((p) => {
              const ok = !!room?.nightConfirmedSeats?.includes(p.seatIndex);
              return (
                <span key={`night-confirm-${p.id}`} className={`pill ${ok ? 'status-ok' : 'status-warn'}`}>
                  #{p.seatIndex + 1} {p.nickname} {ok ? '✓' : '…'}
                </span>
              );
            })}
          </div>
        </section>

        <section className="card col-6">
          <h3>聊天（管理员全量）</h3>
          <p className="muted">仅用于观察对话与卡点；玩家侧只会看到与自己相关的消息。</p>
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.55, maxHeight: 420, overflow: 'auto' }}>
            {(room?.chatLog ?? []).slice(-80).map((e) => (
              <li key={e.id}>
                <span className="muted">
                  [{e.scope}] #{(e.fromSeat ?? 0) + 1}
                  {e.scope === 'dm' && typeof e.toSeat === 'number' ? `→#${e.toSeat + 1}` : ''}
                  ：
                </span>{' '}
                {e.text}
              </li>
            ))}
            {(room?.chatLog ?? []).length === 0 && <li className="muted">（暂无聊天记录）</li>}
          </ol>
        </section>

        <section className="card col-12">
          <h3>AI 调用记录（上帝）</h3>
          <p className="muted">
            仅展示上帝/说书人自身 AI 调用，不包含玩家私有调用。
          </p>
          <p className="muted" style={{ marginTop: 4 }}>
            总计 {aiTraceEntries.length} 条
            {aiTraceEntries.length > 0 ? ` · 最近一条：${new Date(aiTraceEntries[aiTraceEntries.length - 1].at).toLocaleTimeString()}` : ' · 暂无调用记录'}
          </p>
          <div style={{ marginTop: 8, maxHeight: 340, overflow: 'auto', border: '1px solid #333', borderRadius: 8, padding: 10 }}>
            {aiTraceEntries.length === 0 ? (
              <p className="muted">还没有收到上帝 AI 调用事件。请先开启 AI 说书人并推进流程。</p>
            ) : (
              [...aiTraceEntries].reverse().slice(0, 80).map((e) => {
                const statusStyle = getTraceStatusStyle(e.status);
                return (
                  <article key={`${e.id}-${e.updatedAt ?? e.at}`} style={{ marginBottom: 12, padding: 10, border: '1px solid #2f2f2f', borderRadius: 8, background: '#161616' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 13 }}>
                        <strong>{traceStageZh(e.stage)}</strong>
                        <span className="muted" style={{ marginLeft: 8 }}>
                          [{phaseZh(e.phase)}] · {new Date(e.updatedAt ?? e.at).toLocaleTimeString()}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: statusStyle.bg, color: statusStyle.color }}>
                        {statusStyle.label}
                      </span>
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      actor: {e.actor === 'storyteller' ? 'AI 说书人' : 'AI 玩家'}
                      {e.stepId ? ` · step ${e.stepId}` : ''}
                      {' · '}
                      model: {e.model}
                      {typeof e.elapsedMs === 'number' ? ` · ${e.elapsedMs}ms` : ''}
                    </div>
                    {e.behavior && <div style={{ marginTop: 8, fontSize: 12 }}>behavior: {e.behavior}</div>}
                    {e.error && <div style={{ marginTop: 8, fontSize: 12, color: '#ff9fa8' }}>error: {e.error}</div>}
                  </article>
                );
              })
            )}
          </div>
        </section>

        <section className="card col-6">
          <h3>实时公开大屏</h3>
          <p className="muted">
            阶段：{room ? `${phaseZh(room.phase)} / ${daySubPhaseZh(room.daySubPhase)}` : '未收到房间状态'}
          </p>
          <p className="muted" style={{ marginTop: 4 }}>公开事件数：{room?.publicLog?.length ?? 0}</p>
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.55, maxHeight: 420, overflow: 'auto' }}>
            {(room?.publicLog ?? []).slice(-40).map((e) => (
              <li key={`${e.seq}-${e.at}`}>{e.line}</li>
            ))}
            {(room?.publicLog ?? []).length === 0 && <li className="muted">（暂无公开事件）</li>}
          </ol>
        </section>

        <section className="card col-6">
          <h3>全局记录（管理员）</h3>
          <p className="muted">
            含私密信息与裁定过程，仅管理员可见，用于把握全局局势。
          </p>
          <p className="muted" style={{ marginTop: 4 }}>全局记录数：{room?.globalLog?.length ?? 0}</p>
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.55, maxHeight: 420, overflow: 'auto' }}>
            {(room?.globalLog ?? []).slice(-60).map((e) => (
              <li key={`${e.groupKey}-${e.seq}-${e.at}`}>
                <span className="muted">[{e.groupTitle}] </span>
                {e.line}
              </li>
            ))}
            {(room?.globalLog ?? []).length === 0 && (
              <li className="muted">
                （暂无全局记录。通常在“开始游戏”后会写入；若已开局仍为空，请刷新管理台并重连。）
              </li>
            )}
          </ol>
        </section>
      </div>
      <style>{`
        @keyframes pulseDot {
          0% { transform: scale(1); opacity: 0.7; }
          50% { transform: scale(1.35); opacity: 1; }
          100% { transform: scale(1); opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}

