// F1 spike data source (throwaway, loopback only, no auth): serves the built Ovis app and
// two Herdr-backed reads: /hg/session (session.snapshot) and /hg/pane/:id (pane.read, ANSI).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { hostname, homedir } from "node:os";
import { createConsoleRpc, createUnixConnector, derivePaneDimensions } from "./console-rpc.mjs";

const ROOT = process.argv[2];
const PORT = Number(process.argv[3] ?? 41291);
const SOCKET = process.env.HERDR_SOCKET ?? join(homedir(), ".config/herdr/herdr.sock");
const rpc = createConsoleRpc({ connect: createUnixConnector(SOCKET) });
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8", "" : "application/octet-stream" };
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
let generation = crypto.randomUUID();
let stats = { session: 0, pane: 0, errors: 0 };

async function file(path, res) {
  const target = normalize(join(ROOT, path));
  if (!target.startsWith(normalize(ROOT) + sep) && target !== normalize(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? MIME[""], "cache-control": "no-cache" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/hg/session") {
      stats.session += 1;
      const snapshot = await rpc.snapshot();
      return json(res, 200, { host: hostname(), runtimeGeneration: generation, snapshot });
    }
    const pane = /^\/hg\/pane\/([^/]+)$/.exec(url.pathname);
    if (pane) {
      stats.pane += 1;
      const paneId = decodeURIComponent(pane[1]);
      const expected = req.headers["x-herdgate-runtime-generation"];
      let snapshot;
      try { snapshot = await rpc.snapshot(); } catch { generation = crypto.randomUUID(); return json(res, 503, { error: { code: "runtime_unavailable", message: "Herdr runtime is unavailable" } }); }
      if (typeof expected !== "string" || expected !== generation) return json(res, 409, { error: { code: "generation_mismatch", message: "Runtime generation changed; refresh the session" } });
      if (!snapshot.panes.some((p) => p?.pane_id === paneId)) return json(res, 404, { error: { code: "pane_gone", message: "Pane is not in the current snapshot" } });
      let read;
      try { read = await rpc.readPane(paneId); } catch (error) { stats.errors += 1; return json(res, 503, { error: { code: "pane_read_failed", message: String(error?.message ?? error) } }); }
      const { cols, rows } = derivePaneDimensions(snapshot, paneId, read);
      return json(res, 200, { pane_id: paneId, text: read.text, truncated: read.truncated, cols, rows, runtimeGeneration: generation });
    }
    if (url.pathname === "/hg/stats") return json(res, 200, stats);
    if (url.pathname === "/") return file("herdgate.html", res);
    return file(url.pathname.slice(1), res);
  } catch (error) {
    stats.errors += 1;
    json(res, 500, { error: { code: "source_failed", message: String(error?.message ?? error) } });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`herdgate source on http://127.0.0.1:${PORT}/ (socket ${SOCKET})`));
