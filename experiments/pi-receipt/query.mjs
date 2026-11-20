#!/usr/bin/env node
// Query a Herdgate host's Pi receipt journal over the device channel — no TUI needed.
// Experimental: the host publisher must run with HERDGATE_PI_RECEIPTS=1.
//
//   node experiments/pi-receipt/query.mjs --gate https://gate.example.com \
//     --device d_xxx --secret <device secret> --id <request uuid>
//
// The secret is the device's own pairing secret (read scope is enough); it is used
// only in memory. Nothing is printed besides the receipt JSON.
import WebSocket from 'ws';

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) { console.error(`missing --${name}`); process.exit(2); }
  return value;
};

const gate = arg('gate').replace(/\/$/, '').replace(/^http/, 'ws');
const ws = new WebSocket(`${gate}/v1/device/ws`, { handshakeTimeout: 8_000 });
const timer = setTimeout(() => { console.error('query timed out'); ws.terminate(); process.exit(1); }, 15_000);
ws.on('error', error => { console.error(error.message); process.exit(1); });
ws.on('open', () => {
  ws.send(JSON.stringify({ v: 1, t: 'hello', device: arg('device'), deviceSecret: arg('secret') }));
});
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const message = JSON.parse(String(data));
  if (message.t === 'hello') {
    ws.send(JSON.stringify({ v: 1, t: 'frame', payload: { op: 'receipt.get', id: arg('id') } }));
    return;
  }
  if (message.t === 'error') { console.error(JSON.stringify(message)); process.exit(1); }
  if (message.t === 'frame' && message.payload?.op === 'receipt.result') {
    clearTimeout(timer);
    console.log(JSON.stringify(message.payload));
    ws.close();
  }
});
process.on('exit', () => { try { ws.terminate(); } catch { /* already gone */ } });
