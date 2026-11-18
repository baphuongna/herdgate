// A herdr-core stand-in: JSON-RPC echo over lines; records every method it receives.
import { appendFileSync } from "node:fs";
const LOG = process.env.FAKE_HC_LOG ?? "/tmp/fake-hc.log";
let buf = "";
process.stdin.setEncoding? null : null;
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { appendFileSync(LOG, JSON.stringify({ malformed: line.slice(0, 24) }) + "\n"); continue; }
    appendFileSync(LOG, JSON.stringify({ method: m.method ?? null, framed: m.params && typeof m.params === "object" ? (m.params.framed ?? null) : null }) + "\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id ?? null, result: { echo: m.method ?? null, framed: m.params && typeof m.params === "object" ? (m.params.framed ?? null) : null } }) + "\n");
  }
});
setInterval(() => {}, 1 << 30);
