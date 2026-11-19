# herdgate host bundle — biến máy này thành một "máy trong đàn"

Bộ này dùng cho máy đã cài **herdr** (app desktop hoặc TUI): cài mod + publisher,
máy sẽ tự kết nối **out** tới gate (không mở port, không VPN) và xuất hiện trên
phone/PWA của bạn.

## Yêu cầu

- herdr desktop app (per-user, không cần admin) hoặc herdr TUI
- `node` >= 22 trong PATH (kiểm tra: `node -v`)
- **Hệ điều hành: Linux hoặc macOS.** Panel hiện dùng `sh`/`kill`/`nohup` —
  bản Windows đang được port; theo dõi bản mới.

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
   - **cloud**: `https://gate.phuongnb.io.vn`
   - **herdgate folder**: đường dẫn tới thư mục `plugin` của bộ này (chứa `server/index.mjs`)
   - **name**: tên máy (hiện trên PWA)
5. **Pair** → panel hiện mã code → mở PWA `gate.phuongnb.io.vn` trên phone/browser bất kỳ,
   Approve → xong. Nhấn **Publish**.

Máy giờ hiện trong PWA; phone pair thiết bị riêng để xem terminal.

## Bộ gồm

    mod/herdgate/          → copy vào mods/ của herdr-app
    plugin/server/*.mjs    → publisher (mod tự spawn bằng node)
    plugin/herdr-plugin.toml → nếu bạn dùng herdr TUI thay vì app

## Gỡ

    rm -rf ~/.config/herdr-app/mods/herdgate ~/.config/herdr-app/herdgate
