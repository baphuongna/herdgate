# pi-herdsman — ĐÀO SÂU TOÀN REPO + bộ có thể học (2026-11-23)

Đối tượng: `github.com/boadij/pi-herdsman` @ v0.53.0 (HEAD #1106). Đã đọc: 42/42 ADR nguyên văn, 31 trang docs
(concepts/reference/guides/development), 28 module nguồn (đọc nguyên văn các module nhỏ, đọc theo cơ chế các
module 4k–12k dòng), 47 file test (cấu trúc + tên test), scripts, CI, docker, installer, skills, `.pi/*`.
Tài liệu ngắn (tổng quan quản trị): [STUDY.md](STUDY.md). Văn bản này là bản đào sâu.

---

## 0. Bức tranh bằng số

| Thước đo | Giá trị | Đọc gì từ đó |
|---|---|---|
| Lịch sử | 733 commit / 11 tuần (từ 2026-09-07), ~75 commit/tuần, **một tác giả chính** (594) + bot (renovate 34, release-please 94) | quy trình một người + agent, gần như toàn bộ do AI viết, người review |
| Release | **94 tag / 11 tuần** (~2/ngày), pre-1.0, release-please + Conventional Commit | nhịp "release nhỏ, liên tục" khả thi khi có CI simulated |
| Code | nguồn **68.7k** dòng · test **149k** dòng (47 file) · tỉ lệ test:source ≈ **2.2:1** | kiểm chứng là sản phẩm chính, không phải phụ |
| Kiến trúc | 42 ADR, mỗi ADR có Status, supersession chain ghi ở đầu file | quyết định có lịch sử, "lịch sử ≠ ngữ nghĩa hiện tại" |
| Docs | 31 trang ~7.5k dòng, phân 4 loại (concepts/guides/reference/development), 1 chủ sở hữu mỗi khái niệm | progressive disclosure + canonical ownership (ADR 0011) |
| Mô hình | 4 role (Lead/Manager/Chief/Agent) · 7 agent định nghĩa kèm · 5 coordinator profile · 13 agent tool · 9 staff tool · 1 supervisor · 3 peer · 5 lệnh | "nhiều cơ chế, ít khái niệm" |
| CI | 9 job: scope · format · validate (3 OS) · windows-bootstrap · package · container · **smoke simulated** · peer-federation (docker) · quality | chạy Pi + herdr THẬT với provider giả trong mỗi PR |
| Môi trường | pin pi 1.6.0 · herdr 0.9.5 (sha256 theo 4 platform) · node ≥ 22.19 | bootstrap tin cậy qua metadata npm |

## 1. Ranh giới hệ thống (mọc từ ADR 0002/0003/0008/0014 + coordination.md)

| Hệ thống | Sở hữu | Herdsman không làm |
|---|---|---|
| **Pi** | history, turn, model, session identity, `sendMessage` delivery | — |
| **herdr** | process/pane/tab/workspace, worktree, agent lifecycle (`agent list/get/wait/read`) | Herdsman không tự xoá pane khi không chứng minh được ownership |
| **Git** | branch, commit, ancestry | Herdsman không push, không tạo PR |
| **Mailbox (Herdsman)** | ack request, active/completed, pending ask, result | — |
| **Label** | tên logic của agent qua các generation | chỉ là control target của generation hiện tại |

- **Durable intent, derived runtime**: chỉ assignment/ownership/ancestry/exact-session là sự thật bền; pane/pid/placement
  là *quan sát*, tính lại từ bằng chứng tươi; mâu thuẫn → fail closed.
- **State nằm dưới `<agentDir>/pi-herdsman/`** (config.json, runtime/, assignments/, evidence, peers); chỉ lock + snapshot
  tạm ở OS temp (ADR 0007). Ghi atomic `write→fsync→rename→fsync(dir)`, thư mục `0o700`, file `0o600`.
- **Lock tiến trình** (`lock.ts`): claim dir `<sha256(target)>/<pid>-<uuid>` + **birth time của PID trên Linux**
  (`/proc/<pid>/stat` start ticks + boot id) chống PID tái sử dụng; stale → rename sang `.stale` rồi kiểm lại;
  release → rename sang `retired`, kiểm generation, mới unlink.
- **Build identity** (`compatibility.ts`): `version + sha256(dist/index.js)`; staff/peer khác build → `incompatible`,
  không có `available_tools` → fail closed. Mọi `list_staff` trả `self.build`.

## 2. Danh tính và quyền hạn (ADR 0003/0017/0021/0029/0035)

- Bốn danh dạng cố tình tách: **definition** (config) ≠ **label** (`^[a-z][a-z0-9_-]{0,31}$`) ≠ **Pi session**
  (UUID, exact) ≠ **herdr ids** (workspace/tab/pane/terminal/alias). Điều khiển cần mọi nguồn **đồng thuận**.
- `ProjectAssignment` là **duy nhất** nguồn quyền Manager; supervising ≠ owning Agent của Lead.
- Assignment handle = repo + branch gốc; **branch đang checkout là trạng thái Git mutable**, không phải identity (ADR 0035).
- `pi-herdsman-session-kind` là một custom entry bất biến trong session, đọc từ **mọi nhánh lịch sử** (ADR 0029).
- Trạng thái công khai là **hàm thuần** 6 tham số (core.ts): `(lifecycle herdr, activeRequestId, completionPending,
  handoffPending, waitingForOwner, recoveryPending) → working|blocked|settling|unknown` (+ `lost` chứng minh bởi
  inventory). `available_tools` là ảnh chụp **đủ điều kiện thử**, không phải bằng chứng receiver sẵn sàng.

## 3. Vòng đời Agent — phía owner và phía agent

**Launch (herdr.ts)**: `tab create --workspace --cwd --label --env… --no-focus` (hoặc `pane split --ratio`)
→ giữ `terminal_id` → **readiness marker**: `pane run <pane> "echo __PI_HERDSMAN_READY_<uuid>__"` và chờ dòng
marker → `pane process` lấy pid shell → mới khởi Pi với env `PI_HERDSMAN_MAILBOX/WORKSPACE_ID/DEPTH…`. Shell
chờ hỏi người → `pane_not_ready`; mẹo `HERDR_ENV=1` để tắt wizard/omz-update trong pane herdr.

**Nhiệm vụ vào agent**: bootstrap record (64 KiB) trong mailbox, kiểm `runId/ownerSessionId/workspaceId/label/build/
childSessionId`; request được bơm bằng `sendUserMessage(controlMarker(requestId), {deliverAs:"steer"})`.

**Kết thúc (agent side)**: `turn_end` ghi observation (`outcome`, text, `messageEntryId`, context %, model, thinking);
`agent_before_settle` chặn settle khi còn con chưa settle / result chưa persist; `agent_settled` → `writeResult`
đúng một lần; lỗi persist → `result_error` (giữ run/request/owner, đánh dấu retry unsafe, cleanup safe).

**Trả về owner**: inbox scheduler drain tại **3 biên** (`recipient-fan-in.ts`, 60 dòng): `before_agent_start`
(startup), `turn_end` (outcome completed) và `agent_before_settle` → trả `{continue:true}` để **tiếp tục turn** nếu
đã deliver; budget **32 mục / 256 KiB mỗi biên**. Gửi bằng `pi.sendMessage({customType, content, display, details},
{triggerTurn, deliverAs:"steer"})`, chỉ khi `ctx.isIdle()`.

**Health**: scan dự phòng 30s + event-driven; **stale** sau 10 phút không có tiến triển (streaming tool update
không tính); nhắc `5m → 2m30s → 1m15s → 1m`; `unknown` tối đa 1 lần/episode; `lost` lặp lại; `settling` không sinh
attention. Quyết định stale: đọc bằng chứng → (1 lần) chẩn đoán → steer → interrupt (thay steering chưa giao) → stop.

**Continuation** (ADR 0004): `continue_agent` = generation mới trên session cũ (cwd/definition/label từ history);
không `cwd` override; session đang có managed work → từ chối; definition mất → fail. Stop không bao giờ auto-restart.
Pi restore tự nhiên một transcript managed → **quarantine** (không chạy tool, không làm Lead).

## 4. Manager và project work

- **Assignment record**: `{version, id, repoKey, branch, text, checkoutPath?, piSessionFile?, resultBindings?,
  requiredEvidence?, gitBaselineSha?}`; file `assignments/<sha(repoKey)>/<sha(branch)>.json`; giới hạn 1 MiB.
- **Chỉ một Manager sống** cho một project scope (lease, `assignmentLockPath`); assignment sống qua Manager turnover.
- **`integrate_branch`**: chọn theo handle branch, kiểm `expected_head` full SHA, source+target clean, hoàn tất
  handoff khớp revision, **không có execution đang treo**; `ff-only` hoặc `"divergent"` có preflight → `needs_update`
  (không đụng checkout), `blocked`, `complete`, **`cleanup_pending`** (nói thật một nửa; retry cùng SHA); chứng minh
  tích hợp bằng `git merge-base --is-ancestor <accepted> HEAD` — **không** bằng việc branch biến mất.
- **Retire** khi: herdr `worktree remove` thành công HOẶC inventory Git đầy đủ chứng minh checkout vắng (ADR 0019);
  workspace đóng ≠ worktree mất; inventory lỗi/gián đoạn → giữ. Retire = đổi tên atomically sang pending-context
  (ADR 0023), **commit-before-cleanup** (ADR 0022), xoá message theo `fromSessionId`.
- **Xoá worktree cần người duyệt**: model chỉ ghi *intent* (versioned entry trên session branch, ADR 0031) → người
  gõ `remove` (hoặc repo pre-authorized) → herdr remove không `--force`; gõ `forget <branch>` cho legacy (ADR 0033).
  **Hoàn thành/review/im lặng không phải là đồng ý.**
- Merge quyền hạn **tách khỏi** quyền cấu hình (ADR 0040): user cấu hình repo policy trước khi có Manager.

## 5. Thông điệp và bằng chứng (ADR 0001/0005/0025–0028/0036)

- `files` là **kênh duy nhất** chuyển bằng chứng qua biên; không kế thừa hội thoại. UTF-8 đầy đủ hoặc **từ chối**
  (ADR 0027) — path-only không tính là đã giao.
- **Tham chiếu ngữ nghĩa model-facing**: `result:<label>#<index>`, `evidence:<name>#<index>`; UUID chỉ nội bộ;
  alias không tồn tại; xung đột → fail closed (ADR 0001). `read_evidence` đọc trong ownership root.
- **Required evidence**: task của `delegate_work` → `project-brief.txt`; `retain:true` trên `message_staff/
  resume_work/delegate_agent`; snapshot bất biến ≤1 MiB; **chỉ Manager** thêm/xoá yêu cầu project (ADR 0026);
  con cái nhận **snapshot** của tập yêu cầu, không nhận cập nhật sống (ADR 0028: mặc định liệt kê bằng tham chiếu,
  không nhúng).
- Giới hạn: inline 128 KiB/file, mailbox 1 MiB, record 8 KiB (body lớn tách riêng, kiểm hash trước khi giao),
  `notify_owner` tối đa 8 chưa xác nhận, `await_owner` là **tool gọi duy nhất trong turn**.
- Tool **tách theo thao tác** (ADR 0006): không multiplex; không alias tương thích cũ.

## 6. Definition engine (ADR 0015/0018/0034/0037–0039/0041/0042)

- Markdown + frontmatter; trường: `name enabled description model thinking systemPromptMode bodyMode noTools
  noBuiltinTools tools excludeTools permission noSkills inheritSkills skills noExtensions extensions agents
  inheritProjectContext inheritGlobalContext inheritAncestorContext`.
- Lớp: **bundled < global(`<agentDir>/agents|coordinators/`) < trusted project(`.pi/…`) < private repo
  (`<git-common-dir>/pi-herdsman/…`)**. Hai namespace anh em `agents/` và `coordinators/`; Chief chỉ global.
- Reserved profile (`flexible-lead`, `orchestrator-lead`, `managed-lead`, `manager`, `chief`) bị loại khỏi roster
  delegate được; `managed-lead` mặc định **không có tool thường** (`tools: []`), tool điều khiển bắt buộc được inject
  và bảo vệ khỏi exclude; resolution lúc launch, không hot-reconfigure.
- **Definition = chiến lược; runtime = hợp đồng**: body chỉ mô tả chuyên môn/ưu tiên, không định nghĩa ngữ nghĩa tool;
  thay body không được làm mất nghĩa vận hành. `cwd`/`model` override là **opt-in global**, model theo `allowedAgentModels`,
  xác thực lại ngay trước launch; `cwd` khác → Pi `--no-approve`.

## 7. Peer federation (peer.md, peer-transport.ts, bin/peer-bridge.ts, docker/)

- Presence: một record private `runtime/peers-v2/peers/` kèm `{pid,id}` claim của lock; chết/không khớp → bỏ qua;
  enrichment (repo/branch/label) bất đồng bộ; Chief không publish. **Presence là quan sát, không phải quyền.**
- Remote: cần route SSH không tương tác (strict host-key), `pi-herdsman-peer` bridge nhận durable qua stdin,
  corresponding để trả lời mà không cần SSH ngược; khác build không nói chuyện được (#688), initiation hai chiều (#790) còn mở.
- Docker: image ghcr, **SSH port 2222 → 22**, volume `home` + `ssh`, sidecar Tailscale tuỳ chọn — không có web terminal.

## 8. Nguyên tắc thiết kế giao diện cho model (instruction-interface-design.md, 15 nguyên tắc)

1. Giảm gánh nặng quyết định của model: thứ hệ thống biết thì **suy ra/đặt mặc định**, không hỏi.
2. Salience: việc hiện tại + ràng buộc ở **cuối** ngữ cảnh (Lost in the Middle), không viết lại prefix (ADR 0009).
3. Một bất biến, một nghĩa; nhiều nơi nhắc lại được nhưng phải chung nguồn.
4. Coordination phải **hội tụ**: ra quyết định/blocker/hoàn tất, không đẻ thêm coordination; không polling.
5. Definition body chỉ là chiến lược; hợp đồng vận hành thuộc runtime.
6. Sửa ambiguity **tại nguồn**: xoá > cấu trúc hoá > validate > mới tới prose.
7. **Cấu trúc thay lời**: tool availability, schema, ownership, `available_tools`, mặc định.
8. Tool ưu tiên expose `direct` để compose qua Code Mode.
9. Hướng dẫn chung **không phụ thuộc roster**; description = hướng dẫn chọn khi delegate, không hàm ý quyền.
10. **Steering tích cực**: mô tả hành vi mong muốn trước; `never/forbidden` chỉ cho bất biến thật.
11. Hợp đồng model-facing là **một hệ thống** (prompt + schema + state + lỗi + docs).
12. Ít khái niệm, ít tham số, ít trạng thái, ít ngoại lệ.
13. Giảm gánh **tham chiếu** model phải gõ (ref ngắn, ổn định; không path/UUID).
14. Không tích luỹ **hướng dẫn phòng vệ**: lỗi của model là bằng chứng để điều tra hợp đồng, không phải thêm câu.
15. Đánh giá thay đổi theo **độ phức tạp của hệ thống còn lại**.

## 9. Quy trình phát triển (AGENTS.md, validation.md, scripts, CI)

- **Evidence-gated simplification**: diagnostic là bằng chứng, không phải yêu cầu sửa; trace caller → root cause →
  ưu tiên xoá/gội/dùng native → đổi khi chứng minh được → kiểm bằng check nhỏ nhất.
- **Thứ tự validation**: typecheck → lint `--deny-warnings` → test → **format là phép biến đổi nguồn CUỐI** → chỉ
  `format:check` + `git diff --check` trước commit. Test runner: `node --test` + module-mocks, **deadline 360s**,
  process group tách (POSIX) / `taskkill /T /F` (Windows), rò rỉ descendant = fail.
- **Hai tầng kiểm chứng**: (a) unit/integration với **fake Pi/fake herdr** trong process (`support.ts`: `fakePi`,
  `fakeContext`, stub `herdr agent list/get`…), (b) **smoke simulated**: Pi + Herdr thật chạy, model là `fauxProvider`
  của pi-ai, 10 kịch bản (core, continuation, chief-tree, supervisor-agent, terminal-failure, agent-terminal-failure,
  manager-handoff, manager-merge, agent-crash-recovery, deep-chain) + `manager-recovery` chỉ live; cô lập session
  dir + XDG herdr cho mỗi lần chạy.
- **ci-scope**: path lạ → **nhiều validation hơn**, chỉ thu hẹp khi chi phí lặp lại chứng minh.
- **ADR**: ghi ở đầu file supersession chain; docs hiện hành chỉ mô tả hành vi hiện tại; ADR là lịch sử.
- **Release**: release-please + Conventional Commit; quy trình agent **draft (read-only) → review → authorize once
  (reply mẫu `Squash: yes / Body only: yes / No other writer: confirmed`; im lặng ≠ đồng ý) → ship agent chỉ làm
  đúng phần được duyệt → báo cáo kết quả tách biệt**, kể cả một phần thất bại. Có AGENTS.md **public-disclosure
  safety** ở đầu (redact, giữ attribution Git).
- **Skills**: `agentic-system-audit` (692 dòng — audit toàn hợp đồng agentic: 3 lens, ma trận cross-surface, taxonomy,
  verdict); `simplification-audit` (knip + jscpd, read-only); `testing`; `contributor-credit`; bundled skills
  `herdsman-guide/agent-definitions/agent-specialization-audit/machine-pairing`.
- **Phân phối**: `npm view pi-herdsman@latest --json` làm manifest bootstrap → đọc `piHerdsman.runtime.{pi,
  herdr.version, herdr.sha256.<platform>}` → cài pi + herdr pin, kiểm sha256; `pi install npm:pi-herdsman`;
  `herdr integration install pi` (agent-state hook v9 — máy ta đã có).

## 10. Herdsman so với herdgate — ma trận năng lực

| Năng lực | Herdsman | herdgate hôm nay |
|---|---|---|
| Subagent có ownership, result exactly-once, continuation | ✅ | ◐ `pi-spawn` + receipts (wave: 3/5 receipt `failed` dù DONE) |
| Manager branch-scoped, integrate, retire, worktree approval | ✅ | ◐ controller tay (tôi) |
| Wake owner tự động khi idle, không polling | ✅ | ✗ `send_text` nudge + poll `pane list` |
| Guardrail bằng definition (tools/model/cwd) | ✅ | ◐ brief lời + audit C18 |
| Health attention, stale/lost/unknown | ✅ | ◐ `pane.exited`, wedge guard |
| Usage/cost theo ownership | ✅ | ✗ (C17 chỉ đếm no-op) |
| **Loop tự vận hành / lịch / auto-pause** | ✗ | ✅ plugin/loop |
| **Audit hậu kiểm commit** | ✗ | ✅ C18 |
| **Trần chi phí / concurrency theo API key** | ✗ | ◐ rule "3 song song" (chưa cơ chế hoá) |
| **Mobile/PWA/relay/SSH edge, receipts per op** | ✗ (SSH/Docker only) | ✅ |
| Peer liên máy | ✅ SSH route | ◐ qua herdr pairing + relay herdgate |
| Chỉ Pi | ✅ | ✅ (cả experimental worker/MCP) |

---

## 11. TỔNG KẾT — BỘ CÓ THỂ HỌC (xếp theo lớp, kèm nơi tìm và cách dùng cho herdgate)

### Lớp 1 — Tư duy (áp dụng ngay, 0 code)

| # | Bài học | Nguồn | Dùng cho herdgate |
|---|---|---|---|
| 1.1 | **Định nghĩa ranh giới, không định nghĩa workflow**; 6 câu quyết định feature | README, product-philosophy | Mọi proposal C23+ phải trả lời 6 câu trước khi vào backlog |
| 1.2 | **Persist intent, derive runtime**; quan sát mâu thuẫn = fail closed, không đoán | ADR 0002/0003 | đã cùng hướng (state file-first) — viết thành bất biến trong AUTO.md |
| 1.3 | **Delivered ≠ tests passed ≠ accepted**; `cleanup_pending` nói thật một nửa | staff.md, ADR 0032 | loop log tách 3 trạng thái: `handed-off` / `validated` / `accepted` |
| 1.4 | **Im lặng ≠ đồng ý**; approval là reply mẫu tách 3 quyền | `.pi/prompts/release.md` | khi owner nói "release": in body + hỏi reply mẫu, không publish theo nhưng |
| 1.5 | **Lỗi của model là bằng chứng về hợp đồng**, không phải lý do thêm lời dặn | instruction-interface-design §14 | Vụ C11b (in token) → sửa cơ chế (C18) thay vì thêm câu guardrail — đã đúng |
| 1.6 | **Cấu trúc thay lời**; steering tích cực; `never` chỉ cho bất biến thật | §7, §10 | brief agent con: chuyển phần "KHÔNG…" sang allowlist/định nghĩa (P5) |
| 1.7 | **Coordination phải hội tụ**: không polling, kết thúc turn khi hết việc độc lập | §4, lifecycle.md | loop chỉ nudge khi có việc; no-op protocol (đã có C11c) |
| 1.8 | **Prefix ổn định, append-only**; task + ràng buộc đặt cuối ngữ cảnh | ADR 0009, §2 | DEV-LOOP.md đọc mỗi vòng: đặt backlog (việc hiện tại) **cuối** file — đã vô tình đúng |
| 1.9 | **Retire trước compaction**; việc mới = session mới + handoff file | ADR 0010/0004 | P4 |
| 1.10 | **Một bất biến một nghĩa**, sửa tại nguồn, xoá > cấu trúc > validate > prose | §3, §6, simplification-audit | dùng cho đợt gọn AUTO.md/DEV-LOOP.md kế |

### Lớp 2 — Hợp đồng (định nghĩa lại khái niệm trong herdgate)

| # | Bài học | Nguồn | Dùng |
|---|---|---|---|
| 2.1 | **4 danh tính tách biệt** (definition/label/session/herdr id) + điều khiển cần đồng thuận | agents.md, ADR 0029 | pi-spawn registry: thêm `piSessionId` làm khoá chính; tên chỉ là hiển thị |
| 2.2 | **State là hàm thuần** từ (lifecycle herdr, request active, pending flags) → 5 trạng thái an toàn | core.ts `agentControlState` | thay `armed/paused/exited` heuristic trong loop state bằng phép chiếu |
| 2.3 | **Delegation ≠ continuation ≠ steering**: 3 thao tác, 3 lane | ADR 0004, lifecycle.md | `task.mjs`: `steer` (deliverAs steer) cho agent đang chạy; `continue` chỉ khi idle/done |
| 2.4 | **Result là bản ghi durable delivered đúng một lần** (`ResultRecord`), có `result_error` | mailbox.ts, ADR 0001 | receipts: lưu `ResultRecord` trong state dir thay vì parse jsonl |
| 2.5 | **Tham chiếu ngữ nghĩa** `result:<label>#<n>`, UUID chỉ nội bộ | ADR 0001/0028 | receipts/handoff giữa các agent trong herdgate dùng ref ngắn |
| 2.6 | **`files` là kênh bằng chứng duy nhất**; UTF-8 đầy đủ hoặc từ chối | ADR 0005/0027 | brief + handoff là file; không "xem pane của agent kia" |
| 2.7 | **Assignment handle ≠ branch đang checkout ≠ session ≠ checkout** | ADR 0035 | worktree wave: ghi `expected_head` đầy đủ khi merge tay |
| 2.8 | **Definition = chiến lược; runtime = hợp đồng**; allowlist tools là cấu hình launch | ADR 0015, §5 | P5 |
| 2.9 | **Presence là quan sát, không phải quyền** | peer.md | roster C13/C16: `legs[]` chỉ để hiển thị, không để cấp quyền |
| 2.10 | **Build identity = version + hash bundle**, khác build không điều phối | compatibility.ts | laptop/home lệch version → op từ chối có lý do thay vì hành xử lạ |

### Lớp 3 — Cơ chế (code nhỏ, giá trị lớn)

| # | Cơ chế | Nguồn | Chi phí | Ưu tiên |
|---|---|---|---|---|
| 3.1 | **Owner-side inbox drain 3 biên** (`before_agent_start`/`turn_end`/`agent_before_settle` → `{continue:true}`), budget 32 mục/256 KiB | recipient-fan-in.ts (60 dòng) | S | **P2** — thay arming/send_text/poll của loop |
| 3.2 | **`pi.sendMessage(custom, {triggerTurn, deliverAs:"steer"})` chỉ khi `ctx.isIdle()`** | index.ts | S (gộp P2) | P2 |
| 3.3 | **`herdr agent wait <target> --until idle,done --timeout`** thay poll | herdr 0.9.5 CLI (Herdsman dùng `agent list/get`) | S | **P3** |
| 3.4 | **Readiness marker** `pane run "echo __READY_<uuid>__"` + `terminal_id` + pid shell | herdr.ts | đã có tương tự trong pi-spawn (arming) — ghi thành bất biến | — |
| 3.5 | **Process lock** claim dir `<pid>-<uuid>` + Linux birth time; stale→quarantine→verify | lock.ts | M | khi loop có >1 tiến trình cùng lúc (hiện 1/op) |
| 3.6 | **Atomic durable write** fsync file + dir, 0o700/0o600 | storage.ts | S | loop state.json (hiện write+rename, chưa fsync) |
| 3.7 | **Health attention lịch** `5m→2m30s→1m15s→1m`, stale 10 phút, unknown 1 lần | lifecycle.md | S | P7 (chi phí thật) đi kèm |
| 3.8 | **Usage theo ownership** từ Pi-native cost records | commands.md `/herdsman stats` | S–M | **P7** — trần chi phí C17 bằng số thật |
| 3.9 | **Fan-in + `notify_owner` ≤8 + `await_owner` sole-tool-call** | notify-owner.md, await-owner.md | S | agent con hỏi owner: 1 câu/turn, chặn đúng chỗ |
| 3.10 | **`integrate_branch` status set** `needs_update/blocked/cleanup_pending/complete`, chứng minh bằng `merge-base --is-ancestor` | lead/project.ts | M | script `scripts/integrate.mjs` cho controller tay (hiện làm tay) |
| 3.11 | **Build identity** sha256 bundle trong `loop.status`/hostInfo | compatibility.ts | S | P22 |
| 3.12 | **Faux provider smoke** (pi-ai `fauxProvider`) cho pi-spawn/loop e2e không cần API key | scripts/smoke-faux.mjs, CI smoke job | M | **P8** |
| 3.13 | **Concurrency gate theo key** (không có trong Herdsman) | — (bài học 429 của ta) | S | **P6** + đề xuất upstream |
| 3.14 | **Fresh session per cycle + handoff file** | ADR 0010/0004 | M | **P4** |

### Lớp 4 — Quy trình (PM/controller)

| # | Bài học | Nguồn | Dùng |
|---|---|---|---|
| 4.1 | **ADR có supersession chain**; docs hiện hành chỉ nói hành vi hiện tại | docs/adr, documentation.md | specs herdgate: thêm dòng "supersedes/superseded by" |
| 4.2 | **Format là bước biến đổi nguồn cuối cùng**; trước commit chỉ check read-only | validation.md | AUTO.md bước "verify" |
| 4.3 | **Test runner có deadline + process containment**; rò rỉ = fail | check.mjs, validation.md | `npm test` herdgate (~2 phút, 386 test) — thêm deadline 360s + kill group |
| 4.4 | **Hai tầng kiểm chứng**: fake-in-process (nhanh) + simulated smoke (thật) | support.ts, smoke-faux.mjs | P8 |
| 4.5 | **ci-scope: path lạ → nhiều validation hơn** | scripts/ci-scope.mjs | chưa có CI herdgate — ghi khi làm |
| 4.6 | **Release: draft → review → authorize once → ship → report tách biệt**; release-please | release.md, workflows | thay "READY-TO-RELEASE" bằng quy trình 5 bước có reply mẫu |
| 4.7 | **Public-disclosure safety** đứng đầu AGENTS.md | AGENTS.md | AUTO.md: thêm mục redact trước khi push (trúng C11b) |
| 4.8 | **Skill audit hợp đồng agentic** (3 lens, ma trận cross-surface, verdict) | .agents/skills/agentic-system-audit | **P9**: copy (Apache-2.0, giữ attribution) và chạy audit herdgate có cấu trúc thay đánh giá tay |
| 4.9 | **Simplification audit định kỳ** (knip + jscpd, read-only, worktree sạch) | .agents/skills/simplification-audit | chạy 1 lần sau wave |
| 4.10 | **Evidence-gated simplification** (6 bước) | AGENTS.md | áp cho mọi finding lint/audit |
| 4.11 | **Test tỉ lệ 2.2:1**, table-drive một bất biến, test ở tầng thấp nhất có thẩm quyền | AGENTS.md testing | NO TEST = NO MERGE (đã có) — thêm "test bền, không ghpin" (C19) |
| 4.12 | **Một tác giả + agent, 94 release/11 tuần** = nhịp khả thi khi CI simulated tồn tại | git log | lập KPI cho herdgate: release/ tuần khi có P8 |

### Lớp 5 — Phân phối & vận hành

| # | Bài học | Nguồn | Dùng |
|---|---|---|---|
| 5.1 | **Bootstrap qua metadata npm** (`piHerdsman.runtime.*`, sha256 theo platform) | install.sh, package.json | herdgate Windows installer: pin + sha256 herdr/node bundle (có `windows/node-runtime.mjs`) |
| 5.2 | **`HERDR_ENV=1`** để shell không hỏi trong pane | recovery.md | profile shell máy chủ (wedge/pane_not_ready) |
| 5.3 | **Docker SSH (2222) + volume + Tailscale sidecar** | compose.yaml, docker/ | mẫu cho VPS cutover Pha A (relay + SSH edge) |
| 5.4 | **Pin pi/herdr/node trong package.json** | package.json | herdgate: công khai `engines` + herdr min version trong hostInfo |

### Những gì KHÔNG học (và vì sao)

- **Không fork/build orchestrator riêng** — 68.7k dòng + 149k test, một tác giả; triết lý của chính họ: compose.
- **Không thay loop product/audit/mobile bằng Herdsman** — họ không có; đó là lợi thế herdgate.
- **Không copy multi-role (Chief)** — herdgate chưa cần tầng giám sát thứ ba; Manager (controller) + Agent đủ.
- **Không dùng SSH federation làm đường mobile** — herdgate có relay/PWA riêng tốt hơn.

### Lộ trình đề xuất (rút từ bảng trên, chờ chủ sở quyết định)

1. **P2+P3** (một vòng): extension Pi trong session dev-loop + `herdr agent wait` → xoá arming/send_text/poll.
2. **P7**: chi phí thật/cycle → auto-pause theo số thật.
3. **P1**: wave C23–C25 chạy qua Herdsman Manager thật (thử A) — nghiệm thu `integrate_branch complete` ≥2 branch + bảng so sánh chi phí với wave C17–C21.
4. **P8 + 4.3**: faux smoke + deadline cho `npm test`.
5. **P4**: session mới mỗi cycle.
6. **P9**: audit hợp đồng agentic có cấu trúc trên herdgate (skill của họ, Apache-2.0).
