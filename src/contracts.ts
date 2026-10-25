export interface Usage { requests: number; tokens: number; cost: number; lastSeenMs: number | null }
export interface Forecast { requests: number; tokens: number; cost: number; basis: 'quota' | 'previous' }
export interface WindowRow {
  id: string; accountId: string; accountName: string; provider: string; plan: string;
  windowLabel: string; windowMode: string; startMs: number | null; endMs: number | null;
  usedPercent: number | null; observedAtMs: number | null; stale: boolean;
  current: Usage | null; previous: Usage | null; forecast: Forecast | null;
  unavailableReason: string;
}
export interface Snapshot { generatedAtMs: number; rows: WindowRow[]; warnings: string[]; sourceLabel: string }
