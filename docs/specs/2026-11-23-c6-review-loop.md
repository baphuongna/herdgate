# Spec C6 — Review loop trọn vòng: biết khi agent xử lý xong (theme, KHÔNG bump riêng)

Ngày: 2026-11-23 · Vòng: DEV-LOOP C6

## Khoảng trống (đã khảo sát code)

- `worker.submitted` (chat/job thường) → PWA đăng ký `receipt.watch {wantBody}` →
  settle push về + wake push khi app đóng — vòng kín TỐT.
- `review.sent` (gửi review comments) → PWA chỉ hiện "đã gửi" rồi quên —
  **không watch**, agent xử lý xong phone không hay biết, phải tự mở Jobs.
- Hạ tầng host đã đủ: settle push + wake theo subscriber (index.mjs ~500),
  không cần đổi host.

## Thiết kế

### M1 — PWA subscribe khi gửi review
- Handler `review.sent`: ngoài `r.sent`, set job vào `state.worker.jobs`
  (status "queued", principal device) + `sendPayload({op:"receipt.watch",
  id, wantBody:true})` — dùng đúng đường render Jobs/Chat sẵn có.
- `state.worker.review.linkedJob = {id, status}` — `workerJobTouched` cập
  nhật trạng thái này khi receipt.push/watched về đúng jobId.

### M2 — Review tab hiện vòng đời
- Sau gửi: chip "⏳ agent đang xử lý (job xxxxxxxx)" — thay "đã gửi" tĩnh.
- Khi trạng thái cuối về (replied/failed/canceled): chip "✓ agent đã xử lý —
  xem trong Jobs/Chat" + nút chuyển tab Jobs.
- Refusal đã có sẵn giữ nguyên.

### Nghiệm thu
- Source contract (web.test.ts): review.sent handler gọi receipt.watch;
  linkedJob marker; chip render theo trạng thái.
- e2e host đã phủ (review-ops) — không đổi host.
- Live trung thực: gate nhà đang tắt HERDGATE_PI_WORKER → live chỉ chứng
  minh fence `pi_worker_disabled` đúng; vòng đầy đủ xác minh bằng harness
  (đã có trong pi-worker/review tests). Ghi rõ trong Cycle Log.

## Vì sao không release riêng
Theme nhỏ, thuần client — theo chính sách 2b nằm chờ theme lớn kế tiếp
(hoặc user gọi release).
