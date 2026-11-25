/**
 * The npm package, the way its user meets it (spec: docs/specs/2026-11-25-uplift.md F4).
 *
 * Twice now the repo was green while the tarball was not: 0.14.0 shipped without admin.html
 * (a page listed nowhere in `files`), and `herdgate cloud serve` never once ran from an install —
 * Node refuses to strip TypeScript under node_modules. So this test does what a user does: it
 * takes the real tarball, lays it out under node_modules like a registry install, and runs the
 * documented command. What comes out the other side must be a gate: healthz, the PWA shell with
 * its service worker, the admin page, an API that refuses without a token.
 *
 * Runtime dependencies are symlinked from the checkout (the suite is offline); everything the
 * gate IS comes from the tarball alone.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const repo = join(import.meta.dirname, "..");
const host = "gate.fixture.invalid";
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDGATE_")));

/** Everything index.html, the service worker and the admin page ask the gate for. */
const SHELL = ["/", "/app.css", "/app.js", "/e2e.js", "/push-decision.js", "/app.webmanifest", "/sw.js", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];
const ADMIN = ["/admin", "/admin.css", "/admin.js", "/admin-model.js"];

function get(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method: "GET", headers: { Host: host, ...headers }, signal: AbortSignal.timeout(3000) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("npm package: laid out like an install and started with `cloud serve`, it is a gate", { timeout: 120_000, skip: process.platform !== "linux" }, async () => {
  const stage = mkdtempSync(join(tmpdir(), "herdgate-npm-pack-"));
  let child: ChildProcess | undefined;
  try {
    // The real tarball — lifecycle scripts included, as `npm publish` runs them.
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", stage], { cwd: repo, encoding: "utf8", env, timeout: 90_000 }))[0] as { filename: string; files: { path: string }[] };
    const shipped = new Set(packed.files.map((f) => f.path));

    const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version as string;
    const pkg = join(stage, "app", "node_modules", "@bom0792", "herdgate");
    mkdirSync(pkg, { recursive: true });
    execFileSync("tar", ["-xzf", join(stage, packed.filename), "-C", pkg, "--strip-components=1"]);
    for (const dep of ["ssh2", "ws", "qrcode-terminal"]) {
      symlinkSync(realpathSync(join(repo, "node_modules", dep)), join(stage, "app", "node_modules", dep), "dir");
    }

    // The compiled cloud has to be IN the tarball: Node will not run the .ts entry from there.
    assert.ok(shipped.has("dist/cloud-runtime/cloud/main.js"), "the tarball carries the compiled cloud");
    assert.ok(shipped.has("dist/cloud-runtime/protocol/envelope.js"), "…with its compiled protocol");
    for (const page of ["admin.html", "admin.js", "admin.css", "admin-model.js", "sw.js", "push-decision.js", "e2e.js", "app.webmanifest"]) {
      assert.ok(shipped.has(`src/web/${page}`), `the tarball carries src/web/${page}`);
    }

    const state = join(stage, "state");
    const tokenFile = join(stage, "owner-token");
    writeFileSync(tokenFile, "npm-pack-boot-owner-token\n", { mode: 0o600 });
    const cloudEnv = {
      ...env,
      HERDGATE_ACCOUNT_TOKEN_FILE: tokenFile, HERDGATE_STATE: join(state, "state.json"),
      HERDGATE_PUBLIC_HOST: host, HERDGATE_PUBLIC_URL: `https://${host}`, HERDGATE_PORT: "0", HERDGATE_SSH_PORT: "0",
    };

    // The documented command, from outside the package (a user's shell is never inside it).
    let log = "";
    child = spawn(process.execPath, [join(pkg, "bin", "herdgate.mjs"), "cloud", "serve"], { cwd: stage, env: cloudEnv, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk) => { log += String(chunk); });
    let base = "";
    for (let i = 0; i < 400 && !base; i++) {
      const port = log.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      if (port) base = `http://127.0.0.1:${port}`;
      else {
        assert.equal(child.exitCode, null, `cloud serve exited:\n${log}`);
        await delay(25);
      }
    }
    assert.ok(base, `cloud serve did not come up:\n${log}`);
    assert.doesNotMatch(log, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/, "the install runs; no type-stripping refusal");

    const health = await get(base, "/healthz");
    assert.deepEqual([health.status, health.text, health.headers["x-hg-build"]], [200, "ok", version], "the gate knows its own version from wherever package.json sits");

    for (const path of SHELL) {
      const r = await get(base, path);
      assert.equal(r.status, 200, `the PWA shell serves ${path}`);
    }
    assert.match((await get(base, "/")).text, /<div id="view"><\/div>/, "it is the real shell, not an error page");
    assert.match((await get(base, "/sw.js")).text, /addEventListener\("push"/, "and the real service worker");

    for (const path of ADMIN) {
      const r = await get(base, path);
      assert.equal(r.status, 200, `the admin page serves ${path}`);
      assert.ok(r.headers["content-security-policy"], `${path} under the CSP`);
      assert.equal(r.headers["cache-control"], "no-store", `${path} is never cached stale`);
    }
    assert.match((await get(base, "/admin.js")).text, /push-test/, "the admin client in the tarball is this one");

    const anon = await get(base, "/v1/admin/overview");
    assert.deepEqual([anon.status, anon.headers["cache-control"]], [401, "no-store"], "the API is there and refuses without the owner");
    const owner = await get(base, "/v1/admin/overview", { authorization: "Bearer npm-pack-boot-owner-token" });
    assert.equal(owner.status, 200);
    const overview = JSON.parse(owner.text);
    assert.deepEqual(overview.counts, { rooms: 0, devices: 0, agentsOnline: 0, devicesLive: 0, pendingCodes: 0 });
    assert.equal(overview.gate.health.node, process.version, "the installed gate reports its health");
    assert.match(String((await get(base, "/nope.js")).status === 404 ? "404" : ""), /404/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const kill = setTimeout(() => child?.kill("SIGKILL"), 2_500).unref();
      await exited;
      clearTimeout(kill);
    }
    rmSync(stage, { recursive: true, force: true });
  }
});
