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
- **Nạp việc không mất pane (C20)**: action `kick` — resume + nudge NGAY
  (bypass cooldown một lần, +1 cycle); chừa khi pane `working|blocked`
  (`nudged:false`, không chen ngang), pane chết → exit 1 hẹn `start` lại.
- **Auto-resume (C20)**: config `watchFiles` (1–8 file TUYỆT ĐỐI, phải
  tồn tại — fail-closed): loop tự pause (`pausedBy:"auto"`) mà file đổi
  (mtime > pausedAt) → settle kế tự resume + nudge, cooldown vẫn giữ.
  `pausedBy:"owner"` (action `pause`) không bao giờ tự resume; `status`
  lộ `watchFiles`/`pausedBy`/`pausedAt`.
- Hệ driver cũ (systemd `herdgate-devloopd` + script
  `~/.local/bin/herdgate-dev-loop.sh`) đã **retired** (inactive/disabled,
  log dừng ở era PAUSE 03:47) — giữ làm khảo cổ, đừng khởi động lại khi
  chuỗi plugin đang chạy (double-drive).
- Guardrails AUTO.md: KHÔNG npm publish/tag (ghi `READY-TO-RELEASE`
  khi theme trọn — chủ sở liệu publish), KHÔNG đụng service/pane user,
  KHÔNG in token, đúng 1 vòng/lần.
- **Cycle audit (C18 — cơ chế, không chỉ lời)**: mỗi settle trước nudge,
  plugin đối chiếu git của `cwd` trong window vòng với các luật (bump
  version, tag mới, token commit — `AUDIT ok/VIOLATION` trong loop.log);
  vi phạm → giữ chuỗi (`auditHold`, không nudge) tới khi owner `resume`.
- Theo dõi: `tail -f ~/.local/state/herdr/plugins/dev.herdgate.loop/loop.log`;
  trạng thái: action `status` của plugin.
- **Backlog trống** (hết mục 🔄/queued, không nợ giao/nghiệm thu nào trả
  được ngay): vòng **no-op ngắn** — quét log sống (loop/gate/publisher)
  + 1 dòng Cycle Log `no-op — backlog trống`; KHÔNG săn theme ép;
  loop tự pause sau 2 no-op liên tiếp (ghi log `auto-pause`),
  resume vẫn là quyết định của owner.

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
| C12 | kế tiếp | **Loop sống trên Windows (verify)** — laptop ĐÃ lên 0.12.0 (hello 09:23:53Z, tự/user update): còn đúng 1 việc — link plugin/loop trên laptop herdr + probe thật maxCycles=1 qua event thật (lane ssh edge như C11b) | Cao | ✅ xong |
| C13 | — | **Roster phân biệt publisher-alive vs client-online** — bằng chứng sống 2026-11-23: operator đọc 0/6 online thành "laptop mất kết nối" và điều tra nhầm hàng chục phút, trong khi publisher connected + supervised + hostInfo tươi; ssh-probe vừa kết nối cũng hiện offline | Trung bình–cao | ✅ xong |
| C16 | — | **Presence cho mobile native leg** — bằng chứng sống 2026-11-23 tối: owner xác nhận app mobile TUI đã VÀO ĐƯỢC laptop (sau C14+C15), nhưng roster gate vẫn hiện `app mobile offline, legs []` — presence web leg không đếm mobile native (agent-ws + ssh channel) | Trung bình–cao | ✅ xong |
| C17 | — | **Loop tự pause sau K no-op liên tiếp** (chi phí không có trần — no-op mỗi ~60s vô hạn) | Cao | ✅ xong (wave subagent) |
| C18 | — | **Cycle audit** — guardrail bằng cơ chế (git window: bump/tag/token → `auditHold`) | Cao | ✅ xong (wave subagent) |
| C19 | — | **Cycle Log tách theo tháng** — DEV-LOOP.md 51KB → 28KB, tripwire ≤32KiB | Trung bình | ✅ xong (wave subagent) |
| C20 | — | **`kick` + auto-resume khi backlog đổi** (`watchFiles`, `pausedBy` owner/auto) | Trung bình–cao | ✅ xong (wave subagent) |
| C21 | — | **Device op `loop.status`** — loop hiện diện từ client (read-only, capped) | Trung bình | ✅ xong (wave subagent) |
| C22 | — | **PWA hiển thị `loop.status`** — C21 để ngở: thêm 1 dòng trạng thái loop cạnh worker (`$("worker")`), allowlist tường minh trong app.js + test/web.test.ts; mobile: KHÔNG thêm verb ssh | Trung bình | ✅ xong |
| C23 | — | **Cooldown loop hoãn nudge, không bỏ rơi** (liveness: settle < 60s sau nudge → im lặng vĩnh viễn) — SDD 3 vai: critic → implementer → reviewer | Cao | ✅ xong (wave 3 subagent) |
| C24 | kế tiếp | **SELF path qua `fileURLToPath` ở `plugin/server/index.mjs`** — supervisor còn dùng `new URL(...).pathname` (hỏng Windows: `%20`, `/C:/`), phát hiện khi làm C23 (F7) | Thấp | ✅ xong (owner verify laptop) |
| C26 | kế tiếp | **Trần chuỗi work — `workPauseAfter`** (C17 chỉ đếm no-op; chuỗi work tự sinh việc = chạy mãi, không trần chi phí): N chu kỳ work liên tiếp → auto-pause `pausedBy:auto` như C17; no-op xen giữa reset streak; `unknown` không đụng streak (không phạt bằng đoán); config `workPauseAfter`, chọn default có lý lẽ (gợi ý 0=tắt mặc định + dev-loop thật đặt ~12, hoặc mặc định ≥16) — test đối xứng `noopPauseAfter` trong loop-plugin | Trung bình | ✅ xong (default 0; dev-loop thật = 12) |
| C27 | kế tiếp | **Helper SDD cho loop + dogfood** — `experiments/pi-spawn/sdd.mjs`: spawn vai read-only (critic/reviewer) + `herdr agent wait` + đọc câu trả lời cuối từ session jsonl + close, ép 1 subagent/lúc; test kèm; vòng C27 tự chạy qua cổng VỪA (critic + reviewer thật) để chứng minh pipeline AUTO.md v2 | Trung bình | queued (PM, 2026-11-24 — AUTO.md v2 đã land cùng commit) |
| C13 | — | **Jobs/results phong phú** — chỉ khi có bằng chứng nhu cầu quan sát được; **EXCAVATION chọn lọc** vẫn parked; **multi-loop registry** (một plugin một loop — probe C10 phải bơm event tay) parked tới khi có nhu cầu thật hai loop song song | Tham khảo | parked |
| — | blocked | VPS cutover (việc user — `docs/plans/vps-cutover.md`); herdr > 0.9.5 lộ pid | — | blocked |

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

### Bài học C13
- Hai trục presence khác nhau từng bị gộp: "device live" (ai đang KẾT NỐI vào room — web/ssh) và "host alive" (publisher websocket — máy còn sống không). Roster phải trả CẢ HAI tường minh; sự cố thật là đọc trục này kết luận trục kia.
- Leg SSH không mở websocket PWA — presence của nó phải đến từ chính sshd (refcount per-device, bump khi 0↔1 tránh double-fire). Device machine lane dùng HÀNG NGÀY mà production chưa bao giờ hiện live: bug im lặng vì không ai nhìn trục đó lúc máy chạy tốt.
- `ssh -N` (authenticate + giữ transport, không channel) là hình chuẩn probe presence; `ssh host cmd` cần host chấp nhận exec — chết ngay khi host vắng (`the host is not connected`), khiến lần verify đầu tưởng fail.

### Bài học C12
- remote-api-bridge là streaming client: nó KHÔNG đợi stdin EOF để thoát — nó thoát NGAY khi EOF và bỏ rơi reply đang treo. Client one-shot viết xong rồi đóng stdin là tự đào race (thua kể cả khi server xử lý xong trước): "request thực thi nhưng client tưởng fail" sinh mồ côi server-side (w1P). Giữ stdin mở tới dòng reply đầu mới là hợp đồng đúng.
- Env TUI cấp cho plugin action (`HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, `HERDR_PLUGIN_*`) là nguồn sự thật về lane — plugin 1-action in env (link/unlink 30 giây) chẩn đoán nhanh hơn mọi tài liệu; `herdr plugin config-dir` in đường dẫn khác với env thật (`%APPDATA%` vs `%LOCALAPPDATA%` cho state) — tin env.
- Windows owner-config mặc định MANG BOM (PS 5.1 `Set-Content -Encoding utf8`, Notepad cũ): mọi config reader phải strip `\uFEFF` trước parse; báo "not found" cho file vừa viết là lời nói dối gây lạc hướng — mất một vòng điều tra vì tin nó (file TỒN TẠI, chỉ là parse chết).
- Event hook chạy code shipped trong khi action chạy code mình vừa fix — hai phiên bản chia state dir vẫn chain được (hook không phụ thuộc reply để lưu state), nhưng log `rc=FAIL` không có nghĩa nudge không tới: pane output là bằng chứng cuối cùng. Đọc pane, đừng chỉ đọc log.

### Bài học C11f
- Atomic write (tmp+rename) không tự healing phía rác: crash giữa hai dòng để lại mồ côi vĩnh viễn — mọi nơi dùng pattern này cần một bên dọn tại boot (exact-prefix, best-effort). Orphan 3 ngày tuổi trên máy thật là checkpoint rẻ nhất cho micro-fix có bằng chứng.
- Micro-cycle vẫn đúng luật 2b khi có bằng chứng sản phẩm + test + live verify — cái khiến vòng nhỏ thành "1 regex" là THIẾU bằng chứng, không phải cỡ nhỏ.

### Bài học C16
- Presence là BA câu hỏi, không phải hai: "host còn sống không" (agent-ws), "socket đang mở không" (connected/legs), "nó vừa ở đây không" (lastSeen). Client burst 1–2s/~17s (app mobile native) khiến câu 2 hầu như luôn trả lời "không"; gộp câu 3 vào câu 2 bằng linger/grace là nói dối có hệ thống — thêm trục, đừng làm mờ trục cũ.
- "Dọn sạch" phải kiểm chứng bằng cái đo được (PORT FREE), không phải bằng việc script chạy hết: scratch gate C13 đứng giữ 8899/2229 hơn 3 giờ sau log "dọn scratch sạch" — tới vòng sau ai cần port mới phát hiện. Mọi probe tự mở listener phải khép bằng kill + verify port.

### Bài học wave C17–C21 (subagent glm-5.3-flash max ×5, reviewer gộp)
- **Tối đa 3 subagent song song** trên một API key (zai trả 429/1302 khi 5 cái sinh cùng lúc). Receipt `failed` KHÔNG có nghĩa agent bỏ cuộc — tìm DONE marker trong session trước khi `continue`; `task.mjs continue` chỉ nhận khi agent idle.
- Brief phải yêu cầu **test là bất biến bền**, không ghpin trạng thái một lần ("exactly N rows", "pre-split count") — vòng kế sẽ đỏ suite và BLOCKED loop.
- Reviewer: sau mỗi lần giải conflict chạy `node --check` + test rồi mới `rebase --continue`, chain bằng `&&` — lần này dùng `;` nên file thiếu `}` vẫn lọt tới nhánh tích hợp (sửa trong cùng phút).
- DEV-LOOP.md: **Cycle Log là bảng ở CUỐI file** — vòng mới thêm dòng vào cuối bảng (không chèn sau backlog).

### Bài học wave 3 (SDD với subagent, C23)
- **Spec do PM viết, subagent phản biện TRƯỚC khi code**: critic read-only bắt 3 BLOCK trong spec của chính PM
  (spawn kép cùng id; hàm dùng chung `process.exit` không trả lý do; **đếm kép `noopStreak`** → auto-pause chỉ sau
  1 no-op). Một vòng critic (~5 phút) rẻ hơn một vòng fix sau merge.
- **Read-only ép bằng cấu hình**: `pi --tools read` cho critic/reviewer (bài học "structure over instruction");
  bằng chứng cho reviewer là **file** (diff + log test controller tự chạy), không phải "đọc pane".
- **`herdr agent wait <pane> --until idle --until done --timeout …`** (cờ lặp, không dùng dấu phẩy) thay poll.
- **Hook herdr chạy với env runtime của herdr**: một plugin id = một state dir. Loop scratch với state dir riêng
  nhận được `start` nhưng **mọi event** đi vào state thật → im lặng. Nghiệm thu sống phải dùng thể hệ thật
  (dừng → mượn → khôi phục). Unit test với stub là tầng duy nhất kiểm được cấu hình tách biệt.
- `pgrep -f '<pattern>'` tự khớp chính pipeline — kiểm rò rỉ tiến trình bằng `ps` + lọc, sau khi pipeline thoát.
- Critic còn chỉ ra `plugin/server/index.mjs` dùng `new URL(...).pathname` → C24.

## Cycle Log (10 vòng gần nhất — dòng mới nối vào cuối bảng này; lịch sử đầy đủ: docs/DEV-LOOP/LOG-2026-11.md)

| Vòng | Ngày | Kết quả | Commit/Tag | Ghi chú nghiệm thu |
|------|------|---------|------------|--------------------|
| no-op | 2026-11-23 | ⏸️ **no-op — backlog trống** (sau C22; no-op #1 liên tiếp) | docs-only | Quét sống sạch: loop nudge #4 rc=ok + AUDIT ok commits=20 tags=0 (cơ chế C18 chạy thật, 5 dòng fixture/prose skipped đúng thiết kế), gate journal 0 lỗi + healthz 200, home TUI 0 lỗi, laptop agent PhuongNB-Laptop-TUI connected từ 20:45:08, backups 3+__latest đứng. Gate (18:25, pre-C16) và TUI home (09:16, pre-C21) vẫn chờ restart của owner — đó là điều kiện để `lastSeen` (C16) và dòng dev-loop (C21+C22) sống trên production; npm 0.13.1. Không săn theme ép |
| wave3 | 2026-11-23 | 🧪 **Wave 3: SDD với subagent, 1 agent/lúc, 3 vai** — critic (`--tools read`, 14 finding, 3 BLOCK) → spec v1.1 → implementer (red→green, 3 commit) → reviewer (`--tools read`, 2 finding → fix round) → controller FF + full suite | spec `10a5aad`→`e7d6223`; `dc39bff`,`18c45a3`,`f4b2362` | Chờ bằng `herdr agent wait`, không poll; bằng chứng reviewer là file (diff + test log) |
| C23 | 2026-11-23 | ✅ xong — **cooldown hoãn nudge, không bỏ rơi**: tách settle thành bookkeeping (chạy một lần) + nudge (hoãn được), đúng một runner tách rời, hàng rào kiểm lại, retry bridge 5s×3 | spec `10a5aad`+`e7d6223`, feat `18c45a3`, fix `f4b2362` | 62/62 file test; full suite **398/398**; **nghiệm thu sống** scratch loop maxCycles 3: `suppressed → deferred nudge scheduled in 57s → firing → nudge #2 → #3 → loop done` |
| C24 | 2026-11-24 | ✅ xong — **SELF path = đường dẫn thường trên toàn shipped tree**: `plugin/server` SELF=`fileURLToPath` cho cả 2 spawn (supervisor + publisher), `plugin/mirror` selfDir qua `dirname(fileURLToPath)`; hết sạch `new URL(...).pathname` dưới `plugin/` | spec `aeec99e` + test đỏ `7e7f77f` + feat `c98c251` | T1 tripwire quét `plugin/**/*.mjs`; T2 hành vi: serve() từ dir có dấu cách (`%20`) đỏ thật bằng MODULE_NOT_FOUND trong publisher.log → xanh (supervisor alive + hello). Suite **400/400**. Live laptop = owner (backlog ghi rõ; không đụng service/pane user) |
| C26 | 2026-11-24 | ✅ xong — **`workPauseAfter`: trần chi phí chuỗi work** — trục đối xứng C17 còn thiếu | spec `ce5063b` + test đỏ `645ecf3` + feat `b112793` | `workStreak` đếm work liên tiếp, no-op reset chéo cả 2 trục, `unknown` không đụng; auto-pause `pausedBy:auto` giữ status running, log `auto-pause: N work cycles in a row`; reset ở start/kick/resume/auto-resume C20; default **0 = tắt** (grandfather C10), **dev-loop thật = 12** (loop.json cập nhật atomic). T1–T6 đỏ→xanh (T3: fixture commit phải mang timestamp — window classify là wall-clock); suite **406/406**. Verify sống: config thật + code mới qua status sandbox `configOk:true workPauseAfter:12`; trần chỉ tự chứng minh khi chuỗi thật đụng 12 work — như C15, unit + config là bằng chứng hôm nay. Owner kick 01:29:23 sau auto-pause 18:10:29 (C17 sống thật lần đầu trên production) |
| no-op | 2026-11-24 | ⏸️ **no-op — backlog trống** (sau C26) | docs-only | Nudge #4 rc=ok, AUDIT ok commits=5; healthz 200, journals 0 lỗi, backups 4+__latest; **C26 sống thật**: state production `workStreak:1` sau vòng work đầu |
| no-op | 2026-11-24 | ⏸️ **no-op #2 — backlog trống** → auto-pause C17 ở settle kế | docs-only | Nudge #5 rc=ok, AUDIT ok commits=1; healthz 200, journals 0 lỗi; state thật `noopStreak:1 workStreak:0` — reset chéo C26 đếm đúng trên production. Rotate C21 (tripwire headroom) |
| C27 | 2026-11-24 | ✅ xong — **`sdd.mjs`: helper SDD + dogfood cổng VỪA AUTO.md v2** — lần đầu pipeline chạy thật trọn vẹn | spec v1.0–v1.2 + test `f3fc27c` + feat `1328571` | Critic thật (task.mjs tay, 10 findings: 1 BLOCK seam) → **reviewer bằng chính sdd.mjs 3 round**: r1 13 findings (lock-leak exit-in-try, intEnv nuốt 0…), r2 helper TỰ LỘ bug half-answer (deliver text giữa chừng khi busy) → T8 chặn, r3 **0 BLOCK — đủ đóng**. Settle loop chờ text+not-working (status không đọc được = busy, fail-safe); lock wx tự lành; exit 1/2/3/4/5/64. T1–T8 đỏ trước; suite **414/414** (log nguyên vẹn /tmp/c27-full-tests.log cho reviewer). Dogfood là bằng chứng sống của cả helper lẫn cổng |
