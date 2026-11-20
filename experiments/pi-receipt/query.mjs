#!/usr/bin/env node
// Query a Herdgate host's Pi receipt journal over the device channel — no TUI needed.
// Experimental: the host publisher must run with HERDGATE_PI_RECEIPTS=1.
//
//   node experiments/pi-receipt/query.mjs --gate https://gate.example.com \
//     --device d_xxx --secret <device secret> --id <request uuid> [--wait [--timeout 300]]
//
// --wait keeps the socket open: if the receipt has not settled yet, the script
// prints the publisher's receipt.push the moment the agent finishes. The secret
// is the device's own pairing secret (read scope is enough); it is used only in
// memory. Nothing is printed besides the receipt JSON.
import WebSocket from 'ws';

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) { console.error(`missing --${name}`); process.exit(2); }
  return value;
};
const opt = name => process.argv.includes(`--${name}`);
const id = arg('id');
const wait = opt('wait');
const timeoutMs = (Number(arg('timeout')) || 300) * 1000;

const gate = arg('gate').replace(/\/$/, '').replace(/^http/, 'ws');
const settled = p => p && (p.status !== 'unknown' || p.reason !== 'not_retained_in_runtime');
const ws = new WebSocket(`${gate}/v1/device/ws`, { handshakeTimeout: 8_000 });
const timer = setTimeout(() => { console.error('query timed out'); ws.terminate(); process.exit(1); }, timeoutMs);
ws.on('error', error => { console.error(error.message); process.exit(1); });
ws.on('open', () => {
  ws.send(JSON.stringify({ v: 1, t: 'hello', device: arg('device'), deviceSecret: arg('secret') }));
});
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const message = JSON.parse(String(data));
  if (message.t === 'hello') {
    ws.send(JSON.stringify({ v: 1, t: 'frame', payload: { op: 'receipt.get', id } }));
    return;
  }
  if (message.t === 'error') { console.error(JSON.stringify(message)); process.exit(1); }
  if (message.t !== 'frame') return;
  const payload = message.payload ?? {};
  if (payload.op === 'receipt.result') {
    if (!wait || settled(payload)) { finish(payload); }
    return; // waiting: fall through and listen for the settle push
  }
  if (payload.op === 'receipt.push' && payload.id === id) finish(payload);
});
function finish(payload) {
  clearTimeout(timer);
  console.log(JSON.stringify(payload));
  ws.close();
  process.exit(0);
}
process.on('exit', () => { try { ws.terminate(); } catch { /* already gone */ } });
