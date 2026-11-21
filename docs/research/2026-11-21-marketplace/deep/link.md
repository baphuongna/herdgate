# Đào sâu tầng 2 — LZHcode1986/herdr-link v0.8.0 (MIT)

Nguồn: clone `/tmp/deep/link` (master). Báo cáo tầng 1: `../r-link.md` (không lặp — mục nào tầng 1 đã nêu chỉ được trích thêm code + số dòng). Tổng 18.801 dòng git (lõi TS 6.894: src 2.807 + test 4.087; còn lại dist bundle, lock, docs).

## Kiến trúc đầy đủ (module graph + dòng dữ liệu)

```
PROTOCOL.md (canonical, tiếng Trung) ──máy-đọc-hoá──> src/protocol.ts (314d, zero IO)
                                                        ▲            ▲
              ┌─────────────────────────────────────────┘            │ types+errors+contract
              │ gọi control-layer                                    │
src/herdr.ts (1227d) ◄── execFile(argv, shell:false) ── Herdr CLI (JSON stdout/stderr)
   ▲    ▲    ▲        duy nhất đụng Herdr; HerdrScope{pane,binary} cho adapter shared-host
   │    │    └─ src/opencode-v2.ts (265d)  session-attributed, codemode:false, hook("context")
   │    └────── src/opencode.ts (212d, V1) single-gateway, system.transform per-session
   └─────────── src/mcp.ts (595d)  stdio JSON-RPC tay (Pi/CC/Codex/AGY), lazy 2 tầng
src/pi-wait-guard.ts (194d)  extension Pi độc lập: chỉ guard Bash, không tool/prompt
scripts/build-opencode.mjs ──esbuild──> dist/*-opencode*.js + manifest sha256 ──> scripts/install-opencode.mjs
scripts/build-mcp.mjs ──> dist/herdr-link.mcp.js (shebang banner) ──> check-mcp-bundle.mjs spawn thật
scripts/plugin-action.mjs (doctor, read-only) <── herdr-plugin.toml [[actions]]
test/*.test.ts (8 file, 4.087d): node:test + type-strip, --test-concurrency=1
```

Luồng dữ liệu 1 send: model → gateway `{action:"send"}` → adapter → `getSelfContext()` + `getAgentContext(to)` (2 CLI call fresh) → `assertSameWorkspace` → `buildEnvelope` (id adapter-side) → `agent prompt <to> <wrapper>` (không `--wait`) → peer nhận wrapper self-describing → peer dormant gọi gateway `{}` → active → reply bằng send thường về `from`.
Luồng start: model → validate (matrix placement, trước mọi allocation) → lock cursor (configured) → `allocateNewTab`/`allocateWith` → `agent start` → rollback best-effort nếu fail → receipt `{status,agent,kind}` không topology id.

Inventory phần còn lại (theo vai trò, đã đọc lướt/trọn): `CHANGELOG.md` (~200d, lịch sử 0.6→0.8 cực chi tiết), `README{,.zh-CN}.md` (marketing + self-grading), `docs/mcp-wiring.md` (325d, wiring 5 host + bảng坑), `examples/agent_config.example.json` (40d), `.github/workflows/{ci,release}.yml`, `tsconfig.json` (`erasableSyntaxOnly`, `allowImportingTsExtensions` — chạy TS trực tiếp không build bước test), `dist/` 3 bundle + manifest.

## Máy trạng thái & luồng chi tiết

**1. FSM lazy 2 tầng (per MCP connection / per OpenCode session)** — 3 trạng thái: `outside` (env gate fail → `tools/list` trả `[]`, mọi call → `NOT_IN_HERDR`), `dormant` (chỉ gateway), `active` (gateway + 4 tool Tier 1). Chuyển trạng thái idempotent, phát notification đúng 1 lần:
```ts
// src/mcp.ts:283
function activateSession(): void {
  if (activated) return;
  activated = true;
  notify({ jsonrpc: "2.0", method: TOOLS_LIST_CHANGED });
}
// src/mcp.ts:444
case "tools/list": {
  if (!environmentOk()) return respond(id, { tools: [] });
  return respond(id, {
    tools: activated ? [gatewayToolForState(true), ...toolDefinitions()] : [gatewayToolForState(false)],
  });
}
```
Điểm mấu chốt tầng 2 phát hiện thêm: **call Tier 1 trực tiếp khi dormant cũng là path activation** (`callTool` gọi `activateSession()` trước khi thi hành — mcp.ts:408-411), nên host không bao giờ kẹt ở trạng thái lệch. Gateway dispatch fallback nhận cả 2 dạng argument (nested `arguments` hoặc top-level shorthand — mcp.ts:377-380).

**2. FSM start-with-rollback (herdr.ts:569)** — allocation trả về `{paneId, rollback()}`; mọi nhánh fail đều đóng đúng artifact rồi re-throw primary:
```ts
// src/herdr.ts:489 allocateNewTab (rút gọn)
const createdTabId = parseTabCreateResult(created);
try {
  const panes = await runFor(["pane", "list", "--workspace", self.workspace_id], ...);
  const rootPanes = filterPanesByTab(panes, createdTabId);
  if (rootPanes.length !== 1) throw startFailure("created tab must contain exactly one root pane");
  return { paneId: rootPanes[0], rollback: () => bestEffortCloseTab(createdTabId, scope) };
} catch (error) {
  await bestEffortCloseTab(createdTabId, scope);  // tab tạo rồi nhưng chưa expose được
  throw error;
}
```
Cursor round-robin chỉ advance sau start thành công (herdr.ts:613-616), test khẳng định "failure keeps the cursor on the selected variant" (herdr.test.ts:1395+). `allocateWith` có **guard workspace 2 lớp**: agent record (assertSameWorkspace) rồi pane record (`anchorPane.workspace_id !== self.workspace_id` → PEER_NOT_FOUND, herdr.ts:546-549) — test riêng cho case agent-record khớp nhưng pane-record lệch.

**3. FSM self-bootstrap (herdr.ts:878-992)** — probe (bounded 3×100ms chỉ với PEER_NOT_FOUND) → đã có tên? return → rename `hl-<hex8>` → confirm bằng fresh read (không tin echo) → collision `agent_name_taken` thì regenerate (tối đa 3) → mọi failure khác collapse `SELF_UNNAMED`. Concurrent de-dup keyed per pane:
```ts
// src/herdr.ts:921-933
const bootstrapsInFlight = new Map<string, Promise<string>>();
export function ensureSelfName(scope?: HerdrScope): Promise<string> {
  let pane: string;
  try { pane = paneFor(scope); }
  catch (error) { return Promise.reject(error); }  // phải là rejected promise cho fire-and-forget
  const pending = bootstrapsInFlight.get(pane);
  if (pending) return pending;
  const started = ensureSelfNameFlow(pane, scope).finally(() => { bootstrapsInFlight.delete(pane); });
  bootstrapsInFlight.set(pane, started);
  return started;
}
```
Chi tiết tinh tế tầng 2 mới thấy: `ensureSelfName` catch `paneFor` lỗi rồi **trả rejected promise thay vì throw** — vì adapter gọi `void ensureSelfName().catch()` từ module init, throw đồng bộ sẽ crash (comment herdr.ts:928-930).

**4. Hai grade environment gate (PROTOCOL §6.1)** — in-pane (`HERDR_ENV+BIN+PANE`) vs session-attributed (không gate khi đăng ký, attribution mỗi call). Scope tách bạch:
```ts
// src/herdr.ts:75-84
function paneFor(scope: HerdrScope | undefined): string {
  const explicit = scope?.pane;
  if (explicit) return explicit;
  if (scope === undefined) assertHerdrEnvironment(); // mất env = NOT_IN_HERDR, không phải SELF_UNNAMED
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) throw selfUnnamed("HERDR_PANE_ID is missing");
  return pane;
}
```
Và binary fallback chuỗi 3 bậc: `scope.binary → HERDR_BIN_PATH → "herdr" trên PATH` (herdr.ts:66-73, CHANGELOG ghi "measured: the CLI resolves its own socket").

**5. Session attribution (opencode-v2.ts:114-176)** — walk `parentID` về root (bounded 32, chống cycle bằng `seen` set), rồi exact-match qua `agent_session{agent:"opencode",kind:"id",source:"herdr:opencode"}` > directory-unique; 0 hoặc >1 match → `SELF_UNNAMED` fail-closed. Directory chuẩn hoá `realpathSync.native` + case-fold Windows (opencode-v2.ts:71-78).

**6. Phân lớp lỗi 3 tầng** — (a) transport/JSON-RPC (`-32700…-32602` chỉ cho protocol); (b) môi trường `NOT_IN_HERDR` — **passthrough tuyệt đối**: binary stale, socket hang up, JSON hỏng đều là `NOT_IN_HERDR`, không bao giờ bị re-label thành `SEND_FAILED` (herdr.ts:133-148 `runFor` + test "surfaces a stale/deleted Herdr binary as NOT_IN_HERDR"); (c) operation (`SEND_FAILED`…) với message đóng từ bảng hằng:
```ts
// src/protocol.ts:163-176
export const AGENT_ERROR_DETAILS: Record<LinkErrorCode, string> = {
  NOT_IN_HERDR: "Herdr environment is unavailable",
  SELF_UNNAMED: "Herdr Link could not establish a stable Agent Name",
  PEER_NOT_FOUND: "target agent is not a live peer",
  ...
};
export function formatAgentFacingError(error: unknown, fallbackCode: LinkErrorCode): string {
  const code = error instanceof HerdrLinkError ? error.code : fallbackCode;
  return `${code}: ${AGENT_ERROR_DETAILS[code]}`;   // redact diagnostic thô (pane id, CLI text)
}
```
Chi tiết đáng học: **close không cần caller có tên** — chỉ cần workspace (`getSelfWorkspaceId`, herdr.ts:1186-1199): "the caller only contributes its authoritative workspace and need not itself be named" — tách requirement theo operation thay vì áp uniform.

**7. stdout serialisation (mcp.ts:218-238)** — 1 writer promise-chain FIFO cho cả response lẫn notification, xử lý `drain` backpressure; stdout không bao giờ mang gì ngoài JSON line. Test integration assert notification đến **trước** response cùng request (mcp.test.ts:862-866).

## Mọi cơ chế áp vào herdgate

1. **Test seam `setHerdrRunnerForTests` thay vì mock module** — swap runner quá trình, record argv vào mảng:
```ts
// src/herdr.ts:47-50
export function setHerdrRunnerForTests(runner: HerdrRunner | undefined): void {
  herdrRunner = runner ?? defaultHerdrRunner;
}
// test/herdr.test.ts:58 (withMock) — runner ghi {file,args} rồi delegate handler
const runner: HerdrRunner = async (file, args) => {
  calls.push({ file, args: [...args] });
  ... return { stdout, stderr: "" };
};
```
Áp vào: suite 48 file/10.069d test của ta (pi-spawn, pi-task, wake-event, publisher-lifecycle). Vì sao: cho phép assert **chuỗi argv chính xác từng bước** (`assert.deepEqual(calls.map(c=>c.args.slice(0,3)), [...])`) — assert protocol sequencing chứ không chỉ kết quả; `resetSelfBootstrapForTests`/`resetStartStateForTests` là pattern "test seam đặt cạnh state, có docblock @internal".

2. **Docs-as-code consistency test** — contract text là 1 const, test đối chiếu 3 nơi phải khớp tuyệt đối:
```ts
// test/protocol.test.ts (test "PROTOCOL.md §3 and MCP wiring §1.1 exactly match...")
const protocolMatch = protocol.match(/## 3\. Agent Communication Contract[\s\S]*?```text\n([\s\S]*?)\n```/);
const docsMatch = docs.match(/### 1\.1 canonical 文本[\s\S]*?```text\n([\s\S]*?)\n```/);
assert.equal(protocolMatch[1], COMMUNICATION_CONTRACT);
assert.equal(docsMatch[1], COMMUNICATION_CONTRACT);
```
Áp vào: mọi cặp spec↔code herdgate (specs/, DESIGN.md ↔ src/protocol/envelope.ts constants; docs skill text ↔ installer output). Vì sao: rẻ, bắt drift ngay CI, thay review thủ công.

3. **Version-manifest governance test** (test/release.test.ts, 32d): assert `package.json == package-lock (2 chỗ) == MCP_SERVER_VERSION == herdr-plugin.toml`. Áp vào: version herdgate app-mod/plugin/protocol PROTOCOL_VERSION — 1 test duy nhất giữ đồng bộ mọi nơi ghi version.

4. **Fake CLI cross-platform bằng NODE_OPTIONS preload** — thay vì shell script (không chạy nổi Windows CreateProcess), fake binary là `process.execPath` + `--require` loader chỉ kích hoạt khi `argv[1]` không phải file thật:
```js
// test/mcp.test.ts:729 writeFakeHerdr
const entry = process.argv[1];
if (entry === undefined || fs.existsSync(entry)) return;  // verb "herdr" không tồn tại → loader hành xử
if (verb === "agent" && process.argv[2] === "get") {
  if (target === "self-pane") ok({ agent: { name: "brain", workspace_id: "ws-main", pane_id: "w9:p1" } });
  else ok({ agent: { name: target, workspace_id: "ws-main", pane_id: "tgt:1" } });
}
```
Áp vào: test herdgate host/relay path cần "CLI thật" chạy end-to-end qua stdio (herdr-bridge, host-herdr, wake-event) mà không phụ thuộc bash. Vì sao: cùng code path production (spawn + JSON stdout) chạy thật trên 3 OS.

5. **Stateful fake topology handler** (test/herdr.test.ts:143 `startTopologyHandler`) — fake có memory (panes list, tabSeq/paneSeq counter, `startFailures` injection, `failTabClose`, `paneListOverride`) mô phỏng đúng measured CLI shapes. Áp vào: test pi-spawn/pi-revive — herdgate cần fake pane/worktree lifecycle tương tự với "inject N lần fail ở bước X". Vì sao: rollback/cursor test cần failure tại đúng vị trí trong chuỗi, không phải fail-all.

6. **Readline waiter-queue child-process harness** (mcp.test.ts:649 `McpServerProcess`) — mọi stdout line đẩy vào `all[]` + pending/waiters; `next(label)` có timeout 15s và tên để debug; `raw()` gửi line rác thử Parse error rồi ping lại chứng minh server còn sống. Áp vào: test ssh-bridge/gateway herdgate (WebSocket/WebSocket-like streams). Vì sao: pattern typed queue này tránh race "đọc trước khi message đến" — chuẩn cho mọi integration stream test.

7. **Closed error vocabulary + redaction** (protocol.ts:133-176, excerpt mục §6.6 trên). Áp vào: `src/protocol/envelope.ts` + error path của gateway/ssh-bridge — herdgate tách 3 lớp: transport (socket/SSH down), pairing/scope, operation (spawn fail); model/agent-facing message lấy từ bảng hằng, không rò pane id/path. Vì sao: message ổn định = test được bằng string, và không lộ topology ra ngoài scope.

8. **Allocation + rollback contract `{paneId, rollback()}`** (herdr.ts:489-567). Áp vào: spawn path herdgate (pi-spawn): tạo worktree/tab xong rồi `agent start`/session-attach fail → đóng đúng artifact vừa tạo, giữ primary error; `rollback().catch(()=>{})` không bao giờ thay primary. Vì sao: tránh rác pane/worktree khi fail giữa chừng — pipeline herdgate dài hơn nên cần đúng контракт này ở mọi bước tạo-2-fa.

9. **Lock cursor keyed `${configPath}\0${agent}` + advance-on-success-only** (herdr.ts:365-383, 613-616). Áp vào: worker pool / round-robin chọn model|host herdgate nếu có. Vì sao: promise-chain lock không dependency, và "chỉ advance khi thành công" tự nhiên cho retry cùng variant sau fail.

10. **HerdrScope pattern** (herdr.ts:53-84): mọi hàm control-layer nhận `scope?: {pane?, binary?}`, omitted = in-pane env authority + NOT_IN_HERDR classification. Áp vào: `src/host/herdr.ts` — mọi lệnh herdr của herdgate nên đi qua 1 runner có scope tường minh (host pane vs cloud relayer), phân loại lỗi môi trường đồng nhất. Vì sao: hướng giải quyết chung cho "code chạy cả trong pane lẫn ngoài pane" mà không if-else rải rác.

11. **`invokedDirectly()` bằng realpath so sánh** (mcp.ts:574-586): bin là symlink nên phải `realpathSync(argv[1])` trước khi so `import.meta.url`. Áp vào: mọi entry herdgate vừa import vừa chạy (`bin/herdgate.mjs`, probe scripts). Vì sao: bug im lặng kiểu "spawn qua bin cài đặt → no-op" rất khó bắt.

12. **Fire-and-forget bootstrap trả rejected-promise** (herdr.ts:923-933, mục §3 above). Áp vào: wake-event/publisher init path herdgate nơi ta gọi `void init().catch()` ở module load. Vì sao: throw đồng bộ tại top-level import = crash cả process.

13. **Marker + sha256 manifest + reproducible build + import-graph audit** (scripts/build-opencode.mjs:39-49 `markerFor`; check-opencode-bundles.mjs rebuild rồi so sha256, đọc metafile asserts v1 bundle không chứa SDK v2 và ngược lại; `isPacked()` kiểm `package.json.files`). Áp vào: dist herdgate (app-mod, plugin, cloud bundle). Vì sao: bắt được cả regression lẫn shipping sót file; release workflow còn `npm pack` + extract + chạy check trên tarball thật (release.yml "Verify the publish tarball").

14. **Installer atomic-write + backup + verify-then-rollback** (install-opencode.mjs:286-336): write temp→rename; verify bằng import bản copy byte-identical dưới root `type:module` riêng; fail → restore backup timestamped hoặc remove file vừa ghi; test phủ cả 2 nhánh rollback bằng fixture tự điền sha256 (test/install-opencode.test.ts). Áp vào: `windows/install-cli.mjs`, `scripts/install-pi-skills.mjs`, cập nhật app-mod. Vì sao: install là nơi user mất niềm tin nhanh nhất; "verify deployed rồi mới commit" + rollback là chuẩn vàng.

15. **`agent prompt` KHÔNG `--wait` + wrapper self-describing** — test khẳng định `promptCall.args.length === 4` và `!includes("--wait")` (herdr.test.ts:309-311); gửi xong return `{status:"sent"}`. Áp vào: publisher/task path herdgate gửi prompt cho Pi agent (wake-on-settle): payload kèm JSON envelope dòng cuối + hướng dẫn回流 — nhận side tự biết trả lời đâu, không cần docs side. (Tầng 1 đã nêu ý tưởng; tầng 2 xác nhận implementation chỉ 4 argv và có test khóa.)

## Cách họ test (bài học cho suite ~48 file/10k dòng của ta)

- **`node:test` + `--experimental-strip-types --test-concurrency=1`**: chạy TS trực tiếp, không build; **concurrency 1** vì env vars + process.cwd() là shared state (package.json scripts). herdgate cũng mock env nhiều — cân nhắc serialize các test đụng env.
- **3 lớp test rõ ràng**: (1) pure unit (protocol.test: 337d cho 314d code — tỉ lệ ~1:1); (2) control-layer qua runner seam (herdr.test 1.565d, sequencing-assert từng argv); (3) integration thật: spawn server + fake CLI preload + readline harness (mcp.test 1.035d) — kể cả symlink-bin path và Windows fallback `EPERM` diagnostic.
- **Env snapshot/restore là idiom lặp lại** ở mọi file (`snapshotEnv`/`restoreEnv`, `t.after`) — không bao giờ để env leak giữa subtest.
- **Test cả "gì KHÔNG xảy ra"**: `assert.equal(calls.some(c => c.args[1] === "prompt"), false)` sau khi send fail — assert không-delivery, không-touch pane. Pattern cực mạnh cho fail-closed.
- **Test idempotency và transition-once**: activation gọi 3 lần → vẫn 1 notification; contract inject 2 lần → system length vẫn 2.
- **Test comment "why"**: gần mọi khối assert có comment giải thích scenario thực (vd "The caller pane moves to ws-2; ambient env stays stale and must lose").
- **Naming test theo hành vi**: "surfaces a stale/deleted Herdr binary as NOT_IN_HERDR instead of SEND_FAILED/CLOSE_FAILED" — tên test là tài liệu phân lớp lỗi.
- **CI**: matrix 3 OS × 2 Node (22, 24), fail-fast:false; publish từ tag với npm provenance (Sigstore) + tarball-verify; GitHub Release sinh từ CHANGELOG awk theo tag — mọi bước chạy lại full test trước publish.

## Anti-pattern / không lấy gì

- **Zero-retry doctrine**: chỉ 2 retry bounded (readiness, name-collision) — đúng cho channel, sai cho orchestration. herdgate revive/settle/delivery-cần-đảm-brủ phải tự có retry/backoff có chủ đích; đừng bắt chước "no retry, no ack" như nguyên tắc.
- **"sent is delivery only" + wait-free**: herdgate publisher cần wake-on-settle + receipts tồn tại precisely vì thiếu guarantee này — envelope Link-style không thay được receipts JSONL (principal `spawn:<id>` đã có ngữ nghĩa riêng).
- **Same-workspace-only addressing**: thiết kế cố ý của Link, đối lập mô hình cross-machine (VPS relay, cloudflared) của herdgate — đừng cố map peer-name model sang device/leg model.
- **Spec tiếng Trung**: canonical spec 1 ngôn ngữ không Anh — cộng đồng khó review; herdgate giữ spec Anh/Việt song song nhưng consistency-test (cơ chế số 2) vẫn lấy được.
- **Tự viết JSON-RPC/stdio tay**: hợp lý vì scope đóng 5 method, nhưng herdgate đã có WebSocket protocol riêng + rate-limit — không có lý do thêm lớp JSON-RPC tay.
- **In-memory-only activation + ephemeral naming**: server restart mất hết (bất lợi chấp nhận của Link); herdgate cần quan sát bền (receipts, GC) — đừng học phần "không persist gì" ngoài đúng scope session.
- **`executableText` guard + `terminate:true`**: guard chặn `bash -c "…"` giấu lệnh (đã ghi rõ trade-off) — nếu herdgate làm guard tương tự phải biết lỗ hổng có chủ ý đó; và `terminate:true` chỉ hợp khi runtime hỗ trợ end-turn chính tắc.

## File đã đọc (tầng 2, clone /tmp/deep/link)

Đọc trọn: `src/protocol.ts` (314d), `src/herdr.ts` (1.227d, 2 lượt), `src/mcp.ts` (595d), `src/opencode-v2.ts` (265d), `src/opencode.ts` (212d), `src/pi-wait-guard.ts` (194d) — toàn bộ src; `test/protocol.test.ts` (337d), `test/pi-wait-guard.test.ts` (143d), `test/release.test.ts` (32d), `test/install-opencode.test.ts` (117d), `test/mcp.test.ts` (1.035d), `test/opencode.test.ts` (461d), `test/opencode-v2.test.ts` (397d) — 7/8 test file trọn; `test/herdr.test.ts` (1.565d) đọc 3 lượt, trọn nội dung trừ ~40d trùng lặp vùng giao; `scripts/build-mcp.mjs` (34d), `scripts/build-opencode.mjs` (130d), `scripts/check-mcp-bundle.mjs` (59d), `scripts/check-opencode-bundles.mjs` (169d), `scripts/mcp-probe.mjs` (46d), `scripts/plugin-action.mjs` (100d), `scripts/install-opencode.mjs` (495d) — trọn; `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `package.json`, `herdr-plugin.toml`, `tsconfig.json`, `examples/agent_config.example.json`, `dist/herdr-link.opencode.manifest.json`, `CHANGELOG.md` (50d đầu), `PROTOCOL.md` (đọc lại toàn bộ §1–§6.3 lần này để锚 định số mục). Tầng 1 đã đọc và không đọc lại: `README.md`, `README.zh-CN.md`, `docs/mcp-wiring.md`. Tổng tầng 2: **29 file, ~6.600 dòng đọc thật**.
