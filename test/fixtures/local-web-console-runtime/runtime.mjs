import net from "node:net";
import { chmodSync, rmSync } from "node:fs";
import { once } from "node:events";

export async function startFixtureRuntime(socketPath, { snapshot, readText = "fixture screen\n", cols = null, rows = null } = {}) {
  const calls = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let request;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      calls.push(request);
      if (request.method === "session.snapshot") {
        const value = typeof snapshot === "function" ? await snapshot(request) : snapshot;
        socket.end(JSON.stringify({ id: request.id, result: { snapshot: value } }) + "\n");
      } else if (request.method === "pane.read") {
        const text = typeof readText === "function" ? await readText(request) : readText;
        socket.end(JSON.stringify({ id: request.id, result: { read: {
          pane_id: request.params?.pane_id, text, truncated: false, revision: 1, cols, rows,
        } } }) + "\n");
      } else {
        socket.end(JSON.stringify({ id: request.id, error: { code: "unknown_method", message: "fixture rejects unknown method" } }) + "\n");
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  try { chmodSync(socketPath, 0o600); } catch { /* platform-specific socket ACL */ }
  return {
    calls,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(socketPath, { force: true });
    },
  };
}
