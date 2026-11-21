# Pi worker — owned request runner (experimental prototype)

Bước 3 của lộ trình thu hẹp khoảng cách với Paseo: một **worker riêng** tiêu thụ queue
local và chạy từng request qua **Pi SDK thật** (không phải extension trong TUI, không
observer). Worker sở hữu admission idempotent, resume và fail-closed; nó **không** phải
scheduler và **không bao giờ gửi lại** một request đã admitted.

Trạng thái theo docs gốc: `WRITTEN → RESEARCHED → PROTOTYPE` — slice này đã được nghiệm
thu end-to-end qua Gate loopback (xem `test/pi-receipt-gate.test.ts`) và kill/restart
(xem `test/pi-worker.test.ts`).

## Kiến trúc

```
thiết bị (act) ──worker.submit──▶ publisher (HERDGATE_PI_WORKER=1) ──append──▶ jobs.jsonl (0600)
thiết bị (read) ──worker.status──▶ publisher ──read──▶ jobs.jsonl (không bao giờ trả prompt)
worker.mjs (chạy riêng trên host) ──drain──▶ Pi SDK session/workspace ──▶ receipts.jsonl
thiết bị ──receipt.get──▶ publisher ──▶ receipts.jsonl (như bước 2)
```

- `plugin/server/pi-worker.mjs` (SHIPPED, chỉ định dạng file): `jobs.jsonl` newest-wins,
  bound 16 KB/prompt, 100 job pending, `publicJob` strip prompt. Publisher **không chạy
  Pi** — nó chỉ append/đọc queue khi chủ host bật `HERDGATE_PI_WORKER=1` + đặt
  `HERDGATE_PI_WORKER_DIR` (mặc định `~/.local/state/herdgate/pi-worker`).
- `experiments/pi-worker/worker.mjs` (KHÔNG ship): drain queue theo thứ tự admission,
  một job một lúc, pid-lock một worker/host; mỗi job một **session SDK riêng** ghi JSONL
  audit dưới `<worker dir>/sessions`; receipt cùng định dạng journal của observer
  (writer dùng chung `experiments/pi-receipt/journal.mjs`).

## Bảo mật / ranh giới

- `worker.submit` **yêu cầu scope `act`** (nó mang prompt); `worker.status` và
  `receipt.get` đủ scope `read` vì chỉ trả metadata. Đúng UUID, không enumeration.
- Fail-closed khi restart: job kẹt `running` vì worker chết → `unknown/worker_restarted`
  (job + receipt), **không chạy lại** — duplicate id trong queue/ journal → trả
  `duplicate: true`, không append. Kill -9 giữa chừng không kịp ghi thì truy vấn sau
  là `unknown`.
- Provider: **`--real`** chạy model đã cấu hình của host Pi (đọc `auth.json` +
  `models.json` + model mặc định trong settings của user chạy worker — không ghi
  settings; sessions vẫn cách ly dưới worker dir). **`--fixture-dir`** chạy provider
  tổng hợp không mạng cho test. Hai flag loại nhau. `--tools` (opt-in) bật tools cho
  job — cùng mức tin với SSH bridge của thiết bị đã pair, nhưng tường minh;
  `--thinking low|medium|high` ghim mức suy nghĩ (mặc định: theo settings). Thiếu
  credential → job chốt `failed/pi_no_auth` fail-closed, worker không chết.
  `--job-timeout <giây>` (0 = tắt) chặn treo: stream treo quá hạn bị abort và chốt
  `failed/job_timeout` — khác abort của người (`canceled/aborted`) — rồi queue chạy
  tiếp job kế; job chạy đúng một lần, không retry/resend. Yêu cầu
  Pi tối thiểu `1.5.2` (floor qua `MIN_PI_VERSION`).
- **Đã nghiệm thu `--real` + tự khai sinh cha trên Windows (NTFS, node 22.14,
  Pi 1.5.2, 2026-11-21)**: job thật qua model host → `replied` 469 tokens/$0.00069,
  body 0600, self-register đầy đủ (parent `pi-worker`, `sessionFile` Windows path,
  status supersede theo verdict), scope case-insensitive hội tụ. Hai phát hiện
  Windows đã sửa trong worker: dynamic import absolute path phải qua `file://`
  URL; undici 8.12 của Pi đụng `zlib.createZstdDecompress` lúc load (node < 22.15
  chưa có) — worker tự shim trong tiến trình mình, không đụng cài đặt của ai.
- Receipt chỉ chứa `id/status/reason/entry IDs/sessionId`. Prompt chỉ nằm trong
  `jobs.jsonl` local 0600 và session JSONL của host.
- Worker có hai chế độ: **once** (mặc định — drain xong exit 0, không daemon, không
  scheduler, không listener mạng) và **rpc** (daemon JSONL trên stdio cho chủ host —
  xem dưới). Người chủ tự chạy nó (service/test/SSH) khi muốn.

## Định tuyến nhiều workspace (allowlist, fail-closed)

Mặc định mọi job chạy trong `--workspace` của worker. Chủ host có thể đặt bảng định
vọng **`workspaces.json`** (0600) trong worker dir:

```json
{ "v": 1, "workspaces": { "other": "/home/me/source/other-project" } }
```

Device gửi `worker.submit` kèm `workspace: "other"` (remote.mjs: `--workspace other`)
— chỉ TÊN, không bao giờ đường dẫn thô. Worker nạp lại allowlist mỗi pass (sửa live
được): tên hợp lệ → job chạy + ghi receipt trong scope workspace đó; tên lạ →
`failed/unknown_workspace` chốt ngay ở scope mặc định, không chạy, không gửi lại.

## Chạy daemon như service

`herdgate-pi-worker.service` (cùng thư mục) là template local cho chế độ rpc:
SIGTERM đi qua graceful path (abort job đang chạy thành receipt `canceled`),
`--idle-exit 3600` tự thoát khi hết việc.

## Chế độ rpc (daemon JSONL, bài học jsonl-rpc của Paseo)

```sh
node experiments/pi-worker/worker.mjs --workspace <dir> --fixture-dir <dir> \
  --mode rpc [--idle-exit 3600]
```

Một request JSON một dòng vào stdin, một response một dòng ra stdout:
`{"type":"response","id":…,"ok":true,"result":…}` (hoặc `"error"`). stderr là log chẩn đoán.

| op | ý nghĩa |
|---|---|
| `ping` | `{pong, pid, rpc, pi, uptimeMs}` — không tác dụng phụ |
| `stats` | queue/verdict counters, job đang chạy (chỉ id), scope |
| `drain {wait}` | kích hoạt một pass drain; `wait:true` chờ xong (op dài) |
| `steer {text}` | **chỉ khi đang chạy job**: `sendUserMessage` vào session đang chạy; hàng đợi headless được flush thành turn theo sau trong cùng job |
| `abort` | **chỉ khi đang chạy job**: `session.abort()` → receipt `canceled/aborted`; response trả SAU khi verdict ghi xong |
| `shutdown` | graceful: abort job đang chạy, nhả pid-lock, exit 0 |

Nguyên tắc bền vững (từ jsonl-rpc-process của Paseo): frame quá 64 KiB → **tiến trình
exit 3 thay vì bỏ frame** (mất state còn an toàn hơn desync); dòng rác → response lỗi,
không chết; EOF stdin / SIGTERM / SIGINT → graceful shutdown; queue tự kích hoạt pass
mới khi rảnh (watchFile). Session tạo/hủy mỗi job nên "idle cleanup" ở đây là chính
daemon: `--idle-exit <giây>` thoát graceful khi hết việc.

## Dùng thử

```sh
# phía host: publisher đã chạy với HERDGATE_PI_WORKER=1, HERDGATE_PI_WORKER_DIR=...
node experiments/pi-worker/remote.mjs --gate https://gate.example.com \
  --device d_act --secret <secret> --submit "brief" [--id <uuid>] [--workspace <tên>]

# host chạy worker (fixture):
node experiments/pi-worker/worker.mjs --workspace /path/to/ws --fixture-dir /tmp/fx
node experiments/pi-worker/worker.mjs --workspace ... --check   # chỉ kiểm Pi/queue wiring

# hỏi kết quả (read scope đủ):
node experiments/pi-receipt/query.mjs --gate ... --device d_read --secret ... --id <uuid>
node experiments/pi-worker/remote.mjs --gate ... --device d_read --secret ... --status <uuid>
```

## Scheduler, heartbeat, MCP (bước 4, prototype)

- `scheduler.mjs --config <schedule.json> [--once|--loop <s>] [--now <ms>]`: enqueue
  prompt theo lịch **deterministic** — một job mỗi (schedule id, time bucket), run ID
  suy ra từ bucket nên restart `--once` (cron/systemd timer) không bao giờ chạy trùng.
  Mỗi tick ghi heartbeat (`heartbeat.json`) mà publisher phục vụ qua op `worker.health`
  (read scope): queue depth + heartbeat gần nhất (`ts/source/ageSeconds`), thiếu thì
  `null` — fail-closed. Không gửi lại run failed/unknown.
- `mcp.mjs --gate --device --secret`: MCP stdio server (JSON-RPC newline) nối **OUT**
  tới Gate, không listener. Tools: `herdgate_worker_submit` (act), `herdgate_worker_status`,
  `herdgate_receipt`, `herdgate_receipt_wait` (chờ settle push, timeout trả trạng thái
  hiện tại), `herdgate_receipt_body` (reply đã lưu; bật `HERDGATE_PI_RECEIPT_BODY=1`
  cho worker để lưu và cho publisher để phục vụ), `herdgate_worker_health` (read). Dùng được từ bất kỳ MCP client nào
  (kể cả Pi qua cấu hình MCP).

Cả hai đều đã nghiệm thu E2E loopback trong giai đoạn scheduler và MCP của
`test/pi-receipt-gate.test.ts`: bucket lặp lại không trùng, bucket kế tiếp enqueue mới,
health đúng depth + heartbeat, MCP handshake/tools/list/tools/call đủ 4 tool, read
scope bị `requires-act`.

## Đã nghiệm thu (loopback, Linux)

- Submit từ device frame khi **không có TUI**: `queued` → worker drain → `receipt.get`
  trả `replied` cùng entry IDs; session TUI không bị ảnh hưởng (provider TUI vẫn đúng
  số call cũ).
- Duplicate id qua Gate → `duplicate: true`, không chạy lại.
- Submit khi worker tắt → job nằm queue; khởi động worker sau → chạy (queue bền).
- SIGKILL worker giữa provider call → restart: job kẹt thành `unknown/worker_restarted`,
  job kế tiếp trong queue vẫn chạy; request bị giết **đúng 1 lần** call.
- Worker thứ hai từ chối chạy khi pid còn sống.

## Chưa làm (thuộc slice sau)

- Đã có `--real` (model host, đã nghiệm thu live: glm-5.3 thinking low, 435 tokens,
  $0.0006, body 0600) — còn: policy tools chi tiết (allowlist tool thay vì all/none),
  push/subscribe khi receipt đổi, PWA act UI. **Đã đánh giá
  `@earendil-works/pi-durable`** (`DURABLE_EVAL.md` + probe runnable): crash giữa
  turn → resume → job hoàn tất với đúng 1 retry, nhưng không phải drop-in (harness
  riêng, transcript khác, đổi semantics fail-closed) — giữ SessionManager cho job,
  pi-durable là ứng viên cho scheduler/daemon quanh worker.
  Restore-by-file đã chạy end-to-end trên BOTH: Linux (split-pane) và Windows (tab riêng qua herdr 0.9.4-preview, transcript thật load trong TUI — ↑461 ↓12 $0.001, đúng prompt/reply của job).
- **Tự khai sinh cha**: mỗi job tạo session với id chính là job id
  (`SessionManager.create(…, {id})` — SDK hỗ trợ sẵn) rồi tự ghi vào registry
  spawn (`experiments/pi-spawn`) với `parentSessionId: 'pi-worker'` kèm đường dẫn
  transcript; verdict settle cập nhật lại bản ghi. Nghiệm thu live: job thật
  `--real` → `spawn.mjs restore job-<id>` mở đúng transcript đó trong TUI
  (restore ưu tiên `--session <file>`; `--session-id` trần sẽ tạo session rỗng
  trùng id — bẫy đã bắt được lúc live).
