#!/usr/bin/env node
// Host-local BM25 search over the Pi receipt journal — memex-style: find
// previous work by content, get back the receipt id, the verdict and the
// session file to restore. Core lives in plugin/server/pi-receipt-search.mjs
// (shared with the device-channel receipt.search op); this CLI adds the rich
// local display: snippets with highlights and restore paths — host-only
// privileges a device must not receive.
//
//   node experiments/pi-receipt/search.mjs "noise rekey" [--base DIR] [--sessions DIR]
//     [--limit 10] [--json] [--id] [--all] [--no-transcript] [--snippet N]

import { buildIndex, collectDocs, searchIndex, sessionRoots, snippet } from '../../plugin/server/pi-receipt-search.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
};
const opt = name => process.argv.includes(`--${name}`);

const query = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ');
if (!query) {
  console.error('usage: search.mjs <query terms> [--base DIR] [--sessions DIR] [--limit N] [--json] [--id] [--all] [--no-transcript] [--snippet N]');
  process.exit(2);
}
const base = arg('base') ?? `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/herdgate/pi-receipts`;
const explicitSessions = arg('sessions');
const sessions = explicitSessions ? [explicitSessions] : sessionRoots();
const limit = Number(arg('limit', '10'));
const width = Number(arg('snippet', '160'));
const docs = collectDocs({ base, sessionsRoot: opt('no-transcript') ? null : sessions });
// Sessions own many receipts (one per request); without collapsing, one long
// transcript floods the whole result page with its own duplicates.
const ranked = searchIndex(buildIndex(docs), query, docs.length);
const hits = [];
const seen = new Set();
for (const h of ranked) {
  if (!opt('all') && h.doc.meta.sessionId && seen.has(h.doc.meta.sessionId)) continue;
  if (h.doc.meta.sessionId) seen.add(h.doc.meta.sessionId);
  hits.push(h);
  if (hits.length >= limit) break;
}
if (!hits.length) {
  console.error(`no receipts match ${JSON.stringify(query)} (${docs.length} scanned)`);
  process.exit(1);
}
if (opt('id')) { for (const h of hits) console.log(h.doc.id); process.exit(0); }
if (opt('json')) {
  console.log(JSON.stringify(hits.map(h => ({
    id: h.doc.id, score: Math.round(h.score * 1000) / 1000, ...h.doc.meta,
    sessionFile: h.doc.sessionFile,
    snippet: snippet(h.doc.text, query, width),
  }))));
  process.exit(0);
}
const tty = process.stdout.isTTY;
const hl = s => tty ? `\x1b[1;33m${s}\x1b[0m` : s;
for (const h of hits) {
  const m = h.doc.meta;
  const when = new Date(m.ts).toISOString().replace('T', ' ').slice(0, 19);
  const cost = m.usage ? ` ${m.usage.totalTokens}t $${m.usage.costUsd?.toFixed(4)}` : '';
  const title = m.title ? `  ${m.title}` : '';
  console.log(`${h.score.toFixed(2).padStart(6)}  ${m.id}  ${when}  ${m.status}${m.reason ? `/${m.reason}` : ''}${title}${cost}`);
  console.log(`        ${hl(snippet(h.doc.text, query, width))}`);
  if (h.doc.sessionFile) console.log(`        restore: ${h.doc.sessionFile}`);
  console.log();
}
