# Deploying Herdgate

## Deploying a clean Gate

From a checkout with Node 22+, npm, Bash, `tar`, `zip` and `sha256sum`:

```sh
npm ci --ignore-scripts
npm run build:release
# Or stage into a new directory without changing the PWA currently being served:
npm run build:release -- /path/to/new-output
```

The default `dist/<version>/` contains `herdgate-cloud-<version>.tar.gz`,
`herdgate-host-<version>.zip`, the npm tarball and `SHA256SUMS`. Verify the set
with `sha256sum -c SHA256SUMS`. The Cloud archive contains compiled JS, the PWA
with the matching host ZIP, a dependency lockfile, and Compose/systemd examples.
The standalone npm command `herdgate cloud serve` is also available from a full
npm installation on Node with TypeScript stripping, like `npm start`.

Extract the Cloud archive and follow its [README](templates/cloud/README.md)
to deploy via Docker Compose or systemd. Create credentials on the destination:
no build step copies state, tokens, SSH or VAPID keys, or modifies a running Gate.
The old `scripts/deploy-vps.sh` is retired and does not connect to the target.
For an existing Gate, back up and migrate explicitly, keeping the public origin,
owner token, state, SSH key and any VAPID keys. A clean Gate starts with no rooms.

From v0.9.33, Push wake is off by default. If you need it, set `HERDGATE_ENABLE_PUSH=1`
(and optionally `HERDGATE_PUSH_SUB` to a VAPID contact URI); `HERDGATE_NO_PUSH=1`
takes precedence. Existing VAPID keys are untouched while wake is off.

A PWA room with a Noise host pin no longer accepts plaintext pane data or a different
host key.

### Client addresses behind a proxy (v0.9.34)

Abuse limits (failed-hello strikes, pairing-code minting, SSH-over-WSS caps) key on
the client address. Connections arriving over loopback — a same-host proxy such as
cloudflared — automatically get a **per-connection** budget, so one abusive client
cannot lock everyone behind the proxy out, and the Gate admits SSH tunnels up to its
global total rather than a collapsed per-address cap. If your edge forwards a real
client IP header, set `HERDGATE_TRUSTED_PROXY=1` (and optionally
`HERDGATE_REAL_IP_HEADER`, default `CF-Connecting-IP`) to restore per-client budgets;
a raw TCP edge cannot convey real addresses, so size the shared budget with
`HERDGATE_SSH_TUNNELS_PER_IP` and `HERDGATE_SSH_TUNNELS_TOTAL`. Pairing-code minting
is bounded per client (10 per 10 minutes) and globally (256 pending). Matching legacy pins are upgraded without re-pairing. Keep the publisher’s
`e2e-host.json` in backups; on a key-change warning verify the identity with the host
admin rather than clearing browser data. Noise does not cover the separate SSH leg.

## Source checkout behind cloudflared

If you are developing or already run from the checkout, bind the cloud to
`127.0.0.1` and publish it through a Cloudflare tunnel. Two shapes:

### A. Quick tunnel (no DNS setup, throwaway URL)

```sh
# terminal 1 — the cloud
# From the checkout; use a disposable private directory.
trial=$(mktemp -d)
(umask 077; openssl rand -base64 32 > "$trial/owner-token")
HERDGATE_ACCOUNT_TOKEN_FILE="$trial/owner-token" HERDGATE_STATE="$trial/state.json" npm start

# terminal 2 — a trycloudflare URL (random, changes every run)
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the printed `https://<random>.trycloudflare.com` as the public URL. Nothing to configure; fine for testing.

### B. Named tunnel + your domain (stable hostname)

```sh
cloudflared tunnel login                     # once, picks a zone
cloudflared tunnel create herdgate
cloudflared tunnel route dns herdgate herd.example.com

cat > ~/.cloudflared/herdgate.yml <<'YML'
tunnel: herdgate
credentials-file: /absolute/path/to/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: herd.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
YML

cloudflared --config ~/.cloudflared/herdgate.yml tunnel run
```

Then start the cloud with the hostname pinned:

```sh
install -d -m 700 "$HOME/.herdgate"
# First install only; preserve the token file on upgrades.
(umask 077; set -C; openssl rand -base64 32 > "$HOME/.herdgate/owner-token")
export HERDGATE_ACCOUNT_TOKEN_FILE="$HOME/.herdgate/owner-token"
export HERDGATE_STATE="$HOME/.herdgate/state.json"
export HERDGATE_PUBLIC_HOST=herd.example.com
export HERDGATE_PUBLIC_URL=https://herd.example.com
npm start
```

`HERDGATE_PUBLIC_HOST` makes the gateway answer **only** that Host (421 otherwise); `HERDGATE_PUBLIC_URL` builds
the pairing links shown to hosts.

### Funnel vs Tunnel

- **Tunnel** (above): the hostname resolves for everyone, but traffic only flows for this tunnel — which is
  what we want, because herdgate authenticates every request and socket itself (hello-first tokens). Use this.
- **Funnel** (`cloudflared tunnel --url … --hello-world` variants / funnel ingress) would additionally let
  arbitrary internet clients terminate at your origin without a CF account — herdgate's gate is the only
  protection then. It works with the same code (the gate never trusts CF headers), but adds no value and more
  exposure. Not recommended.

## Rehearse before going live (edge-sim)

`npm run edge` runs a local Cloudflare-edge simulator: TLS termination + `Host` rewrite +
WebSocket Upgrade splice — byte-for-byte the origin-side job cloudflared does. It lets you
exercise the public contract (`expectedHost` pinning → 421 on wrong host, the PWA over
TLS, both wss legs) on this machine, with a throwaway dev cert:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
  -keyout /tmp/edge-key.pem -out /tmp/edge-cert.pem -days 2 -nodes -subj "/CN=127.0.0.1"

# terminal 1, reuse a local test token file
HERDGATE_ACCOUNT_TOKEN_FILE=/path/to/test-token \
HERDGATE_PUBLIC_HOST=gate.local HERDGATE_NO_SSH=1 npm start
HERDGATE_TARGET_PORT=8787 HERDGATE_PINNED_HOST=gate.local \
  HERDGATE_EDGE_CERT=/tmp/edge-cert.pem HERDGATE_EDGE_KEY=/tmp/edge-key.pem \
  npm run edge                                                          # terminal 2
# → https://127.0.0.1:<port>  (trust the cert or pass --ignore-certificate-errors)
```

Verified by `test/edge.test.ts` and a full headless-Chrome run: sign in → `online` →
machine online → pair read → live Herdr view + SSH hint, all over TLS with both wss legs
through the splice.

For a permanent deployment, prefer a named tunnel on a domain you control. If a quick tunnel
registers but returns 404, check the active tunnel and ingress settings before changing DNS.

### The SSH leg — passwordless logins (publickey)

`hc machine add` shells out to the system `ssh`, which prefers keys and the agent and
refuses to answer prompts when it has no terminal. A device whose machine should add
it non-interactively registers that machine's public key first:

1. In the PWA, open the host's room → **SSH for the Herdr app**, select the exact device ID,
   and add the controlling machine's public key. For Herdr Mobile, add the phone's public key to
   its device ID instead. Do not edit the publisher's `authorized_keys` or copy a private key.
2. Confirm the fingerprint presented by the client matches the Gate's known SSH host fingerprint.
   Pin that key; the TCP edge does not present the VPS admin SSH key.
3. Use the room's device ID as the SSH username. For example, a Core client can run
   `hc machine add d_device@ssh.example.com:2299`. On Mobile, use the reachable TCP edge
   hostname or IPv4 address and port in the machine settings. Password auth with the paired
   device secret also works.

The REST surface (same two identities as `/v1/device/push`: the device's own secret,
or the account token): `GET/POST/DELETE /v1/device/sshkey`. Ed25519, RSA and ECDSA
(nistp256/384/521) keys are accepted; signatures are verified per RFC 4252 §7.

## The SSH leg is not a Cloudflare-TCP leg — three ways in

Phones speak plain SSH to `host:port`; Cloudflare Tunnel only carries TCP for clients
running `cloudflared access`, which the phone does not. Reachability options, in order
of setup cost:

1. **LAN / same network** — `HERDGATE_SSH_BIND=0.0.0.0`, phones dial the machine.
2. **IPv6 AAAA** (this machine's setup) — a DNS-only `AAAA` record to the gate
   machine's global IPv6; `~/.local/bin/herdgate-ssh-ddns` + the `herdgate-ddns`
   timer keep it current (needs a Cloudflare API token + `ufw allow`).
3. **Tokenless TCP edge (recommended for a VPS)** — one TCP connection from Herdr
   Mobile maps to one WSS connection to the public gate. The edge never terminates
   SSH. Use the existing Herdgate SSH host key on the phone, not the VPS admin key.

### Deploy the tokenless TCP edge on a VPS

Use a public IPv4 VPS with Node 22+ installed system-wide. The Cloud release
includes the compiled TCP edge and a separate systemd unit. See the
[Cloud README](templates/cloud/README.md#optional-native-herdr-mobile-on-cellular).
For an existing standalone deployment, its old unit and config still work.
The edge caps concurrent sessions at 3 per IP and 6 total by default; the
Gate's tunnel caps still apply, and it may see several clients as one source
behind a proxy. Test the edge directly from Mobile over cellular and verify
the pinned Gate SSH key before switching any DNS-only records. Keep the HTTPS
Gate hostname unchanged.

### Legacy authenticated SSH bridge

The older SSH bridge is also available, but requires an account owner token on
its VPS and shares one upstream connection:

```sh
# on the VPS (Node ≥ 22, one file, no dependencies):
node ssh-bridge.ts   # env: HERDGATE_URL, HERDGATE_BRIDGE_TOKEN (the account token),
                     #      HERDGATE_BRIDGE_BIND/PORT (default 0.0.0.0:2299),
                     #      HERDGATE_BRIDGE_PUBLIC_HOST/PORT — advertise what phones dial
```

The bridge dials the cloud over an OUTBOUND WebSocket and pipes raw SSH bytes both
ways; the cloud feeds them into its sshd through ssh2's `injectSocket`. Device-key
auth, act-scope enforcement, the read-only allowlist and brute-force strikes all stay
in the cloud. The legacy bridge credential is the account (owner) token. While a bridge with an advertised address is connected, the
device hello's `ssh {host, port}` points phones at it; disconnect it and the hello
falls back to the gate's own address. Verified end to end through the real Cloudflare
tunnel: pair over wss → SSH the bridge → `hello` (32 methods), `server.status`, and
`terminal.send` refused with the act-scope error.

The public HTTP/WSS surface continues to go through the tunnel.

### When the publisher and gateway run on the same machine

Set `HERDGATE_AGENT_LOOPBACK_PORT=8833` in the publisher's `herdgate.env`
(use the gateway's actual port). Keep `HERDGATE_URL` set to the canonical public
URL. The publisher dials `127.0.0.1` with the public `Host` header, so gateway host
validation and room-token authentication still apply. This opt-in mode uses the
existing `ws` dependency from the npm installation; the standalone plugin uses
Node's native WebSocket by default. Restart only the publisher. Remove the line
to restore the public transport. No client SSH configuration changes are needed.

For the standalone Linux Mobile TUI publisher (`src/host/mobile-tui.ts`),
set `HERDGATE_AGENT_LOOPBACK_PORT` in its **process environment** (for systemd,
a drop-in with `[Service]` and `Environment=HERDGATE_AGENT_LOOPBACK_PORT=8833`,
using the actual local port). Keep the public `HERDGATE_URL`, the existing room
and the device scope. Only enable this when the Gate is on the same machine.
Restart that Mobile publisher alone in a maintenance window and verify its
journal reports `cloud hello: … via loopback 127.0.0.1:…`. Reconnect Mobile
and test the existing entry. Remove the drop-in setting and restart the same
publisher to roll back. This does not change the public WSS leg on the VPS,
the SSH host key, or the Herdr server.

## Measure Mobile latency

For a local baseline with an isolated Herdr 0.9.5 server, pane, Gate and TCP
edge (no live rooms or keys), run:

```sh
TEST_HERDR_BIN="$(command -v herdr)" node scripts/bench-mobile-tui.mjs 25
```

Compare native Herdr, the Core adapter over local pipes, and the full Mobile
transport over loopback. The script reports key-to-ANSI, Send-to-ACK and
Send-to-ANSI separately; attach is measured separately from steady-state
input. This does not include cellular RTT or the official app's rendering.
An observe/read-only TUI attachment instead polls every 1.25 seconds; its
refresh interval is not comparable to the native interactive stream.

## Keep the Gate running

Use the packaged [systemd unit or Compose](templates/cloud/README.md) on Linux.
For a foreground source/npm install, set a persistent state file and use
`HERDGATE_ACCOUNT_TOKEN_FILE` instead of storing the token in a unit, plist, or
shell history. Run the reverse proxy or tunnel separately.

## Migrate the Linux TUI publisher

On the host, use Node 22+ and run as the user who owns the running Herdr TUI
and the systemd user unit. Verify publisher/remote access before starting and
pick a window when a short remote disconnection is acceptable:

```sh
systemctl --user is-active herdgate-home-tui.service
herdr status server --json
npx --yes @bom0792/herdgate@latest migrate
npx --yes @bom0792/herdgate@latest status
```

For a new host with no previous publisher unit, use `herdgate setup` after
pairing instead. Migration only adopts the known legacy Herdgate home unit.
It stages the publisher under `${XDG_DATA_HOME:-$HOME/.local/share}/herdgate/home-tui/releases`,
reuses the existing room config, and checks for a Gate hello from the new
systemd invocation. If the new publisher cannot connect, it attempts to
restore the previous service. It does not stop or update the Herdr server.
If Herdr's executable or socket is not at the default path, pass
`HERDR_BIN_PATH` and/or `HERDR_SOCKET_PATH` when running setup or update.

After success, reconnect from the remote Herdr TUI and confirm the existing
session is reachable. If migration fails, check
`journalctl --user -u herdgate-home-tui.service` locally; do not re-pair or
share tokens or keys. Use `herdgate update` for later main-publisher updates.

### Upgrade boundaries

- The publisher CLI updates the main TUI service only. It does not deploy
  the Gate, web/PWA, Cloudflare tunnel, VPS TCP edge, or independent Mobile
  read/control services. Maintain and verify those separately.
- Herdr Mobile Core, Mobile TUI read and Mobile TUI control are different
  targets. Preserve the room, SSH key and scope of each entry. Do not turn a
  read device into an interactive device just to resolve a connection issue.
- If several phone entries use the same public IP and a new one cannot
  connect, close unused entries and retry. Check the TCP edge logs before
  attributing the failure to the connection limits.

## Operational notes

- Preserve the Gate state and SSH host key in protected backups. Deleting
  state loses room/device registrations; replacing the host key invalidates
  clients' pins.
- **Keep a copy off the machine.** `node scripts/gate-push.mjs push --to <user@host>
  --path <dir>` ships the newest `gate-backup` archive as an AES-256-GCM blob and
  verifies the remote sha256; `auto` reads `~/.config/herdgate/backup-remote.json`
  and is a no-op until that file exists (the `herdgate-gate-push.timer` pattern).
  Run `export-key` once and store the base64 key in a password manager — the remote
  only ever holds ciphertext, so the key is the only way back.
- **Rotate the account token** by replacing the private token file (or old token environment value) and restarting the Gate. Update browsers that use the owner token.
- **Logs** go to stderr (agent connect/pair events). Payloads are never logged — keep it that way.
- **Watch the exposure**: `curl -s https://host/healthz` public; everything else needs tokens.
