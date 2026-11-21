# herdr-file-viewer — ĐÀO SÂU TẦNG 2 (excavate)

Nguồn: /tmp/deep/filev (clone depth-1, v1.18.0). Quy mô: src 23.140 dòng / 39 module; tests ~56k dòng,
**1.664 `#[test]`**; docs 2.292 dòng. Tầng 1 (r-filev.md) đã tóm cơ chế chính — không lặp; ở đây đào
module graph, state machine, meta-tests và các cơ chế tầng 1 chưa chạm.

## Kiến trúc đầy đủ (module graph: ai gọi ai, dữ liệu chảy thế nào)

```
main.rs (50d, chỉ dispatch argv)
 └ lib::run(open_flag)  [src/app.rs:53]
    ├ proc::remember_launch_dir()          # chốt launch-dir TRƯỚC mọi chdir (app.rs:55)
    ├ host::from_env() → context::LaunchContext   # HERDR_PLUGIN_CONTEXT_JSON, degrade {cwd}
    ├ root::resolve(&ctx) → Resolved{root, repo_root, is_git_repo, is_worktree, base_branch}
    ├ config::load_config_from_env() → resolve() → EffectiveSettings (config>env>default)
    ├ factory: Box<dyn Fn(&Resolved) -> RootProviders>   # re-root rebuild providers (ADR-0004)
    │   └ LiveGit (Arc<dyn GitService>) + LiveContent (Box<dyn ContentProvider>)
    ├ startup_controller(...) → Controller::new_with_changed_file_view
    │   (seed changed_file_view TRƯỚC dispatch render đầu — worker không cancel job đã chạy)
    ├ controller.apply_*(eff.*) × 12      # mọi config key = 1 lời apply tường minh
    ├ open_target::pick_raw_open(--open > env) → parse_open_target_preferring_file
    │   → controller.apply_open_target()   # soft-fail, không abort startup
    ├ input::resolve_bindings(registry, cfg.keys) → (bindings, KeyLoadOutcome)
    ├ update::start_default_with(!update_check)     # notice coordinator off-UI
    ├ controller.set_host(LiveHerdr::from_env, workspace_id)  # $HERDR_BIN_PATH seam
    └ event_loop [app.rs:332]
        loop { follow_root; draw_if_needed(dirty); poll(tick);
               route key → modal handler or input::decode → controller.handle(intent)
               → apply_input_effects(clear|redraw|quit); drain controller.poll() }
```

Controller (src/controller/mod.rs 4.970d, split 11 submodule) sở hữu: 1 `Modal` enum duy nhất
(type-enforce exclusive ownership), `latest_seq` render, `AnnotationStore`, pinned preview, và
spawn 2 worker: render worker (1 thread dài hạn, mpsc RenderJob→RenderCompletion, backlog collapse,
`catch_unwind`) và project-search worker (collapse + cancel-probe qua `Arc<AtomicU64>`).
Presenter (3.134d) chỉ vẽ từ `Controller::view_state()` — borrow-free `ViewState` projection, không
đọc tree trực tiếp; mouse hit-test dựa geometry presenter feed-back (`set_pane_geometry`).
git.rs là module DUY NHẤT gọi git; herdr.rs là seam duy nhất gọi herdr CLI ($HERDR_BIN_PATH).
`proc::in_launch_dir` neo mọi process ngoài (renderer/editor/opener/herdr) về launch-dir — cwd
process thì `follow_root` bám tree-root (kênh để `pane list` biết viewer đang đứng ở root nào).

## Máy trạng thái & luồng chi tiết

### 1. Modal — exclusive input ownership bằng 1 enum (controller/mod.rs:635)
```rust
enum Modal {
    None, Picker(PickerState), Finder(FinderState), ProjectSearch(ProjectSearchState),
    Prompt(PromptState), Help(HelpState), LineSelect(PreviewSelection),
    Annotations(AnnotationListState), AnnotationEditor(AnnotationEditorState),
    DiscardConfirm(DiscardAction),   // carries what to do once the user decides
}
```
Event loop là chuỗi guard-arm có thứ tự (app.rs:332-440): `project_search_open → finder_open →
prompt_open → help_open → line_select_active → annotation_raw_keys_owned → decode globals`.
Mỗi modal nuốt TOÀN BỘ phím (kể cả no-op) — không phím nào rò xuống action global; `handle()`
còn chốt hai lớp: modal≠None → `Effects::noop()`, rồi `focus_policy::target_for` reject action
liveselection từ pinned preview. Bài học: ownership bằng type (enum mang state bên trong), không
phải flag rời.

### 2. Render pipeline — seq + worker collapse + panic containment (controller/mod.rs:1190)
```rust
while let Ok(mut job) = job_rx.recv() {
    while let Ok(newer) = job_rx.try_recv() { job = newer; }   // collapse backlog
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let raw_diff = ... git.diff(...);                      // diff đọc OFF input-thread
        content.render_at_width(&job.path, job.mode, raw_diff.as_deref(), ...)
    })).unwrap_or_else(|_| RenderResult { content: Text::raw("[content unavailable: renderer error]"), ... });
    if result_tx.send(RenderCompletion { job, result }).is_err() { break; } // controller gone
}
```
`poll()` chỉ áp kết quả khi `seq == latest_seq` (mod.rs:3776); RenderJob mang `root` + `branch`
(BranchState) capture lúc dispatch — không suy ra từ cursor lúc kết quả về. Một render mới =
dispatch_reset 6 thứ (scroll H+V, pending_goto, pending_line_select, search, selection,
open_range_flash — mod.rs:3651-3672): mỗi loại state gắn content đều bị clear đồng bộ tại chỗ
dispatch, trước khi worker spawn. Có phân biệt reflow (resize, cùng selection) giữ scroll/search
qua `reflow_seq` — đúng 1 bit, không heuristic.

### 3. DiscardConfirm — confirm carry actionfuture (mod.rs:1320-1327)
Quit/switch-worktree với store non-empty → `Modal::DiscardConfirm(DiscardAction::Quit |
SwitchRoot(Box<Resolved>))`. confirm chỉ sau khi clipboard write THÀNH CÔNG; `DiscardAction` giữ
luôn `Resolved` đã resolve để apply không phải resolve lại. Điểm tinh: confirm được raise SAU hai
early-return (target không phải dir; same-root no-op canonicalized) — đúng thời điểm annotations
"thật sự" có nguy cơ, không confirm cho một switch sẽ no-op.

### 4. launch_decision — decision in-process, script chỉ dịch (launch.rs)
```rust
let Some(id) = files.pane_id.as_deref().filter(|id| is_flag_safe(id)) else { return "OPEN".into() };
if Some(id) == focused.pane_id.as_deref() { format!("CLOSE {id}") } else { format!("FOCUS {id}") }
```
Binary in `--launch-decision` đọc `pane list` JSON từ stdin → in 1 dòng OPEN/FOCUS/CLOSE
(tab variant thêm SWITCHTAB, root-aware qua resolver inject được); script `.sh` gọi rồi switch-case
— mọi lỗi đều degrade về OPEN. Pane id filter `is_flag_safe` trước khi vào argv của
`pane zoom|close` (chống option-injection từ host JSON).

### 5. Baseline state (git.rs:96) — Head/Base là FUNCTION của context
`default_baseline`: feature branch/worktree → Base; trên base branch → Head; detached worktree →
Base. Base không phải "branch cha" mà là `merge-base(resolve_base_branch(hint→main/master/
origin/*), HEAD)`; untracked merge thêm từ status; unborn HEAD diff với EMPTY_TREE hash
`4b825dc…`. Mọi truy vấn Base đều thread `base_hint` từ launch context để decision==computation.

## Mọi cơ chế áp vào herdgate (excerpt + file:line → đích herdgate)

1. **Git hardening fail-closed bằng refuse-flag** (git.rs:588) — TẦNG 1 thiếu chi tiết này:
```rust
let Some(filter_overrides) = configured_filter_overrides(repo_root) else {
    let mut refused = base_git_command(repo_root);
    refused.arg("--herdr-refuse-unverified-filter-config");  // flag sai → git fail trước dispatch
    return refused;
};
```
Inventory filter drivers bằng `git config --includes --null --name-only --get-regexp ^filter\.`
(2s timeout, 1MiB cap, fifo-trap có test), rồi override mỗi driver `filter.X.{clean,smudge,
process}= (rỗng)` + `required=false` qua `-c`. Không đọc được inventory → CHẠY THẬT một flag sai
để git tự fail, chứ không chạy lệnh với filter-set chưa xác minh. Áp: `plugin/server` chỗ gọi git —
hiện herdgate chỉ cần `-c` phủ filter nếu op Diff quét repo lạ; inventories + fail-closed đúng
threat model khi publisher chạy trong worktree agent.
2. **capture_stdout bounded-read + kill** (git.rs:605):
```rust
let _ = out.take(MAX_DIFF_BYTES).read_to_end(&mut buf);  // đọc tối đa 4MiB rồi ngắt
let _ = child.kill(); let _ = child.wait();              // giải phóng git block trên pipe đầy
```
Áp: mọi `git show/log/diff` dài của op Diff/Timeline — `.take(N)` + kill thay vì đợi EOF; chống
repo khổng lồ treo worker.
3. **`is_within_root` lexical + canonicalize** (git.rs:674): reject absolute + `..` trước khi chạy
git, rồi `canonicalize` hai bên chống symlink-trung-gian thoát root. Áp: op Diff nhận target từ
chat/PWA — cùng hàm này trước khi build pathspec.
4. **`in_launch_dir` — launch-dir pin** (proc.rs:33): OnceLock ghi cwd lúc spawn; mọi child ngoài
(git除外 vì dùng `-C`) chạy `cmd.current_dir(launch_dir)` vì process cwd bám untrusted root; comment
nêu rõ lý do: relative program `./tools/render` và delta đọc `.git/config` của cwd. Áp: herd-gate/
publisher khi spawn bất kỳ process nào trong khi cwd = worktree agent.
5. **OSC 52 clipboard + base64 tự viết** (app.rs:747-790): payload base64 → tên file chứa ESC/OSC
không thể break-out; cắt dependence clipboard OS, đi xuyên tmux/SSH. Áp: mobile TUI SSH khi cần
"copy path/receipt" về máy người dùng.
6. **Annotation serializer ` -> ` + escape** (annotation.rs:318-345): sort path→lines→id,
`escape_list_content` (`& < >`), separator ` -> ` vì `:` đã dùng cho `path:line` và không bị escape —
arrow là token duy nhất không thể giả mạo trên dòng (cả `>` đã escape). Áp: op "note" human→agent:
format `<file-annotations>` deterministic này agent parse được bằng split " -> " an toàn.
7. **TempDir tự viết + sweep stale 1h** (tests/common/mod.rs:44-91): Drop cleanup + sweep orphan
của run bị SIGKILL theo prefix `herdr-fv-test-` + mtime cutoff. Áp: herdgate test suite nếu chưa
dùng tempfile — chống /tmp nhỏ bị các run test giết chóc làm đầy.
8. **RecordingClipboard / GatedContent stubs** (tests/controller_async.rs:54, common/mod.rs:112):
stub clipboard ghi log `Arc<Mutex<Vec<String>>>` giữ handle sau khi bàn cho controller; GatedContent
block trong `render()` tới khi test nhả — ép race theo ý, không sleep. Áp: suite 213 test — mọi
seam side-effect của herdgate (SSH send, Pi API, git) cần stub kiểu recording + gate như thế này.
9. **FocusGained → refresh git** (app.rs:449): `EnableFocusChange` khi start, event focus →
`controller.handle_focus_gained()` re-read status — bắt merge/pull/commit từ pane khác không cần
poll. Áp: khi herdgate có pane desktop — subscribe focus thay vì timer.
10. **Zombie-reaper thread cho opener fire-and-forget** (app.rs:830-856): spawn xong stdio-null,
`std::thread` throwaway `child.wait()` — không block loop, không zombie. Áp: mọi spawn
"fire-and-forget" của publisher (notify script, open URL từ action).
11. **EditorOutcome 3 trạng thái phân biệt resume-fail** (app.rs:690-724): `NotLaunched` /
`NonZeroExit` / `TookOver` — resume TUI fail SAU khi editor chạy = vẫn TookOver (phải refresh git
+ repaint toàn bộ), không báo "could not open". Áp: bất kỳ chỗ nào herdgate chạy process ngoài rồi
phục hồi UI — error taxonomy theo "đã side-effect chưa", không theo "lệnh có lỗi không".
12. **Intent::ALL + exhaustive-match test** (intent.rs:333): thêm variant mà quên phân loại
mutation → không compile. Áp: herdgate op-list / intent của TUI mobile nếu có — enum closed-set +
test ép match hết.
13. **Deep-link `path:line-range` + flash range 1s** (open_target.rs:196, app.rs OpenRangeFlash):
`parse_line_suffix` nhận `N` / `A-B`, reveal → pending_goto gắn seq render, range flash tự hết.
Áp: `src/web/app.js` Diff view deep-link (đã nêu tầng 1, giờ có spec byte-level: lexical-normalize
trước containment check, `names_a_file` closure cho "prefer file when names one").

## Cách họ test (bài học cho suite 213 test)

- **1664 test / 56k dòng tests — tests là 70% codebase.** Tầng: unit inline (module `#[cfg(test)]`),
integration tests/ (38 file), e2e pty (`expectrl`), snapshot (`insta` × 44 snap), **meta-tests đọc
file repo như data**.
- **Meta-test = guard_docs/CI/manifest/scripts** — phát hiện giá trị nhất cho herdgate:
  `tests/docs_consistency.rs:46 no_documented_launch_passes_cwd_to_plugin_pane_open` gộp các run of
  lines có `plugin pane open` (xử lý `\` continuation!) trong SKILL.md + usage.md + summoning.md +
  3 launcher script, cấm `--cwd` trong block — bug #139 từng trôi docs-vs-script nay fail build.
  `tests/ci_workflow.rs` assert chính file `.github/workflows/ci.yml` (windows job advisory
  non-blocking `continue-on-error: true`, musl không rebuild mỗi PR). `tests/launcher_content.rs`
  chạy trên Linux nhưng đọc .ps1 — content-check không cfg(windows) để bug Windows chặn PR Linux.
  Áp herdgate: test đọc `herdr-plugin.toml`, docs skill, CI yml, script publisher của ta như data.
- **AGENTS.md "Tests prove things deterministically"** (rules học từ flake thật): không assert
  time-budget chặt; chứng minh "không có work" bằng observable sync tell (`render_seq` bump trước
  khi worker spawn — unchanged seq proves no dispatch); "bounded vs unbounded" bound fixture
  60s-stall ở vài giây; **force race bằng gate, không sleep** — GatedContent giữ render mở, dispatch
  mới hơn, nhả cũ → kết quả stale tới `poll` đúng thứ tự guard tồn tại để reject (comment: "Verified
  to fail when the guard is removed"); pty e2e chỉ match từ đơn (ratatui diff-redraw làm vỡ phrase
  có space); mỗi phím q/Esc chỉ bóc 1 layer state — không bấm phím dựa state chưa quan sát.
- **Trigger-based panic containment test** (controller_async.rs:180): `PanicOnContent` panic trên
  đúng 1 file, file khác vẫn render sau đó → chứng minh worker SỐNG SÓT qua panic (không chỉ là
  "panic không crash app").
- **common/mod.rs dependency-free**: tự TempDir + sweep; `viewer_command` luôn set
  `HERDR_FILE_VIEWER_NO_UPDATE_CHECK=1` — test không bao giờ chạm mạng, mặc định ở harness chung.
- **e2e anchor "blank-cell contiguous"** (e2e_keyboard.rs:25): chỉ assert text vẽ vào cell trống
  trước đó (draw full đầu tiên / content lần đầu chọn file) vì overwrite bị cursor-escape phân mảnh.

## Anti-pattern / không lấy gì

- **Controller 4.970 dòng + presenter 3.134 dòng**: split submodule (`use super::*`) giảm file size
  nhưng KHÔNG giảm coupling — mọi submodule dò chung một struct 40+ field. herdgate giữ module nhỏ
  theo ownership thật, đừng "mod.rs + 11 feature-mod cùng self".
- **Doc-comment mang AC-id dày đặc** (AC-N5, AC-23… trong 500+ chỗ): trace tốt cho repo có spec-
  chain, nhưng herdgate không có chuỗi AC编号 — copy style này gây noise; chỉ giữ comment "vì sao"
  ngắn kiểu `#139`, `GH #58`.
- **Update gateway (7 module, ~2k dòng)** cho banner spotlight/release-notice: quá mức với self-
  hosted; kể cả pattern "dismissal json riêng + 404 withdraw" cũng không đáng cho herdgate.
- **Windows machinery** (ps1 inline trong manifest 15 dòng/lệnh, `\\?\` strip, call-operator spawn,
  `-windows` suffix ids): herdgate Linux-only.
- **No-events philosophy (AC-N4)**: viewer đúng nhưng herdgate chủ trương wake-on-settle ngược lại.
- **Version phải bump 3 file (Cargo.toml/lock/manifest) + tag-at-merge-commit + release notes extract
  từ CHANGELOG bằng awk**: quy trình release phức tạp appropriate cho binary phân phối 4 nền tảng;
  herdgate PWA không cần.
- **Filter-inventory 2s timeout mỗi process viewer**: hợp lý cho process dài; herd-gate là daemon
  chạy dai — nếu áp cơ chế 1, cache inventory theo repo-root thay vì probe mỗi lần.

## File đã đọc (đầy đủ + dòng)

ĐỌC TRỌN: ARCHITECTURE.md (1-400/toàn bộ); constitution.md (1-22); AGENTS.md (1-303);
docs/summoning.md (1-163); herdr-plugin.toml (1-129); skills/herdr-file-viewer/SKILL.md (1-89);
src/intent.rs (1-376); src/proc.rs (1-147); src/view_policy.rs (1-120, phần code chính);
src/annotation.rs (1-400, phần code chính).
ĐỌC TRỌN PHẦN CHẠY + skim test: src/app.rs (1-1000 chạy; 1001+ tên test); src/git.rs (1-1100 gồm
tests; còn lại danh mục test); src/controller/mod.rs (1-800 types; 1190-1370 workers+re_root;
2285-2405 handle(); 3651-3861 dispatch_render/poll); tests/common/mod.rs (1-200);
tests/controller_async.rs (1-260); tests/docs_consistency.rs (1-200).
ĐỌC ĐOẠN LÕI (grep + đọc hàm): src/open_target.rs (header, parse_line_suffix:196-241,
lexically_normalize); src/render.rs (neutralize_terminal_control:657-697); src/repo_search.rs
(1-50 + bound consts); src/launch.rs (launch_decision + launch_decision_tab doc);
src/input.rs (Binding:179-200 + registry); tests/launcher_content.rs (1-80); tests/manifest.rs
(1-60); tests/e2e_keyboard.rs (1-70); .github/workflows/ci.yml (grep jobs); docs/usage.md (grep
mục annotation/agent); src/presenter.rs, src/config.rs, src/input.rs phần còn lại + 24 test file
khác: LIỆT KÊ THEO VAI TRÒ — presenter.rs (3.134d, vẽ ViewState→ratatui + 44 snapshot), config.rs
(1.840d, TOML defensive-parse + EffectiveSettings), input.rs (1.965d, REGISTRY 46 binding +
KeySpec parser + decode), help.rs (1.552d, overlay + settings_text compiled CHANGELOG),
root_picker.rs (1.385d, popup prompt + Tab-completion, pure over injected fs), render.rs còn lại
(1.325d, classify/delegate/stdin-spawn), finder.rs (995d, index+fuzzy worker 10ms settle),
tree.rs (883d, gitignore-walk + compact-dirs two-entry probe memo), opener.rs (619d, per-OS argv),
worktree.rs (364d, worktree list + agent overlay), highlight/text_layout/preview*/search/fuzzy/
index/infile/picker/prompt/herdr/host/context/root/editor/focus_policy (mỗi module <550d, vai trò
đúng bảng ARCHITECTURE.md), src/update/* (7 file, dismissed ở mục anti-pattern), 24 tests/ còn lại
(theo tên file — cây đầy đủ trong inventory bước 1).

Tổng: 25 file đọc trọn/đoạn lõi + toàn bộ cây inventory. Phát hiện giá trị nhất: **meta-test đọc
docs/script/CI như data** (`no_documented_launch_passes_cwd_to_plugin_pane_open`) + **fail-closed
refuse-flag cho git filter inventory** — hai thứ tầng 1 không có.
