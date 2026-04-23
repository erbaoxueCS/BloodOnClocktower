import { getShownCharacterId } from './gameEngine.js';
export function buildYourRolePayload(room, seatIndex) {
    const p = room.players[seatIndex];
    const cid = p ? getShownCharacterId(p) : undefined;
    if (!cid)
        return null;
    const c = room.script.characters.find((x) => x.id === cid);
    return {
        characterId: cid,
        characterName: c?.name ?? cid,
        characterNameZh: c?.nameZh ?? cid,
        ability: c?.ability ?? '',
        alignment: (c?.alignment ?? 'good'),
        roleType: (c?.type ?? 'townsfolk'),
    };
}
