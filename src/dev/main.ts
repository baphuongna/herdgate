/**
 * edge-sim CLI: run the Cloudflare-edge simulator for a local gateway.
 *
 *   HERDGATE_TARGET_PORT   the gateway's plain-HTTP port      (required)
 *   HERDGATE_PINNED_HOST   the Host the edge presents        (default: gate.local)
 *   HERDGATE_EDGE_CERT     TLS cert                          (required)
 *   HERDGATE_EDGE_KEY      TLS key                           (required)
 *
 * The pair of throwaway dev certs is generated with openssl (see DEPLOY.md's
 * "Rehearse before going live"). Real deployments use cloudflared + a real cert; this
 * exists so the public contract (host pinning, TLS PWA, wss legs) is exercised on this
 * machine first.
 */
import { startEdgeSim } from "./edge-sim.ts";

const env = process.env;
const targetPort = Number(env.HERDGATE_TARGET_PORT ?? 0);
if (!targetPort || !env.HERDGATE_EDGE_CERT || !env.HERDGATE_EDGE_KEY) {
  console.error("edge-sim: HERDGATE_TARGET_PORT, HERDGATE_EDGE_CERT, HERDGATE_EDGE_KEY are required");
  process.exit(2);
}
const edge = await startEdgeSim({
  pinnedHost: env.HERDGATE_PINNED_HOST ?? "gate.local",
  targetPort,
  certPath: env.HERDGATE_EDGE_CERT,
  keyPath: env.HERDGATE_EDGE_KEY,
});
console.log(`edge-sim: https://127.0.0.1:${edge.port} → 127.0.0.1:${targetPort} (Host: ${env.HERDGATE_PINNED_HOST ?? "gate.local"})`);
const bye = (): void => {
  void edge.close().then(() => process.exit(0));
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
