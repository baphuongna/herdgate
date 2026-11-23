# pi-herdsman — bài học cho herdgate (nghiên cứu 2026-11-23)

Nguồn đã đọc: clone `github.com/boadij/pi-herdsman` @ **v0.53.0** (HEAD #1106, 2026-11-23) — README,
AGENTS.md, `docs/concepts/*`, `docs/reference/{staff,agent,configuration}.md`, `docs/guides/project-orchestration.md`,
`docs/development/{product-philosophy,smoke-testing}.md`, 42 ADR (đọc kỹ 0002/0003/0004/0009/0010/0029/0032),
`extension/{index,herdr,mailbox,supervision,storage,lock,managed-agent-runtime}.ts` (đọc chọn theo cơ chế),
`extension/{agents,coordinators}/*.md`, `scripts/smoke-faux.mjs`.

---

## 1. Nó là gì

**Lớp điều phối giữa Pi và herdr** — "asynchronous Pi subagents and agent fleet orchestration". Cài là
pi package (`pi install npm:pi-herdsman` → extension + skills), Apache-2.0, pre-1.0, ~60k LOC source +
~150k LOC test, 1100+ PR, release gần như mỗi ngày. Pin **pi 1.6.0 · herdr 0.9.5 · node ≥ 22.19** —
trùng khớp máy này (pi 1.6.0, herdr 0.9.5, node 22.23.4, `herdr integration status` → pi current v9;
`herdr worktree {list,create,open,remove}`, `herdr agent wait` đều có).

Triết lý (AGENTS.md + product-philosophy.md): *"Define the boundaries, not the workflow"* — model tự quyết
định tách việc, delegate, chạy song song; Herdsman chỉ **ép quyền hạn, ownership, assignment, supervision**.
6 câu hỏi quyết định cho mọi feature: có phải bài toán điều phối? Pi/herdr đã giải chưa? có bằng chứng thật
chưa? primitive nhỏ nhất? phần còn lại nằm ngoài? có thể "unobtrusive until needed"?

## 2. Mô hình

| Role | Làm gì | Không được |
|---|---|---|
| **Lead** | session Pi bình thường; sở hữu Agent của mình (cây = *herd*) | — |
| **Manager** | điều phối project: giao **branch-scoped assignment** cho Lead trong worktree, `integrate_branch`, `remove_worktree` | không sở hữu Agent của Lead; không tự implement |
| **Chief** | giám sát Manager + Lead thường (một runtime herdr) | không có tool project |
| **Agent** | một assignment bounded cho đúng một owner; được lồng khi definition cho `agents` (`maxAgentDepth` mặc định 2) | không tham gia quyền hạn Manager/Chief/peer |

**Bốn danh tính cố tình khác nhau**: definition (config) ≠ label (tên logic qua các generation) ≠
Pi session (ngữ cảnh + identity continuation) ≠ herdr ids (workspace/tab/pane/alias — chỉ để chứng minh
physical ownership). **Bốn hệ thống trả lời bốn câu hỏi**: herdr = physical lifecycle · Mailbox =
ack/active/result/ask · Pi = history/turns · label = control target. Mọi thao tác điều khiển cần các nguồn
**đồng thuận**; thiếu/mâu thuẫn → **fail closed**, không đoán.

Trạng thái công khai là **projection an toàn để điều khiển**: `working · blocked(await_owner) · settling · unknown · lost`.
Coordination chỉ đi **một cạnh quyền hạn**: lên `message_supervisor`/result tự động · xuống `message_staff` ·
ngang `message_peer` · ownership `notify_owner/await_owner/reply_agent`.

## 3. Mười cơ chế đáng học — đối chiếu herdgate hôm nay

| # | Cơ chế Herdsman | herdgate hôm nay | Nhận xét |
|---|---|---|---|
| 1 | Chạy **như extension Pi trong session owner**; result/attention về bằng `pi.sendMessage({customType, content, display}, {triggerTurn:true, deliverAs:"steer"})` khi owner **idle** (inbox scheduler) → *"agent results resume the session automatically"* | loop plugin **ngoài Pi**: `send_text` nudge, arming, đọc `pane list`, `pane.exited` = chain-broke | API có từ pi 1.5.2 (floor của ta). Bỏ được toàn bộ heuristic pane |
| 2 | **Result exactly-once** (`ResultRecord`, delivery một lần, cleanup sau; `result_error` nếu không persist được) | receipts parse session jsonl + DONE marker tay | wave vừa rồi: 3/5 receipt `failed` dù DONE |
| 3 | **Delegation ≠ continuation** (ADR 0004): continue = generation mới trên session cũ; **không bao giờ relaunch Lead đang chạy** — dùng `message_staff` (steering lane) | `task.mjs continue` bị từ chối `competing_input` | bản năng đúng, thiếu lane steering tách biệt |
| 4 | **Work assignment theo branch** + `delegate_work`/`resume_work`/`stop_lead`/`integrate_branch(expected_head)` FF-only hoặc `"divergent"` có preflight `needs_update`, `cleanup_pending` nói thật một nửa; retire qua worktree removal | controller (tôi) làm **tay toàn bộ** trong wave C17–C21 (int worktree, FF, gỡ worktree) | Manager mode = đúng vai controller |
| 5 | **Guardrail bằng definition**: allowlist `tools`/`agents`, `cwd`/`model` override phải opt-in global, `pi.setActiveTools`, `noSkills/noExtensions`, `inherit*Context` flags | brief bằng lời + **audit hậu kiểm** (C18) | hai lớp **bổ sung** nhau; reviewer không có bash/edit là ép cứng |
| 6 | **Context**: ADR 0009 prefix ổn định (append-only, không rewrite giữa); ADR 0010 **retire session trước compaction ngưỡng** → handoff file, việc kế = Agent mới | dev-loop **một session** C1→C22, compaction nhiều lần | giải thích "bài học bị quên" giữa các cycle |
| 7 | **Event-driven, không polling**; attention `5m → 2m30s → 1m15s → 1m`, stale sau 10 phút, scan dự phòng 30s; `herdr agent wait --until idle,done` | poll `pane list` mỗi ~60s + cooldown | `herdr agent wait` có sẵn, chưa dùng |
| 8 | **Persist intent, derive runtime** (ADR 0002/0003): file-first, atomic `tmp+rename`, `proper-lockfile`, ambiguous → fail closed | cùng trường phái (state file-first, ownership, fail-closed) | đã đúng |
| 9 | **Evidence handoff bằng file**: `files`, `result:reviewer#2` (semantic ref), `retain:true`; inline 128 KiB, mailbox 1 MiB, record 8 KiB | brief là file `/tmp/hg-wave2/c1N.md`, handoff không có ref | nhỏ, đáng mượn |
| 10 | **Usage theo ownership** từ Pi-native token/cost (`/herdsman stats`) → chi phí thật; **không có** trần chi phí / concurrency gate (429 không xử lý) | C17 auto-pause + rule "tối đa 3 subagent" | ta đang có thứ họ chưa có |

Thử nghiệm của họ cũng đáng học: **smoke "simulated"** — Pi, Herdsman, herdr chạy thật, chỉ quyết định model
được viết kịch bản qua `fauxProvider` của pi-ai (có trong pi-ai 1.6.0 trên máy này); smoke "live" chỉ khi
cần kiểm instruction adherence. Kèm nguyên tắc validation: test nhỏ nhất trước, format là **phép biến đổi
nguồn cuối cùng** trước commit.

## 4. Herdsman không có — phần giữ làm lợi thế của herdgate

- Không **loop tự vận hành**/không lịch — Manager do người khởi động trong phiên; không auto-pause, không no-op protocol.
- Không **audit hậu kiểm** commit (C18), không **trần chi phí/concurrency** (C17 + rule 3 — 429 là bài học thật của ta).
- Không **mobile/PWA/relay/SSH edge**; federation = route SSH + herdr pairing; không receipts per-request cho từng op.
- Chỉ Pi. Pre-1.0, breaking changes thường xuyên; state ở `~/.pi/agent/pi-herdsman/`.

## 5. Ba lựa chọn

| | Làm gì | Được | Mất |
|---|---|---|---|
| **A. Dùng thẳng cho wave kế** | `pi install npm:pi-herdsman`; session ở primary workspace `/manager`; `delegate_work` 3 branch; `integrate_branch` FF-only | cơ chế 1–9 ngay, không bảo trì 60k LOC | thêm một hệ thống state; pre-1.0 |
| **B. Port cơ chế vào loop/pi-spawn** | P2/P3/P7 bên dưới | sửa đúng chỗ đau của ta, giữ ownership | làm lại một phần (nhưng nhỏ) |
| **C. Fork/build orchestrator riêng** | — | — | loại — trái triết lý "compose, don't own" |

**Khuyến nghị: A + B nhỏ.** Herdsman thay thế vai *controller tay* (tôi) cho các wave lớn; herdgate giữ
layer riêng (relay/mobile, loop product, audit, cap chi phí) và học mấy cơ chế rẻ. Thử A trên **một wave
thật** (C23–C25) với acceptance rõ, không cái gì được coi là đã học nếu chưa chạy.

## 6. Đề xuất backlog (CHƯA queue — chờ chủ sở quyết định)

| ID | Việc | Nghiệm thu |
|---|---|---|
| **P1** | Wave C23–C25 chạy qua **Herdsman Manager** thay `pi-spawn` (thử A) | `integrate_branch` FF `complete` cho ≥2 branch; log so sánh chi phí/vòng với wave C17–C21; một bài học "Herdsman vs pi-spawn" |
| **P2** | **Pi extension trong session dev-loop**: watch backlog/state, `sendMessage(..., {triggerTurn})` khi idle — bỏ arming/`send_text`/`pane.exited` heuristic | loop-plugin test: không còn path "pane.text" trong nudge; một cycle thật không cần `kick` tay |
| **P3** | `herdr agent wait --until idle,done --timeout` thay poll `pane list` trong loop plugin | test dùng stub herdr trả `wait`; log cho thấy 0 lần poll |
| **P4** | **Session mới mỗi cycle + handoff file** (ADR 0010/0004): DEV-LOOP.md/backlog/LOG là handoff, session dev-loop không sống > 1 cycle | soak 5 cycle: không compaction giữa cycle; token/vòng giảm so với C16–C22 |
| **P5** | **Definition cho subagent** (allowlist tools/model/cwd) + brief tách phần "authority" ra khỏi phần "task" | reviewer spawn không có `edit`/`write`; test release-shape |
| **P6** | **Concurrency gate theo API key** trong pi-spawn/loop (đếm agent đang running theo key, từ chối spawn thứ 4) | test: spawn thứ 4 bị từ chối có lời giải thích; **đề xuất upstream** cho Herdsman |
| **P7** | **Chi phí thật mỗi cycle** từ Pi-native usage (session jsonl) → `loop.log cost=…` + PWA `loop.status` | C17 auto-pause dùng số thật thay vì đếm no-op |
| **P8** | **Smoke simulated** cho loop/pi-spawn bằng `fauxProvider` (pi-ai) — Pi + herdr chạy thật, model viết kịch bản | một e2e không cần network/API key trong `npm test` |

## 7. Bài học vận hành ngay (không cần code)

1. **Không relaunch cái đang chạy** — steering là một lane riêng; "continue" chỉ khi idle (ta đã tự phát hiện, giờ có tên).
2. **Result là bản ghi durable, delivered đúng một lần** — không phải dòng texte trong pane.
3. **Handoff bằng file + session mới** khi việc đổi tính chất; để một session phình tới compaction là đánh mất guardrail.
4. **Câu "result delivered" ≠ "tests passed"** — Herdsman nhắc ở ba chỗ; loop của ta cũng phân biệt `work`/`no-op` nhưng chưa tách "handed off" khỏi "accepted".
5. Với mọi feature mới, hỏi **6 câu của họ** — nhất là "Pi/herdr đã có chưa?" (`herdr agent wait` là ví dụ vừa tìm ra).
