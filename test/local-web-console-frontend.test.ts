import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyOvisSource } from "../console/tools/verify-ovis-source.mjs";
import { createReadOnlyOvisMachineApi } from "../console/src/ovis/machine-api-deny.ts";
import { createConsoleFetchGuard, denyNetworkConstructor } from "../console/src/ovis/fetch-guard.ts";

const root = new URL("../", import.meta.url);

test("pinned Ovis frontend source is complete, hash-verified, and excludes server/PWA runtime", async () => {
  const result = await verifyOvisSource(root);
  assert.equal(result.revision, "b0f20e7bcf87f770638c26b8c74e77ef8fd84131");
  assert.ok(result.fileCount > 1000);
  assert.ok(result.bytes > 10_000_000);
  assert.ok(result.files.includes("src/App.tsx"));
  assert.ok(result.files.includes("src/components/PaneTerminal.tsx"));
  assert.ok(result.files.includes("shared/herdr-api.generated.ts"));
  assert.ok(result.files.includes("src/lib/markdownPreview.worker.ts"));
  assert.ok(result.files.includes("src/lib/highlight.worker.ts"));
  assert.ok(result.files.includes("shared/ghostty/ghostty-vt.wasm"));
  assert.ok(!result.files.some((file) => /^(server|relay|push-relay|app)\//.test(file)));
  assert.ok(!result.files.some((file) => /(^|\/)(sw\.js|pwa\.ts|manifest\.webmanifest)$/.test(file)));
});

test("reports build readiness only when the entrypoint and runtime artifacts exist", async () => {
  const result = await verifyOvisSource(root);
  const artifactsReady = await Promise.all([
    readFile(new URL("../console/dist/index.html", import.meta.url)).then(() => true, () => false),
    readFile(new URL("../console/dist/manifest.json", import.meta.url)).then(() => true, () => false),
  ]);
  assert.equal(result.localEntrypoint, "console/src/entry.tsx");
  assert.equal(result.buildReady, artifactsReady.every(Boolean));
  assert.equal(result.upstreamPwaRegistrationExcluded, true);
});

test("local React shell uses the Herdgate client and does not boot Ovis App/PWA", async () => {
  const entry = await readFile(new URL("../console/src/entry.tsx", import.meta.url), "utf8");
  const ui = await readFile(new URL("../console/src/ui.tsx", import.meta.url), "utf8");
  const terminal = await readFile(new URL("../console/src/ovis/TerminalMirror.tsx", import.meta.url), "utf8");
  const storageGuard = await readFile(new URL("../console/src/ovis/storage-guard.ts", import.meta.url), "utf8");
  const html = await readFile(new URL("../console/index.html", import.meta.url), "utf8");
  assert.match(entry, /createRoot/);
  assert.match(entry, /installConsoleNetworkGuard\(\)/);
  assert.match(entry, /installConsoleStorageGuard\(\)/);
  assert.ok(entry.indexOf("installConsoleStorageGuard()") < entry.indexOf("createRoot(element).render"), "storage guard is active before React mounts");
  assert.match(storageGuard, /memoryStorage\(\)/);
  assert.match(entry, /@xterm\/xterm\/css\/xterm\.css/);
  assert.match(ui, /OvisReadOnlySessionView/);
  assert.match(ui, /fetchScreen\(/);
  assert.match(ui, /transitionMirrorSelection\(/);
  assert.match(ui, /Workspace/);
  assert.match(ui, /Pane/);
  assert.match(ui, /error\.status === 401/);
  assert.match(ui, /error\.status === 404/);
  assert.match(ui, /error\.status === 409/);
  assert.match(terminal, /from "@xterm\/xterm"/);
  assert.match(terminal, /disableStdin: true/);
  assert.doesNotMatch(entry, /vendor\/ovis\/src\/(?:main|App)/);
  assert.doesNotMatch(ui, /PaneTerminal|innerHTML|localStorage|serviceWorker/);
  assert.doesNotMatch(terminal, /from ["'][^"']*HerdrSocket|new WebSocket|\.attach\(/);
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /ovis\.sh|pwa\.ts|sw\.js/);
  assert.match(ui, /href="\/notices\/THIRD_PARTY_NOTICES\.md"[^>]*>Third-party notices<\/a>/);
  assert.equal((ui.match(/href="\/notices\/THIRD_PARTY_NOTICES\.md"/g) ?? []).length, 2, "login and main view both link the third-party notices");
});

test("L1 import trace mounts pinned Ovis tab and pane source with memory-only preference shims", async () => {
  const ui = await readFile(new URL("../console/src/ui.tsx", import.meta.url), "utf8");
  const view = await readFile(new URL("../console/src/ovis/ReadOnlySessionView.tsx", import.meta.url), "utf8");
  const terminal = await readFile(new URL("../console/src/ovis/TerminalMirror.tsx", import.meta.url), "utf8");
  const settingsShim = await readFile(new URL("../console/src/ovis/settings-shim.tsx", import.meta.url), "utf8");
  const viewedPaneShim = await readFile(new URL("../console/src/ovis/last-viewed-pane-shim.ts", import.meta.url), "utf8");
  const i18nShim = await readFile(new URL("../console/src/ovis/i18n-shim.ts", import.meta.url), "utf8");
  const vite = await readFile(new URL("../console/vite.config.ts", import.meta.url), "utf8");
  const attribution = await readFile(new URL("../console/patches/README.md", import.meta.url), "utf8");
  assert.match(ui, /from "\.\/ovis\/ReadOnlySessionView\.tsx"/);
  assert.match(view, /vendor\/ovis\/src\/components\/TabStrip\.tsx/);
  assert.match(view, /vendor\/ovis\/src\/components\/PaneCanvas\.tsx/);
  assert.match(view, /watching/);
  assert.match(view, /closable=\{false\}/);
  assert.match(view, /onContextMenuCapture/);
  assert.match(view, /onKeyDownCapture/);
  assert.match(view, /OvisTerminalMirror/);
  assert.match(terminal, /read-only port of the terminal surface in Ovis PaneTerminal\.tsx/);
  assert.match(settingsShim, /memory-only/);
  assert.match(viewedPaneShim, /No localStorage\/IndexedDB persistence/);
  assert.match(vite, /settings-shim\.tsx/);
  assert.match(vite, /last-viewed-pane-shim\.ts/);
  assert.match(vite, /machine-context-shim\.tsx/);
  assert.match(vite, /i18n-shim\.ts/);
  assert.doesNotMatch(i18nShim, /ovis\.sh|install\.ps1|install\.sh/);
  assert.match(view, /from "\.\/machine-context-shim\.tsx"/);
  assert.doesNotMatch(view, /vendor\/ovis\/src\/lib\/machineContext/);
  assert.match(attribution, /b0f20e7bcf87f770638c26b8c74e77ef8fd84131/);
  assert.match(attribution, /not full Ovis frontend parity/);
});

test("Console fetch firewall allows only the typed local routes and blocks Ovis/remote API calls", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const guard = createConsoleFetchGuard(async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET" });
    return Response.json({ ok: true });
  }, "http://127.0.0.1:43123");
  await guard("/api/console/v1/session");
  await guard("/api/console/v1/pane/p%3A1/screen", { headers: { "x-herdgate-runtime-generation": "gen-1" } });
  await assert.rejects(guard("/api/session"), /blocked by Herdgate Console/);
  await assert.rejects(guard("/api/telemetry", { method: "POST" }), /blocked by Herdgate Console/);
  await assert.rejects(guard("/api/console/v1/pane/p1/act", { method: "POST" }), /blocked by Herdgate Console/);
  await assert.rejects(guard("https://ovis.sh/api/session"), /blocked by Herdgate Console/);
  await assert.rejects(guard("/index.html"), /blocked by Herdgate Console/);
  assert.deepEqual(calls, [
    { url: "/api/console/v1/session", method: "GET" },
    { url: "/api/console/v1/pane/p%3A1/screen", method: "GET" },
  ]);
});

test("WebSocket and EventSource constructors are hard-disabled for the Ovis read-only UI", () => {
  class FakeSocket { constructor(url: string) { void url; } }
  const DeniedSocket = denyNetworkConstructor(FakeSocket, "WebSocket");
  assert.throws(() => new DeniedSocket("ws://127.0.0.1/ws"), /WebSocket is disabled/);
  class FakeEventSource { constructor(url: string) { void url; } }
  const DeniedEventSource = denyNetworkConstructor(FakeEventSource, "EventSource");
  assert.throws(() => new DeniedEventSource("http://127.0.0.1/events"), /EventSource is disabled/);
});

test("read-only Ovis machine API hard-denies upstream reads and mutations without fetching", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("unexpected Ovis route"); }) as typeof fetch;
  try {
    const api = createReadOnlyOvisMachineApi();
    for (const operation of ["fetchPaneTranscript", "fetchPaneConversation", "focusPane", "splitPane", "renamePane", "closePane", "createTab", "runPluginAction"]) {
      await assert.rejects(api[operation]("pane-1"), new RegExp(`Ovis machine API is disabled.*${operation}`));
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
