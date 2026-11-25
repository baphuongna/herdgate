import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConsoleApiClient, ConsoleApiError } from "../src/console/web/client.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(projectRoot, "../herdgate-console-runtime");
const servicePath = path.join(runtimeRoot, "bin/console-service.mjs");
const fixtureAssets = path.join(runtimeRoot, "test/fixtures/local-web-console-runtime/console/dist");

test("ConsoleApiClient interoperates with the a9a260f runtime service contract", { skip: !existsSync(servicePath) }, async (t) => {
  const { createConsoleService } = await import(pathToFileURL(servicePath).href);
  const snapshot = {
    version: "0.9.5", protocol: 22,
    workspaces: [{ workspace_id: "w1", label: "Runtime fixture" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Tab 1" }],
    panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", focused: true, terminal_title: "Fixture shell" }],
    focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1", layouts: [], agents: [],
  };
  const rpcCalls: string[] = [];
  const service = createConsoleService({
    assetsDir: fixtureAssets,
    rpc: {
      snapshot: async () => { rpcCalls.push("session.snapshot"); return snapshot; },
      readPane: async (paneId: string) => { rpcCalls.push(`pane.read:${paneId}`); return { pane_id: paneId, text: "fixture ANSI\n", truncated: false, revision: 1, cols: 80, rows: 24 }; },
    },
  });
  await service.start();
  t.after(() => service.stop());
  const origin = service.origin;
  const client = new ConsoleApiClient((input, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.method === "POST") headers.set("origin", origin);
    return fetch(new URL(String(input), origin), { ...init, headers });
  });

  await assert.rejects(client.capabilities(), (error: unknown) => error instanceof ConsoleApiError && error.status === 401);
  await client.redeem(service.issueLoginCode());
  const capabilities = await client.capabilities();
  assert.equal(capabilities.mode, "mirror");
  assert.equal(capabilities.scope, "read");
  assert.equal(capabilities.transport, "rpc");
  const session = await client.fetchSession();
  assert.deepEqual(session.workspaces, [{ id: "w1", label: "Runtime fixture" }]);
  assert.deepEqual(session.tabs, [{ id: "w1:t1", workspaceId: "w1", label: "Tab 1" }]);
  assert.deepEqual(session.panes, [{ id: "w1:p1", tabId: "w1:t1", workspaceId: "w1", title: "Fixture shell" }]);
  const screen = await client.fetchScreen("w1:p1", session.runtimeGeneration!);
  assert.equal(screen.ansi, "fixture ANSI\n");
  assert.equal(screen.cols, 80);
  assert.equal(screen.rows, 24);
  assert.equal(screen.sequence, 1);
  await client.logout();
  assert.equal(client.authenticated, false);
  assert.deepEqual(rpcCalls, ["session.snapshot", "pane.read:w1:p1"]);
});
