import net from "node:net";

// Packaged Console transport: npm ships bin/*.mjs but not nested plugin/server/console sources.

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const PANE_TIMEOUT_MS = 2_500;
const MAX_PANE_LINES = 120;
let nextId = 0;

function positiveDimension(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Derive terminal cell geometry only from runtime readings or the matching layout. */
export function derivePaneDimensions(snapshot, paneId, read = {}) {
  const pane = snapshot?.panes?.find((item) => item?.pane_id === paneId);
  const layout = snapshot?.layouts?.find((item) => item?.tab_id === pane?.tab_id);
  const layoutPane = layout?.panes?.find((item) => item?.pane_id === paneId);
  const isZoomedPane = layout?.zoomed === true && (layout.focused_pane_id === paneId || layoutPane?.focused === true);
  const rect = isZoomedPane ? layout.area : layoutPane?.rect;
  const viewportRows = positiveDimension(pane?.scroll?.viewport_rows);
  const layoutRows = positiveDimension(rect?.height);
  const verticalInsets = viewportRows !== null && layoutRows !== null ? layoutRows - viewportRows : null;
  // Live 0.9.5 geometry: zero/two vertical border cells and one stable scrollbar gutter; unknown deltas stay null.
  const fallbackCols = positiveDimension(rect?.width) !== null && rect.width > 4 && (verticalInsets === 0 || verticalInsets === 2)
    ? rect.width - (verticalInsets === 2 ? 3 : 1)
    : null;
  return {
    cols: positiveDimension(read?.cols) ?? positiveDimension(fallbackCols),
    rows: positiveDimension(read?.rows) ?? viewportRows,
  };
}

export class ConsoleRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConsoleRpcError";
    this.code = code;
  }
}

/** Bind a connector to a path at trusted runtime setup; paths never enter RPC calls. */
export function createUnixConnector(socketPath) {
  if (typeof socketPath !== "string" || socketPath.length === 0) throw new TypeError("socketPath required");
  return () => net.createConnection(socketPath);
}

/**
 * Minimal Herdr JSONL RPC. The public surface intentionally exposes only two read methods.
 * Each Herdr request is one-shot: one connection, one matching reply, then immediate teardown.
 */
export function createConsoleRpc({ connect, timeoutMs = DEFAULT_TIMEOUT_MS, paneTimeoutMs = PANE_TIMEOUT_MS, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES }) {
  if (typeof connect !== "function") throw new TypeError("connect function required");
  for (const [name, value] of Object.entries({ timeoutMs, paneTimeoutMs, maxFrameBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }

  let confirmedPanes = new Set();
  let snapshotInFlight;

  function request(method, params, deadlineMs) {
    const id = `console:${++nextId}`;
    const frame = Buffer.from(`${JSON.stringify({ id, method, params })}\n`, "utf8");
    if (frame.byteLength > maxFrameBytes) return Promise.reject(new ConsoleRpcError("frame_too_large", "RPC request frame too large"));

    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;
      let received = Buffer.alloc(0);
      const timer = setTimeout(() => fail("timeout", "RPC timed out"), deadlineMs);
      timer.unref?.();

      const close = () => {
        if (!socket) return;
        const current = socket;
        socket = undefined;
        try { current.destroy(); } catch { /* best-effort teardown */ }
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        close();
        fn(value);
      };
      const fail = (code, message) => finish(reject, new ConsoleRpcError(code, message));

      try {
        socket = connect();
      } catch {
        fail("connect_failed", "RPC connect failed");
        return;
      }
      if (!socket || typeof socket.on !== "function" || typeof socket.write !== "function" || typeof socket.destroy !== "function") {
        fail("connect_failed", "RPC connector returned an invalid socket");
        return;
      }

      socket.on("error", () => fail("connection_error", "RPC connection failed"));
      socket.on("close", () => {
        if (settled) return;
        if (received.length > 0) fail("unterminated_frame", "RPC connection closed with an unterminated frame");
        else fail("connection_closed", "RPC connection closed before a reply");
      });
      socket.on("data", (chunk) => {
        if (settled) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received = Buffer.concat([received, data]);
        if (received.byteLength > maxFrameBytes) {
          fail("frame_too_large", "RPC reply frame too large");
          return;
        }
        const newline = received.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== received.length - 1) {
          fail("invalid_frame", "RPC reply must contain exactly one JSONL frame");
          return;
        }
        let message;
        try {
          const lineBytes = received.subarray(0, newline);
          const line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes).replace(/\r$/, "");
          message = JSON.parse(line);
        } catch {
          fail("malformed_reply", "RPC reply is not valid UTF-8 JSON");
          return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          fail("invalid_reply", "RPC reply has invalid shape");
          return;
        }
        if (message.id !== id) {
          fail("reply_id_mismatch", "RPC reply id mismatch");
          return;
        }
        if (message.error !== undefined) {
          const error = message.error;
          if (!error || typeof error !== "object" || typeof error.code !== "string" || typeof error.message !== "string") {
            fail("invalid_reply", "RPC error reply has invalid shape");
            return;
          }
          fail(error.code, `RPC denied: ${error.code}`);
          return;
        }
        if (!message.result || typeof message.result !== "object" || Array.isArray(message.result)) {
          fail("invalid_reply", "RPC success reply has invalid shape");
          return;
        }
        finish(resolve, message.result);
      });

      try {
        socket.write(frame, (error) => {
          if (error) fail("connection_error", "RPC request write failed");
        });
      } catch {
        fail("connection_error", "RPC request write failed");
      }
    });
  }

  function snapshot() {
    if (snapshotInFlight) return snapshotInFlight;

    const pending = (async () => {
      try {
        const result = await request("session.snapshot", {}, timeoutMs);
        const value = result.snapshot;
        if (!value || typeof value !== "object" || !Array.isArray(value.workspaces) || !Array.isArray(value.tabs) || !Array.isArray(value.panes)) {
          throw new ConsoleRpcError("invalid_snapshot", "session.snapshot result has invalid shape");
        }
        const panes = new Set();
        for (const pane of value.panes) {
          if (!pane || typeof pane !== "object" || typeof pane.pane_id !== "string" || pane.pane_id.length === 0) {
            throw new ConsoleRpcError("invalid_snapshot", "session.snapshot contains an invalid pane");
          }
          panes.add(pane.pane_id);
        }
        confirmedPanes = panes;
        return value;
      } catch (error) {
        // Keep the last confirmed set while refreshing; revoke it if that refresh fails.
        confirmedPanes = new Set();
        throw error;
      } finally {
        if (snapshotInFlight === pending) snapshotInFlight = undefined;
      }
    })();
    snapshotInFlight = pending;
    return pending;
  }

  return Object.freeze({
    snapshot,

    async readPane(paneId) {
      if (typeof paneId !== "string" || !confirmedPanes.has(paneId)) {
        throw new ConsoleRpcError("pane_not_confirmed", "pane ID was not confirmed by the latest snapshot");
      }
      const result = await request("pane.read", {
        pane_id: paneId,
        source: "visible",
        lines: MAX_PANE_LINES,
        format: "ansi",
      }, paneTimeoutMs);
      const value = result.read;
      if (!value || typeof value !== "object" || value.pane_id !== paneId || typeof value.text !== "string" || typeof value.truncated !== "boolean") {
        throw new ConsoleRpcError("invalid_pane_read", "pane.read result has invalid shape");
      }
      return value;
    },
  });
}
