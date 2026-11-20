export interface JournalEntry {
  v?: number;
  id: string;
  status: string;
  reason?: string;
  ts?: number;
  sessionId?: string;
  paneId?: string;
  requestEntryId?: string;
  responseEntryId?: string;
  runtime?: string;
  [key: string]: unknown;
}

export interface PublicReceipt {
  id?: string;
  status: string;
  reason?: string;
  requestEntryId?: string;
  responseEntryId?: string;
}

export function journalBase(env?: Record<string, string | undefined>): string;
export function scopeFor(cwd: string): string;
export function validEntry(entry: unknown): JournalEntry | null;
export function readJournal(dir: string): JournalEntry[];
export function findReceipt(base: string, id: string): JournalEntry | null;
export function publicReceipt(entry: JournalEntry | null): PublicReceipt;
export function watchReceipts(
  base: string,
  onEntry: (entry: JournalEntry) => void,
  options?: { intervalMs?: number },
): () => void;
