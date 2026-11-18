/**
 * A small static file server for the PWA, deliberately boring:
 *
 *   - only files under one root, resolved through `realpath` (no traversal, no symlink escape);
 *   - no directory listings, no dotfiles;
 *   - a fixed content-type table, `no-store` for the app shell and long cache for hashed assets;
 *   - a strict CSP: the PWA is same-origin and needs no inline script at all.
 *
 * The PWA lives at `src/web/` in this repo and is served by the same process that runs the
 * gateway, so a device that opens the public hostname gets the app and the WS endpoint from
 * one origin (no CORS, no second deployment).
 */

import { createReadStream, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** The PWA is self-contained: same-origin only, and no inline script or style. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self' ws: wss:; manifest-src 'self'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";

export interface StaticResult {
  status: number;
  body?: Buffer;
  filePath?: string;
  headers: Record<string, string>;
}

export interface StaticOptions {
  /** Absolute or relative directory holding the PWA. */
  root: string;
  /** Served for `/` and for a directory-looking path. Default `index.html`. */
  index?: string;
}

/**
 * Map a URL path onto a file under the root. Returns `null` when the request must not be
 * served (traversal attempt, dotfile, missing file, directory). Pure enough to test without
 * a server: it only touches the filesystem to `realpath` and `stat`.
 */
export function resolveStatic(root: string, urlPath: string, o: StaticOptions = { root }): StaticResult | null {
  // Strip the query and decode once: `%2e%2e%2f` must not become `../`.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null; // malformed escape
  }
  if (decoded.includes("\0")) return null;

  const index = o.index ?? "index.html";
  const wanted = decoded === "/" || decoded === "" ? `/${index}` : decoded;
  if (!wanted.startsWith("/")) return null;

  const rootAbs = resolve(o.root);
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    return null; // no web root configured or missing on disk
  }

  // Reject dotfiles anywhere in the path: `.env`, `.git`, editor droppings.
  const segments = wanted.split("/").filter((s) => s !== "");
  if (segments.some((s) => s.startsWith("."))) return null;
  if (segments.some((s) => s === ".." || s === "\\")) return null;

  const candidate = resolve(rootReal, ...segments);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) return null;

  let real: string;
  let stat: ReturnType<typeof statSync>;
  try {
    real = realpathSync(candidate); // a symlink pointing outside the root is refused
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
    stat = statSync(real);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const type = TYPES[extname(real).toLowerCase()] ?? "application/octet-stream";
  // The shell must never be cached stale; icon/svg assets may be.
  const cache = /\.(svg|png|ico|woff2)$/i.test(real) ? "public, max-age=604800" : "no-store";
  return {
    status: 200,
    filePath: real,
    headers: {
      "content-type": type,
      "cache-control": cache,
      "content-length": String(stat.size),
      "content-security-policy": CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  };
}

/** Stream a resolved static file to a response. */
export function sendStatic(res: ServerResponse, hit: StaticResult): void {
  res.writeHead(hit.status, hit.headers);
  if (!hit.filePath) return void res.end();
  const stream = createReadStream(hit.filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** Convenience wrapper: serve `urlPath` or answer 404. Returns whether it answered. */
export function serveStatic(res: ServerResponse, root: string | undefined, urlPath: string): boolean {
  if (!root) return false;
  const hit = resolveStatic(root, urlPath, { root });
  if (!hit) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("not found");
    return true;
  }
  sendStatic(res, hit);
  return true;
}

/** Exported for tests: the head of the CSP the PWA runs under. */
export const cspFor = (): string => CSP;
