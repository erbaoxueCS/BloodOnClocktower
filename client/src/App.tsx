import { useCallback, useState } from 'react';
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
