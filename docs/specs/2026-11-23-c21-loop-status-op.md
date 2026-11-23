# Spec C21 — Device op `loop.status`: loop hiện diện trên phone

Ngày: 2026-11-23 · Vòng: DEV-LOOP · Chủ đề: quan sát được loop shipped
(`dev.herdgate.loop`) từ phone/PWA mà không cần `tail -f` trên máy.

## Bối cảnh

Loop plugin đã shipped và chạy thật (C9→C12), nhưng trạng thái của nó
(`~/.local/state/herdr/plugins/dev.herdgate.loop/state.json` + `loop.log`)
chỉ quan sát được bằng cách SSH vào máy và `tail -f`. Phone/PWA không có
cách nào biết loop đang `running`/`paused`/`done`, đã chạy bao nhiêu vòng,
nudge cuối lúc nào. Cần một op device read-only trả đúng những điều đó.

## Tính năng

Op `loop.status` trong `plugin/server/index.mjs`, xử lý cạnh `worker.health`:

- **Scope**: read (không cần act — thuần đọc file state, không gọi herdr,
  không ghi gì).
- **Nguồn state dir** (thứ tự):
  1. `HERDGATE_LOOP_STATE_DIR` (override cho probe/test),
  2. `HERDR_LOOP_STATE_DIR` (alias cùng ý nghĩa),
  3. `join(dirname(HERDR_PLUGIN_STATE_DIR), "dev.herdgate.loop")` — anh em
     plugin trong cùng herdr home (mặc định thật: `~/.local/state/herdr/plugins/`
     chứa cả `dev.herdgate.host` lẫn `dev.herdgate.loop`),
  4. không env nào → `unknown`.
- **Đọc**: `state.json` (strip BOM như loop plugin đã học C12) + tail
  `loop.log` ≤ 20 dòng (`MAX_LOOP_LOG_TAIL`), mỗi dòng cắt ≤ 200 ký tự
  (`MAX_LOOP_LOG_LINE`).
- **Reply** (đi qua `replyTo`/`sendPayload` sẵn có — cùng đường wire mọi op,
  tổng byte bounded bởi cap ở trên, không cần shrink thêm):
  `{ op: "loop.status", loop: { ok: true, pane: { id, alive: null }, status,
  paused, pausedBy, cycles, lastNudgeAt, logTail } }`.
  - `alive` LUÔN `null` một cách trung thực: op này không gọi `herdr` để
    giữ giá (một lần đọc file, không spawn); trạng thái sống của pane xem
    qua `view`/`fleet.detail` đã có.
  - `pausedBy`: state.json của loop plugin hiện không ghi trường này — op
    trả `string|null` trung thực (null khi không có).
  - Không có state dir / `state.json` hỏng → `{ op: "loop.status",
    loop: { ok: false, error: "unknown" } }` — không throw, không crash
    server, op kế tiếp vẫn trả bình thường.

## Tiêu chí nghiệm thu (đo được)

1. Test đỏ trước ở đúng chỗ (op `loop.status` chưa có → reply không bao giờ
   về), xanh sau implement — file `test/loop-status-op.test.ts` chạy bằng
   `node --test test/loop-status-op.test.ts`.
2. State dir tạm có `state.json` + `loop.log` 30 dòng → reply
   `payload.op === "loop.status"`, `loop.ok === true`, shape đủ trường,
   `logTail.length <= 20`, mọi phần tử `<= 200` ký tự, `pane.alive === null`.
3. Không có state dir → `loop.ok === false`, `loop.error === "unknown"`,
   server vẫn sống (op `view` ngay sau đó vẫn được trả).
4. Env override (`HERDR_LOOP_STATE_DIR`, và `HERDGATE_LOOP_STATE_DIR`)
   thắng đường dẫn anh-em dẫn từ `HERDR_PLUGIN_STATE_DIR`.
5. `state.json` có BOM vẫn đọc được (trả state thật, không `unknown`).
6. README mục "Device-channel ops" thêm đúng 1 dòng `loop.status`.

## Thiết kế

- Handler inline trong block dispatch op của `plugin/server/index.mjs`, ngay
  cạnh `worker.health` (cùng tính chất: metadata-only, read-scope, opt-in env
  cho probe). Hai hằng `MAX_LOOP_LOG_TAIL = 20`, `MAX_LOOP_LOG_LINE = 200`
  đứng cạnh các cap `MAX_*` hiện có — invariant "mọi bulk reply có cap" giữ
  nguyên: reply này bounded bằng cấu trúc (20×200 ký tự ≈ 4KiB ≪ 256KiB frame).
- Parse state: cùng quy ước loop plugin — `JSON.parse(readFileSync(..., "utf8")
  .replace(/^\uFEFF/, ""))`, object mới nhận; mọi trường coerce an toàn
  (`typeof` check), không tin state.json (file owner có thể sửa tay).
- Không đụng `plugin/loop/` (đọc thôi khi viết spec), không thêm verb
  ssh.mjs, không đụng PWA (xem Ghi chú).

## Kế hoạch test (file mới `test/loop-status-op.test.ts`)

Theo mẫu fake-gate của `test/publisher-loopback.test.ts`: spawn publisher
`serve` thật với env trỏ vào fake gate WS (hello kèm 1 device read), gate
relay frame `{op:"loop.status"}` của device và thu reply frame về.

1. **Happy path** (state qua `HERDGATE_LOOP_STATE_DIR`): `state.json` ghi
   đủ trường + `loop.log` 30 dòng → shape như tiêu chí #2.
2. **Không state**: không env, `HERDR_PLUGIN_STATE_DIR` trỏ dir tạm không có
   anh-em → `ok:false` + `error:"unknown"`; sau đó gửi `view` → vẫn nhận
   snapshot (server sống).
3. **Env thắng anh-em**: sibling `dir/dev.herdgate.loop/state.json` ghi
   marker "sibling", env dir ghi marker khác qua `HERDR_LOOP_STATE_DIR` →
   reply mang marker của env dir.
4. **BOM**: `state.json` có tiền tố `\uFEFF` → vẫn parse ra state thật.

Chạy targeted: `node --test test/loop-status-op.test.ts` (không full suite —
4 CPU/5 agent, controller chạy lúc merge).

## Rủi ro

- Path brotherhood sai (herdr home khác giữa máy) → có env override để
  probe/test; default chỉ đúng khi hai plugin cùng `HERDR_PLUGIN_STATE_DIR`
  parent — đúng mô hình shipped hiện tại.
- state.json owner sửa tay kiểu lạ → mọi trường coerce, không bao giờ throw
  ra ngoài handler (try/catch → `unknown`).
- Đụng chạm file đang được loop plugin ghi cùng lúc → đọc một lần, partial
  JSON → rơi vào nhánh `unknown` (chấp nhận: poll kế trả đúng).

## PWA — KHÔNG làm (lý do)

Thêm một op gửi từ `src/web/app.js` phá assert exact-set allowlist trong
`test/web.test.ts` (deepEqual danh sách op), mà main đang có agent khác sửa
cả hai file đó → xung đột merge chắc chắn xảy ra. ≤15 dòng không cứu được vì
bắt buộc phải sửa test allowlist. Op đã lộ đầy đủ cho mọi device client qua
gate; UI phone sẽ đi vòng riêng khi main rảnh.

## Ghi chú cho reviewer

- Task text dùng hai tên env khác nhau (`HERDGATE_LOOP_STATE_DIR` ở mục
  tính năng, `HERDR_LOOP_STATE_DIR` ở mục test) — implement nhận cả hai,
  `HERDGATE_` ưu tiên trước `HERDR_`, cả hai đều thắng đường anh-em.
- `pausedBy` không tồn tại trong state.json hiện tại của loop plugin —
  trả `null` trung thực thay vì chế số; nếu sau này loop plugin ghi trường
  này thì op tự đọc đúng không cần sửa.
- File `plugin/loop/server/index.mjs` KHÔNG được import (chạy CLI khi
  import) — chỉ đọc để đồng bộ format state/log.
- Không restart service, không verify sống qua gate thật (nằm ngoài phạm vi
  vòng này; controller merge rồi live tự hiện qua PWA/API khi cần).

## Nghiệm thu (điền lúc xong)

- (chưa chạy)
