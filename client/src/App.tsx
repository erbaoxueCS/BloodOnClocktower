import { useCallback, useEffect, useState } from 'react';
import { Lobby } from './Lobby';
import { Game } from './Game';
import { AdminPanel } from './AdminPanel';
import type { RoomView } from './types';

export default function App() {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [yourSeatIndex, setYourSeatIndex] = useState<number | null>(null);
  const [yourCharacterId, setYourCharacterId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [hostSecret, setHostSecret] = useState<string | null>(null);
  const [adminMode, setAdminMode] = useState<boolean>(false);

  const enterRoom = useCallback((r: RoomView, seat: number, characterId: string | null, id: string, hs?: string | null) => {
    setRoom(r);
    setYourSeatIndex(seat);
    setYourCharacterId(characterId);
    setRoomId(id);
    setHostSecret(hs ?? null);
  }, []);

  const leaveRoom = useCallback(() => {
    setRoom(null);
    setYourSeatIndex(null);
    setYourCharacterId(null);
    setRoomId(null);
    setHostSecret(null);
    setAdminMode(false);
  }, []);

  const updateRoom = useCallback((r: RoomView) => setRoom(r), []);
  const enterAdmin = useCallback((rid: string, hs: string) => {
    setAdminMode(true);
    setRoomId(rid);
    setHostSecret(hs);
    setRoom(null);
    setYourSeatIndex(null);
    setYourCharacterId(null);
  }, []);

  // Dev 便捷：支持通过 URL 参数自动加入/进入管理员页（便于一键开多个标签页测试）
  useEffect(() => {
    const qs = new URLSearchParams(location.search);
    const autoJoin = qs.get('autoJoin') === '1';
    const admin = qs.get('admin') === '1';
    const rid = qs.get('roomId');
    const hs = qs.get('hostSecret');
    const nickname = qs.get('nickname') ?? '';
    if (!rid) return;

    if (admin && hs) {
      enterAdmin(rid, hs);
      return;
    }
    if (autoJoin && nickname.trim()) {
      void (async () => {
        try {
          const r = await fetch(`/api/rooms/${encodeURIComponent(rid)}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: nickname.trim() }),
          });
          const data = await r.json();
          if (data.room && data.seatIndex !== undefined) {
            enterRoom(data.room, data.seatIndex, data.yourCharacterId ?? null, data.roomId, null);
            return;
          }
          // quickstart 场景：房间可能已开局，join 会失败；改为“接管已有座位”
          const r2 = await fetch('/api/dev/take-seat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: rid, nickname: nickname.trim() }),
          });
          const data2 = await r2.json();
          if (data2.room && data2.seatIndex !== undefined) {
            enterRoom(data2.room, data2.seatIndex, null, data2.roomId ?? rid, null);
          }
        } catch {
          // ignore
        }
      })();
    }
  }, [enterAdmin, enterRoom]);

  if (adminMode && roomId && hostSecret) {
    return <AdminPanel roomId={roomId} hostSecret={hostSecret} onLeave={leaveRoom} />;
  }

  if (room && roomId != null && yourSeatIndex != null) {
    return (
      <Game
        roomId={roomId}
        room={room}
        yourSeatIndex={yourSeatIndex}
        yourCharacterId={yourCharacterId}
        hostSecret={hostSecret}
        onLeave={leaveRoom}
        onRoomUpdate={updateRoom}
      />
    );
  }
  return <Lobby onEnterRoom={enterRoom} onEnterAdmin={enterAdmin} />;
}
