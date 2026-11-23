# Spec C11b — Giao v0.11.0 cho laptop + đòi nợ verify on-metal C8

Ngày: 2026-11-23 · Vòng: DEV-LOOP (nudge #1 của chuỗi dev-loop sau C11) ·
Chủ đề: phần đuôi của release v0.11.0 — cái mà Cycle Log đã hứa
"drive lại sau"

## Lý do chọn theme này (bằng chứng, hôm nay)

- Backlog **không còn mục queued**: C11 ✅ (vòng trước), C12 parked
  (không có nhu cầu quan sát mới), các dòng blocked không phải việc của
  loop. Vòng code thuần không có theme hợp lệ.
- **Nợ ghi rõ 2 lần trong Cycle Log**: v0.11.0 "update + verify on-metal
  chờ laptop online (chủ sở hữu mở máy hoặc drive lại sau)"; C8
  "Windows-on-metal verify đá tại lần owner publish theme" — owner đã
  publish (npm latest = 0.11.0) nhưng laptop vẫn **0.10.0**.
- **Laptop ĐANG online ngay lúc này** (bằng chứng dưới) — cửa sổ drive
  không tự mở mãi.

## Bằng chứng trạng thái (đo được, đầu vòng)

- Gate state (đọc local — gate chạy trên máy home): room
  `PhuongNB-Laptop-TUI` hostInfo version **0.10.0**, hello cuối
  09:22 sáng nay.
- `herdr machine list`: máy `laptop` (id 328f45bf…, target herdgate-laptop)
  saved, `herdr machine status` → **reachable**; `herdr --machine laptop
  status server` → running, herdr **0.9.5** (đúng bản Windows package yêu
  cầu), endpoint compatible.
- SSH edge từ máy này = device `d_39752695` ("laptop-tui", room
  Laptop-TUI, **scope act**) — controller hợp pháp do chủ sở hữu pair
  bằng `herdgate connect`.

## Thiết kế — drive không đụng tài sản user

Nguyên tắc: laptop là máy sống của owner (~40 workspace, D:\source\*,
paseo worktrees). **Không gõ vào pane có sẵn, không đóng tab có sẵn.**
Mọi lệnh chạy trong MỘT tab do mình mở, nhãn rõ ràng, tự đóng:

1. `herdr --machine laptop tab create --label c11update` → pane mới
   (flow tiền lệ của C5 — phone fleet control đã làm y hệt trên home).
2. **Dry-run lane**: gõ `herdgate status` đọc version hiện tại (kỳ vọng
   0.10.0) — chứng minh typing/reading lane sống trước khi đổi bản.
3. **Update thật**: gõ `herdgate update` (C1: lệnh đúng là `herdgate
   update`, không phải `setup update`). Chờ marker `"release"` (JSON
   kết quả của setup-tui update) bằng `pane wait-output --timeout
   180000`. Lock `.setup` tự reclaim nếu >60s (đã đọc code
   acquireSetupLock — pre-clean của C1 chỉ cần khi run trước chết <60s).
4. Đọc JSON kết quả (kỳ vọng `{"release":"0.11.0", … "state":
   "connected"}`).
5. **Verify gate-side**: gate state room Laptop-TUI hostInfo version
   flips 0.10.0 → 0.11.0 (hello reconnect).
6. **Verify C8 on-metal**: trong cùng tab, PowerShell đọc state dir của
   TUI publisher: `publisher-tui.supervisor.json` (heartbeat
   `{pid,pollMs,at}` fresh — at mới), `publisher-tui.log` (dấu vết
   babysitter: adopt/respawn/start của bản mới), lock tồn tại hợp lệ.
7. **Verify loop shipped-but-inert**: `Test-Path` release dir 0.11.0 có
   `plugin\loop\herdr-plugin.toml` (npm files) — KHÔNG start loop trên
   laptop (bản 0.11.0 chưa có fix boot Windows của C11 — chủ có publish
   bản kế mới được chạy loop ở đó).
8. Dọn: đóng tab c11update. Ghi Cycle Log.

## Nghiệm thu (đo được)

1. Tab c11update mở + đóng sạch; không pane/tab/workspace có sẵn của
   owner bị đụng (diff pane.list trước/sau: chỉ pane mình tạo biến mất).
2. `herdgate status` dry-run in version 0.10.0 (bằng chứng trước).
3. Update xong: JSON release 0.11.0, state connected; gate hostInfo
   = 0.11.0; heartbeat supervisor fresh; log có dòng của bản 0.11.0.
4. Nếu drive fail giữa chừng: laptop phải ở trạng thái dùng được (update
   flow tự rollback theo code đã đọc: triedStart fail → reinstall
   prior + restart). Ghi trung thực phần chưa đạt.

## Rủi ro

- Publisher restart làm PWA mất view laptop ~10-30s — thiết kế chấp
  nhận (watchdog adopt/respawn tồn tại để xử lý đúng kịch bản này).
- Bản 0.11.0 trên Windows chưa được verify từng inch — nếu watchdog
  báo động sai trên on-metal, đó chính là bằng chứng cần ghi lại thành
  backlog (nhiệm vụ của vòng verify là phát hiện, không phải che).
- Owner có thể đang gõ trên laptop: tab mới xuất hiện ở workspace
   đang focus — nhãn `c11update` + tự đóng; mọi lệnh chỉ chạy trong tab
   đó.

## Không có thay đổi code repo

Vòng này là delivery + verification. Nếu verification lộ bug → vòng đó
chuyển thành SDD fix (red → green) ngay trong lượt nếu còn giờ, không
che giấu.
