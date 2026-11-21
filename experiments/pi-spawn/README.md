# Pi spawn registry — cha/con và vòng đời agent (thử nghiệm)

Herdr không có registry quan hệ controller→agent, và binding session của Pi chỉ biết được
*sau khi* detection chạy. Helper này lấp hai lỗ đó bằng một nguyên tắc: **một UUID làm cả
receipt request id lẫn `pi --session-id`** — session của agent con được biết ngay tại lúc
spawn, và mở lại sau khi pane chết chỉ là gọi lại cùng một cờ.

## Dùng

```sh
node experiments/pi-spawn/spawn.mjs spawn reviewer --cwd /home/bom/source [-- model ...]
node experiments/pi-spawn/spawn.mjs self --parent <session-id> --name <n> [--cwd DIR] [--id UUID]
node experiments/pi-spawn/spawn.mjs list
node experiments/pi-spawn/spawn.mjs restore reviewer   # hoặc <request-id>
``n
- `spawn`: tách sibling pane (tự tìm pane gọi khi chạy trong Herdr), `herdr agent start … --
  --session-id <uuid>` (idempotent: có session thì mở, không thì tạo), xác minh binding
  (`agent_session` khớp id), ghi `spawns.jsonl` cạnh journal receipt cùng scope.
- `self`: **agent tự khai sinh cha** (ownership edge kiểu pi-durable, nhưng bằng cơ chế
  herdgate): một agent không do controller pane-split — job của pi-worker, con do SDK
  sinh — tự ghi `{id = sessionId, parentSessionId, name, cwd, sessionFile}` vào scope
  workspace của nó. Worker `--real` lẫn fixture đều tự đăng ký mỗi job; bản ghi cập nhật
  trạng thái theo verdict (replied/failed/…).
- `list`: các agent con của workspace này + pane còn attached hay không (`self` cho con
  không pane), kèm trạng thái receipt.
- `restore`: mở lại **đúng session đó**: ưu tiên `--session <file>` theo đường dẫn
  transcript ghi trong bản ghi (session của worker nằm ngoài storage mặc định của Pi —
  `--session-id` trần sẽ âm thầm tạo session rỗng trùng id), fallback `--session-id`
  cho con do TUI spawn.

Registry `<base>/<scope>/spawns.jsonl` (0600): `{id, sessionId, paneId?, name,
parentSessionId, cwd, sessionFile?, self?, ts, status}` — chỉ id/panes/trạng thái,
**không có prompt/answer**; bound như journal (giữ ~200–300 bản ghi mới nhất). Dùng
chung `HERDGATE_PI_RECEIPT_DIR` override và `scopeFor(realpath)` với journal.
Cha-con có hai nguồn: controller ghi khi `spawn`, và **agent tự khai sinh cha** qua
`self` (job pi-worker là khách hàng đầu tiên — mỗi job SDK tự đăng ký, id session
dược chỉ định bằng `SessionManager.create(…, {id: job.id})` nên một id chạy trọn
chuỗi receipt → session → restore).

## Vì sao `--session-id`

`pi --resume` là menu tương tác, không nhận id; `pi --session <id|path>` mở một session có
sẵn. `--session-id <id>` gán/xài id ngay từ đầu — đúng cho cả spawn lẫn restore, và là
forensic link tự nhiên tới receipt (`receipt.get <id>`), body (`responses/<id>.md`) và
watch push cùng một id.

## Đã nghiệm thu

- Unit (`test/pi-spawn.test.ts`): ghi/ghi-đè cùng id, patch restore, bound 200–300, invalid
  fail-closed, không lộ text prompt.
- Live trên máy nhà: spawn `demo-child` → `bound:true`, parent = session controller; đóng
  pane; `restore demo-child` → cùng session id ở pane mới, `bound:true`.
