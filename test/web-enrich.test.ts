/**
 * PWA w4 — receipt.enrich: the detail expansion under a receipt row
 * (model · context · turns · usage · last activity).
 *
 * Two halves, mirroring the web-pwa3 pattern:
 *   1. the web-asset contract — the markers the enrich surface must keep in
 *      app.js (the op, its reply, the panel) and app.css (.receipt-detail);
 *   2. units of the real module in a bare VM — the pure formatter enrichRows
 *      (token grouping, the never-invented context bar, local-hour lastTs) and
 *      the fenced enrich state machine (open/loading/apply, verbatim refusal,
 *      toggle-close, one-open-at-a-time).
 *
 * The op itself (journal lookup, transcript parsing, refusals) is covered by
 * the wave-2 plugin suites — no e2e ws here.
 *
 *   node --test test/web-enrich.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";

const root = join(import.meta.dirname, "..");

/** Minimal DOM stub — the same shape the web-pwa3 harness drives app.js with. */
class Element {
  hidden = true;
  value = "";
  open = false;
  className = "";
  textContent = "";
  style: Record<string, string> = {};
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

type Rows = {
  model: string | null;
  context: string | null;
  contextPct: number | null;
  turns: string | null;
  usage: string | null;
  last: string | null;
};

type WebApi = {
  enrichRows(result: Record<string, unknown>): Rows;
  contextPctOf(tokens: unknown, max?: unknown): number | null;
  enrichSnap(): { id: string; loading: boolean; error: string | null; result: Record<string, unknown> | null } | null;
  enrichToggle(id: string): void;
  fetchInfo(): { gen: string; inflight: { key: string; gen: string; fresh: boolean }[] };
  fetchReply(payload: Record<string, unknown>): boolean;
  online(): void;
  offline(): void;
  probe: {
    detail(id: string): Element;
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
    navigator: { userAgent: "web-enrich-test" },
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

test("web assets: w4 enrich markers — the op, its fields, the panel", () => {
  const js = readFileSync(join(root, "src/web/app.js"), "utf8");
  const css = readFileSync(join(root, "src/web/app.css"), "utf8");
  for (const marker of [
    "receipt.enrich",         // the op this surface asks for
    "receipt.enrich.result",  // its reply
    "contextTokens",          // context size, straight from the transcript
    "usageTotal",             // usage roll-up shape
    "lastTs",                 // last activity
    "enrichRows",             // the pure formatter behind the panel
    "receipt-detail",         // the expansion element
    "đang tải chi tiết phiên", // loading line (a spinner of words)
  ]) {
    assert.ok(js.includes(marker), `app.js must contain ${marker}`);
  }
  assert.ok(css.includes(".receipt-detail"), "app.css must style .receipt-detail");
  assert.ok(css.includes("grid-template-columns: max-content 1fr"), "the panel is a two-column grid: label left, value right");
});

test("w4 units: enrichRows formats transcript facts — grouped tokens, local hour, $ usage", () => {
  const api = loadApp();
  const ts = Date.now() - 42_000;
  // JSON round-trip: values born in the VM realm must compare by value here.
  const rows = JSON.parse(JSON.stringify(api.enrichRows({
    model: "grok-code",
    contextTokens: 81234,
    turns: 12,
    usageTotal: { totalTokens: 123456, costUsd: 0.0123 },
    lastTs: ts,
  })));
  assert.equal(rows.model, "grok-code");
  assert.equal(rows.context, "81,234 tokens", "tokens group by thousands — no invented % bar");
  assert.equal(rows.contextPct, null, "no known window cap → no bar, ever a guess");
  assert.equal(rows.turns, "12");
  assert.equal(rows.usage, "123,456 tokens · $0.0123");
  const at = new Date(ts);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  assert.equal(rows.last, hhmm, "lastTs renders as the device's local hour");

  // Sparse answers hide their missing rows instead of printing nulls.
  const bare = JSON.parse(JSON.stringify(api.enrichRows({ turns: 1 })));
  assert.equal(bare.model, null);
  assert.equal(bare.context, null);
  assert.equal(bare.usage, null);
  assert.equal(bare.last, null);
  assert.equal(bare.turns, "1");
  const nothing = JSON.parse(JSON.stringify(api.enrichRows(null)));
  assert.deepEqual(nothing, { model: null, context: null, contextPct: null, turns: null, usage: null, last: null });
});

test("w4 units: contextPctOf — a bar only against a real cap, capped at 100", () => {
  const api = loadApp();
  assert.equal(api.contextPctOf(65_536, 131_072), 50, "half the window is 50%");
  assert.equal(api.contextPctOf(200_000, 131_072), 100, "over the cap the bar tops out");
  assert.equal(api.contextPctOf(0, 131_072), 0);
  assert.equal(api.contextPctOf(-5, 131_072), null, "negative tokens are not a bar");
  // Without a known cap there is no bar — the threshold is never invented.
  assert.equal(api.contextPctOf(81_234), null);
  assert.equal(api.contextPctOf(81_234, null), null);
  assert.equal(api.contextPctOf(81_234, 0), null);
});

test("w4 units: the enrich fence — open sends receipt.enrich, the reply becomes the panel", async () => {
  const api = loadApp();
  api.online();
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  api.enrichToggle(id);
  assert.deepEqual(JSON.parse(JSON.stringify(api.fetchInfo().inflight.map((f) => f.key))), [`enrich:${id}`]);
  const snap = api.enrichSnap();
  assert.equal(snap!.id, id);
  assert.equal(snap!.loading, true, "the panel shows its loading line while flying");

  assert.equal(
    api.fetchReply({ op: "receipt.enrich.result", id, model: "qwen3", contextTokens: 1000, turns: 2, usageTotal: { totalTokens: 3000, costUsd: 0.0042 }, lastTs: 1_700_000_000_000 }),
    true,
    "the fence consumes the reply",
  );
  await delay(0);
  const done = api.enrichSnap();
  assert.equal(done!.loading, false);
  assert.equal(done!.error, null);
  assert.equal((done!.result as { model?: string }).model, "qwen3");
  const panel = api.probe.detail(id);
  assert.equal(panel.className, "receipt-detail");
  assert.ok(panel.find((n) => n.textContent === "model"), "a label per fact");
  assert.ok(panel.find((n) => n.textContent === "qwen3"), "the model, verbatim");
  assert.ok(panel.find((n) => n.textContent === "1,000 tokens"), "context tokens, grouped");
  assert.ok(panel.find((n) => n.textContent === "3,000 tokens · $0.0042"), "usage tokens and $");
  assert.equal(panel.find((n) => String(n.className).includes("ctxbar")), undefined, "no cap known → no bar element");

  // Toggle closes; a closed panel renders nothing but its shell.
  api.enrichToggle(id);
  assert.equal(api.enrichSnap(), null);
  assert.deepEqual(api.probe.detail(id).children, []);
});

test("w4 units: a refusal shows the server's words; a transport fault keeps the shared banner", async () => {
  const api = loadApp();
  api.online();
  const id = "11111111-2222-4333-8444-555555555555";
  api.enrichToggle(id);
  await delay(0);
  // The server's refusal — verbatim, never swallowed into a generic shrug.
  assert.equal(api.fetchReply({ op: "error", code: "receipt.enrich", message: `no readable transcript for session ${id}` }), true);
  await delay(0);
  const refused = api.enrichSnap();
  assert.equal(refused!.loading, false);
  assert.equal(refused!.error, `no readable transcript for session ${id}`);
  const panel = api.probe.detail(id);
  assert.match(panel.find((n) => String(n.className).includes("error"))!.textContent, /no readable transcript/, "the host's words stay visible");

  // The disabled host answers receipt.enrich.result with a reason — shown, not hidden.
  api.enrichToggle(id); // close the refused panel before asking again
  api.enrichToggle(id);
  assert.equal(api.fetchReply({ op: "receipt.enrich.result", id: null, reason: "pi_receipts_disabled" }), true);
  await delay(0);
  assert.match(String(api.enrichSnap()!.error), /pi_receipts_disabled/);

  // Transport loss: the shared pwa3 banner text, snapshot discipline intact.
  api.enrichToggle(id); // close, then ask while the wire is gone
  api.offline();
  api.enrichToggle(id);
  await delay(0);
  const offline = api.enrichSnap();
  assert.equal(offline!.loading, false);
  assert.match(offline!.error!, /giữ dữ liệu gần nhất/, "the transport fault banner names its verdict");
});

test("w4 units: one detail open at a time — opening another closes the first", async () => {
  const api = loadApp();
  api.online();
  const a = "aaaaaaaa-0000-4000-8000-000000000001";
  const b = "aaaaaaaa-0000-4000-8000-000000000002";
  api.enrichToggle(a);
  api.enrichToggle(b);
  await delay(0);
  const snap = api.enrichSnap();
  assert.equal(snap!.id, b, "the last tapped receipt owns the detail");
  assert.equal(api.fetchReply({ op: "receipt.enrich.result", id: a, turns: 1, usageTotal: { totalTokens: 1, costUsd: 0 } }), true);
  await delay(0);
  assert.equal(api.enrichSnap()!.id, b, "a late reply for the closed row never steals the panel");
});
