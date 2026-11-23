# Spec C5 — THEME LỚN: Fleet control từ PWA (→ 0.10.0, KHÔNG release giữa chừng)

Ngày: 2026-11-23 · Vòng: DEV-LOOP C5 · Chính sách: 2b (release một lần khi trọn theme)

## Mục tiêu người dùng

Từ điện thoại (PWA, 4G/5G): **mở tab mới trên máy home, gõ lệnh vào terminal,
đóng tab mình mở** — không cần mở máy. Read vẫn an toàn mặc định; mọi can
thiệp cần device act.

## F1 — BUG: pane.focus thiếu act gate (rào trước khi xây)
- Hiện: device **read** gọi `pane.focus` được — kéo focus màn hình user (EoP
  nhẹ, can thiệp UI). Fix: requires-act như term.send.
- Test: read device → `requires-act`; act device → vẫn focus.

## F2 — Ops tab (act, ownership-map)
- `tab.create` (act): `label?` (charset `[A-Za-z0-9 _.-]{1,64}` — không ký tự
  điều khiển), tạo tab qua herdr api (`tab.create` → trả `{tabId, paneId}`),
  publisher ghi map `tabId → deviceId` vào state file (sống qua restart).
- `tab.close` (act): chỉ đóng tab **trong map và đúng chủ**; tab lạ → từ chối
  `not-yours`. Map tự dọn: đóng xong xoá entry; entry trỏ tab đã biến mất →
  bỏ qua khi list.
- Cap: map ≤ 64 entry (FIFO drop — chống phình).
- Test: act tạo → entry; close đúng chủ → đóng; close sai chủ/tab lạ → từ
  chối; restart publisher → map còn; cap.

## F3 — PWA terminal typing (act, opt-in mỗi session)
- Terminal panel: khi device act, hiện nút "Gõ" bật chế độ nhập; input chữ →
  `term.send` (cap 4096 host-side như mirror), Enter/Backspace → `term.keys`.
- KHÔNG predictive echo ở PWA (poll 1.6s — echo giả sẽ lag xấu); chữ hiện
  theo frame authoritative.
- Web rules cập nhật CÓ CHỦ ĐÍCH: allowlist op của client mở thêm
  `tab.create|tab.close|term.send|term.keys|pane.focus` (chỉ chạy khi device
  act — server gate); test vẫn liệt kê tường minh từng op, no innerHTML, token
  không vào URL giữ nguyên.

## F4 — PWA UI gộp
- Terminals list: nút "+ tab" (tab.create); tab do phone tạo (reply giữ trong
  sessionStorage) có chip "mở từ đây" + nút đóng (tab.close).
- Focus pane: chỉ khi act + xác nhận ("đưa pane này lên màn hình máy?").

## Nghiệm thu
- Suite xanh (thêm ~10 test: op gates, ownership, cap, PWA contract mới).
- Live (probe device, dọn sau): read bị chặn cả 3 op act; act tạo tab thật
  (kiểm pane.list tăng), gõ lệnh vào tab đó output đúng, đóng tab biến mất;
  publisher restart giữa chừng → map còn, tab.close vẫn đúng chủ.

## Milestones trong vòng (không release riêng)
M1: F1+F2 (ops + tests) · M2: F3+F4 (PWA) + web rules update · M3: live
verify trọn + **0.10.0** (version, tag, npm, laptop update một lần).
