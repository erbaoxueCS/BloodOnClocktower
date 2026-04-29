import { useState } from 'react';
import type { RoomView } from './types';

const API = '/api';
const NICK_PREFIX = ['夜行', '钟声', '雾隐', '火漆', '预言', '静默', '迷踪', '秘钥', '月影', '余烬'];
const NICK_SUFFIX = ['守夜人', '提名王', '验人师', '反转侠', '沉默狼', '谜语客', '夜鸦', '推理官', '投票手', '烛火'];

function buildDefaultNickname(): string {
  const p = NICK_PREFIX[Math.floor(Math.random() * NICK_PREFIX.length)] ?? '夜行';
  const s = NICK_SUFFIX[Math.floor(Math.random() * NICK_SUFFIX.length)] ?? '守夜人';
  const n = Math.floor(Math.random() * 90) + 10;
  return `${p}${s}${n}`;
}

type Script = { id: string; name: string; nameZh: string; minPlayers: number; maxPlayers: number };

interface LobbyProps {
  onEnterRoom: (room: RoomView, seatIndex: number, characterId: string | null, roomId: string, hostSecret?: string | null) => void;
  onEnterAdmin: (roomId: string, hostSecret: string) => void;
}

export function Lobby({ onEnterRoom, onEnterAdmin }: LobbyProps) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [roomId, setRoomId] = useState('');
  const [nickname, setNickname] = useState(buildDefaultNickname);
  const [hostSecret, setHostSecret] = useState<string>('');
  const [error, setError] = useState('');
  const [copyTip, setCopyTip] = useState('');
  const [quickTip, setQuickTip] = useState('');
  const [quickJoinUrls, setQuickJoinUrls] = useState<string[]>([]);
  const [quickAdminUrl, setQuickAdminUrl] = useState<string>('');
  const [quickStarting, setQuickStarting] = useState(false);

  const copyRoomId = async () => {
    if (!roomId.trim()) return;
    try {
      await navigator.clipboard.writeText(roomId.trim());
      setCopyTip('房间号已复制');
      setTimeout(() => setCopyTip(''), 1500);
    } catch {
      setCopyTip('复制失败，请手动复制');
      setTimeout(() => setCopyTip(''), 1800);
    }
  };

  const loadScripts = async () => {
    try {
      const r = await fetch(`${API}/scripts`);
      const list = await r.json();
      setScripts(list);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createRoom = async () => {
    setError('');
    try {
      const r = await fetch(`${API}/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptId: 'trouble_brewing' }) });
      const data = await r.json();
      if (data.roomId) setRoomId(data.roomId);
      else setError(data.error || '创建失败');
      if (typeof data.hostSecret === 'string') setHostSecret(data.hostSecret);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const devQuickStart = async () => {
    setError('');
    setQuickTip('正在创建并开局（如无反应请看下方错误/链接）…');
    setQuickJoinUrls([]);
    setQuickAdminUrl('');
    setQuickStarting(true);
    const timeoutId = window.setTimeout(() => {
      setQuickTip('请求超时：可能是后端未响应或代理失败（请看下方错误或手动打开链接）。');
    }, 8000);
    try {
      const r = await fetch(`${API}/dev/quickstart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerCount: 5, scriptId: 'trouble_brewing', start: true }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        setError(`快速开始失败：HTTP ${r.status} ${t.slice(0, 200)}`);
        return;
      }
      const data = await r.json();
      if (!data?.roomId) {
        setError(data?.error || '快速开始失败');
        return;
      }
      setRoomId(String(data.roomId));
      if (typeof data.hostSecret === 'string') setHostSecret(data.hostSecret);

      const joinUrls = Array.isArray(data.joinUrls) ? data.joinUrls.filter((x: unknown) => typeof x === 'string') as string[] : [];
      const adminUrl = typeof data.adminUrl === 'string' ? data.adminUrl : '';
      setQuickJoinUrls(joinUrls);
      setQuickAdminUrl(adminUrl);

      let opened = 0;
      if (Array.isArray(data.joinUrls)) {
        // 打开 5 个玩家页（浏览器可能拦截弹窗，可先允许本地站点弹窗）
        for (const u of data.joinUrls) {
          if (typeof u === 'string') {
            const w = window.open(u, '_blank', 'noopener,noreferrer');
            if (w) opened++;
          }
        }
      }
      if (typeof data.adminUrl === 'string') {
        const w = window.open(data.adminUrl, '_blank', 'noopener,noreferrer');
        if (w) opened++;
      }
      setQuickTip(opened > 0
        ? '已创建并开局：已尝试打开玩家页与管理员页（若被拦截，请允许弹窗）'
        : '已创建并开局，但浏览器可能拦截了弹窗：请允许弹窗，或使用下方链接手动打开。');
      setTimeout(() => setQuickTip(''), 4000);
    } catch (e) {
      setError((e as Error).message);
      setQuickTip('请求失败：请看下方错误信息。');
    } finally {
      window.clearTimeout(timeoutId);
      setQuickStarting(false);
    }
  };

  const joinRoom = async () => {
    if (!roomId.trim() || !nickname.trim()) { setError('请输入房间号和昵称'); return; }
    setError('');
    try {
      const r = await fetch(`${API}/rooms/${roomId.trim()}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: nickname.trim() }) });
      const data = await r.json();
      if (data.room && data.seatIndex !== undefined) {
        onEnterRoom(data.room, data.seatIndex, data.yourCharacterId ?? null, data.roomId, hostSecret || null);
      } else setError(data.error || '加入失败');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const enterAdmin = () => {
    if (!roomId.trim() || !hostSecret.trim()) {
      setError('管理员模式需要房间号和房主密钥');
      return;
    }
    onEnterAdmin(roomId.trim(), hostSecret.trim());
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1 className="title">Blood on the Clocktower</h1>
          <p className="subtitle">在线推理对局 · 支持玩家视角与管理员控制台</p>
        </div>
      </header>
      <div className="grid">
        <section className="card col-8">
          <h3>剧本信息</h3>
          <p className="muted">默认剧本为 Trouble Brewing，可先查看人数范围后再开房。</p>
          <button type="button" onClick={loadScripts}>加载剧本列表</button>
          {scripts.length > 0 && (
            <ul style={{ marginTop: 10 }}>
              {scripts.map((s) => (
                <li key={s.id}>{s.nameZh}（{s.name}） {s.minPlayers}-{s.maxPlayers} 人</li>
              ))}
            </ul>
          )}
        </section>
        <section className="card col-4">
          <h3>快速开始</h3>
          <div className="row">
            <button className="btn-primary" type="button" onClick={createRoom}>创建房间</button>
            <button type="button" onClick={devQuickStart} disabled={quickStarting}>
              {quickStarting ? '快速开始中…' : '一键快速开始测试（5 人）'}
            </button>
          </div>
          {quickTip && <p className="muted" style={{ marginTop: 8 }}>{quickTip}</p>}
          {(quickJoinUrls.length > 0 || quickAdminUrl) && (
            <div style={{ marginTop: 10 }}>
              <p className="muted" style={{ marginBottom: 6 }}>若弹窗被拦截，可手动打开：</p>
              {quickAdminUrl && (
                <p style={{ margin: '6px 0' }}>
                  管理员页：<a href={quickAdminUrl} target="_blank" rel="noreferrer">打开</a>
                </p>
              )}
              {quickJoinUrls.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {quickJoinUrls.map((u, i) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer">打开玩家 {i + 1}</a>
                  ))}
                </div>
              )}
            </div>
          )}
          <p className="muted" style={{ marginTop: 10 }}>
            后端连通性自检：
            {' '}
            <a href="/api/scripts" target="_blank" rel="noreferrer">打开 /api/scripts</a>
            {' '}
            <span className="muted">（应返回脚本 JSON）</span>
          </p>
          {roomId && (
            <p style={{ marginTop: 10 }}>
              房间号：<code className="mono">{roomId}</code>
              <button type="button" style={{ marginLeft: 8 }} onClick={copyRoomId}>复制房间号</button>
              {copyTip && <span className="muted" style={{ marginLeft: 8 }}>{copyTip}</span>}
            </p>
          )}
          {hostSecret && (
            <p className="muted" style={{ marginTop: 8 }}>
              房主密钥：<code className="mono">{hostSecret}</code>
            </p>
          )}
        </section>
        <section className="card col-8">
          <h3>玩家加入</h3>
          <div className="row">
            <label className="field">
              <span className="label">房间号</span>
              <input placeholder="例如：ABCD12" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">昵称</span>
              <input placeholder="请输入昵称" value={nickname} onChange={(e) => setNickname(e.target.value)} />
            </label>
            <button className="btn-primary" type="button" onClick={joinRoom}>加入房间</button>
          </div>
        </section>
        <section className="card col-4">
          <h3>管理员入口</h3>
          <label className="field">
            <span className="label">hostSecret</span>
            <input placeholder="房主密钥" value={hostSecret} onChange={(e) => setHostSecret(e.target.value)} />
          </label>
          <button style={{ marginTop: 8 }} type="button" onClick={enterAdmin}>进入管理员页面</button>
        </section>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
