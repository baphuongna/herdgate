#!/usr/bin/env node
// Submit to (or check) a Herdgate host's Pi worker queue over the device channel.
// Experimental: the host publisher must run with HERDGATE_PI_WORKER=1 and a worker
// (experiments/pi-worker/worker.mjs) must be started on the host to drain jobs.
//
//   node experiments/pi-worker/remote.mjs --gate https://gate.example.com \
//     --device d_xxx --secret <act device secret> --submit "brief prompt" [--id <uuid>]
//   node experiments/pi-worker/remote.mjs ... --status <uuid>        # read scope is enough
//
// The secret is the device's own pairing secret; it is used only in memory.
import WebSocket from 'ws';

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) { console.error(`missing --${name}`); process.exit(2); }
  return value;
};

const gate = arg('gate').replace(/\/$/, '').replace(/^http/, 'ws');
const submit = arg('submit');
const status = arg('status');
const workspaceFlag = process.argv.indexOf('--workspace');
const workspaceName = workspaceFlag > 0 ? process.argv[workspaceFlag + 1] : undefined;
if (workspaceName !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(workspaceName)) {
  console.error('--workspace must be a short lowercase name from the host allowlist');
  process.exit(2);
}
const payload = submit !== undefined
  ? { op: 'worker.submit', prompt: submit,
      ...(process.argv.includes('--id') ? { id: arg('id') } : {}),
      ...(workspaceName !== undefined ? { workspace: workspaceName } : {}) }
  : { op: 'worker.status', id: status };
const ws = new WebSocket(`${gate}/v1/device/ws`, { handshakeTimeout: 8_000 });
const timer = setTimeout(() => { console.error('remote worker call timed out'); ws.terminate(); process.exit(1); }, 15_000);
ws.on('error', error => { console.error(error.message); process.exit(1); });
ws.on('open', () => {
  ws.send(JSON.stringify({ v: 1, t: 'hello', device: arg('device'), deviceSecret: arg('secret') }));
});
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const message = JSON.parse(String(data));
  if (message.t === 'hello') {
    ws.send(JSON.stringify({ v: 1, t: 'frame', payload }));
    return;
  }
  if (message.t === 'error') { console.error(JSON.stringify(message)); process.exit(1); }
  const reply = message.t === 'frame' ? message.payload : undefined;
  if (reply && ['worker.submitted', 'worker.status.result', 'error'].includes(reply.op)) {
    clearTimeout(timer);
    console.log(JSON.stringify(reply));
    ws.close();
  }
});
process.on('exit', () => { try { ws.terminate(); } catch { /* already gone */ } });
