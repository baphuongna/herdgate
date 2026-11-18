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
