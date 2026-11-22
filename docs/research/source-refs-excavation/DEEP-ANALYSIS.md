# DEEP-ANALYSIS — phần 5, 6, 7, 8 (bỏ 1–4, 9 theo quyết định)

Nguồn đã đọc: collie `push.ts` (154) + `push-decision.ts` (70) + `self-update.ts` (177) + sw.js herdgate (98) + vapid.ts (105) + gateway push (hiện trạng); herdr-reviewr README đầy đủ + cấu trúc src (app 2901, lib 2042, ui 1983, forge 1596, markdown 1268, git 1100, diff 776); herdr-file-viewer ARCHITECTURE.md toàn bộ (bảng 24 module + data flow + load-bearing decisions) + fuzzy.rs đầu; herdr-mirror README đầy đủ + cấu trúc src (mirror 1362, pane 974, daemon 793) + predict.rs đầu.

---

## PHẦN 5 — Push & self-update — ✅ DONE c5b8cdf+00b3076 (RFC 8291, decision table, VAPID rotation, x-hg-build hysteresis; gate nhà đã bật push)

### Kiến trúc gốc (collie)
- **push.ts**: máy trạng thái availability (`unsupported|insecure|server-off|denied|ready`) + preference per-device (`collie:push-disabled`); **keysMatch** — subscription bị buộc cứng với VAPID key sinh ra nó; khi bridge xoay keypair, mọi push về subscription cũ CHẾT IM LẶNG → detect lệch key → unsubscribe + subscribe lại. Server tự prune endpoint 410.
- **push-decision.ts**: logic quyết định THUẦN cho SW push handler (test được không cần SW): payload `{type:"clear"|…, title, body, tag, renotify, data:{paneId, session, target}}` → `clear` (rút thông báo, chạy kể cả khi app visible) | `suppress` (tab đang visible — in-app đã lộ) | `show` (thay thế slot theo `tag`, `renotify` khi có agent mới). Tag dùng chung `collie:herd` = coalesce cả đàn thành 1 slot.
- **self-update.ts**: bridge đóng dấu build id vào MỌI response (server-build header); client so với BUILD của bundle mình → stale. 3 lớp an toàn: **hysteresis** (2 poll liên tiếp mới hành động — deploy swap nguyên tử không tự reload), **once-per-build** (sessionStorage — không loop reload), **reload-hold** (đang có draft/upload/sheet → chỉ hiện banner "tap to update", tự cập nhật khi hold giải phóng). Hoạt động cả khi KHÔNG có SW (plain HTTP).

### Hiện trạng herdgate
- sw.js: push **payload-less silent ping** → nếu có window: postMessage wake; không có: notification chung chung "Có hoạt động mới" (tag herdgate-wake, renotify). gateway: `pendingWakes` dedup + cap 8.
- KHÔNG có: payload mã hóa, tag theo loại, clear/rút, suppress theo visibility, detect xoay VAPID (subscription chết âm thầm sau rotation), self-update banner (PWA chỉ network-first navigate).

### Thiết kế áp vào herdgate
1. **Giữ silent ping làm wake-channel** (triết lý E2E: push service không thấy gì) — NHĂNG CẤP nội dung notification bằng cách để SW fetch sau khi wake? KHÔNG được: push event phải return ngay, fetch khi offline oan. → **Chấp nhận payload mã hóa RFC 8291** (aes128gcm: ECDH + HKDF + AES-GCM ~60 dòng trong vapid.ts) — Google vẫn không đọc được nội dung, chỉ biết "có một push". Payload: `{kind:"settle"|"died"|"needs-you", room, agent, tag}` + `renotify`. 
2. **Decision port**: `decidePush(payload, hasVisibleClient)` y nguyên (viết `src/web/push-decision.js` + test thuần). Tag = `hg:<room>` coalesce; `clear` khi receipt cho thấy agent đã settle trước khi user mở.
3. **keysMatch + resubscribe** vào flow pair PWA (đã có generation-token fetch) — thêm check mỗi lần mở app.
4. **Self-update**: gate thêm header `x-hg-build` (= version package) vào mọi response tĩnh + `/healthz`. PWA: BUILD id nhúng lúc serve (static.ts chèn vào app.js header hoặc meta tag) + hysteresis ×2 + once-per-build + hold khi đang soạn (localStorage draft). SW giữ network-first navigate (đã đúng).

### Việc (theo thứ tự)
1. `push-decision.js` + test (1h) — thuần.
2. RFC8291 payload trong `vapid.ts` + test vector chuẩn (RFC test) (3h).
3. Gateway gửi payload theo receipt event (settle/died/needs-you đã có từ wake-event.mjs) (2h).
4. SW handler mới + notificationclick deep-link `#room=<id>` (1h).
5. keysMatch/resubscribe trong app.js (1h).
6. `x-hg-build` header + PWA self-update controller (3h).
**Tổng ~11h.** Rủi ro: FF/Safari notification API khác nhau — test trên điện thoại thật; payload > 4KB không được (chỉ gửi kind+ids).

---

## PHẦN 6 — Review diff (herdr-reviewr) — ✅ DONE 9cc5e33 (291 test; turn-anchor = git-anchors journal bên ngoài repo, KHÔNG refs/reviewr — receipts không có commit hash như dự đoán)

### Kiến trúc gốc (đáng học từng điểm)
- **3 tab**: Changes / All files / **PR** (đọc qua `gh`, không bao giờ post). **3 scope**: `u` uncommitted / `b` branch / **`t` last turn** — diff của ĐÚNG lượt agent vừa làm (cần herdr).
- **Comment theo dòng**: `v` chọn dòng → `c` note → card dưới dòng; sửa/xóa/nhảy comment; **`s` Send** — thả TOÀN BỘ comment vào input agent dưới dạng `path:start-end — comment` (1 keystroke, agent nhận dạng cấu trúc).
- **Kỷ luật an toàn**: không bao giờ sửa worktree; git write duy nhất = ref private `refs/reviewr/` (baseline); PR read-only.
- Render ngoài luồng input (worker + mpsc + bỏ render stale + catch_unwind); delegate highlight cho `delta`/`bat`/`glow`; markdown preview giữ vị trí đọc; 18 theme; mouse đầy đủ.

### Hiện trạng herdgate
- `diff.get` (ref → `git show --stat --patch`, cap 128KiB, gitRead hardening) hiển thị text thô trong PWA. Không có: scope uncommitted/branch/last-turn, comment, gửi lại agent, highlight.

### Thiết kế áp vào herdgate (mobile, không phải TUI)
- **Op mới (đều read-only qua gitRead):**
  - `review.files` `{scope}` → danh sách file + +/- stats. scope=uncommitted: `git status --porcelain` + `git diff --stat`; branch: `merge-base` với upstream/main + `--stat`; **last-turn**: từ receipts — turn của agent đã ghi commit hashes (git-safe một đường) → diff first..last. KHÔNG cần ref riêng (receipts chính là baseline trung thực hơn).
  - `review.diff` `{scope, path}` → patch 1 file (cap, đã có pattern).
- **Comment store ở PWA (session-only)** — port discipline: không ghi gì xuống gate/agent cho đến khi bấm Send.
- **`review.send`** (ACT): đóng gói `path:start-end — comment` từng dòng → gửi về agent: đường chuẩn = `task.mjs continue` subagent (prompt chứa khối `<file-comments>`; agent nhận dạng cấu trúc như reviewr) — tái dùng fleet sẵn có, KHÔNG cơ chế mới.
- UI mobile: màn hình danh sách file (stat) → màn diff cuộn, tap số dòng chọn, sheet comment; nút Send gộp.
- Highlight: client-side (PWA) — không delegate CLI (phone không có delta/bat).

### Việc
1. `review.files` + `review.diff` + test gitRead fixtures (4h).
2. Last-turn scope: join receipts × commit hashes (2h — kiểm receipts có đủ: git-safe đã ghi per-turn).
3. UI PWA 2 màn + comment store (6h).
4. `review.send` qua task.mjs + act gate + test e2e với agent thật (4h).
5. Highlight diff client (dùng lib nhỏ hoặc regex token cơ bản) (3h).
**Tổng ~19h.** Giá trị: vòng "agent code → tôi review trên phone → agent sửa" khép không cần mở laptop.

---

## PHẦN 7 — ✅ DONE 4a79ec9+c3397ba (file.tree/file.read + fuzzy.js + tab Files; cap 128KiB + wire-budget; git-safe allowlist subcommand) —
 File viewer + deep-link (herdr-file-viewer)

### Kiến trúc gốc (24 module — những cái đáng học)
- **Đọc-only tuyệt đối**: mọi git subcommand read-only; editor = hand-off process; annotation chỉ in-memory; copy qua OSC 52.
- **Delegate render**: markdown/diff/syntax giao cho `glow`/`delta`/`bat` — viewer chỉ dựng khung; render chạy worker thread, stale drop theo sequence number.
- **fuzzy** (thuần, ~60 dòng): subsequence không phân biệt hoa thường + **basename weighting** (match nằm hết trong tên file > match lan thư mục) + đường ngắn thắng.
- **search**: smartcase substring thuần (không regex), trả byte-offset ranges; **highlight** compose đè lên render có sẵn (không re-render).
- **lineselect**: `path:line` / `path:start-end` / trích text / annotation `a` → serializer `<file-annotations>` ( ` -> ` phân tách — note chứa ":" không thể tái tạo separator = chống ambiguity).
- **view_policy** (pure): file đổi → diff, .md → render, còn lại → syntax; thứ tự cycle.

### Thiết kế áp vào herdgate
- **Op (read-only, whitelist mạnh hơn diff.get):**
  - `file.tree` `{filter?}` → `git ls-files` (đã respect .gitignore sẵn) + `git status` overlay (M/A/D markers). Cap số file (5k).
  - `file.read` `{path, lines?}` → path **root-relative, chặn `..`, chặn symlink ra ngoài** (lstat check + gitRead cwd cố định), size cap 256KiB, trả text thô (PWA tự highlight — không delegate CLI).
- **PWA**: màn viewer 1 cột + breadcrumb; fuzzy finder (port thẳng thuật toán subsequence + basename weighting ra JS ~50 dòng, test bằng fixture); in-file search smartcase; deep-link **`#f=<path>:<line>`** — receipts (stack trace, diff note) chèn link sẵn; lineselect → copy `path:line` (serializer `<file-annotations>` giữ tương thích nếu sau này mở reviewr thật trên desktop).
- **Không làm** (lý do): editor hand-off (phone không có), worktree switcher picker (chưa cần), theme (PWA đã có).

### Việc
1. `file.tree` + `file.read` + hardening test (traversal, symlink, cap) (4h).
2. Fuzzy JS port + test (1.5h).
3. UI viewer + search + highlight client (5h).
4. Deep-link `#f=` từ receipt body + PWA router hash (2h).
5. lineselect copy + serializer (1.5h).
**Tổng ~14h.**

---

## PHẦN 8 — Mirror plugin (herdr-mirror) — 🟡 PHASE 1+2 done 335a544+6d8052d (297 test)
✅ fleet.detail op (read) · term.send/term.keys typing lane (act, argv không shell) · plugin/mirror (pair/status/pane/stream) · predict.mjs (threshold 2 + RTT grace 150ms mới, timeout 1200, cap 32) · herdrRead fallback pane read · live: panel fleet thật + stream ANSI thật từ room home.
⬜ Còn: reconcile workspace `🏠 <room>` tự động qua plugin.pane.open (đang gọi tay stream), act-pair UX trong TUI, typing live-chưa-thử với act thật (HERDGATE_MIRROR_TYPE=1).

### Kiến trúc gốc
- 1 binary, 2 mặt: **daemon** (control plane — reconcile remote workspaces thành local mirror workspaces `<host>: <name>`, đẩy agent status vào sidebar) + **1 process `pane` mỗi mirror pane** (data plane — stream terminal remote).
- One-way mirror nhưng **gõ vào mirror pane = lái remote**; remote actions: new workspace/tab, split right/down (đúng vocabulary api-bridge ta đã dùng hôm nay).
- **Predictive local echo (predict.rs — mosh-style giản lược)**: echo phím local ngay (round-trip ~100ms đọc như lag), nhưng CHỈ bật sau **CONFIRM_THRESHOLD=2** phím liên tiếp được frame authoritative xác nhận; 1 mâu thuẫn = tắt; full-screen app (vim/htop) tự tắt; timeout 1200ms xóa "ghost" (không để ký tự password dự đoán lưu lại màn hình). MAX_PENDING=32.
- Cấu hình `hosts.toml`; autostart trên event `workspace.focused`; **restore** đưa lại mirror đã đóng; teardown. Target = ssh host HOẶC docker container (socat).

### Áp vào herdgate — khác biệt then chốt
herdr-mirror nói ssh thẳng tới remote herdr. **Herdgate đã có đường tốt hơn: gate + device identity + E2E.** Mirror của ta = một plugin herdr chạy trên MÁY BẤT KỲ (vd laptop), đăng ký làm **device read** vào room trên gate, rồi:
1. **Sidebar phase (nhẹ, trước)**: poll `view` snapshot (đã có, 5s cadence) → panel "🏠 home" trong TUI local: list agents + trạng thái + needs-you count. Không stream pane. (~1 ngày việc — nâng cấp pane herdgate status hiện có thành panel thật.)
2. **Mirror phase (đầy đủ)**: workspace local `🏠 <room>: <ws>`; nội dung pane = poll `term.read` chu kỳ 1–2s/pane (herdr stable 0.9.5 chưa có terminal session streams — mirror gốc cần preview build; poll là cái giá ổn định). Gõ được = act grant (phải pair act, đúng triết lý gate).
3. **Predictive echo port JS** (predict.rs → ~120 dòng JS): cùng hằng số (threshold 2, timeout 1200ms, pending cap 32) — vì RTT nhà↔laptop qua CF ~130ms là đúng vùng "đọc như lag" mà module này sinh ra để trị.
4. Remote actions: tab.create / pane.send_text / tab.close — **đã chứng minh sống hôm nay** qua api-bridge (drive-laptop).

### Việc
1. Panel fleet trong plugin hiện tại (snapshot → pane panel) (6h).
2. Plugin mirror riêng `plugin/mirror/`: device client + workspace reconcile (1-2 ngày).
3. Pane stream poll + vẽ (ansi đơn giản) (1 ngày).
4. Predictive echo JS + test (4h).
5. Remote actions qua act + act-pair UX trong TUI (4h).
**Tổng ~4-5 ngày** (lớn nhất 4 phần — để cuối).

---

## So sánh & thứ tự khuyến nghị trong 4 phần
| Phần | Giá trị/ngày | Chi phí | Rủi ro |
|---|---|---|---|
| 5 Push/self-update | Cao (biết agent cần mình ĐÚNG loại, không lo rotation chết push; PWA luôn mới) | ~11h | Payload crypto — có RFC test vectors |
| 7 File viewer | Cao (mọi receipt trỏ file mở được ngay) | ~14h | Path hardening — test kỹ traversal |
| 6 Review | Rất cao (vòng review khép trên phone) | ~19h | Phụ thuộc receipts có commit-hash per turn (verify) |
| 8 Mirror | Cao nhưng "màn hình thứ 2" (TUI) | 4-5 ngày | Cần act cho typing; herdr stable chưa có streams → poll |

Thứ tự: **5 → 7 → 6 → 8** (5 và 7 nhỏ, độc lập, hạ tầng tin cậy trước; 6 cần verify dữ liệu receipts; 8 để cuối vì lớn nhất và sidebar phase có thể rút ra làm sớm standalone).
