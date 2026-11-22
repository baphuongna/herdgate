# Spec C1 — Operability Pack (→ v0.9.43)

Ngày: 2026-11-22 · Vòng: DEV-LOOP C1 · Trạng thái: implement

## Bối cảnh

Ba vết đứt vận hành đã gặp thật trong hai release gần nhất:

1. **EEXIST giữa update** (v0.9.41): `setup-tui` bị giết giữa chừng để lại
   `.setup` mồ côi; lần chạy sau chết ngay `mkdirSync` — phải dọn tay.
2. **Không biết máy nào chạy bản nào**: publisher gửi `info.version`
   **hard-code "0.9.38"** (`plugin/server/index.mjs`), gate bỏ qua `info`
   trong hello, PWA roster không hiển thị. Quản lý 2 máy qua room mà phải
   hỏi từng máy bằng drive script.
3. **Mirror watch phải gọi tay**: muốn mirror liên tục trên laptop thì mỗi
   lần mở Herdr phải chạy `watch`; herdr 0.9.5 có `[[startup]]` hook nhưng
   plugin chưa khai báo.

## Tính năng & tiêu chí nghiệm thu (đo được)

### F1 — setup-tui idempotent với `.setup` mồ côi
- Lock `.setup` tồn tại từ lần chạy trước bị giết (tuổi > 60s) → lần chạy
  mới **tự giành lại lock** (xóa + tạo lại) và hoàn tất bình thường.
- Lock tươi (< 60s — khả năng có process khác đang chạy) → báo lỗi rõ ràng
  (không âm thầm đè).
- Unit test 3 nhánh: fresh / stale / fresh-foreign. Export
  `acquireSetupLock` để test được; guard "chỉ chạy khi là main" để file vẫn
  là entry npm bin.

### F2 — publisher version thật + gate `hostInfo` + PWA roster
- Publisher hello gửi `info.version` đọc từ `package.json` shipped
  (repo và npm layout đều đúng đường dẫn `../../package.json`); hết chuỗi
  hard-code.
- Gate: hello host leg có `info` hợp lệ (`name`, `version` string ≤ 64) →
  lưu vào `RoomRecord.hostInfo` (kèm `at`); publisher cũ không gửi →
  trường vắng mặt, không break.
- `GET /v1/devices?room=` trả thêm `host: {name, version}` khi có.
- PWA roster (block "thiết bị của máy này") thêm dòng mờ
  `publisher <version>` trên danh sách khi có — không đụng luật web test
  (client vẫn chỉ op `view`; dữ liệu từ fetch `/v1/devices` sẵn có).
- Test: gate hello với/ không info; publisher helper trả đúng version
  package.json; VM PWA render dòng version.

### F3 — mirror `[[startup]]` one-shot, opt-in
- `plugin/mirror/herdr-plugin.toml` khai báo `[[startup]]` →
  `node server/index.mjs startup`.
- `startup`: đọc config; `autostart !== true` → exit 0 ngay (rẻ, im lặng);
  `autostart === true` → chạy đúng logic `watch --once` (reconcile một
  vòng rồi thoát — hook kiểu one-shot như bom.hosts; pane/tab do herdr
  sở hữu nên sống theo session herdr). Lỗi reconcile → log 1 dòng, vẫn
  exit 0 (không bao giờ chặn herdr khởi động).
- Lệnh mới `mirror autostart on|off` ghi `cfg.autostart` (yêu cầu đã
  pair); `status` hiển thị trường `autostart`; `--help` cập nhật.
- Test: autostart=false → không gọi herdr api nào; autostart=true → gọi
  đúng chuỗi reconcile (dựa stub `.mjs` đã có trong mirror-ops test).

## Thiết kế

- **F1**: tuổi lock đo bằng `statSync(lock).mtimeMs`; ngưỡng 60s đủ tách
  "crash cách đây mấy phút" khỏi "đang chạy song song thật" (update qua
  npm là một process duy nhất trên máy).
- **F2**: `hostInfo` nằm trên **RoomRecord** (mỗi room một publisher —
  đúng mô hình 1 host/room của gate), không đụng DeviceRecord. Wire:
  thêm ~40 bytes — không liên quan frame budget.
- **F3**: herdr chạy startup hook theo kiểu one-shot (tham chiếu bom.mjs
  `startup` — toast rồi thoát). Watch dài hạn vẫn là lệnh tay; startup
  chỉ "khôi phục presence" (workspace + tab). Tabs herdr tự sống chết
  theo session — không daemon mới.

## Kế hoạch test (viết trước, red → green)

1. `test/windows-node.test.ts`: acquireSetupLock 3 nhánh.
2. `test/devices.test.ts`: hello info → `/v1/devices` có `host.version`;
   hello không info → không có `host`; publisher cũ không break.
3. `test/plugin.test.ts` (hoặc file mới nhỏ): helper version publisher =
   version package.json.
4. `test/mirror-ops.test.ts`: startup off (0 call), on (reconcile once),
   autostart on/off lệnh.
5. `test/web.test.ts`: VM roster render `publisher <ver>`.

## Rủi ro & ứng phó

- Restart gate làm đứt WS ~2s → publisher tự reconnect (đã chứng minh).
- npm layout khác repo → đường dẫn package.json dùng URL-relative, test
  release-shape vẫn canh self-contained (không thêm import ngoài).
- `[[startup]]` trên herdr 0.9.5: bom.hosts đang dùng thật trên máy này —
  không phải guesswork.

## Rollout

Suite xanh → restart gate + home publisher (source) → verify
`/v1/devices` host.version trên 2 room → bump 0.9.43, tag, npm publish →
chờ flip → drive update laptop (pre-clean `.setup`, `HG_WAIT=75`) →
verify laptop host.version = 0.9.43 qua gate → dọn probe → Cycle Log.
