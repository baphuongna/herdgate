# Spec C13 — Roster phân biệt publisher-alive vs client-online

Ngày: 2026-11-23 · Vòng: DEV-LOOP (nudge #2 của pane wK:p2) · Chủ đề:
mục C13 queued trong backlog (bằng chứng sống của owner, commit `10df787`).

## Bối cảnh (bằng chứng)

- Sự cố thật 2026-11-23: operator đọc device roster thấy **0/6 "live"** → kết
  luận "laptop mất kết nối" → điều tra nhầm hàng chục phút, trong khi
  publisher **connected + supervised + hostInfo 0.12.0 tươi** (hello 09:23Z).
- **"ssh-probe vừa kết nối cũng hiện offline"**: `connected` trong
  `/v1/devices` chỉ đếm leg websocket PWA (`deviceConns`) — leg SSH (sshd)
  có session authenticate riêng, không bao giờ được tính. Device
  `d_39752695` (machine lane herdr, owner pair bằng `herdgate connect`) trên
  production **không bao giờ hiện live** dù dùng hàng ngày.
- Roster block của PWA chỉ in `publisher <version>` — không có tín hiệu
  alive ở đúng chỗ operator đang nhìn; room list ghi "online/offline" không
  nói rõ đó là presence của PUBLISHER (websocket agent), dễ đọc thành "máy
  còn kết nối không".

## Thay đổi

1. **sshd báo presence**: mỗi SSH connection authenticate thành công →
   refcount per-device (một device nhiều connection = vẫn online); socket
   close → giảm. `SshDeps.onPresence(deviceId, online)` (optional —
   backward-compatible với test harness cũ).
2. **Gateway ăn presence SSH**: `sshLive` set; `deviceViews` (WS push cho
   host) và `/v1/devices` tính `connected = web || ssh`; `/v1/devices` thêm
   `legs: ("web"|"ssh")[]` (additive, client cũ đọc `connected` vẫn đúng).
3. **Host-alive tách bạch trong payload roster**: `/v1/devices` trả
   `host: { name, version, connected }` — `connected` = websocket agent
   đang mở (chỉ số "publisher-alive" mà operator cần ngay lúc đó).
4. **PWA nói rõ nghĩa**:
   - room row meta: `online`/`offline` → `host online`/`host offline`
     (khớp wording `room-state` đã có).
   - roster line publisher: thêm `· host connected` / `· host disconnected`.
   - device line: `· live` → `· live(web)` / `· live(ssh)` /
     `· live(web+ssh)` theo `legs`.

## Test (đỏ trước)

- `test/ssh.test.ts` mới: ssh2 client authenticate + GIỮ connection →
  GET `/v1/devices`: device `connected:true`, `legs` chứa `"ssh"`,
  `host.connected:true` (agent đang online); đóng connection → `connected`
  flips false. Không cần exec (auth là đủ cho presence).
- `test/web.test.ts` mới: source-pattern — roster render `host.connected`,
  `d.legs`; room row dùng chữ "host online".

## Nghiệm thu (đo được)

1. Test đỏ đúng chỗ (connected:false với ssh đang mở / thiếu legs /
   thiếu host.connected), xanh sau fix; full suite xanh tuyệt đối.
2. Live verify: gate scratch từ source (port 8899, NO_SSH?, token env không
   in) + state scratch có device thật → ssh client thật (publickey) giữ
   kết nối → `/v1/devices` flips đúng + đóng → flips về. Gate thật 8833
   không đụng.

## Rủi ro

- sshd auth có 2 đường (publickey/password) — presence phải đúng once-only
  per peer (publickey probe phase không tính); nhiều connection một device
  phải refcount, không phải boolean per-peer quăng chung.
- `revoke()` hủy socket → close handler phải tự giảm (không leak count).
- Field mới trong `/v1/devices` là additive — không breaking client cũ.

## Không bump version (2b)

Theme observability cho owner; gộp vào release kế khi owner publish
(đang đứng READY-TO-RELEASE: loop-windows-live từ C12).
