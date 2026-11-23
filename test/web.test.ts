/**
 * The PWA: static serving safety, and the app's contract with the wire.
 *
 * Two halves:
 *   - `resolveStatic` against a real temp directory: traversal, dotfiles, symlink escape,
 *     CSP/cache headers (these are security-shaped, so they are asserted, not assumed);
 *   - the served app shell and the client source, checked for the rules it must keep
 *     (textContent only, the two ops it may send, no token exfiltration).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveStatic, CSP } from "../src/cloud/static.ts";
import { startCloud } from "../src/cloud/gateway.ts";

const WEB = new URL("../src/web/", import.meta.url).pathname;

function withRoot(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-web-"));
  try {
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>shell</title>");
    writeFileSync(join(dir, "app.js"), "export {};\n");
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "a.css"), "body{}");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("static: serves the shell at / and normal files, with a locking-down CSP", () => {
  withRoot((dir) => {
    const root = resolveStatic(dir, "/", { root: dir })!;
    assert.ok(root, "/ resolves");
    assert.match(root.filePath!, /index\.html$/);
    assert.equal(root.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(root.headers["cache-control"], "no-store", "the shell must never be cached stale");
    assert.equal(root.headers["content-security-policy"], CSP);
    assert.equal(root.headers["x-content-type-options"], "nosniff");
    assert.equal(root.headers["x-frame-options"], "DENY");

    const js = resolveStatic(dir, "/app.js?cache=1", { root: dir })!;
    assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8", "the query is ignored");
    const css = resolveStatic(dir, "/sub/a.css", { root: dir })!;
    assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
  });
});

test("static: refuses traversal, dotfiles, directories and escapes", () => {
  withRoot((dir) => {
    const outside = mkdtempSync(join(tmpdir(), "herdgate-outside-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    try {
      symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));

      for (const attempt of [
        "/../etc/passwd",
        "/sub/../../etc/passwd",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/..%2fetc/passwd",
        "/.env",
        "/sub/.env",
        "/sub/",
        "/nope.js",
        "/link.txt", // a symlink leaving the root
        "/%00.txt",
        "//",
        "/%zz",
      ]) {
        assert.equal(resolveStatic(dir, attempt, { root: dir }), null, `refused: ${attempt}`);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("static: a missing root is not an error, just nothing to serve", () => {
  assert.equal(resolveStatic("/definitely/not/here", "/", { root: "/definitely/not/here" }), null);
});

test("gateway: serves the PWA but never shadows /v1", async () => {
  const cloud = await startCloud({
    accounts: [{ id: "a1", name: "owner", token: "tok" }],
    webRoot: WEB,
    log: () => {},
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-type") ?? "", /text\/html/);
    assert.match(shell.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(await shell.text(), /id="signin"|id="rooms"/);

    for (const path of ["/app.js", "/app.css", "/sw.js", "/app.webmanifest", "/icons/icon.svg"]) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, `${path} is served`);
    }

    // API routes keep precedence over the static handler.
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");

    // An unknown API-looking path is a 404, not a file.
    const missing = await fetch(`${base}/v1/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await cloud.close();
  }
});

/** The source with comments removed: prose about a rule is not a violation of it.
 *  Block comments are stripped only at line starts — a string may legally
 *  contain "image/*" (found live: the old rule swallowed half the file). */
function codeOnly(src: string): string {
  return src
    .replace(/(^|\n)[ \t]*\/\*[\s\S]*?\*\//g, "\n") // /* block */ at line start
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // // line (leaving "https://" intact)
}

test("client: renders text only, and sends nothing but view", () => {
  const src = codeOnly(readFileSync(join(WEB, "app.js"), "utf8"));
  assert.ok(!src.includes("innerHTML"), "no innerHTML: every string from the wire is untrusted");
  assert.ok(!src.includes("insertAdjacentHTML"), "no HTML injection helpers");
  assert.ok(!src.includes("document.write"), "no document.write");

  // Every op this client may send, dot-names included — an explicit allowlist,
  // not a shape accident. tab.*/term.send/term.keys run only when the device
  // holds an act grant; the host refuses the rest.
  const ops = [...src.matchAll(/op:\s*"([a-z][a-z.]*)"/g)].map((m) => m[1]);
  const allowed = ["loop.status", "receipt.ack", "receipt.get", "receipt.watch", "review.send", "tab.close", "tab.create", "term.list", "term.read", "term.send", "view", "worker.health", "worker.submit"];
  assert.deepEqual([...new Set(ops)].sort(), allowed, "the client sends exactly the allowlisted ops");
  // The typing lane and the phone-tab chips exist only behind the act check.
  assert.match(src, /state\.deviceScope === "act"/, "typing and tab creation are act-gated in the UI");
  assert.match(src, /hg-phone-tabs:/, "phone-opened tabs are tracked session-side");

  // The token goes to the cloud's WS endpoint only: no fetch/beacon to anywhere else.
  assert.ok(!/fetch\([^)]*token/i.test(src), "the token is never put in a URL");
  assert.ok(!src.includes("navigator.sendBeacon"), "no beacon exfiltration");
});

test("client: the roster shows the publisher build when the room reports it", () => {
  const src = codeOnly(readFileSync(join(WEB, "app.js"), "utf8"));
  // The devices block fetches /v1/devices (account lane, no new op); when the
  // gate answers with host info, one muted line names the running build.
  assert.match(src, /host\.version/, "the roster line renders host.version");
  assert.match(src, /v1\/devices/, "still the same roster fetch — no new wire surface");
});

test("client: the roster separates host-alive from device liveness", () => {
  const src = codeOnly(readFileSync(join(WEB, "app.js"), "utf8"));
  // Room rows name whose presence they report: the publisher's, not a bare
  // "online" an operator can read as "the machine is connected" (2026-11-23:
  // 0/6 live was read as "laptop disconnected" while the publisher was up).
  assert.match(src, /host online/, "room rows say 'host online'");
  // The devices block shows the host's own aliveness where the owner looks.
  assert.match(src, /host\.connected/, "the roster line renders host.connected");
  // Device liveness names its leg(s): web and ssh are different lanes, and an
  // ssh-only device (the machine lane) is live too.
  assert.match(src, /d\.legs/, "device lines render the legs they are live on");
});

test("client: a device that was just here says so — lastSeen names the leg and the age", () => {
  const src = codeOnly(readFileSync(join(WEB, "app.js"), "utf8"));
  // The mobile native app authenticates in 1–2s bursts every ~17s: `connected`
  // sampled at a random moment misses it (caught live 2026-11-23 — the roster
  // read `offline, legs []` while the owner was inside the app). Between
  // bursts the row must say when the device was last seen, not bare silence.
  assert.match(src, /d\.lastSeen/, "device rows read d.lastSeen");
  assert.match(src, /lastSeen\.at/, "the age renders from lastSeen.at");
  assert.match(src, /last seen /, "the wording says what it is");
});

test("client: the worker box shows the dev-loop's own status line", () => {
  const src = codeOnly(readFileSync(join(WEB, "app.js"), "utf8"));
  // C21 shipped the read-only loop.status op; C22 makes the phone SEE it — one
  // muted line beside the worker queue line: status, pause+who, cycles, last
  // nudge. An old host that has no such op must not paint the room red for it.
  assert.match(src, /op === "loop\.status"/, "the loop.status reply is handled");
  assert.match(src, /payload\.loop/, "the loop state rides payload.loop");
  assert.match(src, /dev-loop: /, "the line names what it is");
  assert.match(src, /lastNudgeAt/, "the last nudge renders");
  assert.match(src, /pausedBy/, "who paused the loop is shown");
  assert.match(src, /no op loop\\\.status/, "an old host's refusal is swallowed, not a room error");
});

test("client: review.send closes the loop — the phone learns when the agent is done", () => {
  const src = codeOnly(readFileSync(join(WEB, "app.js"), "utf8"));
  // The reply handler subscribes the review job like a typed one.
  assert.match(src, /payload\.op === "review\.sent"[\s\S]{0,900}receipt\.watch/, "review.sent registers a receipt.watch");
  assert.match(src, /r\.linkedJob = \{ id: payload\.id, status: "queued" \}/, "the Review tab links to its job");
  assert.match(src, /linked\.id === id && fields\.status/, "workerJobTouched mirrors the status into the Review tab");
  // The chip renders the lifecycle, not a static "sent".
  assert.match(src, /agent đang xử lý/, "a pending chip names the wait");
  assert.match(src, /agent đã xử lý/, "a done chip names the outcome");
});

test("client: handles the refusal paths honestly", () => {
  const src = readFileSync(join(WEB, "app.js"), "utf8");
  assert.match(src, /4001/, "a refused token signs the device out instead of retrying");
  assert.match(src, /pair\.denied/, "a denied pair is shown, not swallowed");
  assert.match(src, /host offline|host is not connected/, "an offline host is stated plainly");
});
