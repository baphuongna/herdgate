/**
 * HerdGateAgent: one outbound WebSocket from the host to the cloud, with
 * hello-first auth, exponential backoff + jitter on reconnect, and app-level
 * ping/pong. The old connection is superseded server-side when a new one hellos
 * with the same room token.
 */

import { encode } from "../protocol/envelope.ts";
import type { AgentToCloud, CloudToAgent, DeviceView } from "../protocol/agent.ts";
import { type AgentAdapter, type PairAsk } from "./adapter.ts";
import WebSocket from "ws";

export interface AgentOptions {
  endpoint: string; // wss://host/v1/agent/ws
  roomToken: string;
  adapter: AgentAdapter;
  log?: (line: string) => void;
  /** Reconnect bounds (ms). Defaults: 1s..30s, doubling, +0..500ms jitter. */
  backoff?: { minMs?: number; maxMs?: number };
  /** Passed to the underlying WebSocket (e.g. `rejectUnauthorized` for dev certs). */
  wsOptions?: Record<string, unknown>;
  /** Keepalive interval (ms). A ping goes out every interval; three silent intervals mean
   *  the cloud is gone and the socket is redialed. Default 25 s. */
  keepaliveMs?: number;
}

export class HerdGateAgent {
  readonly #o: AgentOptions;
  readonly #log: (line: string) => void;
  #ws: WebSocket | null = null;
  #stop = false;
  #attempt = 0;
  #devices: DeviceView[] = [];
  #firstHello!: () => void;
  /** Resolves after the cloud's first `hello`; rejects on stop before that. */
  readonly firstHello: Promise<void>;

  constructor(o: AgentOptions) {
    this.#o = o;
    this.#log = o.log ?? (() => {});
    this.firstHello = new Promise((res, rej) => {
      this.#firstHello = res;
      o.adapter.info; // touch: adapter is required at runtime by callers
      this.#stopPromiseCatch = rej;
    });
  }
  #stopPromiseCatch: (e: Error) => void = () => {};
  #unpaired = false;

  /** True once the gate said the room token no longer exists; no more dials after that. */
  get unpaired(): boolean {
    return this.#unpaired;
  }

  start(): void {
    this.#stop = false;
    this.#unpaired = false;
    this.#connect();
  }

  stop(): void {
    this.#stop = true;
    this.#stopPromiseCatch(new Error("agent stopped"));
    this.#ws?.close(1000, "stopped");
  }

  /** Opaque payload to one device. */
  send(device: string, payload: unknown): void {
    this.#send({ t: "frame", device, payload } satisfies AgentToCloud);
  }

  /** Ask the cloud to push-wake a device that is not connected (silent, no payload). */
  wake(device: string): void {
    this.#send({ t: "wake", device } satisfies AgentToCloud);
  }

  presence(online: boolean, detail?: string): void {
    this.#send({ t: "presence", online, detail } satisfies AgentToCloud);
  }

  /** Answer a `pair.request`. */
  respond(requestId: string, ok: boolean): void {
    this.#send({ t: "pair.response", requestId, ok } satisfies AgentToCloud);
  }

  get devices(): readonly DeviceView[] {
    return this.#devices;
  }

  scopeOf(device: string): "read" | "act" | null {
    return this.#devices.find((d) => d.id === device)?.scope ?? null;
  }

  #send(msg: AgentToCloud): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(encode(msg as unknown as Record<string, unknown>));
  }

  #connect(): void {
    if (this.#stop) return;
    const ws = new WebSocket(this.#o.endpoint, { maxPayload: 256 * 1024, ...this.#o.wsOptions });
    this.#ws = ws;
    let helloed = false;
    // Any frame from the cloud is proof of life; the keepalive below reads it.
    let lastInbound = Date.now();

    ws.on("open", () => {
      const info = this.#o.adapter.info();
      ws.send(encode({ t: "hello", roomToken: this.#o.roomToken, info }));
    });
    ws.on("message", (data) => {
      lastInbound = Date.now();
      let m: CloudToAgent;
      try {
        m = JSON.parse(String(data)) as CloudToAgent;
      } catch {
        return;
      }
      if (!helloed && m.t === "hello") {
        helloed = true;
        this.#attempt = 0;
        this.#devices = m.devices ?? [];
        this.#log(`cloud hello: room ${m.roomId} (${m.roomName}), ${this.#devices.length} device(s)`);
        this.#o.adapter.onDevices(this.#devices);
        this.#firstHello();
        return;
      }
      switch (m.t) {
        case "room.update":
          this.#devices = m.devices ?? [];
          this.#o.adapter.onDevices(this.#devices);
          return;
        case "frame":
          void this.#o.adapter.onFrame(m.device, m.payload);
          return;
        case "pair.request": {
          const ask: PairAsk = { requestId: m.requestId, device: m.device, scope: m.scope };
          void Promise.resolve(this.#o.adapter.onPairAsk(ask)).then((ok) => this.respond(ask.requestId, ok));
          return;
        }
        default:
          return;
      }
    });
    ws.on("error", (e) => this.#log(`ws error: ${e.message}`));
    ws.on("close", (code: number, reason: Buffer) => {
      if (this.#stop) return;
      // The gate removed this room: the token is gone for good. Redialing it would only
      // pile failed hellos onto this network's address (five of them block it for a minute).
      if (code === 4001 && reason.toString() === "unknown room token") {
        this.#unpaired = true;
        this.#log("cloud refused the room token: this host is no longer paired — run `herdgate pair` again");
        return;
      }
      const min = this.#o.backoff?.minMs ?? 1_000;
      const max = this.#o.backoff?.maxMs ?? 30_000;
      const wait = Math.min(max, min * 2 ** this.#attempt) + Math.random() * 500;
      this.#attempt += 1;
      this.#log(`disconnected; retry in ${Math.round(wait)}ms`);
      setTimeout(() => this.#connect(), wait);
    });

    // Keepalive with a verdict. The ping alone was not one: a path that died without a
    // reset leaves the socket "OPEN" and TCP retransmitting for ~15–30 minutes, so the host
    // kept believing it was published while the gate (8 s heartbeat) had dropped the room
    // minutes earlier (2026-11-21: tunnel back at 23:11:37, agent redialed at 23:21:04).
    // Three silent intervals ⇒ terminate; `close` owns the redial and its backoff.
    // (unref: a timer alone must not hold the process.)
    const keepaliveMs = this.#o.keepaliveMs ?? 25_000;
    const iv = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(iv);
      ws.send(encode({ t: "ping", n: Date.now() } as unknown as Record<string, unknown>));
      const silent = Date.now() - lastInbound;
      if (silent > 3 * keepaliveMs) {
        clearInterval(iv);
        this.#log(`cloud silent for ${Math.round(silent / 1000)}s; redialing`);
        ws.terminate();
      }
    }, keepaliveMs);
    iv.unref?.();
  }
}

/**
 * Host provisioning (device flow): mint a code, surface it to the human, poll
 * until an account approves it, return the room token. Store that token — it is
 * the host's long-lived credential (revoke = re-provision).
 */
export async function provision(o: {
  baseUrl: string; // http(s)://host[:port]
  name: string;
  onCode?: (info: { url: string; code: string }) => void;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<{ roomToken: string; roomId: string }> {
  const res = await fetch(`${o.baseUrl.replace(/\/$/, "")}/v1/agent/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: o.name }),
  });
  if (!res.ok) throw new Error(`agent/code: ${res.status}`);
  const minted = (await res.json()) as { code: string; url: string };
  // Both fields go to the caller: the url to click, the code for the pairing QR
  // (see ../agent/qr.ts — the PWA opens with `#pair=<code>` prefilled).
  (o.onCode ?? ((i) => console.log(`pair this host: ${i.url}`)))({ url: minted.url, code: minted.code });
  const deadline = Date.now() + (o.timeoutMs ?? 11 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, o.pollMs ?? 3_000));
    const st = (await (await fetch(`${o.baseUrl.replace(/\/$/, "")}/v1/agent/code/${minted.code}/status`)).json()) as {
      status: string;
      roomToken?: string;
      roomId?: string;
    };
    if (st.status === "approved" && st.roomToken) return { roomToken: st.roomToken, roomId: st.roomId! };
    if (st.status === "unknown") throw new Error("pairing code expired or unknown");
  }
  throw new Error("pairing timed out");
}
