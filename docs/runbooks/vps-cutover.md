# Runbook — chuyển gate lên VPS (Pha B)

> **Chưa chạy lần nào.** Mỗi bước có lệnh kiểm riêng; không đi tiếp khi kiểm của bước trước chưa
> xanh. Mục tiêu: giữ nguyên origin `https://gate.phuongnb.io.vn` và host key → điện thoại, laptop
> không phải ghim lại gì. Nền: `docs/plans/vps-cutover.md`, `templates/cloud/README.md` (mục
> *Back up, upgrade or migrate*), `docs/runbooks/gate-migration.md` (gate tại máy nhà).

## 0. Điều kiện trước (thiếu một là dừng)

- [ ] VPS ở VN, Ubuntu/Debian, root bằng ssh key, `node` ≥ 22 tại `/usr/bin/node`.
- [ ] Gate nhà đã đẩy off-site về chính VPS này (`backup-remote.json` → `backup@vps`):
      `gate-push push` xanh, `gate-push check` liệt kê đúng bản. VPS phải làm **courier** trước
      khi làm gate — đó là đường đưa state lên VPS, không copy plaintext qua ssh.
- [ ] Key backup (`export-key`, in một lần 24/11) và owner token (đang trong unit systemd trên
      máy nhà) đã nằm trong password manager.
- [ ] Artifact `dist/0.13.3/herdgate-cloud-0.13.3.tar.gz`, `sha256sum -c SHA256SUMS` xanh.

## 1. Chuẩn bị VPS (DNS chưa đụng — gate nhà vẫn phục vụ)

```sh
sudo mkdir -p /opt/herdgate-cloud /etc/herdgate
sudo tar -xzf herdgate-cloud-0.13.3.tar.gz -C /opt && cd /opt/herdgate-cloud-0.13.3
sudo npm ci --omit=dev --omit=optional --ignore-scripts && sudo node scripts/patch-ssh2.mjs
printf '%s\n' 'HERDGATE_PUBLIC_HOST=gate.phuongnb.io.vn' 'HERDGATE_PUBLIC_URL=https://gate.phuongnb.io.vn' \
  'HERDGATE_SSH_PORT=2222' 'HERDGATE_TRUSTED_PROXY=1' 'HERDGATE_REAL_IP_HEADER=X-Forwarded-For' \
  'HERDGATE_ENABLE_PUSH=1' | sudo install -m 0600 /dev/stdin /etc/herdgate/cloud.env
install -m 0600 owner-token.txt /etc/herdgate/owner-token          # token từ password manager
sudo install -m 0644 herdgate-cloud.service /etc/systemd/system/ && sudo systemctl daemon-reload
printf 'gate.phuongnb.io.vn {\n  reverse_proxy 127.0.0.1:8787\n}\n' | sudo install -m 0644 /dev/stdin /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
# Firewall: 22 (key-only), 80, 443. KHÔNG mở 2222 — SSH leg của điện thoại/laptop đi qua /v1/ssh/ws trên 443.
```

**Kiểm**: `sudo systemctl start herdgate-cloud` → `journalctl -u herdgate-cloud` có `listening`
(state **tạm** mới sinh, sẽ bị thay ở mục 3) → `sudo systemctl stop herdgate-cloud`.
Caddy chưa có chứng chỉ cho tới khi DNS trỏ về — bước đó ở mục 3c.

## 2. Đưa key backup lên VPS và tập giải mã (gate nhà vẫn chạy)

```sh
mkdir -p ~/.config/herdgate && printf '%s' '<base64 từ export-key>' | base64 -d > ~/.config/herdgate/backup.key && chmod 600 ~/.config/herdgate/backup.key
B=$(ls -1 /srv/herdgate-backup/*.enc | tail -1)
node /opt/herdgate-cloud-0.13.3/scripts/gate-push.mjs decrypt --in "$B" --out /tmp/restore
ls /tmp/restore    # state.json ssh_host_ed25519.json vapid.json attachments/ pi-receipts/ tasks/
```

Bản này chỉ để tập; bản thật dùng ở mục 3b.

## 3. Cắt (không bao giờ hai gate cùng một state)

**3a — máy nhà: dừng gate, chốt bản cuối.**

```sh
systemctl --user stop herdgate.service
systemctl --user start herdgate-gate-backup.service && node ~/apps/herdgate-gate/herdgate-cloud-0.13.3/scripts/gate-push.mjs push
#    → ghi lại tên file .enc + sha256 in ra. KHÔNG start lại herdgate.service.
```

**3b — VPS: khôi phục bản cuối vào state dir của unit.** Lặp lệnh `decrypt` mục 2 với file mới,
rồi:

```sh
sudo systemctl start herdgate-cloud && sudo systemctl stop herdgate-cloud    # tạo /var/lib/herdgate-cloud
sudo find /tmp/restore -mindepth 1 -exec cp -a {} /var/lib/herdgate-cloud/ \; && rm -rf /tmp/restore
sudo systemctl start herdgate-cloud
```

Không cần `chown` tay: với `DynamicUser=yes`, `StateDirectory=` được systemd chown **đệ quy** sang
user động mỗi lần start (man systemd.exec, `StateDirectory=`). Gate tự đọc `ssh_host_ed25519.json`
và `vapid.json` nằm cạnh `state.json` (mặc định của `src/cloud/main.ts`).

**3c — kiểm trên VPS, trước khi đụng DNS:**

```sh
journalctl -u herdgate-cloud | grep -E 'listening|minted|cannot|rror'
sudo -u root jq -r .public /var/lib/herdgate-cloud/ssh_host_ed25519.json | ssh-keygen -lf /dev/stdin
curl -fsS -H 'Host: gate.phuongnb.io.vn' http://127.0.0.1:8787/healthz
```

- KHÔNG được có `minted` (mint = state chưa vào, fleet sẽ phải ghim lại key) hay `cannot load`.
- Fingerprint phải là `SHA256:OCMQlBohVZ/XnGDde8SiDlJcLrd3V6aQ3LbcsUuaqII`. Sai → dừng.
- healthz 200. 421 = sai `Host` (đúng thiết kế fail-closed).

**3d — đổi DNS + chuyển publisher (thao tác tay, trong cửa sổ quan sát):**

1. Hoàn tác A/B tunnel nếu đang chạy: `~/.local/state/herdgate/tunnel-ab/revert.sh` (để tunnel
   về đúng trạng thái baseline khi lùi).
2. Cloudflare: đặt TTL bản ghi `gate` = 300, chờ 1 TTL; rồi **DNS only** (grey cloud)
   A `gate.phuongnb.io.vn` → IP VPS; xoá AAAA nếu có. Caddy tự xin chứng chỉ khi có traffic.
3. Máy nhà: publisher đang đi loopback `127.0.0.1:8833` tới gate nhà (đã dừng) → gỡ
   `HERDGATE_AGENT_LOOPBACK_PORT` khỏi `~/.config/herdr-app/herdgate/config/herdgate.env` **và**
   drop-in `~/.config/systemd/user/herdgate-mobile-tui-control.service.d/*.conf`; rồi
   `systemctl --user daemon-reload && systemctl --user restart herdgate-home-tui.service herdgate-mobile-tui-control.service`.
   Laptop không đổi gì (đã đi public URL).
4. `herdgate-tunnel.service` trên máy nhà **giữ nguyên đang chạy** = đường lùi 5 phút.

**Kiểm**: `journalctl -u herdgate-cloud -f` thấy 3 publisher nhà nối lại; PWA + Herdr TUI trên
điện thoại mở được; laptop `herdgate status` xanh. Đo lại `probe/bench.mjs` từ repo: kỳ vọng
healthz từ 0,37–2,66 s → vài chục ms. Không đẹp hơn thì **đo lại rồi mới kết luận**.

## 4. Sau cutover

- Off-site cho gate VPS: `backup-remote.json` trên VPS trỏ về host thứ ba (hoặc tài khoản
  `backup` trên máy nhà — chỉ nhận ciphertext) + hai timer 04:30/04:45 như máy nhà; drill
  `decrypt` như Pha A.
- Gate nhà thành **cold standby**: giữ `~/apps/herdgate-gate/herdgate-cloud-0.13.3/` + các bản
  `gate-…` trong `~/.local/state/herdgate/backups/`; **không** `enable` lại `herdgate.service`.
- Dọn: bản ghi DDNS `ssh.phuongnb.io.vn` (đã retired).

## 5. Lùi (flip-back) — 5 phút

1. VPS: `sudo systemctl stop herdgate-cloud`; chốt bản cuối từ VPS (backup + `gate-push` về máy
   nhà hoặc copy bản mã hóa rõ ràng); **không** start lại.
2. Máy nhà: giải mã bản cuối đó vào `~/.local/state/herdgate/` (cách mục 2, cùng key), rồi
   `systemctl --user start herdgate.service`. Không có bản cuối thì state nhà là state tại thời
   điểm 3a — mọi thay đổi trong lúc VPS phục vụ (pair thiết bị mới, đổi key) **mất**.
3. DNS: bật lại **Proxied** (orange cloud) → tunnel cũ phục vụ ngay.
4. Máy nhà: đặt lại `HERDGATE_AGENT_LOOPBACK_PORT=8833` ở hai chỗ đã gỡ (3d.3), restart hai unit.
