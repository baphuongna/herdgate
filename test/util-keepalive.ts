/**
 * A cloud stand-in for keepalive tests: it says hello and answers every `ping` with a
 * `pong` — until `mute()` is called. From then on it keeps every socket OPEN and says
 * nothing: a black hole in the cloud→host direction, exactly what a path that died
 * without a reset looks like from the host (the host's own packets leave, nothing comes
 * back, TCP keeps retransmitting for ~15–30 minutes).
 */
import { once } from "node:events";
import { WebSocketServer } from "ws";

export interface QuietCloud {
  port: number;
  conns: () => number;
  pings: () => number;
  mute: () => void;
  close: () => Promise<void>;
}

export async function quietCloud(): Promise<QuietCloud> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  let conns = 0;
  let pings = 0;
  let muted = false;
  wss.on("connection", (socket) => {
    conns += 1;
    socket.on("error", () => {});
    socket.on("message", (data) => {
      let m: { t?: string; n?: number };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.t === "hello") socket.send(JSON.stringify({ v: 1, t: "hello", roomId: "r_keepalive", roomName: "keepalive", devices: [] }));
      if (m.t === "ping") {
        pings += 1;
        if (!muted) socket.send(JSON.stringify({ v: 1, t: "pong", n: m.n ?? 0 }));
      }
    });
  });
  const addr = wss.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return {
    port: addr.port,
    conns: () => conns,
    pings: () => pings,
    mute: () => {
      muted = true;
    },
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds; throws with `what` after `ms`. */
export async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
