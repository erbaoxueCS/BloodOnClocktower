import { useEffect, useRef, useState } from 'react';
import type { RoomView } from './types';

// HTTP 走 Vite 代理 /api
// 开发环境：前端端口可能是 5173/5174/...，但后端固定 3001
const BACKEND_PORT = import.meta.env.DEV ? '3001' : (location.port || '');
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}${BACKEND_PORT ? `:${BACKEND_PORT}` : ''}`;

interface GameProps {
  roomId: string;
  room: RoomView;
  yourSeatIndex: number;
  yourCharacterId: string | null;
  onLeave: () => void;
  onRoomUpdate: (room: RoomView) => void;
}

export function Game({ roomId, room: initialRoom, yourSeatIndex, yourCharacterId: initialChar, onLeave, onRoomUpdate }: GameProps) {
  const [room, setRoom] = useState<RoomView>(initialRoom);
  const [characterId, setCharacterId] = useState<string | null>(initialChar);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [lastSendError, setLastSendError] = useState<string>('');
  const [optimisticReady, setOptimisticReady] = useState<boolean | null>(null);
  const [nightPrompt, setNightPrompt] = useState<null | { stepId: string; actorSeatIndex: number; pick: 1 | 2; aliveSeatIndices: number[] }>(null);
  const [nightTargets, setNightTargets] = useState<number[]>([]);
  const [nightLog, setNightLog] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`${WS_URL}?roomId=${roomId}&seatIndex=${yourSeatIndex}`);
    wsRef.current = ws;
    setWsStatus('connecting');
    setLastSendError('');
    setOptimisticReady(null);
    ws.onopen = () => setWsStatus('open');
    ws.onerror = () => setWsStatus('error');
    ws.onclose = () => setWsStatus('closed');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'room') {
          setRoom(msg.room);
          onRoomUpdate(msg.room);
          if (msg.yourCharacterId != null) setCharacterId(msg.yourCharacterId);
          // 一旦收到服务端状态，以服务端为准
          setOptimisticReady(null);
        } else if (msg.type === 'night_prompt') {
          setNightPrompt(msg);
          setNightTargets([]);
        } else if (msg.type === 'night_info') {
          const text = String(msg.message ?? '');
          if (text) setNightLog((prev) => [text, ...prev].slice(0, 50));
        } else if (msg.type === 'phase') {
          setRoom((r) => ({ ...r, phase: msg.phase, dayNumber: msg.dayNumber ?? r.dayNumber }));
        } else if (msg.type === 'vote_result') {
          setRoom((r) => ({ ...r, currentNomination: null }));
          // 票型公开：打印到控制台（后续可做 UI 面板）
          if (Array.isArray(msg.votes)) {
            console.log('vote_result', { passed: msg.passed, votesFor: msg.votesFor, votes: msg.votes });
          }
        } else if (msg.type === 'game_over') {
          setRoom(msg.room);
        } else if (msg.type === 'error') {
          console.error(msg.message);
          setLastSendError(String(msg.message ?? '未知错误'));
        }
      } catch (_) {}
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [roomId, yourSeatIndex]);

  const send = (payload: object) => {
    setLastSendError('');
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    } else {
      setLastSendError('未连接到后端（WebSocket 未打开）');
    }
  };

  const you = room.players[yourSeatIndex];
  const effectiveReady = optimisticReady ?? you?.isReady ?? false;
  const isHost = yourSeatIndex === 0;
  const canStart = room.status === 'lobby' && room.players.length >= room.minPlayers && room.players.every((p) => p.isReady) && isHost;
  const isMyNightTurn = nightPrompt?.actorSeatIndex === yourSeatIndex;

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1>血染钟楼 · {room.scriptNameZh}</h1>
        <button type="button" onClick={onLeave}>离开房间</button>
      </div>
      <p>房间号：<code>{room.id}</code> · 你的座位：{yourSeatIndex + 1} · {room.status === 'lobby' ? '大厅' : `第 ${room.dayNumber} 天 · ${room.phase === 'day' ? '白天' : room.phase === 'first_night' ? '首夜' : '夜晚'}`}</p>
      <p style={{ marginTop: 4, color: wsStatus === 'open' ? '#8f8' : '#f88' }}>
        连接状态：{wsStatus === 'open' ? '已连接' : wsStatus === 'connecting' ? '连接中' : wsStatus === 'closed' ? '已断开' : '错误'}
        {lastSendError ? `（${lastSendError}）` : ''}
      </p>

      {room.status === 'lobby' && (
        <div>
          <button
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
          <span style={{ marginLeft: 8, opacity: 0.85 }}>你的状态：{effectiveReady ? '已准备' : '未准备'}</span>
          {canStart && <button type="button" onClick={() => send({ type: 'start' })} style={{ marginLeft: 8 }}>开始游戏</button>}
        </div>
      )}

      {room.status === 'playing' && (
        <>
          {nightLog.length > 0 && (
            <section style={{ marginTop: 16, padding: 12, border: '1px solid #333', borderRadius: 8 }}>
              <h3>夜间信息</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {nightLog.map((t, i) => (
                  <li key={`${i}-${t.slice(0, 12)}`}>{t}</li>
                ))}
              </ul>
            </section>
          )}
          {nightPrompt && (
            <section style={{ marginTop: 16, padding: 12, border: '1px solid #333', borderRadius: 8 }}>
              <h3>夜晚行动：{nightPrompt.stepId}</h3>
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
                      setNightPrompt(null);
                      setNightTargets([]);
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
          {room.lastNightDeaths?.length > 0 && (
            <p style={{ color: '#f88' }}>昨夜死亡：{room.lastNightDeaths.map((s) => `#${s + 1}`).join('、')}</p>
          )}
          {room.lastNightRevivals?.length > 0 && (
            <p style={{ color: '#8f8' }}>昨夜复活：{room.lastNightRevivals.map((s) => `#${s + 1}`).join('、')}</p>
          )}
          {characterId && <p>你的身份：<strong>{characterId}</strong></p>}

          <section style={{ marginTop: 16 }}>
            <h3>玩家</h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {room.players.map((p) => (
                <li key={p.id} style={{ opacity: p.isAlive ? 1 : 0.5, marginBottom: 8 }}>
                  #{p.seatIndex + 1} {p.nickname} {p.isReady && room.status === 'lobby' && '✓'} {!p.isAlive && '(已死亡)'}
                </li>
              ))}
            </ul>
          </section>

          {room.phase === 'day' && (
            <section style={{ marginTop: 24 }}>
              <h3>白天</h3>
              {room.daySubPhase === 'discussion' && isHost && (
                <button type="button" onClick={() => send({ type: 'next_phase' })}>进入提名阶段</button>
              )}
              {room.daySubPhase === 'nomination' && room.currentNomination === null && you?.isAlive && (
                <div>
                  提名一名玩家：
                  {room.players.filter((p) => p.isAlive && p.seatIndex !== yourSeatIndex).map((p) => (
                    <button key={p.id} type="button" onClick={() => send({ type: 'nominate', nominatedSeat: p.seatIndex })} style={{ marginRight: 8 }}>
                      #{p.seatIndex + 1} {p.nickname}
                    </button>
                  ))}
                </div>
              )}
              {room.currentNomination && (
                <p>
                  当前提名：#{room.currentNomination.nominator + 1} 提名 #{room.currentNomination.nominated + 1}
                  {you?.isAlive && (
                    <>
                      <button type="button" onClick={() => send({ type: 'vote', inFavor: true })} style={{ marginLeft: 8 }}>投票赞成</button>
                      <button type="button" onClick={() => send({ type: 'vote', inFavor: false })}>反对</button>
                    </>
                  )}
                  {isHost && <button type="button" onClick={() => send({ type: 'end_voting' })} style={{ marginLeft: 8 }}>结束投票</button>}
                </p>
              )}
              {room.pendingExecution != null && (
                <p>
                  待处决：#{room.pendingExecution + 1} {room.players[room.pendingExecution]?.nickname}
                  {isHost && <button type="button" onClick={() => send({ type: 'execute' })} style={{ marginLeft: 8 }}>执行处决</button>}
                </p>
              )}
            </section>
          )}
        </>
      )}

      {room.status === 'ended' && (
        <p>游戏结束。完整身份请查看服务器日志或后续复盘功能。</p>
      )}
    </div>
  );
}
