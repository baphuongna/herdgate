# Spec: Herdgate Local Web Console

**Trạng thái:** S0 đã có prototype RPC và fixture trên hai nhánh riêng; chưa có Console chạy được. Các mục 8–10 là đặc tả tích hợp/phát hành, không phải chứng nhận đã đạt. **Nguồn tham chiếu:** [kiểm kê Ovis](../research/2026-11-25-ovis.md), upstream ghim tại [`b0f20e7`](https://github.com/devswha/ovis/tree/b0f20e7bcf87f770638c26b8c74e77ef8fd84131). Bản vá `windowsHide` phát hành/kiểm thử độc lập.

## 1. Mục tiêu và phạm vi

Hiện trạng: **Herdr Mobile App chính chủ → Herdgate → Herdr TUI chính chủ**. PWA có trong cây source không phải client đang vận hành. Không thay đổi đường hiện có, không dùng hosted app, relay, account, telemetry hay updater của Ovis.

Mỗi máy có **Herdgate host** bật Console sẽ có **một địa chỉ localhost trên chính máy đó**. Console dùng frontend Ovis làm giao diện web dự phòng, nối vào **chính phiên Herdr đang chạy**, không tạo phiên đối chiếu. Tại chỗ vẫn dùng được khi Gate, Internet và publisher outbound không hoạt động. Console không là bản sao hay cơ chế khôi phục phiên: nếu daemon Herdr/Pi hoặc máy chết, nó chỉ báo đúng trạng thái, không tự dựng lại.

- **Đích sản phẩm:** đưa toàn bộ source frontend Ovis vào Herdgate, build riêng. Workspace/tab/pane, terminal, chat và inbox được nối dần theo capability. Không đánh đồng *có source/build được* với *tất cả chức năng dùng được*.
- **Mốc giao đầu (L1):** Windows x64 laptop Herdr App 0.9.5 và Linux của chủ hệ thống; read-only, cùng layout/pane đang có, đọc ANSI snapshot, không cần Gate. Windows trên đúng runtime phải qua thử thật trước khi tuyên bố hỗ trợ.
- **Chưa nằm trong L1:** gửi phím, PTY tương tác thật, tạo/đóng/resize workspace hoặc pane, đọc file, render HTML workspace, approval card, native push, truy cập web từ xa, autostart khi đăng nhập. Giữ `/admin`, publisher, cấu hình pairing và SSH/Mobile chính chủ không đổi.

## 2. Kiến trúc và nguồn dữ liệu

```text
Herdr Mobile App → Herdgate Gate → publisher/SSH bridge → Herdr runtime (không đổi)

Trình duyệt tại máy đó → http://127.0.0.1:<port>/
                      → Herdgate Console daemon (Node ≥22, tài khoản user)
                      → adapter cục bộ → socket / Windows named pipe Herdr
                                      → đúng Herdr runtime/phiên ở đường trên
```

Một process Node per-user của Herdgate phục vụ cả asset tĩnh và API ở cùng origin. Không chạy Vite dev server hoặc Bun/Ovis server trên máy người dùng. Không có API proxy tổng quát, shell tùy ý, đường dẫn Herdr socket nhập từ browser hoặc kết nối từ Gate vào listener này. Không đi vòng qua cloud để lấy dữ liệu local.

1. Resolve phiên từ **cấu hình host đã chọn** và cơ chế discovery sẵn có nơi tái sử dụng được. Nếu có nhiều ứng viên hợp lệ và chưa có lựa chọn rõ, trả `runtime_ambiguous`; không mặc định sang Herdr CLI standalone khi đang dùng Herdr App. Mọi dữ liệu trả về nằm trong runtime đã chọn. Không tìm/khởi động daemon mới như tác dụng phụ của một lần đọc.
2. Adapter đọc có allowlist: L1 chỉ `session.snapshot`/liệt kê và `pane.read` theo ID do snapshot xác nhận. Ưu tiên RPC trực tiếp qua `node:net`, có framing JSONL, so khớp reply ID, timeout và cap; thử named pipe trên **đúng** Herdr App 0.9.5. Có thể fallback CLI read-only đã xác nhận trỏ đúng cùng runtime, có `windowsHide`; không fallback vì lỗi permission, sai runtime, sai framing hoặc để che giấu mất kết nối. Bằng chứng fallback không phải bằng chứng RPC hoạt động. Nếu chỉ chứng minh được CLI thì ghi rõ `cli` và chưa được quảng cáo “bỏ spawn”.
3. Giữ ID workspace/tab/pane từ nguồn, không nối theo tên hoặc index. Console theo dõi `runtimeGeneration` (identity của runtime/phiên được xác minh; đổi khi mất binding hoặc evidence cho thấy runtime đã thay). Reset lựa chọn/pending khi generation đổi. Nếu không còn pane đã chọn, báo `pane_gone`, trả về chọn pane; không gán input tương lai cho pane mặc định. Snapshot lỗi không được trình bày như live; nếu giữ nội dung cũ trong RAM ở tab hiện tại thì gắn `stale`.
4. L1 hiển thị **Mirror**: repaint từ ANSI snapshot của pane. Không cam kết vị trí cursor thật, kích thước PTY theo browser hoặc không mất output giữa hai lần đọc. Không gọi `terminal.attach` hay resize để giả lập live. Ưu tiên adapter/view-model của Herdgate; không import ngoài shipped tree từ `plugin/server/`.

## 3. Frontend, URL và contract

Vendor/ghim frontend và phần shared cần để build; giữ `LICENSE`, third-party notices và hồ sơ upstream/patch. Tách lớp tích hợp Herdgate khỏi code vendor. Không dùng boot Ovis relay/account. `transport.ts` của Ovis giúp thay cách gọi, nhưng `api.ts`/`ws.ts` vẫn đòi contract Ovis: kiểm kê các request bootstrap/refresh/terminal, rồi thay bằng adapter typed và capability gates; không dùng API response rỗng/giả thành công để lừa UI. Các màn hình chưa nối hiện “Chưa hỗ trợ trong chế độ Herdgate” hoặc ẩn có chủ đích. Chứng minh browser không gọi ra hạ tầng upstream, kể cả asset/font, trạng thái lỗi hay update.

- **URL local:** `http://127.0.0.1:<port>/` trên origin riêng với Gate. Port được OS cấp khi mặc định; CLI đọc port thực từ state riêng tư. `127.0.0.1` là địa chỉ chuẩn ghi ra; không alias `localhost`/IPv6 trong L1 nếu chưa có test. Có thể thêm cổng cố định dạng opt-in sau; không bind wildcard/fallback ra LAN.
- **API local dự kiến `/api/console/v1/`:** `capabilities` (mode, quyền và tính năng), `session` (snapshot cấu trúc, runtime identity/generation đã rút gọn), `pane/:id/screen` (generation, sequence, cols/rows nếu biết, ANSI, thời điểm đọc, cờ `truncated`), `auth/redeem`, `auth/logout`. Envelope lỗi nhất quán `{ "error": { "code": "…", "message": "…" } }`. `401` chưa xác thực, `403` thiếu quyền/nguồn không hợp lệ, `404` pane không còn, `409` generation không khớp, `429` quá giới hạn, `503` mất runtime/capability. Mọi UI state phải phân biệt Console đang chạy với runtime có pane.
- **Refresh:** chỉ poll khi tab hiển thị, tối đa một request đang chạy cho từng loại và pane được chọn; bỏ kết quả cũ khi đổi selection/generation. Default đề xuất: layout ≥2 s, screen ≥1 s; hợp nhất đọc đồng thời và dừng poll khi không còn viewer. Read timeout ≤8 s cho snapshot, ≤2,5 s cho pane. Giữ giới hạn upstream hiện có; trần ban đầu cho API mirror **256 KiB tính cả JSON**, cắt theo hàng và ranh giới UTF‑8/escape, đánh dấu `truncated`. Nếu không tạo được snapshot hợp lệ trong cap, báo lỗi rõ, không trả frame dở. Snapshot layout quá giới hạn phải fail rõ hoặc phân trang ở phiên bản sau, không lặng lẽ mất pane. Các con số là yêu cầu thiết kế ban đầu, không phải benchmark đã đo.
- **Không đăng ký service worker ở L1.** Không cache snapshot/receipt lâu dài, không ghi vào localStorage/IndexedDB. Shell và API `no-store`; asset hash mới được cache immutable. Asset manifest do build cung cấp; không serve tùy tiện file từ source/state/project. Tránh inline executable content từ terminal hoặc transcript.

## 4. CLI và vòng đời

| Lệnh dự kiến | Hành vi |
| --- | --- |
| `herdgate console start` | Owner opt-in; start/reuse đúng một instance. Chờ loopback health + xác minh instance do chính state của user quản lý trước khi báo READY. Idempotent và không chạm publisher/Gate/TUI. |
| `herdgate console status [--json]` | `stopped`, `starting`, `ready`, `runtime-unavailable` hoặc `error`; báo address và mode transport (`rpc`/`cli`), không lộ thông tin xác thực hay đường dẫn cá nhân trong health công khai. |
| `herdgate console open` | Mở đúng URL của instance đang chạy; không tự mở Herdr/TUI hay phát key vào URL. Nếu chưa có browser session, hướng dẫn lấy mã local qua `herdgate console login`. Với `stopped`, hướng dẫn `start`, không âm thầm bật dịch vụ. |
| `herdgate console login` | Tạo mã ghép **local**, ngắn hạn và dùng một lần cho cùng user, hiển thị trong terminal cục bộ để nhập vào trình duyệt. Không dùng owner token, room token, SSH key hoặc code mobile. Không in mã trong `status`, health, JSON, URL hay log. |
| `herdgate console stop` | Dừng đúng Console, vô hiệu session local của instance, thu listener và state tạm. Không kill theo tên process, không đụng Herdr/Gate/publisher. Gọi lần nữa vẫn an toàn. |

- Tách state/log Console khỏi publisher. State thư mục chỉ owner (`0700`/`0600` ở Unix; ACL user ở Windows), không ghi raw session secret. Start đồng thời dùng lock/instance identity; PID không đủ để adopt hoặc stop (PID reuse). Khi phát hiện lock/process stale, chỉ thu hồi sau khi xác minh owner/process identity; không kill process lạ.
- **Quản lý process:** Linux ưu tiên service user độc lập cửa sổ TUI; Windows cần launcher/service per-user chạy ngoài process tree của Herdr App và trong đúng user/session để thấy pipe. Chọn cơ chế Windows bằng spike, nghiệm thu không nháy CMD, không admin, không watchdog hay task tự bật lúc đăng nhập ngoài phạm vi L1. Không coi `detached: true` là bằng chứng Windows thoát được job của app.
- Console có trạng thái `ready` kể cả Gate/publisher unreachable; nếu Herdr runtime chưa sẵn thì UI báo offline/runtime unavailable. Stop Console không stop runtime. Restart Console có thể đổi port và bắt đăng nhập lại; không auto migrate sang phiên Herdr khác. Không cam kết sống qua reboot hay Windows sign-out tại L1.

## 5. Ranh giới quyền và dữ liệu

**Loopback không đồng nghĩa với đã xác thực:** process local khác và trang web trong trình duyệt vẫn là các caller khác. Tại L1:

- Chỉ bind `127.0.0.1`; từ chối `Host` lệch authority chính xác, kể cả header forward/trust-proxy. Không CORS mở; endpoint đổi state (`redeem`, `logout`, input về sau) chỉ cùng origin và kiểm chống CSRF; thiếu/sai `Origin` trong các request browser này → fail-closed. Request cross-origin không đọc được dữ liệu pane; WebSocket tương lai phải kiểm `Host`, `Origin` và session trước khi upgrade. Health không xuất pane/device/token.
- `login` yêu cầu quyền OS trên state/control channel riêng tư; mã entropy cao, TTL tối đa **120 s**, dùng một lần, giới hạn số lần thử, hủy khi restart/stop. Browser gửi code trong body `POST` cùng origin. L1 trả session token chỉ giữ trong RAM của tab, gửi trong `Authorization` cho đúng API origin; không cookie (cookie loopback không cô lập theo cổng), không ghi browser storage và không chuyển tiếp token sang redirect/origin khác. Reload hoặc mở tab mới phải login lại. TTL phiên dự kiến: 30 phút idle, tối đa 8 giờ; logout/stop hủy ở server. Không tuyên bố bảo vệ trước tiến trình có quyền đọc RAM/browser của cùng user; không tái sử dụng session này cho truy cập từ xa.
- L1 **chỉ đọc** dù frontend Ovis có nút gửi/duyệt. Backend không đăng ký write routes; test gọi thẳng không thay đổi pane. S2 mới đặc tả `act`: bật `allowAct` và cấp riêng cho session local theo thao tác owner, recheck mỗi input và sau khi thu hồi; không dùng phiên `read` nâng quyền ngầm. Những thao tác không biết capability mặc định từ chối.
- Nội dung terminal là dữ liệu không tin cậy: không `innerHTML`, không thực thi mã, không bật OSC clipboard, auto-open link, file routes hoặc embedded origin khác trong L1. CSP tự host, sandbox không cần thiết nếu không render HTML bên thứ ba, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. Không log hoặc gửi telemetry chứa terminal, token hay transcript.

## 6. Các lát SDD và tiêu chí nghiệm thu

| Lát | Scope | Bằng chứng cần có |
| --- | --- | --- |
| **S0 – contract & fixture** | Manifest vendor/giấy phép; kiểm kê startup pane; protocol mock Node cho runtime pinned; fake host riêng, không động user pane. | Build từ checkout ghim; không runtime fetch upstream; danh sách request và trạng thái unsupported. Fixture cho reply ID sai, JSONL chia chunk, phản hồi quá cỡ, timeout, permission denied và sai runtime; mỗi nhánh test đỏ trước. |
| **S1 – L1 cục bộ** | CLI/lifecycle + loopback/auth + read-only snapshot và Mirror trên frontend; tên máy, layout và selection đúng. | Unit/integration với API, fake runtime và real browser. Có read-only host thật (Windows 0.9.5 và Linux): trước/sau detach cùng ID pane; còn đọc được lúc Gate/publisher outbound không tới được trong môi trường test; nghe đúng `127.0.0.1`; stop Console không tắt Herdr. Ghi rõ backend RPC/CLI, số spawn snapshot, thời gian mở đến first paint và bytes/s khi một pane được xem; không suy ra từ fixture. |
| **S2 – local act (spec bổ sung)** | Input đúng pane, chỉ sau opt-in. Nếu dùng mirror, ghi rõ nó không phải PTY attach. | `read`/đã revoke/mất generation đều không ghi kể cả gọi API trực tiếp; đổi pane/reconnect hủy input cũ, không replay; `act` thành công ở pane fixture và có ACK để phân biệt đã áp dụng với chưa biết kết quả. |
| **S3 – tính năng frontend còn lại** | Live attach chỉ nơi runtime chứng minh capability, inbox và chat Pi dựa trên receipt/transcript; sau đó mới xét workspace actions/approval. | Mỗi capability có contract riêng, không kể chức năng chưa nối là đã hỗ trợ. Approval phải dựa trên prompt có cấu trúc và identity/generation; không chuyển phát phím mù từ chữ terminal. |
| **S4 – web từ xa (ngoài spec này)** | Nếu làm, phục vụ ở Gate trên HTTPS, ghép thiết bị riêng và đi qua đường được phân quyền; không publish cổng localhost, không dùng local cookie. | Spec riêng về pairing, failure mode và frame budget Gate; test qua 4G/5G và regression Herdr Mobile App chính chủ. Không là dependency của S1–S3. |

**Release gate L1:**

- Test bind/Host/CSRF/unauthenticated/viewer expiry/logout, mã ghép replay, request sai pane/generation, teardown/start đồng thời, stale PID và lỗi launcher. Test negative từng nhánh; dùng fixture, không probe tài sản user tùy tiện.
- Browser test fixture: load từ loopback, không request upstream, thay pane không paint nhầm, data không chạy dưới dạng HTML/script, Gate down không đổi UI local; không route ghi nào hoạt động. Kiểm disk/log không có bí mật hoặc snapshot; app không đăng ký service worker.
- Test thật với user đồng ý: tạo pane fixture riêng; ghi runtime identity/pane ID đã rút gọn rồi **detach TUI** và kiểm snapshot mới đúng pane đó. **Quit Herdr App là ca khác**: ghi quan sát riêng cho Console, publisher và Herdr runtime; nếu daemon chết thì phải báo runtime unavailable, không được ghi “cùng phiên còn sống”. Không tự quit app, stop production Gate hoặc sửa pane user để thử.
- Kiểm tray/Task Manager hoặc theo dõi cửa sổ Windows trên đúng launcher; đọc nhiều tick không nháy mới ghi đạt. Xác nhận Herdr Mobile App chính chủ vẫn vào được bằng đường cũ; nếu chưa có điện thoại nghiệm thu thì để pending. `npm test` với binary test dự án + kiểm npm pack/asset từ install sạch, không bump/publish chỉ vì có spec.
- **Rollback:** `herdgate console stop` và tắt opt-in. Không cần rollback Gate/publisher/Herdr. Kiểm lại listener đã đóng và Mobile/TUI chính chủ vẫn giữ đường trước đó.

## 7. Quyết định phải chứng minh ở S0/S1

1. Socket/pipe nào resolve được đúng Herdr App 0.9.5; có bằng chứng cùng runtime sau detach, reconnect và đổi phiên hay không. Không chốt khả năng PTY Windows từ docs Ovis.
2. Launcher Windows nào sống ngoài cây Herdr App nhưng vẫn đọc được pipe bằng user đó, không nháy CMD và không xin quyền admin. Nếu không đạt, Ubuntu/Linux có thể nghiệm thu riêng; không coi Windows hoàn tất.
3. Bao nhiêu phụ thuộc Ovis phải vendor để build frontend đầy đủ; kích thước bundle và cách bỏ upstream boot/network. Nếu một màn hình ràng buộc chặt API Ovis, ghi rõ chi phí port thay vì mở một proxy tổng quát hoặc chạy Ovis backend ngầm.

## 8. Deliverable đầy đủ: source, artefact, tích hợp

Không chấp nhận view-model, fixture, ảnh chụp hoặc UI tự viết làm bản thay thế frontend Ovis. Bản tích hợp phải **chạy entrypoint React từ source Ovis đã nhập**, giữ giao diện workspace/tab/pane và terminal của Ovis. Source có thể giữ nguyên các màn hình chưa dùng; build Herdgate chỉ được khởi tạo những đường đã nối hoặc hiển thị trạng thái chưa hỗ trợ. Ovis desktop/native/host server, CI upstream và account backend không được nhập làm runtime. Mọi layout hoặc UX đổi do mode Herdgate phải thành patch có lý do, không sửa tràn qua vendor mà không có log.

- **Source:** snapshot thuần từ commit đã ghim trong vùng vendor riêng, có `UPSTREAM` (repo/ref, file lấy/bỏ, toolchain, lock/patch, lệnh cập nhật, cách tái tạo), license và notices. Chỉ lấy graph frontend + shared/assets/build cần; nếu script build phụ thuộc module server, tách helper build cần thiết hoặc thay bằng cấu hình Herdgate, không ship Ovis server. Tách commit vendor import khỏi patch tích hợp và file sinh. Báo file count/source bytes/bundle bytes thật, phân biệt tests/assets. Không kéo cả repo chỉ để né tính dependency closure.
- **Build:** lock dependency và tree-shaking entrypoint Herdgate; Vite/Bun nếu cần là toolchain **build**, Node ≥22 là runtime. Script `build:console` phải phát artefact tĩnh và manifest, chạy lại được tại ref đã ghim; preload dependency qua bước cài có kiểm soát sau khi kiểm lock và lifecycle scripts, sau đó build/test trong môi trường không dùng credential của người dùng và không gọi upstream. CI không chạy installer Ovis hay workflow deploy upstream. Giữ asset path tương đối hoặc `/assets/...` trên loopback origin riêng, không đòi mount `/console/` tại local. Các điểm external mặc định (analytics, updater, OAuth, web panel, remote accounts, font/link, web worker) phải bị loại khỏi startup, không chỉ ẩn nút.
- **Ship:** `npm pack` từ môi trường build sạch phải chứa bản thành phẩm và notices; dùng allowlist manifest để serve; **không** cần repo Ovis, Bun/Vite, mạng hoặc dependency frontend vào lần mở đầu tiên ở máy đích. Nếu thiếu/khác phiên bản bundle, `start` báo `console_assets_missing` hoặc lỗi manifest, không tự tải từ mạng. S1 có thể nghiệm thu developer build trước; chưa gọi là bản cài hoàn chỉnh nếu chưa test tarball.
- **Nối runtime:** launcher/API local không phụ thuộc cách đóng gói frontend cho tới seam static manifest. Mode strict L1 chỉ gọi API nội bộ đã liệt kê; tách handler HTTP/install CLI/port riêng khỏi RPC. Không thêm mock success cho route Ovis chưa có; map endpoint hoặc refactor consumer rõ ràng. Frontend gửi expected generation trong request màn hình; daemon xác minh generation/pane trước và sau RPC. Frontend bỏ response từ lần chọn cũ hoặc sequence lùi, kể cả người dùng chuyển A → B → A, và vẽ `truncated` có cảnh báo nếu snapshot vẫn hợp lệ.

## 9. Ma trận tính năng và phần việc nối tiếp

| Tính năng trong frontend thật | Contract/bề mặt Herdgate | Mốc bật và nghiệm thu |
| --- | --- | --- |
| Mở app, khóa, lỗi local | Auth local, `capabilities`, runtime health/status | L1: unauth không thấy dữ liệu; reload login lại; Console lên ngay cả khi runtime offline; trạng thái lỗi giải thích đúng nguyên nhân. |
| Sidebar, tab, layout, pane đang chọn | `session`, IDs + generation và layout từ runtime | L1: cùng tên chưa đủ, so đúng IDs với Herdr; A → B → A không paint nhầm; không mutate focus TUI để đổi lựa chọn trình duyệt. |
| Terminal Mirror ANSI | `pane/:id/screen`; dữ liệu bounded + seq/truncated, geometry gốc nếu biết | L1: browser vẽ đúng màu/lưới, resize viewport chỉ đổi UI, không gọi Herdr resize; thử lỗi ở cả RPC/API/browser; không upload hay replay input. |
| Input local/Escape/Tab/Ctrl‑C | S2: write endpoint allowlist với `paneId`, generation, id lệnh; chỉ owner opt-in `act`/`allowAct`, ACK kết quả bounded; không arbitrary exec API | Mở ở S2 sau review quyền và test revoke trong lúc gửi, tab stale, mất ACK và reconnect. Không retry lệnh nhập; không biến người local vào owner từ localhost. |
| Terminal attach thật | S3a: adapter capability trên từng runtime, stream attach được xác thực, flow-control và đóng đúng vòng đời | Chỉ bật nơi runtime đã chứng minh; Windows mirror vẫn là tính năng chính nếu chưa đạt. Test disconnect/cancel/memory bound; không auto chuyển input sang mode khác. |
| Inbox + chat | S3b: dữ liệu trạng thái sẵn có, Pi `receipt.body` có quyền; transcript history/branch/pagination phải là contract đọc riêng | Không dùng snapshot để bịa hội thoại/câu hỏi. Report unsupported cho agent không có nguồn dữ liệu; receipt trùng, branch đổi, chỉ có prompt, stale đều phân biệt. |
| Tạo/đóng/tab/workspace, approvals | S3c: allowlist từng operation, identity prompt/pane/generation, xác nhận thao tác phá huỷ | Từng thao tác chỉ bật sau fixture + review + live ca cô lập; không điều khiển pane user để test. Không copy backend Ovis hoặc gửi phím duyệt mù. |
| Account, cập nhật, máy từ xa, portal, file viewer, push của Ovis | Không expose backend upstream; route/settings Ovis tương ứng không thực thi | Không phải tiêu chí L1–S3 local. Nếu cần đường từ xa, dùng spec S4; không đổi app chính chủ. |

## 10. Trình tự đưa vào nhánh phát triển và Definition of Done

1. **Hai nhánh song song:** (A) nhập *source frontend thật* và chứng minh build/launch trên fixture offline; (B) service loopback + auth + API/RPC với fixture. Phân quyền file không chồng; độc lập với bản vá publisher `windowsHide`. Mỗi nhánh có diff/commit và test trước khi reviewer nhận; review không đạt trả lại đúng agent.
2. **Ghép trên nhánh tích hợp riêng** sau khi hai nhánh pass review; nối frontend vào service thật, chạy trên loopback với fixture trước. Chạy `npm test`, kiểm tarball, real browser và test đóng/detach trên máy test. Khi thiếu Herdr App/pipe/điện thoại, chính xác ghi ca chưa nghiệm thu; không chặn tiếp phần code có fixture nhưng không được đánh dấu release-ready.
3. **Đủ code L1** nghĩa là cài từ tarball vào thư mục sạch, `start → login → open → chọn pane → thấy đúng mirror → stop` trên fixture và thực sự đang chạy React bundle Ovis đã vendor, không có request tới Gate/Ovis ngoài loopback. **Đạt L1 laptop** thêm bằng chứng cùng phiên Herdr App 0.9.5, detach và không nháy CMD, phân biệt quit. Không gọi là “hoàn chỉnh” chỉ vì hai nhánh S0 pass.
4. **Hoàn chỉnh mục tiêu Console dự phòng:** bao gồm L1 và S2 (đọc + điều khiển cùng phiên khi có quyền). Những màn hình frontend đã nhập nhưng chưa có capability S3 bị khóa rõ ràng; truyền đạt trạng thái từng nhóm, không hứa parity toàn bộ sản phẩm Ovis. Triage S3/S4 độc lập, không mở rộng quyền hoặc deploy ngoài phạm vi bằng chứng. Review và kiểm thử đóng vòng mỗi lát; không publish/bump, chạy laptop production hay chuyển đổi kiến trúc hiện có khi chưa có gate đã thỏa.
