// F0 spike recorder (classic script, loaded after the transport and before the app).
// Records every fetch / WebSocket / EventSource the Ovis app uses, in order, with timing.
(() => {
  const log = [];
  window.__hgLog = log;
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = (url) => { log.push({ t: 0, k: "sw-register", path: String(url) }); return new Promise(() => {}); };
  }
  const t0 = performance.now();
  const stamp = () => Math.round(performance.now() - t0);
  const mode = window.__hgMode || "record"; // "record" passes through; "fail" answers 503 for /api/*
  const head = (value) => { try { return String(value).slice(0, 140); } catch { return null; } };
  const frame = (data) => {
    const text = typeof data === "string" ? data : "[binary]";
    try { const j = JSON.parse(text); return { type: j?.type ?? j?.kind ?? null, op: j?.op ?? null, len: text.length, head: head(text) }; } catch { return { type: null, len: text.length, head: head(text) }; }
  };
  const of = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = String((init && init.method) || (typeof input === "object" && !(input instanceof URL) ? input.method : "") || "GET").toUpperCase();
    const path = new URL(url, location.origin).pathname;
    const rec = { t: stamp(), k: "fetch", method, path, query: new URL(url, location.origin).search.slice(0, 80), status: null, ms: null };
    if (init && init.body) rec.req = head(init.body);
    log.push(rec);
    if (mode === "fail" && path.startsWith("/api")) {
      rec.status = 503; rec.ms = 0; rec.hg = "fail-mode";
      return new Response(JSON.stringify({ error: "hg_f0_unimplemented" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const start = performance.now();
    try {
      const res = await of(input, init);
      rec.status = res.status; rec.ms = Math.round(performance.now() - start);
      if (res.ok && /json/.test(res.headers.get("content-type") || "")) { try { res.clone().text().then((text) => { rec.resBytes = text.length; rec.res = head(text); }); } catch { /* ignore */ } }
      return res;
    } catch (error) { rec.error = head(error); rec.ms = Math.round(performance.now() - start); throw error; }
  };
  const OW = window.WebSocket;
  const HGWebSocket = function (url, protocols) {
    const ws = arguments.length > 1 ? new OW(url, protocols) : new OW(url);
    const rec = { t: stamp(), k: "ws", path: new URL(String(url), location.origin).pathname, sent: [], received: [], open: null, close: null };
    log.push(rec);
    const send = ws.send.bind(ws);
    ws.send = (data) => { const f = frame(data); rec.sent.push({ t: stamp(), ...f }); return send(data); };
    ws.addEventListener("open", () => { rec.open = stamp(); });
    ws.addEventListener("message", (event) => { const f = frame(event.data); if (rec.received.length < 400) rec.received.push({ t: stamp(), ...f }); });
    ws.addEventListener("close", (event) => { rec.close = { t: stamp(), code: event.code }; });
    ws.addEventListener("error", () => { rec.error = stamp(); });
    return ws;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(HGWebSocket, name, { value: OW[name] });
  HGWebSocket.prototype = OW.prototype;
  window.WebSocket = HGWebSocket;
  const OE = window.EventSource;
  const HGEventSource = function (url, init) {
    const es = init === undefined ? new OE(url) : new OE(url, init);
    const rec = { t: stamp(), k: "sse", path: new URL(String(url), location.origin).pathname, messages: 0, open: null, error: null, first: null };
    log.push(rec);
    es.addEventListener("open", () => { rec.open = stamp(); });
    es.addEventListener("error", () => { rec.error = stamp(); });
    es.addEventListener("message", (event) => { rec.messages += 1; if (rec.first === null) rec.first = head(event.data); });
    return es;
  };
  HGEventSource.CONNECTING = OE.CONNECTING; HGEventSource.OPEN = OE.OPEN; HGEventSource.CLOSED = OE.CLOSED; HGEventSource.prototype = OE.prototype;
  window.EventSource = HGEventSource;
})();
