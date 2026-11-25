import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyOvisSource } from "../console/tools/verify-ovis-source.mjs";

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

test("records the Herdgate React entrypoint without claiming an unbuilt bundle is ready", async () => {
  const result = await verifyOvisSource(root);
  assert.equal(result.localEntrypoint, "console/src/entry.tsx");
  assert.equal(result.buildReady, false);
  assert.equal(result.upstreamPwaRegistrationExcluded, true);
});

test("local React shell uses Ovis xterm in read-only mode and does not boot Ovis App/PWA", async () => {
  const entry = await readFile(new URL("../console/src/entry.tsx", import.meta.url), "utf8");
  const ui = await readFile(new URL("../console/src/ui.tsx", import.meta.url), "utf8");
  const html = await readFile(new URL("../console/index.html", import.meta.url), "utf8");
  assert.match(entry, /createRoot/);
  assert.match(entry, /@xterm\/xterm\/css\/xterm\.css/);
  assert.match(ui, /from "@xterm\/xterm"/);
  assert.match(ui, /disableStdin: true/);
  assert.match(ui, /fetchScreen\(/);
  assert.match(ui, /Workspace/);
  assert.match(ui, /Pane/);
  assert.match(ui, /error\.status === 401/);
  assert.match(ui, /error\.status === 404/);
  assert.match(ui, /error\.status === 409/);
  assert.doesNotMatch(entry, /vendor\/ovis\/src\/(?:main|App)/);
  assert.doesNotMatch(ui, /PaneTerminal|innerHTML|localStorage|serviceWorker/);
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /ovis\.sh|pwa\.ts|sw\.js/);
});
