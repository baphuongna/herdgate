#!/usr/bin/env node
// Query a Herdgate host's Pi receipt journal over the device channel — no TUI needed.
// Experimental: the host publisher must run with HERDGATE_PI_RECEIPTS=1.
//
//   node experiments/pi-receipt/query.mjs --gate https://gate.example.com \
//     --device d_xxx --secret <device secret> --id <request uuid> [--wait [--timeout 300]]
//     [--body [--out /path/to/report.md]]
// or search the journal remotely (metadata hits only, no snippets):
//   node experiments/pi-receipt/query.mjs --gate ... --device ... --secret ... \
//     --search "noise rekey" [--limit 10] [--all]
//
// --wait listens for the settle push after one initial lookup. --body fetches
// the archived reply for either a new push or an already-settled receipt.
// --out additionally saves the reply to a new private file; stdout is still JSON.
// The secret is the device's own pairing secret (read scope is enough); it is used
// only in memory. Nothing is printed besides the receipt JSON.
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 && fallback !== undefined) return fallback;
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) { console.error(`missing --${name}`); process.exit(2); }
  return value;
};
const opt = name => process.argv.includes(`--${name}`);
const search = opt('search') ? process.argv[process.argv.indexOf('--search') + 1] : undefined;
if (opt('search') && (!search || search.startsWith('--'))) { console.error('missing --search <query>'); process.exit(2); }
const id = search ? null : arg('id');
const wait = opt('wait');
const wantBody = opt('body');
const out = opt('out') ? arg('out') : undefined;
const seconds = Number(arg('timeout', '300'));
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 2_147_483) { console.error('invalid --timeout'); process.exit(2); }
if (out && !wantBody) { console.error('--out requires --body'); process.exit(2); }
if (search && (id || wantBody || wait)) { console.error('--search cannot combine with --id/--body/--wait'); process.exit(2); }
if (!search && !id) { console.error('missing --id (or use --search <query>)'); process.exit(2); }
const timeoutMs = seconds * 1000;

const gate = arg('gate').replace(/\/$/, '').replace(/^http/, 'ws');
const settled = p => p && (p.status !== 'unknown' || p.reason !== 'not_retained_in_runtime');
const ws = new WebSocket(`${gate}/v1/device/ws`, { handshakeTimeout: 8_000 });
const timer = setTimeout(() => fail('query timed out'), timeoutMs);
let finished = false;
let fetchingBody = false;
let watched = false;
ws.on('error', error => { if (!finished) fail(error.message); });
ws.on('close', () => { if (!finished) fail('device channel closed before the reply'); });
ws.on('open', () => {
  ws.send(JSON.stringify({ v: 1, t: 'hello', device: arg('device'), deviceSecret: arg('secret') }));
});
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const message = JSON.parse(String(data));
  if (message.t === 'hello') {
    ws.send(JSON.stringify({ v: 1, t: 'frame', payload: search
      ? { op: 'receipt.search', query: search, limit: Number(arg('limit', '10')), all: opt('all') }
      : { op: 'receipt.get', id } }));
    return;
  }
  if (message.t === 'error') return fail(JSON.stringify(message));
  if (message.t !== 'frame' || finished) return;
  const payload = message.payload ?? {};
  if (payload.op === 'error') return fail(JSON.stringify(payload));
  if (payload.op === 'receipt.search.result') {
    finished = true;
    clearTimeout(timer);
    console.log(JSON.stringify(payload));
    ws.close();
    return;
  }
  if (search || payload.id !== id) return;
  if (payload.op === 'receipt.body.result' && fetchingBody) return finish(payload);
  if (payload.op === 'receipt.result' && wait && !settled(payload)) return registerWatch();
  if (payload.op === 'receipt.watched' && payload.pending) return; // armed; the settle will arrive as a push
  if (fetchingBody || !(payload.op === 'receipt.push' || payload.op === 'receipt.watched'
    || (payload.op === 'receipt.result' && (!wait || settled(payload))))) return;
  if (wantBody && payload.status === 'replied') {
    fetchingBody = true;
    ws.send(JSON.stringify({ v: 1, t: 'frame', payload: { op: 'receipt.body', id } }));
  } else finish(payload);
});
function registerWatch() {
  if (watched) return;
  watched = true;
  ws.send(JSON.stringify({ v: 1, t: 'frame', payload: { op: 'receipt.watch', id,
    wantBody, ttlMs: timeoutMs + 60_000 } }));
}
function finish(payload) {
  try {
    if (out && typeof payload.text === 'string') writeFileSync(out, payload.text, { mode: 0o600, flag: 'wx' });
  } catch (error) { return fail(`cannot save report (${error.code ?? 'unknown'})`); }
  // Ack only after the report is handled: the host retires the push intent.
  if (watched && !finished) ws.send(JSON.stringify({ v: 1, t: 'frame', payload: { op: 'receipt.ack', id } }));
  finished = true;
  clearTimeout(timer);
  process.exitCode = out && typeof payload.text !== 'string' ? 1 : 0;
  console.log(JSON.stringify(payload));
  ws.close();
}
function fail(message) {
  finished = true;
  clearTimeout(timer);
  console.error(message);
  process.exitCode = 1;
  ws.terminate();
}
