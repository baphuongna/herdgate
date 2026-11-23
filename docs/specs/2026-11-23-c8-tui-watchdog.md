# Spec C8 — Watchdog publisher TUI Windows (lock model run-id, KHÔNG bump riêng)

Ngày: 2026-11-23 · Vòng: DEV-LOOP C8 · Nối theme C7 (serve path) sang nhánh còn lại.

## Lý do chọn theme này (bỏ lựa chọn "Jobs/results phong phú")

- C7 đóng gap serve path (supervisor pidfile model); nhánh **Windows TUI pilot**
  (`publish-tui start` → `startPublisher`) vẫn one-shot: publisher chết →
  lock `publisher-tui.lock` ở state `stale` **mãi mãi**, `start` lần sau
  early-return stale (exit 1) — user phải `stop` (reap) rồi `start` lại bằng
  tay. Trên laptop Windows không có systemd `Restart=always` để cứu.
- Lock model khác pidfile model nên C7 cố tình không đụng (spec C7 ghi rõ
  "lock model khác (wx run-id), cần spec riêng → backlog C8").
- "Jobs/results phong phú" vẫn là giá trị phỏng đoán — chưa có nhu cầu quan
  sát được; giữ nguyên backlog chờ bằng chứng.

## Khoảng trống (đã khảo sát code — plugin/server/publisher-tui-lifecycle.mjs)

- `startPublisher`: spawn child detached 1 lần (stdio → `publisher-tui.log`,
  crash evidence ĐÃ có), không ai canh; chờ `connected` ≤5s rồi thoát.
- Publisher chết: lock `{run, pid}` còn (SIGKILL/OOM — exit handler không
  chạy) → `stale`; hoặc lock biến mất (uncaught exception — exit handler VẪN
  chạy `release()`). Cả hai lớp đều không có ai respawn.
- `registerPublisher` ghi lock flag `wx` → child mới không thể đăng ký nếu
  lock stale chưa được reap đúng quy trình run-scoped.
- Stop an toàn dựa marker run-scoped (`publisher-tui-<run>.stop`) — không bao
  giờ signal theo pid (Windows tái sử dụng pid).

## Thiết kế

Nguyên tắc: **không đụng serve path của C7** (supervisor pidfile giữ nguyên);
đường tui có supervisor riêng trong chính module lifecycle, dùng **heartbeat
freshness** thay pid-liveness làm chuẩn sống-còn (pid Windows bị tái sử dụng).

### M1 — Supervisor process + log kế thừa + xoay vòng
- `startPublisher(dir, args, env)`:
  - xoay `publisher-tui.log` → `.old` (thay thế) khi > 512 KiB (như C7 M1).
  - heartbeat `publisher-tui.supervisor.json` `{pid, pollMs, at}`: claim bằng
    `wx`, steal khi stale/chết, refresh mỗi chu kỳ poll. "Còn sống" = pid sống
    **và** `at` tươi (< max(3×pollMs, 3s)).
  - spawn supervisor detached: `node publisher-tui-lifecycle.mjs --supervise
    <dir> -- <args…>`, stdio → log fd (supervisor + mọi thế hệ child kế thừa).
  - **Adopt-or-heal**: publisher đang `connected`/`connecting` (sống) mà chưa
    có supervisor → vẫn spawn supervisor để canh (không spawn đè child);
    lock `stale` → supervisor reap run-scoped rồi respawn (hết bẫy "phải stop
    trước khi start").
  - Vòng chờ kết quả: `HERDGATE_TUI_START_TIMEOUT_MS` (mặc định 10s) — trả
    `connected`/`connecting` như cũ, quá hạn throw đúng message cũ.

### M2 — supervise(): vòng poll của supervisor
- Knob env trùng tên C7 (một bộ thao tác thuật cho người vận hành):
  `HERDGATE_WATCHDOG_POLL_MS` (1000), `_MAX` (5), `_WINDOW_MS` (600000),
  `_BACKOFF_BASE_MS` (1000) + mới `HERDGATE_WATCHDOG_BOOT_TIMEOUT_MS` (15000).
- Mỗi tick: refresh heartbeat (kiểm quyền sở hữu trước khi ghi — thua quyền
  thì exit "spare"); thấy marker `publisher-tui.supervisor.stop` → dọn + exit 0.
  Trạng thái owner (`ownerOf`):
  - **không owner + đang chờ child đăng ký**: chờ; child chết trước khi đăng
    ký → tính death. Child sống mà im lặng quá BOOT_TIMEOUT → SIGTERM pid
    **của chính child mình spawn** (an toàn: pid từ spawn, chưa tái sử dụng).
  - **không owner + đã từng có lineage** (lock biến mất, không dấu stop):
    lớp crash "clean exit" (uncaught exception vẫn chạy exit handler) →
    respawn trong budget.
  - **owner run khác run đang canh**: adopt (log) — babysit luôn publisher
    bản cũ/foreground, không spawn đè.
  - **owner chết**: có stop marker của run đó → reap run-scoped + exit 0;
    không → death: reap (wx reap-marker, đúng nghi thức stopPublisher) →
    budget/backoff (1s ×2 ≤60s, reset khi sống ≥60s) → respawn child với
    **run-id mới** (child tự ghi lock wx mới).
  - **owner sống**: ổn; sống ≥60s reset thang backoff.
- Zombie-reap (bài học C7): giữ exit listener cho mọi child mình spawn.
- Vượt budget → log `giving up` + dọn marker + exit 1 — chết có dấu vết.
- Supervisor không đọc config/pairing (module lifecycle tự chứa; publisher
  child tự fail nếu mất pairing → vòng budget lo phần còn lại).

### M3 — stop & status trung thực
- `stopPublisher`: **stand down supervisor trước** — ghi marker
  `publisher-tui.supervisor.stop`, chờ heartbeat biến mất ≤10s; supervisor
  treo (vẫn tươi+sống sau 10s) → SIGTERM pid trong heartbeat rồi dọn marker
  mồ côi. Sau đó giữ nguyên nghi thức per-run stop như cũ.
- `publisherStatus` thêm trường `supervised: true|false` (additive; windows-cli
  `status`/`stop` in thêm trường này).

## Nghiệm thu (đo được)

1. Test tích hợp `test/publisher-tui-watchdog.test.ts` (process thật trên máy
   này, worker đăng ký lock thật — pattern publisher-lifecycle):
   a. **Respawn**: start → connected pid₁/run₁; SIGKILL pid₁ → connected lại
      pid₂≠pid₁, run₂≠run₁ trong 10s; `publisher-tui.log` có dòng exit +
      respawn của supervisor.
   b. **Stop đứng xuống cả supervisor**: stop → state `stopped`, heartbeat +
      supervisor-stop marker biến mất, không respawn trong 1.5×poll.
   c. **Budget**: MAX=2 → giết child 3 lần → supervisor `giving up` + tự exit
      (heartbeat biến mất), log có dòng tương ứng, không respawn nữa.
   d. **Adopt**: worker chạy sẵn (không supervisor) + start → pid không đổi
      (không spawn đè); giết worker → respawn.
   e. **Heal stale**: worker SIGKILL (lock stale, không supervisor) + start →
      connected pid mới (reap + respawn tự động).
2. Hai test publisher-lifecycle hiện hữu vẫn xanh (semantics start/stop giữ).
3. Full suite xanh tuyệt đối (baseline 315/0).
4. Live trên Windows thật: **trì hoãn trung thực** — laptop chỉ nhận code qua
   npm update, mà chính sách 2b cấm bump/publish trong vòng tự chạy. Ghi rõ
   trong Cycle Log; khi owner publish theme này (READY-TO-RELEASE) thì verify
   Windows-on-metal ở lần update laptop kế tiếp.

## Rủi ro & Mitigation

- **Version-skew window**: stopPublisher bản cũ (chưa biết supervisor-stop)
  chạy cạnh supervisor bản mới → 1 respawn thừa sau stop (bounded, tự ổn định
  khi stop lại bằng bản mới; cây shipped mang cả hai phía cùng version).
- **Windows pid reuse trong 1 chu kỳ poll** che một cái chết: chấp nhận như
  thiết kế stop run-scoped hiện có (không bao giờ signal theo pid trừ pid do
  chính supervisor spawn / pid trong heartbeat còn tươi).
- **Test chậm**: mọi deadline env-param, poll 200ms; tổng thêm < 45s.
- Serve path (C7) không đụng — hai supervisor hai model độc lập, mỗi bên chỉ
  lo cây state của mình (`publisher-tui.*` vs `publisher.*`).

## Không release riêng
Theo chính sách 2b: theme vận hành vừa-sized, commit + test, không bump.
Nếu nghiệm thu 1–3 xanh: ghi `READY-TO-RELEASE: tui-publisher-self-healing`
(chủ sở hữu review + publish — kèm verify Windows thật lúc update laptop).
