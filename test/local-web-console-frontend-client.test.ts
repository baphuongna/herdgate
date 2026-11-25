import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleApiClient, ConsoleApiError } from "../src/console/web/client.ts";
import { MirrorFrameGate, stripUnsafeOsc } from "../src/console/web/mirror-gate.ts";

const session = {
  runtime: "available",
  runtimeGeneration: "gen-1",
  workspaces: [{ id: "w-1", label: "Workspace" }],
  tabs: [{ id: "t-1", workspaceId: "w-1", label: "Tab" }],
  panes: [{ id: "p/1", tabId: "t-1", workspaceId: "w-1", title: "Shell" }],
  focused: { workspaceId: "w-1", tabId: "t-1", paneId: "p/1" },
};
const screen = { paneId: "p/1", runtimeGeneration: "gen-1", sequence: 4, cols: 80, rows: 24, ansi: "hello", capturedAt: "2026-01-01T00:00:00.000Z", truncated: false };

test("redeems a code in the body and keeps the returned bearer only in this API client", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new ConsoleApiClient(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/auth/redeem")) return Response.json({ token: "tab-secret-with-entropy", expiresAt: "2026-01-01T00:30:00.000Z" });
    return Response.json({ snapshot: session });
  });
  await client.redeem("short-lived-code");
  await client.fetchSession();
  assert.equal(calls[0]?.url, "/api/console/v1/auth/redeem");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { code: "short-lived-code" });
  assert.equal(new Headers(calls[0]?.init.headers).has("authorization"), false);
  assert.equal(new Headers(calls[1]?.init.headers).get("authorization"), "Bearer tab-secret-with-entropy");
  for (const call of calls) {
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
  }
});

test("maps only the typed read routes and sends expected generation for an encoded pane ID", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new ConsoleApiClient(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).includes("/capabilities")) return Response.json({ mode: "read-only", console: "ready", runtime: "available", features: { session: true, mirror: true, act: false } });
    if (String(input).includes("/auth/redeem")) return Response.json({ token: "tab-secret-with-entropy", expiresAt: "later" });
    if (String(input).includes("/screen")) return Response.json({ screen });
    return Response.json({ snapshot: session });
  });
  assert.equal((await client.capabilities()).features.act, false);
  await client.redeem("fixture-code");
  assert.deepEqual(await client.fetchSession(), session);
  assert.deepEqual(await client.fetchScreen("p/1", "gen-1"), screen);
  assert.match(calls[3]!.url, /^\/api\/console\/v1\/pane\/p%2F1\/screen\?generation=gen-1$/);
  assert.ok(calls.every((call) => call.init.method === "GET" || call.init.method === "POST"));
});

test("rejects malformed snapshots, mismatched screen identity and over-budget screen JSON", async () => {
  let mode: "bad-session" | "wrong-generation" | "oversized" = "bad-session";
  const client = new ConsoleApiClient(async (input) => {
    if (String(input).endsWith("/auth/redeem")) return Response.json({ token: "tab-secret-with-entropy", expiresAt: "later" });
    if (String(input).endsWith("/session")) return Response.json({ snapshot: { ...session, panes: [{ id: 1 }] } });
    const frame = mode === "wrong-generation" ? { ...screen, runtimeGeneration: "other" } : mode === "oversized" ? { ...screen, ansi: "x".repeat(300_000) } : screen;
    return Response.json({ screen: frame });
  });
  await client.redeem("code");
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
    if (String(_input).endsWith("/auth/redeem")) return Response.json({ token: "tab-secret-with-entropy", expiresAt: "later" });
    if (String(_input).endsWith("/auth/logout")) { logoutCalled = true; return Response.json({ ok: true }); }
    if (returnError) return Response.json({ error: { code: "unsupported", message: "Not supported in Herdgate mode" } }, { status: 501 });
    return Response.json({ snapshot: session });
  });
  await client.redeem("code");
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
      ? Response.json({ token: "tab-secret-with-entropy", expiresAt: "later" })
      : new Response("not JSON", { status: 401 });
  });
  await client.redeem("code");
  assert.equal(client.authenticated, true);
  await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.status === 401);
  assert.equal(client.authenticated, false);
  await assert.rejects(client.fetchSession(), (error: unknown) => error instanceof ConsoleApiError && error.code === "unauthenticated");
  assert.equal(requests, 2);
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
