# Kế hoạch VPS cutover — xử lý sau (ghi 22/11/2026)

**Vấn đề**: gate chạy từ source trên máy nhà = điểm đơn. Máy nhà chết → mất tất cả (phone, laptop, TUI thứ 3).

**Nguyên tắc đã chốt**: gate chạy thẳng trên VPS (KHÔNG phải VPS làm edge/proxy về nhà).
Noise E2E → VPS chỉ thấy ciphertext; độ tin yêu cầu thấp.

## Pha A — diễn tập + runbook (làm trên máy nhà, không cần VPS)
- [x] Dựng gate thứ 2 (port + state dir riêng) từ Cloud archive — 24/11: `herdgate-cloud-0.13.3.tar.gz`,
      smoke trên state tạm, rồi boot từ bản khôi phục (port 18789)
- [ ] Publisher test trỏ vào → probe toàn ops (view/ssh bridge/receipts/pair)
- [x] Runbook migration: backup → **đi qua đường off-site** (mã hóa, "VPS" là thư mục local, remote
      sha256 khớp) → `gate-push decrypt` → byte-identical 120 file → start → verify: host key =
      production (`SHA256:OCMQlB…`, fleet không ghim lại), 5 room / 13 device (24/11)
- [x] Cron backup state hàng ngày — `herdgate-gate-backup.timer` 04:30 + bản mã hóa off-site `herdgate-gate-push.timer` 04:45 (`scripts/gate-push.mjs`, 24/11)
- [x] Runbook Pha B: `docs/runbooks/vps-cutover.md`

## Pha B — cutover (cần user: root key, deploy key, DNS)

Lý do đo được 24/11: mọi kết nối mới đang đi vòng Cloudflare SIN (hairpin), 0.4–2.7 s chỉ để thiết lập,
~10 RTT/hành động — xem `docs/research/2026-11-24-connectivity/ANALYSIS.md`. VPS trong nước = thay đổi kích cỡ duy nhất.
- [ ] VPS: Node 22 + Cloud archive (templates/cloud: compose hoặc systemd + Caddy)
- [ ] Restore snapshot; GIỮ NGUYÊN hostname gate.phuongnb.io.vn (chỉ flip DNS, hạ TTL trước)
- [ ] ssh leg: herdgate-tcp-edge template; ssh host key giữ nguyên → phone không config lại
- [ ] Publishers tự reconnect (cùng hostname) — không đụng config nhà/laptop
- [ ] Gate nhà → cold standby (code + snapshot, stopped; runbook flip-back 5 phút)

## Pha C — tùy chọn: standby ấm (VPS #2 rsync state). Với hệ 1 người dùng: cold standby đủ.

## Ma trận rủi ro sau cutover
| Sự cố | Hệ thống | Hồi phục |
|---|---|---|
| Nhà chết | chỉ mất home panes | — |
| VPS chết | flip DNS về nhà + start | ~5 phút |
| Cả hai | restore từ backup archive | ~30 phút |

Ghi chú vận hành hôm nay: herdr remote client BỎ CUỘC sau 5 lần retry (upstream) —
restart gate phải báo/reconnect tay các client remote.
