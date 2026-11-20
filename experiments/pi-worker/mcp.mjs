#!/usr/bin/env node
// Experimental MCP stdio server bridging the Herdgate device channel — step 4 slice
// (API/MCP). NOT SHIPPED. Controller side: it connects OUT to the Gate with device
// credentials and speaks newline-delimited JSON-RPC (MCP) on stdio; no listener.
//
//   node experiments/pi-worker/mcp.mjs --gate https://gate.example.com \
//     --device d_xxx --secret <device secret>
//
// Tools: herdgate_worker_submit (needs an act device), herdgate_worker_status,
// herdgate_receipt, herdgate_worker_health (read scope is enough for the last three).
import WebSocket from 'ws';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const EXPERIMENT_VERSION = `${JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version}-experiment`;

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) { console.error(`missing --${name}`); process.exit(2); }
  return value;
};

const gate = arg('gate').replace(/\/$/, '').replace(/^http/, 'ws');
const device = arg('device');
const secret = arg('secret');

function call(payload, op) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gate}/v1/device/ws`, { handshakeTimeout: 8_000 });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('gate call timed out')); }, 15_000);
    ws.on('error', error => { clearTimeout(timer); reject(error); });
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, t: 'hello', device, deviceSecret: secret })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.t === 'hello') { ws.send(JSON.stringify({ v: 1, t: 'frame', payload })); return; }
      if (message.t === 'error') {
        clearTimeout(timer); ws.close();
        return resolve({ op: 'error', code: message.code ?? 'gate', message: message.message ?? '' });
      }
      if (message.t === 'frame') {
        const reply = message.payload ?? {};
        if (reply.op === op || reply.op === 'error') { clearTimeout(timer); ws.close(); resolve(reply); }
      }
    });
  });
}

const TOOLS = [
  { name: 'herdgate_worker_submit',
    description: 'Submit a prompt to the Herdgate host Pi worker queue. Admission is idempotent by request id; the run settles asynchronously — poll herdgate_worker_status or herdgate_receipt. Needs an act device.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, id: { type: 'string', description: 'optional request UUID; omit to let the host assign one' } }, required: ['prompt'] },
    invoke: args => call({ op: 'worker.submit', prompt: args.prompt, ...(args.id ? { id: args.id } : {}) }, 'worker.submitted') },
  { name: 'herdgate_worker_status',
    description: 'Queue record for one Herdgate worker job id (state/reason/entry ids; never the prompt).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    invoke: args => call({ op: 'worker.status', id: args.id }, 'worker.status.result') },
  { name: 'herdgate_receipt',
    description: 'Pi receipt metadata for one request UUID: status replied/failed/canceled/unknown plus reason and entry ids.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    invoke: args => call({ op: 'receipt.get', id: args.id }, 'receipt.result') },
  { name: 'herdgate_worker_health',
    description: 'Host worker liveness: queue depth and the last heartbeat written by the scheduler/worker experiment.',
    inputSchema: { type: 'object', properties: {} },
    invoke: () => call({ op: 'worker.health' }, 'worker.health.result') },
];

const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const rpc = (id, result) => out({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return rpcError(null, -32700, 'parse error'); }
  if (request.id === undefined || request.id === null) return; // notification
  const { id, method, params } = request;
  if (method === 'initialize') {
    const version = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
    return rpc(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'herdgate-worker', version: EXPERIMENT_VERSION } });
  }
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') {
    return rpc(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(entry => entry.name === params?.name);
    if (!tool) return rpcError(id, -32602, `unknown tool ${String(params?.name)}`);
    const args = params?.arguments ?? {};
    for (const key of tool.inputSchema.required ?? []) {
      if (args[key] === undefined || args[key] === '') {
        return rpc(id, { content: [{ type: 'text', text: JSON.stringify({ op: 'error', code: 'bad-arguments', message: `missing ${key}` }) }], isError: true });
      }
    }
    tool.invoke(args)
      .then(reply => rpc(id, { content: [{ type: 'text', text: JSON.stringify(reply) }], isError: reply.op === 'error' }))
      .catch(error => rpc(id, { content: [{ type: 'text', text: JSON.stringify({ op: 'error', code: 'transport', message: String(error?.message ?? error) }) }], isError: true }));
    return;
  }
  return rpcError(id, -32601, `method not found: ${String(method)}`);
});
