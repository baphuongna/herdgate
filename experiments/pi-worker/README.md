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
- Prototype chỉ chạy provider **fixture** (`--fixture-dir`, không mạng, không tool,
  không extension); yêu cầu Pi tối thiểu `1.5.2` (floor qua `MIN_PI_VERSION`, bản mới hơn
  chạy không đổi code). Wire provider thật là slice sau.
- Receipt chỉ chứa `id/status/reason/entry IDs/sessionId`. Prompt chỉ nằm trong
  `jobs.jsonl` local 0600 và session JSONL của host.
- Worker là binary một-lần-drain (drain xong exit 0) — không daemon, không scheduler,
  không listener mạng. Người chủ tự chạy nó (service/test/SSH) khi muốn.

## Dùng thử

```sh
# phía host: publisher đã chạy với HERDGATE_PI_WORKER=1, HERDGATE_PI_WORKER_DIR=...
node experiments/pi-worker/remote.mjs --gate https://gate.example.com \
  --device d_act --secret <secret> --submit "brief" [--id <uuid>]

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

- Provider/tool thật cho worker (hiện fixture-only, `noTools`), multi-workspace routing
  (một worker/host), push/subscribe khi receipt đổi, PWA act UI, và đánh giá
  `@earendil-works/pi-durable` cho session durable thay SessionManager thường.
  Windows chưa nghiệm thu.
