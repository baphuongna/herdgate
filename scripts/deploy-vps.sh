#!/usr/bin/env bash
# herdgate → VPS: dựng gateway trực tiếp trên VPS (không Cloudflare tunnel).
# Dùng:  bash scripts/deploy-vps.sh root@<VPS-IP>
# Yêu cầu bên VPS : Ubuntu/Debian, root (qua key herdgate_deploy), port 80/443/2299 mở.
# Yêu cầu bên DNS : gate. + ssh. trỏ A → VPS (mây xám) — làm TRƯỚC khi chạy để Caddy xin cert được.
set -euo pipefail
TARGET="${1:?dùng: deploy-vps.sh root@<vps-ip>}"
KEY="$HOME/.ssh/herdgate_deploy"
DIR=$(cd "$(dirname "$0")/.." && pwd)

echo "==> 1/5 sync source + node_modules + state"
rsync -az --delete -e "ssh -i $KEY" \
  --exclude .git --exclude test --exclude app-mod --exclude plugin/herdr-plugin.toml \
  "$DIR/src" "$DIR/package.json" "$DIR/tsconfig.json" "$DIR/node_modules" "$TARGET:/opt/herdgate/"
rsync -az -e "ssh -i $KEY" "$HOME/.local/state/herdgate/" "$TARGET:/opt/herdgate-state/"

echo "==> 2/5 node 22 (nvm, per-root) + systemd herdgate"
ssh -i "$KEY" "$TARGET" 'set -e
  if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
    . ~/.nvm/nvm.sh
    nvm install 22 --silent
  fi
  NODE=$(command -v node)
  mkdir -p ~/.config/systemd/user 2>/dev/null || true
  cat > /etc/systemd/system/herdgate.service <<EOF2
[Unit]
Description=herdgate gateway (cloud relay hub)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$NODE /opt/herdgate/src/cloud/main.ts
Environment=HERDGATE_BIND=127.0.0.1
Environment=HERDGATE_PORT=8833
Environment=HERDGATE_STATE=/opt/herdgate-state/state.json
Environment=HERDGATE_SSH_PORT=2299
Environment=HERDGATE_SSH_BIND=0.0.0.0
Environment=HERDGATE_ACCOUNT_TOKEN=__TOKEN__
WorkingDirectory=/opt/herdgate
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF2
'

echo "==> 3/5 chèn account token từ unit nhà (base64 qua đường, khỏi sợ ký tự đặc biệt)"
TOKEN=$(grep -oP 'HERDGATE_ACCOUNT_TOKEN=\K.*' ~/.config/systemd/user/herdgate.service | tr -d '"')
TOKEN_B64=$(printf %s "$TOKEN" | base64 -w0)
ssh -i "$KEY" "$TARGET" "python3 -c \"import base64; tok=base64.b64decode('$TOKEN_B64').decode(); p=open('/etc/systemd/system/herdgate.service').read().replace('__TOKEN__',tok); open('/etc/systemd/system/herdgate.service','w').write(p)\""

echo "==> 4/5 caddy (TLS tự động) + firewall"
ssh -i "$KEY" "$TARGET" 'set -e
  if ! command -v caddy >/dev/null; then
    apt-get update -qq && apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<EOF2
gate.phuongnb.io.vn {
    reverse_proxy 127.0.0.1:8833
}
EOF2
  systemctl enable --now caddy >/dev/null 2>&1 || systemctl restart caddy
  command -v ufw >/dev/null && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 2299/tcp comment herdgate-ssh || true
'

echo "==> 5/5 start herdgate"
ssh -i "$KEY" "$TARGET" 'systemctl daemon-reload && systemctl enable --now herdgate && sleep 3 && systemctl is-active herdgate'

echo "OK — kiểm tra: curl https://gate.phuongnb.io.vn/healthz (sau khi DNS đã trỏ)"
