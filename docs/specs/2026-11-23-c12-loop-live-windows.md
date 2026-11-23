# Spec C12 — Loop sống trên Windows: probe thật qua event thật + fix separator under-home

Ngày: 2026-11-23 · Vòng: DEV-LOOP · Chủ đề: khép theme "loop on Windows"
began C11 — phần còn lại của backlog C12.

## Lý do chọn theme (bằng chứng, đầu vòng)

- C12 là mục 🔄 duy nhất: "Giao 0.12.0 cho laptop + loop sống trên Windows…
  probe loop thật maxCycles=1 qua event thật", điều kiện "chọn khi mở".
- **Laptop TUI đang mở** (pane list qua machine lane trả về thật, pane focus
  w8:p2 đang sống).
- **Phần "giao 0.12.0" đã do owner tự làm**: gate room `PhuongNB-Laptop-TUI`
  hostInfo version **0.12.0**, hello 09:23:53Z hôm nay — không update lại,
  chỉ verify trên máy (release id, supervised, boot.mjs trong release dir).
- **Bug thật lộ ra khi soạn probe** (đọc code, dòng 66 index.mjs):
  `c.cwd.startsWith(home + "/")` — separator cứng. Trên Windows
  `homedir()` = `C:\Users\x`, mọi cwd dưới home dạng `C:\Users\x\proj`
  fail `startsWith("C:\Users\x/")` ⇒ **config bị từ chối; cách duy nhất
  chạy được trên Windows hôm nay là cwd == đúng home**. Loop "chạy trên
  Windows" (C11, v0.12.0) thực chất chưa dùng được với bất kỳ cwd thật nào
  của owner (D:\… bị chặn đúng thiết kế under-home; C:\Users\x\… bị chặn
  vì separator). Probe 0.12.0 chạy được bằng cwd == home; fix cho bản kế.

## Đổi code repo (SDD)

**Fix 1 dòng语义**: under-home check chấp nhận separator của nền tảng —
chấp nhận cả `/` lẫn `\` sau home (node trên Windows nhận cả hai dạng;
trên Linux `\` chỉ xảy ra nếu owner tự đặt tên file như vậy — vô hại).
Test trước (red): sandbox HOME + thư mục con có tên CHỨA backslash thật
(`mkdir "<home>\proj"` — tên file hợp lệ trên Linux) → 0.12.0 từ chối,
bản fix chấp nhận. Kèm test chặn đúng: cwd ngoài home vẫn bị từ chối.

## Probe sống trên laptop (không đụng tài sản owner)

Nguyên tắc C11b: mọi lệnh trong MỘT tab tự mở nhãn `c12probe` trong
workspace đang focus; diff pane.list trước/sau; không gõ pane có sẵn.

1. Snapshot pane.list (before).
2. Tab `c12probe` → `herdgate status` (dry-run: đọc release id + version +
   supervised) → `where.exe pi`, `where.exe node` (điều kiện sống của probe).
3. Verify release dir có `plugin\loop\server\boot.mjs` (Test-Path).
4. `herdr plugin link <release>\plugin\loop` (lane chính thống; plugin id
   `dev.herdgate.loop` chưa từng link trên laptop).
5. Viết probe config vào plugin CONFIG_DIR của laptop (`herdr plugin
   config-dir dev.herdgate.loop`): label `c12probe`, promptFile + cwd dưới
   `C:\Users\phuongnb` (**cwd == home** — workaround bug separator, ghi
   trung thực), maxCycles 1, cooldownMs 10000, nudgeText marker probe.
6. `herdr plugin action dev.herdgate.loop start` (trong tab mình) → pane
   loop sinh ra trong workspace `⚙ c12probe` riêng (không đụng workspace
   owner) → pi boot qua boot.mjs shell-free → trả lời marker cycle 1 →
   settle → **event thật của herdr trên Windows** nudge #1 → agent trả lời
   marker nudge → settle → `maxCycles 1 reached — done` (đọc loop.log trên
   máy + `plugin action … status`).
7. Dọn: `plugin action … stop` (đóng workspace `⚙ c12probe`), unlink
   plugin, xoá probe config/prompt, đóng tab c12probe, diff pane.list
   (after == before).

## Nghiệm thu (đo được)

1. Test mới đỏ trên 0.12.0, xanh sau fix; full suite xanh tuyệt đối.
2. Laptop verify: release 0.12.0 thật trên máy (status), boot.mjs tồn tại.
3. Probe: loop.log trên laptop có `start → armed → nudge #1 rc=ok →
   maxCycles 1 reached — done`; dấu vết pi trả lời thật trên pane (marker
   C12-PROBE); không nudge #2.
4. Dọn sạch: plugin unlinked, probe config/prompt xoá, workspace `⚙
   c12probe` đóng, pane.list diff chỉ thiếu tab mình tạo.
5. Nếu pi/node thiếu trên laptop hoặc gate từ chối: ghi trung thực phần
   chưa đạt thành nợ, không flo glitch.

## Rủi ro

- pi trên laptop có thể thiếu PATH → probe die ở boot; khi đó vòng còn
  lại fix + verify + nợ "cài pi" (việc owner) — vẫn là một vòng trung thực.
- Plugin event hook mỗi event một process node — nếu node không trên PATH
  của herdr service, event chain chết âm thầm (fail-closed đúng thiết kế);
  `where.exe node` đo trước.
- Owner đang dùng máy: tab sinh ra ở workspace focus — nhãn rõ, tự đóng,
  mọi lệnh chỉ trong tab/panes mình sở hữu.

## Không bump version

Theo 2b: fix 1 dòng + probe là phần khép của theme loop-windows-boot đã
release 0.12.0; fix lên bản kế do owner publish (READY-TO-RELEASE note nếu
đủ giá trị).
