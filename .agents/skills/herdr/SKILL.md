---
name: herdr
description: 'Vận hành Herdr TUI qua CLI: xem hoặc điều khiển pane, tab, workspace, worktree, agent, session và máy SSH. Chỉ dùng khi người dùng yêu cầu dùng Herdr; không tự khởi chạy agent hoặc thay đổi phiên chỉ vì có thể chạy song song.'
---

# Herdr TUI

Herdr quản lý terminal. Workspace chứa tab, tab chứa pane; agent là tiến trình được Herdr nhận diện trong pane, không phải thực thể điều phối độc lập kiểu Paseo. Dùng skill này cho thao tác runtime hoặc làm nền cho advisor/committee/handoff. Hỏi thông tin, soạn skill hay thảo luận phương án không phải yêu cầu chạy lệnh thay đổi phiên.

## Xác định đúng phiên và CLI

Cần Herdr TUI CLI và server tương thích; khi chạy agent, cần kind đã cài và khởi chạy được trên **máy đích** (với Pi, cần cấu hình model và quyền truy cập của máy đó). Skill không đóng gói binary, model, token hay integration hook; không tự cài các thành phần thiếu.

Trước mọi thao tác với phiên sống, kiểm tra `HERDR_ENV=1` và có `HERDR_PANE_ID`; nếu thiếu, dừng và báo, không tự dò hay thao tác trên phiên đang focus từ ngoài Herdr. Có thể đọc docs/help offline mà không attach. Chọn ví dụ theo shell thực tế, không yêu cầu cài Bash trên Windows.

Bash/Git Bash:

```bash
if [ "${HERDR_ENV:-}" = 1 ] && [ -n "${HERDR_PANE_ID:-}" ]; then
  H=${HERDR_BIN_PATH:-herdr}
  "$H" status && "$H" pane current --current
else
  printf "%s\n" "Không ở trong pane Herdr; không điều khiển phiên." >&2
fi
```

PowerShell:

```powershell
if ($env:HERDR_ENV -eq '1' -and $env:HERDR_PANE_ID) {
    $H = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { 'herdr' }
    & $H status
    if ($LASTEXITCODE -eq 0) { & $H pane current --current }
} else {
    Write-Warning 'Không ở trong pane Herdr; không điều khiển phiên.'
}
```

Ưu tiên `HERDR_BIN_PATH` của phiên; chỉ dùng `herdr` trên PATH khi biến này không được cấp. Giữ nguyên context Herdr do pane cung cấp, không tự đoán socket hay session. Đọc `status` và kết quả `pane current --current` để xác minh đúng phiên trước khi gửi lệnh. Dùng `--skill`, `--help` hoặc help từng nhóm (`agent`, `pane`, `worktree`, `plugin`) để xác nhận các cờ/method cần dùng ở bản thực tế. Không chạy `herdr` trần để dò lệnh (launch/attach), không dò bằng lệnh con đột biến không tham số. Nếu binary không chạy được, thiếu tính năng hoặc không tương thích, báo chứ không tự cập nhật, restart hay đổi binary.

Các mẫu lệnh còn lại dùng cú pháp Bash. Trong PowerShell, gọi binary bằng `& $H` và dùng tham số/biến tương ứng. Truyền dữ liệu như path và brief bằng các phần tử argv riêng. Với native CLI trên Windows, nếu shell không giữ nguyên được dấu nháy hoặc brief nhiều dòng (ví dụ chế độ truyền đối số cũ của PowerShell), dùng runtime hỗ trợ argv trực tiếp hoặc dừng và báo giới hạn. Với Git Bash gọi `herdr.exe`, khi cần giữ nguyên path/brief/argv, dùng `MSYS2_ARG_CONV_EXCL='*'` cho **lời gọi đó** và truyền path native của máy đích. Không sửa cấu hình shell toàn cục.

## Chọn thao tác và target

- Read-only: `workspace list`, `tab list --workspace "$HERDR_WORKSPACE_ID"`, `pane list --workspace "$HERDR_WORKSPACE_ID"`, `agent list`, `session list --json`, `machine list --json`. `pane process-info`/`pane read` dùng khi cần đọc tiến trình thường; `agent get`/`agent read` khi cần đối chiếu agent được nhận diện. Chỉ đọc đối tượng nằm trong scope yêu cầu, không đổ toàn bộ transcript/log ra câu trả lời.
- Parse JSON, chỉ dùng ID thật. Agent target là tên live duy nhất hoặc pane ID đang chứa agent, không phải terminal ID hay kind `pi`. Kiểm tra tên chưa được dùng, dạng `[a-z][a-z0-9_-]{0,31}`. Sau move, phát hiện lại pane ID. Không dùng focus hiện tại làm fallback cho `--current`.
- Máy SSH: chỉ khi người dùng chỉ định; dùng cùng prefix `--machine <label-or-id>` cho discovery, launch, prompt, wait và read. Xác minh client/server hai đầu, dùng ID/path lấy ở máy đích và pane đích rõ ràng (không dùng `--current`/ID local trên máy remote). Không tự start máy đích, cài phần mềm, attach/takeover hoặc chuyển sang local khi lỗi.
- `workspace create` là terminal context, không phải tạo project registry. `worktree create` tạo/mở checkout (có thể tạo branch); `worktree open` mở checkout có sẵn. Chỉ thay topology/cwd khác khi được yêu cầu, kiểm tra Git base và trust; không thêm `--trust-repository` để lách Git. `workspace close` khác `worktree remove`; không dùng `--group`/`--force` hay đóng tài nguyên phiên đang dùng chỉ để dọn tiện.
- `pane run` chạy lệnh thường trong shell pane trống: phản hồi là đã xếp input, không chứng minh command chạy xong; `pane wait-output` có thể match output cũ. Dùng marker mới nếu cần quan sát lần chạy. Không thay `agent prompt` bằng raw keystrokes khi gửi việc.
- Herdr không có profile registry kiểu Paseo; xem tùy chọn profile Pi bên dưới. Không giả định có Paseo MCP, schedule/heartbeat bền hoặc quyền SLP native. Không dựng vòng polling, schedule bên ngoài, tự gửi tiếp hoặc dùng skill này thay `slp-gate`.

## Tùy chọn Pi: profile portable và phản hồi có cấu trúc

Nếu có Python 3.11+ và file `herdr_pi.py` đi kèm **trong thư mục của skill này**, dùng helper qua đường dẫn phát hiện từ vị trí `SKILL.md`, không dựa vào cwd cố định. Tên lệnh Python có thể là `python`, `python3` hoặc `py -3`. Bộ skill thuần terminal vẫn dùng được nếu không có helper hoặc Python.

- **Profile:** nếu người dùng chọn profile, dùng `profile list --file <catalog.toml>` hoặc `profile show <name> --file <catalog.toml>`. Có mẫu `profiles.example.toml` cùng thư mục; catalog thật do người dùng chọn, không tự copy credentials hay model config của máy khác. Xem `notes` để chọn profile khi được giao quyền chọn; notes không phải prompt. Xác minh model/thinking hỗ trợ trên máy đích. Truyền `pi_args` dưới dạng đối số riêng sau `--` của `agent start`, không eval. Nếu profile người dùng chỉ định không dùng được, báo và hỏi thay vì tự đổi.
- **Đối chiếu:** trước khi gửi việc cho Pi, gọi `new-request`, giữ ID và đặt nguyên `marker` trả về ở **dòng đầu prompt**. Một ID mới cho mỗi agent và mỗi vòng; chỉ gửi một lần qua `agent prompt`. Muốn kết quả tự về thì đăng ký watch cho ID đó trước khi gửi (xem quy trình chung bước 4); sau đó `observe <request-id> --pane <pane-id>` chỉ để đối chiếu thêm khi báo cáo đã đến hoặc khi cần tra cứu. Nếu biết file session tuyệt đối trên chính máy đọc, có thể dùng `--session-file <path>` thay `--pane`; không đọc path của máy SSH từ local. Nếu đã biết ID phiên Pi lúc gửi, thêm `--expect-session <id>` cho cả hai kiểu đọc để không nhận nhầm kết quả từ phiên fork khác ID. Nếu không có ID đã xác minh, báo kết quả là quan sát không ghim phiên. Chỉ truyền `--include-answer` khi cần đọc phần trả lời và đúng phạm vi.
- **Đọc kết quả:** `response_observed` = tìm thấy assistant reply cùng nhánh cho marker đó, không phải proof agent đã idle/hoàn tất task; `request_observed` = thấy user entry nhưng chưa thấy phản hồi phù hợp; `request_not_observed` hoặc `unverified` **không** suy ra chưa gửi. Không tự resend, không tự chuyển sang session khác. Có thể đọc terminal để chẩn đoán, nhưng ghi rõ đó là nguồn riêng, không biến thành receipt. Nếu thiếu integration hay file không đọc được, dùng luồng terminal và báo giới hạn.

## Quy trình chung khi được yêu cầu tạo agent

1. Xác định cwd, kind và flags mà người dùng muốn. Không có profile chung của Herdr; dùng help/catalog của CLI con, ví dụ `pi --list-models` nếu cần chọn model. Mặc định ưu tiên Pi đang dùng nếu kind/bin sẵn có, không tự chuyển host, tài khoản/provider hay model khi lỗi. Tôn trọng model/flags chỉ định; cờ riêng đặt sau `--`.
   Pi mới dùng settings/provider/tài nguyên của user và workspace trên máy đích. Khi người dùng yêu cầu override, truyền cờ Pi đã xác minh sau `--` bằng argv riêng (ví dụ `--model provider/id --thinking high`; tool, skill, extension và session flags theo `pi --help` tại máy đích). `agent prompt` vào Pi đã mở dùng model/thinking hiện tại; không gắn cờ khởi chạy vào nội dung prompt.
2. Mặc định tạo sibling pane trong tab hiện tại, giữ cwd và không giật focus. `pane layout --pane "$HERDR_PANE_ID"` giúp chọn `right`/`down` phù hợp. Xác định cwd tuyệt đối trên chính máy đích: local Unix dùng `pwd -P`, Windows PowerShell dùng `(Get-Location).ProviderPath` trong thư mục filesystem, Windows Git Bash dùng `pwd -W`. Với SSH, xác minh cwd bằng thông tin workspace/pane của máy đích hoặc đường dẫn do người dùng cung cấp; không chuyển đổi cwd local thành cwd remote. Chỉ dùng existing pane khi người dùng chỉ định và xác minh đó là shell trống. Ví dụ dưới đây là mẫu, không tự chạy khi chỉ đọc skill:

   ```bash
   "$H" pane split --current --direction right --cwd "$target_cwd" --no-focus
   # Đọc .result.pane.pane_id, dùng làm giá trị pane_id.
   "$H" agent start "$agent_name" --kind pi --pane "$pane_id" --timeout 30000
   ```

   Không dùng lại Pi session cũ (`--continue`/`--resume`) cho agent mới. `agent start` không tự tạo pane; nếu lỗi hoặc agent bị kẹt lúc khởi động, xác minh pane và agent trước khi làm gì tiếp. Không reset pane hay khởi chạy lần hai mù.
3. Xác minh đúng agent và `idle`/`done` bằng `agent get`, kiểm tra UI nếu chưa rõ pane có sẵn sàng. Gửi brief có phạm vi, yêu cầu không tự ủy quyền tiếp và marker kết quả mới riêng cho task/agent. Truyền brief dạng một đối số, không `eval` hay chèn vào chuỗi shell; không đưa credential, toàn bộ log hay transcript nhạy cảm vào prompt/argv. Với brief dài, tóm gọn; nếu cần dẫn file thì xác minh quyền đọc và đường dẫn trên đúng máy.

   ```bash
   "$H" agent prompt "$pane_id" "$brief"   # gửi một lần, KHÔNG --wait — không chờ kết quả
   ```

4. **Subagent tự báo cáo lại; controller không chờ.** Đăng ký watch cho request ID **trước khi gửi**, kết quả tự đẩy về khi agent settle:
   - Listener riêng (tiến trình/terminal khác controller): `node experiments/pi-receipt/query.mjs --gate … --device d --secret s --id <uuid> --wait --body --out <file-new>` — push đến thì tải reply, lưu file 0600 và ACK tự động.
   - MCP client có cấu hình herdgate: `herdgate_receipt_wait` / `herdgate_receipt` / `herdgate_receipt_body`.
   - Tự viết client: frame `receipt.watch {id, wantBody}` rồi `receipt.ack {id}` sau khi xử lý; mất kết nối thì publisher phát lại push chưa ACK khi nối lại.

   Cấm: `agent prompt --wait`/`--timeout` để chờ nhiệm vụ (đó là chờ đồng bộ trên controller), vòng lặp `agent get`/`agent read`, `sleep`, polling pane. `agent start --timeout` chỉ chờ readiness khi khởi tạo agent — vẫn hợp lệ. `agent prompt` trả ok chứng nhận input đã xếp, không phải agent đã nhận việc hay hoàn thành. Khi báo cáo về: `replied` chứng minh có reply cuối đúng request (kèm usage), không khẳng định task nghiệp vụ thành công; `observe`/`agent read` chỉ để đối chiếu bổ sung sau khi báo cáo đến, hoặc khi người dùng yêu cầu tra cứu. Nếu chưa có watch/forwarder nào: ghi rõ "đã submit, báo cáo sẽ tự về" và kết thúc lượt, không chuyển sang chờ.
5. Báo tên agent, pane, cùng kết quả hoặc trạng thái chưa xác minh; dừng đúng giới hạn. Không tự đóng pane có việc đang chạy hay pane người dùng; không dọn tài nguyên nếu chưa được yêu cầu. Worktree là checkout riêng, **không phải OS sandbox**.

## Mở lại session sau khi pane đóng

Pane chết không mất session — Pi session là file. Khôi phục đúng quy trình (khác với quy tắc
"không resume cho agent mới": đây là trả lại đúng session cũ của pane đó):

```bash
PANE=$("$H" pane split --current --direction right --no-focus --cwd /home/bom/source | jq -r .result.pane.pane_id)
"$H" agent start <tên> --kind pi --pane "$PANE" --timeout 45000 -- --session <session-id|đường-dẫn-file>
"$H" pane list   # xác minh agent_session trỏ đúng file session cũ
```

Cờ sau `--` truyền thẳng cho Pi; **dùng `--session <id|path>`** — `--resume` không nhận id,
nó mở menu chọn tương tác và agent sẽ không ràng buộc session. **Không dùng `pane run 'pi …'`
để khởi chạy/khôi phục agent**: phản hồi của `pane run` chỉ là "input đã xếp", không chờ readiness,
không ràng buộc agent — agent sẽ hiện không có session và controller không quản lý được.
Muốn đóng agent: `/quit` trong pane đó, đợi shell prompt; đóng pane phải do người dùng quyết định.
