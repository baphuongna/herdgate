import test from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(!result.files.some((file) => /^(server|relay|push-relay|app)\//.test(file)));
  assert.ok(!result.files.some((file) => /(^|\/)(sw\.js|pwa\.ts|manifest\.webmanifest)$/.test(file)));
});

test("does not claim a local build entry or PWA isolation before integration exists", async () => {
  const result = await verifyOvisSource(root);
  assert.equal(result.localEntrypoint, null);
  assert.equal(result.buildReady, false);
  assert.equal(result.upstreamPwaRegistrationExcluded, true);
});
