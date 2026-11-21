/** The host CLI: run this on the machine where Herdr runs.
 *
 *   HERDGATE_URL         https://your-cloud        (required)
 *   HERDGATE_ROOM_TOKEN  this host's room token    (required once paired)
 *   HERDGATE_PROVISION   "1" to pair via device flow, then print the room token
 *   HERDGATE_HOST_NAME   label shown to devices    (default: os hostname)
 *   HERDGATE_HERDR_POLL_MS  snapshot poll interval (default 5000)
 *   HERDGATE_ALLOW_ACT   "1" to auto-approve `act` devices (default: deny)
 *   HERDGATE_HERDR_BIN   path to the herdr binary  (default: `herdr` on PATH)
 *
 * Read-only: this process only ever runs `herdr api snapshot`.
 */
import { hostname } from "node:os";
import { HerdGateAgent, provision } from "../agent/index.ts";
import { pairingQrPayload, printPairingQr } from "../agent/qr.ts";
import { HerdrAdapter } from "./herdr.ts";
import { createSshBridge } from "./ssh.ts";
import type { AgentAdapter, PairAsk } from "../agent/adapter.ts";
import type { DeviceView } from "../protocol/agent.ts";

const env = process.env;
const url = env.HERDGATE_URL;
if (!url) {
  console.error("herdgate-host: HERDGATE_URL is required (e.g. https://herd.example.com)");
  process.exit(2);
}
const name = env.HERDGATE_HOST_NAME ?? hostname();
const log = (line: string): void => console.error(`herdgate-host: ${line}`);
const base = url.replace(/\/$/, "");

let roomToken = env.HERDGATE_ROOM_TOKEN ?? "";
if (!roomToken) {
  if (env.HERDGATE_PROVISION !== "1") {
    console.error("herdgate-host: HERDGATE_ROOM_TOKEN is required (or set HERDGATE_PROVISION=1 to pair)");
    process.exit(2);
  }
  const paired = await provision({
    baseUrl: base,
    name,
    onCode: (info) => {
      log(`approve this host at ${info.url} (expires in 10 minutes)`);
      // The camera path (pairfob lesson): a QR of `https://<gate>/#pair=<code>`
      // opens the PWA with the code prefilled. ASCII QR only on an interactive
      // terminal; otherwise the URL line above is the fallback.
      try {
        printPairingQr(pairingQrPayload(base, info.code), (line) => console.error(line), {
          isTTY: process.stderr.isTTY,
        });
      } catch {
        log(`open on your phone: ${base}/#pair=${info.code}`);
      }
    },
  });
  roomToken = paired.roomToken;
  console.error(`herdgate-host: paired into room ${paired.roomId}`);
  console.error(`herdgate-host: store this token: HERDGATE_ROOM_TOKEN=${paired.roomToken}`);
}

const adapter = new HerdrAdapter({
  name,
  pollMs: Number(env.HERDGATE_HERDR_POLL_MS ?? 5_000),
  allowAct: env.HERDGATE_ALLOW_ACT === "1",
  log,
});

// The SSH leg (phones → herdr-core through the gate). The bridge owns every `ssh.*`
// op; the Herdr adapter never sees them. Scope is enforced inside the bridge.
const sshBridge = createSshBridge({
  send: (device, payload) => agent.send(device, payload),
  scopeOf: (device) => agent.scopeOf(device),
  log,
});
let knownDevices = new Set<string>();
const adapterWithSsh: AgentAdapter = {
  info: () => adapter.info(),
  onFrame: (device: string, payload: unknown): void => {
    if (sshBridge.handle(device, payload)) return;
    adapter.onFrame(device, payload);
  },
  onDevices: (devices: DeviceView[]) => {
    // A device that left the room must not keep an SSH channel running.
    const fresh = new Set(devices.map((d) => d.id));
    for (const gone of knownDevices) if (!fresh.has(gone)) sshBridge.dropDevice(gone);
    knownDevices = fresh;
    adapter.onDevices(devices);
  },
  onPairAsk: (ask: PairAsk) => adapter.onPairAsk(ask),
};

const agent = new HerdGateAgent({
  endpoint: `${base.replace(/^http/, "ws")}/v1/agent/ws`,
  roomToken,
  adapter: adapterWithSsh,
  log,
});

adapter.attach({
  send: (device, payload) => agent.send(device, payload),
  get devices() {
    return agent.devices;
  },
  scopeOf: (device) => agent.scopeOf(device),
});

agent.start();
adapter.start();
await agent.firstHello;
log(`connected; serving Herdr metadata read-only (${name})`);

const bye = (): void => {
  log("shutting down");
  adapter.stop();
  sshBridge.closeAll();
  agent.stop();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
