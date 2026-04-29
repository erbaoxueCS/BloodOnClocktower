import type { Room } from '../game/types.js';

export type AiInvocationActor = 'player' | 'storyteller';
export type AiInvocationStage = 'day_plan' | 'day_dialogue' | 'night_action' | 'storyteller_decision';
export type AiInvocationStatus = 'started' | 'responded' | 'applied' | 'fallback' | 'error';

export interface AiInvocationRecord {
  id: string;
  at: number;
  updatedAt: number;
  actor: AiInvocationActor;
  stage: AiInvocationStage;
  roomId: string;
  seatIndex: number | null;
  phase: string;
  stepId?: string;
  model: string;
  status: AiInvocationStatus;
  request?: string;
  response?: string;
  behavior?: string;
  elapsedMs?: number;
  error?: string;
}

const STORE_KEY = 'ai_invocation_log_store';

function getStore(room: Room): Map<string, AiInvocationRecord> {
  const v = room.storytellerDecisions.get(STORE_KEY);
  if (v instanceof Map) return v as Map<string, AiInvocationRecord>;
  const m = new Map<string, AiInvocationRecord>();
  room.storytellerDecisions.set(STORE_KEY, m);
  return m;
}

export function createInvocation(
  room: Room,
  input: Omit<AiInvocationRecord, 'id' | 'at' | 'updatedAt'>,
): AiInvocationRecord {
  const now = Date.now();
  const rec: AiInvocationRecord = {
    id: `${now}-${Math.random().toString(36).slice(2)}`,
    at: now,
    updatedAt: now,
    ...input,
  };
  getStore(room).set(rec.id, rec);
  return rec;
}

export function updateInvocation(
  room: Room,
  id: string,
  patch: Partial<Omit<AiInvocationRecord, 'id' | 'at'>>,
): AiInvocationRecord | null {
  const store = getStore(room);
  const prev = store.get(id);
  if (!prev) return null;
  const next: AiInvocationRecord = {
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  };
  store.set(id, next);
  return next;
}

export function listInvocations(room: Room): AiInvocationRecord[] {
  const store = getStore(room);
  return Array.from(store.values()).sort((a, b) => a.at - b.at);
}
