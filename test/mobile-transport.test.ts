// Wave C1+C2: the mobile TUI transport — persistent /bin/sh with marker framing, the
// bounded ack-ing input queue, and checksum-stamped reads (cksum + conditional body).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The transport modules ship as plain .mjs (the plugin directory stands alone).
const stream = await import(new URL("../plugin/server/mobile-tui-stream.mjs", import.meta.url).pathname);
const { cksum, openShellManager } = stream as {
  cksum: (bytes: Buffer) => string;
  openShellManager: (options?: { timeoutMs?: number }) => {
    execute: (command: string) => Promise<{ stdout: Buffer; code: number }>;
    reinit: () => void;
    close: () => void;
    readonly generation: number;
    readonly state: string;
    readonly fails: number;
    readonly stats: { shells: number; shellRequests: number; fallbackRequests: number };
  };
};
const PaneLiveInputQueueT = stream.PaneLiveInputQueue as typeof PaneLiveInputQueue;

test("persistent shell frames every command with a unique marker, strictly in order", { timeout: 8_000 }, async () => {
  const m = openShellManager();
  try {
    // Sequential replies, each exactly the command's own bytes — never a neighbour's.
    assert.equal((await m.execute("printf first")).stdout.toString(), "first");
    assert.equal((await m.execute("printf 'đ 🀄 nhiều-byte'")).stdout.toString(), "đ 🀄 nhiều-byte");
    // A reply that contains marker-shaped text must not fool the framing: markers are unique.
    assert.equal((await m.execute("printf 'HC_decoy not a frame\\n'")).stdout.toString(), "HC_decoy not a frame\n");
    assert.equal((await m.execute("true")).stdout.length, 0); // empty output is a whole frame
    assert.equal((await m.execute("sh -c 'exit 7'")).code, 7); // the frame carries the exit status
    // stdin is detached per command: `cat` cannot swallow the next request's frame.
    assert.equal((await m.execute("cat")).code, 0);
    assert.equal((await m.execute("cat")).stdout.length, 0);
    // Output far bigger than one chunk still decodes byte-exact (multibyte-safe cut).
    const big = await m.execute("head -c 200000 /dev/zero | tr '\\0' z");
    assert.equal(big.stdout.length, 200000);
    assert.ok(big.stdout.every((b: number) => b === 0x7a));
    assert.equal((await m.execute("printf last")).stdout.toString(), "last");
    assert.equal(m.state, "live");
    assert.equal(m.stats.shells, 1); // one shell served every request above
  } finally {
    m.close();
  }
});

test("a write failure kills the shell generation: the request is never retried, later commands fall back, only reinit() revives", { timeout: 8_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-shell-gen-"));
  const sideEffect = join(dir, "ran");
  const m = openShellManager();
  try {
    assert.equal((await m.execute("printf alive")).stdout.toString(), "alive");
    assert.equal(m.generation, 1);
    // The command runs once and kills its own shell: the marker can never arrive.
    await assert.rejects(m.execute(`printf 'ran\\n' >> '${sideEffect}'; kill -9 $$`), (err: NodeJS.ErrnoException & { kind?: string }) => err.kind === "shell_failed");
    assert.equal(m.state, "dead");
    assert.equal(m.fails, 1); // exactly one failure per generation — no second attempt
    await new Promise((resolve) => setTimeout(resolve, 150)); // had a retry been made, it would land by now
    assert.equal(readFileSync(sideEffect, "utf8"), "ran\n"); // ran exactly once: never retried
    // Later commands still work — through the one-exec-per-command fallback.
    assert.equal((await m.execute("printf fallback")).stdout.toString(), "fallback");
    assert.equal(m.stats.shells, 1); // no respawn inside a dead generation
    assert.equal(m.stats.fallbackRequests, 1);
    assert.equal(m.generation, 1);
    // The generation comes back only by an explicit re-init.
    m.reinit();
    assert.equal(m.generation, 2);
    assert.equal((await m.execute("printf revived")).stdout.toString(), "revived");
    assert.equal(m.state, "live");
    assert.equal(m.stats.shells, 2);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("input queue: adjacent same-pane keystrokes coalesce and acks come back strictly in order", { timeout: 8_000 }, async () => {
  const applied: Array<{ paneId: string; kind: string; text?: string; keys?: string[] }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const q = new PaneLiveInputQueueT(async (event) => {
    if (!applied.length) await gate; // the first batch is in flight while the rest queue up
    applied.push(event);
  });
  const first = q.enqueue("p1", "text", { text: "prompt one" });
  const a = q.enqueue("p1", "keys", { keys: ["up"] });
  const b = q.enqueue("p1", "keys", { keys: ["down"] });
  const c = q.enqueue("p1", "keys", { keys: ["enter"] });
  const second = q.enqueue("p1", "text", { text: "prompt two" });
  release();
  // Ack counts arrive in submission order regardless of which batch carried them.
  assert.deepEqual(await Promise.all([first, a, b, c, second]), [1, 2, 3, 4, 5]);
  assert.deepEqual(applied.map((e) => e.kind), ["text", "keys", "text"]);
  assert.deepEqual(applied[1].keys, ["up", "down", "enter"]); // one send-keys for the burst
  assert.equal(q.acknowledgedCount, 5);
  assert.equal(q.state, "live");
  // A definitive host refusal fails only its own input; the queue drains on in order.
  const q2 = new PaneLiveInputQueueT(async (event) => {
    if (event.text === "no") throw Object.assign(new Error("herdr pane run exited 1"), { definitive: true });
  });
  const bad = q2.enqueue("p1", "text", { text: "no" });
  const good = q2.enqueue("p1", "text", { text: "yes" });
  await assert.rejects(bad, /herdr pane run exited 1/);
  assert.equal(await good, 2); // ack order advanced past the failed input
  assert.equal(q2.state, "live");
});

test("input queue overflow drops everything and flags needsResync: the client re-reads, nothing replays", { timeout: 8_000 }, async () => {
  let writes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const q = new PaneLiveInputQueueT(async () => { writes++; await gate; }, { limit: 4 });
  const pending = [];
  for (let i = 0; i < 4; i++) {
    const p = q.enqueue("pX", "text", { text: `t${i}` });
    p.catch(() => {}); // keep this tick's rejections observed, asserted below
    pending.push(p);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes, 1); // only the head batch was ever written
  const overflow = q.enqueue("pX", "text", { text: "one too many" });
  overflow.catch(() => {});
  assert.equal(q.state, "needsResync");
  assert.equal(q.droppedCount, 4); // the whole queue went, not just the newcomer
  for (const p of pending) await assert.rejects(p, (err: NodeJS.ErrnoException & { kind?: string }) => err.kind === "needs_resync");
  await assert.rejects(overflow, (err: NodeJS.ErrnoException & { kind?: string }) => err.kind === "needs_resync");
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes, 1); // dropped input is never replayed at the pane
  await assert.rejects(q.enqueue("pX", "text", { text: "after resync" }), (err: NodeJS.ErrnoException & { kind?: string }) => err.kind === "needs_resync");
});

test("checksum-stamped reads: unchanged polls carry no body, changes and old clients get the full text", { timeout: 12_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-mobile-reads-"));
  const session = join(homedir(), `.herdgate-mt-reads-${process.pid}-${Date.now()}.jsonl`);
  const herdr = join(dir, "herdr");
  const writeSession = (extra: string[]) => writeFileSync(session, [
    '{"type":"message","message":{"role":"user","content":"đầu file thườ', // torn head record: the reader drops it
    JSON.stringify({ type: "message", message: { role: "user", content: "hỏi phiên transport" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: "đây là câu trả lời đầu" } }),
    ...extra,
  ].join("\n") + "\n");
  writeSession([]);
  writeFileSync(herdr, `#!/bin/sh
case "$1/$2/$3" in
pane/list/) printf '%s\\n' '{"result":{"panes":[{"pane_id":"w1:p1","terminal_title":"agent pane"}]}}';;
pane/get/w1:p1) printf '%s\\n' '{"result":{"pane":{"agent":"pi","agent_session":{"value":"${session}"}}}}';;
pane/read/w1:p1) printf 'màn hình hiện tại';;
*) exit 9;;
esac
`, { mode: 0o700 });
  const adapter = new URL("../src/host/mobile-tui-core.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [adapter, "connect"], { env: { ...process.env, HERDR_BIN_PATH: herdr } });
  const watchdog = setTimeout(() => child.kill(), 10_000);
  const stdout = child.stdout[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  const fill = async () => {
    const part = await stdout.next();
    assert.equal(part.done, false, "adapter closed unexpectedly");
    buffer = Buffer.concat([buffer, part.value]);
  };
  const next = async () => {
    while (buffer.length < 9) await fill();
    const end = 9 + buffer.readUInt32LE(5);
    while (buffer.length < end) await fill();
    const out = { channel: buffer.readUInt32LE(0), kind: buffer[4], body: buffer.subarray(9, end) };
    buffer = buffer.subarray(end);
    return out;
  };
  const frame = (channel: number, kind: number, body = Buffer.alloc(0)) => {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(channel);
    header[4] = kind;
    header.writeUInt32LE(body.length, 5);
    return Buffer.concat([header, body]);
  };
  const rpc = (id: number, method: string, params?: object) => ({ jsonrpc: "2.0", id, method, params });
  const response = async (id: number) => {
    const f = await next();
    assert.equal(f.channel, 0);
    const message = JSON.parse(f.body.toString());
    assert.equal(message.id, id);
    assert.ok(message.result, JSON.stringify(message.error));
    return message.result;
  };
  try {
    child.stdin.write(JSON.stringify(rpc(1, "hello", { framed: true })) + "\n");
    while (buffer.indexOf(10) < 0) await fill();
    const nl = buffer.indexOf(10);
    const hello = JSON.parse(buffer.subarray(0, nl).toString());
    buffer = buffer.subarray(nl + 1);
    assert.ok(hello.result.features.includes("checksum_reads"));
    child.stdin.write(frame(0, 0, Buffer.from(JSON.stringify(rpc(2, "terminal.list")))));
    const address = (await response(2)).terminals[0].address;
    // An old viewer without a checksum gets the full stitched body plus a stamp.
    child.stdin.write(frame(0, 0, Buffer.from(JSON.stringify(rpc(3, "terminal.read", { terminal: address })))));
    const full = await response(3);
    assert.match(full.text, /hỏi phiên transport/);
    assert.match(full.text, /màn hình hiện tại/); // the screen seam rides along
    assert.equal(full.unchanged, undefined);
    assert.equal(full.checksum, cksum(Buffer.from(full.text, "utf8")));
    // The stamp is a real POSIX cksum (coreutils agrees, byte for byte).
    assert.equal(full.checksum, execFileSync("cksum", { input: full.text }).toString().trim());
    // Same stamp → the server answers "unchanged" and carries no body at all.
    child.stdin.write(frame(0, 0, Buffer.from(JSON.stringify(rpc(4, "terminal.read", { terminal: address, checksum: full.checksum })))));
    const same = await response(4);
    assert.equal(same.unchanged, true);
    assert.equal(same.text, undefined); // no body crosses the wire
    assert.equal(same.checksum, full.checksum);
    // New turn in the session file → the old stamp no longer matches, the body returns.
    writeSession([JSON.stringify({ type: "message", message: { role: "user", content: "câu hỏi thứ hai" } })]);
    child.stdin.write(frame(0, 0, Buffer.from(JSON.stringify(rpc(5, "terminal.read", { terminal: address, checksum: full.checksum })))));
    const changed = await response(5);
    assert.equal(changed.unchanged, undefined);
    assert.match(changed.text, /câu hỏi thứ hai/);
    assert.notEqual(changed.checksum, full.checksum);
    // And that new stamp is again enough to go body-less.
    child.stdin.write(frame(0, 0, Buffer.from(JSON.stringify(rpc(6, "terminal.read", { terminal: address, checksum: changed.checksum })))));
    assert.equal((await response(6)).unchanged, true);
  } finally {
    clearTimeout(watchdog);
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    rmSync(dir, { recursive: true, force: true });
    if (existsSync(session)) rmSync(session);
  }
});

test("through the adapter: input acks in order, and an ambiguous delivery flags needs_resync with no replay", { timeout: 12_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-mobile-input-"));
  const adapter = new URL("../src/host/mobile-tui-core.mjs", import.meta.url).pathname;
  const script = (killer: boolean) => {
    const herdr = join(dir, killer ? "herdr-kill" : "herdr");
    writeFileSync(herdr, `#!/bin/sh
case "$1/$2" in
pane/list) printf '%s\\n' '{"result":{"panes":[{"pane_id":"w1:p9","terminal_title":"input pane"}]}}';;
pane/run|pane/send-keys) printf '%s|%s|%s|%s\\n' "$2" "$3" "$4" "$#" >> '${join(dir, killer ? "log-kill" : "log")}'${killer ? "; kill -9 $PPID" : ""}; exit 0;;
*) exit 9;;
esac
`, { mode: 0o700 });
    return herdr;
  };
  const drive = async (bin: string, requests: Array<{ method: string; params: object }>) => {
    const child = spawn(process.execPath, [adapter, "--interactive", "connect"], { env: { ...process.env, HERDR_BIN_PATH: bin } });
    const watchdog = setTimeout(() => child.kill(), 9_000);
    const stdout = child.stdout[Symbol.asyncIterator]();
    let buffer = Buffer.alloc(0);
    const fill = async () => {
      const part = await stdout.next();
      assert.equal(part.done, false, "adapter closed unexpectedly");
      buffer = Buffer.concat([buffer, part.value]);
    };
    const send = (msg: object) => {
      const body = Buffer.from(JSON.stringify(msg));
      const header = Buffer.alloc(9);
      header.writeUInt32LE(0);
      header[4] = 0;
      header.writeUInt32LE(body.length, 5);
      child.stdin.write(Buffer.concat([header, body]));
    };
    const out = [];
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } }) + "\n");
      while (buffer.indexOf(10) < 0) await fill();
      buffer = buffer.subarray(buffer.indexOf(10) + 1);
      let id = 1;
      for (const request of requests) {
        send({ jsonrpc: "2.0", id: ++id, method: request.method, params: request.params });
        while (buffer.length < 9) await fill();
        const end = 9 + buffer.readUInt32LE(5);
        while (buffer.length < end) await fill();
        out.push(JSON.parse(buffer.subarray(9, end).toString()));
        buffer = buffer.subarray(end);
      }
    } finally {
      clearTimeout(watchdog);
      child.stdin.end();
      await new Promise((resolve) => child.once("close", resolve));
    }
    return out;
  };
  try {
    const list = await drive(script(false), [{ method: "terminal.list", params: {} }]);
    const address = list[0].result.terminals[0].address;
    // Acknowledgements come back one per input, strictly in submission order.
    const acks = await drive(script(false), [
      { method: "terminal.send", params: { terminal: address, text: "một" } },
      { method: "terminal.send", params: { terminal: address, text: "hai" } },
      { method: "terminal.keys", params: { terminal: address, keys: ["up"] } },
    ]);
    assert.deepEqual(acks.map((r: { result: { ack: number } }) => r.result.ack), [1, 2, 3]);
    // The pane writes left in order, one herdr call per input.
    assert.equal(readFileSync(join(dir, "log"), "utf8"), "run|w1:p9|một|4\nrun|w1:p9|hai|4\nsend-keys|w1:p9|up|4\n");
    // An ambiguous failure (the shell dies mid-delivery, answer unknown) → needs_resync,
    // and the queue stays closed: the next input is refused, never replayed blindly.
    const dying = await drive(script(true), [
      { method: "terminal.send", params: { terminal: address, text: "vào void" } },
      { method: "terminal.send", params: { terminal: address, text: "sau resync" } },
    ]);
    assert.equal(dying[0].error.data.kind, "needs_resync");
    assert.equal(dying[1].error.data.kind, "needs_resync");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
