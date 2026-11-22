export const MAX_SPAWNS: number;
export const COMPACT_AT: number;
export const SPAWN_NAME: RegExp;

export interface SpawnRecord {
  id: string;
  sessionId: string;
  paneId: string;
  name: string;
  parentSessionId?: string;
  cwd?: string;
  ts: number;
  status?: string;
  restoredAt?: number;
  [key: string]: unknown;
}

export function spawnsFile(base: string): string;
export function readSpawns(file: string): SpawnRecord[];
export function recordSpawn(base: string, spawn: SpawnRecord): SpawnRecord & { status: string };
export function updateSpawn(base: string, id: string, patch: Partial<SpawnRecord>): SpawnRecord | null;
export function findSpawn(base: string, ref: string): SpawnRecord | null;
export function spawnBase(): string;
