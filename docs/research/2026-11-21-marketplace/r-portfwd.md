# Nghiên cứu miko-misa/herdr-portfwd — port forwarding cho dev-server của agent trên máy remote

Plugin Rust (MIT, ~0.2.1, Herdr ≥0.8.0): Ctrl+click URL `localhost:PORT` agent in ra → forward cùng số port về máy người ngồi, mở browser bên đó. Hai mode: herdr-mirror (server local) và `herdr --remote` (server remote, plugin chạy remote).

## Kiến trúc cốt lõi (file-level)

- `herdr-plugin.toml` — manifest: 6 actions (`scan/add/list/stop/stop-all/open-url`), 3 panes (`list` overlay, `picker`+`confirm` popup), 1 `[[link_handlers]]` regex `^https?://(?:localhost|127\.0\.0\.1|\[::1\]):\d+`, 3 `[[events]]` (`workspace.focused/pane.exited/pane.closed` → `reconcile --event`), 1 `[[startup]]` (`reconcile --startup`, exit ngay).
- `src/discover.rs` — parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn` / `ss -ltnpH` + `ps -eo pid=,ppid=`; `ProcessTree{ancestry,descends_from}`; `attribute(listeners,tree,panes)` gắn listener vào pane qua `shell_pid`.
- `src/context.rs` — `parse_context(HERDR_PLUGIN_CONTEXT_JSON)`, `resolve_host()` với `HostSource` 4 mức: Explicit(--host/env) > WorkspacePrefix > Default > OnlyHost.
- `src/actions.rs` — `Placement{Local,Remote}` + `PlacementReason{Forced,MirrorWorkspace,LiveMaster,MirroredPane,Assumed}`; `Actions::locate()` suy luận bên nào đang chạy.
- `src/request.rs` — `Request{id,host,remote_port,local_port,remote_bind,origin,pane_id,open_url?,created_unix_ms}`, `Queue{last_consumed_id,pending}`, `RequestLog` (enqueue/push/pending/consume_through + `settle_to` fold ack).
- `src/state.rs` — `Store` (forwards.json) và `JsonFile<T>` chung: flock lock-file riêng, read-mutate-temp-fsync-rename, quarantine bytes đã hiểu không phải của mình; `StateError::Damaged` thay vì default() — "không đọc được" ≠ "rỗng".
- `src/ssh_process.rs` — thuần argv: `master_argv` (ControlMaster=auto+ControlPersist=yes+BatchMode), `forward_argv/cancel_argv/check_argv` (`-O forward/cancel/check`), `verify_control_path` ≤104 bytes (sun_path).
- `src/local_agent.rs` (~4800 dòng) — agent chạy máy local dưới `--remote`: poll requests + discovery, backoff khi fail, `RemoteRequests` đọc requests.json qua `ssh cat`, ack bằng `remote_mark_command(id)` (shell snippet chỉ interpolate một `u64`), `clamp_remote_bind` ép loopback, `offer_notification` L2.
- `src/main.rs` — subcommand dispatch, `reconcile()`, render báo cáo thuần `&Report -> String`; `src/ui.rs` — pane rendering; `docs/ARCHITECTURE.md` — hợp đồng thiết kế + 13 invariants.

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)

1. **Port attribution bằng process ancestry** (`discover.rs::attribute` + `ProcessTree::ancestry`): mỗi listener (PID từ lsof/ss) đi ngược parent-map tới `shell_pid` của pane (từ `herdr pane process-info`). Ancestry cycle-guard bằng `HashSet` + `MAX_ANCESTRY_DEPTH`; PID=0 bị lọc ("kernel, never a shell"); 2 pane trùng shell giữ cái đầu để kết quả chỉ phụ thuộc snapshot. Listener không tới pane nào → không đưa vào list (lọc cloudflared/limactl/ssh-mux). Đây là lý do "biết port nào thuộc agent nào" thay vì `ssh -L` mù.
2. **Tách request/apply qua high-water mark** (`request.rs::settle_to/ack_mark/consume_through` + `local_agent.rs::RemoteRequests`): bên remote không thể bind port máy local → ghi `requests.json`; local agent poll qua master SSH riêng, áp dụng, ghi lại `requests.acked` = **một số nguyên duy nhất**, thay bằng temp+mv từ shell (không thể lấy lock crate từ shell). Mọi lần đọc queue đều fold ack vào (`settle_to`), nên `list/status` bên remote không báo request đã apply là "đang chờ", và agent restart không mở lại port user đã stop. Request fail (port bị chiếm) **không** settled — stays pending, retry tới khi TTL expire. `id` là idempotency key: `id <= last_consumed_id` là replay, drop. Forward-compat: mọi field `#[serde(default)]`, `open_url` skip khi None → reader cũ parse writer mới.
3. **Placement inference** (`actions.rs::locate`): env override > mirror prefix trên workspace label > control master đang sống trên máy này > workspace nào trên server có mirror prefix > default là remote ("assumed"). `status` in cả reason (`local (live control master)`).
4. **Cùng số port, không tự đổi** (invariant 1): local = remote port vì "printed URL is the point" (Vite HMR, OAuth redirect_uri embed port). Conflict → báo tên process giữ port, remap chỉ khi user gõ `--local-port`. `mapping()` in `(remapped; URLs that embed the port will not work)`.
5. **Automation 3 mức, im lặng không bao giờ mặc định**: L1 explicit (click → confirm pane, phải nhấn enter; `confirm_on_click=false` mới one-motion) / L2 offer (notification toast chứa **chính xác lệnh** `herdr-portfwd add 5173` vì toast không có callback/accept key — offer là "một câu", accept là L1) / L3 auto opt-in per-workspace `[[auto]]`. Mỗi port offer 1 lần, tới khi listener mất rồi quay lại. L1 đè lên port L2/L3 đã mở = **pin** (`state.rs::promoted`) — reconcile sau đó không gỡ.
6. **Record ≠ port; Liveness 3 giá trị** (`Liveness::{Live,Missing,Unknown}`): forwards.json chỉ nói forward *nên* tồn tại; sống/chết hỏi bằng bind port, chỉ máy bind mới trả lời được → bên remote hiển thị `not checked` thay vì đoán. Header đếm theo tally (`2 live, 1 not live`) không theo `rows.len()`.
7. **Kỷ luật state file** (`state.rs::JsonFile`): lock file **riêng** (data file bị rename dưới nó), temp+fsync+rename+fsync-dir; unreadable → `Damaged` + refuse (không move file của người khác: "may hold every record it has"), understood-not-ours → quarantine `.corrupt`; `requests.acked` unreadable đọc là 0 vì mark chỉ có thể *xóa* request — hướng an toàn là "chưa apply".
8. **Event hooks cho reconcile, không poll pane output**: `workspace.focused/pane.exited/pane.closed` → reconcile drop record pane/host đã mất; reconcile merge theo invariant 2: chỉ overrule record còn giống hệt lúc đọc, để add/stop land giữa chừng không bị mất.
9. **Fact về Herdr platform** (ARCHITECTURE facts 4,8,9,10): keybinding plugin_action không fire dưới `--remote` mặc định → mọi action phải chạy được không cần key (link_handler + `herdr plugin action invoke`); loại command chỉ biết qua env `HERDR_PLUGIN_ACTION_ID/ENTRYPOINT_ID/EVENT` (is_terminal không tin được); đúng 1 popup slot, popup không tự close → pane truyền data qua `herdr plugin pane open --env KEY=<json 1 dòng>`; pane mở pane khác phải hỏi **trước khi** exit, popup→popup dùng `--placement overlay`.
10. **Trait seams**: `SshRunner`, `HerdrClient`, `UrlOpener`, `LocalPorts` — không test nào chạm ssh/herdr/browser/network thật.

## Áp vào herdgate (checklist)

**Ưu tiên cao**
- [ ] Port attribution per Pi session: publisher mỗi máy đã observe Pi sessions — thêm bước `lsof/ss + ps ppid-map` (port `discover.rs::attribute`/`ProcessTree::ancestry`, cycle-guard + depth-cap + pid=0 filter) để gắn listening port vào session/pane → PWA Jobs/Usage hiển thị "ports của job này", mobile mở đúng dev-server. Giải đúng bài "URL localhost agent in ra vô nghĩa trên máy khác".
- [ ] Request/apply + high-water mark cho mọi queue cross-machine của herdgate khi applier không link được code writer (SSH/shell): pattern `requests.json` + `requests.acked` (1 integer, rename, monotonic, fold vào mọi read, fail không settle). Khớp triết lý receipts JSONL one-id hiện có — bổ sung chiều ack-back.
- [ ] `StateError::Damaged`-style discipline cho receipts/registry: file đọc không được → refuse + tên file, không bao giờ default() thành "rỗng"; quarantine chỉ khi hiểu được bytes không phải của mình; temp+fsync+rename cho mọi JSON state.
- [ ] Liveness 3 giá trị cho records (spawn registry, forwards nếu thêm): record là intent; sống/chết hỏi process/port ở đúng máy; bên không check được in "not checked", đếm theo tally.
- [ ] Notification = câu chứa lệnh chính xác (L2 pattern): PWA push/notify cho event (port mới, job xong) nên kèm deep-link/lệnh copy-paste được, vì toast không callback.

**Ưu tiên trung bình**
- [ ] Semantics pin: tương tác explicit của user lên thứ tự auto/detected → promote record thành explicit, lifecycle sweep không gỡ; chỉ một chiều.
- [ ] Same-port-no-renumber + conflict report nêu tên process giữ port, nếu herdgate làm port-fwd/preview tunnels cho dev server.
- [ ] Offer mỗi port một lần + re-offer khi listener biến mất rồi quay lại (tránh toast spam mỗi poll).

**Ưu tiên thấp**
- [ ] Placement inference đa tầng + override env (herdgate relay biết rõ topology, ít cần suy đoán); confirm pane UI (PWA/mobile không dùng pane); facts về Herdr keybinding/popup slot (chỉ relevant nếu herdgate làm Herdr plugin).

## KHÔNG nên học

- **SSH ControlMaster + OpenSSH-only làm transport**: herdgate đã có gate VPS + cloudflared; thêm master SSH/host SSH probing mỗi tick (`ssh cat requests.json`) là chồng transport thứ 3, brittle version-skew (repo tự viết shell probe 4 đường dẫn candidate cho plugin cũ).
- **Poll 5s cố hữu**: bị giới hạn `PLUGIN_HOOK_EVENT_KINDS` của Herdr (không hook được pane output) — herdgate publisher có thể event-driven trực tiếp, đừng copy polling.
- **macOS/Linux only + lsof/ss/ps per-platform + binary Rust fetch theo platform** (scripts/install.sh): không khớp stack Node của herdgate.
- MIT license — dùng ý tưởng OK, không copy code tùy tiện (giữ attribution nếu port code).

## File đã đọc

README.md (599 dòng, full); herdr-plugin.toml; docs/ARCHITECTURE.md (~500 dòng, full); src/discover.rs (`attribute`, `ProcessTree::{ancestry,descends_from}`, `parse_lsof`, `parse_ss`); src/context.rs (`resolve_host`, `HostSource`, `parse_context`); src/actions.rs (`locate`, `Placement/PlacementReason`, `placement_override`); src/request.rs (`Request`, `Queue`, `RequestLog::{enqueue_opening,pending,consume_through}`, `settle_to`, `ack_mark`); src/state.rs (`JsonFile::{open,read,update}`, `write_atomically`, `quarantine_path`, `promoted`); src/ssh_process.rs (`master_argv`, `forward_argv`, `cancel_argv`, `check_argv`, `verify_control_path`); src/local_agent.rs (`RemoteRequests`, `REMOTE_REQUESTS_COMMAND`, `remote_mark_command`, `Agent::{step,run,delay}`, `clamp_remote_bind`, `offer_notification`); src/main.rs (`reconcile`, `placement_label`, `mapping`, `render_add`); Cargo.toml; src/lib.rs, src/types.rs, src/cli.rs, src/ssh.rs, src/config.rs (skim cấu trúc). Tổng 16 file nguồn thật qua raw.githubusercontent.com.
