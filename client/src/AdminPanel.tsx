import { useEffect, useRef, useState } from 'react';
import type { RoomView } from './types';

const BACKEND_PORT = import.meta.env.DEV ? '3001' : (location.port || '');
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}${BACKEND_PORT ? `:${BACKEND_PORT}` : ''}`;

interface AdminPanelProps {
  roomId: string;
  hostSecret: string;
  onLeave: () => void;
}

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

export function AdminPanel({ roomId, hostSecret, onLeave }: AdminPanelProps) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [lastError, setLastError] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [copyTip, setCopyTip] = useState('');
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
        } else if (msg.type === 'error') {
          setLastError(String(msg.message ?? '未知错误'));
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
            已确认：{room?.nightConfirmedSeats?.length ?? 0}/{room?.players?.length ?? 0}
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
    </div>
  );
}

