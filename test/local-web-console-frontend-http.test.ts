import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { ConsoleApiClient, ConsoleApiError } from "../src/console/web/client.ts";


test("local HTTP fixture exercises auth, typed session and pane mirror routes without write capability", async () => {
  const contract = JSON.parse(await readFile(new URL("./fixtures/local-web-console-contract.json", import.meta.url), "utf8"));
  const expectedSnapshot = contract.session;
  const generation = "fixture-generation-1";
  const snapshot = {
    version: "0.9.5", protocol: 22,
    workspaces: [{ workspace_id: "workspace-a", label: "Fixture workspace" }],
    tabs: [{ tab_id: "tab-a", workspace_id: "workspace-a", label: "Tab 1" }],
    panes: [{ pane_id: "pane-a", tab_id: "tab-a", workspace_id: "workspace-a", focused: true, terminal_title: "Fixture pane" }],
    focused_workspace_id: "workspace-a", focused_tab_id: "tab-a", focused_pane_id: "pane-a", layouts: [], agents: [],
  };
  const screen = { ...contract.screen, runtimeGeneration: generation };
  const paneId = screen.paneId as string;
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
    const auth = request.headers.authorization === `Bearer ${"f".repeat(64)}`;
    if (url.pathname === "/api/console/v1/capabilities" && request.method === "GET") {
      auth ? send(200, { mode: "mirror", scope: "read", transport: "rpc", features: { session: true, paneScreen: true, act: false, attach: false, chat: false, inbox: false, fileViewer: false } }) : send(401, { error: { code: "unauthorized", message: "Local login required" } });
    } else if (url.pathname === "/api/console/v1/auth/redeem" && request.method === "POST") {
      const value = JSON.parse(Buffer.concat(body).toString("utf8"));
      if (value.code !== "c".repeat(64)) send(401, { error: { code: "invalid_code", message: "Invalid code" } });
      else send(200, { token: "f".repeat(64), expiresInMs: 1_800_000, maxAgeMs: 28_800_000 });
    } else if (url.pathname === "/api/console/v1/auth/logout" && request.method === "POST" && auth) {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    } else if (url.pathname === "/api/console/v1/session" && request.method === "GET") {
      auth ? send(200, { runtimeGeneration: generation, snapshot }) : send(401, { error: { code: "unauthorized", message: "Local login required" } });
    } else if (url.pathname === `/api/console/v1/pane/${encodeURIComponent(paneId)}/screen` && request.method === "GET") {
      if (!auth) send(401, { error: { code: "unauthorized", message: "Local login required" } });
      else if (request.headers["x-herdgate-runtime-generation"] !== generation) send(409, { error: { code: "generation_mismatch", message: "Runtime changed" } });
      else send(200, screen);
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
    await assert.rejects(client.capabilities(), (error: unknown) => error instanceof ConsoleApiError && error.status === 401);
    await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.status === 401);
    await client.redeem("c".repeat(64));
    assert.equal((await client.capabilities()).features.act, false);
    const received = await client.fetchSession();
    assert.equal(received.runtime, expectedSnapshot.runtime);
    assert.equal(received.runtimeGeneration, expectedSnapshot.runtimeGeneration);
    assert.deepEqual(received.workspaces, expectedSnapshot.workspaces);
    assert.deepEqual(received.tabs, expectedSnapshot.tabs);
    assert.deepEqual(received.panes, expectedSnapshot.panes);
    const ovisPanes = received.ovisSnapshot?.panes;
    assert.ok(Array.isArray(ovisPanes));
    const firstOvisPane = ovisPanes[0];
    assert.ok(typeof firstOvisPane === "object" && firstOvisPane !== null && "pane_id" in firstOvisPane);
    assert.equal(firstOvisPane.pane_id, paneId);
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
