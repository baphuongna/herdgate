/**
 * PWA v3 — chat-style threads, path:line deep-links, and the fetch discipline
 * (generation tokens, in-flight sharing, stale-fallback banners).
 *
 * Two halves:
 *   1. the web-asset contract — the markers the chat/fold/subagent/goto/flash
 *      surfaces must keep in app.js and app.css;
 *   2. units of the real module, run in a bare VM (the web-pairing harness
 *      pattern, minus the cloud): parseLineSuffix, diffGotoIndexes, and the
 *      fenced-fetch machinery — join, fresh, generation drop, snapshot banner.
 *
 *   node --test test/web-pwa3.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";

const root = join(import.meta.dirname, "..");

/** Minimal DOM stub — the same shape the pairing harness drives app.js with. */
class Element {
  hidden = true;
  value = "";
  open = false;
  className = "";
  textContent = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  handlers = new Map<string, (event: { preventDefault(): void; target: Element }) => void>();
  nodes = new Map<string, Element>();
  get content() { return this; }
  focus() {}
  close() {}
  setAttribute() {}
  cloneNode() { return new Element(); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  find(check: (node: Element) => boolean): Element | undefined {
    if (check(this)) return this;
    for (const node of this.children) {
      if (!(node instanceof Element)) continue; // plain text nodes ride along
      const hit = node.find(check);
      if (hit) return hit;
    }
    return undefined;
  }
  closest() { return this; }
  querySelector(id: string) {
    if (!this.nodes.has(id)) this.nodes.set(id, new Element());
    return this.nodes.get(id)!;
  }
  addEventListener(event: string, cb: (event: { preventDefault(): void; target: Element }) => void) { this.handlers.set(event, cb); }
  fire(event: string, target = this) { this.handlers.get(event)?.({ preventDefault() {}, target }); }
}

type WebApi = {
  parseLineSuffix(target: string): { path: string; line: number; end: number } | null;
  newGeneration(): string;
  generationCurrent(gen: string): boolean;
  diffGotoIndexes(lines: string[], goto: { path: string; line: number; end?: number }): number[];
  fetchInfo(): { gen: string; inflight: { key: string; gen: string; fresh: boolean }[] };
  fetchDrive(op: string, replyOp: string, payload: Record<string, unknown>, opts?: Record<string, unknown>): { sent: Record<string, unknown>[]; promise: Promise<Record<string, unknown>> };
  fetchReply(payload: Record<string, unknown>): boolean;
  online(): void;
  offline(): void;
  chatFetch(fresh?: boolean): void;
  chatSnap(): { usage: unknown; chatError: string | null; filter: string | null };
  probe: {
    thread(job: Record<string, unknown>): Element;
    subagent(name: string, extra?: Record<string, unknown>): Element;
    linked(text: string): Element;
  };
};

/** Run the real browser module with a minimal DOM; return its test seam. */
function loadApp(): WebApi {
  const source = readFileSync(join(root, "src/web/app.js"), "utf8").replace(/^import .* from "\/e2e.js";$/m, "");
  const doc = new Element();
  const $ = (id: string) => doc.querySelector(id);
  const api: Record<string, unknown> = {};
  runInNewContext(source, {
    document: Object.assign(doc, { getElementById: $, createElement: () => new Element() }),
    Element,
    navigator: { userAgent: "pwa3-test" },
    location: { origin: "http://127.0.0.1:1", protocol: "http:" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WebSocket: Object.assign(class {}, { OPEN: 1 }),
    fetch: async () => { throw new Error("no network in this harness"); },
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    console,
    __herdgateWebTest: api,
  });
  return api as unknown as WebApi;
}

test("web assets: pwa3 markers — chat fold, subagent card, goto line, generation, fresh, stale banner", () => {
  const js = readFileSync(join(root, "src/web/app.js"), "utf8");
  const css = readFileSync(join(root, "src/web/app.css"), "utf8");
  const jsMarkers = [
    "tool-run",        // chat: the folded one-liner under a thread
    "fold",            // chat: the fold element itself
    "subagent",        // chat: Delegation cards for background spawns
    "spawn:",          // chat: the principal shape that becomes a card
    "parseLineSuffix", // diff: the path:line / #Lline parser (filev open_target)
    "#L",              // diff: the #L42 spelling
    "flash",           // diff: the 3s reveal highlight
    "newGeneration",   // fetch discipline: uuid per view-mount
    "generationCurrent", // fetch discipline: the stale-answer guard
    "fresh",           // fetch discipline: reads that must postdate writes
    "fetch-timeout",   // fetch discipline: the transport fault class
    "chatError",       // stale-fallback: the banner state
    "giữ dữ liệu gần nhất", // stale-fallback: snapshots are kept, never blanked
    "usage.rollup",    // still the host op behind the chat (pwa2 marker)
  ];
  for (const marker of jsMarkers) {
    assert.ok(js.includes(marker), `app.js must contain ${marker}`);
  }
  const cssMarkers = [".thread", ".msg.user", ".msg.assistant", ".fold", ".subagent", ".spawn-thread", ".pathline", ".flash"];
  for (const marker of cssMarkers) {
    assert.ok(css.includes(marker), `app.css must contain ${marker}`);
  }
});

test("pwa3 units: parseLineSuffix — :N, :A-B, #LN, #LA-LB; refuses non-files", () => {
  const api = loadApp();
  // JSON round-trip: objects born in the VM realm must compare by value here.
  const parse = (t: string) => JSON.parse(JSON.stringify(api.parseLineSuffix(t)));
  assert.deepEqual(parse("src/app.rs:42"), { path: "src/app.rs", line: 42, end: 42 });
  assert.deepEqual(parse("src/app.rs:42-48"), { path: "src/app.rs", line: 42, end: 48 });
  assert.deepEqual(parse("hello.txt#L2"), { path: "hello.txt", line: 2, end: 2 });
  assert.deepEqual(parse("hello.txt#L2-L4"), { path: "hello.txt", line: 2, end: 4 });
  assert.deepEqual(parse("hello.txt#L2-4"), { path: "hello.txt", line: 2, end: 4 });
  assert.deepEqual(parse("docs/notes.md#L10"), { path: "docs/notes.md", line: 10, end: 10 });
  for (const bad of ["", "HEAD", "main", "10:30", "hello.txt:0", "hello.txt:41-7", "hello.txt:123456789", "a b.txt:42", "hello.txt", "hello.txt:"]) {
    assert.equal(api.parseLineSuffix(bad), null, `${JSON.stringify(bad)} must not parse as path:line`);
  }
});

test("pwa3 units: generation tokens — a uuid per mount; old generations retire", () => {
  const api = loadApp();
  const g1 = api.newGeneration();
  assert.equal(typeof g1, "string", "the generation token is a string (uuid-shaped)");
  assert.ok(g1!.length >= 8);
  assert.equal(api.generationCurrent(g1!), true);
  const g2 = api.newGeneration();
  assert.notEqual(g1, g2, "each view mount mints a fresh token");
  assert.equal(api.generationCurrent(g1!), false, "an old generation must never own the screen again");
  assert.equal(api.generationCurrent(g2!), true);
});

test("pwa3 units: fenced fetches — join the flight, fresh replaces it", async () => {
  const api = loadApp();
  // join: the same op flying under the same generation is sent once, and every
  // caller hears the one reply.
  const a = api.fetchDrive("usage.rollup", "usage.rollup.result", { days: 7 }, { key: "chat-usage" });
  const b = api.fetchDrive("usage.rollup", "usage.rollup.result", { days: 7 }, { key: "chat-usage" });
  await delay(0);
  assert.equal(a.sent.length, 1, "the first caller sends");
  assert.equal(b.sent.length, 0, "the second caller joins the flight instead of re-sending");
  assert.equal(api.fetchInfo().inflight.length, 1);
  let gotA: unknown = null;
  let gotB: unknown = null;
  void a.promise.then((p) => { gotA = p; });
  void b.promise.then((p) => { gotB = p; });
  assert.equal(api.fetchReply({ op: "usage.rollup.result", total: { requests: 1 } }), true, "the fence consumes the reply");
  await delay(0);
  assert.equal((gotA as { op: string }).op, "usage.rollup.result");
  assert.equal((gotB as { op: string }).op, "usage.rollup.result");
  assert.equal(api.fetchInfo().inflight.length, 0, "the flight lands");

  // fresh: a read that must postdate earlier writes never joins the older flight.
  const c = api.fetchDrive("usage.rollup", "usage.rollup.result", { days: 7 }, { key: "chat-usage" });
  await delay(0);
  assert.equal(c.sent.length, 1);
  let superseded = false;
  void c.promise.then((p) => { superseded = Boolean((p as { fault?: string }).fault); });
  const d = api.fetchDrive("usage.rollup", "usage.rollup.result", { days: 7 }, { key: "chat-usage", fresh: true });
  await delay(0);
  assert.equal(d.sent.length, 1, "fresh must start its own flight");
  assert.equal(superseded, true, "the replaced flight settles immediately as superseded");
  assert.equal(api.fetchInfo().inflight.length, 1, "the older flight is replaced, not stacked");
  assert.equal(api.fetchReply({ op: "usage.rollup.result", total: { requests: 2 } }), true);
  await delay(0);
});

test("pwa3 units: a stale answer is dropped; a transport fault keeps the snapshot and raises a banner", async () => {
  const api = loadApp();
  api.online();
  // stale: a usage reply that answers an older generation never becomes state.
  api.chatFetch();
  await delay(0);
  assert.deepEqual(JSON.parse(JSON.stringify(api.fetchInfo().inflight.map((f) => f.key))), ["chat-usage"]);
  api.newGeneration(); // the view remounts mid-flight
  assert.equal(api.fetchReply({ op: "usage.rollup.result", total: { requests: 9 }, days: [], byPrincipal: [] }), true);
  await delay(10);
  assert.equal(api.chatSnap().usage, null, "a stale answer must be dropped on arrival");

  // current: the same reply under the live generation applies.
  api.chatFetch();
  api.fetchReply({ op: "usage.rollup.result", total: { requests: 3 }, days: [], byPrincipal: [] });
  await delay(10);
  assert.ok(api.chatSnap().usage, "the current generation's answer applies");
  assert.equal(api.chatSnap().chatError, null);

  // transport fault: the snapshot survives and a banner says why — never a silent blank.
  const before = api.chatSnap().usage;
  api.offline();
  api.chatFetch(true);
  await delay(10);
  assert.equal(api.chatSnap().usage, before, "the last snapshot survives the fault");
  assert.match(String(api.chatSnap().chatError), /giữ dữ liệu gần nhất/, "the banner names its verdict");
});

test("pwa3 units: the chat thread renders — user bubble, tool-run fold, path:line links, Delegation card", async () => {
  const api = loadApp();
  const job = {
    id: "11111111-2222-4333-8444-555555555555",
    status: "replied",
    hasBody: true,
    prompt: "sửa lỗi login ở src/app.js:120 rồi báo lại",
    body: "đã sửa src/app.js:120 và thêm test ở test/app.test.ts:42",
    events: [
      { at: Date.now() - 60_000, status: "queued", reason: null, tokens: null },
      { at: Date.now(), status: "replied", reason: null, tokens: 1234 },
    ],
  };
  const thread = api.probe.thread(job);
  assert.ok(thread!.find((n) => n.className === "msg user" && n.textContent.includes("login")), "the prompt is the session's user bubble");
  const fold = thread!.find((n) => String(n.className).includes("fold"));
  assert.ok(fold, "receipt events fold under the thread");
  assert.match(fold!.children[0]!.textContent, /tool-run · receipt 11111111/, "the fold is one line naming the receipt");
  assert.ok(fold!.children.length <= 2, "closed, it is summary + detail only");
  const reply = thread!.find((n) => n.className === "msg assistant");
  assert.ok(reply, "the reply is the assistant bubble");
  const link = reply!.find((n) => n.className === "link pathline");
  assert.ok(link, "path:line tokens in a reply become jump links");
  assert.equal(link!.textContent, "src/app.js:120");

  // a job still in flight: no body yet — the bubble carries the verdict glyph + status
  const pending = api.probe.thread({ id: "99999999-8888-4999-8999-999999999999", status: "running" });
  const pendingBubble = pending!.find((n) => n.className === "msg assistant");
  assert.ok(pendingBubble!.find((n) => n.textContent === "running"), "a pending job states its verdict");
  assert.ok(pendingBubble!.find((n) => n.textContent === "◐"), "…with its working glyph");

  // Delegation card: name + status + tokens; clicking filters the chat
  const card = api.probe.subagent("nightly-build");
  assert.match(card!.children[0]!.textContent, /nightly-build/, "the card names the subagent");
  assert.match(card!.children[1]!.textContent, /running|done/, "the card carries a status");
  assert.match(card!.children[2]!.textContent, /4321 tokens/, "the card carries its tokens");
  card!.fire("click");
  assert.equal(api.chatSnap().filter, "spawn:nightly-build", "clicking a card filters the chat to that subagent");
  card!.fire("click");
  assert.equal(api.chatSnap().filter, null, "clicking again clears the filter");
});

test("pwa3 units: diffGotoIndexes walks a real `git show` patch to the target line", () => {
  const api = loadApp();
  // Exactly what `git show --stat --patch` answers for the pwa2 fixture repo:
  // a stat block, then one patch. renderWorkerDiff hands diffGotoIndexes the
  // patch lines (from the first `diff --git`).
  const patch = [
    "diff --git a/hello.txt b/hello.txt",
    "index 1111111..2222222 100644",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1,2 @@",
    " one",
    "+two",
  ];
  const goto = (lines: string[], g: { path: string; line: number; end?: number }) => JSON.parse(JSON.stringify(api.diffGotoIndexes(lines, g)));
  assert.deepEqual(goto(patch, { path: "hello.txt", line: 2, end: 2 }), [patch.indexOf("+two")]);
  assert.deepEqual(
    goto(patch, { path: "hello.txt", line: 1, end: 2 }),
    [patch.indexOf(" one"), patch.indexOf("+two")],
    "a range covers every row it names",
  );
  assert.deepEqual(goto(patch, { path: "other.txt", line: 1, end: 1 }), [], "an absent path yields nothing — graceful");
  assert.deepEqual(goto(patch, { path: "hello.txt", line: 9, end: 9 }), [], "an absent line yields nothing — graceful");

  // Two files in one patch: the walk must switch files and count each hunk's new side.
  const two = [
    "diff --git a/src/one.rs b/src/one.rs",
    "index 1111111..2222222 100644",
    "--- a/src/one.rs",
    "+++ b/src/one.rs",
    "@@ -1,3 +1,4 @@",
    " fn main() {",
    "+    let x = 1;",
    " }",
    "diff --git a/two.rs b/two.rs",
    "index 3333333..4444444 100644",
    "--- a/two.rs",
    "+++ b/two.rs",
    "@@ -5 +5 @@",
    "-old",
    "+fresh",
  ];
  assert.deepEqual(goto(two, { path: "src/one.rs", line: 2, end: 2 }), [two.indexOf("+    let x = 1;")]);
  assert.deepEqual(goto(two, { path: "two.rs", line: 5, end: 5 }), [two.indexOf("+fresh")]);
  // a bare name still matches a nested file (the deep link may be relative)
  assert.deepEqual(goto(two, { path: "one.rs", line: 2, end: 2 }), [two.indexOf("+    let x = 1;")]);
});
