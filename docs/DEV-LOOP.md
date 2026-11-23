# DEV-LOOP — vòng phát triển tự vận hành của herdgate

> Protocol vận hành: mỗi vòng là **một chu kỳ SDD trọn vẹn**, không làm tạm bợ.
> Trạng thái vòng nằm ở cuối file này — lượt làm việc nào cũng đọc file này
> trước, nối đúng chỗ dừng, không hỏi lại user.

## Tự vận hành (auto-run)

- **Driver hiện tại = chính plugin shipped `dev.herdgate.loop`** (cutover
  C9): action `start` mở workspace `⚙ dev-loop`, boot pi với prompt
  `docs/DEV-LOOP/AUTO.md` (cwd = repo); event hook nudge vòng kế khi
  pane settle. State/log: `~/.local/state/herdr/plugins/dev.herdgate.loop/`
  (state.json: cycles/armed/paused; loop.log: mọi quyết định nudge).
- Mỗi vòng = 1 turn của cùng session pi trong pane đó (không còn
  `pi -p` headless mỗi vòng): 1 chu kỳ SDD trọn (spec → red → green →
  suite → commit → push) rồi dừng đúng 1 vòng.
- **Đóng băng**: action `pause` của plugin; resume: `resume`; dừng hẳn:
  `stop` (đóng cả workspace — đọc câu trả lời cuối trước khi stop). Từ
  C11c, `start` từ chối khi pane cũ còn sống bất kể status (done để lại
  đáp án trên màn hình — stop rồi start lại là một bảng sạch).
- Hệ driver cũ (systemd `herdgate-devloopd` + script
  `~/.local/bin/herdgate-dev-loop.sh`) đã **retired** (inactive/disabled,
  log dừng ở era PAUSE 03:47) — giữ làm khảo cổ, đừng khởi động lại khi
  chuỗi plugin đang chạy (double-drive).
- Guardrails AUTO.md: KHÔNG npm publish/tag (ghi `READY-TO-RELEASE`
  khi theme trọn — chủ sở liệu publish), KHÔNG đụng service/pane user,
  KHÔNG in token, đúng 1 vòng/lần.
- Theo dõi: `tail -f ~/.local/state/herdr/plugins/dev.herdgate.loop/loop.log`;
  trạng thái: action `status` của plugin.
- **Backlog trống** (hết mục 🔄/queued, không nợ giao/nghiệm thu nào trả
  được ngay): vòng **no-op ngắn** — quét log sống (loop/gate/publisher)
  + 1 dòng Cycle Log `no-op — backlog trống`; KHÔNG săn theme ép,
  KHÔNG tự pause loop (quyết định dừng là của owner).

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
| C9 | — | **Loop như tính năng shipped** (`plugin/loop/` — shipped, live) | Cao | ✅ xong |
| C10 | kế tiếp | **Loop nudge arming** (bug sống của theme C9 — nudge lúc sinh) | Cao | ✅ xong |
| C11 | — | **Loop boot path Windows** — boot POSIX-only `cd X && pi "$(cat Y)"` trái manifest `windows`; laptop user sẽ hỏng ngay khi start. Fix: dòng boot không chứa cấu trúc shell (cwd qua tab.create, prompt qua `pi @file`) + `bootCommand` override | Cao | ✅ xong |
| C12 | kế tiếp | **Loop sống trên Windows (verify)** — laptop ĐÃ lên 0.12.0 (hello 09:23:53Z, tự/user update): còn đúng 1 việc — link plugin/loop trên laptop herdr + probe thật maxCycles=1 qua event thật (lane ssh edge như C11b) | Cao | 🔄 chọn khi mở |
| C13 | — | **Roster phân biệt publisher-alive vs client-online** — bằng chứng sống 2026-11-23: operator đọc 0/6 online thành "laptop mất kết nối" và điều tra nhầm hàng chục phút, trong khi publisher connected + supervised + hostInfo tươi; ssh-probe vừa kết nối cũng hiện offline | Trung bình–cao | queued |
| C13 | — | **Jobs/results phong phú** — chỉ khi có bằng chứng nhu cầu quan sát được; **EXCAVATION chọn lọc** vẫn parked; **multi-loop registry** (một plugin một loop — probe C10 phải bơm event tay) parked tới khi có nhu cầu thật hai loop song song | Tham khảo | parked |
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
| C9 | 2026-11-23 | ✅ xong — plugin/loop shipped, live-verified trong chính TUI home | spec `85acee6` + feat `18364b5` | Vòng đầu do CHỦ sở hữu làm giữa chừng (PAUSE chặn nudge, không chồng lấn C8). Suite **330/0** (10 test mới: manifest rules, self-contained + npm files, foreign-pane im lặng, settle→nudge+cycles+cooldown, working/blocked tay-ra, exited→chain-broke, paused im, maxCycles→done trung thực, config hỏng→mute, start escape đúng + idempotent + fail-closed, stop gone-is-success, status JSON). **Live cutover ngay trên máy home**: unlink experiment `dev.herdgate.devloop`, link shipped `dev.herdgate.loop`; probe thật (maxCycles=2) chạy qua TOÀN BỘ event thật của herdr: start 03:52:28 → nudge#1 (29s) → cooldown giữ → nudge#2 (40s) → settle → **cap đạt → done (43s), không nudge lần 3**. Phát hiện thêm nhờ probe: validate `cwd under home` bắt đúng probe /tmp (fail-closed làm việc). Từ C10 chuỗi chạy trên plugin shipped. Auto-loop đóng băng bằng `pause` action của plugin (không còn repo PAUSE flag) |
| C10 | 2026-11-23 | ✅ xong — loop nudge arming, **không bump** theo 2b | spec `a81a4f7` + feat `596196e` | **Bằng chứng sống chọn theme**: log loop shipped thật — nudge #1 bắn +1.77s sau start (agent chưa turn nào); chính session viết spec nhận nudge là input #2 lúc sinh ⇒ mọi task generic bị tiêm nudge-text dev-loop ~2s sau start. Suite **333/0** (3 test mới: birth-settle im, work→settle nudge, grandfather state cũ không đứt chuỗi). **Live probe** plugin shipped + herdr + pi thật (workspace riêng `⚙ c10probe`, maxCycles=1): start im lặng >2m46s (bản cũ nudge +1.77s cùng máy), `armed` khi thấy working, nudge #1 gõ thật → pi trả lời thật `PROBE-CYCLE-2-DONE`, settle cuối → `maxCycles 1 reached — done`, không nudge #2; stop đóng workspace sạch. Trung thực: event cho probe bơm tay đúng form (hook thật của herdr gắn state dir chuẩn ⇒ event pane probe bị foreign-check nuốt — đúng thiết kế một-loop-một-plugin); birth-idle của probe đã được chứng minh bằng so sánh trực tiếp cũ/mới + unit. Jobs-rich vẫn parked (không có nhu cầu quan sát mới) |

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

### Bài học C10
- Trạng thái tác tử (idle/working/done) là quan sát, không phải lời khai: herdr phát `idle` quanh lúc pane sinh ra; mọi máy trạng thái đọc event phải phân biệt "idle vì chưa bắt đầu" với "idle vì vừa xong" — arm trên bằng chứng việc ĐÃ xảy ra, đừng tin trạng thái tĩnh.
- Chính session đang chạy là nguồn bằng chứng tốt nhất: nudge arrives làm input #2 lúc sinh lộ bug mà không log nào ghi. Đọc log loop thật TRƯỚC khi chọn theme vòng.
- Nâng cấp tại chỗ của máy trạng thái phải grandfather state cũ: thêm trường `armed` mà coi state thiếu trường là unarmed = giết chuỗi đang chạy trên máy thật ở event kế tiếp. Mặc định nâng cấp = giữ hành vi cũ cho dữ liệu cũ.
- Một plugin-id = một state = một loop: event hook của herdr luôn đọc state dir chuẩn — probe song song phải bơm event tay đúng form; foreign-check nuốt event pane lạ (đúng thiết kế, và cũng là rào an toàn cho probe).

### Bài học C11
- Vấn đề "shell nào sẽ chạy dòng mình gõ" chỉ đáng trả lời bằng cách xoá câu hỏi: không chọn shell — bỏ mọi cấu trúc shell (command substitution, `cd /d`) khỏi TEXT được gõ, đẩy trạng thái (cwd) vào API (tab.create) và dùng dạng mà mọi shell truyền y hệt nhau (đường dẫn trong ngoặc kép).
- `pi @file` là một ARGUMENT đường dẫn — không cần substitution ở shell; bằng chứng sống: pane thật đọc prompt qua attachment và trả lời đúng marker. (Còn pipe stdin thì loại: pi tự chọn print-mode khi stdin redirect — giết loop.)
- Reverse-engineer binary (strings/nm) cho câu trả lời mơ hồ (cmd? PowerShell?) thì thiết kế sao KHÔNG cần biết câu trả lời — default an-tổn-quan + van thoát owner (bootCommand) là kết cấu bền hơn một template đoán shell.
- Release commit phải để lại working tree SẠCH: v0.11.0 "aligned all manifests" nhưng bump host manifest rơi khỏi commit, file dirty 6 tiếng không ai thấy. Bài cho mọi lần bump: `git status` sạch là một phần của definition-of-done.

### Bài học C11b
- Drive laptop qua lane chính thống: `herdr --machine <name>` (machine đã saved) — ssh edge CHỈ dịch đúng probe templates của herdr (`command -v`, EncodedCommand probe của Windows…), mọi lệnh shell thẳng đều bị từ chối đúng thiết kế. hc machine registry rỗng là bình thường — herdr có registry riêng.
- `herdr pane send-text` (CLI) KHÔNG kèm Enter — text nằm trên prompt mà không chạy; phải `pane send-keys <id> enter` sau đó. (Api `pane.send_text` với `\r` trong text thì tự Enter — hai lane khác nhau.)
- Footprint nhỏ nhất khi drive máy sống của owner: 1 tab riêng có nhãn trong workspace đang mở + tự đóng; chứng minh không đụng gì bằng diff pane.list trước/sau.
- Scrub secret theo TÊN key là chưa đủ: filter 'TOKEN' đã lọt 'ROOM_TOKEN' và in giá trị thật ra output. Scrub theo GIÁ TRỊ (regex hình-dạng secret / độ dài) hoặc whitelist tên field ĐƯỢC PHÉP in — mọi script đọc env cấu hình phải mặc định deny.

### Bài học C11c
- "Done" không phải "gone": máy trạng thái có trạng thái kết thúc phải hỏi "tài sản của trạng thái đó còn trên đời không?" — pane done vẫn sống với đáp án cuối; restart đè lên nó = mồ côi hoá tài sản người đọc. Từ chối + chỉ lối ra (stop) an toàn hơn dọn hộ (đừng đóng cái owner có thể đang đọc).
- Tài liệu vận hành là code: section "Tự vận hành" sai một epoch (devloopd) khiến mỗi vòng tốn khảo cổ lại kiến trúc. Khi driver đổi, đoạn mô tả driver phải đổi trong CÙNG vòng cutover.
- Backlog trống là tín hiệu thiết kế thiếu: chuỗi tự chạy cần giao thức no-op trung thực (sweep + 1 dòng log) — săn theme ép khi không có việc là tự tạo việc ảo, tệ hơn im lặng ghi nhận.

### Bài học C11d
- Backup hệ sống: manifest phải digest trên BẢN ARCHIVE, không phải source — source nóng (pi-receipts) đổi giữa lúc copy và digest ⇒ verify tự bắn lỗi chính mình. Backup mà verify được trên bytes nó sẽ restore mới là backup.
- Công cụ verify ra đời TRƯỚC khi cần: chính lần chạy thật đầu tiên của gate-backup --verify bắt được race mà unit test không thấy (tmp dir đứng yên). Rule cũ còn đúng: evidence là sản phẩm — và bằng chứng sống bắt bug tốt hơn test tĩnh.
- "Việc user" trong backlog không phải khối đồng nhất: Pha A của VPS plan (backup/runbook/diễn tập sandbox) làm được mà không đụng gì của user; chỉ Pha B (key/DNS) thật sự của owner. Cắt ranh theo NHỮNG GÌ phải đụng, không theo tên mục.

### Bài học C11e
- Artifact deploy ≠ source chạy: archive không bundle node_modules — `npm ci` + `patch-ssh2` là MỘT PHẦN artifact contract, không phải tuỳ chọn tiện lợi. Diễn tập phải theo ĐÚNG các bước deploy của README; lần đầu tôi bỏ bước là crash ngay ERR_MODULE_NOT_FOUND — và chính cái crash đó xác nhận diễn tập đang đi đúng đường thật.
- Rehearsal state-thật × artifact-thật là lớp verification suite không thay được: cloud-release.test boots artifact với state tổng hợp 5 dòng; chỉ state sản phẩm tích luỹ 0.9.35→0.11.0 (5 rooms, 15+ devices, host key thật) mới lộ schema-drift — hôm nay: KHÔNG lộ (5/5 MATCH), và sự khớp đó giờ là bằng chứng, không phải phỏng đoán.
- Chạy suite nền bắt-cơ-hội trong khi làm rehearsal: cùng 25 phút tường, hai việc verification song song — và lần này full log được giữ (flake không tái diễn, nhưng nếu có thì đã có xác pháp thay vì đuôi bị cắt).

### Bài học C11f
- Atomic write (tmp+rename) không tự healing phía rác: crash giữa hai dòng để lại mồ côi vĩnh viễn — mọi nơi dùng pattern này cần một bên dọn tại boot (exact-prefix, best-effort). Orphan 3 ngày tuổi trên máy thật là checkpoint rẻ nhất cho micro-fix có bằng chứng.
- Micro-cycle vẫn đúng luật 2b khi có bằng chứng sản phẩm + test + live verify — cái khiến vòng nhỏ thành "1 regex" là THIẾU bằng chứng, không phải cỡ nhỏ.
| v0.11.0 | 2026-11-23 | 🚀 RELEASE "Self-healing + Loop" — gộp theme: C7 publisher watchdog (serve) + C8 TUI watchdog (run-id lock) + C9 plugin/loop shipped + C10 arming | bump + tag v0.11.0 | Đủ điều kiện 2b(a): trọn theme lớn user-facing. Suite 333/0. Windows-on-metal verify TUI watchdog đá ngay sau publish (nợ C8). **Trạng thái**: npm latest flipped 0.11.0 ✓; laptop offline (cả 6 device) tại lúc drive — update + verify on-metal chờ laptop online (chủ sở hữu mở máy hoặc drive lại sau) |
| C11 | 2026-11-23 | ✅ xong — loop boot path Windows (dòng boot thoát POSIX-only), **không bump** theo 2b | spec `7b1d964` + feat (c11) + dọn `c72bc2f` | Suite **338/0** (5 test mới: boot.mjs default/override/fail-closed + dependency manifest; CLI: tab.create CÓ cwd, text boot mới, bootCommand override end-to-end, boot hỏng chết trước bridge, status.boot). **Live probe home** (herdr 0.9.5 thật, scratch state — không đụng loop dev-loop thật): start → pane wJ:p2 sinh ĐÚNG cfg.cwd qua `tab.create` cwd (không gõ `cd`); boot `pi "@<promptFile>"` (không command substitution) → pi thật boot trong pane (agent detected, working) → trả lời `C11-PROBE-OK` qua attachment, done; stop đóng workspace sạch; shipped loop 0 đụng pane probe (foreign-check). min_herdr_version loop 0.9.0→0.9.5 (tab.create cwd). Bắt thêm: release v0.11.0 commit bỏ sót host manifest (bump rơi khỏi commit, file dirty 6 tiếng) — dọn commit riêng. Windows-on-metal chờ laptop (cùng nợ C8). **READY-TO-RELEASE: loop-windows-boot** — theme C9–C11 trọn; laptop đang update 0.11.0 sẽ hỏng boot trên Windows, owner publish sớm để fix tới máy |
| C11b | 2026-11-23 | ✅ xong — **giao v0.11.0 cho laptop + đòi nợ on-metal C8** (drive-verify, không đổi code repo) | spec `2e9ec3f` | Backlog hết mục queued → chọn nợ ghi 2 lần trong log: laptop còn 0.10.0, owner đã publish v0.11.0. **Drive qua lane chính thống** `herdr --machine laptop` (machine saved `328f45bf`, device `d_39752695` scope act do owner pair bằng `herdgate connect`): 1 tab riêng `c11update` trong workspace owner đang mở, KHÔNG đụng pane có sẵn (diff pane.list 43/43 trước/sau — chỉ pane mình tạo biến mất). Dry-run `herdgate status` (0.10.0, connected pid 30420) → `herdgate update` → JSON `{"release":"tui-212160f7c748d246","state":"connected","pid":28488,"supervised":true}` — **supervised:true là C8 sống on-metal**; supervisor log: `watching (poll 1000ms, budget 5/600s)` → `publisher starting (pid 28488, run d604f95a)` → `publisher started`; heartbeat `publisher-tui.supervisor.json` fresh ({pid:37020, pollMs:1000, at=ngay lúc đọc}); **gate hostInfo r_5a22e50b flips 0.10.0 → 0.11.0** (04:57:08Z). Loop plugin shipped trên laptop (releases\tui-212160f7c748d246\plugin\loop\{herdr-plugin.toml, server\index.mjs}) — trung thực: **không có boot.mjs (pre-C11)**, loop inert ở đó cho tới khi owner publish fix C11 — READY-TO-RELEASE: loop-windows-boot vẫn đứng. Không đổi code repo — suite không chạy lại (baseline 338/0 của C11). **Vi phạm guardrail ghi trung thực**: đầu vòng in 2 room token ra output khi lọc env theo tên biến (ROOM_TOKEN khớp substring 'TOKEN' của filter) — giá trị chỉ nằm trong transcript local; bài học C11b |
| C11c | 2026-11-23 | ✅ xong — **loop operability**: start sạch sau done + tài liệu vận hành nói sự thật + giao thức no-op, **không bump** theo 2b | spec + feat + docs | Suite **340/0** (2 test mới: done+alive → từ chối, đúng 1 pane.list, không tab.create; chain-broke+dead → restart sạch cùng workspace, cycles về 0). **Bug thật**: guard idempotent cũ chỉ kiểm `status==="running"` ⇒ `start` sau `done` (pane còn sống với đáp án cuối) tạo tab MỚI, pane cũ mồ côi trong `⚙ <label>` — mỗi restart +1 tab rác. Fix: từ chối khi pane mình còn sống bất kể status, message nêu status + "stop it first" (chọn từ chối thay vì tự đóng: pane done chứa đáp án owner có thể đang đọc). Trung thực lệch spec nhỏ: assertion test idempotent cũ đổi theo message mới (spec viết "giữ nguyên" — hành vi giữ nguyên, chữ đổi). Docs: "Tự vận hành" viết lại theo thực tại (driver = plugin shipped C9, devloopd retired — inactive/disabled đo được, pause/resume/stop actions, **giao thức no-op khi backlog trống** — bằng chứng 3 vòng liên tiếp phải săn theme/đòi nợ). AUTO.md không đụng. Live regression: chính chuỗi dev-loop chạy trên plugin bản C11 (nudge vòng này = event hook sống) |
| no-op | 2026-11-23 | ⏸️ **no-op — backlog trống** (giao thức C11c lần đầu áp dụng) | docs-only | Quét sống toàn bộ: loop chain khỏe (nudge #1–#3-pane wH:p2, armed, không suppressed lạ); gate 0 lỗi từ 12:00; home TUI publisher 0 lỗi; laptop herdr 0.9.5 reachable (0.11.0 đã giao ở C11b). Không nợ trả được ngay: loop-windows-boot chờ owner publish; VPS cutover việc user; sysmon chờ herdr > 0.9.5. **Điều tra đã đóng**: room bom-Inspiron-7559 hello 0.9.47 lúc 09:16:49 gây nghi ngờ "publisher báo version cũ" — không phải bug: process chạy từ source nạp lúc 09:16 (package.json khi đó = 0.9.47), v0.11.0 bump lúc 11:17, hostInfo chỉ refresh khi reconnect ⇒ roster hiện 0.9.47 là đúng với process đang chạy, tự đúng ở lần reconnect/restart kế (không restart theo guardrail). Không code, không suite (baseline 340/0 giữ nguyên) |
| C11d | 2026-11-23 | ✅ xong — **gate resilience pack** (Pha A VPS plan, phần không cần user): backup + verify + runbook + diễn tập restore sống, **không bump** theo 2b | spec + feat + docs | Suite **344/0** (4 test mới: archive đủ 6 entry + manifest sha256 = digest của BẢN ARCHIVE, host key giữ 0600, retention --keep 2, verify bắt 1 byte đổi, thiếu state.json rc 2). Trung thực flake: full run ĐẦU có 1 fail không kịp capture (chỉ tail); 3 full run kế tiếp 344/0 + gate-backup 10/10 — nếu tái diễn, vòng sau điều tra với full log. **Bug thật bắt bởi chính công cụ mới**: verify bản backup thật FAIL `pi-receipts` — gate đang sống ghi receipts liên tục ⇒ digest theo source là race; fix semantics: manifest digest trên BẢN ARCHIVE (cái sẽ restore), backup nóng giờ verify OK sau 3s. **Live rehearsal trên máy nhà**: backup state thật (5/6 entry — attachments không tồn tại, ghi absent) → verify → restore scratch `~/.cache/hg-c11d` → gate scratch từ source (port 8899, NO_SSH, NO_PUSH, token qua env không in) → `/healthz` ok + `/v1/devices` serve room thật: home 5 devices (0.9.47), laptop-tui 6 devices (**0.11.0** — bản state mới nhất) ⇒ restore được chứng minh ở tầng API → stop scratch, port free, gate thật 8833 không đụng (200 với Host đúng, 421 sai Host = enforce sống). Runbook `docs/runbooks/gate-migration.md` (backup hằng ngày + timer TEMPLATE owner tự cài + cutover Pha B + cảnh báo herdr remote client bỏ cuộc sau 5 retry). Còn của owner: leg Cloud-archive 0.9.38, cài timer, Pha B (root key/DNS) |
| C11e | 2026-11-23 | ✅ xong — **cutover rehearsal: state thật × artifact thật** (không đổi code) | spec + runbook + docs | Pha A khép gap cuối trong lane dev-loop: C11d mới chứng minh source→source; vòng này dựng artifact ĐÚNG hình deploy (build:cloud runtime + web + package.json lock như build-release + `npm ci --omit=dev` + `patch-ssh2` đúng README templates/cloud) restore backup thật C11d → boot scratch port 8899 (NO_SSH/NO_PUSH, token env không in) → **5/5 rooms khớp gate thật tuyệt đối** (bom-Inspiron 5d/0.9.47, Laptop 0d, Laptop-TUI 6d/0.11.0, home-tui-mobile 1d, home-tui-control 1d/tui-core-pilot — device count + hostInfo) + PWA HTML 200 từ artifact. **Phát hiện thật bắt trong diễn tập**: lần boot đầu crash `ERR_MODULE_NOT_FOUND: ws` — archive KHÔNG bundle node_modules, `npm ci` + `patch-ssh2` là một phần artifact contract (README deploy đúng, nhưng ai diễn tập bỏ bước deploy sẽ chết ở cửa đầu — đã ghi cảnh giác vào runbook). Dọn sạch: gate artifact stop, 8899 free, gate thật 200 Host đúng. Flake C11d: full suite chạy nền bắt-cơ-hội với FULL log → **344/0** (5 full runs xanh liên tiếp kể từ flake; không tái diễn, log giữ ở /tmp cho vòng sau nếu cần). Không code repo — suite nền xanh là verification |
| no-op | 2026-11-23 | ⏸️ **no-op — backlog trống** (vòng bị gián đoạn giữa chừng khi chờ suite nền; khép trọn ở lượt này) | docs-only | Quét sống sạch: loop 0 anomalies (13 dòng quyết định, không suppressed/FAIL lạ), gate 0 lỗi từ 12:45, laptop herdr 0.9.5 reachable, 2 backup C11d đứng trong backups/ với _latest, owner chưa publish (npm latest 0.11.0). **Flake C11d hạ cấp trung thực**: 2 full suite chạy nền nối tiếp → 344/0 + 344/0 với full log giữ tại /tmp/hg-c11f-suite{1,2}.log ⇒ 6 green liên tiếp sau đúng 1 đỏ không capture (7 runs tổng) — coi như one-off timing của e2e; nếu tái diễn, log lần này là mẫu chuẩn để so. **Bằng chứng sống mới**: log loop xuất hiện lần đầu `nudge suppressed (cooldown 60000ms)` — double-settle trong 1s (06:49:07.492 → 06:49:08.359) do vòng trước kết thúc gián đoạn; cooldown từ thời C2 chặn đúng thiết kế, không có nudge kép tới agent |
| C11f | 2026-11-23 | ✅ xong — **gate state hygiene**: boot dọn tmp mồ côi của atomic write, **không bump** theo 2b | spec + feat + docs | Bằng chứng sản phẩm: `state.json.tmp-joutxcyr5h` (Nov 20, 3 ngày) — kill giữa writeFileSync và renameSync của `State#save()` strands tmp vĩnh viễn, không gì dọn. Suite **347/0** (3 test mới: sweep orphans đúng prefix + strangers nguyên vẹn + state nạp đúng; sweep cả khi main state chưa từng land; không path ⇒ không đụng fs). Implement: `#sweepOrphanedTmp()` trong constructor — exact-prefix `<basename>.tmp-`, topology single-instance của README bảo đảm tmp còn sống của process khác không tồn tại hợp lệ. **Live verify scratch**: gieo `state.json.tmp-orphanprobe` + state backup thật → boot gate source (code mới) port 8899 → healthz ok + **orphan swept (đếm 0)** → dọn scratch, gate thật 200 nguyên vẹn. File thật trên máy nhà để cho lần restart kế của gate thật tự dọn (restart là của owner — live proof thứ hai sẽ đến miễn phí). Vòng bị bắt lỗi giữa chừng: thiếu import `join` — targeted test đỏ lại ngay, sửa 1 dòng, xanh |
| no-op | 2026-11-23 | ⏸️ **no-op — backlog trống** | docs-only | Quét sống sạch: loop nudge #8-#9 đều rc=ok + 1 suppressed đúng thiết kế, gate/TUI 0 lỗi từ 14:10, laptop 0.9.5 reachable, 3 mục backups/ đứng (2 archive + _latest), orphan thật duy nhất còn nằm chờ gate restart của owner (C11f sẽ dọn nó miễn phí). Owner chưa publish (npm 0.11.0) — mọi nợ còn lại là của owner: publish loop-windows-boot, backup timer, Pha B VPS. Không săn theme ép |
| v0.12.0 | 2026-11-23 | 🚀 RELEASE "Loop on Windows + self-sweeps" — gộp theme: C11 boot shell-free (+bootCommand) + C11c start-refuses + C11d gate-backup + C11f state boot sweep | bump + tag v0.12.0 | Đủ 2b(a): loop chạy thật trên Windows (laptop owner là máy đầu tiên cần). Suite 344/0×2 (C11f) + targeted 20/0 trước bump. Owner-side ĐÃ LÀM cùng ngày: npm flip 135s; gate restart (orphan `state.json.tmp-joutxcyr5h` quét sạch, publisher reconnect 14:36:09 adaptive→60s); `herdgate-gate-backup.timer` daily 04:30 + chạy thử OK (5/6 entries, keep 14); còn duy nhất: giao laptop khi TUI mở (= C12) |
| đính chính | 2026-11-23 | 📝 "Laptop TUI chưa mở / mất kết nối" là hiểu nhầm chỉ số — publisher laptop connected (pid 7144, supervised:true), hostInfo 0.12.0 hello 09:23:53Z; "0/6 online" chỉ nói các client device (phone/PWA/ssh ngắn hạn) không giữ WS — bình thường khi không ai mở. Không regression từ v0.11.0/v0.12.0/gate restart. Cải thiện chỉ số → C13 | owner-side |
