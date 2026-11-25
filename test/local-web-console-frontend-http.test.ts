import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { ConsoleApiClient, ConsoleApiError } from "../src/console/web/client.ts";


test("local HTTP fixture exercises auth, typed session and pane mirror routes without write capability", async () => {
  const contract = JSON.parse(await readFile(new URL("./fixtures/local-web-console-contract.json", import.meta.url), "utf8"));
  const snapshot = contract.session;
  const screen = contract.screen;
  const paneId = screen.paneId as string;
  const generation = screen.runtimeGeneration as string;
  let changes = 0;
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}`);
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    const auth = request.headers.authorization === "Bearer fixture-tab-token";
    if (url.pathname === "/api/console/v1/capabilities" && request.method === "GET") {
      send(200, { mode: "read-only", console: "ready", runtime: "available", features: { session: true, mirror: true, act: false } });
    } else if (url.pathname === "/api/console/v1/auth/redeem" && request.method === "POST") {
      const value = JSON.parse(Buffer.concat(body).toString("utf8"));
      if (value.code !== "local-fixture-code") send(401, { error: { code: "invalid_code", message: "Invalid code" } });
      else send(200, { token: "fixture-tab-token", expiresAt: "2026-11-25T00:30:00.000Z" });
    } else if (url.pathname === "/api/console/v1/auth/logout" && request.method === "POST" && auth) {
      send(200, { ok: true });
    } else if (url.pathname === "/api/console/v1/session" && request.method === "GET") {
      auth ? send(200, { snapshot }) : send(401, { error: { code: "unauthenticated", message: "Login required" } });
    } else if (url.pathname === `/api/console/v1/pane/${encodeURIComponent(paneId)}/screen` && request.method === "GET") {
      if (!auth) send(401, { error: { code: "unauthenticated", message: "Login required" } });
      else if (url.searchParams.get("generation") !== generation) send(409, { error: { code: "generation_mismatch", message: "Runtime changed" } });
      else send(200, { screen });
    } else {
      // No write operation is implemented; an attempted direct act call is rejected without effect.
      send(404, { error: { code: "unsupported", message: "Not supported in read-only mode" } });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = new ConsoleApiClient((input, init) => fetch(new URL(String(input), origin), init));
  try {
    assert.equal((await client.capabilities()).features.act, false);
    await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.status === 401);
    await client.redeem("local-fixture-code");
    assert.deepEqual(await client.fetchSession(), snapshot);
    assert.deepEqual(await client.fetchScreen(paneId, generation), screen);
    const writeAttempt = await fetch(new URL(`/api/console/v1/pane/${encodeURIComponent(paneId)}/act`, origin), {
      method: "POST", headers: { authorization: "Bearer fixture-tab-token", "content-type": "application/json" }, body: JSON.stringify({ key: "x" }),
    });
    assert.equal(writeAttempt.status, 404);
    assert.equal(changes, 0);
    await client.logout();
    assert.equal(client.authenticated, false);
    await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.status === 401);
    assert.ok(seen.includes("GET /api/console/v1/session"));
    assert.ok(seen.includes(`GET /api/console/v1/pane/${encodeURIComponent(paneId)}/screen`));
    assert.ok(seen.includes(`POST /api/console/v1/pane/${encodeURIComponent(paneId)}/act`));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
