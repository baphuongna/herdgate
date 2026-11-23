# Runbook — Gate migration & backup (Pha A của docs/plans/vps-cutover.md)

> Áp dụng cho gate chạy từ source trên máy nhà (`herdgate.service`).
> Mọi lệnh chạy trên máy nhà. KHÔNG chạy cutover (Pha B) khi chưa có
> root key + deploy key + quyền DNS — đó là việc của chủ sở hữu.

## Hằng số

- Source gate: `~/source/herdgate/src/cloud/main.ts`, port 8833,
  bind 127.0.0.1 (sau cloudflared `gate.phuongnb.io.vn`).
- State dir: `~/.local/state/herdgate/` — `state.json`,
  `ssh_host_ed25519.json` (host key — MẤT LÀ MẤT CẢ FLEET: mọi phone/
  laptop phải re-pair), `vapid.json` (push identity), `attachments/`,
  `pi-receipts/`, `tasks/`.
- Account token: nằm trong env của `herdgate.service`
  (`systemctl --user show herdgate.service -p Environment`). KHÔNG in
  ra log/shell history nếu tránh được.

## 1. Backup hằng ngày (chưa tự động — owner cài timer)

```bash
node ~/source/herdgate/scripts/gate-backup.mjs            # mặc định: state thật, ~/.local/state/herdgate/backups, keep 14
node ~/source/herdgate/scripts/gate-backup.mjs --verify \
  ~/.local/state/herdgate/backups/$(cat ~/.local/state/herdgate/backups/_latest)
```

Timer template (owner tự cài — loop không đụng systemd của user):

```ini
# ~/.config/systemd/user/herdgate-gate-backup.service
[Unit]
Description=herdgate gate state backup
[Service]
Type=oneshot
ExecStart=/home/bom/.nvm/versions/node/v22.23.1/bin/node /home/bom/source/herdgate/scripts/gate-backup.mjs

# ~/.config/systemd/user/herdgate-gate-backup.timer
[Unit]
Description=herdgate gate state backup daily
[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
[Install]
WantedBy=timers.target
# systemctl --user daemon-reload && systemctl --user enable --now herdgate-gate-backup.timer
```

⚠️ Archive chứa host key riêng tư (0600). KHÔNG đẩy `backups/` lên
bất kỳ cloud công cộng nào; rsync về máy của owner nếu cần offsite.

## 2. Diễn tập restore (sandbox — không đụng gate thật)

Đã chứng minh sống 2026-11-23 (Cycle Log C11d). Tóm tắt:

```bash
# 2.1 Backup + verify bản vừa tạo (mục 1).
# 2.2 Restore vào scratch
mkdir -p ~/.cache/gate-drill && cd ~/.cache/gate-drill
cp -r ~/.local/state/herdgate/backups/$(cat ~/.local/state/herdgate/backups/_latest)/state.json .
# 2.3 Gate scratch: port khác, NO_SSH, NO_PUSH, state scratch; token qua env
TOKEN=$(systemctl --user show herdgate.service -p Environment --value \
  | grep -oP 'HERDGATE_ACCOUNT_TOKEN=\K[^ ]+' )   # không echo
HERDGATE_PORT=8899 HERDGATE_BIND=127.0.0.1 HERDGATE_NO_SSH=1 HERDGATE_NO_PUSH=1 \
HERDGATE_STATE=$PWD/state.json HERDGATE_ACCOUNT_TOKEN="$TOKEN" \
  node ~/source/herdgate/src/cloud/main.ts &   # log stderr
# 2.4 Verify
curl -s http://127.0.0.1:8899/healthz
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8899/v1/devices?room=<room-id>' | jq '.devices | length'
# 2.5 Dọn: kill gate scratch, rm -rf ~/.cache/gate-drill
```

## 3. Cutover thật (Pha B — CHỦ SỞ HỮU)

1. Hạ TTL DNS `gate.phuongnb.io.vn` trước ≥1h.
2. Backup + verify (mục 1) — bản này là bản mang đi.
3. `systemctl --user stop herdgate.service` (publishers tự retry;
   **herdr remote client BỎ CUỘC sau 5 lần retry — upstream** — restart
   gate xong phải reconnect tay các client remote, plan ghi chú
   2026-11-23).
4. Flush journal nếu cần giữ log: `journalctl --user -u herdgate.service`.
5. VPS: Node 22 + restore snapshot (giữ nguyên hostname, ssh host key,
   vapid) + systemd/Caddy theo templates/cloud.
6. Flip DNS → publishers tự reconnect về cùng hostname; phone không
   config lại (host key giữ nguyên).
7. Verify: `/healthz`, `/v1/devices` từng room, một publisher hello,
   một op view từ phone.
8. Gate nhà → cold standby: giữ code + snapshot cuối, stopped.
   Runbook flip-back: DNS về nhà + `systemctl --user start herdgate.service` (~5 phút).

## Chưa phủ (nợ owner)

- Leg "Cloud archive 0.9.38 → 0.11.0" của Pha A (diễn tập với đúng
  bản npm sẽ chạy trên VPS) — diễn tập C11d dùng source→source.
- Pha C standby ấm — plan chốt cold standby đủ cho hệ 1 người dùng.
