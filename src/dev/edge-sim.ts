/**
 * edge-sim: a local stand-in for the Cloudflare edge, so "public" behavior is testable
 * without a tunnel.
 *
 * cloudflared talks to the origin over plain HTTP to loopback, terminating TLS at the
 * edge and presenting the tunnel hostname in `Host`. This simulator does exactly that on
 * one box:
 *
 *   client ──TLS──▶ edge-sim (terminates, rewrites Host to the pinned name) ──HTTP──▶ gateway
 *
 * It exercises the gateway's real public contract: `expectedHost` pinning (wrong host →
 * 421), the PWA over TLS, and both WebSocket legs through an Upgrade pass-through.
 * For a real deployment see DEPLOY.md — the config this file proves is the config
 * cloudflared runs.
 */

import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as tcpConnect } from "node:net";
import { readFileSync } from "node:fs";

export interface EdgeSimOptions {
  /** The hostname the edge presents to the origin (`Host` is rewritten to this). */
  pinnedHost: string;
  /** The gateway's plain-HTTP endpoint. */
  targetPort: number;
  targetHost?: string;
  certPath: string;
  keyPath: string;
}

export interface EdgeSim {
  port: number;
  close(): Promise<void>;
}

export async function startEdgeSim(o: EdgeSimOptions): Promise<EdgeSim> {
  const targetHost = o.targetHost ?? "127.0.0.1";

  /** Proxy one normal request: same method/path/body, `Host` pinned. */
  const proxy = (req: IncomingMessage, res: ServerResponse): void => {
    const upstream = httpRequest(
      { host: targetHost, port: o.targetPort, path: req.url, method: req.method, headers: { ...req.headers, host: o.pinnedHost } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (e: NodeJS.ErrnoException) => {
      res.destroy();
      req.destroy();
      // Loud on purpose: the edge must never silently swallow an origin failure.
      throw Object.assign(new Error(`edge-sim upstream: ${e.message}`), { code: e.code });
    });
    req.pipe(upstream);
  };

  /** Proxy one Upgrade (WebSocket): splice the raw sockets, `Host` pinned. */
  const proxyUpgrade = (req: IncomingMessage, clientSocket: import("node:stream").Duplex, head: Buffer): void => {
    const upstream = tcpConnect(o.targetPort, targetHost, () => {
      const lines = [`Host: ${o.pinnedHost}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        if (name.toLowerCase() === "host") continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    const fail = (): void => {
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on("error", fail);
    clientSocket.on("error", fail);
  };

  const server = createHttpsServer({ cert: readFileSync(o.certPath), key: readFileSync(o.keyPath) }, proxy);
  server.on("upgrade", proxyUpgrade);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
