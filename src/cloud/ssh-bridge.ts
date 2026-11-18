/**
 * herdgate SSH bridge — a reachable front door for the SSH leg, on any host.
 *
 * The problem it solves: the Herdr phone app speaks plain SSH over TCP, which cannot
 * cross Cloudflare. When the gate machine itself has no reachable port (NAT, no
 * IPv6), run this on a host that does (a tiny VPS is enough): it dials the cloud over
 * an OUTBOUND WebSocket and pipes each phone's raw SSH bytes both ways. Everything
 * that matters — device-key auth, act-scope enforcement, the read-only allowlist,
 * brute-force strikes — stays in the cloud's sshd, untouched; the bridge carries no
 * secrets, so its credential is the account (owner) token.
 *
 * Zero dependencies beyond Node ≥ 22 (global WebSocket). One file: copy it to the
 * VPS and run it.
 *
 *   HERDGATE_URL               the cloud (e.g. https://gate.example.com)   (required)
 *   HERDGATE_BRIDGE_TOKEN      the account token — owner-level              (required)
 *   HERDGATE_BRIDGE_BIND       local TCP bind           (default 0.0.0.0)
 *   HERDGATE_BRIDGE_PORT       local TCP port           (default 2299)
 *   HERDGATE_BRIDGE_PUBLIC_HOST  advertise this host to phones (default: none —
 *   HERDGATE_BRIDGE_PUBLIC_PORT  with PUBLIC_HOST, the PWA's SSH hint shows it)
 *
 *   npm run ssh-bridge
 *   node ssh-bridge.ts          (standalone; no repo imports)
 */

import { createServer as tcpServer, type Socket } from "node:net";
import { hostname } from "node:os";

export interface BridgeOptions {
  /** The cloud base URL (https://…). */
  cloudUrl: string;
  /** Account (owner) token — the bridge is owner infrastructure carrying no secrets. */
  token: string;
  /** Local TCP listener. Defaults: 0.0.0.0:2299. */
  bind?: string;
  port?: number;
  /** Tell phones (via the device hello) to dial this address instead of the gate. */
  advertise?: { host: string; port: number } | null;
  log?: (line: string) => void;
}

export interface BridgeHandle {
  port: number;
  /** Resolves once the cloud accepted our hello — phones can dial from then on. */
  whenReady: Promise<void>;
  close(): Promise<void>;
}

/** Encode a v1 envelope. Inlined (no repo imports) so the file ships alone. */
const enc = (msg: Record<string, unknown>): string => JSON.stringify({ v: 1, ...msg });

export function startSshBridge(o: BridgeOptions): Promise<BridgeHandle> {
  const log = o.log ?? (() => {});
  const wsUrl = o.cloudUrl.replace(/\/$/, "").replace(/^http/, "ws") + "/v1/bridge/ws";
  const bind = o.bind ?? "0.0.0.0";
  const port = o.port ?? 2299;

  let ws: WebSocket | null = null;
  let backoff = 1_000;
  let closing = false;
  let sidSeq = 0;
  const sessions = new Map<string, Socket>();

  const server = tcpServer((sock) => {
    const sid = `bs_${++sidSeq}`;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sock.destroy(); // no cloud behind us: fail fast, the phone retries
      return;
    }
    sessions.set(sid, sock);
    ws.send(enc({ t: "bridge.open", sid }));
    sock.on("data", (d: Buffer) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc({ t: "bridge.data", sid, b64: d.toString("base64") }));
    });
    const bye = (): void => {
      if (sessions.delete(sid) && ws?.readyState === WebSocket.OPEN) ws.send(enc({ t: "bridge.close", sid }));
    };
    sock.on("close", bye);
    sock.on("error", bye);
  });

  /** Declared before `dial` so the catch can reference it (hoisting by hand). */
  let retry: () => void = () => {};
  let readyOk: () => void;
  /** Resolves on the first accepted cloud hello (rejects never; retries forever). */
  const whenReady = new Promise<void>((res) => {
    readyOk = res;
  });

  const dial = (): void => {
    if (closing) return;
    let sock2: WebSocket;
    try {
      sock2 = new WebSocket(wsUrl);
    } catch {
      return retry();
    }
    ws = sock2;
    sock2.onopen = () => {
      sock2.send(enc({
        t: "hello",
        bridgeToken: o.token,
        ...(o.advertise ? { advertise: o.advertise } : {}),
      }));
    };
    sock2.onmessage = (ev) => {
      let m: { t?: string; sid?: string; b64?: string; ok?: boolean };
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (m.t === "hello" && m.ok === true) {
        backoff = 1_000;
        readyOk();
        log(`connected to ${o.cloudUrl}${o.advertise ? ` (advertising ${o.advertise.host}:${o.advertise.port})` : ""}`);
        return;
      }
      if (m.t === "bridge.data" && m.sid && typeof m.b64 === "string") {
        const s = sessions.get(m.sid);
        if (s && !s.destroyed) s.write(Buffer.from(m.b64, "base64"));
        return;
      }
      if (m.t === "bridge.close" && m.sid) {
        const s = sessions.get(m.sid);
        if (s) {
          sessions.delete(m.sid);
          s.end();
          s.destroy();
        }
        return;
      }
    };
    retry = (): void => {
      const wait = Math.min(30_000, backoff) + Math.random() * 500;
      backoff *= 2;
      log(`disconnected from the cloud; retrying in ${Math.round(wait)}ms`);
      setTimeout(dial, wait).unref?.();
    };
    sock2.onclose = () => {
      // The cloud went away: end every phone session (they redial on their own).
      for (const s of sessions.values()) s.destroy();
      sessions.clear();
      ws = null;
      retry();
    };
    sock2.onerror = () => {
      /* onclose carries the retry */
    };
  };
  dial();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      const addr = server.address();
      const realPort = typeof addr === "object" && addr ? addr.port : port;
      log(`ssh bridge listening on ${bind}:${realPort} → ${o.cloudUrl} (${hostname()})`);
      resolve({
        port: realPort,
        whenReady,
        close: () =>
          new Promise<void>((done) => {
            closing = true;
            for (const s of sessions.values()) s.destroy();
            sessions.clear();
            try {
              // Plain close(): the WHATWG client API rejects close(1001) — only 1000
              // and 3000-4999 are valid client codes — and a throw here would leave
              // the socket (and the cloud's bridge registry) hanging open.
              ws?.close();
            } catch {
              /* already gone */
            }
            server.close(() => done());
          }),
      });
    });
  });
}

// ---- CLI (run directly) ------------------------------------------------------

const ranDirectly = process.argv[1]?.endsWith("ssh-bridge.ts");
if (ranDirectly) {
  const env = process.env;
  if (!env.HERDGATE_URL || !env.HERDGATE_BRIDGE_TOKEN) {
    console.error("ssh-bridge: HERDGATE_URL and HERDGATE_BRIDGE_TOKEN are required");
    process.exit(2);
  }
  const adv =
    env.HERDGATE_BRIDGE_PUBLIC_HOST
      ? {
          host: env.HERDGATE_BRIDGE_PUBLIC_HOST,
          port: Number(env.HERDGATE_BRIDGE_PUBLIC_PORT ?? env.HERDGATE_BRIDGE_PORT ?? 2299),
        }
      : null;
  const bridge = await startSshBridge({
    cloudUrl: env.HERDGATE_URL,
    token: env.HERDGATE_BRIDGE_TOKEN,
    bind: env.HERDGATE_BRIDGE_BIND,
    port: Number(env.HERDGATE_BRIDGE_PORT ?? 2299),
    advertise: adv,
    log: (l) => console.error(`herdgate-bridge: ${l}`),
  });
  console.error(`herdgate-bridge: phones dial ${adv ? `${adv.host}:${adv.port}` : `this host:${bridge.port}`}`);
  const bye = (): void => {
    void bridge.close().then(() => process.exit(0));
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
