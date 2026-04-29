import type { Room } from './types.js';
import { getShownCharacterId } from './gameEngine.js';

/** 仅下发给对应座位：中英角色名 + 能力（剧本内 ability 文案） */
export interface YourRolePayload {
  characterId: string;
  characterName: string;
  characterNameZh: string;
  ability: string;
  alignment: 'good' | 'evil';
  roleType: 'townsfolk' | 'outsider' | 'minion' | 'demon';
}

export function buildYourRolePayload(room: Room, seatIndex: number): YourRolePayload | null {
  const p = room.players[seatIndex];
  const cid = p ? getShownCharacterId(p) : undefined;
  if (!cid) return null;
  const c = room.script.characters.find((x) => x.id === cid);
  return {
    characterId: cid,
    characterName: c?.name ?? cid,
    characterNameZh: c?.nameZh ?? cid,
    ability: c?.ability ?? '',
    alignment: (c?.alignment ?? 'good') as 'good' | 'evil',
    roleType: (c?.type ?? 'townsfolk') as 'townsfolk' | 'outsider' | 'minion' | 'demon',
  };
}
