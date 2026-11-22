/**
 * The herdgate gateway (v0): HTTP + two WebSocket legs behind one gate.
 *
 *   GET  /healthz                     liveness (public)
 *   POST /v1/agent/code               mint a host pairing code (rate-limited, no auth)
 *   POST /v1/agent/approve            approve a code (account token)
 *   GET  /v1/agent/code/:code/status  the host polls for its room token
 *   GET  /v1/agent/ws                 host-agent leg  (hello-first, room token)
 *   GET  /v1/device/ws                device leg      (hello-first, account token)
 *
 * Deployment: bind 127.0.0.1, publish through `cloudflared` (DEPLOY.md). The
 * cloud is the identity provider — no Cloudflare Access in front is required,
 * and none of its headers are trusted. If `expectedHost` is set, every request
 * must carry that Host (the public hostname), else 421.
 *
 * Payload rule: `frame.payload` is routed, never parsed (see protocol/envelope.ts).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  decode,
  encode,
  HELLO_TIMEOUT_MS,
  isScope,
  MAX_FRAME_BYTES,
  PAIR_ANSWER_MS,
  RATE_BURST,
  RATE_MSG_PER_S,
  type DeviceView,
  type Envelope,
} from "../protocol/index.ts";
import { AgentCodes } from "./pairing.ts";
import { parseAuthorizedKey, sshKeyFingerprint } from "./sshd.ts";
import { type Account, type DeviceRecord, type RoomRecord, State } from "./stores.ts";
import { pruneBudget, readJsonBody, randomId, sameSecret, sha256Hex } from "./util.ts";
import { serveStatic } from "./static.ts";
import { startSshd, type SshHandle, type SshConfig } from "./sshd.ts";
import { pushEndpoint, sendPush, encryptPayload, canPayload, type PushKeys } from "./push.ts";
import { type VapidKeys } from "./vapid.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The gate's own build id (npm package version) — served on /healthz so a PWA can
 *  detect that the bundle it is running is older than the gate and offer a reload. */
const BUILD_ID: string = (() => {
  try {
    return String(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")).version ?? "");
  } catch {
    return "";
  }
})();

/** What changed on the host, for the encrypted push payload (Vietnamese copy is PWA-side). */
export interface WakeNote {
  kind: "settle" | "died" | "needs-you" | "activity";
  agent?: string;
}

export interface CloudConfig {
  accounts: { id: string; name: string; token: string }[];
  bind?: string;
  port?: number;
  /** JSON state file (rooms + devices); omit for in-memory. */
  statePath?: string;
  /** The public hostname cloudflared serves; enforced as `Host` when set. */
  expectedHost?: string;
  /** Shown in pairing-code responses; e.g. `https://herd.example.com`. */
  publicUrl?: string | null;
  /** Directory of the PWA (src/web). Served on `/`; omit to serve no UI. */
  webRoot?: string;
  /** The SSH leg; omit to disable, or set `port: 0` for an ephemeral listener. */
  ssh?: SshConfig;
  /** Public address advertised to clients, when an edge maps a different port. */
  sshHost?: string;
  sshPublicPort?: number;
  /** VAPID keys for silent wake pushes; omit to disable the push endpoints. */
  push?: { keys: VapidKeys; /** mailto contact required by the VAPID spec. */ sub: string } | null;
  /**
   * Trust a reverse-proxy header (e.g. CF-Connecting-IP) as the client address for
   * abuse limits. Without it, loopback connections (a same-host proxy such as
   * cloudflared) get a per-connection budget so one abusive client can never lock
   * out everyone behind the proxy.
   */
  trustedProxy?: boolean;
  /** Header name read in trusted-proxy mode; default CF-Connecting-IP. */
  realIpHeader?: string;
  /** SSH-over-WSS budget. Defaults: 6 per client, 64 total. Raw-TCP edges cannot
   * convey real client addresses, so size these for the shared edge address. */
  sshTunnelLimits?: { perKey?: number; total?: number };
  /** Cap on concurrently pending pairing codes; default 256. */
  maxPendingCodes?: number;
  heartbeatMs?: number;
  log?: (line: string) => void;
}

interface AgentConn {
  ws: WebSocket;
  room: RoomRecord;
}
interface DeviceConn {
  ws: WebSocket;
  account: Account;
  device: DeviceRecord | null;
  /** True when this socket authenticated with a device secret, not the account token. */
  viaDeviceSecret: boolean;
}

export interface Cloud {
  server: Server;
  port: number;
  /** The SSH leg, when enabled. */
  ssh: SshHandle | null;
  close(): Promise<void>;
}

export function startCloud(cfg: CloudConfig): Promise<Cloud> {
  const log = cfg.log ?? (() => {});
  const state = new State(cfg.accounts, cfg.statePath);
  const codes = new AgentCodes(Date.now, cfg.publicUrl ?? null, cfg.maxPendingCodes ?? 256);
  let sshd: SshHandle | null = null;

  const agentByRoom = new Map<string, AgentConn>(); // roomId → conn
  const deviceConns = new Set<DeviceConn>();
  const pendingPairs = new Map<string, { host: WebSocket; owner: WebSocket; finish: (ok: boolean, reason?: string) => void }>();
  const cancelPairs = (ws: WebSocket, side: "host" | "owner", reason?: string): void => {
    for (const pair of pendingPairs.values()) if (pair[side] === ws) pair.finish(false, reason);
  };

  // ---- SSH bridges: a reachable front door for the SSH leg --------------------
  // A bridge runs on any host with an open port (e.g. a tiny VPS), dials the cloud
  // over wss (outbound only) and pipes raw SSH bytes both ways. Device auth, scopes
  // and the read-only allowlist all live in the sshd behind the gate — the bridge
  // carries no secrets, so the account token (owner-level) is its credential.
  interface BridgeConn {
    ws: WebSocket;
    account: Account;
    /** What phones should dial ({host, port}); when set, the device hello prefers it. */
    advertise: { host: string; port: number } | null;
  }
  const bridges = new Set<BridgeConn>();

  /** A virtual SSH client socket: bytes arrive from / leave to a bridged wss frame. */
  class VirtualSshSocket extends Duplex {
    readonly remoteAddress: string; // the sshd's strike map sees this source — documented
    readonly remoteFamily = "IPv4";
    readonly remotePort = 0;
    constructor(addr: string) {
      super({ allowHalfOpen: false });
      this.remoteAddress = addr;
    }
    // ssh2 (isWritable) also reads these — Duplex provides writable/_readableState.
    _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
      this.emit("tobytes", chunk);
      cb(null);
    }
    _read(): void {
      /* pushed from the bridge leg */
    }
  }

  // ---- room streams (resume support) ----
  // Messages a phone must not lose while it is away (host frames, presence) are
  // stamped with a room-scoped `seq` and buffered briefly. A reconnecting device
  // says how far it read (`resume: { room, gen, seq }`) and gets the tail back;
  // `gen` changes whenever the gateway process is (re)started, which invalidates
  // stale bookkeeping in one comparison. `ssh.*` frames are ephemeral by
  // contract — they belong to an SSH channel that died with the drop — so they
  // are sent raw and never buffered or replayed.
  const STREAM_KEEP_MS = 120_000;
  const STREAM_MAX_BYTES = 256 * 1024;
  interface StreamMsg {
    seq: number;
    msg: Record<string, unknown>;
    bytes: number;
    at: number;
    device?: string;
  }
  interface RoomStream {
    gen: string;
    seq: number;
    buf: StreamMsg[];
    bytes: number;
    /** Everything at or below this was evicted: resuming from earlier = gap. */
    evictedUpTo: number;
  }
  const streams = new Map<string, RoomStream>();
  const streamOf = (roomId: string): RoomStream => {
    let s = streams.get(roomId);
    if (!s) {
      s = { gen: randomId("g"), seq: 0, buf: [], bytes: 0, evictedUpTo: 0 };
      streams.set(roomId, s);
    }
    return s;
  };
  const pendingWakes = new Set<string>();
  /** Push a wake to an away device. `note` (from the host) upgrades the ping to an
   *  encrypted payload when the subscription captured its p256dh/auth keys — the
   *  provider still sees only ciphertext; keyless subscriptions keep the silent ping. */
  const wakeDevice = (deviceId: string, note?: WakeNote): void => {
    const push = cfg.push;
    const rec = state.deviceById(deviceId);
    const endpoint = pushEndpoint(rec?.push?.endpoint ?? "");
    if (!push || !endpoint || pendingWakes.has(deviceId) || pendingWakes.size >= 8) return;
    pendingWakes.add(deviceId);
    const send = async (): Promise<void> => {
      const keys = rec?.push;
      if (note && keys && canPayload(keys)) {
        const payload = Buffer.from(JSON.stringify({
          v: 1, kind: note.kind, room: rec!.roomId, ...(note.agent ? { agent: note.agent } : {}),
        }), "utf8");
        const body = encryptPayload(payload, keys.p256dh!, keys.auth!);
        return sendPush(endpoint, push.keys, push.sub, body, note.kind === "needs-you" || note.kind === "died" ? "high" : "normal");
      }
      return sendPush(endpoint, push.keys, push.sub, null, "normal");
    };
    void send().catch(() => log("push: wake failed")).finally(() => pendingWakes.delete(deviceId));
  };

  const streamEmit = (roomId: string, msg: Record<string, unknown>, device?: string): void => {
    const s = streamOf(roomId);
    s.seq += 1;
    const stamped = { ...msg, seq: s.seq };
    const text = encode(stamped);
    const bytes = Buffer.byteLength(text);
    const at = Date.now();
    const evict = (): void => {
      const old = s.buf.shift();
      if (!old) return;
      s.bytes -= old.bytes;
      if (old.seq > s.evictedUpTo) s.evictedUpTo = old.seq;
    };
    while (s.buf.length && s.buf[0].at < at - STREAM_KEEP_MS) evict();
    if (bytes > STREAM_MAX_BYTES) {
      // Too big to ever keep: a hole for anyone not connected right now.
      if (s.seq > s.evictedUpTo) s.evictedUpTo = s.seq;
    } else {
      while (s.bytes + bytes > STREAM_MAX_BYTES) evict();
      s.buf.push({ seq: s.seq, msg: stamped, bytes, at, device });
      s.bytes += bytes;
    }
    for (const c of deviceConns) {
      if (c.device?.roomId !== roomId || (device !== undefined && c.device.id !== device)) continue;
      sendText(c.ws, text);
    }
  };

  // ---- rate limiting: failed hellos per client ----
  // The key is the client address, with two guards against a shared-address
  // collapse (audit gateway:shared-address-ip-controls): loopback connections
  // (a same-host proxy like cloudflared) always get a per-connection key, and a
  // trusted-proxy header restores real per-client keys behind an edge.
  const fails = new Map<string, { n: number; until: number; at: number }>();
  const FAILS_MAX = 4_096;
  const loopbackOf = (addr: string): boolean => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  const clientKeyOf = (req: IncomingMessage): string => {
    const addr = req.socket.remoteAddress ?? "?";
    if (cfg.trustedProxy) {
      const raw = cfg.realIpHeader ? req.headers[cfg.realIpHeader.toLowerCase()] : undefined;
      const value = (Array.isArray(raw) ? raw[0] : raw) ?? "";
      const ip = String(value).trim();
      if (ip && !ip.includes(",") && isIP(ip) !== 0) return ip;
      return `${addr}#${randomId("k")}`; // no usable header: never share a budget
    }
    if (loopbackOf(addr)) return `${addr}#${randomId("k")}`;
    return addr;
  };
  const pruneFails = (): void => pruneBudget(fails, FAILS_MAX, 60_000);
  const strike = (key: string): void => {
    pruneFails();
    const f = fails.get(key) ?? { n: 0, until: 0, at: Date.now() };
    f.n += 1;
    f.at = Date.now();
    if (f.n >= 5) {
      f.until = Date.now() + 60_000;
      f.n = 0;
    }
    fails.set(key, f);
  };
  const blocked = (key: string): boolean => {
    const f = fails.get(key);
    return !!f && f.until > Date.now();
  };

  // Per-client pairing-code mint rate (audit pairing:unbounded-code-mint).
  const MINT_PER_KEY = 10;
  const MINT_WINDOW_MS = 10 * 60_000;
  const mints = new Map<string, { n: number; until: number; at: number }>();
  // The budget map itself must stay bounded too (audit
  // gateway:mint-budget-map-unbounded): per-connection keys behind a
  // same-host proxy must not accumulate forever.
  const MINTS_MAX = 4_096;
  const pruneMints = (): void => pruneBudget(mints, MINTS_MAX, MINT_WINDOW_MS);

  const sendText = (ws: WebSocket, text: string | Buffer): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const size = typeof text === "string" ? Buffer.byteLength(text) : text.length;
    if (ws.bufferedAmount + size > 1024 * 1024) return ws.terminate();
    try { ws.send(text); } catch { ws.terminate(); }
  };
  const send = (ws: WebSocket, msg: Record<string, unknown>): void => sendText(ws, encode(msg));
  const fail = (ws: WebSocket, code: string, message: string): void => send(ws, { t: "error", code, message });

  /** Host hello `info`: strings only, few keys, sane lengths — anything else is
   *  dropped whole (never partially trusted), keeping the roster honest. */
  const asHostInfo = (v: unknown): { name?: string; version?: string } | undefined => {
    if (typeof v !== "object" || v === null) return undefined;
    const keys = Object.keys(v);
    if (keys.length > 4) return undefined;
    const o = v as Record<string, unknown>;
    for (const k of ["name", "version"]) {
      if (k in o && !(typeof o[k] === "string" && (o[k] as string).length > 0 && (o[k] as string).length <= 64)) return undefined;
    }
    return { name: typeof o.name === "string" ? o.name : undefined, version: typeof o.version === "string" ? o.version : undefined };
  };

  // ---- registry helpers ----
  const deviceViews = (roomId: string): DeviceView[] =>
    state.devicesOfRoom(roomId).map((d) => ({
      id: d.id,
      name: d.name,
      scope: d.scope,
      connected: [...deviceConns].some((c) => c.device?.id === d.id),
    }));

  const pushRoomUpdate = (roomId: string): void => {
    const a = agentByRoom.get(roomId);
    if (a) send(a.ws, { t: "room.update", devices: deviceViews(roomId) });
  };

  const pushPresence = (roomId: string, online: boolean): void => {
    streamEmit(roomId, { t: "presence", roomId, online });
  };

  const agentViews = (accountId: string) =>
    state.roomsOfAccount(accountId).map((r) => ({
      roomId: r.id,
      name: r.name,
      online: agentByRoom.has(r.id),
    }));

  // ---- WebSocket plumbing ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const keepAlive = (ws: WebSocket): void => {
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const iv = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, cfg.heartbeatMs ?? 8_000);
    iv.unref?.();
    ws.once("close", () => clearInterval(iv));
  };

  /** Token bucket: returns false when over the rate (the caller closes 1008). */
  const bucket = (perSec = RATE_MSG_PER_S, burst = RATE_BURST) => {
    let tokens = burst;
    let last = Date.now();
    return (): boolean => {
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSec);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  };

  const upgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, leg: "agent" | "device" | "bridge" | "ssh-ws"): void => {
    const key = clientKeyOf(req);
    if (blocked(key)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // ws emits receiver errors on the connection, including before its app hello.
      ws.on("error", () => ws.terminate());
      if (leg === "agent") attachAgent(ws, key);
      else if (leg === "bridge") attachBridge(ws, key);
      else if (leg === "ssh-ws") attachSshTunnel(ws, key);
      else attachDevice(ws, key);
    });
  };

  const attachAgent = (ws: WebSocket, ip: string): void => {
    let conn: AgentConn | null = null;
    let done = false;
    const take = bucket();
    const helloTimer = setTimeout(() => {
      if (!done) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    keepAlive(ws);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text only");
      // Size is enforced by `maxPayload` on the server; decode still guards shape.
      if (conn && !take()) return ws.close(1008, "rate");
      const m = decode(String(data));
      if (!m) return fail(ws, "bad-message", "not a v1 envelope");

      if (!conn) {
        if (m.t !== "hello" || typeof m.roomToken !== "string") {
          strike(ip);
          return ws.close(4001, "bad hello");
        }
        const room = state.roomByTokenHash(sha256Hex(m.roomToken));
        if (!room) {
          strike(ip);
          return ws.close(4001, "unknown room token");
        }
        done = true;
        clearTimeout(helloTimer);
        const old = agentByRoom.get(room.id);
        if (old) {
          cancelPairs(old.ws, "host", "host reconnected; try Pair again");
          send(old.ws, { t: "error", code: "superseded", message: "another connection took this room" });
          old.ws.close(4000, "superseded");
        }
        conn = { ws, room };
        agentByRoom.set(room.id, conn);
        // Host info: absent key → honest absence (clear stale); present but
        // invalid → ignored whole (the last valid hello stands).
        const rawInfo = (m as { info?: unknown }).info;
        if (rawInfo === undefined) state.setRoomHostInfo(room.id, undefined);
        else {
          const parsed = asHostInfo(rawInfo);
          if (parsed) state.setRoomHostInfo(room.id, parsed);
        }
        log(`agent ${room.id} (${room.name}) connected`);
        send(ws, { t: "hello", roomId: room.id, roomName: room.name, devices: deviceViews(room.id), resumed: false });
        pushPresence(room.id, true);
        return;
      }

      const room = conn.room;
      if (agentByRoom.get(room.id)?.ws !== ws) return;
      switch (m.t) {
        case "frame": {
          const device = typeof m.device === "string" ? m.device : null;
          if (!device) return fail(ws, "bad-message", "frame.device");
          const payload = m.payload;
          const isSsh = typeof payload === "object" && payload !== null && typeof (payload as { op?: unknown }).op === "string" && String((payload as { op: string }).op).startsWith("ssh.");
          // Host→device ssh.* frames also feed the sshd, which writes them into the
          // phone's SSH channel; the payload stays opaque to this layer either way.
          if (isSsh) {
            if (state.deviceById(device)?.roomId !== room.id) return;
            if (sshd?.onHostFrame(device, payload as Record<string, unknown>)) return;
            // Ephemeral: raw, unstamped, never buffered (see room streams above).
            const text = encode({ t: "frame", payload });
            for (const c of deviceConns) {
              if (c.device?.id === device) sendText(c.ws, text);
            }
            return;
          }
          if (state.deviceById(device)?.roomId !== room.id) return;
          streamEmit(room.id, { t: "frame", payload }, device);
          return;
        }
        case "presence": {
          pushPresence(room.id, m.online === true);
          return;
        }
        case "pair.response": {
          const requestId = typeof m.requestId === "string" ? m.requestId : null;
          const pair = requestId ? pendingPairs.get(requestId) : null;
          if (!pair || pair.host !== ws) return fail(ws, "bad-message", "unknown requestId");
          pair.finish(m.ok === true);
          return;
        }
        case "wake": {
          // The host asks for a phone to be woken: deliver a silent push only if the
          // device is not connected right now (a connected one is already live). A
          // `note` upgrades the ping to an encrypted payload (settle / died / needs-you)
          // when the subscription carries its RFC 8291 keys.
          if (!cfg.push) return fail(ws, "no-push", "push is not configured");
          const deviceId = typeof m.device === "string" ? m.device : null;
          if (!deviceId) return fail(ws, "bad-message", "wake.device");
          const rec = state.deviceById(deviceId);
          if (!rec || rec.roomId !== room.id) return fail(ws, "no-such-device", "not one of this room's devices");
          const rawNote = m.note;
          let note: WakeNote | undefined;
          if (rawNote && typeof rawNote === "object") {
            const kind = (rawNote as { kind?: unknown }).kind;
            const agent = (rawNote as { agent?: unknown }).agent;
            if (kind !== "settle" && kind !== "died" && kind !== "needs-you" && kind !== "activity") {
              return fail(ws, "bad-message", "wake.note.kind");
            }
            note = { kind, ...(typeof agent === "string" && agent.length <= 64 ? { agent: agent.slice(0, 64) } : {}) };
          }
          if ([...deviceConns].some((c) => c.device?.id === deviceId)) return;
          wakeDevice(deviceId, note);
          return;
        }
        case "ping":
          return send(ws, { t: "pong", n: m.n ?? 0 });
        default:
          return fail(ws, "unknown", `agent leg has no ${m.t}`);
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      cancelPairs(ws, "host", "host disconnected; try Pair again once it is online");
      if (conn && agentByRoom.get(conn.room.id)?.ws === ws) {
        agentByRoom.delete(conn.room.id);
        log(`agent ${conn.room.id} disconnected`);
        pushPresence(conn.room.id, false);
        pushRoomUpdate(conn.room.id);
      }
    });
  };

  /**
   * The bridge leg (`/v1/bridge/ws`): owner-token hello, then `bridge.open/data/close`
   * frames carrying one phone's raw SSH bytes each. Bytes land in the sshd through a
   * virtual socket — auth, scopes and the allowlist are unchanged, inside SSH.
   */
  const attachBridge = (ws: WebSocket, ip: string): void => {
    let conn: BridgeConn | null = null;
    let done = false;
    const sessions = new Map<string, VirtualSshSocket>();
    const take = bucket(600, 1200); // SSH chunks: higher ceiling than interactive legs
    const helloTimer = setTimeout(() => {
      if (!done) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    keepAlive(ws);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text only");
      const m = decode(String(data));
      if (!m) return fail(ws, "bad-message", "not a v1 envelope");
      if (conn && !take()) return ws.close(1008, "rate");

      if (!conn) {
        if (m.t !== "hello" || typeof m.bridgeToken !== "string") {
          strike(ip);
          return ws.close(4001, "bad hello");
        }
        const bridgeToken = m.bridgeToken;
        const account = typeof bridgeToken === "string" ? (cfg.accounts.find((a) => sameSecret(a.token, bridgeToken)) ?? null) : null;
        if (!account) {
          strike(ip);
          return ws.close(4001, "unknown bridge token");
        }
        if (!sshd) {
          return ws.close(4001, "ssh leg disabled on this cloud");
        }
        const ad = m.advertise;
        const advertise =
          ad && typeof ad === "object" && typeof (ad as { host?: unknown }).host === "string" && typeof (ad as { port?: unknown }).port === "number" && Number.isSafeInteger((ad as { port: number }).port) && (ad as { port: number }).port > 0 && (ad as { port: number }).port < 65536
            ? { host: String((ad as { host: string }).host).slice(0, 255), port: (ad as { port: number }).port }
            : null;
        done = true;
        clearTimeout(helloTimer);
        conn = { ws, account, advertise };
        bridges.add(conn);
        log(`bridge (${account.name}) connected${advertise ? ` — phones dial ${advertise.host}:${advertise.port}` : ""}`);
        send(ws, { t: "hello", ok: true });
        return;
      }

      switch (m.t) {
        case "bridge.open": {
          const sid = typeof m.sid === "string" ? m.sid : "";
          if (!sid || sessions.has(sid)) return fail(ws, "bad-message", "bridge.open.sid");
          if (!sshd) return fail(ws, "no-ssh", "ssh leg disabled");
          const sock = new VirtualSshSocket("bridge");
          sessions.set(sid, sock);
          sock.on("tobytes", (chunk: Buffer) => send(ws, { t: "bridge.data", sid, b64: chunk.toString("base64") }));
          sock.on("close", () => {
            sessions.delete(sid);
            send(ws, { t: "bridge.close", sid });
          });
          sshd.inject(sock as unknown as import("node:net").Socket);
          return;
        }
        case "bridge.data": {
          const sid = typeof m.sid === "string" ? m.sid : "";
          const sock = sessions.get(sid);
          if (!sock || typeof m.b64 !== "string") return fail(ws, "bad-message", "bridge.data");
          sock.push(Buffer.from(m.b64, "base64"));
          return;
        }
        case "bridge.close": {
          const sid = typeof m.sid === "string" ? m.sid : "";
          const sock = sessions.get(sid);
          if (sock) {
            sock.push(null); // EOF into the sshd
            sock.destroy();
          }
          return;
        }
        case "ping":
          return send(ws, { t: "pong", n: m.n ?? 0 });
        default:
          return fail(ws, "unknown", `bridge leg has no ${m.t}`);
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      for (const sock of sessions.values()) sock.destroy();
      sessions.clear();
      if (conn && bridges.has(conn)) {
        bridges.delete(conn);
        log(`bridge (${conn.account.name}) disconnected`);
      }
    });
  };

  /**
   * The ssh-ws leg (`/v1/ssh/ws`): one WebSocket = one raw SSH connection, piped
   * into the sshd via `inject`. For clients whose network cannot reach the TCP
   * leg (IPv4-only vs an AAAA-only host) — the tunnel rides port 443 like the
   * web app. No pre-auth: the SSH protocol itself authenticates (device id +
   * publickey/password) and the sshd's strike map keys on the tunnel's client key —
   * a real address, a trusted-proxy header value, or a per-connection key for
   * same-host proxies (audit gateway:shared-address-ip-controls).
   */
  const sshTunnels = new Map<string, number>();
  const SSH_TUNNELS_PER_KEY = Math.max(1, Math.min(1_024, cfg.sshTunnelLimits?.perKey ?? 6));
  const SSH_TUNNELS_TOTAL = Math.max(1, Math.min(1_024, cfg.sshTunnelLimits?.total ?? 64));
  const attachSshTunnel = (ws: WebSocket, key: string): void => {
    const n = sshTunnels.get(key) ?? 0;
    const total = [...sshTunnels.values()].reduce((a, b) => a + b, 0);
    if (!sshd || n >= SSH_TUNNELS_PER_KEY || total >= SSH_TUNNELS_TOTAL) {
      ws.close(1013, !sshd ? "ssh leg disabled" : "busy");
      return;
    }
    sshTunnels.set(key, n + 1);
    keepAlive(ws);
    const sock = new VirtualSshSocket(key);
    let closed = false;
    const bye = (): void => {
      if (closed) return;
      closed = true;
      const left = (sshTunnels.get(key) ?? 1) - 1;
      if (left > 0) sshTunnels.set(key, left);
      else sshTunnels.delete(key);
    };
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return ws.close(1003, "binary only");
      if (!sock.push(Buffer.from(data as Buffer))) ws.terminate();
    });
    ws.on("close", () => {
      bye();
      sock.push(null); // EOF: the sshd hangs up cleanly
      sock.destroy();
    });
    sock.on("tobytes", (chunk: Buffer) => sendText(ws, chunk));
    sock.on("close", () => {
      bye();
      // Do not let a peer hold the transport open after the SSH deadline or
      // revocation by declining to complete a WebSocket close handshake.
      ws.terminate();
    });
    sshd.inject(sock);
  };

  const attachDevice = (ws: WebSocket, ip: string): void => {
    let conn: DeviceConn | null = null;
    let done = false;
    const take = bucket();
    const helloTimer = setTimeout(() => {
      if (!done) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    keepAlive(ws);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text only");
      // Size is enforced by `maxPayload` on the server; decode still guards shape.
      if (conn && !take()) return ws.close(1008, "rate");
      const m = decode(String(data));
      if (!m) return fail(ws, "bad-message", "not a v1 envelope");

      if (!conn) {
        if (m.t !== "hello") {
          strike(ip);
          return ws.close(4001, "bad hello");
        }
        // Two identities: the owner (account token) or a paired device (id + its own secret).
        const wantsDevice = typeof m.device === "string" && typeof m.deviceSecret === "string";
        if (!wantsDevice && typeof m.accountToken !== "string") {
          strike(ip);
          return ws.close(4001, "bad hello");
        }
        let account: Account | null = null;
        let device: DeviceRecord | null = null;
        let viaDeviceSecret = false;
        if (wantsDevice) {
          device = state.deviceByCredentials(m.device as string, m.deviceSecret as string);
          if (!device) {
            strike(ip);
            return ws.close(4001, "unknown device credentials");
          }
          account = state.accountById(device.accountId);
          viaDeviceSecret = true;
        } else {
          account = state.accountByToken(m.accountToken as string);
          if (!account) {
            strike(ip);
            return ws.close(4001, "unknown account token");
          }
          if (typeof m.device === "string" && m.device) {
            const d = state.deviceById(m.device);
            device = d && d.accountId === account.id ? d : null;
            if (!device) return fail(ws, "unknown-device", "device id does not belong to this account");
          }
        }
        done = true;
        clearTimeout(helloTimer);
        conn = { ws, account: account!, device, viaDeviceSecret };
        deviceConns.add(conn);
        log(`device ${device ? device.id : "?"} (${account!.name}${viaDeviceSecret ? ", device key" : ""}) connected`);
        const agents = state.roomsOfAccount(account!.id).map((r) => {
          const mine = device && device.roomId === r.id ? device.scope : null;
          return { roomId: r.id, name: r.name, online: agentByRoom.has(r.id), scope: mine };
        });
        const helloMsg: Record<string, unknown> = {
          t: "hello",
          session: randomId("s"),
          device: device ? { id: device.id, name: device.name, scope: device.scope, roomId: device.roomId } : null,
          agents,
        };

        // Resume: a returning device replays what it missed (bounded, best effort).
        // No match (no resume, wrong room, stale gen, seq from another life) falls
        // through to a fresh hello — the device re-requests state on its own.
        const wantResume = ((): { room: string; device: string; gen: string; seq: number } | null => {
          if (!device) return null;
          const r = m.resume;
          if (typeof r !== "object" || r === null) return null;
          const room = (r as { room?: unknown }).room;
          const gen = (r as { gen?: unknown }).gen;
          const seq = (r as { seq?: unknown }).seq;
          if (room !== device.roomId || typeof gen !== "string") return null;
          if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
          return { room, device: device.id, gen, seq };
        })();
        const resuming = ((): { replay: StreamMsg[]; gap: boolean } | null => {
          if (!wantResume) return null;
          const s = streams.get(wantResume.room);
          if (!s || s.gen !== wantResume.gen || wantResume.seq > s.seq) return null;
          const tail = s.buf.filter((b) => b.seq > wantResume.seq);
          const replay = tail.filter((b) => b.device === undefined || b.device === wantResume.device);
          // Missed more than we kept: say so, the device re-syncs its state.
          const gap = tail.length < s.seq - wantResume.seq;
          return { replay, gap };
        })();

        if (resuming && device) {
          const s = streamOf(device.roomId);
          send(ws, {
            ...helloMsg,
            resumed: true,
            stream: { gen: s.gen, seq: s.seq, gap: resuming.gap },
          });
          for (const b of resuming.replay) {
            send(ws, b.msg);
          }
          if (resuming.gap) log(`device ${device.id} resumed with a gap (re-requests state)`);
        } else {
          const s = device ? streamOf(device.roomId) : null;
          send(ws, {
            ...helloMsg,
            resumed: false,
            ...(s ? { stream: { gen: s.gen, seq: s.seq } } : {}),
            ...((): Record<string, unknown> => {
              // A live bridge with an advertised address wins: phones reach the bridge,
              // not the gate machine (which may sit behind NAT with no IPv6).
              if (!cfg.ssh) return {};
              for (const b of bridges) if (b.advertise) return { ssh: { ...b.advertise } };
              // The real port (the listener may be ephemeral), falling back to config.
              return { ssh: { port: cfg.sshPublicPort ?? sshd?.port ?? cfg.ssh.port, ...(cfg.sshHost ? { host: cfg.sshHost } : {}) } };
            })(),
          });
        }
        if (device) pushRoomUpdate(device.roomId);
        return;
      }

      switch (m.t) {
        case "frame": {
          const device = conn.device;
          if (!device || state.deviceById(device.id) !== device) return fail(ws, "not-paired", "pair.begin first");
          const op = (m.payload as { op?: unknown } | null)?.op;
          if (typeof op === "string" && op.startsWith("ssh.")) return fail(ws, "bad-message", "SSH frames require an authenticated SSH channel");
          const agent = agentByRoom.get(device.roomId);
          if (!agent) return fail(ws, "host-offline", "the host is not connected");
          send(agent.ws, { t: "frame", device: device.id, payload: m.payload });
          return;
        }
        case "pair.begin": {
          if (conn.viaDeviceSecret) return fail(ws, "owner-only", "pairing uses the account token");
          const roomId = typeof m.roomId === "string" ? m.roomId : null;
          const name = typeof m.name === "string" ? m.name.trim().slice(0, 64) : "";
          const scope = m.scope;
          const room = roomId ? state.rooms.find((r) => r.id === roomId) : null;
          if (!room || room.accountId !== conn.account.id) return fail(ws, "no-such-room", "roomId is not one of yours");
          if (!name) return fail(ws, "bad-message", "pair.begin.name");
          if (!isScope(scope)) return fail(ws, "bad-message", "pair.begin.scope");
          grantPair(conn, room, name, scope);
          return;
        }
        case "ping":
          return send(ws, { t: "pong", n: m.n ?? 0 });
        default:
          return fail(ws, "unknown", `device leg has no ${m.t}`);
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      cancelPairs(ws, "owner");
      if (conn) {
        deviceConns.delete(conn);
        if (conn.device) pushRoomUpdate(conn.device.roomId);
      }
    });
  };

  /** `read` pairs at once; `act` needs the host's answer while this socket waits. */
  const grantPair = (conn: DeviceConn, room: RoomRecord, name: string, scope: "read" | "act"): void => {
    const finish = (): void => {
      const { device: rec, secret } = state.addDevice(room, name, scope);
      conn.device = rec;
      deviceConns.add(conn);
      send(conn.ws, {
        t: "pair.granted",
        device: { id: rec.id, name: rec.name, scope: rec.scope, roomId: rec.roomId },
        // One-time: the device stores it (PWA keeps it locally) and re-attaches with it.
        deviceSecret: secret,
      });
      pushRoomUpdate(room.id);
      log(`device ${rec.id} paired to ${room.id} (${scope})`);
    };
    if (scope === "read") return finish();
    const agent = agentByRoom.get(room.id);
    if (agent?.ws.readyState !== WebSocket.OPEN) return send(conn.ws, { t: "pair.denied", reason: "host offline" });
    const requestId = randomId("pr");
    const complete = (ok: boolean, reason = "denied on the host"): void => {
      clearTimeout(timer);
      pendingPairs.delete(requestId);
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      if (ok) finish();
      else send(conn.ws, { t: "pair.denied", reason });
    };
    const timer = setTimeout(() => complete(false, "host did not answer"), PAIR_ANSWER_MS);
    pendingPairs.set(requestId, { host: agent.ws, owner: conn.ws, finish: complete });
    send(agent.ws, { t: "pair.request", requestId, device: { name }, scope });
  };

  // ---- HTTP ----
  const hostOk = (req: IncomingMessage): boolean => {
    if (!cfg.expectedHost) return true;
    const host = (req.headers.host ?? "").toLowerCase();
    return host === cfg.expectedHost || host === `${cfg.expectedHost}:443` || host === `${cfg.expectedHost}:80`;
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const accountByAuth = (req: IncomingMessage): Account | null => {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return null;
    return cfg.accounts.find((a) => sameSecret(a.token, token)) ?? null;
  };

  const server = createServer((req, res) => {
    if (!hostOk(req)) {
      res.writeHead(421);
      return res.end("wrong host");
    }
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://x"); }
    catch { return json(res, 400, { error: "bad request target" }); }
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, BUILD_ID ? { "x-hg-build": BUILD_ID } : undefined);
      return res.end("ok");
    }

    if (req.method === "POST" && path === "/v1/agent/code") {
      const key = clientKeyOf(req);
      if (blocked(key)) return json(res, 429, { error: "rate limited" });
      // Two budgets so minting cannot be driven without limit (audit
      // pairing:unbounded-code-mint): a small per-client rate and a global
      // pending cap inside AgentCodes.
      pruneMints();
      const m = mints.get(key) ?? { n: 0, until: 0, at: Date.now() };
      const now = Date.now();
      if (m.until > now) {
        return json(res, 429, { error: "too many pairing codes; retry shortly" });
      }
      if (now - m.at > MINT_WINDOW_MS) m.n = 0;
      if (m.n >= MINT_PER_KEY) {
        m.until = now + MINT_WINDOW_MS;
        mints.set(key, m);
        return json(res, 429, { error: "too many pairing codes; retry shortly" });
      }
      m.n += 1;
      m.at = now;
      mints.set(key, m);
      return void readJsonBody(req).then((body) => {
        const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "host";
        const minted = codes.mint(name);
        if (!minted) return json(res, 429, { error: "too many pending pairing codes" });
        json(res, 200, minted);
      });
    }

    if (req.method === "POST" && path === "/v1/agent/approve") {
      const account = accountByAuth(req);
      if (!account) return json(res, 401, { error: "account token required" });
      return void readJsonBody(req).then(async (body) => {
        const code = typeof body?.code === "string" ? body.code : "";
        const st = codes.status(code);
        if (st.status !== "pending") return json(res, 404, { error: "unknown or used code" });
        // Re-mint the pending entry's room (fulfill binds the token to it).
        const minted = state.addRoom(account.id, st.hostName ?? "host");
        codes.fulfill(code, minted.token, minted.room.id);
        log(`room ${minted.room.id} (${minted.room.name}) approved by ${account.name}`);
        json(res, 200, { roomId: minted.room.id, name: minted.room.name });
      });
    }

    const statusMatch = path.match(/^\/v1\/agent\/code\/([A-Za-z0-9]+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      if (blocked(clientKeyOf(req))) return json(res, 429, { error: "rate limited" });
      const st = codes.status(statusMatch[1]);
      if (st.status === "unknown") return json(res, 404, { status: st.status });
      return json(res, 200, st);
    }

    if (cfg.push && req.method === "GET" && path === "/v1/push/key") {
      return json(res, 200, { publicKey: cfg.push.keys.publicBase64Url });
    }
    if (cfg.push && path === "/v1/device/push") {
      if (blocked(clientKeyOf(req))) return json(res, 429, { error: "rate limited" });
      // Two identities, same as the WS leg: the paired device (id + its own secret in
      // the body) or the owner (account token in Authorization, device id in the body).
      return void readJsonBody(req).then((body) => {
        const deviceId = typeof body?.device === "string" ? body.device : "";
        const deviceSecret = typeof body?.deviceSecret === "string" ? body.deviceSecret : "";
        let device: DeviceRecord | null = deviceId && deviceSecret ? state.deviceByCredentials(deviceId, deviceSecret) : null;
        if (!device) {
          const account = accountByAuth(req);
          if (!account) return json(res, 401, { error: "device credentials or account token required" });
          device = deviceId ? state.deviceById(deviceId) : null;
          if (!device || device.accountId !== account.id) return json(res, 403, { error: "not one of this account's devices" });
        }
        if (req.method === "DELETE") {
          state.setDevicePush(device.id, null);
          return json(res, 200, { ok: true });
        }
        const endpoint = typeof body?.endpoint === "string" && body.endpoint.length <= 2048 ? body.endpoint.trim() : "";
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        const validated = pushEndpoint(endpoint);
        if (!validated) return json(res, 400, { error: "unsupported push endpoint" });
        // Optional RFC 8291 keys: validate the shapes once here, then store verbatim.
        // A subscription without them keeps working as a silent wake ping.
        const p256dh = typeof body?.p256dh === "string" ? body.p256dh : "";
        const auth = typeof body?.auth === "string" ? body.auth : "";
        if ((p256dh || auth) && !canPayload({ p256dh, auth })) {
          return json(res, 400, { error: "bad push keys" });
        }
        const keys: PushKeys | undefined = p256dh && auth ? { p256dh, auth } : undefined;
        state.setDevicePush(device.id, validated.href, keys);
        return json(res, 200, { ok: true });
      });
    }

    // The owner's device roster (per room) and un-pairing. Account-token auth —
    // the same identity that approved the machine.
    if (path === "/v1/devices") {
      if (blocked(clientKeyOf(req))) return json(res, 429, { error: "rate limited" });
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const account = accountByAuth(req);
      if (!account) return json(res, 401, { error: "account token required" });
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const room = state.rooms.find((r) => r.id === (q.get("room") ?? ""));
      if (!room || room.accountId !== account.id) return json(res, 403, { error: "not one of this account's rooms" });
      const live = new Set<string>();
      for (const c of deviceConns) if (c.device) live.add(c.device.id);
      return json(res, 200, {
        host: room.hostInfo ? { name: room.hostInfo.name, version: room.hostInfo.version } : undefined,
        devices: state.devices
          .filter((d) => d.roomId === room.id)
          .map((d) => ({ id: d.id, name: d.name, scope: d.scope, connected: live.has(d.id), keys: (d.sshKeys ?? []).length, created: d.created, push: !!d.push, payload: canPayload(d.push) })),
      });
    }
    if (path === "/v1/device/revoke") {
      if (blocked(clientKeyOf(req))) return json(res, 429, { error: "rate limited" });
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const account = accountByAuth(req);
      if (!account) return json(res, 401, { error: "account token required" });
      return void readJsonBody(req).then((body) => {
        const deviceId = typeof body?.device === "string" ? body.device : "";
        const device = deviceId ? state.deviceById(deviceId) : null;
        if (!device || device.accountId !== account.id) return json(res, 404, { error: "no such device" });
        const gone = state.removeDevice(device.id);
        if (!gone) return json(res, 404, { error: "no such device" });
        for (const c of deviceConns) {
          if (c.device?.id === device.id) {
            deviceConns.delete(c);
            try { c.ws.close(4001, "revoked"); } catch { /* already gone */ }
          }
        }
        sshd?.revoke(device.id);
        pushRoomUpdate(device.roomId);
        log(`device ${device.id} (${device.name}) revoked by ${account.name}`);
        return json(res, 200, { ok: true });
      });
    }

    // Device SSH public keys: register the key of the machine that will `hc machine
    // add` this device, so system ssh logs in without a password prompt. Same two
    // identities as /v1/device/push (the device's own secret, or the owner's token).
    if (path === "/v1/device/sshkey") {
      if (blocked(clientKeyOf(req))) return json(res, 429, { error: "rate limited" });
      return void readJsonBody(req).then((body) => {
        // GET carries no body: the device id rides the query, its secret a header
        // (never a query string — those end up in proxy logs).
        const q = new URL(req.url ?? "/", "http://x").searchParams;
        const headerSecret = req.headers["x-herdgate-secret"];
        const deviceId = typeof body?.device === "string" ? body.device : q.get("device") ?? "";
        const deviceSecret = typeof body?.deviceSecret === "string" ? body.deviceSecret : typeof headerSecret === "string" ? headerSecret : "";
        let device: DeviceRecord | null = deviceId && deviceSecret ? state.deviceByCredentials(deviceId, deviceSecret) : null;
        if (!device) {
          const account = accountByAuth(req);
          if (!account) return json(res, 401, { error: "device credentials or account token required" });
          device = deviceId ? state.deviceById(deviceId) : null;
          if (!device || device.accountId !== account.id) return json(res, 403, { error: "not one of this account's devices" });
        }
        if (req.method === "GET") {
          return json(res, 200, {
            keys: (device.sshKeys ?? []).map((k) => ({ algo: k.algo, fp: sshKeyFingerprint(k.b64), comment: k.comment ?? "", at: k.at, b64: k.b64 })),
          });
        }
        if (req.method === "DELETE") {
          const b64 = typeof body?.b64 === "string" ? body.b64 : "";
          if (!b64) return json(res, 400, { error: "b64 required" });
          const removed = state.removeDeviceSshKey(device.id, b64);
          if (removed) sshd?.revoke(device.id, sshKeyFingerprint(b64));
          return json(res, removed ? 200 : 404, { ok: removed });
        }
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        const parsed = parseAuthorizedKey(typeof body?.pubkey === "string" ? body.pubkey : "");
        if (!parsed) return json(res, 400, { error: "bad pubkey (want an authorized_keys line: <algo> <base64> [comment])" });
        const added = state.addDeviceSshKey(device.id, parsed.algo, parsed.b64, parsed.comment);
        if (!added && !(state.deviceById(device.id)?.sshKeys ?? []).some((k) => k.algo === parsed.algo && k.b64 === parsed.b64)) {
          return json(res, 422, { error: "too many keys (max 5)" });
        }
        return json(res, 200, { ok: true, fp: sshKeyFingerprint(parsed.b64) });
      });
    }

    // The PWA, same-origin with the WS legs. Only GET/HEAD, and only after the API
    // routes above, so `/v1/*` can never be shadowed by a file.
    if ((req.method === "GET" || req.method === "HEAD") && cfg.webRoot) {
      return void serveStatic(res, cfg.webRoot, path);
    }

    res.writeHead(404);
    return res.end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    if (!hostOk(req)) {
      socket.write("HTTP/1.1 421 Misdirected Request\r\n\r\n");
      return socket.destroy();
    }
    let path: string;
    try { path = new URL(req.url ?? "/", "http://x").pathname; }
    catch { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    if (path === "/v1/agent/ws") return upgrade(req, socket, head, "agent");
    if (path === "/v1/device/ws") return upgrade(req, socket, head, "device");
    if (path === "/v1/bridge/ws") return upgrade(req, socket, head, "bridge");
    if (path === "/v1/ssh/ws") return upgrade(req, socket, head, "ssh-ws");
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve) => {
    server.listen(cfg.port ?? 0, cfg.bind ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      // The SSH leg shares this process (state + device sockets). `ssh` unset
      // disables it; port 0 gives an ephemeral listener.
      // The cloud resolves only once the leg is up or has failed, so callers see the truth.
      const sshPromise: Promise<SshHandle | null> = cfg.ssh
        ? startSshd({
            config: cfg.ssh,
            state,
            log,
            sendAsDevice: (deviceId, payload) => {
              const dev = state.deviceById(deviceId);
              if (!dev) return false;
              const agent = agentByRoom.get(dev.roomId);
              if (!agent) return false;
              send(agent.ws, { t: "frame", device: deviceId, payload });
              return true;
            },
            deviceOnline: (deviceId) => [...deviceConns].some((c) => c.device?.id === deviceId),
          }).catch((e) => {
            log(`ssh: failed to start (${e instanceof Error ? e.message : String(e)})`);
            return null;
          })
        : Promise.resolve(null);

      // Resolve the Cloud only once the sshd has bound (or cleanly failed):
      // a caller reading cloud.ssh?.port right after `await startCloud` used to
      // race the bind, fall back to port 22 in ssh2's defaults, and flake with
      // ECONNREFUSED under load (ssh.test.ts publickey, seen ~1/3 full runs).
      sshPromise.then((h) => {
        sshd = h;
        resolve({
        server,
        port,
          get ssh() {
            return sshd;
          },
          close: async () => {
            for (const ws of wss.clients) ws.terminate();
            await Promise.all([sshd?.close(), new Promise<void>((done) => server.close(() => done()))]);
          },
        });
      });
    });
  });
}

/** Silence the unused-import lint for Envelope (kept for API surface clarity). */
export type { Envelope };
