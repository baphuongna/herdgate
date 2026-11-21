# Nghiên cứu 0cv/herdr-mobile-relay (v0.26.1, branch dev, Go+Svelte, AGPL-3.0+, 390★)

## Kiến trúc cốt lõi (file-level)
- **herdr-plugin.toml** — manifest plugin Herdr: 9 `[[actions]]` (non-interactive: setup,
  quick-start, install-service, setup-link, change-hostname, configure-app-deploy,
  stable-teardown, uninstall, status) + 8 `[[panes]]` (bản interactive, placement zoomed)
  + 1 `[[events]]` `pane.agent_status_changed` → `relay/plugin-on-event.sh` đẩy UDP tới relay.
  `[[build]]` chỉ tải release bundle đã checksum-verify, không compile, không toolchain.
- **cmd/herdr-mobile-relay/** — Go binary chính (main.go, journal.go, logging.go).
- **internal/protocol/protocol.go** — protocol version 3, subprotocol WS `herdr-e2ee-v2`;
  `actionCatalog` ~80 action với metadata `ActionMetadata{Operation, Class(read_only|mutating),
  RequiresProtocol, Coordinated, Audited}`; `TargetRef{server_session_id, pane_id, terminal_id,
  generation, agent_session_id}`; `ActionReceipt{action_id, phase, error}` với phase
  `failed_before_dispatch`; `ApiError{code, args}`.
- **internal/herdr/** — client herdr socket: `capabilities.go` (`ServerStatus` + `FeatureEvidence{state
  supported|unsupported|unknown, reason, generation}` — gate feature theo phiên bản herdr server đang
  chạy), `topology_stream.go` (`TopologyStream`: Bootstrap→snapshot+buffered events, `SessionCache.Apply`,
  chỉ emit snapshot khi changed), `send_input.go`/`send_secret.go`/`launch.go`.
- **internal/app/** — `inventory_view.go` (`publishCurrentInventory` = sole authoritative writer,
  diff trước khi broadcast), `connection.go` (`sendConnectionSnapshot`: push_config + agents +
  workspaces + activity_history(500) + inventory_status cho client mới), `server.go`, `hybrid.go`
  (WebRTC direct upgrade), coordinator/ (poller, dispatch, state).
- **internal/deviceauth/store.go** — `devices.json` atomic; `Invitation` one-use 10 phút, rate-limit
  5 lần; role `controller`/`reader`; không cho revoke controller cuối cùng;
  `WithBootstrapReenrollment()` dành riêng temporary tunnel (origin đổi mỗi lần chạy).
- **internal/webrtclink/** — `manager.go`, `conn.go`, `address_discovery.go` (UDP 3478).
- **frontend/src/lib/transports/** — `encrypted.ts` (`createEncryptedTransport` bọc MỌI FrameChannel
  — WS thường, gateway-relayed, WebRTC DataChannel — vào cùng 1 handshake E2EE), `gateway.ts`,
  `webrtc.ts`, `path-manager.ts`; frontend Svelte + PWA (manifest.webmanifest).
- **relay/*.sh** — setup tooling bash: `plugin-setup-menu.sh` (menu 3 nhánh), `plugin-choose-transport.sh`
  (cutover), `common.sh` (2041 dòng, chứa `relay_transport`, `set_gateway_url`,
  `refuse_if_tailscale_selected`), tailscale-setup.sh, stable-setup.sh.
- **Đa relay**: mỗi máy 1 relay riêng; herdr-app/core chạy relay thứ hai (`HERDR_RELAY_BACKEND=hc`);
  phone ghép (merge) nhiều relay, hiển thị `<hostname>` / `<hostname> (core)`.

## Cơ chế đáng học — chi tiết (code/từ khóa thật + file)
1. **Setup menu sinh từ token-list** — `plugin-setup-menu.sh::screen_tokens()`: target
   (`tui|core|both`) → path (`cloudflare webrtc tailscale`, core không có webrtc) → items
   (`temporary stable hostname remove deploy qr status` / `community own qr status` / `on off qr
   status`). Render và dispatch đọc cùng 1 list nên số mục không lệch nhau. Mỗi probe bị chặn
   timeout (`curl --max-time 2`), "trạng thái không xác định được thì bỏ dòng, không bao giờ fatal".
2. **Transport = 1 switch duy nhất trong env file** — `common.sh::relay_transport()`: tailscale
   (nếu có `HERDR_TAILSCALE_PORT`) > gateway (nếu có `HERDR_GATEWAY_URL`) > cloudflare.
   `plugin-choose-transport.sh` ghi/xoá `HERDR_GATEWAY_URL` (+ `HERDR_GATEWAY_SELECTION` =
   `ordered`|`latency`); healthz-probe từng candidate, hiện số ms đo được; `refuse_if_tailscale_selected`
   chặn đổi transport khi Tailscale đang bật — phải tắt đúng bước, không tự động chuyển ngầm.
3. **Cutover phải re-pair vì credential bị buộc vào origin** — `deviceauth/store.go` comment
   `WithBootstrapReenrollment`: temporary tunnel serve app từ hostname đổi mỗi lần chạy → phone lưu
   credential theo origin không còn tồn tại → chỉ quay lại được bằng enrollment mới. Ngược lại,
   failover GIỮA các gateway trong cùng transport không cần quét lại: "The pairing QR carries the
   whole list" (docs/transports.md). README: bản <0.20.0 phải cài lại + pair lại vì phone updater
   không vượt "encrypted-transport boundary".
4. **Live JSON inventory** — `topology_stream.go::Events()` Bootstrap trả snapshot + events đã
   buffer; `Next()` apply event vào SessionCache, chỉ return khi `changed`. Phía server,
   `inventory_view.go::publishCurrentInventory` chạy trong `hub.BroadcastBatchPrepared` (barrier),
   so `agentSnapshotsEqual` bằng JSON-marshal (bỏ StateRevision) để quyết định gửi `agents`/
   `workspaces`/`inventory_status`, commit view sau barrier; kèm `readyRecovery` (re-send khi state
   chuyển về ready). README: herdr 0.9.0 được "recommend" (không phải minimum) cho inventory đầy đủ —
   "A server upgrade can enable or disable individual actions without changing the relay release".
5. **Capability negotiation 3 trạng thái** — `capabilities.go::FeatureEvidence{state: supported|
   unsupported|unknown, reason, generation}`; `connection.go::effectiveCapabilitiesFor` gộp feature
   herdr server + backend + manager runtime thành list `Capabilities` gửi trong `push_config`.
6. **Action catalog có class/audit** — `protocol.go::actionCatalog`: read-only vs mutating,
   `Coordinated` (qua coordinator dispatch) vs không, `Audited` (ghi journal). Reader device bị chặn
   ở `ErrorReaderDenied`; receipt có phase `failed_before_dispatch` phân biệt lỗi trước/sau dispatch.
7. **WebRTC direct upgrade an toàn** — DataChannel `herdr-dc-v1` đàm phán BÊN TRONG phiên relayed,
   chạy handshake E2EE riêng, "takes over only after it has carried a real message", gateway session
   drop sau 10s; hỏng thì tự quay về relayed "automatically, with no re-pairing" (docs/transports.md).
8. **Event hook UDP thay polling** — `herdr-plugin.toml [[events]] on=pane.agent_status_changed` →
   `plugin-on-event.sh` gửi UDP tới relay → phone thấy blocked/finished tức thì.
9. **Không sudo, không toolchain** — install.sh chỉ tải+verify bundle; `tailscale set --operator`
   người dùng tự chạy; mọi thay đổi hệ thống đều confirm tường minh.

## Áp vào herdgate (checklist: module/op/file đích, ưu tiên)
- [CAO] Setup menu cutover cho gate relay (cloudflared ↔ tailscale ↔ direct): học `screen_tokens`
  pattern + 1 biến switch duy nhất trong env gate (tương đương `HERDR_GATEWAY_URL`), kèm guard
  kiểu `refuse_if_tailscale_selected` khi transport đang giữ lock. Đích: module setup gate
  (server/bootstrap hiện có của herdgate).
- [CAO] Receipts JSONL: thêm class (read/mutating) + phase `failed_before_dispatch` + `ApiError
  {code,args}` cho one-id `spawn:<id>` — bỏ qua lỗi không có code số/máy đọc được. Đích: receipts
  writer của publisher.
- [CAO] Inventory cho PWA Jobs/Timeline: thay poll週期 bằng pattern Bootstrap-snapshot + event
  stream + cache-changed (topology_stream.go) từ publisher per-machine; diff-by-marshal trước khi
  broadcast như `publishCurrentInventory`. Đích: publisher observe Pi sessions + PWA store.
- [CAO] Capability 3 trạng thái (supported/unsupported/unknown + generation) khi publisher dò phiên
  bản Pi/herdr server — tránh cứng minimum version. Đích: publisher handshake.
- [TRUNG] Event push UDP/socket cho wake-on-settle:pane events → relay local, thay vì poll.
  Đích: herdr pane events consumer đang chuyển dở.
- [TRUNG] Gateway/WebSocket candidate list + policy ordered|latency + healthz probing cho gate VPS
  tự host (nhiều VPS/backup); QR/link mang cả list.
- [THẤP] Re-pair semantics: nếu herdgate làm device/credential, bind theo origin và ghi rõ ràng
  buộc re-pair khi đổi origin (học bootstrap-reenrollment cho URL tạm).
- [THẤP] Direct WebRTC upgrade + phone-side merge nhiều relay (PWA đã gần; chỉ khi cần mobile).

## KHÔNG nên học (anti-pattern, platform mismatch, license)
- **License AGPL-3.0-or-later**: KHÔNG copy code/chunk nào vào herdgate — chỉ học thiết kế/pattern.
- **Bash common.sh 2041 dòng** monolith: dù có test riêng, đây là gánh nặng bảo trì; herdgate nên
  giữ setup thành module nhỏ có test độc lập.
- **Community gateway** (gateway dùng chung công cộng) không hợp mô hình self-host 1 VPS của
  herdgate; cũng không cần WebRTC/STUN nếu traffic đã qua cloudflared/tailnet.
- **Surface khác**: repo nhắm Herdr TUI + herdr-app/core + Web Push VAPID iOS/Android + speech;
  herdgate là PWA + Pi agent + receipts — chỉ lấy lớp transport/inventory, bỏ lớp app phone.
- Không Windows, launchd/systemd user-service machinery phức tạp cho desktop — herdgate VPS/headless
  chỉ cần systemd đơn giản.

## File đã đọc (fetch thật từ raw.githubusercontent.com, branch dev)
1. herdr-plugin.toml (169 dòng) — manifest actions/panes/events.
2. internal/protocol/protocol.go (510) — actionCatalog, TargetRef, ActionReceipt, DecodeFrame.
3. internal/app/inventory_view.go (391) — publishCurrentInventory, inventoryStatusChanged,
   agentSnapshotsEqual.
4. internal/herdr/topology_stream.go (60) — Client.Events, topologyStream.Next.
5. internal/herdr/capabilities.go (527) — FeatureEvidence, ServerStatus, liveFeatures.
6. relay/plugin-setup-menu.sh (572) — screen_tokens, transport_summary, print_status, render_item.
7. relay/plugin-choose-transport.sh (193) — use_gateways, choose_own_gateway, mode temporary/stable/
   community/own.
8. relay/common.sh (2041, grep đích) — relay_transport, set_gateway_url, refuse_if_tailscale_selected.
9. internal/deviceauth/store.go (528) — Invitation/Credential, WithBootstrapReenrollment.
10. internal/app/connection.go (155) — effectiveCapabilitiesFor, sendConnectionSnapshot.
11. docs/transports.md (151) — 4 transport, direct upgrade, gateway env vars.
12. README.md (10.7KB) — tổng quan, security-in-one-paragraph, core compatibility 0.25.0.
