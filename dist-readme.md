# herdgate host bundle — biến máy này thành một "máy trong đàn"

Bộ này dùng cho máy đã cài **herdr** (app desktop hoặc TUI): cài mod + publisher,
máy sẽ tự kết nối **out** tới gate (không mở port, không VPN) và xuất hiện trên
phone/PWA của bạn. ZIP này không chạy Gate; để tự host Gate mới, dùng
`herdgate-cloud-<version>.tar.gz` trong cùng bộ phát hành.

## Yêu cầu

- herdr desktop app (per-user, không cần admin) hoặc herdr TUI
- Node 22+ có WebSocket (kiểm tra: `node -v` và `node -p 'typeof(WebSocket)'`, kết quả sau phải là `function`)
- Nút **Publish** trong panel yêu cầu Linux/macOS. Với Windows, dùng thử publisher TUI chạy nền bên dưới.

## Cài (Linux / macOS)

1. Giải nén bộ này ở một chỗ cố định, ví dụ `~/herdgate` (cả máy lẫn user thường đều được).

        unzip herdgate-host.zip -d ~/herdgate-host

2. Copy mod vào app:

        # Linux
        mkdir -p ~/.config/herdr-app/mods
        cp -r ~/herdgate-host/mod/herdgate ~/.config/herdr-app/mods/

        # macOS
        mkdir -p ~/Library/Application Support/herdr-app/mods
        cp -r ~/herdgate-host/mod/herdgate ~/Library/Application\ Support/herdr-app/mods/

3. Mở (hoặc restart) herdr app → panel **herdgate** xuất hiện.
4. Trong panel điền:
   - **cloud**: `https://gate.example.com`
   - **herdgate folder**: đường dẫn tới thư mục `plugin` của bộ này (chứa `server/index.mjs`)
   - **name**: tên máy (hiện trên PWA)
5. **Pair** → panel hiện mã code → mở PWA địa chỉ Gate đã cấu hình trên phone/browser bất kỳ,
   Approve → xong. Nhấn **Publish**.

Máy giờ hiện trong PWA; phone pair thiết bị riêng để xem terminal.

## Thử Windows làm host TUI (không cần sshd)

Chỉ bật nếu chính sách của máy cho phép điều khiển từ xa. Laptop phải đã pair
trong Herdgate. Với npm trên Windows, chạy `npx --yes @bom0792/herdgate@latest install`
để cài lệnh `herdgate` cho user (không cần admin), rồi dùng `herdgate setup`
khi cài mới hoặc `herdgate migrate`
để tiếp quản publisher cũ. Nếu bản cũ chưa lưu mode, khai đúng chế độ đang dùng:
`--mobile-act d_device`, `--mobile-read d_device`, `--hc <path>` hoặc `--plain`.
Không dừng publisher hay pair lại trước. `herdgate update` giữ mode đã lưu.
Bản npm từ 0.9.31 tự đồng bộ bộ skill vào profile Pi của user khi cài/cập nhật
Herdgate. Dùng `/reload` trong Pi để nhận thay đổi. ZIP này không chứa bộ skill.

Nếu dùng ZIP, mở PowerShell ở thư mục vừa giải nén. Trỏ thẳng đến Node 22 nếu
máy có nhiều bản Node (sửa đường dẫn nếu cần):

```powershell
$node = 'C:\Program Files\nodejs\node.exe'
& $node -p 'typeof(WebSocket)'
& $node .\windows\install-cli.mjs
$bin = Join-Path $env:LOCALAPPDATA 'Herdgate\cli\bin'
$env:Path = "$bin;$env:Path"
herdgate-tui status
```

Bộ cài dùng junction `current` trỏ vào `releases` dưới
`%LOCALAPPDATA%\Herdgate\cli`. Cài ZIP mới bằng cách chạy lại installer;
`herdgate-tui versions` liệt kê các bản, `herdgate-tui use <release-id>`
chọn bản khác. Muốn có lệnh ở mọi cửa sổ, thêm thư mục `bin` trên vào User
PATH; bộ cài không tự sửa PATH.

Mở session `default` bằng Herdr TUI v0.9.5 trước khi chạy `herdgate-tui start`.
Nếu không cài `herdr.exe` trong `%LOCALAPPDATA%\HerdrPilot\v0.9.5`, truyền đường
dẫn đầy đủ sau `start`. Khi `status` báo `connected`, có thể đóng PowerShell.
`herdgate-tui stop` chỉ dừng publisher. Không tự khởi động khi đăng nhập.
Máy điều khiển vẫn cần quyền `act` và SSH key riêng cho room của laptop.
Mặc định publisher chỉ mở cầu nối TUI, không dùng desktop app hay `hc`.
Mobile là opt-in: `--hc <path>` dùng Core thật; `--mobile-tui d_device`
chỉ đọc pane; `--mobile-tui-act d_device` cho phép nhập và resize đối với
đúng thiết bị đã được duyệt `act`. Adapter TUI không phải bản thay thế đầy đủ
cho Core. Từ `0.9.30`, Mobile TUI Act gửi ngay phản hồi đầu tiên sau lúc rảnh;
không cần bật thêm tùy chọn trên Windows. Loopback chỉ dành cho publisher
Linux chạy cùng máy với Gate, không dành cho laptop dùng Gate từ xa.
Cài ZIP không tự migrate hay nâng cấp máy nhà, Gate hoặc VPS.

## Bộ gồm

    mod/herdgate/          → copy vào mods/ của herdr-app
    plugin/server/*.mjs    → publisher (mod tự spawn bằng node)
    plugin/herdr-plugin.toml → nếu bạn dùng herdr TUI thay vì app
    windows/               → bộ cài và CLI publisher Windows
    templates/herdgate-via.mjs → cầu SSH qua WSS/443

## Gỡ

Dừng publisher trước. Để chỉ gỡ mod, xóa thư mục
`~/.config/herdr-app/mods/herdgate` (hoặc thư mục mod tương ứng trên hệ điều hành).
Giữ `~/.config/herdr-app/herdgate` nếu muốn dùng lại pairing đã có.
