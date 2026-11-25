import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleApiClient, ConsoleApiError } from "../src/console/web/client.ts";
import type { ConsoleSessionSnapshot } from "../src/console/web/view-model.ts";
import { MirrorFrameGate, stripUnsafeOsc, transitionMirrorSelection } from "../src/console/web/mirror-gate.ts";

const token = "a".repeat(64);
const runtimeSnapshot = {
  version: "0.9.5", protocol: 22,
  workspaces: [{ workspace_id: "w-1", label: "Workspace" }],
  tabs: [{ tab_id: "t-1", workspace_id: "w-1", label: "Tab" }],
  panes: [{ pane_id: "p/1", tab_id: "t-1", workspace_id: "w-1", focused: true, terminal_title: "Shell" }],
  focused_workspace_id: "w-1", focused_tab_id: "t-1", focused_pane_id: "p/1", layouts: [], agents: [],
};
const session = {
  runtime: "available" as const,
  runtimeGeneration: "gen-1",
  workspaces: [{ id: "w-1", label: "Workspace" }],
  tabs: [{ id: "t-1", workspaceId: "w-1", label: "Tab" }],
  panes: [{ id: "p/1", tabId: "t-1", workspaceId: "w-1", title: "Shell" }],
  focused: { workspaceId: "w-1", tabId: "t-1", paneId: "p/1" },
};
const screen = { paneId: "p/1", runtimeGeneration: "gen-1", sequence: 4, cols: 80, rows: 24, ansi: "hello", capturedAt: "2026-01-01T00:00:00.000Z", truncated: false };
const capabilities = { mode: "mirror", scope: "read", transport: "rpc", features: { session: true, paneScreen: true, act: false, attach: false, chat: false, inbox: false, fileViewer: false } };
type RecordedRequestInit = RequestInit & { cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload" };

function withoutOvisSnapshot(snapshot: ConsoleSessionSnapshot) {
  const { ovisSnapshot: _ovisSnapshot, ...projected } = snapshot;
  return projected;
}

test("redeems a code in the body and keeps the returned bearer only in this API client", async () => {
  const calls: Array<{ url: string; init: RecordedRequestInit }> = [];
  const client = new ConsoleApiClient(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/auth/redeem")) return Response.json({ token, expiresInMs: 1_800_000, maxAgeMs: 28_800_000 });
    return Response.json({ runtimeGeneration: "gen-1", snapshot: runtimeSnapshot });
  });
  const code = "b".repeat(64);
  await client.redeem(code);
  await client.fetchSession();
  assert.equal(calls[0]?.url, "/api/console/v1/auth/redeem");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { code });
  assert.equal(new Headers(calls[0]?.init.headers).has("authorization"), false);
  assert.equal(new Headers(calls[1]?.init.headers).get("authorization"), `Bearer ${token}`);
  for (const call of calls) {
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
  }
});

test("matches runtime API contract from a9a260f for redeem, capabilities, session, screen and 204 logout", async () => {
  const code = "a".repeat(64);
  const rawSnapshot = {
    version: "0.9.5", protocol: 22,
    workspaces: [{ workspace_id: "w-runtime", label: "Runtime workspace" }],
    tabs: [{ tab_id: "t-runtime", workspace_id: "w-runtime", label: "Runtime tab" }],
    panes: [{ pane_id: "p/runtime", tab_id: "t-runtime", workspace_id: "w-runtime", focused: true, terminal_title: "Runtime shell" }],
    focused_pane_id: "p/runtime", focused_tab_id: "t-runtime", focused_workspace_id: "w-runtime", layouts: [], agents: [],
  };
  const rawScreen = { runtimeGeneration: "runtime-gen", sequence: 1, paneId: "p/runtime", cols: null, rows: null, ansi: "runtime ANSI", capturedAt: "2026-11-25T00:00:00.000Z", truncated: false };
  const calls: Array<{ url: string; init: RecordedRequestInit }> = [];
  const client = new ConsoleApiClient(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/auth/redeem")) return Response.json({ token: "a".repeat(64), expiresInMs: 1_800_000, maxAgeMs: 28_800_000 });
    if (url.endsWith("/capabilities")) return Response.json({ mode: "mirror", scope: "read", transport: "rpc", features: { session: true, paneScreen: true, act: false, attach: false, chat: false, inbox: false, fileViewer: false } });
    if (url.endsWith("/session")) return Response.json({ runtimeGeneration: "runtime-gen", snapshot: rawSnapshot });
    if (url.includes("/screen")) return Response.json(rawScreen);
    if (url.endsWith("/auth/logout")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected route ${url}`);
  });

  await assert.rejects(client.capabilities(), (error: unknown) => error instanceof ConsoleApiError && error.status === 401);
  await client.redeem(code);
  assert.equal((await client.capabilities()).mode, "mirror");
  const adapted = await client.fetchSession();
  assert.deepEqual(withoutOvisSnapshot(adapted), {
    runtime: "available", runtimeGeneration: "runtime-gen",
    workspaces: [{ id: "w-runtime", label: "Runtime workspace" }],
    tabs: [{ id: "t-runtime", workspaceId: "w-runtime", label: "Runtime tab" }],
    panes: [{ id: "p/runtime", tabId: "t-runtime", workspaceId: "w-runtime", title: "Runtime shell" }],
    focused: { workspaceId: "w-runtime", tabId: "t-runtime", paneId: "p/runtime" },
  });
  const ovisPanes = adapted.ovisSnapshot?.panes;
  assert.ok(Array.isArray(ovisPanes));
  const firstOvisPane = ovisPanes[0];
  assert.ok(typeof firstOvisPane === "object" && firstOvisPane !== null && "pane_id" in firstOvisPane);
  assert.equal(firstOvisPane.pane_id, "p/runtime");
  assert.deepEqual(await client.fetchScreen("p/runtime", "runtime-gen"), rawScreen);
  assert.equal(calls.find((call) => call.url.endsWith("/pane/p%2Fruntime/screen"))?.url, "/api/console/v1/pane/p%2Fruntime/screen");
  assert.equal(new Headers(calls.find((call) => call.url.endsWith("/screen"))?.init.headers).get("x-herdgate-runtime-generation"), "runtime-gen");
  await client.logout();
  assert.equal(client.authenticated, false);
  assert.equal(calls.at(-1)?.url, "/api/console/v1/auth/logout");
});

test("maps only the typed read routes and sends expected generation for an encoded pane ID", async () => {
  const calls: Array<{ url: string; init: RecordedRequestInit }> = [];
  const client = new ConsoleApiClient(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).includes("/capabilities")) return Response.json(capabilities);
    if (String(input).includes("/auth/redeem")) return Response.json({ token, expiresInMs: 1_800_000, maxAgeMs: 28_800_000 });
    if (String(input).includes("/screen")) return Response.json(screen);
    return Response.json({ runtimeGeneration: "gen-1", snapshot: runtimeSnapshot });
  });
  await client.redeem("c".repeat(64));
  assert.equal((await client.capabilities()).features.act, false);
  assert.deepEqual(withoutOvisSnapshot(await client.fetchSession()), session);
  assert.deepEqual(await client.fetchScreen("p/1", "gen-1"), screen);
  assert.equal(calls[3]!.url, "/api/console/v1/pane/p%2F1/screen");
  assert.equal(new Headers(calls[3]!.init.headers).get("x-herdgate-runtime-generation"), "gen-1");
  assert.ok(calls.every((call) => call.init.method === "GET" || call.init.method === "POST"));
});

test("rejects malformed snapshots, mismatched screen identity and over-budget screen JSON", async () => {
  let mode: "bad-session" | "wrong-generation" | "oversized" = "bad-session";
  const client = new ConsoleApiClient(async (input) => {
    if (String(input).endsWith("/auth/redeem")) return Response.json({ token, expiresInMs: 1_800_000, maxAgeMs: 28_800_000 });
    if (String(input).endsWith("/session")) return Response.json({ runtimeGeneration: "gen-1", snapshot: { ...runtimeSnapshot, panes: [{ pane_id: 1 }] } });
    const frame = mode === "wrong-generation" ? { ...screen, runtimeGeneration: "other" } : mode === "oversized" ? { ...screen, ansi: "x".repeat(300_000) } : screen;
    return Response.json(frame);
  });
  await client.redeem("d".repeat(64));
  await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.code === "invalid_response");
  mode = "wrong-generation";
  await assert.rejects(client.fetchScreen("p/1", "gen-1"), (error: unknown) => error instanceof ConsoleApiError && error.status === 409);
  mode = "oversized";
  await assert.rejects(client.fetchScreen("p/1", "gen-1"), (error: unknown) => error instanceof ConsoleApiError && error.status === 413);
});

test("fails closed on unsupported/error responses and clears the token on logout", async () => {
  let returnError = false;
  let logoutCalled = false;
  const calls: RequestInit[] = [];
  const client = new ConsoleApiClient(async (_input, init = {}) => {
    calls.push(init);
    if (String(_input).endsWith("/auth/redeem")) return Response.json({ token, expiresInMs: 1_800_000, maxAgeMs: 28_800_000 });
    if (String(_input).endsWith("/auth/logout")) { logoutCalled = true; return new Response(null, { status: 204 }); }
    if (returnError) return Response.json({ error: { code: "unsupported", message: "Not supported in Herdgate mode" } }, { status: 501 });
    return Response.json({ runtimeGeneration: "gen-1", snapshot: runtimeSnapshot });
  });
  await client.redeem("e".repeat(64));
  returnError = true;
  await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.status === 501 && error.code === "unsupported");
  returnError = false;
  await client.logout();
  assert.equal(logoutCalled, true);
  assert.equal(client.authenticated, false);
  assert.equal(new Headers(calls.at(-1)?.headers).has("authorization"), true);
});

test("expired 401 invalidates the in-memory viewer token even with a malformed error body", async () => {
  let requests = 0;
  const client = new ConsoleApiClient(async (input) => {
    requests += 1;
    return String(input).endsWith("/auth/redeem")
      ? Response.json({ token, expiresInMs: 1_800_000, maxAgeMs: 28_800_000 })
      : new Response("not JSON", { status: 401 });
  });
  await client.redeem("f".repeat(64));
  assert.equal(client.authenticated, true);
  await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.status === 401);
  assert.equal(client.authenticated, false);
  await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.code === "unauthenticated");
  assert.equal(requests, 2);
});

test("pane selection is a no-op for the active pane, preserving its request key while A→B→A stays fenced", () => {
  const gate = new MirrorFrameGate();
  const firstA = gate.select("p-a", "gen-1");
  const frame = (paneId: string, sequence: number) => ({ ...screen, paneId, sequence });
  assert.equal(gate.accept(firstA, frame("p-a", 1)), true);

  let screenClears = 0;
  assert.equal(transitionMirrorSelection(gate,
    { paneId: "p-a", runtimeGeneration: "gen-1" },
    { paneId: "p-a", runtimeGeneration: "gen-1" },
    () => { screenClears += 1; }), null);
  assert.equal(screenClears, 0);
  assert.equal(gate.accept(firstA, frame("p-a", 2)), true, "the current poll continues after same-pane selection");

  const b = transitionMirrorSelection(gate,
    { paneId: "p-a", runtimeGeneration: "gen-1" },
    { paneId: "p-b", runtimeGeneration: "gen-1" },
    () => { screenClears += 1; });
  assert.ok(b);
  const secondA = transitionMirrorSelection(gate,
    { paneId: "p-b", runtimeGeneration: "gen-1" },
    { paneId: "p-a", runtimeGeneration: "gen-1" },
    () => { screenClears += 1; });
  assert.ok(secondA);
  assert.equal(screenClears, 2);
  assert.equal(gate.accept(firstA, frame("p-a", 3)), false);
  assert.equal(gate.accept(b, frame("p-b", 3)), false);
  assert.equal(gate.accept(secondA, frame("p-a", 4)), true);
});

test("drops responses from earlier selections and lower or mismatched mirror frames", () => {
  const gate = new MirrorFrameGate();
  const firstA = gate.select("p-a", "gen-1");
  const b = gate.select("p-b", "gen-1");
  const secondA = gate.select("p-a", "gen-1");
  assert.equal(gate.accept(firstA, { ...screen, paneId: "p-a" }), false);
  assert.equal(gate.accept(b, { ...screen, paneId: "p-b" }), false);
  assert.equal(gate.accept(secondA, { ...screen, paneId: "p-a", sequence: 6 }), true);
  assert.equal(gate.accept(secondA, { ...screen, paneId: "p-a", sequence: 5 }), false);
  assert.equal(gate.accept(secondA, { ...screen, paneId: "p-other", sequence: 7 }), false);
  assert.equal(gate.accept(secondA, { ...screen, paneId: "p-a", runtimeGeneration: "gen-2", sequence: 7 }), false);
});

test("removes terminal OSC clipboard and hyperlink controls before rendering", () => {
  assert.equal(stripUnsafeOsc("before\u001b]52;c;secret\u0007after\u001b]8;;https://evil.test\u001b\\link\u001b]8;;\u001b\\"), "beforeafterlink");
});
