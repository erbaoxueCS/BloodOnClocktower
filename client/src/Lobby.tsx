import { useState } from 'react';
import type { RoomView } from './types';

const API = '/api';

type Script = { id: string; name: string; nameZh: string; minPlayers: number; maxPlayers: number };

interface LobbyProps {
  onEnterRoom: (room: RoomView, seatIndex: number, characterId: string | null, roomId: string, hostSecret?: string | null) => void;
}

export function Lobby({ onEnterRoom }: LobbyProps) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [roomId, setRoomId] = useState('');
  const [nickname, setNickname] = useState('');
  const [hostSecret, setHostSecret] = useState<string>('');
  const [error, setError] = useState('');

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

  return (
    <div style={{ padding: 24, maxWidth: 480, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 24 }}>血染钟楼</h1>
      <button type="button" onClick={loadScripts}>加载剧本</button>
      {scripts.length > 0 && (
        <ul style={{ marginTop: 8 }}>
          {scripts.map((s) => (
            <li key={s.id}>{s.nameZh}（{s.name}） {s.minPlayers}-{s.maxPlayers}人</li>
          ))}
        </ul>
      )}
      <hr style={{ margin: '24px 0', borderColor: '#333' }} />
      <div>
        <button type="button" onClick={createRoom}>创建房间</button>
        {roomId && <p style={{ marginTop: 8 }}>房间号：<code>{roomId}</code></p>}
        {hostSecret && (
          <p style={{ marginTop: 8, opacity: 0.9 }}>
            房主密钥：<code>{hostSecret}</code>
            <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>（只有持有者可控制进度；可复制到另一终端/AI 连接）</span>
          </p>
        )}
      </div>
      <div style={{ marginTop: 16 }}>
        <input placeholder="房间号" value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ marginRight: 8, padding: 8 }} />
        <input placeholder="昵称" value={nickname} onChange={(e) => setNickname(e.target.value)} style={{ marginRight: 8, padding: 8 }} />
        <button type="button" onClick={joinRoom}>加入房间</button>
      </div>
      {error && <p style={{ color: '#f88', marginTop: 16 }}>{error}</p>}
    </div>
  );
}
