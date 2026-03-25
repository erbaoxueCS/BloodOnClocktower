import { useCallback, useState } from 'react';
import { Lobby } from './Lobby';
import { Game } from './Game';
import type { RoomView } from './types';

export default function App() {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [yourSeatIndex, setYourSeatIndex] = useState<number | null>(null);
  const [yourCharacterId, setYourCharacterId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);

  const enterRoom = useCallback((r: RoomView, seat: number, characterId: string | null, id: string) => {
    setRoom(r);
    setYourSeatIndex(seat);
    setYourCharacterId(characterId);
    setRoomId(id);
  }, []);

  const leaveRoom = useCallback(() => {
    setRoom(null);
    setYourSeatIndex(null);
    setYourCharacterId(null);
    setRoomId(null);
  }, []);

  const updateRoom = useCallback((r: RoomView) => setRoom(r), []);

  if (room && roomId != null && yourSeatIndex != null) {
    return (
      <Game
        roomId={roomId}
        room={room}
        yourSeatIndex={yourSeatIndex}
        yourCharacterId={yourCharacterId}
        onLeave={leaveRoom}
        onRoomUpdate={updateRoom}
      />
    );
  }
  return <Lobby onEnterRoom={enterRoom} />;
}
