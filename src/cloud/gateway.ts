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

import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
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
import { type Account, type DeviceRecord, type RoomRecord, State } from "./stores.ts";
import { readJsonBody, randomId, sameSecret, sha256Hex } from "./util.ts";
import { serveStatic } from "./static.ts";
import { startSshd, type SshHandle, type SshConfig } from "./sshd.ts";
import { endpointTag, vapidHeader, type VapidKeys } from "./vapid.ts";

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
  /** The SSH leg phones dial. `port: 0` disables. */
  ssh?: SshConfig;
  /** VAPID keys for silent wake pushes; omit to disable the push endpoints. */
  push?: { keys: VapidKeys; /** mailto contact required by the VAPID spec. */ sub: string } | null;
  log?: (line: string) => void;
}

interface AgentConn {
  ws: WebSocket;
  room: RoomRecord;
  alive: boolean;
}
interface DeviceConn {
  ws: WebSocket;
  account: Account;
  device: DeviceRecord | null;
  alive: boolean;
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
  const codes = new AgentCodes(Date.now, cfg.publicUrl ?? null);
  let sshd: SshHandle | null = null;

  const agentByRoom = new Map<string, AgentConn>(); // roomId → conn
  const deviceConns = new Set<DeviceConn>();
  const pendingPairs = new Map<string, (ok: boolean) => void>(); // requestId → resolve

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
  /** Silent wake push to a device's stored endpoint (VAPID, no payload). */
  const wakeDevice = (deviceId: string): void => {
    const push = cfg.push;
    const endpoint = state.deviceById(deviceId)?.push?.endpoint;
    if (!push || !endpoint) return;
    const u = new URL(endpoint);
    const req = request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: {
          TTL: "60",
          Urgency: "normal",
          "content-length": "0",
          Authorization: vapidHeader(endpoint, push.keys, push.sub),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) log(`push: wake ${endpointTag(endpoint)} answered ${res.statusCode}`);
      },
    );
    req.on("error", (e) => log(`push: wake ${endpointTag(endpoint)} failed (${e instanceof Error ? e.message : String(e)})`));
    req.end();
  };

  const streamEmit = (roomId: string, msg: Record<string, unknown>): void => {
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
      s.buf.push({ seq: s.seq, msg: stamped, bytes, at });
      s.bytes += bytes;
    }
    for (const c of deviceConns) {
      if (c.device?.roomId !== roomId) continue;
      try {
        c.ws.send(text);
      } catch {
        /* closing */
      }
    }
  };

  // ---- rate limiting: failed hellos per IP ----
  const fails = new Map<string, { n: number; until: number }>();
  const ipOf = (req: IncomingMessage): string => req.socket.remoteAddress ?? "?";
  const strike = (ip: string): void => {
    const f = fails.get(ip) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= 5) {
      f.until = Date.now() + 60_000;
      f.n = 0;
    }
    fails.set(ip, f);
  };
  const blocked = (ip: string): boolean => {
    const f = fails.get(ip);
    return !!f && f.until > Date.now();
  };

  const send = (ws: WebSocket, msg: Record<string, unknown>): void => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(encode(msg));
      } catch {
        /* closing */
      }
    }
  };
  const fail = (ws: WebSocket, code: string, message: string): void => send(ws, { t: "error", code, message });

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

  const keepAlive = (getAlive: () => boolean, ws: WebSocket): NodeJS.Timeout => {
    const iv = setInterval(() => {
      if (!getAlive()) {
        ws.terminate();
        return;
      }
      ws.ping();
    }, 30_000);
    iv.unref?.();
    return iv;
  };

  /** Token bucket: returns false when over the rate (the caller closes 1008). */
  const bucket = () => {
    let tokens = RATE_BURST;
    let last = Date.now();
    return (): boolean => {
      const now = Date.now();
      tokens = Math.min(RATE_BURST, tokens + ((now - last) / 1000) * RATE_MSG_PER_S);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  };

  const upgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, leg: "agent" | "device"): void => {
    const ip = ipOf(req);
    if (blocked(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (leg === "agent") attachAgent(ws, ip);
      else attachDevice(ws, ip);
    });
  };

  const attachAgent = (ws: WebSocket, ip: string): void => {
    let conn: AgentConn | null = null;
    let done = false;
    const take = bucket();
    const helloTimer = setTimeout(() => {
      if (!done) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    const iv = keepAlive(() => conn?.alive ?? true, ws);

    ws.on("pong", () => {
      if (conn) conn.alive = true;
    });
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
          send(old.ws, { t: "error", code: "superseded", message: "another connection took this room" });
          old.ws.close(4000, "superseded");
        }
        conn = { ws, room, alive: true };
        agentByRoom.set(room.id, conn);
        log(`agent ${room.id} (${room.name}) connected`);
        send(ws, { t: "hello", roomId: room.id, roomName: room.name, devices: deviceViews(room.id), resumed: false });
        pushPresence(room.id, true);
        return;
      }

      const room = conn.room;
      switch (m.t) {
        case "frame": {
          const device = typeof m.device === "string" ? m.device : null;
          if (!device) return fail(ws, "bad-message", "frame.device");
          const payload = m.payload;
          const isSsh = typeof payload === "object" && payload !== null && typeof (payload as { op?: unknown }).op === "string" && String((payload as { op: string }).op).startsWith("ssh.");
          // Host→device ssh.* frames also feed the sshd, which writes them into the
          // phone's SSH channel; the payload stays opaque to this layer either way.
          if (isSsh) {
            sshd?.onHostFrame(device, payload as Record<string, unknown>);
            // Ephemeral: raw, unstamped, never buffered (see room streams above).
            const text = encode({ t: "frame", payload });
            for (const c of deviceConns) {
              if (c.device?.id !== device) continue;
              try {
                c.ws.send(text);
              } catch {
                /* closing */
              }
            }
            return;
          }
          streamEmit(room.id, { t: "frame", payload });
          return;
        }
        case "presence": {
          pushPresence(room.id, m.online === true);
          return;
        }
        case "pair.response": {
          const requestId = typeof m.requestId === "string" ? m.requestId : null;
          const resolve = requestId ? pendingPairs.get(requestId) : null;
          if (!requestId || !resolve) return fail(ws, "bad-message", "unknown requestId");
          pendingPairs.delete(requestId);
          resolve(m.ok === true);
          return;
        }
        case "wake": {
          // The host asks for a phone to be woken: deliver a silent push only if the
          // device is not connected right now (a connected one is already live).
          if (!cfg.push) return fail(ws, "no-push", "push is not configured");
          const deviceId = typeof m.device === "string" ? m.device : null;
          if (!deviceId) return fail(ws, "bad-message", "wake.device");
          const rec = state.deviceById(deviceId);
          if (!rec || rec.roomId !== room.id) return fail(ws, "no-such-device", "not one of this room's devices");
          if ([...deviceConns].some((c) => c.device?.id === deviceId)) return;
          wakeDevice(deviceId);
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
      clearInterval(iv);
      if (conn && agentByRoom.get(conn.room.id)?.ws === ws) {
        agentByRoom.delete(conn.room.id);
        log(`agent ${conn.room.id} disconnected`);
        pushPresence(conn.room.id, false);
        pushRoomUpdate(conn.room.id);
      }
    });
  };

  const attachDevice = (ws: WebSocket, ip: string): void => {
    let conn: DeviceConn | null = null;
    let done = false;
    const take = bucket();
    const helloTimer = setTimeout(() => {
      if (!done) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    const iv = keepAlive(() => conn?.alive ?? true, ws);

    ws.on("pong", () => {
      if (conn) conn.alive = true;
    });
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
        conn = { ws, account: account!, device, alive: true, viaDeviceSecret };
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
        const wantResume = ((): { room: string; gen: string; seq: number } | null => {
          if (!device) return null;
          const r = m.resume;
          if (typeof r !== "object" || r === null) return null;
          const room = (r as { room?: unknown }).room;
          const gen = (r as { gen?: unknown }).gen;
          const seq = (r as { seq?: unknown }).seq;
          if (room !== device.roomId || typeof gen !== "string") return null;
          if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
          return { room, gen, seq };
        })();
        const resuming = ((): { replay: StreamMsg[]; gap: boolean } | null => {
          if (!wantResume) return null;
          const s = streams.get(wantResume.room);
          if (!s || s.gen !== wantResume.gen || wantResume.seq > s.seq) return null;
          const replay = s.buf.filter((b) => b.seq > wantResume.seq);
          // Missed more than we kept: say so, the device re-syncs its state.
          const gap = replay.length < s.seq - wantResume.seq;
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
            try {
              ws.send(encode(b.msg));
            } catch {
              /* closing */
            }
          }
          if (resuming.gap) log(`device ${device.id} resumed with a gap (re-requests state)`);
        } else {
          const s = device ? streamOf(device.roomId) : null;
          send(ws, {
            ...helloMsg,
            resumed: false,
            ...(s ? { stream: { gen: s.gen, seq: s.seq } } : {}),
          });
        }
        if (device) pushRoomUpdate(device.roomId);
        return;
      }

      switch (m.t) {
        case "frame": {
          const device = conn.device;
          if (!device) return fail(ws, "not-paired", "pair.begin first");
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
      clearInterval(iv);
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
    if (!agent) return send(conn.ws, { t: "pair.denied", reason: "host offline" });
    const requestId = randomId("pr");
    const timer = setTimeout(() => {
      pendingPairs.delete(requestId);
      send(conn.ws, { t: "pair.denied", reason: "host did not answer" });
    }, PAIR_ANSWER_MS);
    pendingPairs.set(requestId, (ok) => {
      clearTimeout(timer);
      if (ok) finish();
      else send(conn.ws, { t: "pair.denied", reason: "denied on the host" });
    });
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
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200);
      return res.end("ok");
    }

    if (req.method === "POST" && path === "/v1/agent/code") {
      if (blocked(ipOf(req))) return json(res, 429, { error: "rate limited" });
      return void readJsonBody(req).then((body) => {
        const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "host";
        json(res, 200, codes.mint(name));
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
      if (blocked(ipOf(req))) return json(res, 429, { error: "rate limited" });
      const st = codes.status(statusMatch[1]);
      if (st.status === "unknown") return json(res, 404, { status: st.status });
      return json(res, 200, st);
    }

    if (cfg.push && req.method === "GET" && path === "/v1/push/key") {
      return json(res, 200, { publicKey: cfg.push.keys.publicBase64Url });
    }
    if (cfg.push && path === "/v1/device/push") {
      if (blocked(ipOf(req))) return json(res, 429, { error: "rate limited" });
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
        const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim().slice(0, 2048) : "";
        let u: URL;
        try {
          u = new URL(endpoint);
        } catch {
          return json(res, 400, { error: "bad endpoint" });
        }
        if (u.protocol !== "https:" && u.protocol !== "http:") return json(res, 400, { error: "bad endpoint" });
        state.setDevicePush(device.id, endpoint);
        return json(res, 200, { ok: true });
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
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/v1/agent/ws") return upgrade(req, socket, head, "agent");
    if (path === "/v1/device/ws") return upgrade(req, socket, head, "device");
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve) => {
    server.listen(cfg.port ?? 0, cfg.bind ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      // The SSH leg shares this process (state + device sockets). Disabled when ssh is
      // false or its port is 0.
      // `ssh` unset = disabled (tests and API-only runs); main.ts turns it on by default.
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

      void sshPromise.then((h) => {
        sshd = h;
        resolve({
        server,
        port,
          get ssh() {
            return sshd;
          },
          close: () =>
            new Promise<void>((done) => {
              for (const a of agentByRoom.values()) a.ws.close(1001, "server shutdown");
              for (const d of deviceConns) d.ws.close(1001, "server shutdown");
              void sshd?.close();
              server.close(() => done());
            }),
        });
      });
    });
  });
}

/** Silence the unused-import lint for Envelope (kept for API surface clarity). */
export type { Envelope };
