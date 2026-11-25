// Cross-branch contract: the Console service (runtime branch) and the Console build tool (frontend branch)
// each keep a copy of the content security policy. Neither branch can test the other, so this test lives on
// the integration branch and fails as soon as the header sent by the service drifts from the policy the
// built shell is verified against.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CONSOLE_CSP } from "../bin/console-service.mjs";
import { CONSOLE_CSP_HEADER, CONSOLE_CSP_META } from "../console/tools/build-console.mjs";

const HEADER_ONLY_DIRECTIVE = "; frame-ancestors 'none'";

function directives(policy: string): Map<string, string[]> {
  return new Map(policy.split(";").map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
}

function metaPolicy(html: string): string | undefined {
  const tag = /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i.exec(html)?.[0];
  return tag && /\bcontent="([^"]*)"/i.exec(tag)?.[1];
}

test("service CSP header, build CSP header and shell meta CSP are one policy", () => {
  assert.equal(CONSOLE_CSP, CONSOLE_CSP_HEADER, "service header drifted from the build tool's header policy");
  assert.equal(`${CONSOLE_CSP_META}${HEADER_ONLY_DIRECTIVE}`, CONSOLE_CSP_HEADER, "header must be the meta policy plus frame-ancestors");
  const source = readFileSync(new URL("../console/index.html", import.meta.url), "utf8");
  assert.equal(metaPolicy(source), CONSOLE_CSP_META, "source index.html meta CSP drifted from the build tool");
  assert.ok(!source.includes('rel="icon" href="http') && /rel="icon" href="data:,"/.test(source), "favicon must be inline so the browser never requests /favicon.ico");
});

test("Console policy keeps its security invariants regardless of wording", () => {
  const byName = directives(CONSOLE_CSP);
  assert.deepEqual(byName.get("default-src"), ["'self'"]);
  assert.deepEqual(byName.get("script-src"), ["'self'"], "scripts: same-origin only, no inline, no eval");
  assert.deepEqual(byName.get("style-src"), ["'self'", "'unsafe-inline'"], "inline styles only (xterm DOM renderer)");
  assert.deepEqual(byName.get("connect-src"), ["'self'"]);
  assert.deepEqual(byName.get("img-src"), ["'self'", "data:"]);
  assert.deepEqual(byName.get("font-src"), ["'self'"]);
  for (const name of ["worker-src", "child-src", "frame-src", "manifest-src", "object-src", "base-uri", "frame-ancestors"]) {
    assert.deepEqual(byName.get(name), ["'none'"], name);
  }
  assert.deepEqual(byName.get("form-action"), ["'self'"]);
  assert.equal(CONSOLE_CSP.match(/unsafe-inline/g)?.length, 1, "'unsafe-inline' may appear only in style-src");
  assert.ok(!CONSOLE_CSP.includes("unsafe-eval") && !CONSOLE_CSP.includes("*") && !/https?:/.test(CONSOLE_CSP));
  // The meta element cannot carry frame-ancestors; Chrome logs an error for every other header-only directive it meets.
  const meta = directives(CONSOLE_CSP_META);
  assert.equal(meta.has("frame-ancestors"), false);
  assert.equal(meta.has("sandbox"), false);
  assert.equal(meta.has("report-uri"), false);
});
