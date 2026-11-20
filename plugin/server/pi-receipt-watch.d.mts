export const WATCH_TTL_MS: number;
export const MAX_TTL_MS: number;
export const MAX_SUBS_PER_DEVICE: number;

export interface WatchSubscription {
  device: string;
  requestId: string;
  wantBody: boolean;
  createdAt: number;
  expiresAt: number;
  deliveredAt?: number;
}

export interface WatchStore {
  register(input: { device: string; requestId: string; wantBody?: boolean; ttlMs?: number }): WatchSubscription;
  markDelivered(device: string, requestId: string): boolean;
  ack(device: string, requestId: string): boolean;
  pendingFor(device: string): WatchSubscription[];
  pendingAll(): WatchSubscription[];
  sweep(now?: number): number;
}

export function watchFile(base: string): string;
export function openWatchStore(base: string): WatchStore;
