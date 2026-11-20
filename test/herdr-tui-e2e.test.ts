import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startCloud } from "../src/cloud/gateway.ts";
import { State } from "../src/cloud/stores.ts";
import { HerdGateAgent } from "../src/agent/index.ts";
import { createSshBridge } from "../plugin/server/ssh.mjs";

const run = promisify(execFile);
const bin = process.env.TEST_HERDR_BIN;

// Opt-in: TEST_HERDR_BIN=/absolute/path/to/herdr node --test test/herdr-tui-e2e.test.ts
// Uses the actual publisher, SSH over WS and Herdr on both ends, without
// accessing the developer's running server, keys or saved machine registry.
for (const windowsProbe of [false, true]) test(`real Herdr: save machine and use existing pane over SSH/WS (${windowsProbe ? "Windows bootstrap simulated" : "native Linux publisher"})`, { skip: !bin, timeout: 90_000 }, async () => {
  assert.ok(bin);
  const dir = mkdtempSync(join(tmpdir(), "hg-tui-"));
  const home = (side: string) => {
    const path = join(dir, side);
    for (const s of ["config", "state", "data"]) mkdirSync(join(path, s), { recursive: true });
    return { ...process.env, PATH: process.env.PATH, HOME: path, XDG_CONFIG_HOME: join(path, "config"), XDG_STATE_HOME: join(path, "state"), XDG_DATA_HOME: join(path, "data"), HERDR_CONFIG_PATH: join(path, "config", "herdr", "config.toml"), HERDR_SOCKET_PATH: undefined, HERDR_CLIENT_SOCKET_PATH: undefined, HERDR_SESSION: undefined, HERDR_ENV: undefined };
  };
  const hostEnv = home("host");
  const clientEnv = home("client");
  const host = (args: string[]) => run(bin, args, { env: hostEnv, timeout: 12_000, cwd: dir });
  const client = (args: string[], env = clientEnv) => run(bin, args, { env, timeout: 35_000, cwd: dir });
  const key = join(dir, "key");
  const statePath = join(dir, "gate.json");
  const accounts = [{ id: "a1", name: "test", token: "test-account-token" }];
  let cloud: Awaited<ReturnType<typeof startCloud>> | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  let publisher: ReturnType<typeof spawn> | undefined;
  let probeAgent: HerdGateAgent | undefined;
  let probeBridge: ReturnType<typeof createSshBridge> | undefined;
  const tmux = (...args: string[]) => run("tmux", ["-S", join(dir, "tmux.sock"), ...args], { env: clientEnv, cwd: dir, timeout: 5_000 });
  const log: string[] = [];
  try {
    assert.equal((await host(["--version"])).stdout.trim(), "herdr 0.9.5");
    server = spawn(bin, ["server"], { env: hostEnv, cwd: dir, stdio: "ignore", detached: true });
    await waitFor(async () => JSON.parse((await host(["status", "server", "--json"])).stdout).running === true);
    await host(["workspace", "create", "--cwd", dir, "--label", "preexisting-demo", "--focus"]);
    const panes = JSON.parse((await host(["pane", "list"])).stdout).result.panes as { pane_id: string; focused: boolean }[];
    const pane = panes.find((p) => p.focused)?.pane_id;
    assert.ok(pane);
    await host(["pane", "run", pane, "printf 'host-pane-%s\\n' preexisting"]);

    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const [algo, b64] = readFileSync(key + ".pub", "utf8").split(" ");
    const state = new State(accounts, statePath);
    const { room, token } = state.addRoom("a1", "test-host");
    const { device } = state.addDevice(room, "test-laptop", "act");
    state.addDeviceSshKey(device.id, algo, b64);
    cloud = await startCloud({ accounts, statePath, log: (line) => log.push(line), ssh: { port: 0, keyPath: join(dir, "hostkey.json") } });
    const base = `http://127.0.0.1:${cloud.port}`;
    const publisherConfig = join(dir, "pub");
    mkdirSync(publisherConfig);
    writeFileSync(join(publisherConfig, "herdgate.env"), `HERDGATE_URL=${base}\nHERDGATE_ROOM_TOKEN=${token}\n`);
    const root = join(import.meta.dirname, "..");
    if (windowsProbe) {
      const bridge = createSshBridge({
        platform: "win32", session: "default", tuiOnly: true,
        resolveHerdrBin: () => String.raw`C:\Users\Test User\herdr\herdr.exe`,
        spawnImpl: (_, args, opts) => spawn(bin, args, { ...opts, env: hostEnv, cwd: dir }),
        send: (device, payload) => probeAgent!.send(device, payload),
        scopeOf: (device) => probeAgent!.scopeOf(device), log: (line) => log.push(line),
      });
      probeBridge = bridge;
      probeAgent = new HerdGateAgent({ endpoint: base.replace("http:", "ws:") + "/v1/agent/ws", roomToken: token, adapter: {
        info: () => ({ name: "Windows probe fixture", version: "test" }), onFrame: (device, payload) => { bridge.handle(device, payload); }, onDevices: () => {}, onPairAsk: () => false,
      } });
      probeAgent.start();
      await probeAgent.firstHello;
    } else {
      publisher = spawn(process.execPath, [join(root, "plugin/server/index.mjs"), "serve"], { cwd: dir, env: {
        ...hostEnv, HERDR_BIN_PATH: bin, HERDR_PLUGIN_ID: "dev.herdgate.host", HERDR_PLUGIN_CONFIG_DIR: publisherConfig,
        HERDR_PLUGIN_STATE_DIR: publisherConfig, HERDGATE_PUBLISHER_CHILD: "1",
      }, stdio: ["ignore", "ignore", "pipe"] });
      publisher.stderr?.on("data", (d: Buffer) => log.push(d.toString()));
      await waitFor(() => log.some((line) => line.includes("herdgate: connected to")));
    }

    const sshConfig = join(dir, "ssh_config");
    writeFileSync(sshConfig, `Host herdgate-test\n  HostName herdgate-test\n  User ${device.id}\n  IdentityFile ${key}\n  UserKnownHostsFile ${join(dir, "known_hosts")}\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n  ProxyCommand "${process.execPath}" "${join(root, "templates/herdgate-via.mjs")}" --tunnel --gate ${base}\n`);
    // Prime only the test's known_hosts before Herdr's strict saved-machine probes.
    await run("ssh", ["-F", sshConfig, "herdgate-test", "exit"], { timeout: 10_000 });
    const wrapperDir = join(dir, "bin");
    mkdirSync(wrapperDir);
    writeFileSync(join(wrapperDir, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F '${sshConfig}' "$@"\n`, { mode: 0o700 });
    clientEnv.PATH = `${wrapperDir}:${process.env.PATH}`;
    mkdirSync(join(dir, "client", "config", "herdr"), { recursive: true });
    writeFileSync(clientEnv.HERDR_CONFIG_PATH, "onboarding = false\n[remote]\nmanage_ssh_config = false\n");
    const added = await client(["machine", "add", "herdgate-test", "--label", "home", "--remote-session", "default"]);
    assert.match(added.stdout + added.stderr, /Saved SSH machine/);
    await tmux("new-session", "-d", "-x", "120", "-y", "40", "sleep", "60");
    await tmux("set-option", "remain-on-exit", "on");
    await tmux("respawn-pane", "-k", bin, "--remote", "herdgate-test");
    await waitFor(async () => (await tmux("capture-pane", "-p")).stdout.includes("host-pane-preexisting"));
    assert.match((await client(["--machine", "home", "workspace", "list"])).stdout, /preexisting-demo/);
    assert.match((await client(["--machine", "home", "pane", "read", pane, "--source", "recent"])).stdout, /host-pane-preexisting/);
    await tmux("send-keys", "-l", "printf 'laptop-pane-%s\\n' roundtrip");
    await tmux("send-keys", "Enter");
    await waitFor(async () => (await host(["pane", "read", pane, "--source", "recent"])).stdout.includes("laptop-pane-roundtrip"));
    await waitFor(async () => (await tmux("capture-pane", "-p")).stdout.includes("laptop-pane-roundtrip"));
  } catch (e) {
    console.error(log.join("\n"));
    console.error((await tmux("capture-pane", "-p").catch(() => ({ stdout: "no TUI" }))).stdout);
    throw e;
  } finally {
    await tmux("kill-server").catch(() => {});
    if (publisher && publisher.exitCode === null && publisher.signalCode === null) { publisher.kill(); await once(publisher, "exit"); }
    probeBridge?.closeAll();
    probeAgent?.stop();
    await cloud?.close();
    await host(["server", "stop"]).catch(() => {});
    if (server && server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, "exit"); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Herdr: Core send, native ANSI input and resize reach an existing TUI pane", { skip: !bin, timeout: 25_000 }, async () => {
  assert.ok(bin);
  const dir = mkdtempSync(join(tmpdir(), "hg-mobile-act-"));
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_DATA_HOME: join(dir, "data"), HERDR_CONFIG_PATH: join(dir, "config", "herdr", "config.toml"), HERDR_SESSION: undefined, HERDR_ENV: undefined, HERDR_SOCKET_PATH: undefined, HERDR_CLIENT_SOCKET_PATH: undefined, HERDR_BIN_PATH: bin };
  const host = (...args: string[]) => run(bin, args, { env, cwd: dir, timeout: 8_000 });
  const server = spawn(bin, ["server"], { env, cwd: dir, stdio: "ignore" });
  let app: ReturnType<typeof spawn> | undefined;
  try {
    await waitFor(async () => JSON.parse((await host("status", "server", "--json")).stdout).running === true);
    await host("workspace", "create", "--cwd", dir, "--label", "mobile-act", "--focus");
    const panes = JSON.parse((await host("pane", "list")).stdout).result.panes as { pane_id: string; focused: boolean }[];
    const pane = panes.find((p) => p.focused)?.pane_id;
    assert.ok(pane);
    const url = new URL("../plugin/server/mobile-tui-core.mjs", import.meta.url);
    const p = spawn(process.execPath, [url.pathname, "--interactive", "connect"], { env, cwd: dir });
    app = p;
    const stdout = p.stdout[Symbol.asyncIterator]();
    let buffer = Buffer.alloc(0);
    const load = async () => {
      const next = await stdout.next();
      assert.ok(!next.done, "adapter closed early");
      buffer = Buffer.concat([buffer, next.value]);
    };
    const sendFrame = (ch: number, kind: number, body = Buffer.alloc(0)) => {
      const head = Buffer.alloc(9);
      head.writeUInt32LE(ch);
      head[4] = kind;
      head.writeUInt32LE(body.length, 5);
      p.stdin.write(Buffer.concat([head, body]));
    };
    const rpc = (id: number, method: string, params?: object) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const send = (id: number, method: string, params?: object) => sendFrame(0, 0, Buffer.from(rpc(id, method, params)));
    const read = async () => {
      while (buffer.length < 9) await load();
      const end = buffer.readUInt32LE(5) + 9;
      while (buffer.length < end) await load();
      const item = { ch: buffer.readUInt32LE(0), kind: buffer[4], bytes: buffer.subarray(9, end) };
      buffer = buffer.subarray(end);
      if (item.ch !== 0 && item.kind === 0) {
        const credit = Buffer.alloc(4);
        credit.writeUInt32LE(item.bytes.length);
        sendFrame(item.ch, 1, credit);
      }
      return item;
    };
    const response = async (id: number) => {
      const f = await read();
      assert.equal(f.ch, 0);
      const m = JSON.parse(f.bytes.toString());
      assert.equal(m.id, id);
      assert.ok(m.result, JSON.stringify(m.error));
      return m.result;
    };
    p.stdin.write(rpc(1, "hello", { framed: true }) + "\n");
    while (buffer.indexOf(10) < 0) await load();
    const nl = buffer.indexOf(10);
    assert.ok(JSON.parse(buffer.subarray(0, nl).toString()).result.methods.includes("terminal.send"));
    buffer = buffer.subarray(nl + 1);
    // Select the focused existing pane independently of other test-session panes.
    send(2, "terminal.list");
    const { terminals } = await response(2);
    const terminal = "t" + createHash("sha256").update(pane).digest("hex").slice(0, 12);
    assert.ok(terminals.some((item: { address: string }) => item.address === terminal));
    send(3, "terminal.send", { terminal, text: "printf 'hg-%s\\n' core-send" });
    await response(3);
    await waitFor(async () => (await host("pane", "read", pane, "--source", "recent", "--raw")).stdout.includes("hg-core-send"));
    send(4, "terminal.attach", { terminal, cols: 52, rows: 22, resize_notifications: true });
    const attached = await response(4);
    assert.equal(attached.terminal.cols, 52);
    assert.equal(attached.terminal.rows, 22);
    const first = await read();
    assert.equal(first.ch, attached.channel);
    assert.equal(first.kind, 3);
    assert.equal((await read()).kind, 0);
    const size = Buffer.alloc(4);
    size.writeUInt16LE(47);
    size.writeUInt16LE(18, 2);
    sendFrame(attached.channel, 3, size);
    for (;;) {
      const f = await read();
      assert.equal(f.ch, attached.channel);
      assert.ok(f.kind === 0 || f.kind === 3, "unexpected terminal stream close");
      if (f.kind === 3 && f.bytes.equals(size)) break;
    }
    sendFrame(attached.channel, 0, Buffer.from("printf 'hg-%s\\n' live-input\r"));
    await waitFor(async () => (await host("pane", "read", pane, "--source", "recent", "--raw")).stdout.includes("hg-live-input"));
    for (;;) {
      const f = await read();
      assert.equal(f.ch, attached.channel);
      assert.equal(f.kind, 0);
      if (f.bytes.includes("hg-live-input")) break;
    }
    sendFrame(attached.channel, 2);
    assert.equal((await read()).kind, 2);
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) { app.kill(); await once(app, "close"); }
    await host("server", "stop").catch(() => {});
    if (server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, "close"); }
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 75; i++) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail("condition did not become true");
}
