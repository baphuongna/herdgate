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
import { HerdrAdapter } from "./herdr.ts";

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
    onCode: (u) => console.error(`herdgate-host: approve this host at ${u} (expires in 10 minutes)`),
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

const agent = new HerdGateAgent({
  endpoint: `${base.replace(/^http/, "ws")}/v1/agent/ws`,
  roomToken,
  adapter,
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
  agent.stop();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
