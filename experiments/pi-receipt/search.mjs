#!/usr/bin/env node
// Keyword search (BM25) over the local Pi receipt journal — memex-style:
// find previous work by content, get back the receipt id, the verdict and the
// session file to restore. Host-local only: reads the same files its user can
// already read (journal, archived bodies, Pi session transcripts); nothing is
// sent anywhere and no device-channel op exposes this index.
//
//   node experiments/pi-receipt/search.mjs "noise rekey" [--base DIR] [--sessions DIR]
//     [--limit 10] [--json] [--id] [--no-transcript] [--snippet N]
//
// Each receipt becomes one document built from, in order of value:
//   1. the archived reply body (responses/<id>.md) when the host retains it,
//   2. the session transcript's user prompt + final assistant reply, matched
//      by sessionId against <sessions>/**/*_<sessionId>.jsonl,
//   3. receipt metadata tokens (status, reason, pane, tokens/cost, date).
// Corrupt journals, torn lines and missing transcripts are skipped, never fatal.
// Search is read-only and leaves no state behind.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------- BM25 core (Okapi, k1/b from the classic Robertson/Sparck Jones tuning) ----------
const K1 = 1.2;
const B = 0.75;

/** Letters+digits (any script, Vietnamese included), plus inner . _ / - of words. */
export function tokenize(text) {
  const out = [];
  // NFC: 'khóa' typed precomposed or with a combining accent must be one token.
  const re = /[\p{L}\p{N}]+(?:[._/\-][\p{L}\p{N}]+)*/gu;
  let m;
  while ((m = re.exec(String(text ?? '').normalize('NFC')))) out.push(m[0].toLowerCase());
  return out;
}

export function buildIndex(docs) {
  // docs: [{ id, text, meta }] — text already lowercased by tokenize here.
  const terms = docs.map(d => tokenize(d.text));
  const lengths = terms.map(t => t.length);
  const avgdl = lengths.reduce((a, b) => a + b, 0) / (docs.length || 1);
  const df = new Map();
  terms.forEach(t => {
    const seen = new Set(t);
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
  });
  return {
    docs, terms, lengths, avgdl, df, n: docs.length,
    idf(term) {
      const d = this.df.get(term) ?? 0;
      return Math.log(1 + (this.n - d + 0.5) / (d + 0.5));
    },
  };
}

/** Score every document against the query; ties break on newest ts. */
export function searchIndex(index, query, limit = 10) {
  const q = tokenize(query);
  if (!q.length || !index.n) return [];
  const scored = [];
  for (let i = 0; i < index.n; i++) {
    const tf = new Map();
    for (const t of index.terms[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of new Set(q)) {
      const f = tf.get(term);
      if (!f) continue;
      const norm = K1 * (1 - B + B * (index.lengths[i] / (index.avgdl || 1)));
      score += index.idf(term) * (f * (K1 + 1)) / (f + norm);
    }
    if (score > 0) scored.push({ doc: index.docs[i], score });
  }
  scored.sort((a, b) => b.score - a.score || (b.doc.meta.ts ?? 0) - (a.doc.meta.ts ?? 0));
  return scored.slice(0, limit);
}

/** Best window around the first query-term hit; plain text, caller highlights. */
export function snippet(text, query, width = 160) {
  const hay = String(text ?? '');
  const terms = tokenize(query);
  const lower = hay.toLowerCase();
  let at = -1;
  for (const term of terms) { at = lower.indexOf(term); if (at >= 0) break; }
  if (at < 0) return hay.slice(0, width).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - Math.floor(width / 2));
  const cut = hay.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return start > 0 ? `…${cut}` : cut;
}

// ---------- document collection ----------
const SCOPE = /^[0-9a-f]{16}$/;

function readJsonl(file, cap) {
  // Returns parsed lines up to `cap` bytes of raw file; tolerates any bad line.
  try {
    const stat = statSync(file);
    const fd = openSync(file, 'r');
    try {
      const size = Math.min(stat.size, cap);
      const buf = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const n = readSync(fd, buf, read, size - read, null);
        if (!n) break;
        read += n;
      }
      const lines = buf.toString('utf8').split('\n');
      const out = [];
      for (const line of lines) {
        try { out.push(JSON.parse(line)); } catch { /* torn tail or junk */ }
      }
      return out;
    } finally { closeSync(fd); }
  } catch { return []; }
}

const TRANSCRIPT_CAP = 512 * 1024; // head of the transcript is plenty for search
const BODY_CAP = 128 * 1024;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (typeof b?.text === 'string' ? b.text : '')).join(' ');
}

function transcriptText(file) {
  const entries = readJsonl(file, TRANSCRIPT_CAP);
  const parts = [];
  for (const e of entries) {
    if (e?.type !== 'message') continue;
    const role = e.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOfContent(e.message.content).trim();
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

function findSessionFile(sessionsDir, sessionId) {
  if (!sessionsDir || !sessionId) return null;
  try {
    const suffix = `_${sessionId}.jsonl`;
    const byDay = readdirSync(sessionsDir);
    for (const slug of byDay) {
      const dir = join(sessionsDir, slug);
      let names;
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (name.endsWith(suffix)) return join(dir, name);
      }
    }
  } catch { /* no sessions dir: fine */ }
  return null;
}

function metaLine(meta) {
  const bits = [meta.status, meta.reason, meta.paneId];
  if (meta.usage) bits.push(`${meta.usage.totalTokens ?? 0} tokens`, `$${meta.usage.costUsd ?? 0}`);
  return bits.filter(Boolean).join(' ');
}

/** Every receipt in every workspace scope becomes one searchable document. */
export function collectDocs({ base, sessionsDir, withTranscripts = true } = {}) {
  const docs = [];
  let scopes = [];
  try { scopes = readdirSync(base).filter(n => SCOPE.test(n)); }
  catch { return docs; }
  for (const scope of scopes) {
    const dir = join(base, scope);
    for (const entry of readJsonl(join(dir, 'receipts.jsonl'), 4 * 1024 * 1024)) {
      if (!entry?.v || !entry.id || !entry.sessionId) continue;
      const meta = {
        id: entry.id, sessionId: entry.sessionId, ts: entry.ts ?? 0,
        status: entry.status, reason: entry.reason, paneId: entry.paneId, usage: entry.usage,
      };
      let text = metaLine(meta);
      let sessionFile = null;
      if (withTranscripts) {
        sessionFile = findSessionFile(sessionsDir, entry.sessionId);
        if (sessionFile) text += '\n' + transcriptText(sessionFile);
      }
      try { text += '\n' + readFileSync(join(dir, 'responses', `${entry.id}.md`), 'utf8').slice(0, BODY_CAP); }
      catch { /* not retained: fine */ }
      docs.push({ id: entry.id, text, meta, sessionFile });
    }
  }
  return docs;
}

// ---------- CLI ----------
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
};
const opt = name => process.argv.includes(`--${name}`);

if (process.argv[1] && (process.argv[1].endsWith('search.mjs'))) {
  const query = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ');
  if (!query) {
    console.error('usage: search.mjs <query terms> [--base DIR] [--sessions DIR] [--limit N] [--json] [--id] [--all] [--no-transcript] [--snippet N]');
    process.exit(2);
  }
  const base = arg('base') ?? `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/herdgate/pi-receipts`;
  const sessionsDir = arg('sessions') ?? `${process.env.PI_HOME ?? process.env.HOME}/.pi/agent/sessions`;
  const limit = Number(arg('limit', '10'));
  const width = Number(arg('snippet', '160'));
  const docs = collectDocs({ base, sessionsDir: opt('no-transcript') ? null : sessionsDir });
  // Sessions own many receipts (one per request); without collapsing, one long
  // transcript floods the whole result page with its own duplicates.
  const every = searchIndex(buildIndex(docs), query, docs.length);
  const hits = [];
  const seenSession = new Set();
  for (const h of every) {
    if (!opt('all') && h.doc.meta.sessionId && seenSession.has(h.doc.meta.sessionId)) continue;
    if (h.doc.meta.sessionId) seenSession.add(h.doc.meta.sessionId);
    hits.push(h);
    if (hits.length >= limit) break;
  }
  if (!hits.length) {
    console.error(`no receipts match ${JSON.stringify(query)} (${docs.length} scanned)`);
    process.exit(1);
  }
  if (opt('id')) { for (const h of hits) console.log(h.doc.id); process.exit(0); }
  if (opt('json')) { console.log(JSON.stringify(hits.map(h => ({
    id: h.doc.id, score: Math.round(h.score * 1000) / 1000, ...h.doc.meta,
    sessionFile: h.doc.sessionFile,
    snippet: snippet(h.doc.text, query, width),
  })))); process.exit(0); }
  const tty = process.stdout.isTTY;
  const hl = s => tty ? `\x1b[1;33m${s}\x1b[0m` : s;
  for (const h of hits) {
    const m = h.doc.meta;
    const when = new Date(m.ts).toISOString().replace('T', ' ').slice(0, 19);
    const cost = m.usage ? ` ${m.usage.totalTokens}t $${m.usage.costUsd?.toFixed(4)}` : '';
    console.log(`${h.score.toFixed(2).padStart(6)}  ${m.id}  ${when}  ${m.status}${m.reason ? `/${m.reason}` : ''}${cost}`);
    console.log(`        ${hl(snippet(h.doc.text, query, width))}`);
    if (h.doc.sessionFile) console.log(`        restore: ${h.doc.sessionFile}`);
    console.log();
  }
}
