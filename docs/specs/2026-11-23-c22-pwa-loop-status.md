# Spec C22 — PWA hiển thị `loop.status`: dòng trạng thái dev-loop cạnh worker

Ngày: 2026-11-23 · Vòng: DEV-LOOP (kick 16:15:42Z sau wave C17–C21) · Chủ đề:
mục C22 queued — C21 để ngở (op đã có, chưa ai nhìn thấy từ phone).

## Bối cảnh

- C21 shipped op `loop.status` (read-only, capped) trả `{ ok, pane:{id,alive:null},
  status, paused, pausedBy, cycles, lastNudgeAt, logTail }` — nhưng chỉ reachable
  qua client tự viết; PWA chưa gửi op và chưa render gì.
- Owner quan sát loop hiện tại phải `tail -f` trên máy (C21 spec). C22 đóng nốt:
  một dòng muted trong worker box — đúng chỗ owner đã nhìn "queue 0 waiting"
  (worker health) — nói loop đang thế nào.
- Gate thật phục vụ app.js từ source dir, `no-store` (static.ts) ⇒ không cần
  restart gate để điện thoại nhận code mới (chỉ reload PWA).

## Tính năng

1. **Gửi**: `askHealth` (refresh + mở details + lần update đầu) giờ gửi CẢ HAI
   `{op:"worker.health"}` và `{op:"loop.status"}` — cùng lane device-ws sẵn có,
   read scope, không verb ssh mới (mobile native không đụng).
2. **Nhận**: reply `payload.op === "loop.status"` → `state.worker.loop =
   payload.loop` → `updateWorker(true)`.
3. **Render**: 1 dòng `p.muted.small` NGAY SAU dòng health trong worker box:
   - `ok !== true` → `dev-loop: unknown (no loop state on this host)` — trung
     thực với host không có loop (mọi máy chưa link plugin).
   - `ok` → `dev-loop: <status> [· paused[ by <pausedBy>]] [· <cycles> cycles]
     [· nudge HH:MM:SSZ]` (lastNudgeAt epoch → giờ UTC, giống nhịp operator đọc
     loop.log).
   - host offline / chưa trả → dòng trống (health line đã nói offline).

## Không làm

- KHÔNG auto-refresh/polling mới — tần suất hỏi giữ nguyên của worker box
  (mở details / refresh).
- KHÔNG render logTail (màn hình phone nhỏ; log là việc của máy, không phải
  status line) — giữ payload nhỏ ngay cả khi op trả sẵn.
- KHÔNG verb ssh cho mobile native, KHÔNG op mới — chỉ dùng op C21.

## Test (đỏ trước)

- `test/web.test.ts` allowlist: thêm `"loop.status"` vào danh sách op client
  được gửi (đỏ tới khi app.js thực sự gửi).
- Test mới (source-pattern, kiểu roster-line C6/C13/C16): reply handler
  `loop.status`, đọc `payload.loop`, chữ `dev-loop: `, render `lastNudgeAt` +
  `pausedBy`.

## Nghiệm thu (đo được)

1. Đỏ đúng chỗ → xanh; full suite xanh tuyệt đối (baseline 358/0).
2. Live: gate thật (8833) trả `/app.js` có code `loop.status` mới — chứng minh
   điện thoại nhận được sau reload, không restart gì (static no-store đọc từ
   disk mỗi request). Op path đã có e2e thật của C21 trong suite.

## Rủi ro

- Thêm 1 send mỗi lần askHealth: 2 op/thay vì 1 — cả hai read-only, reply nhỏ
  (loop.status ≤ ~4KB với tail 20 dòng) — chấp nhận được trên wire 256KiB cap.
- Host bản cũ (chưa C21) trả `unknown` op error? — bridge cũ không biết op sẽ
  fail-closed trả error; app phải nuốt im lặng (dòng trống), không toast/blank.
