/** Cloud CLI entry. Configure by environment (DEPLOY.md has the full story):
 *
 *   HERDGATE_PORT          listen port            (default 8787)
 *   HERDGATE_BIND          bind address           (default 127.0.0.1)
 *   HERDGATE_STATE         state JSON path        (default: none, in-memory)
 *   HERDGATE_ACCOUNT_TOKEN required, account secret (mint: `openssl rand -base64 32`)
 *   HERDGATE_ACCOUNT_NAME  display name           (default "owner")
 *   HERDGATE_PUBLIC_HOST   enforce this Host header (the cloudflared hostname)
 *   HERDGATE_PUBLIC_URL    shown in pairing URLs  (e.g. https://herd.example.com)
 *   HERDGATE_WEB_ROOT      the PWA directory      (default: src/web beside this file)
 *   HERDGATE_NO_WEB        "1" disables the PWA (API only)
 *   HERDGATE_SSH_PORT      the SSH leg for phones (default 2222; 0 disables)
 *   HERDGATE_SSH_BIND      its bind address       (default 127.0.0.1; 0.0.0.0 for LAN)
 *   HERDGATE_SSH_KEY       host key file          (default: beside the state file)
 *   HERDGATE_HC_BIN        herdr-core binary on hosts (hosts resolve hc themselves)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCloud } from "./gateway.ts";

const env = process.env;
const token = env.HERDGATE_ACCOUNT_TOKEN;
if (!token) {
  console.error("herdgate: HERDGATE_ACCOUNT_TOKEN is required (openssl rand -base64 32)");
  process.exit(2);
}

/** Default web root: the `src/web` directory beside this file, so `npm start` serves the PWA. */
const here = dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = join(here, "..", "web");
const webRoot = env.HERDGATE_NO_WEB === "1" ? undefined : (env.HERDGATE_WEB_ROOT ?? defaultWebRoot);

const sshPort = Number(env.HERDGATE_SSH_PORT ?? 2222);
const sshKeyPath =
  env.HERDGATE_SSH_KEY ?? (env.HERDGATE_STATE ? join(dirname(env.HERDGATE_STATE), "ssh_host_ed25519.json") : undefined);

const cloud = await startCloud({
  bind: env.HERDGATE_BIND ?? "127.0.0.1",
  port: Number(env.HERDGATE_PORT ?? 8787),
  statePath: env.HERDGATE_STATE,
  expectedHost: env.HERDGATE_PUBLIC_HOST,
  publicUrl: env.HERDGATE_PUBLIC_URL ?? null,
  webRoot,
  ssh: {
    port: sshPort,
    bind: env.HERDGATE_SSH_BIND ?? "127.0.0.1",
    keyPath: sshKeyPath,
  },
  accounts: [{ id: "a_owner", name: env.HERDGATE_ACCOUNT_NAME ?? "owner", token }],
  log: (l) => console.error(`herdgate: ${l}`),
});

console.error(`herdgate: listening on http://${env.HERDGATE_BIND ?? "127.0.0.1"}:${cloud.port}`);
console.error(`herdgate: app on  ${env.HERDGATE_PUBLIC_URL ?? `http://${env.HERDGATE_BIND ?? "127.0.0.1"}:${cloud.port}`}/${webRoot ? "" : " (disabled)"}`);
console.error(`herdgate: pair a host:  curl -XPOST ${env.HERDGATE_PUBLIC_URL ?? `http://127.0.0.1:${cloud.port}`}/v1/agent/code -d '{"name":"my-mac"}'`);

const bye = (): void => {
  console.error("herdgate: shutting down");
  void cloud.close().then(() => process.exit(0));
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
