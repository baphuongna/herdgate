/**
 * The admin page (/admin), client side (spec: docs/specs/2026-11-25-web-admin.md).
 *
 *   - static: the pretty URL is an alias to a real file and inherits every refusal rule;
 *   - the gateway serves /admin and its files under the PWA's CSP, never shadowing /v1;
 *   - client rules: text only, the token in exactly one header, every call same-origin /v1;
 *   - markup: every id the script looks up exists; every view has a section and a nav button;
 *     nothing inline (CSP allows none of it);
 *   - the service worker handles the shell ONLY — proven by running it against synthetic requests,
 *     so neither /admin nor a deploy of it can ever land in the PWA's offline cache;
 *   - admin-model.js: the reading and formatting rules, in plain Node.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";

import { resolveStatic, CSP } from "../src/cloud/static.ts";
import { startCloud } from "../src/cloud/gateway.ts";
import * as M from "../src/web/admin-model.js";

const WEB = new URL("../src/web/", import.meta.url).pathname;
const read = (name: string) => readFileSync(join(WEB, name), "utf8");

function withRoot(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "herdgate-admin-web-"));
  try {
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>shell</title>");
    writeFileSync(join(dir, "admin.html"), "<!doctype html><title>admin</title>");
    writeFileSync(join(dir, "admin.js"), "export {};\n");
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The source with comments removed: prose about a rule is not a violation of it. */
function codeOnly(src: string): string {
  return src
    .replace(/(^|\n)[ \t]*\/\*[\s\S]*?\*\//g, "\n")
    .replace(/(^|\n)[ \t]*\/\/.*$/g, "\n");
}

test("static: /admin is served only through an explicit alias, with every refusal rule intact", () => {
  withRoot((dir) => {
    assert.equal(resolveStatic(dir, "/admin", { root: dir }), null, "no alias, no file: a 404, not a guess");
    const aliases = { "/admin": "/admin.html" };
    const hit = resolveStatic(dir, "/admin", { root: dir, aliases })!;
    assert.ok(hit, "/admin resolves through the alias");
    assert.match(hit.filePath!, /admin\.html$/);
    assert.equal(hit.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(hit.headers["cache-control"], "no-store", "a deploy must win at once");
    assert.equal(hit.headers["content-security-policy"], CSP, "the admin page lives under the PWA's CSP");
    assert.match(resolveStatic(dir, "/admin?from=pwa", { root: dir, aliases })!.filePath!, /admin\.html$/, "the query is ignored");
    assert.match(resolveStatic(dir, "/admin", { root: dir, aliases: { "/admin": "admin.js" } })!.filePath!, /admin\.js$/, "a relative target is rooted at the web root");
    assert.equal(resolveStatic(dir, "/admin", { root: dir, aliases: { "/admin": "../secret" } }), null, "an alias cannot climb out");
    assert.equal(resolveStatic(dir, "/admin", { root: dir, aliases: { "/admin": "/.env" } }), null, "an alias cannot reach a dotfile");
    assert.equal(resolveStatic(dir, "/admin", { root: dir, aliases: { "/admin": "/nope.html" } }), null, "an alias to a missing file is a 404");
    assert.equal(resolveStatic(dir, "/admin/", { root: dir, aliases }), null, "a trailing slash is not the alias");
    assert.equal(resolveStatic(dir, "/ADMIN", { root: dir, aliases }), null, "aliases are exact");
  });
});

test("gateway: /admin and its files are served under the CSP; /v1 keeps precedence", async () => {
  const cloud = await startCloud({ accounts: [{ id: "a1", name: "owner", token: "tok" }], webRoot: WEB, log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  try {
    const page = await fetch(`${base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'none'/);
    assert.match(await page.text(), /id="signin"/);

    for (const [path, type] of [
      ["/admin.js", /text\/javascript/],
      ["/admin.css", /text\/css/],
      ["/admin-model.js", /text\/javascript/],
    ] as const) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, `${path} is served`);
      assert.match(r.headers.get("content-type") ?? "", type);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    const head = await fetch(`${base}/admin`, { method: "HEAD" });
    assert.equal(head.status, 200, "HEAD works too");

    // An API-looking path is the API's, not a file's — and the admin API is the owner's.
    const api = await fetch(`${base}/v1/admin/overview`);
    assert.equal(api.status, 401, "/v1/admin/overview is a route, not a file, and needs the token");
    assert.equal((await fetch(`${base}/admin/nope`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200, "the PWA shell is still where it was");
  } finally {
    await cloud.close();
  }
});

test("client: renders text only; the token rides in one header and every call is same-origin /v1", () => {
  for (const file of ["admin.js", "admin-model.js"]) {
    const src = codeOnly(read(file));
    for (const banned of ["innerHTML", "insertAdjacentHTML", "outerHTML", "document.write", "eval(", "new Function("]) {
      assert.ok(!src.includes(banned), `${file}: no ${banned}`);
    }
  }
  const src = codeOnly(read("admin.js"));

  // One fetch site, and it takes the path as a value: no URL is ever spelled at the fetch itself.
  assert.equal([...src.matchAll(/\bfetch\(/g)].length, 1, "exactly one fetch call site (api())");
  assert.ok(!/fetch\(\s*["'`]/.test(src), "the fetch never names a URL literal");
  assert.match(src, /authorization: `Bearer \$\{state\.token\}`/, "the token goes in the Authorization header");
  // Every call into api() spells a same-origin /v1 path.
  const calls = [...src.matchAll(/\bapi\(\s*(["'`])([^"'`]+)/g)].map((m) => m[2]);
  assert.ok(calls.length >= 8, "the page talks to the gate through api()");
  for (const c of calls) assert.match(c, /^\/v1\//, `same-origin API only: ${c}`);
  assert.ok(!/https?:\/\//.test(src), "no absolute URL anywhere in the client");
  // The token is stored under the PWA's key and nowhere else, and never leaves as a query or a hash.
  assert.deepEqual([...src.matchAll(/localStorage\.(?:get|set|remove)Item\(([^)]*)\)/g)].map((m) => m[1].replace(/\s*=.*/, "").trim()), ["TOKEN_KEY", "TOKEN_KEY, token", "TOKEN_KEY"]);
  assert.ok(!/token=\$\{|[?&]token=/.test(src), "the token is never in a URL");

  // Destructive actions keep their confirmation; names go through the same rule as the gate.
  for (const guarded of ["window.confirm(M.removeRoomText(room))", "window.confirm(M.withdrawText(device))", "window.confirm(M.revokeText(device))", 'window.confirm("Xoá key SSH này']) {
    assert.ok(src.includes(guarded), `a confirmation guards: ${guarded}`);
  }
  assert.match(src, /M\.validateName\(raw\)/, "names are validated before being sent");
  assert.match(src, /scope: "read"/, "the page only ever asks for read");
  assert.ok(!/scope: "act"/.test(src), "the page never asks for act");
  assert.match(src, /document\.hidden/, "polling pauses with the tab");
  assert.match(src, /visibilitychange/, "and resumes when it is shown again");
});

test("markup: every id the script uses exists, every view has a section and a button, nothing is inline", () => {
  const html = read("admin.html");
  const js = read("admin.js");
  const ids = new Set([...js.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `admin.html has #${id}`);
  const views = JSON.parse(js.match(/const VIEWS = (\[[^\]]*\])/)![1].replace(/'/g, '"')) as string[];
  assert.equal(views.length, 5);
  for (const v of views) {
    assert.match(html, new RegExp(`id="view-${v}"`), `section for ${v}`);
    assert.match(html, new RegExp(`data-view="${v}"`), `nav button for ${v}`);
  }
  assert.ok(!/<script(?![^>]*\ssrc=)/.test(html), "no inline script");
  assert.ok(!/<style\b/.test(html), "no inline style block");
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "no inline event handlers");
  assert.ok(!/\sstyle\s*=/i.test(html), "no style attributes");
  assert.ok(!/javascript:/.test(html), "no javascript: URLs");
  assert.match(html, /<html lang="vi">/);
  assert.match(html, /<meta name="robots" content="noindex"/, "the console is not for search engines");
  assert.match(read("index.html"), /<a href="\/admin">/, "the PWA links to its console");
});

/** Run sw.js in a bare sandbox and return a driver: did the worker take the request or not? */
function runServiceWorker(): { takes: (url: string, o?: { mode?: string; method?: string }) => boolean; cacheKeys: () => string[] } {
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  const cache = new Map<string, unknown>();
  const caches = {
    open: async () => ({ put: async (k: unknown, v: unknown) => void cache.set(String(k), v), addAll: async () => {} }),
    match: async (k: unknown) => cache.get(String(k)),
    keys: async () => [...cache.keys()],
    delete: async () => true,
  };
  const self = {
    location: { origin: "https://gate.test" },
    addEventListener: (type: string, fn: (ev: unknown) => void) => void ((listeners[type] ??= []).push(fn)),
    clients: { matchAll: async () => [], claim: async () => {}, openWindow: async () => {} },
    registration: {},
    skipWaiting() {},
    importScripts() {},
  };
  runInNewContext(read("sw.js"), { self, caches, URL, Response, fetch: () => new Promise<Response>(() => {}), console, setTimeout, importScripts() {} });
  assert.ok(listeners.fetch?.length === 1, "one fetch handler");
  return {
    takes: (url, o = {}) => {
      let took = false;
      for (const fn of listeners.fetch!) fn({ request: { method: o.method ?? "GET", url, mode: o.mode ?? "cors" }, respondWith: () => void (took = true) });
      return took;
    },
    cacheKeys: () => [...cache.keys()],
  };
}

test("service worker: handles the shell navigation and SHELL assets only — /admin* and the API go to the network", () => {
  const sw = runServiceWorker();
  const ORIGIN = "https://gate.test";
  assert.equal(sw.takes(`${ORIGIN}/`, { mode: "navigate" }), true, "the shell navigation is network-first");
  assert.equal(sw.takes(`${ORIGIN}/#room=r_1`, { mode: "navigate" }), true, "a hash route is still the shell");
  for (const asset of ["/app.js", "/app.css", "/e2e.js", "/app.webmanifest", "/icons/icon.svg"]) {
    assert.equal(sw.takes(`${ORIGIN}${asset}?v=1`), true, `${asset} is a shell asset (query ignored by URL)`);
  }
  for (const path of ["/admin", "/admin?x=1", "/admin.html", "/admin.js", "/admin.css", "/admin-model.js"]) {
    for (const mode of ["navigate", "cors"]) {
      assert.equal(sw.takes(`${ORIGIN}${path}`, { mode }), false, `${path} (${mode}) is not the worker's business`);
    }
  }
  for (const path of ["/v1/admin/overview", "/v1/device/ws", "/healthz", "/pair?code=ABCD2345", "/icons/other.png"]) {
    assert.equal(sw.takes(`${ORIGIN}${path}`, { mode: path === "/pair" ? "navigate" : "cors" }), false, `${path} is never intercepted`);
  }
  assert.equal(sw.takes("https://evil.test/app.js"), false, "another origin is never touched");
  assert.equal(sw.takes(`${ORIGIN}/v1/device/push`, { method: "POST" }), false, "writes are never touched");
  sw.takes(`${ORIGIN}/admin`, { mode: "navigate" });
  sw.takes(`${ORIGIN}/admin.js`);
  assert.deepEqual(sw.cacheKeys(), [], "an admin request puts nothing in the PWA's cache (no shadow '/' entry, no stale admin.js)");
});

const pad = (n: number) => String(n).padStart(2, "0");

test("model: names follow the gate's rule, including combining marks and zero-width characters", () => {
  assert.equal(M.validateName("  Laptop khác  "), "Laptop khác");
  assert.equal(M.validateName("thế hệ mới"), "thế hệ mới", "precomposed Vietnamese is kept");
  assert.equal(M.validateName("e\u0301"), "e\u0301", "a combining accent is a letter, not a control character");
  assert.equal(M.validateName("tab\t"), "tab", "a trailing control character is trimmed away, exactly as the gate does");
  for (const bad of ["", "   ", "x".repeat(65), "bell\u0007", "zero\u200bwidth", "ta\tb", "a\nb", 42, null, undefined, {}]) {
    assert.equal(M.validateName(bad as string), null, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(M.validateName("x".repeat(64)), "x".repeat(64), "64 is allowed, 65 is not");
});

test("model: filtering ignores case and diacritics, and sorts by machine then name", () => {
  assert.equal(M.matches("laptop", "Laptop KHÁC"), true);
  assert.equal(M.matches("dien thoai", "điện thoại"), true, "the owner may type without diacritics");
  assert.equal(M.matches("điện", "dien"), true, "marks are dropped on both sides, so either spelling finds the other");
  assert.equal(M.matches("", "anything"), true);
  assert.equal(M.matches("xyz", "abc", "abd"), false);
  const devices = [
    { id: "d_2", name: "beta", roomName: "Zeta", scope: "act" },
    { id: "d_1", name: "alpha", roomName: "Álpha", scope: "read" },
    { id: "d_3", name: "gamma", roomName: "Álpha", scope: "read" },
  ];
  assert.deepEqual(M.filterDevices(devices, "").map((d) => d.id), ["d_1", "d_3", "d_2"]);
  assert.deepEqual(M.filterDevices(devices, "act").map((d) => d.id), ["d_2"], "scope is searchable");
  assert.deepEqual(M.filterDevices(devices, "alpha").map((d) => d.id), ["d_1", "d_3"], "name and machine both match, diacritics aside");
  assert.deepEqual(M.filterDevices(devices, "d_3").map((d) => d.id), ["d_3"], "ids are searchable");
  assert.deepEqual(M.filterDevices(undefined, ""), []);
  assert.deepEqual(M.filterRooms([{ id: "r_1", name: "b", host: { name: "HOST-B", version: "0.14.0" } }, { id: "r_2", name: "a", host: null }], "0.14").map((r) => r.id), ["r_1"], "rooms match on host version too");
});

test("model: durations, ages, legs and clocks read the way the owner expects", () => {
  assert.equal(M.fmtDuration(0), "0 giây");
  assert.equal(M.fmtDuration(59), "59 giây");
  assert.equal(M.fmtDuration(60), "1 ph 00 giây");
  assert.equal(M.fmtDuration(3723), "1 giờ 02 ph");
  assert.equal(M.fmtDuration(90_000), "1 ngày 1 giờ");
  assert.equal(M.fmtDuration(-5), "0 giây", "clock skew never shows a negative age");
  assert.equal(M.fmtDuration(NaN), "—");
  assert.equal(M.fmtDuration("x" as unknown as number), "—");

  const now = Date.parse("2026-11-24T16:05:07Z");
  const local = new Date(now);
  assert.equal(M.fmtClock("2026-11-24T16:05:07Z"), `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`, "local wall-clock time, no locale involved");
  assert.equal(M.fmtClock("garbage"), "—");
  assert.equal(M.fmtDateTime("2026-11-24T16:05:07Z"), `${pad(local.getDate())}/${pad(local.getMonth() + 1)} ${pad(local.getHours())}:${pad(local.getMinutes())}`);

  assert.equal(M.lastSeenText({ at: now - 65_000, leg: "ssh" }, now), "SSH · 1 ph 05 giây trước");
  assert.equal(M.lastSeenText({ at: now - 3_000, leg: "web" }, now), "web · 3 giây trước");
  assert.equal(M.lastSeenText(null, now), "chưa thấy");
  assert.equal(M.lastSeenText(undefined, now), "chưa thấy");
  assert.equal(M.legsText({ legs: ["web", "ssh"] }), "web + ssh");
  assert.equal(M.legsText({ legs: [] }), "—");
  assert.equal(M.legsText({}), "—");
});

test("model: the event tail merges by seq, never duplicates, and keeps the newest", () => {
  const e = (seq: number) => ({ seq, at: "2026-11-24T16:05:07Z", line: `line ${seq}`, kind: "other" });
  assert.deepEqual(M.mergeEvents([], [e(1), e(2)]).map((x) => x.seq), [1, 2]);
  assert.deepEqual(M.mergeEvents([e(1), e(2)], [e(2), e(3), e(4)]).map((x) => x.seq), [1, 2, 3, 4], "a re-delivered line is dropped");
  assert.deepEqual(M.mergeEvents([e(3)], [e(1), e(2)]).map((x) => x.seq), [1, 2, 3], "order is by seq, not arrival");
  assert.deepEqual(M.mergeEvents([e(1)], undefined).map((x) => x.seq), [1]);
  const many = M.mergeEvents([], Array.from({ length: 7 }, (_, i) => e(i + 1)), 5);
  assert.deepEqual(many.map((x) => x.seq), [3, 4, 5, 6, 7], "capped to the newest");
  assert.deepEqual(M.mergeEvents([e(1)], [{ no: "seq" }, null]).map((x) => x.seq), [1], "garbage is ignored, not thrown");
  assert.equal(M.isOwnerAction("room r_1 (a) removed by owner with 1 device(s)"), true);
  assert.equal(M.isOwnerAction("device d_1 (phone) withdrawn to read by owner"), true);
  assert.equal(M.isOwnerAction("agent r_1 (a) connected"), false);
  assert.equal(M.isOwnerAction(undefined), false);
});

test("model: the gate's answers are told apart for the owner, and polling only runs when it should", () => {
  assert.match(M.errorText(401, { error: "account token required" }), /Token/);
  assert.match(M.errorText(404, null), /Không tìm thấy/);
  assert.match(M.errorText(422, { error: "act is granted by the host at pairing" }), /granted by the host/, "the gate's own reason is kept");
  assert.match(M.errorText(429, {}), /Quá nhanh/);
  assert.match(M.errorText(400, { error: "name must be 1-64" }), /1-64/);
  assert.equal(M.errorText(500, null), "Lỗi 500");
  assert.equal(M.pollIntervalMs({ visible: true, signedIn: true }), M.POLL_MS);
  assert.equal(M.POLL_MS, 4000);
  assert.equal(M.pollIntervalMs({ visible: false, signedIn: true }), 0, "a hidden tab does not poll");
  assert.equal(M.pollIntervalMs({ visible: true, signedIn: false }), 0, "a signed-out page does not poll");

  const o = { counts: { rooms: 5, devices: 13, agentsOnline: 3, devicesLive: 4, pendingCodes: 2 }, gate: { version: "0.14.0", uptimeSec: 3723, startedAt: "2026-11-24T12:00:00Z", ssh: { enabled: true, publicPort: 2299 }, push: true, web: true } };
  assert.deepEqual(M.countCards(o), [
    { label: "Máy", value: 5, note: "3 publisher đang nối" },
    { label: "Thiết bị", value: 13, note: "4 đang nối" },
    { label: "Mã ghép chờ", value: 2, note: "cần duyệt" },
  ]);
  assert.equal(M.countCards({ counts: { pendingCodes: 0 } })[2].note, "không có");
  const facts = M.gateFacts(o.gate);
  assert.deepEqual(facts[0], ["Phiên bản", "0.14.0"]);
  assert.deepEqual(facts[3], ["SSH-leg", "bật · cổng công khai 2299"]);
  assert.deepEqual(M.gateFacts({ ssh: { enabled: false } })[3], ["SSH-leg", "tắt"]);
  assert.equal(M.roomStateText({ connected: true, host: { version: "0.14.0" } }), "publisher online · bản 0.14.0");
  assert.equal(M.roomStateText({ connected: true, host: null }), "publisher online · chưa báo phiên bản");
  assert.equal(M.roomStateText({ connected: false }), "publisher offline");
  assert.match(M.removeRoomText({ name: "old", devices: { total: 3 } }), /«old» cùng 3 thiết bị\?/);
  assert.match(M.removeRoomText({ name: "old", devices: { total: 0 } }), /«old»\?/, "no device count when there are none");
  assert.match(M.withdrawText({ name: "tablet", roomName: "laptop" }), /«tablet» \(máy laptop\)/);
  assert.match(M.revokeText({ name: "tablet", roomName: "laptop" }), /vĩnh viễn/);
});
