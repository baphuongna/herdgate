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

On this machine, quick tunnels **register** successfully (cloudflared logs `Registered
tunnel connection`, edge hkg) but the edge answers **404** for the trycloudflare hostname
from both IPv4 and IPv6, minutes after registration — the data path is blocked somewhere
between this sandbox and Cloudflare, before our code is ever reached. If you see the same,
don't debug herdgate: use a named tunnel with your own zone (section B), which terminates
at your account and behaves predictably. The origin-side configuration is identical
(plain HTTP to loopback), which is what edge-sim proves locally.

### The SSH leg is not a Cloudflare-TCP leg

Phones speak plain SSH to `host:port`; Cloudflare Tunnel only carries TCP for clients
running `cloudflared access`, which the phone does not. So the SSH leg's reachability is
LAN / VPN / Tailscale to the machine running the gate (bind it with
`HERDGATE_SSH_BIND=0.0.0.0`), or hosting the gate on a VPS later. The HTTP/WSS surface
(PWA, pairing, publisher) is the part that goes through the tunnel.

## Keep it running

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
