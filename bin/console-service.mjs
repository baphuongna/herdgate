import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { derivePaneDimensions } from "./console-rpc.mjs";

const API = "/api/console/v1";
const MAX_API_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const CODE_TTL_MS = 120_000;
const CODE_ATTEMPTS = 5;
const CODE_ISSUES_PER_MINUTE = 5;
const IDLE_TTL_MS = 30 * 60_000;
const ABSOLUTE_TTL_MS = 8 * 60 * 60_000;
const ALLOWED_MIME = new Set([
  "text/html; charset=utf-8", "text/css; charset=utf-8", "text/javascript; charset=utf-8",
  "application/javascript; charset=utf-8", "application/json; charset=utf-8", "image/svg+xml",
  "image/png", "image/jpeg", "image/webp", "image/gif", "font/woff2", "font/woff",
  "text/plain; charset=utf-8", "text/markdown; charset=utf-8",
]);
// xterm 6's DOM renderer creates inline styles/style elements for ANSI colors and emphasis.
// Allow inline CSS so the mirror retains terminal color, bold, and underline rendering.
// Keep inline execution forbidden: scripts still load only from this same-origin manifest.
export const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; child-src 'none'; frame-src 'none'; manifest-src 'none'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

class HttpFault extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const hash = (value) => createHash("sha256").update(value, "utf8").digest();
function secureEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : hash(String(a));
  const right = Buffer.isBuffer(b) ? b : hash(String(b));
  return timingSafeEqual(left, right);
}

function loadAssets(assetsDir) {
  try {
    const root = realpathSync(assetsDir);
    const manifestPath = resolve(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest?.version !== 1 || manifest.index !== "index.html" || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
      throw new Error("invalid manifest");
    }
    const files = new Map();
    for (const [urlPath, entry] of Object.entries(manifest.files)) {
      if (typeof urlPath !== "string" || !urlPath || urlPath.startsWith("/") || urlPath.includes("\\") || urlPath.split("/").some((p) => !p || p === "." || p === "..")) {
        throw new Error("unsafe manifest key");
      }
      if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !ALLOWED_MIME.has(entry.type)) throw new Error("invalid manifest entry");
      if (entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("unsafe asset path");
      const target = resolve(root, entry.path);
      const rel = relative(root, target);
      if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("asset escapes manifest root");
      const actual = realpathSync(target);
      const actualRel = relative(root, actual);
      if (actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel) || !statSync(actual).isFile()) throw new Error("asset is not a regular file in manifest root");
      files.set(urlPath, { path: actual, type: entry.type });
    }
    if (!files.has("index.html")) throw new Error("manifest index missing");
    return { root, files };
  } catch (error) {
    const fault = new Error("console_assets_missing: Console asset manifest is missing or invalid");
    fault.code = "console_assets_missing";
    fault.cause = error;
    throw fault;
  }
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", CONSOLE_CSP);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
}
function sendJson(res, status, value) {
  let body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_API_BYTES) {
    status = 502;
    body = Buffer.from(JSON.stringify({ error: { code: "response_too_large", message: "Console response exceeds the 256 KiB limit" } }));
  }
  setSecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", body.byteLength);
  res.end(body);
}
function sendFault(res, fault) {
  const status = Number.isInteger(fault?.status) ? fault.status : 500;
  sendJson(res, status, { error: { code: typeof fault?.code === "string" ? fault.code : "internal_error", message: fault?.message || "Console request failed" } });
}
function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      req.resume();
      return reject(new HttpFault(415, "unsupported_media_type", "Expected application/json"));
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
      req.resume();
      return reject(new HttpFault(413, "request_too_large", "Request body exceeds the limit"));
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        req.removeAllListeners("data");
        req.resume();
        reject(new HttpFault(413, "request_too_large", "Request body exceeds the limit"));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_REQUEST_BYTES) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
        resolveBody(value);
      } catch { reject(new HttpFault(400, "invalid_json", "Request body must be a JSON object")); }
    });
    req.on("error", () => reject(new HttpFault(400, "invalid_request", "Request body could not be read")));
  });
}

export function validateConsoleAssets(assetsDir) { return loadAssets(assetsDir); }

export function createConsoleService({ rpc = null, assetsDir, now = Date.now, log = () => {}, instanceId = randomUUID() }) {
  if (typeof now !== "function" || typeof log !== "function") throw new TypeError("invalid service hooks");
  const assets = loadAssets(assetsDir);
  if (rpc !== null && (typeof rpc?.snapshot !== "function" || typeof rpc?.readPane !== "function")) throw new TypeError("RPC adapter must expose only snapshot and readPane");
  const issuedAt = [];
  const sessions = new Map();
  let loginCode = null;
  let loginAttempts = 0;
  let server;
  let origin = null;
  let runtimeAvailable = false;
  let runtimeGeneration = randomUUID();
  let currentSnapshot = null;
  const sequences = new Map();

  function invalidateRuntime() {
    currentSnapshot = null;
    runtimeAvailable = false;
    runtimeGeneration = randomUUID();
    sequences.clear();
  }
  function issueLoginCode() {
    const time = now();
    while (issuedAt.length && issuedAt[0] <= time - 60_000) issuedAt.shift();
    if (issuedAt.length >= CODE_ISSUES_PER_MINUTE) throw new HttpFault(429, "login_rate_limited", "Too many local login codes requested");
    issuedAt.push(time);
    const code = randomBytes(32).toString("hex");
    loginCode = { digest: hash(code), expiresAt: time + CODE_TTL_MS };
    loginAttempts = 0;
    return code;
  }
  function authenticate(req) {
    const header = req.headers.authorization;
    const match = typeof header === "string" && /^Bearer ([0-9a-f]{64})$/.exec(header);
    if (!match) throw new HttpFault(401, "unauthorized", "Local login required");
    const digest = hash(match[1]);
    const key = digest.toString("hex");
    const session = sessions.get(key);
    const time = now();
    if (!session || !secureEqual(digest, session.digest) || time - session.lastSeen >= IDLE_TTL_MS || time - session.createdAt >= ABSOLUTE_TTL_MS) {
      sessions.delete(key);
      throw new HttpFault(401, "unauthorized", "Local login expired");
    }
    session.lastSeen = time;
    return key;
  }
  function sameOrigin(req) {
    if (req.headers.origin !== origin) throw new HttpFault(403, "origin_denied", "Request origin is not this Console");
  }
  async function refreshSnapshot() {
    if (!rpc || typeof rpc.snapshot !== "function") throw new HttpFault(503, "runtime_unavailable", "Herdr runtime is unavailable");
    let snapshot;
    try { snapshot = await rpc.snapshot(); }
    catch (error) {
      invalidateRuntime();
      if (error?.code === "permission_denied") throw new HttpFault(403, "runtime_permission_denied", "Herdr denied read access");
      if (error?.code === "frame_too_large") throw new HttpFault(502, "snapshot_too_large", "Herdr snapshot exceeds the RPC frame limit");
      throw new HttpFault(503, "runtime_unavailable", "Herdr runtime is unavailable");
    }
    if (!snapshot || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs) || !Array.isArray(snapshot.panes)) {
      invalidateRuntime();
      throw new HttpFault(503, "runtime_unavailable", "Herdr returned an invalid snapshot");
    }
    if (!runtimeAvailable) runtimeGeneration = randomUUID();
    runtimeAvailable = true;
    currentSnapshot = snapshot;
    return snapshot;
  }

  async function route(req, res) {
    setSecurityHeaders(res);
    if (Object.keys(req.headers).some((name) => name.startsWith("x-forwarded-") || name === "forwarded" || name === "x-original-host" || name === "x-original-url")) {
      throw new HttpFault(403, "host_denied", "Forwarded host headers are not accepted");
    }
    const expectedHost = new URL(origin).host;
    if (req.headers.host !== expectedHost) throw new HttpFault(403, "host_denied", "Host is not this Console");
    const url = new URL(req.url ?? "/", origin);
    if (url.origin !== origin) throw new HttpFault(403, "host_denied", "Request authority is not this Console");

    if (url.pathname === "/_console/health" && req.method === "GET") {
      return sendJson(res, 200, { status: "ready", instanceId, runtime: runtimeAvailable ? "online" : "unavailable", transport: rpc ? "rpc" : "unavailable" });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const entry = assets.files.get("index.html");
      const body = readFileSync(entry.path);
      res.statusCode = 200;
      res.setHeader("Content-Type", entry.type);
      res.setHeader("Content-Length", body.byteLength);
      res.setHeader("Cache-Control", "no-store");
      return res.end(body);
    }
    if (req.method === "GET") {
      let path;
      try { path = decodeURIComponent(url.pathname.replace(/^\//, "")); }
      catch { throw new HttpFault(404, "not_found", "Asset not found"); }
      const entry = assets.files.get(path);
      if (entry && path !== "manifest.json") {
        const body = readFileSync(entry.path);
        res.statusCode = 200;
        res.setHeader("Content-Type", entry.type);
        res.setHeader("Content-Length", body.byteLength);
        if (/(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(body);
      }
    }

    if (url.pathname === `${API}/auth/redeem` && req.method === "POST") {
      sameOrigin(req);
      const body = await readJson(req);
      const time = now();
      const code = typeof body.code === "string" && /^[0-9a-f]{64}$/.test(body.code) ? body.code : "";
      if (!loginCode || time >= loginCode.expiresAt) {
        if (loginCode && time >= loginCode.expiresAt) loginCode = null;
        throw new HttpFault(401, "invalid_code", "Local login code is invalid or expired");
      }
      if (!code || !secureEqual(hash(code), loginCode.digest)) {
        loginAttempts++;
        if (loginAttempts >= CODE_ATTEMPTS) loginCode = null;
        throw new HttpFault(401, "invalid_code", "Local login code is invalid or expired");
      }
      loginCode = null;
      loginAttempts = 0;
      const token = randomBytes(32).toString("hex");
      const digest = hash(token);
      const key = digest.toString("hex");
      sessions.set(key, { digest, createdAt: time, lastSeen: time });
      while (sessions.size > 32) sessions.delete(sessions.keys().next().value);
      return sendJson(res, 200, { token, expiresInMs: IDLE_TTL_MS, maxAgeMs: ABSOLUTE_TTL_MS });
    }

    if (url.pathname === `${API}/auth/logout` && req.method === "POST") {
      sameOrigin(req);
      const key = authenticate(req);
      sessions.delete(key);
      loginCode = null;
      res.statusCode = 204;
      return res.end();
    }

    if (url.pathname.startsWith(`${API}/`)) {
      authenticate(req);
      if (req.method !== "GET") throw new HttpFault(404, "not_found", "Console route not found");
      if (url.pathname === `${API}/capabilities`) {
        return sendJson(res, 200, { mode: "mirror", scope: "read", transport: rpc ? "rpc" : "unavailable", features: { session: true, paneScreen: true, act: false, attach: false, chat: false, inbox: false, fileViewer: false } });
      }
      if (url.pathname === `${API}/session`) {
        const snapshot = await refreshSnapshot();
        return sendJson(res, 200, { runtimeGeneration, snapshot });
      }
      const screen = new RegExp(`^${API}/pane/([^/]+)/screen$`).exec(url.pathname);
      if (screen) {
        let paneId;
        try { paneId = decodeURIComponent(screen[1]); }
        catch { throw new HttpFault(404, "pane_gone", "Pane is not in the current snapshot"); }
        const expectedGeneration = req.headers["x-herdgate-runtime-generation"];
        if (typeof expectedGeneration !== "string" || expectedGeneration !== runtimeGeneration) throw new HttpFault(409, "generation_mismatch", "Runtime generation changed; refresh the session");
        if (!runtimeAvailable || !currentSnapshot) throw new HttpFault(503, "runtime_unavailable", "Herdr runtime is unavailable");
        if (!currentSnapshot.panes.some((pane) => pane?.pane_id === paneId)) throw new HttpFault(404, "pane_gone", "Pane is not in the current snapshot");
        const generation = runtimeGeneration;
        let read;
        try { read = await rpc.readPane(paneId); }
        catch (error) {
          if (error?.code === "pane_not_found") {
            currentSnapshot = null;
            sequences.delete(paneId);
            throw new HttpFault(404, "pane_gone", "Pane is no longer available");
          }
          invalidateRuntime();
          if (error?.code === "permission_denied") throw new HttpFault(403, "runtime_permission_denied", "Herdr denied read access");
          if (error?.code === "frame_too_large") throw new HttpFault(502, "screen_too_large", "Herdr pane frame exceeds the RPC frame limit");
          throw new HttpFault(503, "runtime_unavailable", "Herdr pane read failed");
        }
        if (!runtimeAvailable || runtimeGeneration !== generation || expectedGeneration !== runtimeGeneration) throw new HttpFault(409, "generation_mismatch", "Runtime generation changed during pane read");
        const currentPane = currentSnapshot?.panes.find((pane) => pane?.pane_id === paneId);
        if (!currentPane) {
          sequences.delete(paneId);
          throw new HttpFault(404, "pane_gone", "Pane is no longer in the current snapshot");
        }
        if (!read || read.pane_id !== paneId || typeof read.text !== "string" || typeof read.truncated !== "boolean") throw new HttpFault(502, "invalid_pane_read", "Herdr returned an invalid pane frame");
        const { cols, rows: rowsCount } = derivePaneDimensions(currentSnapshot, paneId, read);
        const capturedAt = new Date(now()).toISOString();
        let ansi = read.text;
        let truncated = read.truncated;
        const endsWithNewline = ansi.endsWith("\n");
        let rows = ansi.split("\n");
        if (endsWithNewline) rows.pop();
        const responseFor = (text, wasTruncated) => ({ runtimeGeneration: generation, sequence: (sequences.get(paneId) ?? 0) + 1, paneId, cols, rows: rowsCount, ansi: text, capturedAt, truncated: wasTruncated });
        let payload = responseFor(ansi, truncated);
        while (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_API_BYTES && rows.length > 1) {
          rows.shift();
          ansi = rows.join("\n") + (endsWithNewline ? "\n" : "");
          truncated = true;
          payload = responseFor(ansi, truncated);
        }
        if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_API_BYTES) throw new HttpFault(502, "screen_too_large", "A complete terminal row exceeds the mirror size limit");
        sequences.set(paneId, payload.sequence);
        return sendJson(res, 200, payload);
      }
    }
    throw new HttpFault(404, "not_found", "Console route not found");
  }

  function handler(req, res) {
    Promise.resolve().then(() => route(req, res)).catch((error) => {
      const fault = error instanceof HttpFault ? error : new HttpFault(500, "internal_error", "Console request failed");
      if (fault.status >= 500) {
        try { log(`console request failed: ${fault.code}`); } catch { /* logging must not affect fail-closed behavior */ }
      }
      if (!res.headersSent) sendFault(res, fault);
      else res.destroy();
    });
  }

  return {
    get origin() { return origin; },
    get runtimeGeneration() { return runtimeGeneration; },
    get runtimeAvailable() { return runtimeAvailable; },
    issueLoginCode,
    invalidateRuntime,
    async probeRuntime() {
      try { await refreshSnapshot(); return "online"; }
      catch { return "unavailable"; }
    },
    async start({ host = "127.0.0.1", port = 0 } = {}) {
      if (server) return server.address();
      if (host !== "127.0.0.1") throw new Error("Console only binds to 127.0.0.1");
      server = createServer(handler);
      server.headersTimeout = 5_000;
      server.requestTimeout = 10_000;
      server.keepAliveTimeout = 5_000;
      await new Promise((resolveStart, rejectStart) => {
        server.once("error", rejectStart);
        server.listen(port, host, () => { server.removeListener("error", rejectStart); resolveStart(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Console listener did not receive a TCP address");
      origin = `http://127.0.0.1:${address.port}`;
      return address;
    },
    async stop() {
      loginCode = null;
      sessions.clear();
      invalidateRuntime();
      if (!server) return;
      const current = server;
      server = undefined;
      await new Promise((resolveStop) => current.close(() => resolveStop()));
    },
  };
}
