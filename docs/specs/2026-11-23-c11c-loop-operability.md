# Spec C11c — Loop operability: khởi động lại sạch + tài liệu nói sự thật

Ngày: 2026-11-23 · Vòng: DEV-LOOP (nudge #2 của chuỗi dev-loop sau C11) ·
Chủ đề: vận hành của chính chuỗi loop — nối theme C9–C11

## Lý do chọn theme (bằng chứng)

1. **Bug thật trong plugin/loop đã ship**: guard idempotent của `cmdStart`
   là `s.paneId && s.status === "running" && paneAlive(...)`. Khi loop
   **done** (maxCycles đạt) mà pane còn sống, `start` KHÔNG từ chối — nó
   tạo tab MỚI trong workspace cũ, ghi đè `paneId` trong state. Pane/pi
   cũ thành mồ côi: tab vẫn mở, events bị foreign-check nuốt, không ai
   sở hữu. Mỗi lần restart sau done = +1 tab rác trong `⚙ <label>`.
   (Kịch bản thật: owner cho loop chạy xong N vòng rồi `start` lại.)
2. **Tài liệu DEV-LOOP.md "Tự vận hành" nói sai thực tại**: mô tả
   `herdgate-devloopd.service` + driver script là cơ chế chạy — thực tế
   service đó `inactive/disabled`, chuỗi đang chạy bằng **plugin
   shipped** (state `~/.local/state/herdr/plugins/dev.herdgate.loop/`,
   nudge từ event hook). Mỗi vòng mới phải khảo cổ lại kiến trúc.
3. **Backlog trống 3 chuỗi liên tiếp** (C11b phải đi đòi nợ delivery,
   vòng này phải săn theme): thiếu giao thức xử lý "không có việc" —
   vòng sau sẽ săn theme mỏng thay vì no-op trung thực.

## Thiết kế

### D1 — start từ chối khi pane cũ còn sống (bất kể status)

Đổi guard thành: `s.paneId && paneAlive(s.paneId)` → `die(1)` với thông
điệp nêu status hiện tại và "stop first". Lý do chọn **từ chối** thay vì
tự đóng pane cũ: pane done chứa câu trả lời cuối của chuỗi — owner có
thể đang đọc; đóng hộ là phá tài sản người vận hành. stop (đóng cả
workspace) rồi start = một bảng sạch, đúng dòng "restart with the start
action" đã có cho chain-broke (pane chết ⇒ paneAlive false ⇒ vẫn start
được như cũ).

Chi phí bridge: guard mới gọi `pane.list` mọi khi state có paneId (cũ
chỉ gọi khi running) — một request ngắn, chấp nhận.

### D2 — DEV-LOOP.md "Tự vận hành" viết lại theo thực tại

Plugin chain là driver (start/stop/pause/resume actions, event hook
nudge, state/log paths); devloopd + driver script = đã retired (đo
`systemctl --user is-active herdgate-devloopd` = inactive, log dừng
03:47 sau PAUSE era); PAUSE flag chỉ còn ý nghĩa với driver cũ. Không
đụng `docs/DEV-LOOP/AUTO.md` (guardrail).

### D3 — Giao thức no-op khi backlog trống

Thêm vào Protocol: backlog hết mục 🔄/queued VÀ không nợ giao/nghiệm thu
nào trả được ngay ⇒ vòng **no-op ngắn**: quét nhanh log sống (loop,
gate, publisher) + 1 dòng Cycle Log `no-op — backlog trống`, KHÔNG săn
theme ép, KHÔNG pause loop của owner (việc dừng là của owner).

## Nghiệm thu (đo được)

1. Unit (stub bridge): state `{status:"done", paneId sống}` + `start` ⇒
   rc=1, thông điệp "stop", đúng 1 bridge call (pane.list), không
   tab.create.
2. Unit: state `{status:"chain-broke", paneId chết}` + `start` ⇒ chạy
   bình thường (không hồi quy đường restart chuỗi đứt).
3. Unit: state `{status:"running", paneId sống}` ⇒ vẫn từ chối như cũ
   (test idempotent hiện có phải xanh không sửa).
4. Full suite xanh tuyệt đối (baseline 338/0 + test mới).
5. Docs: DEV-LOOP.md không còn claim devloopd là driver; có đoạn no-op
   protocol; AUTO.md không bị đụng (git diff sạch với file đó).
6. Live: không cần probe mới — hành vi từ chối phủ bởi unit; chuỗi
   dev-loop thật đang chạy chính là regression test sống cho đường
   foreign/nudge (nudge vòng này đến từ event hook của bản đã sửa C11).

## Kế hoạch test

- `test/loop-plugin.test.ts`: thêm case done+alive (từ chối), case
  chain-broke+dead (chạy); test idempotent cũ giữ nguyên.
- Không test riêng cho docs (nội dung tĩnh, soi bằng review).

## Rủi ro

- Guard mới tốn thêm 1 pane.list mỗi start — không đáng kể (start là
  hành động hiếm).
- Thông điệp lỗi mới phải hướng dẫn đúng hành động (stop), nếu không
  owner bế tắc — nhắc rõ trong message.

## Không có thay đổi nào ngoài plugin/loop + docs DEV-LOOP
