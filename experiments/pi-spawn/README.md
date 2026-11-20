# Pi spawn registry — cha/con và vòng đời agent (thử nghiệm)

Herdr không có registry quan hệ controller→agent, và binding session của Pi chỉ biết được
*sau khi* detection chạy. Helper này lấp hai lỗ đó bằng một nguyên tắc: **một UUID làm cả
receipt request id lẫn `pi --session-id`** — session của agent con được biết ngay tại lúc
spawn, và mở lại sau khi pane chết chỉ là gọi lại cùng một cờ.

## Dùng

```sh
node experiments/pi-spawn/spawn.mjs spawn reviewer --cwd /home/bom/source [-- model ...]
node experiments/pi-spawn/spawn.mjs list
node experiments/pi-spawn/spawn.mjs restore reviewer   # hoặc <request-id>
```

- `spawn`: tách sibling pane (tự tìm pane gọi khi chạy trong Herdr), `herdr agent start … --
  --session-id <uuid>` (idempotent: có session thì mở, không thì tạo), xác minh binding
  (`agent_session` khớp id), ghi `spawns.jsonl` cạnh journal receipt cùng scope.
- `list`: các agent con của workspace này + pane còn attached hay không.
- `restore`: mở lại **đúng session đó** trong pane mới bằng `--session-id`; cập nhật bản ghi.

Registry `<base>/<scope>/spawns.jsonl` (0600): `{id, sessionId, paneId, name,
parentSessionId, cwd, ts, status}` — chỉ id/panes/trạng thái, **không có prompt/answer**;
bound như journal (giữ ~200–300 bản ghi mới nhất). Dùng chung `HERDGATE_PI_RECEIPT_DIR`
override và `scopeFor(realpath)` với journal. Cha-con hiện là **quan hệ quan sát** (controller
tự ghi khi spawn), chưa phải cơ chế SDK cho agent tự khai sinh cha.

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
