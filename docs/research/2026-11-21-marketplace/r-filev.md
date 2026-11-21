# herdr-file-viewer (smarzban) — nghiên cứu sâu cho herdgate

Repo: github.com/smarzban/herdr-file-viewer — Rust (ratatui), MIT, 720★, v1.18.0, herdr ≥0.7.5.
Bản chất: TUI **read-only, git-aware** trong 1 pane herdr — tree trái, phải tự chọn view (diff nếu
file đổi / markdown render / syntax highlight). Agent "đặt" người dùng tại file:dòng; người đánh dấu
file/range rồi copy note dán lại vào chat.

## Kiến trúc cốt lõi (file-level)
- `herdr-plugin.toml`: [[build]] fetch-or-build (SHA-256 verify, fallback cargo); [[panes]] `file-viewer`
  (placement=split) + `root-picker` (placement=popup, width 60%/height 16); [[actions]] open split/tab/
  at/at-tab, mỗi platform 1 id riêng (`-windows` suffix vì herdr từ chối id trùng). **Không có [[events]]**
  — viewer chỉ mở do action tường minh (AC-N4, ngược lại với herdgate cần event hooks).
- `src/host.rs` + `src/context.rs`: parse `HERDR_PLUGIN_CONTEXT_JSON` {focused_pane_cwd, workspace_cwd,
  cwd, base_branch, workspace_id} — mọi field optional, malformed → degrade `{cwd}`, never panic.
  `HERDR_FILE_VIEWER_ROOT` override phải absolute + is_dir, không dùng `--cwd` (làm vỡ spawn command
  relative trên Windows, #139).
- `src/root.rs`/`src/worktree.rs`/`src/git.rs`: root = worktree top-level (không phải cwd); `git.rs`
  là module DUY NHẤT gọi git, chỉ subcommand read-only.
- `src/app.rs` event loop: draw → poll input → controller.handle(intent) → drain finished renders.
  Render + project-search chạy off-thread (std::thread + mpsc, no tokio).
- `src/launch.rs` + `scripts/open-file-viewer.sh`: launcher idempotent "launch-or-focus-or-toggle";
  quyết định tính **in-process** (`--launch-decision`, ăn `pane list` JSON qua stdin), script chỉ dịch
  decision → CLI, lỗi nào cũng degrade về OPEN.
- `src/open_target.rs`: parse `path` / `path:line` / `path:start-end` từ CLI `--open` hoặc env
  `HERDR_FILE_VIEWER_OPEN`, lexical-normalize dưới root (chống thoát root, AC-N5).
- `skills/herdr-file-viewer/SKILL.md`: skill dạy agent lệnh mở đúng + anti-pattern.

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)
1. **Contract agent→human "mở giúp tôi chỗ này"** (SKILL.md): agent chạy
   `herdr plugin pane open --plugin herdr-file-viewer --entrypoint file-viewer --placement split
   --direction right --focus --env "HERDR_FILE_VIEWER_OPEN=src/app.rs:42"` (+ `HERDR_FILE_VIEWER_ROOT=$repo`
   absolute khi cần). Viewer reveal + pending go-to-line. Skill nêu rõ: target là DATA không phải shell
   source; KHÔNG `--cwd`; KHÔNG key-script TUI; KHÔNG retarget pane đã có (state người dùng).
2. **Human→agent feedback qua annotation** (`src/annotation.rs`): `AnnotationStore` session-only,
   target = root-relative path + LineRange 1-based; `canonical_text()` serialize `<file-annotations>`
   wrapper, sort path→lines→id, escape `&amp;/&lt;/&gt;`, separator ` -> `; copy qua **OSC 52 clipboard**
   — người paste thẳng vào chat agent. Quit/switch worktree với store non-empty → `Modal::DiscardConfirm`,
   `y` chỉ proceed khi clipboard write thành công.
3. **Git hardening cho repo không tin cậy** (`src/git.rs::git_command`): MỘT shared builder cho mọi
   call: `.env_remove("GIT_DIR"/"GIT_WORK_TREE")`, `-c core.fsmonitor=false`,
   `-c core.hooksPath=<null-device>`, `--no-ext-diff --no-textconv --no-color`,
   `diff.submodule=short`. Có unit test khóa từng flag (test asserts args chứa từng giá trị) để
   hardening không bị trôi giữa callers.
4. **View policy thuần hàm** (`src/view_policy.rs::default_mode`): deleted→Diff; changed→Diff (config
   `changed_file_view`); markdown→RenderedMarkdown; còn lại SyntaxContent. `applicable_modes` sinh
   chuỗi cycle (diff → full-diff → rendered → syntax) — auto-mode + override thủ công 1 phím `v`.
5. **Render delegate + neutralize** (`src/render.rs`): glow/delta/bat feed content qua **stdin**
   (không argv — chống option-injection), `CLICOLOR_FORCE=1` khi stdout không TTY, `--file-name=`
   fake để bat hiểu ngôn ngữ; output re-sanitize: giữ SGR, strip mọi control/cursor escape
   (`neutralize_terminal_control`, ControlMode::Styled/Plain/OneLine); binary file refuse; cap
   kích thước. Writer thread riêng tránh pipe deadlock (`proc.rs::terminate_and_reap` định nghĩa
   timeout-kill 1 lần).
6. **Launcher logic testable** (`src/launch.rs::launch_decision`): ăn JSON `pane list`, trả
   "OPEN" / "FOCUS <pane_id>" / "CLOSE <pane_id>"; pane id được validate flag-safe trước khi vào
   argv. Tab-variant root-aware: chỉ focus viewer nào cwd (viewer giữ process cwd = tree root,
   `app::follow_root`) resolve về cùng worktree top-level với pane đang focus — resolve root qua
   resolver inject được.
7. **Search có giới hạn** (`src/repo_search.rs` + `search.rs`): literal smartcase, KHÔNG regex;
   1 MiB/file, 500 kết quả, skip NUL/invalid-UTF-8/unreadable; cancel-probe giữa từng file; stream
   partial mỗi 50ms; sequence bump để drop kết quả stale.

## Áp vào herdgate (checklist: module/op/file đích, ưu tiên)
- [CAO] `plugin/server/*` (mọi chỗ gọi `git` cho Diff/Timeline): áp shared hardened-git builder y hệt
  cơ chế 3 — publisher/herd-gate đang chạy trong agent worktree (pipeline worktree) = đúng threat model.
  Thêm `--no-ext-diff --no-textconv`, `core.fsmonitor=false`, `core.hooksPath=<null>`, scrub
  GIT_DIR/GIT_WORK_TREE env cho mọi `git show/diff` của op Diff hiện chạy `git show --stat --patch`.
- [CAO] `src/web/app.js` (Diff view, ~line 584-622): deep-link `path:line` — op diff/jobs nhận thêm
  target `src/app.rs:42`, render scroll-to-line + flash hilight range (mẫu `OpenTarget::goto_line`,
  `parse_line_suffix`). Cmd+K mở "đến file:dòng" từ PWA; Pi agent có thể gửi target này trong receipt/
  chat để mobile "đặt người tại chỗ lỗi" — thay thế screenshot.
- [CAO] Kênh human→agent: thêm op "note" kiểu `<file-annotations>` (path -> note) từ PWA Diff view,
  publisher chèn vào session Pi như user message — đối xứng annotation/copy-paste của viewer; giữ
  format deterministic + escape để agent parse được.
- [VỪA] `plugin/server` search op: áp bound literal-smartcase (cap 500 dòng, 1 MiB/file, skip binary/
  NUL) thay regex nếu đang dùng; sequence/cancel khi user gõ tiếp.
- [VỪA] `plugin/herdr-plugin.toml`: học style [[actions]] per-platform + [[panes]] popup (root-picker
  dùng `plugin pane open --env`, không `--cwd`) nếu herdgate thêm pane tương tác trên desktop.
- [VỪA] Mobile TUI SSH (`src/host/mobile-tui-core.mjs`): khi hiển thị file/diff phía terminal, áp
  neutralize-terminal-control (giữ SGR bỏ control) trước khi vẽ — nội dung repo là untrusted.
- [THẤP] Đưa logic "launch-or-focus-or-toggle" in-process (binary testable ăn JSON stdin) nếu sau này
  herdgate có action mở pane.
- [THẤP] View-policy auto (changed→diff, md→render) cho PWA file preview nếu làm tab Files.

## KHÔNG nên học
- **Toàn bộ TUI 2 cột in-process ratatui** (~11k dòng Rust): herdgate PWA là web; chỉ mượn policy,
  không mượn UI stack. Mobile TUI SSH cũng không cần tree viewer.
- **Windows preview machinery** (CreateProcessW/`\\?\` path/`-windows` action ids, ps1 launcher):
  herdgate Linux VPS, chi phí không cần.
- **Update gateway/spotlight** (`src/update/*`, curl docs, dismissal json): self-host relay không cần
  hệ thống notice từ xa; phức tạp không tương xứng.
- **"No events, explicit action only" (AC-N4)**: đúng cho viewer nhưng herdgate chủ trương ngược lại
  (wake-on-settle via `[[events]]` pane.agent_status_changed) — đừng copy triết lý này.
- Phụ thuộc renderers ngoài (glow/delta/bat) bắt buộc cài thêm — với PWA chỉ lấy ý delegate, còn
  server-side render thì tự làm; MIT license OK, không vướng.

## File đã đọc (thật, từ raw.githubusercontent main)
herdr-plugin.toml; ARCHITECTURE.md; README.md; skills/herdr-file-viewer/SKILL.md; src/host.rs;
src/herdr.rs (HerdrCli::run_json, resolve_program, $HERDR_BIN_PATH); src/context.rs; src/launch.rs
(launch_decision/launch_decision_tab); src/open_target.rs (parse_open_target, parse_line_suffix,
resolve_under_root); src/annotation.rs (AnnotationStore::canonical_text, format_annotations,
normalize_note, escape_list_content); src/render.rs (render, sanitize_name, to_text,
neutralize_terminal_control, spawn renderer stdin); src/git.rs (git_command hardening, status,
default_baseline, changed_set, diff); src/view_policy.rs (default_mode, applicable_modes);
src/editor.rs (EditorLauncher, SpawnError); src/focus_policy.rs; scripts/open-file-viewer.sh.
