# Deploying herdgate publicly (cloudflared, this machine)

The cloud binds `127.0.0.1` and is published through a Cloudflare tunnel. Two shapes:

## A. Quick tunnel (no DNS setup, throwaway URL)

```sh
# terminal 1 — the cloud
cd /home/bom/source/herdgate
export HERDGATE_ACCOUNT_TOKEN=$(openssl rand -base64 32)
export HERDGATE_STATE=$HOME/.herdgate/state.json
npm start

# terminal 2 — a trycloudflare URL (random, changes every run)
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the printed `https://<random>.trycloudflare.com` as the public URL. Nothing to configure; fine for testing.

## B. Named tunnel + your domain (stable hostname)

```sh
cloudflared tunnel login                     # once, picks a zone
cloudflared tunnel create herdgate
cloudflared tunnel route dns herdgate herd.example.com

cat > ~/.cloudflared/herdgate.yml <<'YML'
tunnel: herdgate
credentials-file: /home/bom/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: herd.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
YML

cloudflared tunnel run --config ~/.cloudflared/herdgate.yml
```

Then start the cloud with the hostname pinned:

```sh
export HERDGATE_ACCOUNT_TOKEN=$(openssl rand -base64 32)
export HERDGATE_STATE=$HOME/.herdgate/state.json
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

HERDGATE_PUBLIC_HOST=gate.local HERDGATE_SSH_PORT=0 npm start          # terminal 1
HERDGATE_TARGET_PORT=8787 HERDGATE_PINNED_HOST=gate.local \
  HERDGATE_EDGE_CERT=/tmp/edge-cert.pem HERDGATE_EDGE_KEY=/tmp/edge-key.pem \
  npm run edge                                                          # terminal 2
# → https://127.0.0.1:<port>  (trust the cert or pass --ignore-certificate-errors)
```

Verified by `test/edge.test.ts` and a full headless-Chrome run: sign in → `online` →
machine online → pair read → live Herdr view + SSH hint, all over TLS with both wss legs
through the splice.

### A note on `trycloudflare.com` quick tunnels

On this machine, quick tunnels **register** but the edge answers **404** for the
trycloudflare hostname from both IPv4 and IPv6 — the free-for-all hostname space is
blocked somewhere between this machine and Cloudflare. **Named tunnels on your own zone
do not have this problem**: `gate.phuongnb.io.vn` (tunnel `herdgate`, id `dfc578ef`) is
live — PWA + CSP through the edge, owner + host wss legs through the edge, pairing and
the live Herdr view all verified in headless Chrome with the real Cloudflare cert (no
`--ignore-certificate-errors`). The live recipe on this machine:

```sh
cloudflared tunnel create herdgate
cloudflared tunnel route dns -f <tunnel-uuid> gate.phuongnb.io.vn   # -f overwrites; the
    # bare form once logged the WRONG tunnel id (fell back to config.yml) — always pass
    # the UUID and check the log line says your tunnel id
# ~/.cloudflared/herdgate.yml  →  ingress gate.phuongnb.io.vn → http://127.0.0.1:8833
HERDGATE_PUBLIC_HOST=gate.phuongnb.io.vn HERDGATE_PORT=8833 HERDGATE_SSH_PORT=2299 npm start
cloudflared --config ~/.cloudflared/herdgate.yml tunnel run herdgate
```

Gotchas hit along the way: port 8787 was already taken by the hermes webui (the old
`config.yml` routes `hermes.phuongnb.io.vn` there — an ingress clash would silently serve
the wrong app through our hostname), and running the gateway script without `&` in a
shell helper blocks forever. Local `curl http://127.0.0.1:8833/` returns **421** by
design — the gateway pins `Host: gate.phuongnb.io.vn`; that is the pinning contract
working, not a bug.

### The SSH leg is not a Cloudflare-TCP leg — three ways in

Phones speak plain SSH to `host:port`; Cloudflare Tunnel only carries TCP for clients
running `cloudflared access`, which the phone does not. Reachability options, in order
of setup cost:

1. **LAN / same network** — `HERDGATE_SSH_BIND=0.0.0.0`, phones dial the machine.
2. **IPv6 AAAA** (this machine's setup) — a DNS-only `AAAA` record to the gate
   machine's global IPv6; `~/.local/bin/herdgate-ssh-ddns` + the `herdgate-ddns`
   timer keep it current (needs a Cloudflare API token + `ufw allow`).
3. **The SSH bridge (v0.9.0)** — a front door on ANY host with an open port (a tiny
   VPS is enough), when the gate machine itself has none:

```sh
# on the VPS (Node ≥ 22, one file, no dependencies):
node ssh-bridge.ts   # env: HERDGATE_URL, HERDGATE_BRIDGE_TOKEN (the account token),
                     #      HERDGATE_BRIDGE_BIND/PORT (default 0.0.0.0:2299),
                     #      HERDGATE_BRIDGE_PUBLIC_HOST/PORT — advertise what phones dial
```

The bridge dials the cloud over an OUTBOUND WebSocket and pipes raw SSH bytes both
ways; the cloud feeds them into its sshd through ssh2's `injectSocket`. Device-key
auth, act-scope enforcement, the read-only allowlist and brute-force strikes all stay
in the cloud — the bridge carries no secrets, which is why its credential is the
account (owner) token. While a bridge with an advertised address is connected, the
device hello's `ssh {host, port}` points phones at it; disconnect it and the hello
falls back to the gate's own address. Verified end to end through the real Cloudflare
tunnel: pair over wss → SSH the bridge → `hello` (32 methods), `server.status`, and
`terminal.send` refused with the act-scope error.

The HTTP/WSS surface (PWA, pairing, publisher) goes through the tunnel as always.

## Keep it running

On this machine (Linux + systemd) a user unit keeps the gate up; the tunnel is a second unit:

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/herdgate.service <<'UNIT'
[Unit]
Description=herdgate cloud relay hub
After=network-online.target

[Service]
ExecStart=/home/bom/.nvm/versions/node/v22.23.1/bin/node /home/bom/source/herdgate/src/cloud/main.ts
Environment=HERDGATE_ACCOUNT_TOKEN=change-me
Environment=HERDGATE_PUBLIC_HOST=gate.phuongnb.io.vn
Environment=HERDGATE_PORT=8833
Environment=HERDGATE_STATE=/home/bom/.local/state/herdgate/state.json
WorkingDirectory=/home/bom/source/herdgate
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload && systemctl --user enable --now herdgate
# tunnel:  cloudflared --config ~/.cloudflared/herdgate.yml tunnel run herdgate
#   (a second unit wrapping that line, same shape)
```

Other platforms:

```sh
# launchd agent sketch (adjust paths); or use tmux/systemd-in-wsl as you prefer
cat > ~/Library/LaunchAgents/dev.herdgate.cloud.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.herdgate.cloud</string>
  <key>ProgramArguments</key><array>
    <string>/Users/bom/.nvm/versions/node/v22.23.1/bin/node</string>
    <string>/home/bom/source/herdgate/src/cloud/main.ts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>HERDGATE_ACCOUNT_TOKEN</key><string>…</string>
    <key>HERDGATE_STATE</key><string>/Users/bom/.herdgate/state.json</string>
    <key>HERDGATE_PUBLIC_HOST</key><string>herd.example.com</string>
    <key>HERDGATE_PUBLIC_URL</key><string>https://herd.example.com</string>
  </dict>
</dict></plist>
PLIST
launchctl load ~/Library/LaunchAgents/dev.herdgate.cloud.plist
```

(The plist above is a sketch — fill the token, keep `node` on your PATH or use the absolute binary.)

## Operational notes

- **Back up nothing but rotate everything**: state.json can be deleted; re-pair hosts and devices (minutes).
- **Rotate the account token** by restarting with a new `HERDGATE_ACCOUNT_TOKEN` (devices must update it).
- **Logs** go to stderr (agent connect/pair events). Payloads are never logged — keep it that way.
- **Watch the exposure**: `curl -s https://host/healthz` public; everything else needs tokens.
