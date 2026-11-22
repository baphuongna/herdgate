# Kế hoạch VPS cutover — xử lý sau (ghi 22/11/2026)

**Vấn đề**: gate chạy từ source trên máy nhà = điểm đơn. Máy nhà chết → mất tất cả (phone, laptop, TUI thứ 3).

**Nguyên tắc đã chốt**: gate chạy thẳng trên VPS (KHÔNG phải VPS làm edge/proxy về nhà).
Noise E2E → VPS chỉ thấy ciphertext; độ tin yêu cầu thấp.

## Pha A — diễn tập + runbook (làm trên máy nhà, không cần VPS)
- [ ] Dựng gate thứ 2 (port + state dir riêng) từ Cloud archive 0.9.38
- [ ] Publisher test trỏ vào → probe toàn ops (view/ssh bridge/receipts/pair)
- [ ] Runbook migration: stop → flush journal → backup (state.json + ssh_host_ed25519.json
      + vapid.json + attachments/ + pi-receipts/) → restore → start → verify
- [ ] Cron backup state hàng ngày (hiện chỉ có 1 bản thủ công backup-pre-0.9.35)

## Pha B — cutover (cần user: root key, deploy key, DNS)
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
