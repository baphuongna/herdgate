// F0 spike: measure the boot contract of the unmodified Ovis app (REST + WS + SSE), in order.
// usage: node boot-contract.mjs <origin> <outDir>
import { writeFileSync, mkdirSync } from "node:fs";
const [origin, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ver = await (await fetch("http://127.0.0.1:9338/json/version")).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });
let seq = 0; const pending = new Map();
bws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const bsend = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, res); bws.send(JSON.stringify({ id: i, method, params })); });

async function page(targetId) {
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) { wsUrl = ((await (await fetch("http://127.0.0.1:9338/json/list")).json()).find((x) => x.id === targetId) ?? {}).webSocketDebuggerUrl ?? null; if (!wsUrl) await sleep(150); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let n = 0; const pend = new Map(); const problems = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    const p = m.params ?? {};
    if (m.method === "Runtime.exceptionThrown") problems.push("exception: " + String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 220));
    if (m.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) problems.push(p.type + ": " + (p.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 220));
    if (m.method === "Log.entryAdded" && p.entry?.level === "error") problems.push("log: " + String(p.entry.text).slice(0, 160) + " " + String(p.entry.url ?? "").slice(-60));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++n; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => { const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return m.result?.result?.value; };
  return { send, evaluate, problems, close: () => ws.close() };
}

async function phase(name, path, waitMs) {
  const { result: created } = await bsend("Target.createTarget", { url: "about:blank" });
  const p = await page(created.targetId);
  await p.send("Page.enable"); await p.send("Runtime.enable"); await p.send("Log.enable");
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.send("Page.navigate", { url: `${origin}${path}` });
  await sleep(waitMs);
  const log = (await p.evaluate(`window.__hgLog ?? null`)) ?? [];
  const state = await p.evaluate(`({ title: document.title, body: (document.body?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 260), rootChildren: document.getElementById("root")?.childElementCount ?? null })`);
  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) writeFileSync(`${outDir}/${name}.png`, Buffer.from(shot.result.data, "base64"));
  writeFileSync(`${outDir}/${name}.log.json`, JSON.stringify(log, null, 1));
  p.close(); await bsend("Target.closeTarget", { targetId: created.targetId });

  // ---- summary (ordered by first occurrence) ----
  const rest = new Map();
  for (const r of log.filter((x) => x.k === "fetch")) {
    const key = `${r.method} ${r.path}`;
    if (!rest.has(key)) rest.set(key, { first: r.t, count: 0, statuses: new Set(), ms: [], resBytes: [], req: r.req ?? null, res: r.res ?? null });
    const e = rest.get(key); e.count += 1; e.statuses.add(r.status); if (r.ms !== null) e.ms.push(r.ms); if (r.resBytes) e.resBytes.push(r.resBytes);
  }
  const restRows = [...rest.entries()].sort((a, b) => a[1].first - b[1].first).map(([key, e]) => ({ first: e.first, key, count: e.count, status: [...e.statuses].join("/"), ms: e.ms.length ? Math.round(e.ms.reduce((s, v) => s + v, 0) / e.ms.length) : null, resBytes: e.resBytes.length ? Math.round(e.resBytes.reduce((s, v) => s + v, 0) / e.resBytes.length) : null }));
  const sockets = log.filter((x) => x.k === "ws").map((s) => ({ first: s.t, path: s.path, open: s.open, close: s.close, sentCount: s.sent.length, sentFirst: s.sent.slice(0, 12).map((f) => `${f.t}ms ${f.type ?? f.op ?? "?"} ${f.head ?? ""}`), receivedCount: s.received.length, receivedTypes: Object.entries(s.received.reduce((acc, f) => { const k = String(f.type ?? f.op ?? "?"); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}:${v}`), receivedFirst: s.received.slice(0, 12).map((f) => `${f.t}ms ${f.type ?? f.op ?? "?"} ${f.head ?? ""}`) }));
  const sse = log.filter((x) => x.k === "sse").map((s) => ({ first: s.t, path: s.path, open: s.open, error: s.error, messages: s.messages, first: s.first }));
  const other = log.filter((x) => x.k !== "fetch" && x.k !== "ws" && x.k !== "sse");
  return { name, state, problems: p.problems.slice(0, 12), rest: restRows, sockets, sse, other, totalRecords: log.length };
}

const a = await phase("A-demo-healthy", "/index.html", 25000);
const b = await phase("B-fail-503", "/fail.html", 12000);
writeFileSync(`${outDir}/contract.json`, JSON.stringify({ A: a, B: b }, null, 1));
const show = (x) => console.log(JSON.stringify(x, null, 1).split("\n").map((l) => l.length > 230 ? l.slice(0, 230) + "…" : l).join("\n"));
show({ A: { state: a.state, totalRecords: a.totalRecords, problems: a.problems }, B: { state: b.state, totalRecords: b.totalRecords, problems: b.problems } });
bws.close();
