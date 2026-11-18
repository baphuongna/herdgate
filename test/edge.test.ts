/**
 * The public contract, tested without a tunnel: gateway behind the edge-sim (TLS + Host
 * rewrite + Upgrade splice), which is byte-for-byte the origin-side job cloudflared does.
 *
 * What going public actually demands of this code:
 *   - `expectedHost` pinning: a request whose Host is not the public hostname gets 421 —
 *     direct-to-origin probes included;
 *   - the PWA and both WS legs work over TLS through the edge (wss from a real client);
 *   - a full device flow over that path: sign in → pair read → the secret comes back once.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { startCloud } from "../src/cloud/gateway.ts";
import { startEdgeSim } from "../src/dev/edge-sim.ts";
import { encode } from "../src/protocol/envelope.ts";

const PINNED = "gate.herd.example";
const TOKEN = "edge-account-tok";

interface Recv {
  t: string;
  [k: string]: unknown;
}

/** One WS message, promise-style, over TLS with the self-signed dev cert. */
function wsCall(url: string, messages: Record<string, unknown>[], want: string[], timeoutMs = 8_000): Promise<Recv[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    const got: Recv[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`edge ws: wanted ${want.join(",")}, got ${got.map((m) => m.t).join(",") || "nothing"}`));
    }, timeoutMs);
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Recv;
      got.push(m);
      if (want.every((t) => got.some((g) => g.t === t))) {
        clearTimeout(timer);
        ws.close();
        resolve(got);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on("open", () => {
      for (const m of messages) ws.send(encode(m));
    });
  });
}

test("public contract: host pinning, TLS PWA, wss pairing through the edge", async () => {
  // A throwaway dev cert for 127.0.0.1 only.
  const dir = mkdtempSync(join(tmpdir(), "herdgate-edge-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-keyout", key, "-out", cert, "-days", "2", "-nodes",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });

    const cloud = await startCloud({
      accounts: [{ id: "a1", name: "owner", token: TOKEN }],
      expectedHost: PINNED,
      webRoot: new URL("../src/web/", import.meta.url).pathname,
      log: () => {},
    });
    const edge = await startEdgeSim({
      pinnedHost: PINNED,
      targetPort: cloud.port,
      certPath: cert,
      keyPath: key,
    });
    try {
      // 1. A direct-to-origin probe (any Host but the pinned one) is refused at the gate:
      //    with pinning on, NOTHING bypasses the edge - including this test's own calls.
      const { request: httpRequest } = await import("node:http");
      const direct = await new Promise<{ status: number; body: string }>((res, rej) => {
        const r = httpRequest({ host: "127.0.0.1", port: cloud.port, path: "/healthz", method: "GET", headers: { host: "127.0.0.1" } }, (up) => {
          let b = "";
          up.on("data", (c: Buffer) => (b += c.toString()));
          up.on("end", () => res({ status: up.statusCode ?? 0, body: b }));
        });
        r.on("error", rej);
        r.end();
      });
      assert.equal(direct.status, 421, "direct-to-origin probes get 421");
      assert.equal(direct.body, "wrong host");

      // 2. The right Host through the edge: healthz, the PWA shell, CSP intact.
      //    (Self-signed dev cert, so requests go through node:https with rejectUnauthorized.)
      const { request: httpsRequest } = await import("node:https");
      const health = await new Promise<{ status: number; body: string }>((res, rej) => {
        const r = httpsRequest({ host: "127.0.0.1", port: edge.port, path: "/healthz", method: "GET", rejectUnauthorized: false, headers: { host: PINNED } }, (up) => {
          let b = "";
          up.on("data", (c: Buffer) => (b += c.toString()));
          up.on("end", () => res({ status: up.statusCode ?? 0, body: b }));
        });
        r.on("error", rej);
        r.end();
      });
      assert.equal(health.status, 200);
      assert.equal(health.body, "ok");

      const get = (path: string): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> =>
        new Promise((res, rej) => {
          const r = httpsRequest(
            { host: "127.0.0.1", port: edge.port, path, method: "GET", rejectUnauthorized: false, headers: { host: PINNED } },
            (up) => {
              let body = "";
              up.on("data", (c: Buffer) => (body += c.toString()));
              up.on("end", () => res({ status: up.statusCode ?? 0, headers: up.headers, body }));
            },
          );
          r.on("error", rej);
          r.end();
        });

      const shell = await get("/");
      assert.equal(shell.status, 200);
      assert.match(String(shell.headers["content-type"]), /text\/html/);
      assert.match(String(shell.headers["content-security-policy"]), /default-src 'self'/, "the CSP travels through the edge");
      assert.match(shell.body, /id="signin"/, "the PWA is what the public URL serves");

      // 3. The full device flow over the edge - every HTTP call, like a real deployment.
      const callJson = (path: string, init?: { method?: string; body?: string; token?: string }): Promise<Record<string, unknown>> =>
        new Promise((res, rej) => {
          const r = httpsRequest(
            {
              host: "127.0.0.1", port: edge.port, path, method: init?.method ?? "GET",
              rejectUnauthorized: false,
              headers: { host: PINNED, "content-type": "application/json", ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}) },
            },
            (up) => {
              let b = "";
              up.on("data", (c: Buffer) => (b += c.toString()));
              up.on("end", () => {
                try {
                  res(JSON.parse(b) as Record<string, unknown>);
                } catch {
                  rej(new Error(`${path}: non-JSON ${up.statusCode}: ${b.slice(0, 60)}`));
                }
              });
            },
          );
          r.on("error", rej);
          if (init?.body) r.write(init.body);
          r.end();
        });

      const minted = (await callJson("/v1/agent/code", { method: "POST", body: JSON.stringify({ name: "edge-host" }) })) as { code: string };
      await callJson("/v1/agent/approve", { method: "POST", token: TOKEN, body: JSON.stringify({ code: minted.code }) });

      // The owner signs in over the edge and sees the room (no room token on this socket).
      const ownerGot = await wsCall(`wss://127.0.0.1:${edge.port}/v1/device/ws`, [{ t: "hello", accountToken: TOKEN, name: "owner-phone" }], ["hello"]);
      const hello = ownerGot.find((m) => m.t === "hello") as unknown as { agents: { roomId: string }[] };
      assert.equal(hello.agents.length, 1, "the room is visible through the edge");

      // The host agent connects through the edge too (wss is what a remote host uses).
      const { HerdGateAgent } = await import("../src/agent/index.ts");
      const st = (await callJson(`/v1/agent/code/${minted.code}/status`)) as { roomToken?: string };
      const agent = new HerdGateAgent({
        endpoint: `wss://127.0.0.1:${edge.port}/v1/agent/ws`,
        roomToken: st.roomToken!,
        adapter: { info: () => ({ name: "edge-host", version: "0" }), onFrame: () => {}, onDevices: () => {}, onPairAsk: () => true },
        log: () => {},
        wsOptions: { rejectUnauthorized: false },
      });
      agent.start();
      await agent.firstHello;
      agent.stop();

      // A device pairs read-only over the edge, with the one-time secret coming back.
      const pairGot = await wsCall(
        `wss://127.0.0.1:${edge.port}/v1/device/ws`,
        [
          { t: "hello", accountToken: TOKEN, name: "phone" },
          { t: "pair.begin", roomId: hello.agents[0].roomId, name: "phone", scope: "read" },
        ],
        ["pair.granted"],
      );
      const granted = pairGot.find((m) => m.t === "pair.granted") as unknown as { deviceSecret?: string };
      assert.ok(granted.deviceSecret, "the device key arrives over the public path");
    } finally {
      await edge.close();
      await cloud.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
