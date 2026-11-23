# Spec C24 — SELF path qua `fileURLToPath` trên toàn shipped tree

Ngày: 2026-11-24 · Vòng: DEV-LOOP (C24, mục queued sau C23) · Chủ đề: fix
lớp bug F7 do critic C23 chỉ ra — shipped code tự spawn/dẫn đường tới chính
nó bằng `new URL(...).pathname`, hỏng trên Windows.

## Bối cảnh

- `plugin/loop/server/index.mjs` đã sửa đúng ở C23: `const SELF =
  fileURLToPath(import.meta.url)` — nhưng shipped tree còn **3 chỗ** dùng
  `.pathname` trên file-URL sinh từ `import.meta.url`:
  1. `plugin/server/index.mjs:267` — `serve()` spawn supervisor.
  2. `plugin/server/index.mjs:349` — `supervisorLoop()` spawn publisher.
  3. `plugin/mirror/server/index.mjs:338` — `selfDir` cho
     `streamCommandLine` (mirror khai `platforms` gồm `windows` → live-relevant).
- Trên Windows `.pathname` luôn sai (`file:///C:/x` → `/C:/x`, `%20` không
  decode); publisher laptop hôm nay chạy được chỉ vì may mắn đường dẫn
  không có ký tự cần encode và node chưa đụng nhánh này từ đường dẫn đó.
- `fileURLToPath` đã import sẵn ở `plugin/server/index.mjs` (dòng 547 dùng
  đúng); `git-safe.mjs` cũng đã đúng — đây là nốt sót, không phải pattern mới.

## Tính năng

1. `plugin/server/index.mjs`: thêm `const SELF = fileURLToPath(import.meta.url);`
   (khai báo module-level, cạnh các const khác, comment nhắc F7/Windows như
   loop đã làm); cả 2 lệnh spawn dùng `[SELF, "serve"]`.
2. `plugin/mirror/server/index.mjs`: import `fileURLToPath` (node:url) +
   `dirname` (node:path); `selfDir = dirname(fileURLToPath(import.meta.url))`.

## Không làm

- KHÔNG thêm `"windows"` vào `platforms` của host manifest (`plugin/herdr-plugin.toml`)
  — quyết định sản phẩm của owner, không phải vòng này.
- KHÔNG đổi shape POSIX của `streamCommandLine` (command mirror pane là
  việc riêng IF mirror-windows trở thành thực tế quan sát được.
- KHÔNG đụng các test file đang dùng `.pathname` cho đường dẫn repo của chính
  test (chỉ chạy trên máy POSIX của suite; shipped tree mới là hợp đồng).

## Test (đỏ trước) — `test/self-path.test.ts`

- **T1 (tripwire, bất biến bền)**: quét mọi `plugin/**/*.mjs`, không dòng
  code nào khớp `new URL(...).pathname` (comment "file-URL .pathname" của
  loop không khớp regex). Fail → in file + dòng. Bắt hồi quy cho CẢ shipped
  tree, không chỉ 3 chỗ nay.
- **T2 (hành vi, đỏ thật trên POSIX)**: copy `plugin/server` vào tmp dir tên
  có dấu cách (`with space x`) + symlink `node_modules`; fake gate loopback
  (harness kiểu `publisher-watchdog.test.ts`); chạy
  `node "<spaced>/index.mjs" serve`; chờ supervisor pid alive + hello ≥1
  trong 15s. Với bug: spawn arg chứa `%20` → module không tải được → đỏ.
  Fix 1 trong 2 chỗ vẫn đỏ (chỗ còn lại giết supervisor hoặc publisher).

## Nghiệm thu (đo được)

1. T1 + T2 đỏ đúng chỗ trước khi implement; targeted xanh sau.
2. Full suite xanh tuyệt đối (baseline 398/0).
3. Dọn: pid kill + marker stop + tmp rm + gate close (PORT FREE không cần
   đếm — gate dùng port 0 ngẫu nhiên).
4. Live verify laptop = owner (backlog ghi rõ "owner verify laptop"); vòng
   này không đụng service/pane nào của user.

## Rủi ro

- T2 đỏ bằng timeout 15s (chờ hello không tới) — chấp nhận, có diagnostic
  log đường dẫn spawn trong assertion message.
- Copy `plugin/server` (~vài trăm KB) + symlink node_modules: chỉ đọc, không
  đụng repo thật; tmp dọn trong `finally`.
