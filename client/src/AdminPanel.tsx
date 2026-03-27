import { useEffect, useRef, useState } from 'react';
import type { RoomView } from './types';

const BACKEND_PORT = import.meta.env.DEV ? '3001' : (location.port || '');
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}${BACKEND_PORT ? `:${BACKEND_PORT}` : ''}`;

interface AdminPanelProps {
  roomId: string;
  hostSecret: string;
  onLeave: () => void;
}

export function AdminPanel({ roomId, hostSecret, onLeave }: AdminPanelProps) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [lastError, setLastError] = useState('');
  const [isHost, setIsHost] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

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

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>管理员控制台</h1>
        <button type="button" onClick={onLeave}>退出管理员页</button>
      </div>
      <p>
        房间：<code>{roomId}</code> · 连接：{wsStatus} · 房主权限：{isHost ? '是' : '否'}
        {lastError ? ` · 错误：${lastError}` : ''}
      </p>

      <section style={{ marginTop: 14, padding: 12, border: '1px solid #333', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>流程控制</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => send({ type: 'start' })}>开始游戏</button>
          <button type="button" onClick={() => send({ type: 'next_phase' })}>进入提名阶段</button>
          <button type="button" onClick={() => send({ type: 'end_nomination' })}>结束提名阶段</button>
          <button type="button" onClick={() => send({ type: 'cancel_current_nomination' })}>取消本次提名</button>
          <button type="button" onClick={() => send({ type: 'end_voting' })}>结束投票</button>
          <button type="button" onClick={() => send({ type: 'execute' })}>执行处决</button>
        </div>
      </section>

      <section style={{ marginTop: 14, padding: 12, border: '1px solid #333', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>实时公开大屏</h3>
        <p style={{ marginTop: 0, opacity: 0.85 }}>
          阶段：{room ? `${room.phase} / daySubPhase=${room.daySubPhase ?? 'null'}` : '未收到房间状态'}
        </p>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.55 }}>
          {(room?.publicLog ?? []).slice(-40).map((e) => (
            <li key={`${e.seq}-${e.at}`}>{e.line}</li>
          ))}
          {(room?.publicLog ?? []).length === 0 && <li style={{ opacity: 0.6 }}>（暂无公开事件）</li>}
        </ol>
      </section>
    </div>
  );
}

