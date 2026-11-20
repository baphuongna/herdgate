/** Cloud CLI entry. Configure by environment (DEPLOY.md has the full story):
 *
 *   HERDGATE_PORT          listen port            (default 8787)
 *   HERDGATE_BIND          bind address           (default 127.0.0.1)
 *   HERDGATE_STATE         state JSON path        (default: none, in-memory)
 *   HERDGATE_ACCOUNT_TOKEN or HERDGATE_ACCOUNT_TOKEN_FILE (required; pick one)
 *   HERDGATE_ACCOUNT_NAME  display name           (default "owner")
 *   HERDGATE_PUBLIC_HOST   enforce this Host header (the cloudflared hostname)
 *   HERDGATE_PUBLIC_URL    shown in pairing URLs  (e.g. https://herd.example.com)
 *   HERDGATE_WEB_ROOT      the PWA directory      (default: src/web beside this file)
 *   HERDGATE_NO_WEB        "1" disables the PWA (API only)
 *   HERDGATE_NO_SSH       "1" disables both SSH listeners (TCP and WSS)
 *   HERDGATE_SSH_PORT      the SSH leg for phones (default 2222; 0 picks a free port)
 *   HERDGATE_SSH_BIND      its bind address       (default 127.0.0.1; 0.0.0.0 for LAN)
 *   HERDGATE_SSH_KEY       host key file          (default: beside the state file)
 *   HERDGATE_ENABLE_PUSH   "1" enables wake via supported HTTPS push providers (off by default)
 *   HERDGATE_NO_PUSH       "1" overrides that opt-in and disables push
 *   HERDGATE_SSH_HOST      the hostname phones dial for SSH (a DNS-only name)
 *   HERDGATE_SSH_PUBLIC_PORT optional port advertised for an external TCP edge
 *   HERDGATE_TRUSTED_PROXY  "1" trusts a proxy header (below) as the client address
 *   HERDGATE_REAL_IP_HEADER  the trusted header name (default CF-Connecting-IP)
 *   HERDGATE_SSH_TUNNELS_PER_IP  per-client SSH-over-WSS cap (default 6)
 *   HERDGATE_SSH_TUNNELS_TOTAL   global SSH-over-WSS cap (default 64)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCloud } from "./gateway.ts";
import { generateVapidKeys, loadVapidKeys, type VapidKeys } from "./vapid.ts";

const env = process.env;
const token = accountToken();

function accountToken(): string {
  const direct = env.HERDGATE_ACCOUNT_TOKEN;
  const file = env.HERDGATE_ACCOUNT_TOKEN_FILE;
  if (direct !== undefined && file !== undefined) {
    console.error("herdgate: set only one of HERDGATE_ACCOUNT_TOKEN and HERDGATE_ACCOUNT_TOKEN_FILE");
    process.exit(2);
  }
  let value = direct;
  if (file !== undefined) {
    try { value = readFileSync(file, "utf8").trim(); }
    catch {
      console.error("herdgate: could not read HERDGATE_ACCOUNT_TOKEN_FILE");
      process.exit(2);
    }
  }
  if (!value) {
    console.error("herdgate: HERDGATE_ACCOUNT_TOKEN or a nonempty HERDGATE_ACCOUNT_TOKEN_FILE is required");
    process.exit(2);
  }
  return value;
}

/** Default web root: the `src/web` directory beside this file, so `npm start` serves the PWA. */
const here = dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = join(here, "..", "web");
const webRoot = env.HERDGATE_NO_WEB === "1" ? undefined : (env.HERDGATE_WEB_ROOT ?? defaultWebRoot);

const sshPort = Number(env.HERDGATE_SSH_PORT ?? 2222);
const sshPublicPort = env.HERDGATE_SSH_PUBLIC_PORT === undefined ? undefined : Number(env.HERDGATE_SSH_PUBLIC_PORT);
if (sshPublicPort !== undefined && (!Number.isInteger(sshPublicPort) || sshPublicPort < 1 || sshPublicPort > 65535)) {
  console.error("herdgate: HERDGATE_SSH_PUBLIC_PORT must be a port from 1 to 65535");
  process.exit(2);
}
const sshKeyPath =
  env.HERDGATE_SSH_KEY ?? (env.HERDGATE_STATE ? join(dirname(env.HERDGATE_STATE), "ssh_host_ed25519.json") : undefined);

// Abuse-limit client addressing. Behind a same-host proxy (cloudflared) loopback
// connections already get per-connection budgets; trusted-proxy mode restores
// real per-client keys when the edge forwards one (e.g. CF-Connecting-IP).
const portOption = (name: string): number | undefined => {
  if (env[name] === undefined) return undefined;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    console.error(`herdgate: ${name} must be a port from 1 to 65535`);
    process.exit(2);
  }
  return value;
};
const tunnelPerKey = portOption("HERDGATE_SSH_TUNNELS_PER_IP");
const tunnelTotal = portOption("HERDGATE_SSH_TUNNELS_TOTAL");

// Push wake (VAPID): keys live beside the state file so the public key browsers
// subscribed to never changes behind their backs. Off unless explicitly enabled.
let push: { keys: VapidKeys; sub: string } | null = null;
if (env.HERDGATE_ENABLE_PUSH === "1" && env.HERDGATE_NO_PUSH !== "1") {
  const vapidPath = env.HERDGATE_STATE ? join(dirname(env.HERDGATE_STATE), "vapid.json") : undefined;
  let keys: VapidKeys | undefined;
  if (vapidPath) {
    try {
      keys = loadVapidKeys(JSON.parse(readFileSync(vapidPath, "utf8")).jwk);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("herdgate: cannot load existing VAPID key; restore it from backup");
      keys = generateVapidKeys();
      mkdirSync(dirname(vapidPath), { recursive: true, mode: 0o700 });
      writeFileSync(vapidPath, JSON.stringify({ jwk: keys.privateJwk }), { mode: 0o600, flag: "wx" });
    }
  } else {
    keys = generateVapidKeys();
  }
  push = { keys, sub: env.HERDGATE_PUSH_SUB ?? "mailto:owner@herdgate.invalid" };
}

const cloud = await startCloud({
  bind: env.HERDGATE_BIND ?? "127.0.0.1",
  port: Number(env.HERDGATE_PORT ?? 8787),
  statePath: env.HERDGATE_STATE,
  expectedHost: env.HERDGATE_PUBLIC_HOST,
  publicUrl: env.HERDGATE_PUBLIC_URL ?? null,
  webRoot,
  ssh: env.HERDGATE_NO_SSH === "1" ? undefined : {
    port: sshPort,
    bind: env.HERDGATE_SSH_BIND ?? "127.0.0.1",
    keyPath: sshKeyPath,
  },
  push,
  sshHost: env.HERDGATE_SSH_HOST || undefined,
  sshPublicPort,
  trustedProxy: env.HERDGATE_TRUSTED_PROXY === "1",
  realIpHeader: env.HERDGATE_REAL_IP_HEADER || "CF-Connecting-IP",
  ...(tunnelPerKey !== undefined || tunnelTotal !== undefined
    ? { sshTunnelLimits: { ...(tunnelPerKey !== undefined ? { perKey: tunnelPerKey } : {}), ...(tunnelTotal !== undefined ? { total: tunnelTotal } : {}) } }
    : {}),
  accounts: [{ id: "a_owner", name: env.HERDGATE_ACCOUNT_NAME ?? "owner", token }],
  log: (l) => console.error(`herdgate: ${l}`),
});

if (env.HERDGATE_NO_SSH !== "1" && !cloud.ssh) {
  await cloud.close();
  console.error("herdgate: refusing to start without the configured SSH leg");
  process.exit(1);
}

console.error(`herdgate: listening on http://${env.HERDGATE_BIND ?? "127.0.0.1"}:${cloud.port}`);
console.error(`herdgate: app on  ${env.HERDGATE_PUBLIC_URL ?? `http://${env.HERDGATE_BIND ?? "127.0.0.1"}:${cloud.port}`}/${webRoot ? "" : " (disabled)"}`);
console.error(`herdgate: pair a host:  curl -XPOST ${env.HERDGATE_PUBLIC_URL ?? `http://127.0.0.1:${cloud.port}`}/v1/agent/code -d '{"name":"my-mac"}'`);

const bye = (): void => {
  console.error("herdgate: shutting down");
  void cloud.close().then(() => process.exit(0));
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
