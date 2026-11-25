import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createConsoleRpc } from "../bin/console-rpc.mjs";
import { CONSOLE_CSP, createConsoleService } from "../bin/console-service.mjs";
import { startFixtureRuntime } from "./fixtures/local-web-console-runtime/runtime.mjs";

const assets = new URL("./fixtures/local-web-console-runtime/console/dist/", import.meta.url).pathname;
const fixtureSnapshot = {
  version: "0.9.5", protocol: 22, workspaces: [{ workspace_id: "w1", label: "fixture" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", focused: true }],
  layouts: [], agents: [],
};

async function withService(t: TestContext, opts: { snapshot?: unknown; readText?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hg-console-service-"));
  const runtimePath = join(dir, "runtime.sock");
  const runtime = await startFixtureRuntime(runtimePath, { snapshot: opts.snapshot ?? fixtureSnapshot, readText: opts.readText });
  const logs: string[] = [];
  let now = 1_000_000;
  const rpc = createConsoleRpc({ connect: () => net.createConnection(runtimePath), timeoutMs: 300, paneTimeoutMs: 300 });
  const service = createConsoleService({ rpc, assetsDir: assets, now: () => now, log: (line: string) => logs.push(line) });
  await service.start();
  const origin = service.origin;
  t.after(async () => { await service.stop(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, runtime, logs, origin, advance: (ms: number) => { now += ms; } };
}

function getWithHost(url: string, host: string) {
  const target = new URL(url);
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.get({ host: target.hostname, port: Number(target.port), path: target.pathname, headers: { host } }, (response) => { response.resume(); resolve(response); });
    req.on("error", reject);
  });
}

async function login(origin: string, service: ReturnType<typeof createConsoleService>) {
  const code = service.issueLoginCode();
  const response = await fetch(`${origin}/api/console/v1/auth/redeem`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ code }),
  });
  return { response, code };
}

test("HTTP service serves manifest allowlist and authenticated read-only API on loopback", async (t) => {
  const h = await withService(t);
  const unauth = await fetch(`${h.origin}/api/console/v1/session`);
  assert.equal(unauth.status, 401);
  assert.equal(h.runtime.calls.length, 0, "unauthenticated requests do not reach runtime");

  const shell = await fetch(h.origin);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(shell.headers.get("access-control-allow-origin"), null);
  assert.equal(shell.headers.get("content-security-policy"), CONSOLE_CSP);
  assert.match(await shell.text(), /fixture-local-console|Fixture shell/);
  assert.equal((await fetch(`${h.origin}/assets/app.123abc.js`)).status, 200);
  for (const path of ["/assets/index-D0ahG_z6.js", "/assets/JetBrainsMono-Bold-D4WEaHbo.woff2"]) {
    const asset = await fetch(`${h.origin}${path}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  }
  const unhashed = await fetch(`${h.origin}/assets/app.123abc.js`);
  assert.equal(unhashed.headers.get("cache-control"), "no-store");
  const license = await fetch(`${h.origin}/notices/LICENSE`);
  assert.equal(license.status, 200);
  assert.equal(license.headers.get("content-type"), "text/plain; charset=utf-8");
  const thirdParty = await fetch(`${h.origin}/notices/THIRD_PARTY_NOTICES.md`);
  assert.equal(thirdParty.status, 200);
  assert.equal(thirdParty.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal((await fetch(`${h.origin}/not-in-manifest`)).status, 404);
  assert.equal((await fetch(`${h.origin}/../package.json`)).status, 404);

  const badHost = await getWithHost(`${h.origin}/api/console/v1/session`, "evil.example");
  assert.equal(badHost.statusCode, 403);
  const forwarded = await fetch(`${h.origin}/api/console/v1/session`, { headers: { "x-forwarded-host": "evil.example" } });
  assert.equal(forwarded.status, 403);
  const { response: redeemed, code } = await login(h.origin, h.service);
  assert.equal(redeemed.status, 200);
  const { token } = await redeemed.json() as { token: string };
  assert.ok(token.length >= 64);
  assert.equal(new URL(redeemed.url).search, "", "token is never returned in a URL");
  assert.equal(redeemed.url.includes(token), false);
  assert.equal(redeemed.url.includes(code), false);
  const replay = await fetch(`${h.origin}/api/console/v1/auth/redeem`, {
    method: "POST", headers: { "content-type": "application/json", origin: h.origin }, body: JSON.stringify({ code }),
  });
  assert.equal(replay.status, 401);

  const auth = { authorization: `Bearer ${token}` };
  const capabilities = await fetch(`${h.origin}/api/console/v1/capabilities`, { headers: auth });
  assert.equal(capabilities.status, 200);
  const capabilitiesBody = await capabilities.json() as { features: { act: boolean } };
  assert.deepEqual(capabilitiesBody.features.act, false);
  const sessionResponse = await fetch(`${h.origin}/api/console/v1/session`, { headers: auth });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { runtimeGeneration: string; snapshot: typeof fixtureSnapshot };
  assert.equal(session.snapshot.panes[0].pane_id, "w1:p1");
  assert.equal(typeof session.runtimeGeneration, "string");

  const wrongGeneration = await fetch(`${h.origin}/api/console/v1/pane/w1%3Ap1/screen`, {
    headers: { ...auth, "x-herdgate-runtime-generation": "stale" },
  });
  assert.equal(wrongGeneration.status, 409);
  const screenResponse = await fetch(`${h.origin}/api/console/v1/pane/w1%3Ap1/screen`, {
    headers: { ...auth, "x-herdgate-runtime-generation": session.runtimeGeneration },
  });
  assert.equal(screenResponse.status, 200);
  const screen = await screenResponse.json() as { ansi: string; sequence: number; truncated: boolean; capturedAt: string; cols: number | null; rows: number | null; readAt?: string };
  assert.match(screen.ansi, /fixture screen/);
  assert.equal(screen.sequence, 1);
  assert.equal(screen.truncated, false);
  assert.equal(screen.capturedAt, new Date(1_000_000).toISOString());
  assert.equal(screen.cols, null);
  assert.equal(screen.rows, null);
  assert.equal("readAt" in screen, false);
  assert.equal((await fetch(`${h.origin}/api/console/v1/pane/w1%3Ap1/send`, { method: "POST", headers: { ...auth, origin: h.origin } })).status, 404);

  const missingOrigin = await fetch(`${h.origin}/api/console/v1/auth/logout`, { method: "POST", headers: auth });
  assert.equal(missingOrigin.status, 403);
  const logout = await fetch(`${h.origin}/api/console/v1/auth/logout`, { method: "POST", headers: { ...auth, origin: h.origin } });
  assert.equal(logout.status, 204);
  assert.equal((await fetch(`${h.origin}/api/console/v1/session`, { headers: auth })).status, 401);
  assert.equal(h.logs.some((line) => line.includes(token) || line.includes(code) || line.includes("fixture screen")), false);
  assert.ok(h.runtime.calls.every((call) => ["session.snapshot", "pane.read"].includes(String(call.method))), "no write or arbitrary operation reaches runtime");
});

test("screen API includes cell geometry from the selected pane's layout", async (t) => {
  const snapshot = {
    ...fixtureSnapshot,
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", focused: true, scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 38 } },
      { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", focused: false, scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 38 } },
    ],
    layouts: [{ workspace_id: "w1", tab_id: "w1:t1", zoomed: false, area: { x: 0, y: 0, width: 120, height: 40 }, focused_pane_id: "w1:p1", splits: [], panes: [
      { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
      { pane_id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 60, height: 40 } },
    ] }],
  };
  const service = createConsoleService({ rpc: {
    snapshot: async () => snapshot,
    readPane: async (paneId: string) => ({ pane_id: paneId, text: "screen", truncated: false }),
  }, assetsDir: assets });
  await service.start();
  t.after(() => service.stop());
  const { response: redeemed } = await login(service.origin, service);
  const { token } = await redeemed.json() as { token: string };
  const auth = { authorization: `Bearer ${token}` };
  const session = await fetch(`${service.origin}/api/console/v1/session`, { headers: auth });
  const { runtimeGeneration } = await session.json() as { runtimeGeneration: string };
  for (const paneId of ["w1:p1", "w1:p2"]) {
    const screen = await fetch(`${service.origin}/api/console/v1/pane/${encodeURIComponent(paneId)}/screen`, { headers: { ...auth, "x-herdgate-runtime-generation": runtimeGeneration } });
    assert.equal(screen.status, 200);
    const result = await screen.json() as { cols: number | null; rows: number | null };
    assert.deepEqual({ cols: result.cols, rows: result.rows }, { cols: 57, rows: 38 });
  }
});

test("redeem enforces origin, body bound, one-time code and TTL; viewer expires", async (t) => {
  const h = await withService(t);
  const code = h.service.issueLoginCode();
  const cross = await fetch(`${h.origin}/api/console/v1/auth/redeem`, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://attacker.invalid" }, body: JSON.stringify({ code }),
  });
  assert.equal(cross.status, 403);
  const tooLarge = await fetch(`${h.origin}/api/console/v1/auth/redeem`, {
    method: "POST", headers: { "content-type": "application/json", origin: h.origin }, body: JSON.stringify({ code, extra: "x".repeat(20_000) }),
  });
  assert.equal(tooLarge.status, 413);
  h.advance(120_001);
  const expiredCode = await fetch(`${h.origin}/api/console/v1/auth/redeem`, {
    method: "POST", headers: { "content-type": "application/json", origin: h.origin }, body: JSON.stringify({ code }),
  });
  assert.equal(expiredCode.status, 401);

  const { response } = await login(h.origin, h.service);
  const { token } = await response.json() as { token: string };
  h.advance(30 * 60 * 1000 + 1);
  const expiredViewer = await fetch(`${h.origin}/api/console/v1/session`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(expiredViewer.status, 401);
});

test("local code attempts are capped and exhaust the one-time code", async (t) => {
  const h = await withService(t);
  const code = h.service.issueLoginCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${h.origin}/api/console/v1/auth/redeem`, {
      method: "POST", headers: { "content-type": "application/json", origin: h.origin }, body: JSON.stringify({ code: "f".repeat(64) }),
    });
    assert.equal(response.status, 401);
  }
  const exhausted = await fetch(`${h.origin}/api/console/v1/auth/redeem`, {
    method: "POST", headers: { "content-type": "application/json", origin: h.origin }, body: JSON.stringify({ code }),
  });
  assert.equal(exhausted.status, 401);
});

test("mirror response stays under the JSON cap by truncating whole rows; oversized layout fails clearly", async (t) => {
  const hugeText = `${"A".repeat(100_000)}\n${"B".repeat(100_000)}\n${"C".repeat(100_000)}\n`;
  const rpc = { snapshot: async () => fixtureSnapshot, readPane: async () => ({ pane_id: "w1:p1", text: hugeText, truncated: false }) };
  const service = createConsoleService({ rpc, assetsDir: assets });
  await service.start();
  t.after(() => service.stop());
  const { response: redeemed } = await login(service.origin, service);
  const { token } = await redeemed.json() as { token: string };
  const auth = { authorization: `Bearer ${token}` };
  const session = await fetch(`${service.origin}/api/console/v1/session`, { headers: auth });
  const { runtimeGeneration } = await session.json() as { runtimeGeneration: string };
  const screen = await fetch(`${service.origin}/api/console/v1/pane/w1%3Ap1/screen`, { headers: { ...auth, "x-herdgate-runtime-generation": runtimeGeneration } });
  const bytes = Buffer.from(await screen.arrayBuffer());
  assert.ok(bytes.byteLength <= 256 * 1024);
  const payload = JSON.parse(bytes.toString("utf8"));
  assert.equal(payload.truncated, true);
  assert.doesNotMatch(payload.ansi, /^A/);
  assert.match(payload.ansi, /C/);

  const largeSnapshot = { ...fixtureSnapshot, diagnostic: "x".repeat(256 * 1024) };
  const oversizeService = createConsoleService({ rpc: { snapshot: async () => largeSnapshot, readPane: rpc.readPane }, assetsDir: assets });
  await oversizeService.start();
  t.after(() => oversizeService.stop());
  const { response: secondLogin } = await login(oversizeService.origin, oversizeService);
  const { token: secondToken } = await secondLogin.json() as { token: string };
  const oversized = await fetch(`${oversizeService.origin}/api/console/v1/session`, { headers: { authorization: `Bearer ${secondToken}` } });
  assert.equal(oversized.status, 502);
  const oversizedBody = await oversized.json() as { error: { code: string } };
  assert.equal(oversizedBody.error.code, "response_too_large");
});

test("runtime permission and pane-gone errors map to 403/404 without fallback", async (t) => {
  const permission = createConsoleService({ rpc: { snapshot: async () => { throw Object.assign(new Error("denied"), { code: "permission_denied" }); }, readPane: async () => { throw new Error("must not read"); } }, assetsDir: assets });
  await permission.start();
  t.after(() => permission.stop());
  const { response: permissionLogin } = await login(permission.origin, permission);
  const { token: permissionToken } = await permissionLogin.json() as { token: string };
  const denied = await fetch(`${permission.origin}/api/console/v1/session`, { headers: { authorization: `Bearer ${permissionToken}` } });
  assert.equal(denied.status, 403);

  const vanished = createConsoleService({ rpc: { snapshot: async () => fixtureSnapshot, readPane: async () => { throw Object.assign(new Error("gone"), { code: "pane_not_found" }); } }, assetsDir: assets });
  await vanished.start();
  t.after(() => vanished.stop());
  const { response: goneLogin } = await login(vanished.origin, vanished);
  const { token: goneToken } = await goneLogin.json() as { token: string };
  const auth = { authorization: `Bearer ${goneToken}` };
  const first = await fetch(`${vanished.origin}/api/console/v1/session`, { headers: auth });
  const { runtimeGeneration } = await first.json() as { runtimeGeneration: string };
  const gone = await fetch(`${vanished.origin}/api/console/v1/pane/w1%3Ap1/screen`, { headers: { ...auth, "x-herdgate-runtime-generation": runtimeGeneration } });
  assert.equal(gone.status, 404);
  assert.equal(vanished.runtimeAvailable, true, "one pane disappearance does not imply runtime loss");
  const refreshed = await fetch(`${vanished.origin}/api/console/v1/session`, { headers: auth });
  const refreshedGeneration = await refreshed.json() as { runtimeGeneration: string };
  assert.equal(refreshedGeneration.runtimeGeneration, runtimeGeneration);
});

test("same-generation refresh removing a pane rejects its pending screen without leaking ANSI", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hg-console-pane-race-"));
  const runtimePath = join(dir, "runtime.sock");
  let snapshots = 0;
  let completeRead!: (text: string) => void;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const runtime = await startFixtureRuntime(runtimePath, {
    snapshot: () => ++snapshots === 1 ? fixtureSnapshot : { ...fixtureSnapshot, panes: [] },
    readText: () => { readStarted(); return new Promise<string>((resolve) => { completeRead = resolve; }); },
  });
  const rpc = createConsoleRpc({ connect: () => net.createConnection(runtimePath), timeoutMs: 300, paneTimeoutMs: 300 });
  const service = createConsoleService({ rpc, assetsDir: assets });
  await service.start();
  t.after(async () => { await service.stop(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const { response: redeemed } = await login(service.origin, service);
  const { token } = await redeemed.json() as { token: string };
  const auth = { authorization: `Bearer ${token}` };
  const first = await fetch(`${service.origin}/api/console/v1/session`, { headers: auth });
  const { runtimeGeneration } = await first.json() as { runtimeGeneration: string };
  const pendingScreen = fetch(`${service.origin}/api/console/v1/pane/w1%3Ap1/screen`, {
    headers: { ...auth, "x-herdgate-runtime-generation": runtimeGeneration },
  });
  await started;
  const refreshed = await fetch(`${service.origin}/api/console/v1/session`, { headers: auth });
  assert.equal(refreshed.status, 200);
  const refreshedSnapshot = await refreshed.json() as { snapshot: { panes: { pane_id: string }[] } };
  assert.deepEqual(refreshedSnapshot.snapshot.panes, []);
  assert.equal(service.runtimeGeneration, runtimeGeneration, "pane removal does not change runtime identity");
  completeRead("PRIVATE ANSI MUST NOT LEAK\\n");
  const response = await pendingScreen;
  assert.equal(response.status, 404);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "pane_gone");
  assert.equal("ansi" in body, false);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE ANSI/);
});

test("generation invalidation during pane RPC drops the in-flight screen", async (t) => {
  let completeRead!: (value: { pane_id: string; text: string; truncated: boolean }) => void;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const fakeRpc = {
    snapshot: async () => fixtureSnapshot,
    readPane: () => { readStarted(); return new Promise<{ pane_id: string; text: string; truncated: boolean }>((resolve) => { completeRead = resolve; }); },
  };
  const service = createConsoleService({ rpc: fakeRpc, assetsDir: assets });
  await service.start();
  t.after(() => service.stop());
  const { response: redeemed } = await login(service.origin, service);
  const { token } = await redeemed.json() as { token: string };
  const auth = { authorization: `Bearer ${token}` };
  const session = await fetch(`${service.origin}/api/console/v1/session`, { headers: auth });
  const { runtimeGeneration } = await session.json() as { runtimeGeneration: string };
  const screenRequest = fetch(`${service.origin}/api/console/v1/pane/w1%3Ap1/screen`, {
    headers: { ...auth, "x-herdgate-runtime-generation": runtimeGeneration },
  });
  await started;
  service.invalidateRuntime();
  completeRead({ pane_id: "w1:p1", text: "must be dropped", truncated: false });
  const stale = await screenRequest;
  assert.equal(stale.status, 409);
});
