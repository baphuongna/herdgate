# Runbook — Gate migration & backup (Pha A của docs/plans/vps-cutover.md)

> Áp dụng cho gate trên máy nhà (`herdgate.service`). Từ 24/11/2026 gate **không còn chạy từ
> source**: nó chạy bản release ghim (`~/apps/herdgate-gate/herdgate-cloud-0.13.3/`) qua drop-in
> `~/.config/systemd/user/herdgate.service.d/pin.conf`; hai publisher máy nhà cũng ghim
> (`~/apps/herdgate-release/v0.13.3/`, drop-in `pin.conf` trong `.d/` của từng unit). Mọi
> đường dẫn `~/source/herdgate/...` dưới đây là vị trí *của mã nguồn*, dùng để đọc/tra cứu —
> tiến trình đang chạy không đọc từ đó.
> Mọi lệnh chạy trên máy nhà. KHÔNG chạy cutover (Pha B) khi chưa có
> root key + deploy key + quyền DNS — đó là việc của chủ sở hữu.

## Hằng số

- Gate: `~/apps/herdgate-gate/herdgate-cloud-0.13.3/runtime/cloud/main.js` (drop-in pin),
  port 8833, bind 127.0.0.1 (sau cloudflared `gate.phuongnb.io.vn`); bản trước còn trên đĩa
  (`herdgate-cloud-0.13.2/`) để rollback 30 s.
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

Đã chứng minh sống 2026-11-23 (Cycle Log C11d) bằng gate từ source;
ngày cùng hôm đã diễn tập TIẾP với **artifact đúng hình deploy** (compiled
runtime + `npm ci --omit=dev` + `patch-ssh2.mjs`, đúng README templates/
cloud) restore state THẬT: 5/5 rooms device+hostInfo khớp gate thật,
PWA serve 200 (Cycle Log C11e). Tóm tắt các bước:

```bash
# 2.1 Backup + verify bản vừa tạo (mục 1).
# 2.2 Dựng artifact (giữ nguyên thứ tự — build-release cloud stage):
#   npm run build:cloud -- --outDir <cloud>/runtime
#   cp src/web/{index.html,app.js,app.css,app.webmanifest,sw.js,e2e.js,push-decision.js} <cloud>/runtime/web/
#   cp src/web/icons/* <cloud>/runtime/web/icons/; cp scripts/patch-ssh2.mjs <cloud>/scripts/
#   cp package-lock.json <cloud>/; viết <cloud>/package.json như build-release.sh
#   cd <cloud> && npm ci --omit=dev --omit=optional --ignore-scripts && node scripts/patch-ssh2.mjs
# ⚠️ Archive KHÔNG bundle node_modules: thiếu npm ci là crash ngay cửa
#   (ERR_MODULE_NOT_FOUND: ws) — đã từng bắt trong diễn tập C11e.
# 2.3 Restore state scratch + boot (port khác, NO_SSH, NO_PUSH; token qua env)
# 2.4 Verify: /healthz; /v1/devices TỪNG room khớp gate thật; PWA HTML 200.
# 2.5 Dọn: kill gate scratch, rm scratch.

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

- Diễn tập với tarball phát hành thật (giải nén `herdgate-cloud-<ver>.tar.gz`
  thay vì dựng tay cloud stage) — C11d/C11e phủ source và compiled stage,
  tarball-packing được cloud-release.test canh.
- Pha C standby ấm — plan chốt cold standby đủ cho hệ 1 người dùng.
