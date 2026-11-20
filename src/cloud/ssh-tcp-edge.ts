// Public TCP edge for native SSH clients. One connection = one SSH-over-WSS
// tunnel to the gate. No credentials, SSH termination, or room selection here.
import { createServer, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

interface EdgeOptions {
  gate: string;
  host?: string;
  port?: number;
  perIp?: number;
  total?: number;
}

function integer(label: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return value;
}

export async function startTcpEdge(options: EdgeOptions) {
  const host = options.host ?? "127.0.0.1";
  const gate = new URL(options.gate);
  const localTest = gate.protocol === "http:" && gate.hostname === "127.0.0.1" && host === "127.0.0.1";
  if ((!localTest && gate.protocol !== "https:") || gate.username || gate.password || gate.pathname !== "/" || gate.search || gate.hash) {
    throw new Error("HERDGATE_URL must be a credential-free HTTPS origin");
  }
  const url = new URL("/v1/ssh/ws", gate);
  url.protocol = localTest ? "ws:" : "wss:";
  const port = integer("port", options.port ?? 2299, 0, 65_535);
  const total = integer("total", options.total ?? 6, 1, 6); // the gate limits tunnels per source
  const perIp = integer("per-IP", options.perIp ?? Math.min(3, total), 1, total);
  const byIp = new Map<string, number>();
  const clients = new Set<Socket>();
  const maxBuffered = 512 * 1024;

  const server = createServer({ pauseOnConnect: true }, (sock) => {
    const ip = sock.remoteAddress;
    if (!ip || clients.size >= total || (byIp.get(ip) ?? 0) >= perIp) return sock.destroy();
    byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
    clients.add(sock);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15_000);

    const ws = new WebSocket(url, { handshakeTimeout: 8_000, maxPayload: 256 * 1024, perMessageDeflate: false });
    let alive = true;
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) return sock.destroy();
      alive = false;
      ws.ping();
    }, 12_000);
    heartbeat.unref();
    ws.on("pong", () => { alive = true; });
    ws.on("error", () => sock.destroy());
    ws.on("close", () => {
      if (sock.destroyed) return;
      // Flush any final SSH bytes, but never let a peer that stopped reading
      // keep a public connection slot after the upstream has gone away.
      const deadline = setTimeout(() => sock.destroy(), 2_000).unref();
      sock.once("close", () => clearTimeout(deadline));
      sock.end(() => sock.destroy());
    });
    ws.on("open", () => sock.resume());
    ws.on("message", (data, binary) => {
      if (sock.destroyed || !sock.writable) return;
      if (!binary || !Buffer.isBuffer(data) || sock.writableLength + data.length > maxBuffered) return sock.destroy();
      if (!sock.write(data)) ws.pause();
    });
    sock.on("drain", () => { if (ws.readyState === WebSocket.OPEN) ws.resume(); });
    sock.on("error", () => sock.destroy());
    sock.on("data", (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      sock.pause();
      ws.send(data, { binary: true }, (err) => { if (err) sock.destroy(); else sock.resume(); });
    });
    sock.once("close", () => {
      clearInterval(heartbeat);
      clients.delete(sock);
      const left = (byIp.get(ip) ?? 1) - 1;
      if (left) byIp.set(ip, left);
      else byIp.delete(ip);
      ws.terminate();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no TCP listener");
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => {
      for (const sock of clients) sock.destroy();
      server.close(() => resolve());
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    if (!env.HERDGATE_URL) throw new Error("set HERDGATE_URL to the public HTTPS gate origin");
    const opt = (name: string) => env[name] === undefined ? undefined : Number(env[name]);
    const host = env.HERDGATE_TCP_EDGE_BIND ?? "127.0.0.1";
    const edge = await startTcpEdge({ gate: env.HERDGATE_URL, host, port: opt("HERDGATE_TCP_EDGE_PORT"), perIp: opt("HERDGATE_TCP_EDGE_PER_IP"), total: opt("HERDGATE_TCP_EDGE_TOTAL") });
    console.error(`herdgate-tcp-edge: listening on ${host}:${edge.port}`);
    const stop = () => { void edge.close(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (err) {
    console.error(`herdgate-tcp-edge: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
