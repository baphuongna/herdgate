// Standalone Mobile -> TUI publisher. Use a dedicated room for each mode.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HerdGateAgent } from "../agent/index.ts";
import { createSshBridge, translateBootstrap } from "./ssh.ts";

if (!process.env.HERDGATE_URL) throw new Error("configure HERDGATE_URL for this mobile publisher");
const url = new URL(process.env.HERDGATE_URL);
if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  throw new Error("HERDGATE_URL must be an HTTPS origin");
}
const loopback = process.env.HERDGATE_AGENT_LOOPBACK_PORT;
if (loopback !== undefined && (!/^[1-9]\d{0,4}$/.test(loopback) || Number(loopback) > 65535)) {
  throw new Error("HERDGATE_AGENT_LOOPBACK_PORT must be a port from 1 to 65535");
}
const endpoint = loopback
  ? `ws://127.0.0.1:${loopback}/v1/agent/ws`
  : `wss://${url.host}/v1/agent/ws`;
const token = process.env.HERDGATE_ROOM_TOKEN;
if (!token) throw new Error("configure a dedicated room token for the TUI mobile pilot");
const name = process.env.HERDGATE_HOST_NAME || "home-tui-mobile";
const controller = process.env.HERDGATE_MOBILE_TUI_ACT_DEVICE;
if (controller !== undefined && !/^d_[A-Za-z0-9]{1,32}$/.test(controller)) throw new Error("invalid Mobile TUI act device ID");
const allows = (device: string, scope: "read" | "act" | null) =>
  controller ? device === controller && scope === "act" : scope === "read";
const core = fileURLToPath(new URL("./mobile-tui-core.mjs", import.meta.url));
if (!existsSync(core)) throw new Error("missing TUI Core adapter");
const log = (line: string) => console.error(`herdgate-mobile-tui: ${line}`);
const coreCommands = new Set(["connect", "connect --json", "--version", "-V", "server status", "server status --json"]);
const bridge = createSshBridge({
  send: (device, payload) => agent.send(device, payload),
  resolveHc: () => core,
  trustedReadCore: core,
  tuiOnly: Boolean(controller),
  mobileTuiAdapter: controller ? { device: controller, scope: "act", script: core } : null,
  resolveHerdrBin: () => null,
  scopeOf: (device) => {
    const scope = agent.scopeOf(device);
    return allows(device, scope) ? scope : null;
  },
  log,
});

const agent = new HerdGateAgent({
  endpoint, roomToken: token,
  log: (line) => log(loopback && line.startsWith("cloud hello:") ? `${line} via loopback 127.0.0.1:${loopback}` : line),
  // Only a co-located Gate may use plaintext. Preserve its public Host check.
  wsOptions: loopback ? { headers: { Host: url.host }, agent: false, handshakeTimeout: 5000, perMessageDeflate: false } : undefined,
  adapter: {
    info: () => ({ name, version: "tui-core-pilot", capabilities: [controller ? "interactive" : "read-only"] }),
    onPairAsk: () => false,
    onDevices: (devices) => {
      const next = new Set(devices.filter((d) => allows(d.id, d.scope)).map((d) => d.id));
      for (const id of allowedDevices) if (!next.has(id)) bridge.dropDevice(id);
      allowedDevices = next;
    },
    onFrame(device, payload) {
      if (!payload || typeof payload !== "object" || !("op" in payload) || typeof payload.op !== "string" || !payload.op.startsWith("ssh.")) return;
      const p = payload as Record<string, unknown>;
      if (controller || p.op !== "ssh.open") { bridge.handle(device, p); return; }
      const cmd = typeof p.cmd === "string" ? p.cmd.trim() : "";
      if (cmd === "exit" || cmd === "exit 0") { bridge.handle(device, { ...p, cmd }); return; }
      const direct = cmd.match(/^(?:hc|herdr-core)[ \t]+(.+)$/)?.[1];
      const translated = !direct && cmd.includes("herdr-core") ? translateBootstrap(cmd)?.slice(3) : undefined;
      const args = direct || translated || "";
      if (coreCommands.has(args)) bridge.handle(device, { ...p, cmd: `hc ${args}` });
      else {
        log(`unsupported SSH command from ${device} (${cmd.length} bytes)`);
        agent.send(device, { op: "ssh.denied", ch: p.ch, reason: "unsupported command on read-only Herdr TUI pilot" });
      }
    },
  },
});
let allowedDevices = new Set<string>();
// Do not let a scoped child command inherit any room or account credential.
delete process.env.HERDGATE_ROOM_TOKEN;
delete process.env.HERDGATE_ACCOUNT_TOKEN;
delete process.env.HERDGATE_BRIDGE_TOKEN;
const stop = () => { bridge.closeAll(); agent.stop(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
agent.start();
await agent.firstHello.catch(() => {});
