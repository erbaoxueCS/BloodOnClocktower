// [NEW] 模拟进度状态管理
// 供前端轮询，实时显示每个 AI 玩家的处理状态

export type AiStatus = 'idle' | 'thinking' | 'waiting' | 'done' | 'timeout' | 'error';

export interface AiPlayerProgress {
  seatIndex: number;
  role: string;
  status: AiStatus;
  action?: string;
  elapsed?: number;  // ms
}

export interface SimulationProgress {
  running: boolean;
  currentGame: number;
  totalGames: number;
  currentDay: number;
  currentPhase: 'first_night' | 'night' | 'day' | 'idle';
  currentStep?: string;
  aiPlayers: AiPlayerProgress[];
  summary: {
    goodKills: number;
    evilKills: number;
    nominations: number;
    executions: number;
  };
  lastUpdated: number;
}

let progress: SimulationProgress = {
  running: false,
  currentGame: 0,
  totalGames: 0,
  currentDay: 0,
  currentPhase: 'idle',
  aiPlayers: [],
  summary: {
    goodKills: 0,
    evilKills: 0,
    nominations: 0,
    executions: 0,
  },
  lastUpdated: Date.now(),
};

export function getSimulationProgress(): SimulationProgress {
  return { ...progress, aiPlayers: [...progress.aiPlayers] };
}

export function setSimulationProgress(p: Partial<SimulationProgress>): void {
  progress = { ...progress, ...p, lastUpdated: Date.now() };
}

export function resetSimulationProgress(gameCount: number): void {
  progress = {
    running: true,
    currentGame: 1,
    totalGames: gameCount,
    currentDay: 1,
    currentPhase: 'first_night',
    aiPlayers: [],
    summary: { goodKills: 0, evilKills: 0, nominations: 0, executions: 0 },
    lastUpdated: Date.now(),
  };
}

export function updateAiPlayerStatus(seatIndex: number, status: AiStatus, action?: string, elapsed?: number): void {
  const idx = progress.aiPlayers.findIndex(p => p.seatIndex === seatIndex);
  if (idx >= 0) {
    progress.aiPlayers[idx] = { ...progress.aiPlayers[idx], status, action, elapsed };
  } else {
    progress.aiPlayers.push({ seatIndex, role: '', status, action, elapsed });
  }
  progress.lastUpdated = Date.now();
}

export function setAiPlayerRole(seatIndex: number, role: string): void {
  const idx = progress.aiPlayers.findIndex(p => p.seatIndex === seatIndex);
  if (idx >= 0) {
    progress.aiPlayers[idx] = { ...progress.aiPlayers[idx], role };
  }
}

export function completeSimulation(): void {
  progress.running = false;
  progress.currentPhase = 'idle';
  progress.lastUpdated = Date.now();
}
