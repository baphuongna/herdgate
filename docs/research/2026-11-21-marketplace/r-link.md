# Nghiên cứu LZHcode1986/herdr-link (v0.8.0, MIT) — áp dụng vào herdgate

Nguồn: github.com/LZHcode1986/herdr-link, branch `master`. Đã fetch + đọc thật 10 file (danh sách cuối bài).

## Kiến trúc cốt lõi (file-level)

- `src/protocol.ts` (314d) — lõi thuần, **zero Herdr IO**: hằng số `PROTOCOL_ID="herdr-link/1"`, `AGENT_NAME_RE=/^[a-z][a-z0-9_-]{0,31}$/`, `MESSAGE_ID_RE=/^hl_[a-z0-9]+_[a-z0-9]+$/`; type `HerdrLinkEnvelope{protocol,id,from,to,message}`; 10 error code `LINK_ERROR_CODES` + class `HerdrLinkError`; `buildEnvelope()`, `isHerdrLinkEnvelope()`, `buildInboundWrapper()`, `extractInboundEnvelope()`, `COMMUNICATION_CONTRACT` (6 rule).
- `src/herdr.ts` (1227d) — control layer duy nhất đụng Herdr CLI: `runHerdr()` qua `execFile` argv (shell:false), `classifyCliError()` map `agent_not_found→PEER_NOT_FOUND`; `getSelfContext()`/`getAgentContext()` resolve fresh mỗi call; `assertSameWorkspace()` fail-closed; `ensureSelfName()` bootstrap §6.3; `startAgent()` (validate → placement allocation → start → rollback); `sendMessage()`; `closeAgentPane()`; `listPeers()`.
- `src/mcp.ts` (595d) — stdio MCP server viết tay, không MCP SDK: `createSerializedLineWriter()` (FIFO + backpressure drain), `createRequestHandler()` (closure `activated` per connection), lazy `tools/list` (3 trạng thái: ngoài Herdr `[]` / dormant `[herdr_link]` / active 5 tool), `notifications/tools/list_changed` một lần, gateway action-dispatch fallback; builder contract prefix/wrapper cho Codex/AGY.
- `src/opencode-v2.ts` (265d) — adapter "session-attributed": `resolveSessionScope()` map sessionID→pane qua `agent_session` id rồi fallback directory-unique, fail-closed `SELF_UNNAMED`; gateway `codemode:false` liệt kê trực tiếp; contract inject qua `ctx.session.hook("context")` chỉ session đã active.
- `src/pi-wait-guard.ts` (194d) — extension Pi duy nhất: `executableText()` parser blank quote/heredoc/here-string/comment, chỉ chặn `herdr agent wait` và `herdr agent prompt ... --wait`, không tool không prompt.
- `PROTOCOL.md` (278d, tiếng Trung) — spec canonical 9 mục: envelope §2, hai档 contract §3, tier §4, address model §5, adapter contract §6 (env gate, activation, bootstrap §6.3), lỗi §7, command safety §8, non-goals §9.
- `herdr-plugin.toml` — chỉ 1 action `doctor` (read-only) cho operator; agent-facing surface nằm trong npm package.
- `docs/mcp-wiring.md` (325d) — wiring Pi (`exposure:"codemode"` + `description`), CC (`--allowedTools "mcp__herdr_link__*"`), Codex (`env_vars` bắt buộc), AGY (PreInvocation `ephemeralMessage`); bảng "đã知坑" 6 mục thực测.
- `package.json` — `pi.extensions` trỏ `src/pi-wait-guard.ts`; bin `herdr-link` = `dist/herdr-link.mcp.js`; Node ≥22.6, `--experimental-strip-types --test`.

## Cơ chế đáng học — chi tiết (code/từ_keyword thật + file)

1. **Lazy two-tier gateway, zero-learning**: dormant model chỉ thấy 1 tool `herdr_link` schema tối tiểu; gọi `{}` → `activateSession()` phát 1 notification `tools/list_changed` (mcp.ts), Tier 1 hiện ra. Host không refresh vẫn dùng được nhờ gateway `{"action":"send","arguments":{...}}` (`callGateway()` mcp.ts). Tiết kiệm context: contract không nằm trong system prompt khi idle.
2. **Self-describing inbound wrapper** (`buildInboundWrapper()` protocol.ts): text hướng dẫn + **envelope JSON nguyên văn ở dòng cuối** (`extractInboundEnvelope()` quét bottom-up). Receiver dormant đọc wrapper tự biết kích hoạt gateway và trả lời `from` — không cần prompt-injection, không cần docs. Đây là cơ chế "activation by inbound message" rẻ nhất hệ thống.
3. **Envelope tối tiểu + adapter-owned identity**: `id` do `createMessageId()` sinh (`hl_` + base36 ts + random), `from` resolve từ live record (`getSelfContext()`), model chỉ đưa `to`+`message`; reply = send thường về `from`, không đọc `id` của message nhận được (PROTOCOL §2.2).
4. **Fresh resolution, không tin env**: mỗi call `agent get` lại; `HERDR_WORKSPACE_ID` chỉ là tín hiệu tồn tại, pane move cross-workspace vẫn giữ giá trị cũ → `assertSameWorkspace()` so live workspace, sai → `PEER_NOT_FOUND` *không phân biệt* không-tồn-tại vs khác-workspace (scope privacy, §5).
5. **Self identity bootstrap §6.3** (`ensureSelfName()` herdr.ts): occupant live nhưng chưa có tên → `agent rename <pane> hl-xxxx`; đổi lại bằng fresh read, không tin echo; retry budget đóng: readiness 3×100ms (`SELF_PROBE_*`), collision `agent_name_taken` tối đa 3 lần (`MAX_GENERATED_NAME_ATTEMPTS`); concurrent de-dup qua `bootstrapsInFlight` Map promise; không persist gì.
6. **Allocation + rollback** (`startAgent()` herdr.ts): `allocateNewTab()` (tab create --no-focus → pane list lọc root pane == 1) hoặc `allocateWith()` (anchor same-workspace, kế thừa anchor cwd qua `pane split`); `agent.start` fail → `allocation.rollback()` best-effort close đúng tab/pane vừa tạo, giữ nguyên primary error.
7. **Cursor lock configured-start** (`withStartCursorLock()` herdr.ts): key = `configPath\0configAgent`, promise-chain lock; cursor round-robin chỉ advance **sau khi start thành công**; đọc lại config mỗi call; validate schema chặt (`assertAllowedKeys` từ chối field lạ).
8. **Error model đóng + passthrough** (`runFor()` herdr.ts): `NOT_IN_HERDR` đã phân loại thì *không* bị re-wrap thành `START_FAILED`…; agent-facing chỉ `"CODE: detail"` ổn định (`formatAgentFacingError()`), không lộ pane/tab id hay CLI diagnostic.
9. **JSON-RPC viết tay tin cậy** (mcp.ts): 1 writer tuần tự cho responses + notifications (`createSerializedLineWriter` xử lý `drain`); JSON-RPC error code chỉ cho transport; Link error đi `isError:true` text; `invokedDirectly()` so `realpathSync(argv[1])` vs `import.meta.url` vì bin là symlink.
10. **Bash-command guard parser** (`executableText()` pi-wait-guard.ts): blank `'…'`, `"…"` (kể cả `\"`), heredoc body theo delimiter (xử lý `<<-` strip tab + quoted delimiter), here-string `<<<`, comment `#` — chỉ texto sẽ thực thi được match. Tránh false-positive khi commit message/docs nhắc đến lệnh.
11. **Wait-free reply protocol** (contract rule 1): `send → kết thúc turn → đợi inbound`; cấm wait/poll (`--wait` bị guard chặn với `terminate:true`).
12. **Hai档 contract** (PROTOCOL §3): injected (OpenCode per-session `ctx.session.hook`) vs description-based (MCP family; Pi nhẹ nhất — chỉ `mcp.json` `description` + tool descriptions, không hint). Canonical text là 1 const duy nhất (`COMMUNICATION_CONTRACT`).

## Áp vào herdgate (checklist: module/op/file đích, ưu tiên)

- [CAO] **Wake-on-settle / prompt gửi cho Pi agent**: thay prompt bare bằng wrapper self-describing kiểu `buildInboundWrapper()` (envelope JSON dòng cuối + 2-3 dòng hướng dẫn) trong publisher/task.mjs khi `agent prompt`. Agent nhận không cần đọc docs để biết trả lời về đâu → giảm 1 lớp skill/AGENTS.md. Đích: publisher prompt path + spawn `task.mjs` continue.
- [CAO] **Receipts JSONL one-id**: học envelope id `spawn:<id>` sinh adapter-side dạng `<prefix>_<ts36>_<rand36>` + `from/to` resolve live, model không tự khai báo danh tính. Đích: schema receipts hiện có.
- [CAO] **Lazy gateway pattern cho tool surface herdgate** (nếu herdgate expose MCP/Pi extension): 1 dormant gateway + activation + `tools/list_changed` + action-dispatch fallback. Đích: mọi MCP tool herdgate thêm sau này.
- [CAO] **Error passthrough phân tầng**: tách "môi trường/giao thông" (gate chết, SSH/cloudflared down) khỏi "operation fail" (spawn fail) — không bọc lẫn; code đóng, message ổn định, không lộ pane id. Đích: `task.mjs` status/close + publisher error path.
- [VỪA] **Rollback allocation cho spawn**: task.mjs start tạo worktree/tab rồi fail → đóng đúng artifact vừa tạo, giữ primary error; cursor worker chỉ advance khi spawn thành công. Đích: spawn registry + pipeline worktree.
- [VỪA] **Fresh identity + fail-closed scope**: publisher không cache workspace/pane mapping giữa các call; ánh xạ session→pane kiểu `resolveSessionScope()` (unique-directory, 0 hoặc >1 match → fail closed) nếu cần gắn receipt với pane. Đích: publisher observe loop.
- [VỪA] **Guard parser `executableText()`** nếu herdgate có hook chặn lệnh Bash của agent (ví dụ chặn `task.mjs` gọi trực tiếp thay vì qua op chuẩn). Đích: Pi extension herdgate (nếu có).
- [THẤP] **Bounded retry budget** (readiness + collision) cho `revive` — chỉ 2 loại retry có determinism, còn lại fail nhanh.
- [THẤP] **`.agents/agent_config.json` configured-start** với placement `new_tab|with` + round-robin variants cho worker pool herdgate.
- [THẤP] **Serialized line-writer** nếu herdgate tự viết stdio server/probe (mcp-probe tee pattern trong `scripts/` cũng đáng xem khi debug relay).

## KHÔNG nên học (anti-pattern, platform mismatch, license)

- **Non-goals của Link = core của herdgate**: Link cố tình không có scheduling, receipts, cross-machine transport, cross-workspace, ack/wait/poll. Đừng thay relay VPS/cloudflared hay spawn registry bằng Link, và đừng nhét transport/receipt semantics vào envelope Link-style — herdgate cần delivery guarantee + wake-on-settle, đối lập "sent is delivery only".
- **Same-workspace-only addressing**: herdgate publisher per-machine là cross-machine theo thiết kế; mô hình peer của Link không map.
- **Zero-retry/zero-ack làm doctrine**: hợp cho message channel, hại cho task orchestration (revive/settle cần retry có chủ đích).
- **Đóng gói**: cài nguyên package `herdr-link` chỉ để lấy pattern là thừa (kéo wiring 5 host, installer OpenCode); học code, nhặt pattern từng mảnh. Pi wait-guard phụ thuộc env `HERDR_*` của Herdr TUI — chỉ dùng khi agent chạy trong Herdr pane.
- **Spec tiếng Trung + README/self-grading "VALIDATED" chưa độc lập**: các tuyên bố thực测 (E2E lazy-activation còn ghi "chưa có真机记录") cần tự verify trước khi tin; đây là repo cá nhân 5 sao.
- **License MIT**: được học và tái sử dụng code với attribution; không vấn đề pháp lý.

## File đã đọc (fetch thật từ raw.githubusercontent, branch master)

1. `README.md` (301d) — toàn bộ.
2. `PROTOCOL.md` (278d) — toàn bộ §1–§9.
3. `src/protocol.ts` (314d) — toàn bộ; hàm: `buildEnvelope`, `buildInboundWrapper`, `extractInboundEnvelope`, `createMessageId`, `isHerdrLinkEnvelope`.
4. `src/herdr.ts` (1227d) — toàn bộ; hàm: `runHerdr`, `classifyCliError`, `getSelfContext`, `getAgentContext`, `assertSameWorkspace`, `ensureSelfName/establishSelfName`, `startAgent`, `allocateNewTab/allocateWith`, `withStartCursorLock`, `sendMessage`, `closeAgentPane`, `listPeers`.
5. `src/mcp.ts` (595d) — toàn bộ; hàm: `createSerializedLineWriter`, `createRequestHandler`, `callGateway`, `callTool`, `runStdioServer`, `buildMcpPrefixedCommunicationContract`.
6. `src/opencode-v2.ts` (265d) — toàn bộ; hàm: `resolveSessionScope`, `readSessionAttribution`, gateway `execute`.
7. `src/pi-wait-guard.ts` (194d) — toàn bộ; hàm: `executableText`, default export hook.
8. `docs/mcp-wiring.md` (325d) — toàn bộ §1–§8 (gồm bảng pitfall).
9. `herdr-plugin.toml` (16d), 10. `package.json` (68d) — toàn bộ.
