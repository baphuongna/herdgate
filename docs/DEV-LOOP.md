# DEV-LOOP — vòng phát triển tự vận hành của herdgate

> Protocol vận hành: mỗi vòng là **một chu kỳ SDD trọn vẹn**, không làm tạm bợ.
> Trạng thái vòng nằm ở cuối file này — lượt làm việc nào cũng đọc file này
> trước, nối đúng chỗ dừng, không hỏi lại user.

## Tự vận hành (auto-run)

- **`herdgate-devloopd.service`** (systemd user, chạy nền liên tục) dùng
  driver `~/.local/bin/herdgate-dev-loop.sh`: xong 1 vòng → breather 90s →
  vòng kế NGAY (không chờ timer).
- Mỗi vòng = 1 session `pi -p` mới với prompt `docs/DEV-LOOP/AUTO.md`:
  1 chu kỳ SDD trọn (spec → red → green → suite → commit → push).
- Van an toàn: exit nhanh (<10 phút: BLOCKED/việc gì) hoặc lỗi → cooldown
  30 phút (chống đốt token vòng lặp nóng); `timeout 4h` chặn session treo;
  cờ **`docs/DEV-LOOP/PAUSE`** ghì loop khi người làm việc trực tiếp trong
  repo (tạo file để pause, xoá để chạy lại).
- Guardrails AUTO.md: KHÔNG npm publish/tag (ghi `READY-TO-RELEASE`
  khi theme trọn — chủ sở liệu publish), KHÔNG đụng service/pane user,
  KHÔNG in token, đúng 1 vòng/lần.
- Theo dõi: `tail -f ~/.local/state/herdgate-dev-loop.log` và
  `journalctl --user -u herdgate-devloopd -f`. Dừng hẳn:
  `systemctl --user disable --now herdgate-devloopd`.

## Nguyên tắc bất biến (mọi vòng đều chịu ràng buộc)

1. **SDD đủ bước**: spec (acceptance rõ ràng) → design (đụng wire thì nêu
   frame-budget) → tasks → **test trước (red)** → implement (green) → full
   suite → **verify sống trên máy thật** → commit nhỏ, mesage thật →
   release/tag chỉ khi vòng đó có chủ đề release → cập nhật Cycle Log.
2. **Gate rules**: `read` không ghi; `act` cần `allowAct`; `unknown`
   fail-closed. Mọi op reply phải vừa khung `maxPayload` 256KiB
   (wire-budget shrink loop là mặc định cho mọi op trả dữ liệu lớn).
2b. **Chính sách release (chỉnh sau phản hồi user 2026-11-23)**: KHÔNG bump
   version theo từng vòng nhỏ. Mỗi vòng vẫn commit + test + verify sống, nhưng
   version/npm/laptop-update chỉ chạy khi (a) trọn một **chủ đề lớn** đủ giá trị
   người-dùng (ghi trong Cycle Log là theme nào), hoặc (b) user yêu cầu, hoặc
   (c) hotfix bảo mật/sự cố đang cháy production. Cỡ vòng cũng vậy: gộp các
   việc nhỏ liên quan thành một theme (1 vòng = 1 chủ đề dùng được, không phải
   1 regex).
3. **Self-contained**: `plugin/server` + `plugin/mirror` không import ra
   ngoài shipped tree (`test/release-shape.test.ts` canh).
4. **Không đụng tài sản user**: pane/tab/workspace của user không thuộc
   sở hữu plugin (ownership-by-label `M:<paneId>`, workspace `🏠 <room>`).
5. **Không in owner token**; probe device phải revoke + dọn sau verify.
6. **Trung thực nghiệm thu**: ghi nhận cả cái không đạt; "chưa đạt" được
   ghi vào log thay vì bị bỏ qua.
7. Test đầy đủ: `TEST_PI_BIN=$(which pi) TEST_HERDR_BIN=$(which herdr) npm test`
   (baseline tại lúc viết: **299 pass / 0 fail**).

## Protocol một vòng (10 bước)

1. Đọc Cycle Log cuối → xác định vòng tiếp theo trong Backlog (không hỏi user).
2. Viết spec `docs/specs/<ngày>-c<N>-<tên>.md`: bối cảnh, tính năng, tiêu chí
   nghiệm thu (đo được), thiết kế, kế hoạch test, rủi ro.
3. Sinh thay đổi backlog nếu spec làm lộ điều mới.
4. **Test trước**: viết test mới, chạy targeted → xác nhận red đúng chỗ.
5. Implement tối thiểu theo spec.
6. Targeted green → full suite xanh tuyệt đối.
7. Verify sống: home (source, restart service đúng vai) và/hoặc laptop
   (npm, qua drive script — `HG_VERIFY` chỉ cho lệnh ngắn, update dùng
   `HG_WAIT=75` + pre-clean `.setup`).
8. Commit (docs/impl tách commit), bump version + tag + npm publish nếu vòng
   có release; chờ `dist-tags.latest` flip rồi mới drive update từ xa.
9. Dọn rác probe (device revoke, temp file), cập nhật Cycle Log (đạt/chưa đạt).
10. Nếu còn giờ trong lượt: mở vòng sau từ bước 1. Dừng chỉ khi user báo dừng.

## Backlog (xếp hạng bởi PM — giá trị/ngày, rủi ro giảm dần)

| # | Vòng | Chủ đề | Giá trị | Trạng thái |
|---|------|--------|---------|------------|
| C1 | v0.9.43 | **Operability pack** | Cao | ✅ xong |
| C2 | v0.9.45 | **Predictive echo enable path** | Trung bình–cao | ✅ xong |
| C3 | v0.9.46 | **Security pass STRIDE** surface mới | Cao | ✅ xong |
| C4 | v0.9.47 | **Cadence thích ứng** (sysmon khi herdr lộ pid) | Trung bình | ✅ xong (sysmon vẫn chờ pid) |
| C5 | v0.10.0 | **Fleet control từ PWA** (theme 2b đầu tiên) | Cao | ✅ xong |
| C6 | — | **Review loop trọn vòng** (client-only) | Trung bình | ✅ xong |
| C7 | — | **Publisher watchdog** (serve path tự chữa) | Cao | ✅ xong |
| C8 | — | **Windows TUI publisher watchdog** (lock run-id riêng — nối theme C7) | Trung bình–cao | ✅ xong |
| C9 | nhu cầu | **Jobs/results phong phú** — chỉ khi có bằng chứng nhu cầu quan sát được; **EXCAVATION chọn lọc** (collie harness grammars, 5 repo Rust) vẫn parked | Tham khảo | parked |
| — | blocked | VPS cutover (việc user — `docs/plans/vps-cutover.md`); herdr > 0.9.5 lộ pid | — | blocked |

## Cycle Log

| Vòng | Ngày | Kết quả | Commit/Tag | Ghi chú nghiệm thu |
|------|------|---------|------------|--------------------|
| C1 | 2026-11-22 | ✅ xong — v0.9.43 + hotfix v0.9.44 | `f4a86ad` (feat) → tag v0.9.43 → fix staged package.json → tag v0.9.44 | Suite 303/0 (7 test mới/mở rộng). Live: home+laptop roster host.version 0.9.44 thật; laptop update 2 lần qua drive (`herdgate update` — tự học: `herdgate setup update` không tồn tại, chết an toàn ở check). Bug sống bắt thêm: staged release thiếu package.json → pkgVersion "unknown" → fix + test. askFleetOnce retry khi busy (throttle 1/2s đụng thật giữa pane và startup). Probe 5 device đã revoke |
| C2 | 2026-11-23 | ✅ xong — v0.9.45 | feat echo + tag v0.9.45 | Suite 306/0 (4 test mới). **Live evidence**: scratch pane + tmux + device act tạm qua gate thật — header `off 0/2 → 1/2 → on` sau 2 batch gõ, lệnh gõ chạy thật trên pane gốc; dọn sạch sau (tmux, tab, revoke, temp cfg). Cốt lõi: flush hỏi frame ngay trong throttle 1/s (AskScheduler) + grace 900ms cho kiến trúc poll — grace LAN 150ms của port khiến echo không bao giờ bật được qua WAN |
| C3 | 2026-11-23 | ✅ xong — review + fix F1, v0.9.46 | review `e034a54` + fix + tag v0.9.46 | STRIDE pass surface mới (docs/reviews/2026-11-23-c3-stride.md): **F1 Medium** — term.list/fleet.detail trả panes không giới hạn → tab storm ~2500 pane tự giết socket publisher (cùng lớp bug Part 7) → **fix cap 200 + {panesCapped,total}** (suite 307/0, test tab-storm 301 pane); F2/F3 Low ghi nhận chấp nhận; F4 (pane.focus không match `wG:p1`) → backlog C4. Live: home publisher restart nạp cap, fleet.detail probe xanh rồi revoke sạch; laptop 0.9.46 |
| C4 | 2026-11-23 | ✅ xong — v0.9.47 (bump cuối theo kiểu cũ) | feat + tag v0.9.47 | Suite 310/0 (4 test mới). Adaptive cadence (busy/changed=5s, quiet ×1.5→60s, timer chain — log `adaptive→60000ms`, chain sống >60s live); pane.focus nhận `wG:p1`; attachment.list cap 200; invariant tripwire. Từ C5 áp dụng chính sách release 2b |
| C5 | 2026-11-23 | ✅ xong — **theme lớn đầu tiên theo chính sách 2b**, v0.10.0 (1 bump duy nhất cho 3 milestone) | spec `c9b3f16` → M1 `57ed477` → M2 `aacb3fd` → tag v0.10.0 | **Fleet control từ PWA**: bug sống pane.focus từng trả lời device read (đã act-gate); tab.create/tab.close ownership-map (phone-tabs.json, FIFO 64, sống qua restart — unit test); PWA typing 1 dòng vào pane sống (term.send, không client echo) + nút "+ tab" + chip tab mình mở (session-side); web rules nâng allowlist tường minh. Suite 311/0. **Live trên máy thật**: read bị chặn cả 3 op; act mở tab thật w8:t2N, gõ echo marker hiện trên pane thật, đóng sạch; probe revoked. Laptop 0.10.0 |
| C6 | 2026-11-23 | ✅ xong — review loop trọn vòng (client-only, **không bump** theo 2b) | spec + feat chung commit | review.sent giờ đăng ký receipt.watch như job thường — settle push + wake về phone đúng hạ tầng sẵn; chip Review tab sống theo trạng thái (⏳ → ✓ + nút mở Jobs). **Bug thật bắt thêm**: test utility `codeOnly` nuốt nửa app.js vì string `"image/*"` bị tưởng block comment — strip giờ chỉ ăn comment đầu dòng; allowlist ops lộ thêm worker.health/submit (12 op tường minh). Suite 312/0. Live: probe c6-fence đã revoke, room sạch 5; fence pi_worker_disabled phủ bởi e2e |
| C7 | 2026-11-23 | ✅ xong — publisher watchdog (serve path), **không bump** theo 2b | spec `fb5629f` + feat `0549842` | Chọn watchdog thay cho jobs-rich (lý do trong spec: điểm hỏng đơn + lớp sự cố đã gặp). Suite **315/0** (3 test mới: respawn sau SIGKILL, budget give-up, adopt child bản cũ). **Live verify theo ràng buộc auto-run**: đường serve thật từ source, state scratch + stub gate localhost, thông số MẶC ĐỊNH (poll 1s, budget 5/10min): SIGKILL → respawn pid mới + hello#2 sau 1.8s; stop → supervisor drain sạch, không reconnect; publisher.log ghi đủ dấu vết (exit SIGKILL, respawn 1/5, stop). Service thật không đụng (publisher home nằm dưới systemd Restart=always, ngoài scope). Bug thật bắt thêm: child detached+unref không reap → zombie khiến kill(pid,0) vẫn "alive" — exit listener vừa reap vừa log. READY-TO-RELEASE: publisher-self-healing (chủ sở hữu review + publish khi gộp theme kế hoặc gọi riêng) |
| C9 | queued | 🔄 **THEME: Loop như tính năng shipped** (`plugin/loop/`) — agent loop pane chung: start/stop/pause/resume/status actions + [[events]] chain + registry ownership + maxCycles; thay experiment local bằng bản shipped trên home (loop tự sản phẩm hoá chính nó). Spec sẵn: `docs/specs/2026-11-23-c9-loop-product.md` | — | release theo 2b |

| C8 | 2026-11-23 | ✅ xong — TUI publisher watchdog (run-id lock model), **không bump** theo 2b | spec `4bc17ae` + feat `28946e5` | Chọn watchdog TUI (kế nhiệm được chỉ định của C7; jobs-rich vẫn chưa có bằng chứng nhu cầu). Suite **320/0** (5 test mới, process thật: SIGKILL → respawn pid mới + run-id mới có bằng chứng trong log; stop đứng xuống supervisor — marker sạch, không respawn; budget MAX=2 → giết 3 lần → `giving up`; adopt worker chạy sẵn không spawn đè; heal lock stale tự reap+respawn). Serve path C7 không đụng (hai model, hai cây state `publisher-tui.*` vs `publisher.*`). **Live Windows-on-metal trì hoãn trung thực**: laptop chỉ nhận code qua npm update, 2b cấm publish trong vòng tự chạy — verify thật đá tại lần owner publish theme. READY-TO-RELEASE: tui-publisher-self-healing (gộp với C7 thành theme self-healing trọn) |

### Bài học C1 (nuôi vòng sau)
- Drive laptop: lệnh đúng là `herdgate update` (không phải `setup update`); flow transaction của setup-tui chết an toàn ở bước `check` trước khi đụng publisher — đã chứng minh trên máy thật.
- `$env:...` trong HG_CMD bị bash local expand — escape `\$` hoặc dùng single-quote quanh lệnh PS.
- Staged release giờ có package.json — mọi helper đọc metadata bản build đều theo đường đó.

### Bài học C2
- Port desktop sang kiến trúc poll phải soát lại mọi hằng số thời gian: grace 150ms tính cho RTT cục bộ thành "luôn contradiction" qua WAN — tham số hoá + bằng chứng sống mới đủ tin.
- Evidence là sản phẩm: header trust meter (`off 1/2`) khiến trạng thái tin cậy quan sát được, không phải đoán.

### Bài học C3
- Review read-only tách commit với fix — audit trail giữ được "tôi thấy gì" trước "tôi đổi gì".
- Lớp bug "reply tự giết socket publisher" lặp lại lần 3 (file.read → giờ panes) — mọi op trả danh sách phải có cap mặc định; cân nhắc invariant test chung ở C5.

### Bài học C4 (phản hồi user)
- Version không phải tiến độ: 5 bump/ngày là nhiễu (npm flip chờ 2-3 phút mỗi lần, laptop update mỗi lần). Release theo chủ đề người-dùng, việc nhỏ nằm gọn trong theme.
- Vòng nhỏ chỉ hợp lệ khi nó là bước NHỎ trong chủ đề lớn (như C3 review là bước của chủ đề ổn định).

### Bài học C7
- Zombie là trạng thái "alive": child spawn detached+unref mà không có exit listener sẽ thành zombie khi chết, `kill(pid,0)` vẫn trả sống — poller tưởng publisher sống mãi. Mọi supervisor phải reap (giữ exit listener); signal-alive không phân biệt được zombie.
- Pidfile trễ một chu kỳ poll là hợp lệ về mặt thiết kế — test phải chờ "pid ĐỔI" chứ không phải "pid alive", nếu không sẽ giết zombie và đếm nhầm số death.

### Bài học C8
- Trên Windows, pid-liveness là lời nói dối (pid tái sử dụng nhanh): heartbeat `{pid,pollMs,at}` + freshness là nguồn sự thật "còn đang canh"; chỉ signal pid do chính mình spawn (không thể tái sử dụng khi còn sống trong child handle).
- "Lock biến mất" vẫn là MỘT LỚP CHẾT: uncaught exception vẫn chạy exit handler (release xoá lock sạch sẽ) — babysitter không được tin "clean exit = chủ ý dừng"; chỉ stop-marker + đứng xuống supervisor mới là dấu dừng hợp lệ.
- startPublisher không trả lời trước khi thế giới nó mô tả tồn tại: đợi heartbeat claim (≤3s) để flag `supervised` trong status không nói dối ngay câu trả lời đầu tiên.
- (test harness) waitFor với predicate async phải `await fn()` trong vòng lặp — trả về Promise đầu tiên là trả kết quả của lần gọi đầu (thường là null), không phải kết quả cuối.
