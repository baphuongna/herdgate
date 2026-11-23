# Spec C11e — Cutover rehearsal: state thật × artifact thật

Ngày: 2026-11-23 · Vòng: DEV-LOOP (nudge #5) · Chủ đề: khép gap cuối của
Pha A VPS plan mà dev-loop làm được

## Lý do chọn theme (bằng chứng)

- C11d chứng minh restore sống ở tầng API nhưng bằng **gate từ source**
  (source→source). VPS sẽ chạy **Cloud archive** (JS compiled theo
  templates/cloud — dạng deploy thật).
- `test/cloud-release.test.ts` đã phủ artifact với state **tổng hợp**
  (5 dòng state sạch) — không phủ **state sản phẩm thật** tích luỹ qua
  0.9.35→0.11.0 (5 rooms, 15+ devices, receipts, attachments, vapid,
  host key thật): đúng lớp rủi ro schema-drift của cutover.
- Owner chưa publish (npm latest 0.11.0) — nợ kia vẫn không trả được;
  đây là việc chuẩn bị cutover giá trị cao nhất còn lại trong lane
  dev-loop.

## Thiết kế

1. Build artifact đúng hình deploy: `npm run build:cloud -- --outDir
   <scratch>/runtime` (cùng lệnh build-release.sh dùng) — không cần
   pack tarball, runtime compiled là nội dung archive.
2. Restore bản backup C11d mới nhất (`backups/_latest`) vào scratch
   state dir (đã verify sha256 ở C11d).
3. Boot artifact với env scratch: port 8899, NO_SSH, NO_PUSH, token
   từ systemd (không in), `HERDGATE_STATE` = scratch state.
4. Verify:
   - `/healthz` = ok;
   - `/v1/devices` cho CẢ 5 rooms thật — số device + hostInfo khớp
     gate thật (đọc từ gate thật cùng lúc, cùng token);
   - PWA được serve (`/` trả HTML có app manifest).
5. Dọn: stop, xoá scratch, xác nhận gate thật không đụng.
6. Song song (bắt cơ hội flake C11d): một full suite với **full log**
   capture ra file — nếu fail, log giữ nguyên cho vòng sau/pha này.

## Nghiệm thu (đo được)

1. Artifact compiled boot với state thật; `/healthz` ok.
2. Đếm device 5/5 rooms khớp gate thật (diff từng room).
3. PWA HTML serve từ artifact.
4. Gate thật 8833 nguyên vẹn trước/sau (healthz 200 với Host đúng).
5. Flake: nếu suite bắt được fail → có full log (kết quả ghi trung thực
   dù bắt được hay không).
6. Không đổi code repo (dự kiến); nếu lộ bug artifact/state → chuyển
   SDD fix ngay trong lượt nếu còn giờ, không che.

## Rủi ro

- Build:cloud cần devDeps (tsc) — máy nhà có (repo đang develop).
- State thật có thể chứa thứ artifact từ chối (đúng cái cần phát
  hiện!) — nếu xảy ra: đó là FINDING, ghi runbook + Cycle Log, không
  "sửa state cho chạy".
- Thời gian: suite + rehearsal chạy song song, tổng ≤ 25 phút.
