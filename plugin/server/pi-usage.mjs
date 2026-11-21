// Usage roll-up over the experimental Pi receipt journal (see experiments/pi-receipt).
// Aggregates every workspace scope into daily buckets and per-principal spend —
// the host-local twin of receipt search: no bodies, no session files, just counts.
// Fail-closed like the other journal readers: an unreadable base yields a zeroed
// roll-up, never a throw; corrupt entries are already filtered by readJournal.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from './pi-receipts.mjs';

const SCOPE = /^[0-9a-f]{16}$/; // one hashed dir per Pi workspace
const RECEIPTS = 'receipts.jsonl';
const HUMAN = '(human)'; // principal absent → a human typed it in a pane

const newTotal = () => ({ requests: 0, replied: 0, failed: 0, canceled: 0, unknown: 0, tokens: 0, costUsd: 0 });
const newBucket = extra => ({ ...extra, requests: 0, replied: 0, failed: 0, tokens: 0, costUsd: 0 });

/** Fold one receipt into a bucket; status keys exist only where the shape has them. */
function fold(bucket, entry) {
  bucket.requests += 1;
  if (bucket[entry.status] !== undefined) bucket[entry.status] += 1;
  bucket.tokens += entry.usage?.totalTokens ?? 0; // missing usage counts as zero
  bucket.costUsd += entry.usage?.costUsd ?? 0;
}

const pad2 = n => String(n).padStart(2, '0');
const localDate = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * Roll receipts from every workspace scope under base into one summary: totals,
 * `days` daily buckets (newest first, local dates) and per-principal totals
 * sorted by spend. Duplicate receipt ids collapse to the newest ts — compaction
 * already dedupes within one scope, but two scopes may have seen the same
 * request. Never throws; an unreadable base returns the zeroed shape.
 */
export function usageRollup({ base, days = 7, now = Date.now() } = {}) {
  const at = Number.isFinite(now) ? now : Date.now();
  const span = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 7;

  // Local-day keys, newest first; stepping through the Date constructor so a
  // DST shift inside the window cannot split or duplicate a calendar day.
  const anchor = new Date(at);
  const dayBuckets = new Map();
  for (let back = 0; back < span; back++) {
    const key = localDate(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - back).getTime());
    dayBuckets.set(key, newBucket({ date: key }));
  }

  const latest = new Map(); // id -> entry; newest ts wins, ties keep the last seen
  try {
    for (const name of readdirSync(base)) {
      if (!SCOPE.test(name)) continue;
      let entries;
      try { entries = readJournal(join(base, name, RECEIPTS)); } catch { continue; }
      for (const entry of entries) {
        const prior = latest.get(entry.id);
        if (prior === undefined || prior.ts <= entry.ts) latest.set(entry.id, entry);
      }
    }
  } catch { /* unreadable base: fall through to the zeroed shape */ }

  const total = newTotal();
  const principals = new Map();
  for (const entry of latest.values()) {
    fold(total, entry);
    const day = dayBuckets.get(localDate(entry.ts)); // outside the window: totals only
    if (day) fold(day, entry);
    const key = entry.principal ?? HUMAN;
    let bucket = principals.get(key);
    if (!bucket) { bucket = newBucket({ principal: key, lastTs: entry.ts }); principals.set(key, bucket); }
    fold(bucket, entry);
    if (entry.ts > bucket.lastTs) bucket.lastTs = entry.ts;
  }

  return {
    generatedAt: at,
    total,
    days: [...dayBuckets.values()], // insertion order == newest first
    byPrincipal: [...principals.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}
