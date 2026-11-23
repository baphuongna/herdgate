# Spec C16 — Presence cho mobile native leg: trục "seen" (lastSeen)

Ngày: 2026-11-23 · Vòng: DEV-LOOP · Chủ đề: mục C16 queued trong backlog
(bằng chứng sống: commit `673a551`, owner xác nhận app vào được laptop).

## Bối cảnh (bằng chứng đo được trên gate thật, không phỏng đoán)

- Sau C14+C15 app mobile native (`d_0b441d88` "app mobile") **vào được laptop**
  (owner xác nhận trên app). Nhưng roster gate vẫn hiện `offline, legs []`.
- Journal gate 19:44–21:30 hôm nay: app mobile authenticate bằng publickey
  **theo pattern burst ngắn** — session 1–2 giây, chu kỳ ~17–20s; chỉ khi
  stream TUI actively mới giữ 21–45s (21:17:32→21:18:17). IP thật
  103.67.196.192 (carrier), leg = ssh, relay sang agent qua agent-ws.
- Hệ quả: `connected`/`legs` (C13) lấy mẫu "socket đang mở NGAY LÚC ĐÓ" —
  với pattern burst, thời điểm bất kỳ hầu như luôn `offline, legs []` dù app
  đang sống và dùng liên tục. Owner đọc "offline" = đúng cái C13 muốn tránh:
  một trục presence bị đọc thay cho trục khác. **Không phải bug C13** — ssh
  presence làm đúng nghĩa của nó; thiếu trục thứ ba.

## Thay đổi

1. **sshd báo "seen"**: mỗi authentication thành công (publickey đã verify
   signature / password đúng) → `SshDeps.onSeen(deviceId)` (optional, once
   per connection — ngay chỗ `bumpPresence`, sau verify, KHÔNG tính probe
   PK_OK không chữ ký). Backward-compatible với harness cũ.
2. **Gateway giữ `lastSeen`**: `deviceSeen: Map<deviceId, {at, leg}>`;
   cập nhật từ `onSeen` (leg "ssh") và từ device-ws hello + pair.granted
   (leg "web"). `/v1/device/revoke` dọn entry. Ephemeral trong RAM — restart
   gate mất là đúng (presence là hiện tại, không phải lịch sử).
3. **`/v1/devices` thêm `lastSeen: {at, leg} | null`** per device (additive;
   `connected`/`legs` giữ nguyên nghĩa "socket mở ngay bây giờ" — không nói
   dối, không linger/grace giả "connected").
4. **PWA roster**: dòng device khi không live nhưng có `lastSeen` in thêm
   `· last seen <leg> <ago>` (formatter s/m/h/d). Live thì `live(...)` vẫn
   là câu trả lời (lastSeen im lặng).

## Không làm (ranh giới)

- KHÔNG linger/grace cho `connected` — "vừa mới here" và "đang here" là hai
  câu khác nhau; gộp lại chính là lỗi đọc C13 lần 2.
- KHÔNG đụng `deviceViews` (room.update push cho agent) — host bridge không
  cần trục này; giữ blast radius tối thiểu.
- KHÔNG persist lastSeen vào state.json — presence không phải dữ liệu lâu dài.

## Test (đỏ trước)

- `test/ssh.test.ts` mới (mô phỏng đúng pattern burst của app mobile):
  pair device xong chưa từng nối → `lastSeen:null`; burst 1 (ssh auth thật,
  password) → `connected:true` + `lastSeen.leg:"ssh"`, `at` tươi (<15s);
  đóng → `connected:false, legs:[]` (đúng hình production than phiền) NHƯNG
  `lastSeen` còn tươi; burst 2 sau ~1s → `at` tăng (refresh mỗi lần thấy).
- `test/web.test.ts` mới (source-pattern): app.js render `lastSeen.at`, chữ
  "last seen", có formatter tuổi.

## Nghiệm thu (đo được)

1. Test đỏ đúng chỗ (lastSeen undefined / regex fail), xanh sau implement;
   full suite xanh tuyệt đối (baseline 356/0).
2. **Live verify tái hiện đúng pattern production**: gate scratch từ source
   (port 8899/2229, state tự sinh), device pair thật, 2 burst ssh thật
   (publickey) đóng lại như app mobile → `/v1/devices`: khi giữ `connected:true`;
   sau khi đóng `connected:false, legs:[]` + `lastSeen:{leg:"ssh",at:tươi}` —
   câu trả lời chân thật thay cho `offline` trống rỗng. Gate thật 8833 không đụng.

## Rủi ro

- Map `deviceSeen` tăng theo số device từng pair kể từ boot — bị chặn trên
  bởi số device trong state (pair là act-gated), revoke dọn; chấp nhận.
- Đồng hồ: Date.now() cả hai phía trong cùng process gate — không lệch.
- PWA fetch roster một lần khi mở details — "12s ago" đứng yên đến lần mở
  lại: chấp nhận (fetch lại là đủ), không thêm polling.
