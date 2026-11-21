import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const adapter = new URL("../src/host/mobile-tui-core.mjs", import.meta.url).pathname;
const rpc = (id: number, method: string, params?: object) => ({ jsonrpc: "2.0", id, method, params });
const frame = (channel: number, kind: number, body = Buffer.alloc(0)) => {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel);
  header[4] = kind;
  header.writeUInt32LE(body.length, 5);
  return Buffer.concat([header, body]);
};

test("mobile opens a pane stream, receives updated screen text, and cannot write to Herdr", { timeout: 8_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-mobile-attach-"));
  const herdr = join(dir, "herdr");
  const screen = join(dir, "screen");
  const writes = join(dir, "unexpected-command");
  writeFileSync(screen, "pane one\r\nline two\x1b]52;c;ignored\x07");
  writeFileSync(herdr, `#!/bin/sh
case "$1/$2/$3" in
pane/list/) printf '%s\\n' '{"result":{"panes":[{"pane_id":"w1:p1","terminal_title":"one"},{"pane_id":"w1:p2","terminal_title":"two"}]}}';;
pane/read/w1:p1) cat "$SCREEN";;
pane/read/w1:p2) printf 'pane two';;
pane/get/*) printf '%s\n' '{"result":{"pane":{}}}';;
*) touch "$WRITES"; exit 9;;
esac
`, { mode: 0o700 });
  const child = spawn(process.execPath, [adapter, "connect"], { env: { ...process.env, HERDR_BIN_PATH: herdr, SCREEN: screen, WRITES: writes } });
  const exit = once(child, "close");
  const watchdog = setTimeout(() => child.kill(), 7_000);
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
    const result = { channel: buffer.readUInt32LE(0), kind: buffer[4], body: buffer.subarray(9, end) };
    buffer = buffer.subarray(end);
    return result;
  };
  const send = (msg: object) => child.stdin.write(frame(0, 0, Buffer.from(JSON.stringify(msg))));
  const response = async (id: number) => {
    const f = await next();
    assert.equal(f.channel, 0);
    assert.equal(f.kind, 0);
    const message = JSON.parse(f.body.toString());
    assert.equal(message.id, id);
    return message;
  };
  const expectScreen = async (channel: number, text: string) => {
    const f = await next();
    assert.equal(f.channel, channel);
    assert.equal(f.kind, 0);
    assert.ok(f.body.includes(text));
    assert.ok(!f.body.includes("\x1b]52"), "host text must not emit OSC clipboard commands");
    const credit = Buffer.alloc(4);
    credit.writeUInt32LE(f.body.length);
    child.stdin.write(frame(channel, 1, credit));
  };
  try {
    child.stdin.write(JSON.stringify(rpc(1, "hello", { framed: true })) + "\n");
    while (buffer.indexOf(10) < 0) await fill();
    const nl = buffer.indexOf(10);
    assert.equal(JSON.parse(buffer.subarray(0, nl).toString()).result.framed, true);
    buffer = buffer.subarray(nl + 1);
    send(rpc(2, "terminal.list"));
    const [one, two] = (await response(2)).result.terminals;
    // The mobile app can ask for an ordinary attach. It must still get output only.
    send(rpc(3, "terminal.attach", { terminal: one.address, cols: 80, rows: 24 }));
    const attached = await response(3);
    assert.ok(attached.result, JSON.stringify(attached.error));
    const ch = attached.result.channel;
    assert.ok(ch > 0);
    assert.equal(attached.result.automatic_input, false);
    await expectScreen(ch, "pane one\r\nline two");
    for (const kind of [0, 3, 4, 6]) child.stdin.write(frame(ch, kind, Buffer.from("input")));
    writeFileSync(screen, "changed screen");
    await expectScreen(ch, "changed screen");
    child.stdin.write(frame(ch, 2));
    assert.deepEqual(await next(), { channel: ch, kind: 2, body: Buffer.alloc(0) });
    send(rpc(4, "terminal.attach", { terminal: two.address, cols: 80, rows: 24, observe: true }));
    const second = (await response(4)).result.channel;
    assert.notEqual(second, ch);
    await expectScreen(second, "pane two");
    send(rpc(5, "terminal.send", { terminal: two.address, text: "input" }));
    assert.equal((await response(5)).error.data.kind, "forbidden");
    assert.equal(existsSync(writes), false);
  } finally {
    clearTimeout(watchdog);
    child.stdin.end();
    await exit;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only an interactive adapter delivers Core Send and keys to the selected pane", () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-mobile-control-"));
  try {
    const herdr = join(dir, "herdr");
    const log = join(dir, "input");
    writeFileSync(herdr, `#!/bin/sh
case "$1/$2" in
pane/list) printf '%s\\n' '{"result":{"panes":[{"pane_id":"w1:p3","terminal_title":"three"},{"pane_id":"w1:p4","terminal_title":"four"}]}}';;
pane/run|pane/send-keys|pane/send-text|pane/close|pane/split) printf '%s|%s|%s|%s\\n' "$2" "$3" "$4" "$#" >> "$INPUT_LOG"; [ "$4" != rejected ]; exit $?;;
*) exit 9;;
esac
`, { mode: 0o700 });
    const run = (act: boolean, ...requests: object[]) => {
      const result = spawnSync(process.execPath, [adapter, ...(act ? ["--interactive"] : []), "connect"], { encoding: "utf8", input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n", env: { ...process.env, HERDR_BIN_PATH: herdr, INPUT_LOG: log } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().split("\n").map((line: string) => JSON.parse(line));
    };
    const { address } = run(false, rpc(1, "terminal.list"))[0].result.terminals[1];
    const send = (id: number, text: string) => rpc(id, "terminal.send", { terminal: address, text });
    assert.equal(run(false, send(2, "no"))[0].error.data.kind, "forbidden");
    assert.ok(!existsSync(log));
    const [hello, ok, keys, stopped, rejected, missing, conditional, alien] = run(true,
      rpc(2, "hello"), send(3, "- một tin nhắn"), rpc(4, "terminal.keys", { terminal: address, keys: ["up"] }),
      rpc(5, "terminal.interrupt", { terminal: address }), send(6, "rejected"),
      rpc(7, "terminal.send", { terminal: "forged-address", text: "no" }),
      rpc(8, "terminal.send", { terminal: address, text: "no", wait: true }), rpc(9, "machine.exec", { line: "not exposed" }));
    assert.ok(hello.result.methods.includes("terminal.send"));
    assert.equal(ok.result.started, null);
    assert.equal(keys.result.turn, 0);
    assert.deepEqual(stopped.result, { key: "ctrl+c", outcome: "unknown" });
    assert.equal(rejected.error.data.kind, "unavailable");
    assert.equal(missing.error.data.kind, "not_found");
    assert.equal(conditional.error.data.kind, "usage");
    assert.equal(alien.error.data.kind, "forbidden");
    // Closing a pane and starting one both reach Herdr; a read-only pairing may do neither.
    assert.equal(run(false, rpc(10, "terminal.kill", { terminal: address }))[0].error.data.kind, "forbidden");
    assert.deepEqual(run(true, rpc(10, "terminal.kill", { terminal: address }))[0].result, {});
    assert.equal(readFileSync(log, "utf8"), "run|w1:p4|- một tin nhắn|4\nsend-keys|w1:p4|up|4\nsend-keys|w1:p4|ctrl+c|4\nrun|w1:p4|rejected|4\nclose|w1:p4||3\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mobile TUI adapter negotiates plain Core RPC, exposes a pane, and refuses mutations", () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-mobile-tui-"));
  try {
    const herdr = join(dir, "herdr");
    writeFileSync(herdr, '#!/bin/sh\ncase "$1/$2" in\npane/list) echo \'{"result":{"panes":[{"pane_id":"w1:p3","workspace_id":"w1","cwd":"/tmp","terminal_title":"fixture"}]}}\';;\npane/read) [ "$3" = "w1:p3" ] || exit 9; printf "fixture screen\\n";;\n*) exit 10;;\nesac\n', { mode: 0o700 });
    const run = (...requests: object[]) => {
      const result = spawnSync(process.execPath, [adapter, "connect"], { encoding: "utf8", input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n", env: { ...process.env, HERDR_BIN_PATH: herdr } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().split("\n").map((line: string) => JSON.parse(line));
    };
    const [hello, list] = run(rpc(1, "hello", { framed: false }), rpc(2, "terminal.list"));
    assert.equal(hello.result.framed, false);
    assert.equal(hello.result.generation, 1);
    assert.ok(!hello.result.methods.includes("terminal.send"));
    assert.equal(list.result.terminals[0].title, "fixture");
    const address = list.result.terminals[0].address;
    assert.match(address, /^t[0-9a-z]+$/);
    const [read, denied, invented] = run(rpc(3, "terminal.read", { terminal: address, lines: 2 }), rpc(4, "terminal.send", { terminal: address, text: "no" }), rpc(5, "terminal.read", { terminal: "t00000" }));
    assert.match(read.result.text, /fixture screen/);
    assert.equal(denied.error.code, -32601);
    assert.equal(invented.error.data.kind, "not_found");
    const pack = (message: object, channel = 0, kind = 0) => {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(9);
      header.writeUInt32LE(channel);
      header[4] = kind;
      header.writeUInt32LE(body.length, 5);
      return Buffer.concat([header, body]);
    };
    const input = Buffer.concat([
      Buffer.from(JSON.stringify(rpc(6, "hello", { framed: true })) + "\n"),
      pack(rpc(7, "terminal.list")), pack(rpc(8, "terminal.send"), 7, 6),
      pack(rpc(9, "terminal.send")), pack(rpc(10, "terminal.read", { terminal: address })),
    ]);
    const output = spawnSync(process.execPath, [adapter, "connect"], { input, env: { ...process.env, HERDR_BIN_PATH: herdr } });
    assert.equal(output.status, 0, output.stderr.toString());
    const nl = output.stdout.indexOf(10);
    assert.equal(JSON.parse(output.stdout.subarray(0, nl).toString()).result.framed, true);
    const frames = [];
    for (let at = nl + 1; at < output.stdout.length;) {
      assert.equal(output.stdout.readUInt32LE(at), 0);
      assert.equal(output.stdout[at + 4], 0);
      const end = at + 9 + output.stdout.readUInt32LE(at + 5);
      frames.push(JSON.parse(output.stdout.subarray(at + 9, end).toString()));
      at = end;
    }
    assert.deepEqual(frames.map((f) => f.id), [7, 9, 10]);
    assert.equal(frames[0].result.terminals[0].address, address);
    assert.equal(frames[1].error.data.kind, "forbidden");
    assert.match(frames[2].result.text, /fixture screen/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop layout: the herdr-app doc mirrors TUI workspaces and seats every pane by label", () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-mobile-doc-"));
  try {
    const herdr = join(dir, "herdr");
    writeFileSync(herdr, `#!/bin/sh
case "$1/$2" in
pane/list) printf '%s\\n' '{"result":{"panes":[{"pane_id":"w2:p1","workspace_id":"w2","tab_id":"w2:t1","cwd":"/home/x/app","terminal_title":"app one"},{"pane_id":"w2:p2","workspace_id":"w2","tab_id":"w2:t1","cwd":"/home/x/app","terminal_title":"app two"},{"pane_id":"w3:p9","workspace_id":"w3","tab_id":"w3:t2","cwd":"/home/x/db","terminal_title":"db"},{"pane_id":"w3:p10","workspace_id":"w3","tab_id":"w3:t2","cwd":"/home/x/db","terminal_title":"db log"},{"pane_id":"w9:pX"}]}}';;
workspace/list) printf '%s\\n' '{"result":{"workspaces":[{"workspace_id":"w2","label":"app"},{"workspace_id":"w3","label":"database"}]}}';;
pane/layout) case "$4" in
  w2:p1) printf '%s\\n' '{"result":{"layout":{"panes":[{"pane_id":"w2:p1","rect":{"x":0,"y":0,"width":60,"height":40}},{"pane_id":"w2:p2","rect":{"x":60,"y":0,"width":40,"height":40}}]}}}';;
  w3:p9) printf '%s\\n' '{"result":{"layout":{"panes":[{"pane_id":"w3:p9","rect":{"x":0,"y":0,"width":100,"height":24}},{"pane_id":"w3:p10","rect":{"x":0,"y":24,"width":100,"height":16}}]}}}';;
  *) exit 11;;
esac;;
pane/read) printf 'screen\\n';;
*) exit 9;;
esac
`, { mode: 0o700 });
    const ask = (...requests: object[]) => {
      const result = spawnSync(process.execPath, [adapter, "connect"], { encoding: "utf8", input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n", env: { ...process.env, HERDR_BIN_PATH: herdr } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().split("\n").map((line: string) => JSON.parse(line));
    };
    const [list, doc, again, other, bad] = ask(
      rpc(1, "terminal.list"),
      rpc(2, "doc.get", { name: "herdr-app" }),
      rpc(3, "doc.get", { name: "herdr-app" }),
      rpc(4, "doc.get", { name: "scratch" }),
      rpc(5, "doc.get", {}),
    );
    const [one, two, three, ten, loose] = list.result.terminals;
    assert.equal(list.result.terminals.length, 5);
    // Pane geometry from `pane layout` reaches the app as real cols/rows.
    assert.equal(one.cols, 60);
    assert.equal(one.rows, 40);
    // Seating labels exist only for panes inside a workspace, in the app's id shape.
    assert.match(one.labels["herdr.space"], /^sp[0-9a-f]{30}$/);
    assert.match(one.labels["herdr.tab"], /^tb[0-9a-f]{30}$/);
    assert.equal(one.labels["herdr.space"], two.labels["herdr.space"]);
    assert.equal(one.labels["herdr.tab"], two.labels["herdr.tab"]);
    assert.notEqual(one.labels["herdr.space"], three.labels["herdr.space"]);
    assert.equal(loose.labels["herdr.space"], undefined);
    const value = doc.result.value;
    assert.deepEqual(value.spaces.map((s: { name: string }) => s.name), ["app", "database"]);
    assert.deepEqual(value.spaces.map((s: { folder: string }) => s.folder), ["/home/x/app", "/home/x/db"]);
    const [appSpace, dbSpace] = value.spaces;
    assert.equal(appSpace.id, one.labels["herdr.space"]);
    assert.equal(appSpace.tabs[0].id, one.labels["herdr.tab"]);
    assert.equal(appSpace.tabs[0].root.id, appSpace.tabs[0].id);
    // The split structure is rebuilt from the panes' rectangles: side-by-side -> row with weights.
    assert.equal(appSpace.tabs[0].root.type, "row");
    assert.deepEqual(appSpace.tabs[0].root.children.map((c: { content: { terminal: string } }) => c.content.terminal), [one.address, two.address]);
    assert.deepEqual(appSpace.tabs[0].root.children.map((c: { size: { weight: number } }) => c.size.weight), [0.6, 0.4]);
    // Stacked panes -> column with heights as weights.
    assert.equal(dbSpace.tabs[0].root.type, "column");
    assert.deepEqual(dbSpace.tabs[0].root.children.map((c: { content: { terminal: string } }) => c.content.terminal), [three.address, ten.address]);
    assert.deepEqual(dbSpace.tabs[0].root.children.map((c: { size: { weight: number } }) => c.size.weight), [0.6, 0.4]);
    // Stable across calls, and only herdr-app is served; a nameless doc.get is a usage error.
    assert.deepEqual(again.result.value, value);
    assert.equal(again.result.version, doc.result.version);
    assert.ok(Number.isInteger(doc.result.version) && doc.result.version > 0);
    assert.deepEqual(other.result, { value: null, version: 0 });
    assert.equal(bad.error.data.kind, "usage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
