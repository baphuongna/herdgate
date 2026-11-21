# HerdrChat (cobanov/herdrchat) — tầng 2: excavate toàn diện

Nguồn: clone /tmp/deep/chat (Apache-2.0, NOTICE attribution nếu copy code). Tầng 1 (r-chat.md) đã tóm 10 cơ chế — báo cáo này KHÔNG lặp, chỉ đào sâu: đọc trọn 9.500+ dòng lõi, mọi state machine, cách test, và cơ chế tầng 1 chưa chạm.

## Kiến trúc đầy đủ (module graph: ai gọi ai, dữ liệu chảy thế nào)

```
UI (app/ routes mỏng ≤100 dòng)
 └─ src/features/<domain>/  hooks + components (chỉ tầng này dùng React)
     └─ HerdrClient (src/lib/herdr/client.ts, 1458d) ── mọi verb herdr
         ├─ HerdrSocket (socket.ts, 815d) ── JSON-RPC newline qua bridge
         │   ├─ LiveBridge: python3 duplex giữ-mở, tag `b<n>\t<req>` multiplex
         │   ├─ one-shot: PYTHON_BRIDGE / api-bridge (base64) / remote-api-bridge (FIFO)
         │   └─ callMany/callEach: gộp N request = 1 kênh SSH (batchCommand markers)
         ├─ TranscriptStore (transcript/store.ts, 1075d) ── đọc JSONL 6 agent
         │   └─ parser/message → ChatMessage → threadItems → ThreadWindow
         ├─ EventFeed (events.ts) ── events.subscribe stream + reconnect
         │   └─ useHostEvents (hook) → kick poll
         └─ Transport interface (transport.ts): exec/streamLines/duplex
             ├─ SshHerdrTransport → native iOS Citadel / Android sshj
             ├─ withSession() wrapper (session.ts) — bind HERDR_SESSION ở transport
             └─ DemoHost — host giả đầy đủ cho test + E2E không cần máy thật
 state/: zustand + SQLite + keychain; connections.ts giữ 1 client/host (1 SSH conn)
 relay/: Cloudflare Worker ký APNs/FCM — không lưu gì, không log
```

Luồng dữ liệu chính: poll (snapshot+screen+presence gộp 1 kênh) → session binding (session_sig đổi → drop cache) → tails (1 tail/session, cursor byte UTF-8, SQLite persist) → ThreadWindow (arrivals vs echoes) → threadItems (fold tool-run, card subagent/workflow). Ghi: snapshot có sharing in-flight + `recentSnapshot(maxAge)` để iPad list+chat không đọc trùng.

## Máy trạng thái & luồng chi tiết

**1. Prompt delivery (3 trạng thái + verification ladder)** — tầng 1 đã nêu kết quả; tầng 2 đọc trọn thang bậc trong `useDelivery.ts:120-220`:
```ts
const outcome = await client.sendPrompt(target.paneId, text);
if (target.agent === 'codex' && outcome !== 'delivered') { await awaitCodexReceipt(); return; } // chờ receipt JSONL, không resend
if (outcome === 'stalled') { markFailed(echoId); setActionError(STALLED_WARNING); return; }      // host đã xem = ANSWER
if (outcome === 'unverified' && !wasWorking) {                   // legacy: Enter thứ 2 chỉ khi host nói idle
  let accepted = await client.waitAgentStatus(target.paneId, REACTED, 3500);
  if (!accepted) { const state = await paneState(target.paneId);
    if (state === 'idle') { await client.sendKeys(target.paneId, ['Enter']); accepted = await client.waitAgentStatus(...); }
    else accepted = state === 'reacted'; }   // unknown → KHÔNG Enter, báo lỗi
```
Exception path: `thrown.transport` (mất kết nối giữa chừng) → chờ receipt 8s với lời "may have arrived" — retry tức gửi đôi (#83).

**2. Capability memo 2 nguồn tuổi khác nhau** (client.ts:1208-1218):
```ts
if (this.hostVersion !== null) return { provenance: 'version', answer: Promise.resolve(atLeast(this.hostVersion, AGENT_VERBS_VERSION)) };
const memo = { provenance: 'probe', answer: this.probe(subcommand).then((o) => { if (o === 'unreachable') forget(memo); return o === 'supported'; }) };
```
Probe-derived "no" bị snapshot có version ghi đè (`acceptSnapshot` đặt lại memo null) — 1 blip mạng trước poll đầu không hạ cấp host vĩnh viễn.

**3. Poll loop với kick-mid-poll** (useAgentPoll.ts:140-150, 280-285):
```ts
if (inFlight) { again = true; return; }   // event đến giữa poll → chạy thêm 1 vòng khi xong
...
kickRef.current = () => { if (inFlight) again = true; else schedule(EVENT_DEBOUNCE_MS); };
// finally: schedule(again ? EVENT_DEBOUNCE_MS : backoffDelay(base, failures))
```
Lỗi cũ #88: đặt timer kick bị `schedule(backoff)` của chính poll clear mất. Tốc độ: `statusPollMs = streamLive && !fast ? 30_000 : 2_000 × pollScale`; `pollsFast` = working‖blocked‖watchingPanel‖agentsRunning (Claude idle nhưng background agents chạy vẫn cần fast).

**4. EventFeed** (events.ts:60-115): state `running/live/failures/generation`; watch(panes) idempotent theo sorted-set, đổi → reconnect (subscription không amend). Khi stream start hoặc nhận `events_lost` → phát `RESYNC_EVENT` (event tổng hợp "đọc lại toàn bộ") vì **events không replay** (#94). Backoff 1s × 2^n, trần 30s. `socket_unavailable` → tắt hẳn, poll gánh.

**5. Tail lifecycle** (useTranscriptTails.ts): map<sessionSig, AbortController> + `tailBeats` (lần cuối có dòng) + `tailFailures` + `absentRetry` (backoff 5s→60s khi file chưa có nhưng có sibling đang live — #99). Watchdog `dropSilentTails`: im lặng ≥90s **khi agent working** (working = đang append theo định nghĩa) → abort, poll kế restart từ cursor. Failure đầu restart ngay không báo; failure thứ 2 mới hiện banner.

**6. ThreadWindow echo↔receipt** (threadWindow.ts:61-100):
```ts
addEcho(echo) { this.baselines.set(echo.id, new Set(this.arrivals.map(m => m.id))); ... }
view() { this.echoes = this.echoes.filter((echo) => {
    const receipt = this.arrivals.find(m => m.role === 'user' && !baseline?.has(m.id)
      && !this.claimedReceipts.has(m.id) && receiptKey(m) === receiptKey(echo));  // text + số ảnh
    if (receipt === undefined) return true; this.claimedReceipts.add(receipt.id); ... });
```
Chỉ arrival MỚI (không có trong baseline lúc gửi) mới xác nhận echo — match toàn bộ history làm chữ "again" thứ 2 biến mất. `receiptKey` = text + image count (chỉ text xác nhận nhầm message chỉ-ảnh với tool result).

**7. Delegation state machine** (threadItems.ts `delegationOf`): input = call.result + notices(theo toolUseId) + noticesByTask(theo taskId) + handbacks(theo agentId) + resumes(SendMessage seq). LAUNCHED regex → background; resume sau notification → quay lại running; kết quả ưu tiên handback mà notification trỏ tới (`handbackPointer`). Đóng băng state SAU khi đọc trọn window (notices đến sau card).

**8. Relay** (relay/src/relay.ts): Worker vô trạng thái; parsePush whitelist trường + capping (title 120/body 240/request 4KB), token regex hex64+/FCM; Apple reason passthrough (`Unregistered`/`BadDeviceToken` bảo watcher ngừng gửi); rate limit per-token + per-IP inject được.

## Mọi cơ chế áp vào herdgate (excerpt + file:line + đích + vì sao)

1. **In-flight snapshot sharing + `fresh`** — client.ts:159-163. *Đích: op poll của publisher + mobile TUI fetch.* Nhiều consumer cùng hỏi 1 host → chia sẻ promise; op write cần `fresh: true` (đọc bắt đầu SAU khi write đi) để quyết định retry an toàn. Vì sao: herdgate publisher + PWA có thể poll song song cùng host như iPad list+chat của họ.
2. **Batch N request = 1 kênh SSH bằng markers** — socket.ts:424-438 `batchCommand` chèn `@@hc-batch-begin <i>` / `@@hc-batch-end <i> <exit>` quanh mỗi lệnh trong `sh -c`, `parseBatch` trả `{ok,result|error}` từng entry, entry hỏng không giết batch; `batchParts` cắt theo 126KB argv. *Đích: mobile TUI SSH (gộp receipts+session tails+status = 1 exec).* Vì sao: mỗi exec = 1 kênh SSH + 1 process host; MaxSessions=10.
3. **LiveBridge duplex multiplex tag** — socket.ts:318+ script host `LIVE_BRIDGE` (socket.ts:380-395): stdin `tag\t<json>\t\n`, mỗi request 1 thread connect socket riêng, đáp `tag\t<line>`; timeout → `end()` cả bridge (nửa-chết thì mọi request sau đều chờ deadline riêng). *Đích: publisher SSH connection dài — thay N exec bằng 1 duplex.* Vì sao: tiết kiệm channel + process; tag correlation chuẩn cho async.
4. **Không bao giờ fallback sau khi socket đã trả lỗi** — client.ts `request()`: "a refusal on one is a refusal on the other; retrying a write through the CLI after the socket reported a failure is how a prompt gets sent twice". *Đích: gate op send — mọi đường ghi (socket/HTTP/CLI) chung server thì lỗi server = lỗi cuối, chỉ transport-mất-tín-hiệu mới được retry.* Vì sao: nguyên tắc #83 tổng quát hoá.
5. **fileProbe 4 câu hỏi bằng exit code, không parse stderr** — store.ts:430-470, exit 44=absent / 45=unsearchable / 46=unreadable:
```ts
`[ -d ${folder} ] || exit 44; [ -x ${folder} ] || exit 45; [ -e ${q} ] || exit 46;`  // thực tế 44/45/46
`[ -r ${q} ] || exit ${UNREADABLE_EXIT}; wc -c < ${q}`
```
*Đích: mọi poll file JSONL của herdgate (receipts, session tail) — phân biệt "chưa có" (im lặng retry) vs "không đọc được" (phải nói ra).* Vì sao: stderr locale hoá làm host non-English đọc sai thành unknown mãi mãi.
6. **Cửa sổ byte + strip ảnh trên host** — store.ts:923-955 `windowScript`: `dd bs=1 skip=N count=0` seek + `head -c` đọc tiếp (không `tail -c +N` — BSD 60MB/s), chunk 4MB ×4 khi thiếu dòng, `sed -E 's|"[A-Za-z0-9+/=]{128}..."|""|g'` strip base64 TRƯỚC khi qua mạng (30MB → 196KB đo được). *Đích: publisher đọc Pi session tail + timeline history paging.* Vì sao: transcript có ảnh nhúng = dòng nửa MB; byte-window không strip là thảm hoạ mobile.
7. **Tail frame `<bytes>\t<line>` + cursor byte UTF-8** — store.ts:1003-1015 awk đếm `length($0)` ở C-locale in kèm size dòng; JS `unframe` cộng bytes+1 (newline). Resume đúng đầu dòng qua `lineStartBefore` (grep -b trong 64KB trước cursor), KHÔNG rewind mù (#109 — cursor dừng giữa ký tự multi-byte). *Đích: publisher tail receipts/sessions.* Vì sao: drift vài byte = mất message vĩnh viễn.
8. **Chọn window-vs-tail theo gap** — useTranscriptTails.ts:242-247: cursor lệch ≤64KB (CATCH_UP_BYTES) → tail replay; lớn hơn → đọc window mới một lần (#66: gap 11MB replay từng dòng mất phút). *Đích: publisher reattach sau disconnect.*
9. **Batcher gộp burst** — batcher.ts + TAIL_BATCH_MS=100: burst dòng (call+result+reply) = 1 write SQLite + 1 cursor + 1 rebuild. *Đích: publisher ghi receipts và timeline ingest.* Vì sao: từng dòng 1 transaction làm UI giật.
10. **keepUnchanged JSON-identity** — sameShape.ts:7-19: phần tử bằng JSON cũ → giữ object cũ; không đổi gì → trả chính `previous`. *Đích: timeline/PWA render list.* Vì sao: poll rebuild rows mới = re-render toàn list.
11. **untilChannelCloses** — shell.ts:75-89: `exec 3<&0`, chạy lệnh với stdin=/dev/null, watcher `cat <&3` đọc stdin kênh SSH — kênh đóng → kill lái tiến trình (`hc_leaves` đệ quy pgrep -P). *Đích: MỌI `tail -f`/watcher của publisher qua SSH.* Vì sao: đóng SSH channel không giết lệnh phía sau (#4 — mỗi thread rơi lại một `tail -f` chạy hàng giờ).
12. **withPath prefix PATH tường minh** — shell.ts:50: `export PATH="$HOME/.local/bin:...:$PATH"; ` trước mọi lệnh. *Đích: publisher/gate SSH exec.* Vì sao: shell non-interactive không load profile → exit 127 oan.
13. **Wrapper transport bind session** — session.ts `withSession`: bọc transport thay vì thêm tham số — "call site mới không thể quên vì không bao giờ phải nhớ". *Đích: herdgate nếu cần namespace/env cho mọi lệnh SSH (vd agent workdir, user) — bind 1 chỗ.*
14. **probeScript 1 round-trip, luôn exit 0, in BRIDGE/SOCK** — socket.ts:689-706. *Đích: publisher phát hiện năng lực host (Có tail? Có jq?...) — 1 exec, không đoán bằng stderr.* Vì sao: probe mà tự fail thì không nói gì được; memo hoá chỉ khi host TRẢ LỜI.
15. **Sized-check trên lệnh HOÀN CHỈNH, không phải payload** — socket.ts:552-570 MAX_COMMAND_BYTES=126KB check `utf8Length(command)` sau khi base64 (×4/3) + quote ('→'\\'' 4 lần). *Đích: gate gửi prompt lớn qua SSH.* Vì sao: check sai tầng để lệnh 96-120KB qua check rồi chết E2BIG trên host (#105).
16. **Presence piggyback + TTL + seq** — client.ts `reportMetadata`: queue report, poll kế mang theo (`pollSnapshot`), 5s không ai mang thì tự đi; TTL tự hết hạn. *Đích: gate báo status lên publisher sidebar.* Vì sao: client di động là reporter bất khả tín — TTL là toàn bộ câu chuyện an toàn.
17. **connectionRecovery: code → action** — connectionRecovery.ts:1-70 map code lỗi → {title,label,action} 6 hành động. *Đích: lib lỗi herdgate + PWA error banner.* Vì sao: mỗi mã lỗi có 1 next-step khác nhau (credentials/address/path/install/start/retry); bảng thuần dễ test.
18. **needsTheUser: ngừng poll khi lỗi chỉ người dùng sửa được** — poll.ts:74-80 (auth_failed/host_key_changed/...) vì OpenSSH PerSourcePenalties + MaxStartups từ chối hẳn phone khi retry mù. *Đích: publisher poll loop.* Vì sao: retrylogin sai mỗi 2s = tự DDoS chính mình.
19. **Interrupt confirm bằng vòng quan sát** — client.ts `interrupt`/`leftWorking`: gửi Escape/esc (2 spelling, thử lần lượt), rồi poll status rời `working` ≤3s; status không đọc được = coi thành công (may-have-worked không báo fail). *Đích: op stop của gate.* Vì sao: host nhận key ≠ agent dừng; và spelling key không kiểm chứng được từ client.
20. **Codex/current-rollout qua state DB, không newness** — store.ts `findCodexTranscript`: nhiều file cùng id → hỏi `sqlite3 state_*.sqlite` `rollout_path`; không có sqlite3 → `codex_session_ambiguous`, KHÔNG mở gì. *Đích: nguyên tắc cho mọi resolution session trùng id của herdgate (spawn registry).* Vì sao: chồng chéo id là real; "mới nhất" sai đúng lúc trông giống đúng nhất.

## Cách họ test (bài học cho suite 213 test của ta)

- **ShellHost pattern** (transcriptStore.test.ts:89-121): transport giả chạy `/bin/sh -c <lệnh thật>` trên file thật trong tmpdir — "canned answer chỉ test canned answer"; chạy cả BSD (Mac) lẫn GNU (CI). Subagents test chạy cùng lệnh dưới cả `sh` LẪN `zsh` (`describe.each(SHELLS)`) vì zsh abort khi glob rỗng. → herdgate: test mọi host-script (readChanged, windowScript) bằng real shell, không mock grep/sed.
- **Fake transport đếm lệnh** (sendPrompt.test.ts): mọi test khẳng định cả SỐ LẦN gửi lẫn nội dung ("never sends twice for one prompt, on either path"; "probes once per client, not once per send"). → gate: test send-path phải đếm số lần ghi xuống SSH/socket, pin "không gửi đôi".
- **Invariants thay vì cases**: "pages to the start with no gaps and no repeats" (loop paging tới đầu file, so id-list y nguyên); "must always make progress" `expect(page.startByte).toBeLessThan(anchor)` + guard 100 vòng. → test paging timeline/receipts theo bất biến, kèm guard chống vòng vô hạn.
- **Comment test = lý do**: mỗi `it` mở đầu bằng vì-sao bug ("The reported bug: ... base64 twice"). Bug fix nào cũng thêm test sẽ bắt được nó (CLAUDE.md Gates).
- **Fixture màn hình thật** (`fixtures/screens/*.txt` 25 file ANSI thật của Claude/Codex/Grok) + fixture JSONL đo từ version cụ thể (meta 2.1.294). → herdgate: lưu bản ghi thật của Pi/herdr output làm fixture, ghi kèm version đo.
- **Cấp độ**: jest cho src/lib (pure, transport là interface); Maestro flow `.maestro/regression/` (24 flows) chạy trên Demo host — "A feature the Demo cannot show gets a Demo scenario first". CI: typecheck+lint+jest+python unittest, Android compile riêng; E2E nightly (build 40') chứ không mỗi PR.
- **Relay test**: logic Worker tách khỏi runtime (RelayDeps fetch/subtle/now inject) để jest chạy được.

## Anti-pattern / không lấy gì

- **Native modules** (Citadel/SwiftNIO/sshj/SwiftTerm): herdgate là Node/PWA — chỉ lấy ý (TOFU pin với `presentedFingerprint` trả về để UI hỏi trust; path-monitor reset client khi route đổi; mỗi dial 1 event-loop-group riêng để handshake fail không rò connection pre-auth → sshd MaxStartups từ chối cả phone).
- **Screen-scraping ANSI** (blockedPrompt.ts 825d parse menu): last resort — herdgate có receipts JSONL có cấu trúc, không xuống cấp này trừ khi không còn đường.
- **Presence-report qua `pane.report_metadata` + sidebar tokens**: cơ chế display-one-way đẹp nhưng phụ thuộc verb riêng của herdr; không áp trực tiếp.
- **Keychain/SecureStore migration** (connections.ts `loadMigrating` 3 bước spare-copy): bài học migration secret hay (SecItemUpdate không đổi accessibility) nhưng herdgate không có keychain mobile native.
- **Batch marker `@@hc-batch-begin` dễ vỡ nếu output lệnh chứa marker** — họ tránh bằng marker ngẫu nhiên cho latestMessages (`randomMarker()`) nhưng batch vẫn marker tĩnh; nếu herdgate mượn pattern batch thì dùng marker random per-call.
- **Version-gate bằng snapshot.version trước probe**: tốt, nhưng herdgate không có khái niệm "host herdr cũ/mới" tương tự — đừng thêm tầng probe nếu đã có version ở handshake.
- **License**: Apache-2.0 + NOTICE — mượn code phải attribution; wording "Ran N commands" của zeron (MIT) credit riêng nếu copy nguyên câu.

## File đã đọc (đầy đủ + dòng)

ĐỌC TRỌN: `src/lib/herdr/client.ts` (1458d), `socket.ts` (815), `protocol.ts` (303), `events.ts` (260), `timeouts.ts` (238), `transport.ts` (43), `session.ts`, `shell.ts`; `src/lib/transcript/store.ts` (1075); `src/lib/threadItems.ts` (587); `src/lib/poll.ts` (134), `batcher.ts` (46), `sameShape.ts` (20), `connectionRecovery.ts` (70), `connecting.ts` (18); `src/lib/threadWindow.ts` (131); `src/lib/subagents/meta.ts`, `taskNotice.ts` (107), `delegationEnd.ts`, `scriptMeta.ts`, `workflowRun.ts` (253); `relay/src/relay.ts` (388); `src/state/connections.ts` (394); `src/features/thread/useTranscriptTails.ts` (412), `useDelivery.ts` (349), `useAgentPoll.ts` (330), `useThreadConnection.ts`; `src/features/usePollGate.ts`, `useHostEvents.ts`; `CLAUDE.md` (193).
ĐỌC PHẦN LỚN: `modules/herdr-ssh/ios/SshConnection.swift` (253/465 — lifecycle, TOFU, event-loop-group); test `src/lib/__tests__/sendPrompt.test.ts` (240/448), `transcriptStore.test.ts` (420/933), `subagents.test.ts` (80/409); `.github/workflows/ci.yml`, `e2e.yml` (40); `package.json` (scripts+jest).
Tầng 1 đã đọc (không đọc lại): README, modules/herdr-ssh/README, docs/adding-an-agent.md, parser.ts/blockedPrompt.ts/paths.ts/reader.ts (partials).
TỔNG: 32 file, ~9.500 dòng trọn + ~1.700 dòng phần. Phát hiện giá trị nhất: **bộ protocol cursor byte (windowScript/tailScript/fileProbe) + cơ chế chống gửi-đôi (request-no-fallback, transport-vs-server error, echo-baseline receipt)** — dựng trọn "đọc-ghi an toàn qua SSH không tin tưởng gì" cho publisher/gate của herdgate.
