# Spec: Ovis frontend fork — thay backend, không viết lại giao diện

**Trạng thái:** F0 + F1 (spike chứng minh) đạt trên máy chủ 26/11/2026; chưa có gì trong npm, chưa deploy.
**Nguồn:** Ovis `devswha/ovis` MIT, pin [`fe3058a39947f73fdcca3ef50aaacb55dc5f326b`](https://github.com/devswha/ovis/tree/fe3058a39947f73fdcca3ef50aaacb55dc5f326b) (0.5.9, 2026-11-26T02:49Z). Bằng chứng: [`experiments/ovis-fork/`](../../experiments/ovis-fork/README.md).

## 0. Vì sao làm lại

Bản "Local Web Console" (0.15.1–0.15.2) không phải fork: entrypoint là shell do Herdgate viết, chỉ mount `TabStrip` và `PaneCanvas` của Ovis. Spec cũ mục 8 đã cấm điều đó nhưng vòng nghiệm thu chỉ đo mirror đúng/sai, không đo "có phải giao diện Ovis không". Bản đó đã gỡ ở commit `06a2ddb` (service, ingress tunnel, runtime, 1.127 file).

Ý tưởng gốc: **fork toàn bộ frontend Ovis, thay backend.** Upstream tự chứng minh đường may bằng demo của họ (`scripts/build-site.ts`): build *nguyên app*, chèn `demo-transport.js` trước script app; transport thay ba thứ trên `window` là `fetch`, `WebSocket`, `EventSource`. App không biết mình đang chạy trên nguồn dữ liệu nào. Ovis còn có sẵn vai trò thiết bị chỉ xem (`auth.role === "watch"`, wire mode `observe`) nên không cần tự che nút.

## 1. Mục tiêu và không mục tiêu

- **Ghi:** app Ovis chạy **không sửa một dòng** (entrypoint `src/main.tsx` → `App`); backend của Herdgate là một transport; glyph "View only" là thật, mọi thao tác ghi bị từ chối.
- **Không:** sửa vendor để "làm giống"; trả rỗng/giả thành công cho API chưa nối; mở quyền ghi trước khi có spec S2; dùng account, relay, updater, telemetry, push của Ovis; publish cổng localhost ra ngoài.
- **Kế thừa từ bản đã gỡ** (làm lại kèm test, lấy từ lịch sử git `95ef12a`): mã đăng nhập một lần 120 s/dùng một lần/5 lần sai, token chỉ trong RAM tab, idle 30 phút/tuyệt đối 8 giờ, Host/Origin fail-closed, CSP tự host, allowlist asset, rate limit theo IP ở chế độ public host, `console-rpc.mjs` (framing JSONL, khớp reply id, timeout, cap frame, `derivePaneDimensions`).

## 2. Pin, nguồn và cách dựng

1. Pin theo HEAD upstream tại thời điểm fork, ghi sha + ngày vào `UPSTREAM.md`; upstream đổi rất nhanh (49 commit / 300 file trong nửa ngày sau pin nghiên cứu `b0f20e7`) nên mỗi lát ghi rõ pin.
2. Clone nông đúng sha → snapshot thuần vào `frontend/ovis/` (không `server/`, `relay/`, `app/`, CI), `SOURCE-MANIFEST.txt` sha256 từng file + tool kiểm.
3. Cài dependency ở bước tách có kiểm soát: HOME/caches riêng, không credential, `bun install --frozen-lockfile --ignore-scripts` (Bun 1.4.4 ghim trong `~/.cache/herdgate-console-toolchain`).
4. Build trong `bwrap --unshare-net`, môi trường trống; kết quả phải build lại được và byte-giống.
5. Patch tích hợp (nếu buộc) nằm ở file riêng có lý do, không sửa tràn vendor.

Số đo F0 ở pin này: cài 249 gói trong 7 s, repo sạch; `vite build` trong bwrap không mạng 17 s; 1.514 file / 45 MB, bundle chính 3,1 MB.

## 3. Kiến trúc

```text
Trình duyệt ──> herdgate service (Node ≥22; mã một lần; loopback | public host opt-in)
                 ├── asset tĩnh: bundle app Ovis (nguyên bản) + herdgate-transport.js
                 └── /hg/* chỉ đọc: session.snapshot, pane.read qua RPC Herdr (socket/pipe)
```

- **Transport chạy trong trang**, đúng đường may demo: dịch `/api/*` (REST Ovis), `/ws`, `/api/machines/events`. Chỉ khi cần luồng thật (live attach, S3a) mới thêm `/ws` phía service.
- **Vai trò:** `health.auth.role = "watch"`, `role-ack.mode = "observe"` bất kể trang xin gì. Mọi ghi: REST ≠ GET → 403 `read_only`; frame `input/keys/submit/secret/insert/resize/...` → frame `error` `read_only`.
- **Dữ liệu thật có ngay:** `session.snapshot` (đúng shape `SessionSnapshot` protocol 22 mà Ovis dùng), `pane.read` ANSI + geometry từ layout. Chưa có: transcript hội thoại, attach thật, receipts → trả trung thực (`conversation: {source:"scrollback", turns:[]}`, `terminal_attach` theo khả năng thật).

## 4. Contract boot — đo từ bundle thật (F0, pha A: demo transport, cửa sổ 25 s)

| Thứ tự | Lần đầu (ms) | Endpoint / frame | Ghi chú |
| --- | --- | --- | --- |
| 1 | 259 | `GET /api/health` | auth/role, herdr version/protocol, `web_ui.boot_id` |
| 2 | 264 | `GET /api/machines` | roster máy, bản địa kèm `snapshot` |
| 3 | 267 | `GET /api/telemetry` | 404 được chấp nhận |
| 4–8 | 521–552 | `/api/herdr-ui`, `/api/fs/favicon` (404 OK), `/api/worktree/inventory`, `/api/updates`, `/api/preferences` | |
| 9–12 | 669–779 | `/api/pane/commands`, `/api/pane/conversation` (poll ~1 s), `/api/pane/omo-tasks`, `/api/pane/prompt` (poll ~2 s) | |
| 13 | 526→758 | WS `/ws`: client `role` → `role-ack`; `presence`; chủ `snapshot`; client `attach{pane_id,cols,rows,flow_control}`; chủ `pane-geometry`, `pty-data`; `conversation-watch` | |
| 14 | 746 | SSE `/api/machines/events` `{type:"machines",machines:[…]}` | |
| 15 | ~5 s | `GET /api/health?scope=bridge` + `/api/machines` lặp 5 s | nhịp steady-state |
| 16 | 4606 | `POST /api/seen` | lượt ghi → bản Herdgate từ chối |

Đường lỗi (pha B, mọi `/api/*` = 503): app chỉ gọi `health` (6 lần/12 s), `machines` (3), `telemetry` (1) rồi hiện "Connecting… / Connecting to Ovis…" — không crash, không gọi gì khác.

## 5. F1 — app Ovis nguyên bản trên dữ liệu Herdr thật (đo 26/11)

`herdgate-transport.ts` 149 dòng (bundle 14,29 KB), nguồn `/hg/session` + `/hg/pane/:id` qua RPC Herdr:

- Title `π - source · Ovis`; hiện **"View only"**; sidebar đúng 7 workspace thật kèm trạng thái agent (`source · pi RUN`), danh sách Agents, `Tab 1`.
- WS: `role` → `role-ack{observe}` → `snapshot` → `attach` → `pane-geometry` + `pty-data` mỗi giây (14 cặp/14 s). Lens Terminal vẽ mirror pane thật 253×78 bằng chính stack terminal của Ovis (canvas). Lens Chat báo trung thực "Conversation unavailable".
- 0 exception, 0 request lỗi; nguồn: 10 lần đọc session, 16 lần đọc pane, 0 lỗi; sai `x-herdgate-runtime-generation` → 409, pane không còn → 404.

Giới hạn của F1 (spike): không xác thực, không CSP, chỉ loopback, mirror full-repaint 1 giây, chưa scrollback, chưa transcript, chưa mobile, chưa kiểm multi-pane.

## 6. Các lát và tiêu chí nghiệm thu

| Lát | Nội dung | Bằng chứng bắt buộc |
| --- | --- | --- |
| **F2 – đưa vào repo** | `frontend/` (snapshot vendor + manifest, transport, build tool, manifest asset); service: mã một lần, CSP, allowlist, loopback; `/hg/*` chỉ đọc với generation; test contract (REST + frame WS) và test từ chối ghi | **(1) entrypoint là app Ovis: đồ thị import của bundle không chứa component layout do Herdgate viết.** (2) Build lại trong bwrap không mạng, byte-giống. (3) Test gọi thẳng `/hg/*`: ghi bị từ chối, sai generation/pane. (4) Trình duyệt thật: recorder log khớp contract mục 4, 0 request ngoài origin, 0 ghi storage, 0 vi phạm CSP, ảnh đối chiếu ovis.sh. |
| **F3 – public host** | `HERDGATE_CONSOLE_PUBLIC_HOST` như cũ, budget theo `CF-Connecting-IP`, gán lại `bom.phuongnb.io.vn` (bản ghi DNS còn nguyên) | Ma trận Host/Origin 200/403; 11 lượt redeem → 429; đo qua edge thật. **Đổi ingress: `systemctl --user restart herdgate-tunnel.service` trong cửa sổ bảo trì** — SIGHUP với cloudflared hiện tại là restart (đo: pid đổi, gián đoạn ~10 s). |
| **F4 – Chat đọc** | transcript Pi (receipt) → `/api/pane/conversation` (`pi-transcript`), `conversation-changed`, `pane-status` | Fixture receipt trùng/branch/chỉ prompt; không bịa hội thoại từ snapshot. |
| **F5 – mirror mượt** | delta theo hàng hoặc full frame có nhịp, ack, geometry theo viewport người xem, đa pane, phone | Đo fps/bytes; chọn text còn sống giữa hai frame; detach dừng poll. |
| **S2 – ghi** | spec riêng sau F5 | như spec cũ mục 6 |

Mỗi lát delegate theo vòng SDD: agent trong worktree riêng, reviewer đo lại bằng recorder + ảnh; test xanh ≠ review đạt.

## 7. Rủi ro

- **Tốc độ upstream:** mỗi re-pin là một lát có kiểm kê contract lại; pin ghim trong `UPSTREAM.md`, không tự đuổi theo HEAD.
- **Renderer canvas/webgl:** không đọc chữ qua DOM khi đo; dùng ảnh + API xterm.
- **`pane.read` là màn hình hiển thị, không có scrollback** — lịch sử chỉ có khi Herdr cung cấp (snapshot có `scroll.offset_from_bottom`, chưa kiểm).
- **Lỗi một lần đọc pane** không được làm mất pane đang xem (bản cũ sinh lại generation → màn "Select a pane" kẹt; transport mới giữ pane, chỉ báo lỗi).
