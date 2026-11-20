#!/usr/bin/env node
// Runs an isolated Herdr server, Gate, publisher and TCP edge. Never uses live rooms or keys.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { Client } from 'ssh2';
import { HerdGateAgent } from '../src/agent/index.ts';
import { startCloud } from '../src/cloud/gateway.ts';
import { startTcpEdge } from '../src/cloud/ssh-tcp-edge.ts';
import { State } from '../src/cloud/stores.ts';
import { createSshBridge } from '../plugin/server/ssh.mjs';
import { openTerminal } from '../plugin/server/mobile-tui-stream.mjs';

const run = promisify(execFile);
const herdr = process.env.TEST_HERDR_BIN;
if (!herdr || resolve(herdr) !== herdr) throw new Error('Set TEST_HERDR_BIN to the absolute path to Herdr');
const rounds = Number(process.argv[2] ?? 24);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('Pass 1 to 100 rounds');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const adapter = join(root, 'plugin/server/mobile-tui-core.mjs');
const dir = await mkdtemp(join(tmpdir(), 'herdgate-mobile-bench-'));
const env = {
  HOME: dir, PATH: process.env.PATH, LANG: process.env.LANG,
  SHELL: '/bin/sh', XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state'),
  XDG_DATA_HOME: join(dir, 'data'), HERDR_SOCKET_PATH: join(dir, 'herdr.sock'), HERDR_BIN_PATH: herdr,
};
const host = (...args) => run(herdr, args, { env, cwd: dir, timeout: 5000 });
const stats = (samples) => {
  if (!samples.length) return undefined;
  const s = samples.toSorted((a, b) => a - b);
  const at = (p) => +s[Math.ceil(p * s.length) - 1].toFixed(1);
  return { n: s.length, p50: at(0.50), p95: at(0.95), max: at(1) };
};
const deadline = (promise, label) => {
  const ctrl = new AbortController();
  return Promise.race([promise, delay(6500, undefined, { signal: ctrl.signal, ref: false }).then(() => { throw new Error(`Timeout: ${label}`); })]).finally(() => ctrl.abort());
};
const elapsed = (since) => performance.now() - since;
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const marker = () => randomBytes(5).toString('hex');

async function coreBench(input, output, letters) {
  let buf = Buffer.alloc(0);
  let id = 0;
  const raw = output[Symbol.asyncIterator]();
  const fill = async () => {
    const next = await raw.next();
    assert.ok(!next.done, 'Core stream ended');
    buf = Buffer.concat([buf, next.value]);
  };
  const send = (channel, kind, payload = Buffer.alloc(0)) => {
    const head = Buffer.alloc(9);
    head.writeUInt32LE(channel);
    head[4] = kind;
    head.writeUInt32LE(payload.length, 5);
    input.write(Buffer.concat([head, payload]));
  };
  const read = async () => {
    while (buf.length < 9) await fill();
    const end = 9 + buf.readUInt32LE(5);
    while (buf.length < end) await fill();
    const value = { channel: buf.readUInt32LE(0), kind: buf[4], body: buf.subarray(9, end), time: performance.now() };
    buf = buf.subarray(end);
    if (value.channel !== 0 && value.kind === 0) {
      const credit = Buffer.alloc(4);
      credit.writeUInt32LE(value.body.length);
      send(value.channel, 1, credit);
    }
    return value;
  };
  const request = (method, params) => {
    send(0, 0, Buffer.from(rpc(++id, method, params)));
    return id;
  };
  const response = async (want) => {
    for (;;) {
      const f = await read();
      if (f.channel !== 0) continue;
      const reply = JSON.parse(f.body.toString());
      if (reply.id !== want) continue;
      assert.ok(reply.result, JSON.stringify(reply.error));
      return reply.result;
    }
  };
  const helloStart = performance.now();
  input.write(rpc(++id, 'hello', { framed: true }) + '\n');
  await deadline((async () => {
    while (!buf.includes(10)) await fill();
    const nl = buf.indexOf(10);
    assert.equal(JSON.parse(buf.subarray(0, nl)).result.framed, true);
    buf = buf.subarray(nl + 1);
  })(), 'Core hello');
  const hello = elapsed(helloStart);
  const { terminals } = await deadline(response(request('terminal.list')), 'list');
  assert.equal(terminals.length, 1, 'benchmark must address only its isolated pane');
  const terminal = terminals[0].address;
  const attachStart = performance.now();
  const { channel } = await deadline(response(request('terminal.attach', { terminal, cols: 120, rows: 28 })), 'attach');
  for (;;) {
    const f = await deadline(read(), 'first paint');
    if (f.channel === channel && f.kind === 0) break;
  }
  const attach = elapsed(attachStart);
  const key = [], sendPaint = [], sendAck = [], keyPaintBytes = [];
  for (let i = 0; i < rounds; i++) {
    const wanted = `k-${marker()}`;
    const start = performance.now();
    send(channel, 0, Buffer.from(wanted));
    let text = '', bytes = 0;
    while (!text.includes(wanted)) {
      const f = await deadline(read(), 'key echo');
      assert.equal(f.channel, channel);
      assert.notEqual(f.kind, 2);
      if (f.kind !== 0) continue;
      text += stripVTControlCharacters(f.body.toString());
      bytes += f.body.length;
    }
    key.push(elapsed(start));
    keyPaintBytes.push(bytes);
    send(channel, 0, Buffer.from([0x15])); // Ctrl+U clears the isolated shell line.
    await delay(125);
    // Alternate every glyph. Herdr can omit unchanged cells from its ANSI deltas.
    const letter = letters[i % 2];
    const suffix = letter.repeat(12);
    const command = `printf '\\033[2J\\033[H'; printf '%s' ${Array(12).fill(letter).join(' ')}; printf '\\n'`;
    const startSend = performance.now();
    const req = request('terminal.send', { terminal, text: command });
    let ack = false, painted = false, seen = '';
    while (!ack || !painted) {
      const f = await deadline(read(), `Send ${i + 1} (ack=${ack}, painted=${painted})`);
      if (f.channel === 0) {
        const msg = JSON.parse(f.body);
        if (msg.id === req) {
          assert.ok(msg.result, JSON.stringify(msg.error));
          sendAck.push(f.time - startSend);
          ack = true;
        }
      } else if (f.channel === channel && f.kind === 0 && !painted) {
        seen += stripVTControlCharacters(f.body.toString());
        if (seen.includes(suffix)) {
          painted = true;
          sendPaint.push(f.time - startSend);
        }
      }
    }
    await delay(125);
  }
  send(channel, 2);
  return { hello, attach, keyMs: stats(key), sendPaintMs: stats(sendPaint), sendAckMs: stats(sendAck), keyPaintBytes: stats(keyPaintBytes) };
}

let server, cloud, edge, publisher, bridge;
try {
  await mkdir(join(dir, 'config/herdr'), { recursive: true });
  server = spawn(herdr, ['server'], { env, cwd: dir, stdio: 'ignore' });
  const until = performance.now() + 5000;
  while (!await host('status', 'server', '--json').then(({ stdout }) => JSON.parse(stdout).running, () => false)) {
    if (performance.now() > until) throw new Error('Isolated Herdr server did not start');
    await delay(50);
  }
  await host('workspace', 'create', '--cwd', dir, '--label', 'bench-mobile', '--focus');
  const panes = JSON.parse((await host('pane', 'list')).stdout).result.panes;
  assert.equal(panes.length, 1);
  const pane = panes[0];
  await host('pane', 'run', pane.pane_id, "PS1='bench> '; export PS1");
  // Measure Herdr's native controller alone, before Core framing and SSH.
  const oldSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = env.HERDR_SOCKET_PATH;
  const nativeSamples = [];
  let native;
  try {
    native = await openTerminal(herdr, pane.terminal_id, 120, 28);
    for (let i = 0; i < rounds; i++) {
      const wanted = `n-${marker()}`;
      const start = performance.now();
      await native.send({ type: 'terminal.input', bytes: Buffer.from(wanted).toString('base64') });
      let text = '';
      while (!text.includes(wanted)) {
        const paint = await deadline(native.frames.next(), 'native echo');
        assert.equal(paint.done, false);
        text += stripVTControlCharacters(paint.value.bytes.toString());
      }
      nativeSamples.push(elapsed(start));
      await native.send({ type: 'terminal.input', bytes: 'FQ==' });
      await delay(150);
    }
  } finally {
    native?.close();
    if (oldSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = oldSocket;
  }
  console.log(JSON.stringify({ route: 'Herdr native controller', keyMs: stats(nativeSamples) }));
  await delay(250);
  const child = spawn(process.execPath, [adapter, '--interactive', 'connect'], { env, cwd: dir });
  const childExit = once(child, 'close');
  try { console.log(JSON.stringify({ route: 'Core adapter (local pipes)', ...await coreBench(child.stdin, child.stdout, 'AB') })); }
  finally { child.stdin.end(); await deadline(childExit, 'adapter exit').catch(() => child.kill()); }
  await delay(250);

  const account = { id: 'bench', name: 'bench', token: marker() };
  const statePath = join(dir, 'gate.json');
  const state = new State([account], statePath);
  const room = state.addRoom(account.id, 'bench');
  const { device, secret } = state.addDevice(room.room, 'bench-act', 'act');
  cloud = await startCloud({ accounts: [account], statePath, log: () => {}, ssh: { port: 0, keyPath: join(dir, 'gate-key.json') } });
  edge = await startTcpEdge({ gate: `http://127.0.0.1:${cloud.port}`, port: 0 });
  bridge = createSshBridge({
    tuiOnly: true, mobileTuiAdapter: { device: device.id, scope: 'act', script: adapter },
    scopeOf: (id) => publisher.scopeOf(id), send: (id, body) => publisher.send(id, body),
    spawnImpl: (bin, args, opts) => spawn(bin, args, { ...opts, env, cwd: dir }),
  });
  publisher = new HerdGateAgent({ endpoint: `ws://127.0.0.1:${cloud.port}/v1/agent/ws`, roomToken: room.token, adapter: {
    info: () => ({ name: 'bench', version: 'test' }), onFrame: (id, body) => { bridge.handle(id, body); },
    onDevices: () => {}, onPairAsk: () => false,
  } });
  publisher.start();
  await deadline(publisher.firstHello, 'publisher hello');
  const client = new Client();
  client.on('error', () => {});
  try {
    const start = performance.now();
    const ready = once(client, 'ready');
    client.connect({ host: '127.0.0.1', port: edge.port, username: device.id, password: secret, readyTimeout: 5000 });
    await deadline(ready, 'SSH ready');
    const sshReady = elapsed(start);
    const stream = await deadline(new Promise((res, rej) => client.exec('hc connect', (err, channel) => err ? rej(err) : res(channel))), 'SSH exec');
    stream.stderr.resume();
    console.log(JSON.stringify({ route: 'TCP edge + Gate + publisher (all local)', sshReady, ...await coreBench(stream, stream, 'CD') }));
    stream.end();
  } finally { client.end(); }
} finally {
  bridge?.closeAll();
  publisher?.stop();
  await edge?.close();
  await cloud?.close();
  await host('server', 'stop').catch(() => {});
  if (server && server.exitCode === null && server.signalCode === null) server.kill();
  await rm(dir, { recursive: true, force: true });
}
