export type JobState = 'queued' | 'running' | 'replied' | 'failed' | 'canceled' | 'unknown';

export interface JobRecord {
  v: 1;
  id: string;
  prompt: string;
  ts: number;
  state: JobState;
  sessionId?: string;
  reason?: string;
  requestEntryId?: string;
  responseEntryId?: string;
}

export interface PublicJob {
  id?: string;
  state: JobState;
  ts?: number;
  reason?: string;
  sessionId?: string;
  requestEntryId?: string;
  responseEntryId?: string;
}

export const JOB_ID: RegExp;
export const MAX_PROMPT: number;
export const MAX_PENDING: number;
/** Oldest Pi release the experiments are verified against (floor, not a pin). */
export const MIN_PI_VERSION: string;
export function versionAtLeast(version: string, min?: string): boolean;
export function workerBase(env?: Record<string, string | undefined>): string;
export function jobsFile(base: string): string;
export function validJob(job: unknown): JobRecord | null;
export function readJobs(file: string): Map<string, JobRecord>;
export function appendJob(file: string, job: JobRecord): void;
export function publicJob(job: JobRecord | null): PublicJob;
export function queueDepth(jobs: Map<string, JobRecord>): { queued: number; running: number };
export function scheduledRunId(scheduleId: string, bucket: number): string;
export interface Heartbeat {
  v: 1;
  ts: number;
  source: string;
  [key: string]: unknown;
}
export function heartbeatPath(base: string): string;
export function writeHeartbeat(base: string, entry: Heartbeat): void;
export function readHeartbeat(base: string): Heartbeat | null;
