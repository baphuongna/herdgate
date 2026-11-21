// BM25 keyword search over the local Pi receipt journal — device-safe core.
// The scoring may read archived bodies and Pi session transcripts (host-local
// files its user can already read); the RESULT handed to a device carries
// publicReceipt-shaped metadata only: id, score, status, reason, usage.
// No snippet, no sessionId, no session file, no timestamps — search finds ids,
// and the existing receipt.body op serves text under its own explicit gate.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { publicReceipt } from './pi-receipts.mjs';

const K1 = 1.2;
const B = 0.75;
const TRANSCRIPT_CAP = 512 * 1024;
const BODY_CAP = 128 * 1024;
const SCOPE = /^[0-9a-f]{16}$/;

/** Letters+digits (any script), plus inner . _ / - of words; NFC-folded. */
export function tokenize(text) {
  const out = [];
  const re = /[\p{L}\p{N}]+(?:[._/\-][\p{L}\p{N}]+)*/gu;
  let m;
  while ((m = re.exec(String(text ?? '').normalize('NFC')))) out.push(m[0].toLowerCase());
  return out;
}

export function buildIndex(docs) {
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
  return limit >= scored.length ? scored : scored.slice(0, limit);
}

/** Best window around the first query-term hit (host-local display only). */
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

function readJsonl(file, cap) {
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
      const out = [];
      for (const line of buf.toString('utf8').split('\n')) {
        try { out.push(JSON.parse(line)); } catch { /* torn tail or junk */ }
      }
      return out;
    } finally { closeSync(fd); }
  } catch { return []; }
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (typeof b?.text === 'string' ? b.text : '')).join(' ');
}

function transcriptText(file) {
  const parts = [];
  for (const e of readJsonl(file, TRANSCRIPT_CAP)) {
    if (e?.type !== 'message') continue;
    const role = e.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOfContent(e.message.content).trim();
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

/** Match a Pi session transcript by its id: <sessions>/<slug>/<ts>_<sessionId>.jsonl */
export function findSessionFile(sessionsDir, sessionId) {
  if (!sessionsDir || !sessionId) return null;
  try {
    const suffix = `_${sessionId}.jsonl`;
    for (const slug of readdirSync(sessionsDir)) {
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

/** Where Pi stores session transcripts on this host (PI_HOME wins, like the CLI). */
export function sessionsDir(env = process.env) {
  return join(env.PI_HOME ?? join(homedir(), '.pi'), 'agent', 'sessions');
}

function metaLine(meta) {
  const bits = [meta.status, meta.reason, meta.paneId];
  if (meta.usage) bits.push(`${meta.usage.totalTokens ?? 0} tokens`, `$${meta.usage.costUsd ?? 0}`);
  return bits.filter(Boolean).join(' ');
}

/** Every receipt in every workspace scope becomes one searchable document (host-local). */
export function collectDocs({ base, sessionsRoot, withTranscripts = true } = {}) {
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
        sessionFile = findSessionFile(sessionsRoot, entry.sessionId);
        if (sessionFile) text += '\n' + transcriptText(sessionFile);
      }
      try { text += '\n' + readFileSync(join(dir, 'responses', `${entry.id}.md`), 'utf8').slice(0, BODY_CAP); }
      catch { /* not retained: fine */ }
      docs.push({ id: entry.id, text, meta, sessionFile });
    }
  }
  return docs;
}

/**
 * Device-safe search: full-text scoring host-side, publicReceipt-shaped hits.
 * One hit per session by default (a long transcript owns many receipts; without
 * collapsing it would flood the caller's result page). Never throws.
 */
export function searchReceipts({ base, sessionsRoot, query, limit = 10, dedupe = true, all = false } = {}) {
  try {
    const docs = collectDocs({ base, sessionsRoot });
    const ranked = searchIndex(buildIndex(docs), query, docs.length);
    const hits = [];
    const seen = new Set();
    for (const { doc, score } of ranked) {
      if (dedupe && !all && doc.meta.sessionId && seen.has(doc.meta.sessionId)) continue;
      if (doc.meta.sessionId) seen.add(doc.meta.sessionId);
      hits.push({ id: doc.id, score: Math.round(score * 1000) / 1000, ...publicReceipt({ ...doc.meta, v: 1, ts: doc.meta.ts }) });
      if (hits.length >= Math.max(1, Math.min(50, limit))) break;
    }
    return hits;
  } catch {
    return []; // unreadable journal base: fail closed, no hits
  }
}
