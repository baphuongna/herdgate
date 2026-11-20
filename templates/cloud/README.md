# Herdgate Cloud — self-hosted Gate + PWA

This archive runs the Gate, PWA and SSH-over-WSS relay. It includes the matching host installer at `/herdgate-host.zip` and a separate tokenless TCP edge entrypoint for native Herdr Mobile clients. It contains no owner token, room/device state, host keys, TLS credentials or site-specific settings. The Gate is single-instance; do not point two processes at the same state directory.

## Docker Compose (Linux, new install)

From the extracted archive, as your normal non-root user:

```sh
cp -n compose.env.example .env
# Edit .env: set HERDGATE_PUBLIC_HOST to your DNS name and UID/GID to id -u / id -g.
install -d -m 700 data
(umask 077; set -C; openssl rand -base64 32 > owner-token)
docker compose up -d --build --wait
```

The token-generation command fails rather than overwriting an existing file. Do not put `owner-token` or `data/` under the web root or in a release. Compose mounts the token read-only and runs as the configured UID/GID so it can read the private file and write to `data/`. If using Docker user namespaces, arrange equivalent permissions for the mapped UID/GID. Keep this token in a password manager; it is the owner login for the PWA.

Point your HTTPS reverse proxy or named cloudflared tunnel at `http://127.0.0.1:8787` (or your `HERDGATE_HTTP_PORT`). Preserve the public `Host` header and WebSocket upgrades. Gate's HTTP port is bound to host loopback and its raw SSH port is not published. The included `Caddyfile.example` is a site block to adapt, not a replacement for existing proxy configuration. No DNS, firewall, or TLS changes are performed by the bundle.

```sh
curl -fsS -H 'Host: gate.example.com' http://127.0.0.1:8787/healthz
curl -fsS https://gate.example.com/healthz
```

## Linux/systemd (alternative to Docker)

Requires Node 22+ and npm. JavaScript is already compiled; the target does not need TypeScript or native Node type stripping.

1. Extract the archive into `/opt/herdgate-cloud` (root-owned, readable by the service) and install the locked runtime dependencies there: `npm ci --omit=dev --omit=optional --ignore-scripts && node scripts/patch-ssh2.mjs`.
2. Create `/etc/herdgate` with root-only permissions. Generate a new `/etc/herdgate/owner-token` (0600, root-owned) with `openssl rand -base64 32`, using `umask 077` and `set -C` as above. Do not pass it as a command-line argument. systemd uses `LoadCredential` to hand the service a readable copy.
3. Create `/etc/herdgate/cloud.env` with only non-secret settings:

   ```dotenv
   HERDGATE_PUBLIC_HOST=gate.example.com
   HERDGATE_PUBLIC_URL=https://gate.example.com
   # For a separate native Mobile TCP edge:
   # HERDGATE_SSH_HOST=ssh.example.com
   # HERDGATE_SSH_PUBLIC_PORT=2299
   ```

4. Install the included `herdgate-cloud.service` in `/etc/systemd/system/` (adjust `/usr/bin/node` if necessary). Run `sudo systemctl daemon-reload` and `sudo systemctl enable --now herdgate-cloud`. systemd manages `/var/lib/herdgate-cloud` as the private state directory. Use the same HTTPS reverse-proxy and health checks as for Compose.

## Pair hosts and connect clients

Open `https://gate.example.com/`, sign in with the owner token and approve the host's pairing request. Obtain the matching installer from `https://gate.example.com/herdgate-host.zip`, or on the publisher use the Herdgate CLI from npm:

```sh
herdgate cloud add mygate https://gate.example.com
herdgate pair --cloud mygate  # approve the code in the PWA
herdgate setup --cloud mygate
```

`cloud add` does not move an existing pairing. Do not aim an already-paired publisher at a new, empty Gate and expect its previous room to exist. For SSH, register only the controller's public key on the specific approved device ID, use that ID as the SSH username, and pin the Gate's SSH fingerprint from its startup log when first initialized.

### Optional: native Herdr Mobile on cellular

The compiled `runtime/cloud/ssh-tcp-edge.js` forwards TCP to `wss://<gate>/v1/ssh/ws`. On a VPS, install the archive and locked runtime dependencies as above, but run **only** the included `herdgate-cloud-edge.service`, not `herdgate-cloud.service`. It reads `/etc/herdgate/edge.env`:

```dotenv
HERDGATE_URL=https://gate.example.com
HERDGATE_TCP_EDGE_BIND=0.0.0.0
HERDGATE_TCP_EDGE_PORT=2299
```

Expose only the edge port as needed and enter its reachable IP or DNS-only hostname and port in Mobile. On the Gate set `HERDGATE_SSH_HOST` and `HERDGATE_SSH_PUBLIC_PORT` if the PWA should advertise the edge address. All edge tunnels arrive at the Gate from one address: raise the Gate budget with `HERDGATE_SSH_TUNNELS_PER_IP`/`HERDGATE_SSH_TUNNELS_TOTAL` to fit your expected concurrent Mobile sessions. The edge does not terminate SSH, and needs no owner/room token, state directory, or private key; do not copy them to it. The Gate retains its SSH host key and decides authentication and scope.

## Optional: PWA push wake

Wake notifications are off by default. Only opt in with `HERDGATE_ENABLE_PUSH=1` (in Compose `.env` or systemd `cloud.env`) if needed. `HERDGATE_NO_PUSH=1` overrides that opt-in. Set `HERDGATE_PUSH_SUB` to your VAPID contact URI. Herdgate accepts only HTTPS endpoints on `fcm.googleapis.com`, `updates.push.services.mozilla.com` and `web.push.apple.com`; requests require a public IPv4 address and do not follow redirects. An unsupported subscription does not prevent normal PWA use.

## Back up, upgrade or migrate

Stop only the Gate to take a consistent **private** backup of `state.json`, `ssh_host_ed25519.json`, `vapid.json` (if present) and the owner-token file. Keep the same public origin when moving an existing Gate. Never use a staging archive as a backup, and never run a new instance alongside the old one against the same state. An upgrade replaces application files/image only; use the original state directory and token, not a fresh one. For Compose, retain `data/`, `.env` and `owner-token` and rebuild from the new archive; use the previous image/archive with that same data if rollback is needed and the state format is compatible. Verify `/healthz`, PWA sign-in, publisher reconnect and the pinned SSH host key. Publisher/CLI updates do not upgrade the Gate or TCP edge.
