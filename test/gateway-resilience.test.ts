import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { startCloud } from '../src/cloud/gateway.ts';
import { DeviceSock } from './util2.ts';

test('a transport error only closes the affected WebSocket', async (t) => {
  let latest: WebSocket | undefined;
  const upgrade = WebSocketServer.prototype.handleUpgrade;
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', function (this: WebSocketServer, ...args: Parameters<typeof upgrade>) {
    const [req, socket, head, ready] = args;
    upgrade.call(this, req, socket, head, (ws, request) => {
      latest = ws;
      ready(ws, request);
    });
  });
  const token = 'resilience-fixture';
  const cloud = await startCloud({ accounts: [{ id: 'a', name: 'owner', token }] });
  const base = `ws://127.0.0.1:${cloud.port}`;
  const healthy = new DeviceSock(base + '/v1/device/ws');
  try {
    assert.equal((await healthy.hello({ accountToken: token })).t, 'hello');
    for (const leg of ['agent', 'device', 'bridge']) {
      const socket = new WebSocket(`${base}/v1/${leg}/ws`);
      const signal = AbortSignal.timeout(2000);
      try {
        await once(socket, 'open', { signal });
        const closed = once(socket, 'close', { signal });
        // Simulate a transport failure on an otherwise normal local connection.
        assert.ok(latest);
        latest.emit('error', new Error('test transport failure'));
        await closed;
      } finally { socket.terminate(); }
    }
    await healthy.send({ t: 'ping', n: 5 });
    assert.equal((await healthy.expect('pong')).n, 5);
  } finally {
    healthy.close();
    await cloud.close();
  }
});

test('targeted frames never reach another device in the same room, including on replay', async () => {
  const token = 'routing-fixture';
  const cloud = await startCloud({ accounts: [{ id: 'a', name: 'owner', token }] });
  const http = `http://127.0.0.1:${cloud.port}`;
  const ws = http.replace('http:', 'ws:');
  const connect = (leg: string) => new DeviceSock(`${ws}/v1/${leg}/ws`);
  const sockets: DeviceSock[] = [];
  const open = (leg: string) => { const s = connect(leg); sockets.push(s); return s; };
  const post = (path: string, body: object) => fetch(`${http}/v1/agent/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const { code } = await (await post('code', { name: 'fixture' })).json() as { code: string };
    const { roomId } = await (await post('approve', { code })).json() as { roomId: string };
    const { roomToken } = await (await fetch(`${http}/v1/agent/code/${code}/status`)).json() as { roomToken: string };
    const host = open('agent');
    assert.equal((await host.hello({ roomToken })).t, 'hello');
    const pair = async (name: string) => {
      const owner = open('device');
      await owner.hello({ accountToken: token });
      await owner.send({ t: 'pair.begin', roomId, name, scope: 'read' });
      const grant = await owner.expect('pair.granted') as unknown as { device: { id: string }; deviceSecret: string };
      owner.close();
      return { device: grant.device.id, deviceSecret: grant.deviceSecret };
    };
    const aCred = await pair('a');
    const bCred = await pair('b');
    const a = open('device'), b = open('device');
    await a.hello(aCred);
    const bHello = await b.hello(bCred) as unknown as { stream: { gen: string; seq: number } };
    const send = (device: string, marker: string) => host.send({ t: 'frame', device, payload: { marker } });
    await send(aCred.device, 'only-a');
    await send(bCred.device, 'only-b');
    assert.deepEqual((await a.expect('frame')).payload, { marker: 'only-a' });
    assert.deepEqual((await b.expect('frame')).payload, { marker: 'only-b' });
    b.close();
    await b.expectClose();
    await send(aCred.device, 'offline-only-a');
    await send(bCred.device, 'offline-only-b');
    await host.send({ t: 'ping' });
    await host.expect('pong');
    const replay = open('device');
    const hello = await replay.hello({ ...bCred, resume: { room: roomId, ...bHello.stream } });
    assert.equal(hello.resumed, true);
    assert.deepEqual((await replay.expect('frame')).payload, { marker: 'only-b' });
    assert.deepEqual((await replay.expect('frame')).payload, { marker: 'offline-only-b' });
  } finally {
    sockets.forEach(s => s.close());
    await cloud.close();
  }
});
