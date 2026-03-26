export function pushReplay(room, groupKey, groupTitle, line) {
    const seq = room.replayLog.length;
    room.replayLog.push({ seq, at: Date.now(), groupKey, groupTitle, line });
}
export function pushPublic(room, line) {
    const seq = room.publicLog.length;
    room.publicLog.push({ seq, at: Date.now(), line });
    // 控制长度，避免长局内存膨胀（只保留最近 200 条公开事件）
    if (room.publicLog.length > 200)
        room.publicLog.splice(0, room.publicLog.length - 200);
}
export function clearReplay(room) {
    room.replayLog = [];
}
export function buildReplayBundle(room, winner) {
    const identities = room.players.map((p) => {
        const c = room.script.characters.find((x) => x.id === p.characterId);
        return {
            seatIndex: p.seatIndex,
            nickname: p.nickname,
            characterId: p.characterId ?? '',
            characterName: c?.name ?? '',
            characterZh: c?.nameZh ?? p.characterId ?? '?',
            ability: c?.ability ?? '',
            alignment: c?.alignment ?? 'good',
            survived: p.isAlive,
        };
    });
    return {
        version: '1.0.9',
        winner,
        winnerZh: winner === 'good' ? '善良阵营' : '邪恶阵营',
        identities,
        entries: [...room.replayLog],
    };
}
export function seatLabel(room, seatIndex) {
    const p = room.players[seatIndex];
    if (!p)
        return `#${seatIndex + 1}`;
    return `#${seatIndex + 1}·${p.nickname}`;
}
