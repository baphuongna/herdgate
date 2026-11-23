# Spec C11 — Loop boot path Windows: thoát khỏi POSIX-only

Ngày: 2026-11-23 · Vòng: DEV-LOOP C11 · Chủ đề: làm cho claim `windows`
trong manifest loop là sự thật

## Lý do chọn theme (bằng chứng)

- `plugin/loop/herdr-plugin.toml` khai `platforms = ["linux", "macos",
  "windows"]`, nhưng boot duy nhất của plugin là
  `cd {cwd} && pi "$(cat {promptFile})"\r` (`index.mjs`, cmdStart) —
  **POSIX-only**: `$(cat …)` là bash-ism; `cd` không đổi drive trên cmd.exe;
  laptop của chính chủ (Windows + herdr, sẽ update theme 0.11.0 có kèm
  plugin này) hỏng ngay lần `start` đầu tiên — pane gõ vào cmd/PowerShell
  một lệnh không chạy được, loop chết ở tick 0.
- Theme C9-C11 ("loop như tính năng shipped") chưa trọn khi tính năng
  claim chạy trên nền tảng mà nó không boot nổi.

## Khảo sát (đã làm trên máy này)

- **Shell pane trên Windows không đoán được từ phía linux**: herdr dùng
  portable-pty; config `[terminal] default_shell` chỉ ghi fallback POSIX
  ("$SHELL, then /bin/sh"); chuỗi trong binary hé lộ `cmd.exe /d /c` cho
  custom key commands và `pwsh` cho agent-detection — không có một câu
  trả lời dứt khoát cho pane shell mặc định. Kết luận thiết kế: **default
  phải chạy được ở CẢ cmd.exe lẫn PowerShell**, và phải có van thoát cho
  chủ máy (bootCommand) thay vì đặt cược vào một shell.
- **Pipe stdin không phải lối ra**: pi docs — stdin/stdout redirect ⇒ tự
  chọn print-mode và exit; loop cần pi interactive trong pane (nudge gõ
  tiếp vào TUI sống). Nên `type f | pi` loại.
- **`pi @file` tự boot một turn**: thử thật trên máy này
  (`pi -p @/tmp/hg-c11-atfile.md` → model đọc file, trả lời đúng chuỗi
  marker). @file là **một argument đường dẫn** — không cần command
  substitution, không syntax shell nào — cmd.exe, PowerShell, POSIX sh
  đều truyền được y hệt nhau nếu để trong ngoặc kép (`pi "@…"`: ngoặc
  kép vô hiệu splatting `@` của PowerShell, vô hại với cmd/sh).
- **`cd` là phần không di động** (cmd cần `/d`, PowerShell từ chối `/d`) —
  nhưng API herdr `tab.create` có sẵn `cwd` (`TabCreateParams` trong
  schema protocol 22, herdr 0.9.5 trên máy này) ⇒ pane sinh ra ĐÚNG chỗ,
  không cần gõ `cd` nữa.

## Thiết kế

1. **cwd chuyển từ "gõ text" sang "tham số tạo tab"**: `tab.create` nhận
   thêm `cwd: cfg.cwd`. Boot text không còn `cd … && `.
2. **Một default chung cho mọi nền tảng**: `pi "{promptFile}"` (đường
   dẫn tuyệt đối, ngoặc kép, prefix `@`). Không phân nhánh platform —
   chuỗi này không chứa cấu trúc shell nào để mà khác nhau.
3. **`bootCommand` trong loop.json (van thoát chủ máy)**: nếu có, thay
   default hoàn toàn. Template `{cwd}`/`{promptFile}` được thay từ config.
   Validate fail-closed: string, 1–500 ký tự, không `\r`/`\n` (Enter do
   plugin tự thêm). Không ép chứa placeholder — chủ máy có quyền boot
   agent khác/cách khác; typo placeholder sẽ hiện trong pane (quan sát
   được, không âm thầm).
4. Logic boot tách module thuần `plugin/loop/server/boot.mjs`
   (validate + build) để unit-test từng trường hợp mà không phải spawn
   process; `index.mjs` import tương đối (giữ self-contained).
5. `status` expose `config.boot` (text boot đã resolves, không \r) —
  chủ máy Windows tự soi được chính xác cái sẽ được gõ vào pane.
6. Manifest loop: `min_herdr_version` 0.9.0 → **0.9.5** — dependency cwd
  của tab.create được xác nhận ở 0.9.5; khai thật thay vì nhờ may mắn
  ở bản cũ hơn.

## Nghiệm thu (đo được)

1. Unit (boot.mjs): default build đúng chuỗi `pi "<promptFile>"`;
   bootCommand thay placeholder `{cwd}`/`{promptFile}`; bootCommand sai
   (không string/độ dài >500/chứa \r hoặc \n) ⇒ lỗi validate rõ ràng.
2. Unit (CLI qua stub bridge): `start` gửi `tab.create` CÓ `cwd`; text
   gõ vào pane đúng default mới, kết thúc `\r`; state/tab/pane như cũ
   (không hồi quy lifecycle); `status` in `config.boot`.
3. Unit: loop đang chạy trên máy thật (state kiểu cũ) không bị ảnh
   hưởng — boot chỉ đọc lúc `start`.
4. Full suite xanh tuyệt đối (baseline 333/0 + test mới).
5. **Live probe trên máy home** (herdr 0.9.5 thật, bridge thật, pi thật;
   config/state scratch, workspace `⚙ c11probe`, KHÔNG đụng state loop
   dev-loop thật): `start` ⇒ pane sinh ra với cwd đúng hồ scratch (kiểm
   tra pane cwd qua bridge), pi TUI thật boot với prompt @file (đọc
   output pane thấy TUI/trả lời), `stop` đóng workspace sạch. Nếu gate
   từ chối (rate/điều kiện lạ) — bỏ live, ghi chú trung thực.
6. Không claim gì về Windows-on-metal trong Cycle Log ngoài "default
   được thiết kế + đơn giản hóa cho cmd & PowerShell; chờ owner verify
   trên laptop" (2b: verify đá tại lần publish/laptop online).

## Kế hoạch test

- Mới `test/loop-boot.test.ts`: boot.mjs thuần (default, override, sai
  từng loại, Enter append).
- Sửa `test/loop-plugin.test.ts`: test start hiện có cập nhật kỳ vọng
  (tab.create có cwd; text mới); thêm case bootCommand override qua CLI;
  status có boot.
- Live probe: script bash env scratch như C10 (HERDR_PLUGIN_CONFIG_DIR/
  STATE_DIR riêng), đo bằng calls trong loop.log probe + pane.read.

## Rủi ro

- herdr cũ hơn 0.9.5 bỏ qua `cwd` của tab.create ⇒ pi boot ở cwd mặc
  định (vẫn đúng prompt vì đường dẫn tuyệt đối) — giảm thiểu bằng
  min_herdr_version 0.9.5; chấp nhận vì mọi máy thật đang ≥ 0.9.5.
- `pi @file` trong TUI tương tác khác print-mode về chi tiết (throttle
  gõ ký tự) — live probe ở bước 5 phủ đúng đường TUI thật.
- Đổi boot text làm lần auto-start kế của dev-loop home dùng template
  mới — probe (bước 5) chính là chứng minh chạy-được cho template đó TRƯỚC khi
  lần auto-start kế của dev-loop home dùng nó.
