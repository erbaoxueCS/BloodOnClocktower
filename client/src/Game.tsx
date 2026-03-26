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
  const [endedReplay, setEndedReplay] = useState<ReplayBundle | null>(null);
  const [slayerTarget, setSlayerTarget] = useState<number | null>(null);
  const [isHost, setIsHost] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);

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

  useEffect(() => {
    const qs = new URLSearchParams({ roomId, seatIndex: String(yourSeatIndex) });
    if (hostSecret) qs.set('hostSecret', hostSecret);
    const ws = new WebSocket(`${WS_URL}?${qs.toString()}`);
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
          else setCharacterId(null);
          setYourRole(msg.yourRole ?? null);
          setIsHost(!!msg.isHost);
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
        } else if (msg.type === 'phase') {
          setRoom((r) => ({ ...r, phase: msg.phase, dayNumber: msg.dayNumber ?? r.dayNumber }));
          if (msg.phase === 'day' || msg.phase === 'waiting') {
            setNightPrompt(null);
            setNightTargets([]);
          }
        } else if (msg.type === 'vote_result') {
          setRoom((r) => ({ ...r, currentNomination: null }));
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
        } else if (msg.type === 'error') {
          console.error(msg.message);
          const raw = String(msg.message ?? '未知错误');
          const zh = raw.startsWith('night_action_failed:')
            ? `夜晚行动无效：${raw.replace('night_action_failed:', '')}`
            : raw;
          setLastSendError(zh);
        }
      } catch (_) {}
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [roomId, yourSeatIndex, hostSecret]);

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
  const canStart = room.status === 'lobby' && room.players.length >= room.minPlayers && room.players.every((p) => p.isReady) && isHost;
  const isMyNightTurn = nightPrompt?.actorSeatIndex === yourSeatIndex;

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1>血染钟楼 · {room.scriptNameZh}</h1>
        <button type="button" onClick={onLeave}>离开房间</button>
      </div>
      <p>
        房间号：<code>{room.id}</code> · 你的座位：{yourSeatIndex + 1} ·{' '}
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
          {hostSecret && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>（你是房主，可控制进度）</span>}
        </div>
      )}

      {room.status === 'playing' && (
        <>
          <section style={{ marginTop: 16, padding: 12, border: '1px solid #333', borderRadius: 8, background: '#111' }}>
            <h3 style={{ margin: '0 0 10px' }}>公共大屏（公开信息）</h3>
            <p style={{ margin: '0 0 8px', opacity: 0.85 }}>
              存活 {room.players.filter((p) => p.isAlive).length}/{room.players.length} · 待处决：{room.pendingExecution != null ? `#${room.pendingExecution + 1}` : '无'}
            </p>
            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
              {(room.publicLog ?? []).slice(-20).map((e) => (
                <li key={`${e.seq}-${e.at}`}>{e.line}</li>
              ))}
              {(room.publicLog ?? []).length === 0 && <li style={{ opacity: 0.65 }}>（暂无公开事件）</li>}
            </ol>
          </section>

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
          {room.lastNightDeaths?.length > 0 && (
            <p style={{ color: '#f88' }}>昨夜死亡：{room.lastNightDeaths.map((s) => `#${s + 1}`).join('、')}</p>
          )}
          {room.lastNightRevivals?.length > 0 && (
            <p style={{ color: '#8f8' }}>昨夜复活：{room.lastNightRevivals.map((s) => `#${s + 1}`).join('、')}</p>
          )}
          {(yourRole || characterId) && (
            <section
              style={{
                marginTop: 16,
                padding: 14,
                border: '1px solid #355',
                borderRadius: 8,
                background: '#121a18',
              }}
            >
              <h3 style={{ margin: '0 0 10px', fontSize: 17 }}>你的角色</h3>
              {yourRole ? (
                <>
                  <p style={{ margin: '0 0 6px', fontSize: '1.1rem' }}>
                    <strong>{yourRole.characterNameZh}</strong>
                    <span style={{ marginLeft: 8, opacity: 0.85, fontSize: '0.95rem' }}>{yourRole.characterName}</span>
                  </p>
                  <p style={{ margin: 0, lineHeight: 1.55, opacity: 0.92 }}>{yourRole.ability}</p>
                  <p style={{ margin: '10px 0 0', fontSize: 12, opacity: 0.55 }}>角色 id：{yourRole.characterId}</p>
                </>
              ) : (
                <p style={{ margin: 0 }}>
                  你的身份：<strong>{characterId}</strong>（等待完整角色信息…）
                </p>
              )}
            </section>
          )}

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
              {isHost && room.daySubPhase === 'nomination' && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => send({ type: 'end_nomination' })}>结束提名阶段</button>
                  {room.currentNomination && (
                    <button type="button" onClick={() => send({ type: 'cancel_current_nomination' })}>
                      取消本次提名
                    </button>
                  )}
                </div>
              )}
              {you?.isAlive && (
                <section style={{ marginTop: 12, padding: 12, border: '1px solid #333', borderRadius: 8 }}>
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
              {room.daySubPhase === 'discussion' && isHost && (
                <button type="button" onClick={() => send({ type: 'next_phase' })}>进入提名阶段</button>
              )}
              {room.daySubPhase === 'nomination' && room.currentNomination === null && you?.isAlive && (
                <div>
                  提名一名玩家（可提名自己）：
                  {room.players.filter((p) => p.isAlive).map((p) => (
                    <button key={p.id} type="button" onClick={() => send({ type: 'nominate', nominatedSeat: p.seatIndex })} style={{ marginRight: 8 }}>
                      #{p.seatIndex + 1} {p.nickname}{p.seatIndex === yourSeatIndex ? '（我）' : ''}
                    </button>
                  ))}
                </div>
              )}
              {room.currentNomination && (
                <p>
                  当前提名：#{room.currentNomination.nominator + 1} 提名 #{room.currentNomination.nominated + 1}
                  {you?.isAlive && (
                    <>
                      <span style={{ marginLeft: 8, opacity: 0.85, fontSize: 13 }}>
                        被提名者也可投票（含投给自己）。
                      </span>
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

      {room.status === 'ended' && endedReplay && (
        <section style={{ marginTop: 24 }}>
          <h2>对局复盘</h2>
          <p style={{ marginTop: 8, fontSize: '1.05rem' }}>
            结果：<strong>{endedReplay.winnerZh}</strong> 获胜
          </p>
          {yourRole && (
            <aside
              style={{
                marginTop: 14,
                padding: 12,
                border: '1px solid #355',
                borderRadius: 8,
                background: '#121a18',
              }}
            >
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
