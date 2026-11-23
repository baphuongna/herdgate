# Spec C11f — Gate state hygiene: boot dọn tmp mồ côi của atomic write

Ngày: 2026-11-23 · Vòng: DEV-LOOP (nudge #8) · Chủ đề: micro — bằng chứng
sản phẩm thật trên máy nhà

## Lý do (bằng chứng)

`~/.local/state/herdgate/state.json.tmp-joutxcyr5h` — Nov 20 23:28, 3
ngày tuổi — mồ côi thật của `State#save()` (stores.ts: write tmp →
rename; kill giữa hai dòng ⇒ tmp stranded vĩnh viễn, không code nào
dọn). Vô hại về dữ liệu (rename là atomic, state.json chính luôn nguyên
vẹn) nhưng là rác tích luỹ theo từng lần crash — và khiến các lần
backup/restore kế nhìn thấy "state.json.tmp-..." lạ trong thư mục.

## Thiết kế

- `State` constructor (khi có path): sau `#load()`, quét cùng thư mục
  các file khớp đúng `<basename>.tmp-*` (đúng pattern mình sinh ra,
  prefix tuyệt đối) và xoá. An toàn vì: README templates/cloud cấm 2
  process dùng chung state dir (single-instance) — tmp còn sống của
  process khác không tồn tại trong topology hợp lệ; tmp của chính process
  cũ chết giữa chừng chính là rác cần dọn.
- Không đụng file không khớp pattern (`.tmp2-`, tên khác).

## Nghiệm thu (đo được)

1. Unit: state.json + tmp mồ côi + file lạ → construct State → tmp
   mất, state nạp đúng, file lạ nguyên.
2. Unit: chỉ có tmp (mất state.json — crash trước rename đầu tiên) →
   tmp vẫn được dọn.
3. Unit: không path (in-memory) → không đụng fs.
4. Full suite xanh tuyệt đối.
5. Live (scratch, không đụng gate thật): scratch state + tmp mồ côi gieo
   tay → boot gate source scratch → tmp biến mất sau khi gate nạp state.
   File thật trên máy nhà để nguyên cho lần restart kế của gate thật
   chứng minh (restart là của owner).

## Kế hoạch test

- Mới `test/gate-state-hygiene.test.ts` (import `State` từ
  src/cloud/stores.ts trực tiếp — lớp chưa có test unit riêng).

## Rủi ro

- Xoá nhầm tmp của process đang sống: chỉ khả thi trong topology bị
  cấm (2 gate 1 state dir); pattern prefix chặt + single-instance doc
  đủ. Chấp nhận.
