// F1 spike runner: load the unmodified Ovis app with the Herdgate transport in a real browser and report.
// usage: node run-f1.mjs <origin> <outDir> [waitMs]
import { writeFileSync, mkdirSync } from "node:fs";
const [origin, outDir, waitArg] = process.argv.slice(2);
const waitMs = Number(waitArg ?? 14000);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ver = await (await fetch("http://127.0.0.1:9338/json/version")).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });
let seq = 0; const pending = new Map();
bws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const bsend = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, res); bws.send(JSON.stringify({ id: i, method, params })); });
const { result: created } = await bsend("Target.createTarget", { url: "about:blank" });
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) { wsUrl = ((await (await fetch("http://127.0.0.1:9338/json/list")).json()).find((x) => x.id === created.targetId) ?? {}).webSocketDebuggerUrl ?? null; if (!wsUrl) await sleep(150); }
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let n = 0; const pend = new Map(); const problems = []; const netFail = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  const p = m.params ?? {};
  if (m.method === "Runtime.exceptionThrown") problems.push("exception: " + String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 300));
  if (m.method === "Runtime.consoleAPICalled" && (p.type === "error")) problems.push("console.error: " + (p.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 300));
  if (m.method === "Log.entryAdded" && p.entry?.level === "error") netFail.push(String(p.entry.text).slice(0, 120) + " " + String(p.entry.url ?? "").slice(-70));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++n; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (m.result?.exceptionDetails) return { error: String(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text).slice(0, 300) }; return m.result?.result?.value; };
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
await send("Page.navigate", { url: `${origin}/` });
await sleep(waitMs);
const out = {};
out.elapsedMs = Date.now() - t0;
out.state = await evaluate(`({ title: document.title, visibility: document.visibilityState, viewOnly: /View only/.test(document.body.innerText), header: (document.querySelector(".app-header")?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 160) })`);
out.sidebar = await evaluate(`[...document.querySelectorAll(".sidebar [class*=\\"workspace\\"], .sidebar [role=treeitem], .sidebar .row, .sidebar button")].map((e) => e.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 40)`);
out.tabs = await evaluate(`[...document.querySelectorAll(".tab-strip [role=tab]")].map((e) => e.innerText.replace(/\\s+/g, " ").trim())`);
out.panes = await evaluate(`({ frames: document.querySelectorAll(".pane-frame").length, terminals: document.querySelectorAll(".xterm").length, xtermRows: document.querySelectorAll(".xterm-rows > div").length, textChars: [...document.querySelectorAll(".xterm-rows > div")].reduce((s, d) => s + d.textContent.length, 0), sample: [...document.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent).filter((t) => t.trim()).slice(0, 4), placeholder: document.querySelector(".terminal-placeholder-inner")?.innerText ?? null, notices: [...document.querySelectorAll(".notice, [role=alert]")].map((e) => e.innerText.slice(0, 80)).slice(0, 6) })`);
out.log = await evaluate(`(window.__hgLog ?? []).map((r) => r.k === "fetch" ? [r.t, "fetch", r.method, r.path + (r.query || ""), r.status, r.ms] : r.k === "ws" ? [r.t, "ws", r.path, "sent:" + r.sent.map((f) => f.type).join(","), "recv:" + r.received.map((f) => f.type).join(","), "open@" + r.open] : r.k === "sse" ? [r.t, "sse", r.path, "msgs:" + r.messages] : [r.t, r.k, r.path])`);
out.source = await (await fetch(`${origin.replace(/:\\d+/, ":41291")}/hg/stats`).catch(() => ({ json: async () => null }))).json();
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) writeFileSync(`${outDir}/f1.png`, Buffer.from(shot.result.data, "base64"));
// switch to the Terminal lens with a trusted click, then read what Ovis's own terminal rendered
const lens = await evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((e) => e.innerText.trim() === "Terminal"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
out.terminalLens = { button: lens };
if (lens) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: lens.x, y: lens.y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: lens.x, y: lens.y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: lens.x, y: lens.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(4500);
  out.terminalLens.header = await evaluate(`(document.querySelector(".app-header")?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 160)`);
  out.terminalLens.rows = await evaluate(`[...document.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent)`);
  out.terminalLens.stats = await evaluate(`({ rows: document.querySelectorAll(".xterm-rows > div").length, nonEmpty: [...document.querySelectorAll(".xterm-rows > div")].filter((d) => d.textContent.trim()).length, chars: [...document.querySelectorAll(".xterm-rows > div")].reduce((s, d) => s + d.textContent.length, 0), spans: document.querySelectorAll(".xterm-rows span").length })`);
  out.terminalLens.rows = out.terminalLens.rows.filter((t) => t.trim()).slice(0, 6).map((t) => t.slice(0, 150));
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  if (shot2.result?.data) writeFileSync(`${outDir}/f1-terminal.png`, Buffer.from(shot2.result.data, "base64"));
}
out.problems = [...new Set(problems)].slice(0, 14); out.netFail = [...new Set(netFail)].slice(0, 8);
writeFileSync(`${outDir}/f1.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).split("\n").map((l) => l.length > 240 ? l.slice(0, 240) + "…" : l).join("\n"));
ws.close(); await bsend("Target.closeTarget", { targetId: created.targetId }); bws.close();
