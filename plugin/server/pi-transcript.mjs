// Pi session transcript parser (see docs/research/2026-11-21-marketplace/deep/
// usage.md — ported from herdr-agent-usage src/pi.rs, MIT): tail-window read of
// at most `maxBytes` (default 8MB), opened on exact line boundaries — the line
// cut by the window start is dropped, not parsed; the window is measured from
// the length at read time so a line appended mid-read waits for the next pass.
// A file larger than the window also keeps a 64KB header read so the `session`
// header (id + version) is always available.
// The active branch is walked newest→root by id/parentId (a windowed
// transcript accepts a parent that lives before the window). Model comes from
// the last `model_change` on the branch (assistant message model as fallback),
// contextTokens from the newest assistant usage AFTER the last `compaction`
// (contextTokens || totalTokens || Σ of the four counters), and usageTotal
// sums usage of assistant/toolResult messages plus `branch_summary` and
// `compaction` entries — Pi's own session-stat aggregation. Entry schema is
// exactly what the herdgate receipt observer reads (experiments/pi-receipt/
// observer.js) and what Pi 1.5.2 writes. A broken or absent transcript yields
// {error: 'unreadable', file} — never a throw, never a guess.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // MAX_SESSION_BYTES
const HEADER_BYTES = 64 * 1024;
const MAX_BRANCH = 65_536; // branch walk cap; the seen-set guards cycles

/** stem == sessionId or `*_<sessionId>` (pi.rs filename_matches_session_id). */
export function filenameMatchesSessionId(name, sessionId) {
  const stem = String(name).replace(/\.jsonl$/, '');
  return stem === sessionId || stem.endsWith(`_${sessionId}`);
}

function readRange(fd, start, end, decoder) {
  const chunks = [];
  let pos = start;
  while (pos < end) {
    const buf = Buffer.alloc(Math.min(64 * 1024, end - pos));
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (!n) break; // file shrank mid-read — take what is there
    chunks.push(decoder.write(buf.subarray(0, n)));
    pos += n;
  }
  chunks.push(decoder.end());
  return chunks.join('');
}

/**
 * Read the header window (first 64KB) and the newest `maxBytes` of the file on
 * line boundaries. Whole file when it fits; otherwise the header line cut at
 * 64KB and the tail line cut by the window start are both dropped.
 */
function readWindows(filePath, maxBytes) {
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const size = fstatSync(fd).size;
    if (size <= maxBytes) {
      const lines = readRange(fd, 0, size, new StringDecoder('utf8')).split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline
      return { header: lines, tail: lines, windowed: false };
    }
    const header = readRange(fd, 0, Math.min(HEADER_BYTES, size), new StringDecoder('utf8')).split('\n');
    header.pop(); // the line the header window cuts is not parsed
    const tail = readRange(fd, size - maxBytes, size, new StringDecoder('utf8')).split('\n');
    tail.shift(); // the line the window start cuts is dropped, not parsed
    if (tail.length && tail[tail.length - 1] === '') tail.pop();
    return { header, tail, windowed: true };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function parseJsonObjects(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
    } catch {
      continue; // corrupt or torn line — skipped, never fatal
    }
  }
  return entries;
}

const finite = value => (Number.isFinite(value) ? value : 0);

/** contextTokens || totalTokens || Σ of the four counters (saturating). */
function contextTokensOf(usage) {
  if (!usage) return null;
  if (Number.isFinite(usage.contextTokens)) return usage.contextTokens;
  if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  const sum = finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite);
  return sum;
}

/**
 * Parse a Pi session JSONL transcript.
 * Returns {sessionId, model, modelProvider, contextTokens, usageTotal:
 * {totalTokens, costUsd}, usageCoversSession, turns, lastTs} — `model` from
 * the last model_change on the active branch, `contextTokens` after the last
 * compaction, `turns` counts assistant messages on the branch, `lastTs` is
 * the newest message timestamp (message ms first, entry ISO as fallback,
 * session header as last resort, null when nothing carries one).
 * usageCoversSession is false when the tail window dropped older lines (a
 * windowed sum is a lower bound, not the session total).
 * Unreadable/absent/invalid → {error: 'unreadable', file}. Never throws.
 */
export function parsePiTranscript(filePath, maxBytes = DEFAULT_MAX_BYTES) {
  let windows;
  try {
    windows = readWindows(filePath, Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES);
  } catch {
    return { error: 'unreadable', file: filePath };
  }
  const session = parseJsonObjects(windows.header).find(entry => entry.type === 'session');
  const sessionId = session?.id;
  if (!session || Number(session.version) !== 3 || typeof sessionId !== 'string'
    || sessionId.length === 0 || !filenameMatchesSessionId(basename(String(filePath)), sessionId)) {
    return { error: 'unreadable', file: filePath };
  }

  const entries = parseJsonObjects(windows.tail).filter(entry => entry.type !== 'session' && typeof entry.id === 'string');
  const byId = new Map(entries.map(entry => [entry.id, entry]));

  // Active branch: newest entry → root by parentId. A parent that lives before
  // the window is simply not in byId — the walk stops there (accepted).
  const branch = [];
  const seen = new Set();
  let cursor = entries.length ? entries[entries.length - 1] : undefined;
  while (cursor && !seen.has(cursor.id) && branch.length < MAX_BRANCH) {
    seen.add(cursor.id);
    branch.push(cursor);
    const parentId = cursor.parentId;
    cursor = typeof parentId === 'string' ? byId.get(parentId) : undefined;
  }
  branch.reverse(); // root → leaf

  let model = null;
  let modelProvider = null;
  let lastCompaction = -1;
  let turns = 0;
  let lastTs = null;
  let newestAssistant = null; // whole branch
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type === 'model_change') {
      if (typeof entry.modelId === 'string') model = entry.modelId;
      if (typeof entry.provider === 'string') modelProvider = entry.provider;
    }
    if (entry.type === 'compaction') lastCompaction = i;
    if (entry.type === 'message' && entry.message) {
      const message = entry.message;
      if (message.role === 'assistant') {
        turns++;
        newestAssistant = message; // branch runs root→leaf, so the last wins
      }
      const ms = Number(message.timestamp);
      if (Number.isFinite(ms) && ms > lastTs) lastTs = ms;
      else {
        const iso = Date.parse(entry.timestamp);
        if (Number.isFinite(iso) && iso > lastTs) lastTs = iso;
      }
    }
  }
  if (model === null && typeof newestAssistant?.model === 'string') model = newestAssistant.model;
  if (modelProvider === null && typeof newestAssistant?.provider === 'string') modelProvider = newestAssistant.provider;

  // Context is measured after the last compaction — the newest assistant
  // message from there on; with no compaction the newest assistant overall.
  let contextUsage = null;
  if (lastCompaction >= 0) {
    for (let i = branch.length - 1; i > lastCompaction; i--) {
      const message = branch[i].message;
      if (branch[i].type === 'message' && message?.role === 'assistant' && message.usage) {
        contextUsage = message.usage;
        break;
      }
    }
  } else if (newestAssistant?.usage) contextUsage = newestAssistant.usage;
  const contextTokens = contextUsage ? contextTokensOf(contextUsage) : null;

  // Session totals over the window: assistant and toolResult message usage,
  // plus `usage`, `branch_summary` and `compaction` entry usage (Pi's own
  // getSessionStats aggregation). A windowed sum is a lower bound.
  let totalTokens = 0;
  let costUsd = 0;
  for (const entry of entries) {
    let usage = null;
    if (entry.type === 'usage') usage = entry.usage;
    else if (entry.type === 'branch_summary' || entry.type === 'compaction') usage = entry.usage;
    else if (entry.type === 'message') {
      const role = entry.message?.role;
      if (role === 'assistant' || role === 'toolResult') usage = entry.message.usage;
    }
    if (!usage) continue;
    totalTokens += Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite);
    costUsd += finite(usage.cost?.total);
  }
  if (lastTs === null) {
    const headerTs = Date.parse(session.timestamp);
    if (Number.isFinite(headerTs)) lastTs = headerTs;
  }

  return {
    sessionId,
    ...(model !== null ? { model } : {}),
    ...(modelProvider !== null ? { modelProvider } : {}),
    ...(contextTokens !== null ? { contextTokens } : {}),
    usageTotal: { totalTokens, costUsd },
    usageCoversSession: !windows.windowed,
    turns,
    lastTs,
  };
}
