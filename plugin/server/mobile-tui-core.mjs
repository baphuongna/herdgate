#!/usr/bin/env node
// Subset of the Core API for TUI panes. Input requires explicit local opt-in.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { openTerminal, validDimension } from "./mobile-tui-stream.mjs";

const invoke = promisify(execFile);
const herdr = process.env.HERDR_BIN_PATH || join(homedir(), ".local/bin/herdr");
const name = process.env.HERDGATE_HOST_NAME || "home-tui-mobile";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const core = { id: digest(`herdgate-tui:${hostname()}:${name}`).slice(0, 32), name };
const version = "0.1.21"; // Core wire compatibility target, not a running Core binary.
const methods = ["hello", "server.status", "terminal.list", "terminal.get", "terminal.read", "events.subscribe", "templates.list", "machine.list", "doc.get"];
const inputMethods = ["terminal.send", "terminal.keys", "terminal.interrupt"];
const args = process.argv.slice(2);
const interactive = args[0] === "--interactive";
if (interactive) args.shift();
const mode = interactive ? "interactive" : "read-only";
const inputText = (text) => typeof text === "string" && text.length > 0 && !text.includes("\0") && Buffer.byteLength(text) <= 8192;
const frameKind = { data: 0, credit: 1, close: 2, resize: 3 };
const cap = 128 * 1024;
const windowBytes = 64 * 1024;
const maxStreams = 2;
const pollMs = 1_250;
const startedAt = Date.now();
let cache;
let cacheUntil = 0;
const run = async (args) => (await invoke(herdr, args, { timeout: 4_000, maxBuffer: 512 * 1024, windowsHide: true, shell: false })).stdout;

async function panes() {
  if (cache && Date.now() < cacheUntil) return cache;
  const parsed = JSON.parse(await run(["pane", "list"]));
  if (!Array.isArray(parsed?.result?.panes)) throw new Error("Herdr pane list unavailable");
  cache = parsed.result.panes.filter((p) => typeof p?.pane_id === "string" && /^[a-zA-Z0-9_:.-]{1,128}$/.test(p.pane_id) && !p.pane_id.startsWith("-"))
    .slice(0, 180).map((p) => {
      const title = clip(p.terminal_title_stripped || p.terminal_title || p.pane_id, 120);
      return { id: p.pane_id, target: typeof p.terminal_id === "string" && /^term_[a-zA-Z0-9]{1,96}$/.test(p.terminal_id) ? p.terminal_id : null, terminal: {
        address: "t" + digest(p.pane_id).slice(0, 12), title, name: null, argv: [], cwd: clip(p.cwd, 512),
        state: "live", created_ms: 0, screen: "inexact", cols: 80, rows: 24,
        labels: { where: clip(p.workspace_id, 128) }, turn: 0,
      } };
    });
  cacheUntil = Date.now() + 1_000;
  return cache;
}

function clip(x, n) { return typeof x === "string" ? x.slice(0, n) : ""; }
const status = async () => ({ core, version, pid: process.pid, uptime_ms: Date.now() - startedAt, holders: [], live: (await panes()).length, finished: 0, keeps_running_after_logout: true });
class RpcError extends Error {
  constructor(code, message, kind) { super(message); this.code = code; this.kind = kind; }
}
const invalid = () => new RpcError(-32602, "Invalid params", "usage");

async function findPane(terminal) {
  if (typeof terminal !== "string") throw invalid();
  const hit = (await panes()).find((x) => x.terminal.address === terminal);
  if (!hit) throw new RpcError(-32000, "No such terminal", "not_found");
  return hit;
}

async function call(method, p, framed, attach) {
  switch (method) {
    case "hello":
      return { core, version, generation: 1, framed, features: framed ? ["framed", "attach", "status", ...(interactive ? ["resize_notifications"] : [])] : ["status"], methods: [...methods, ...(framed ? ["terminal.attach"] : []), ...(interactive ? inputMethods : [])], keeps_running_after_logout: true };
    case "server.status": return status();
    case "terminal.list":
    case "events.subscribe": {
      const filters = p.labels ?? {};
      if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw invalid();
      const terminals = (await panes()).map(({ terminal }) => terminal).filter((t) =>
        (method === "terminal.list" || (!p.children_of && (!p.terminal || p.terminal === t.address))) &&
        Object.entries(filters).every(([k, v]) => Object.hasOwn(t.labels, k) && t.labels[k] === v));
      return method === "terminal.list" ? { terminals, hidden_finished: 0, machines: [] } : { terminals, seq: 0, channel: null };
    }
    case "terminal.send":
    case "terminal.keys":
    case "terminal.interrupt": {
      if (!interactive) throw new RpcError(-32601, "This pairing is read-only", "forbidden");
      const { id, terminal } = await findPane(p.terminal);
      const { turn } = terminal;
      if (method === "terminal.send") {
        if (!inputText(p.text) || p.wait === true || p.if != null) throw invalid();
        // Herdr's pane run takes positional text and submits it with Enter in one API request.
        await run(["pane", "run", id, p.text]);
        return { turn, status: null, started: null, wait: null };
      }
      const keys = method === "terminal.interrupt" ? ["ctrl+c"] : p.keys;
      if (!Array.isArray(keys) || !keys.length || keys.length > 32 || keys.some((key) => typeof key !== "string" || !/^(?:(?:ctrl|alt|shift|super)\+)*[a-z0-9][a-z0-9_-]{0,15}$/i.test(key) || key.length > 32)) throw invalid();
      await run(["pane", "send-keys", id, ...keys]);
      return method === "terminal.interrupt" ? { key: keys[0], outcome: "unknown" } : { turn, status: null };
    }
    case "terminal.get":
    case "terminal.attach":
    case "terminal.read": {
      const hit = await findPane(p.terminal);
      if (method === "terminal.get") return hit.terminal;
      if (method === "terminal.attach") {
        if (!framed) throw new RpcError(-32000, "Framed connection required", "needs_framed");
        if ([p.cols, p.rows].some((n) => n !== undefined && n !== 0 && !validDimension(n))) throw invalid();
        return attach(hit, p);
      }
      const lines = p.lines ?? 0;
      if (!Number.isSafeInteger(lines) || lines < 0) throw invalid();
      const text = await run(["pane", "read", hit.id, "--source", "recent", "--lines", String(Math.max(24, Math.min(120, lines + 24))), "--format", "text", "--raw"]);
      return { text: text.slice(0, 32 * 1024), complete: text.length <= 32 * 1024, how: "screen" };
    }
    case "templates.list": return { templates: [] };
    case "machine.list": return { machines: [] };
    case "doc.get": return { value: null, version: 0 };
    default: throw new RpcError(-32601, "Method not available on this TUI adapter", "forbidden");
  }
}

async function paint(paneId, rows) {
  const raw = await run(["pane", "read", paneId, "--source", "visible", "--lines", String(rows), "--format", "text", "--raw"]);
  // Do not replay host terminal escapes (clipboard, title, device queries, etc.).
  const text = stripVTControlCharacters(raw.slice(0, 16_000))
    .replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\n/g, "\r\n");
  return Buffer.from("\x1b[2J\x1b[H" + text);
}

async function serve() {
  let framed = false;
  let buffer = Buffer.alloc(0);
  const streams = new Map();
  let nextChannel = 1;
  let timer;
  let polling = false;
  let closed = false;

  function output(bytes) {
    return new Promise((resolve, reject) => process.stdout.write(bytes, (err) => err ? reject(err) : resolve()));
  }
  function frame(channel, kind, body = Buffer.alloc(0)) {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(channel, 0);
    header[4] = kind;
    header.writeUInt32LE(body.length, 5);
    return output(Buffer.concat([header, body]));
  }
  function write(reply) {
    const body = Buffer.from(JSON.stringify(reply));
    return framed ? frame(0, frameKind.data, body) : output(Buffer.concat([body, Buffer.from("\n")]));
  }
  async function attach(hit, p) {
    if (streams.size >= maxStreams || nextChannel > 0xffff_ffff) throw new RpcError(-32000, "Too many open terminal views", "unavailable");
    const writable = interactive && p.observe !== true;
    if (writable && !hit.target) throw new RpcError(-32000, "This pane has no native terminal stream", "unavailable");
    const native = writable ? await openTerminal(herdr, hit.target, Math.min(500, p.cols || hit.terminal.cols), Math.min(300, p.rows || hit.terminal.rows)) : null;
    const channel = nextChannel++;
    const resize = Boolean(native && p.resize_notifications === true);
    const terminal = native ? { ...hit.terminal, cols: native.first.cols, rows: native.first.rows } : hit.terminal;
    streams.set(channel, { id: hit.id, rows: Math.min(120, p.rows || hit.terminal.rows), credit: windowBytes, last: null, ready: false, native, resize });
    return { channel, terminal, resize_notifications: resize, automatic_input: false };
  }
  function release(channel) {
    const stream = streams.get(channel);
    if (!stream) return false;
    streams.delete(channel);
    stream.native?.close();
    stream.wake?.();
    return true;
  }
  async function closeStream(channel) {
    if (release(channel)) await frame(channel, frameKind.close);
  }
  async function pumpNative(channel, stream) {
    async function sendPaint(paint) {
      if (streams.get(channel) !== stream) return false;
      if (stream.resize && (paint.cols !== stream.cols || paint.rows !== stream.nativeRows)) {
        stream.cols = paint.cols;
        stream.nativeRows = paint.rows;
        const size = Buffer.alloc(4);
        size.writeUInt16LE(paint.cols, 0);
        size.writeUInt16LE(paint.rows, 2);
        await frame(channel, frameKind.resize, size);
      }
      for (let offset = 0; offset < paint.bytes.length;) {
        while (streams.get(channel) === stream && stream.credit === 0) await new Promise((resolve) => { stream.wake = resolve; });
        if (streams.get(channel) !== stream) return false;
        const end = Math.min(offset + stream.credit, offset + 32 * 1024, paint.bytes.length);
        stream.credit -= end - offset;
        await frame(channel, frameKind.data, paint.bytes.subarray(offset, end));
        offset = end;
      }
      return true;
    }
    try {
      if (await sendPaint(stream.native.first)) {
        for await (const paint of stream.native.frames) if (!(await sendPaint(paint))) break;
      }
    } catch { /* Unexpected native close is signalled on this stream. */ }
    finally { await closeStream(channel); }
  }
  function schedule(delay) {
    if (closed || polling || timer || ![...streams.values()].some((s) => !s.native)) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll().catch(() => process.stdin.destroy());
    }, delay);
    timer.unref();
  }
  async function poll() {
    polling = true;
    try {
      for (const [channel, stream] of [...streams]) {
        // Bound subprocesses and stop reading while a client is not draining this view.
        if (closed || streams.get(channel) !== stream || stream.native || !stream.ready || stream.credit < windowBytes / 2) continue;
        let snapshot;
        try { snapshot = await paint(stream.id, stream.rows); }
        catch {
          if (!closed) await closeStream(channel);
          continue;
        }
        if (closed || streams.get(channel) !== stream || snapshot.length > stream.credit || stream.last?.equals(snapshot)) continue;
        stream.credit -= snapshot.length;
        stream.last = snapshot;
        await frame(channel, frameKind.data, snapshot);
      }
    } finally {
      polling = false;
      schedule(pollMs);
    }
  }

  try {
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        let body;
        if (framed) {
          if (buffer.length < 9) break;
          const size = buffer.readUInt32LE(5);
          if (size > cap) throw new Error("Core frame too large");
          if (buffer.length < 9 + size) break;
          const channel = buffer.readUInt32LE(0);
          const kind = buffer[4];
          body = buffer.subarray(9, 9 + size);
          buffer = buffer.subarray(9 + size);
          if (channel !== 0) {
            const stream = streams.get(channel);
            if (stream && kind === frameKind.credit && size === 4) {
              stream.credit = Math.min(windowBytes, stream.credit + body.readUInt32LE());
              stream.wake?.();
              stream.wake = null;
            }
            if (stream && kind === frameKind.close && size === 0) await closeStream(channel);
            if (stream?.native) {
              try {
                if (kind === frameKind.data && size > 0) {
                  if (size > 32 * 1024) throw invalid();
                  await stream.native.send({ type: "terminal.input", bytes: body.toString("base64") });
                }
                if (kind === frameKind.resize && size === 4) {
                  const cols = body.readUInt16LE(0), rows = body.readUInt16LE(2);
                  if (cols > 0 && rows > 0) await stream.native.send({ type: "terminal.resize", cols: Math.min(500, cols), rows: Math.min(300, rows) });
                }
              } catch { await closeStream(channel); }
            }
            continue;
          }
          if (kind !== frameKind.data) continue;
        } else {
          const end = buffer.indexOf(10);
          if (end > cap || (end < 0 && buffer.length > cap)) throw new Error("Core line too large");
          if (end < 0) break;
          body = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          if (!body.length) continue;
        }
        let msg;
        try { msg = JSON.parse(body.toString("utf8")); }
        catch { await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
        if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !Object.hasOwn(msg, "id")) continue;
        if (msg.id !== null && typeof msg.id !== "number" && typeof msg.id !== "string") continue;
        const reply = { jsonrpc: "2.0", id: msg.id };
        const nextFramed = framed || (msg.method === "hello" && msg.params?.framed === true);
        let result;
        try {
          if (msg.params != null && (typeof msg.params !== "object" || Array.isArray(msg.params))) throw invalid();
          result = await call(msg.method, msg.params ?? {}, nextFramed, attach);
        } catch (err) {
          const error = err instanceof RpcError ? { code: err.code, message: err.message, data: { kind: err.kind } } : { code: -32000, message: "Herdr TUI unavailable", data: { kind: "unavailable" } };
          await write({ ...reply, error });
          continue;
        }
        await write({ ...reply, result });
        framed = nextFramed;
        if (msg.method === "terminal.attach") {
          const stream = streams.get(result.channel);
          stream.ready = true;
          if (stream.native) void pumpNative(result.channel, stream).catch(() => process.stdin.destroy());
          else schedule(0);
        }
      }
    }
  } finally {
    closed = true;
    clearTimeout(timer);
    for (const channel of streams.keys()) release(channel);
  }
}

const command = args.join(" ");
try {
  if (command === "--version" || command === "-V") console.log(`hc ${version} (Herdgate ${mode} TUI adapter)`);
  else if (command === "server status" || command === "server status --json") console.log(JSON.stringify(await status()));
  else if (command === "connect" || command === "connect --json") {
    await serve();
  } else {
    console.error("herdgate: TUI adapter supports only connect, --version, and server status");
    process.exitCode = 111;
  }
} catch {
  console.error("herdgate: could not query the local Herdr TUI");
  process.exitCode = 111;
}
