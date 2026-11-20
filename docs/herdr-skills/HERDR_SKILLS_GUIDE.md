# Herdr TUI: đối chiếu Paseo và bộ skill cho Pi

- Document-updated-at: `2026-11-20`
- Document-status: `WRITTEN`

## Kết luận

Herdr TUI có đủ thao tác nền để chạy workflow **advisor, committee và handoff**, nhưng **không thay Paseo/SLP 1:1**. Herdr điều khiển tiến trình trong terminal; pane sống, trạng thái agent và output terminal không tương đương với turn ID, transcript có cấu trúc, receipt hay quyền của một role SLP.

| Khả năng Paseo | Tương ứng trong Herdr TUI | Mức tương đương |
|---|---|---|
| Host, workspace, worktree | Saved SSH machines, named sessions, workspace/tab/pane, Git worktree create/open | Có các thao tác tương ứng; không giả định project registry, archive hay checkout PR theo hợp đồng Paseo. |
| Workspace scripts | `pane run`, `pane wait-output`, plugin actions | Chạy lệnh được; không có lifecycle/registry workspace scripts kiểu Paseo được xác minh. |
| Tạo agent, gửi việc, chờ, đọc kết quả | `agent start`/`agent prompt`; helper tùy chọn đọc reply Pi JSONL theo request ID | Không phải RPC hay receipt bền. Khi không có session Pi, đọc terminal và nêu giới hạn. |
| Agent profiles, provider/model discovery | Helper tùy chọn đọc catalog TOML; xác minh model bằng `pi --list-models` ở máy đích | Dùng lại notes/model/thinking cho Pi; không có registry toàn daemon hoặc đồng bộ tài khoản. |
| Advisor, committee | Một hoặc hai pane do agent gọi quản lý; mỗi agent phân tích độc lập | Tương đương về workflow. Read-only trong brief là ràng buộc tác vụ, không phải sandbox. |
| Handoff | Agent mới nhận brief; có thể đặt ở worktree riêng theo yêu cầu | Tương đương về chuyển việc; không chuyển session/authority, không tự tạo quan hệ parent-child. |
| Schedule, heartbeat, điều phối qua MCP | `agent wait`, notification, event hook của plugin | Không thấy scheduler/heartbeat native hay Paseo MCP trong Herdr CLI/socket đã kiểm. Không đánh đồng event hook/wait với lịch bền. |
| Trợ giúp, tích hợp agent | `status`, `--skill`, `agent explain`, `integration status`, log | Có. Extension Pi `herdr-agent-state.ts` báo trạng thái; không cấp quyền hay cài skill. |
| Plugin | `herdr-plugin.toml`, actions, events, startup, terminal panes; CLI/socket | Có plugin, khác API Paseo. Không có căn cứ port trực tiếp hook authorization, `slp-gate` hoặc UI Paseo. Không áp kết luận này cho mod Herdr Desktop/Core. |

## Bằng chứng tại máy

- `herdr status`: client trên `PATH` là `0.9.4-preview.2026-10-14-fbd2ae23927f`; server là `0.9.5`, endpoint và private protocol tương thích (22). `HERDR_BIN_PATH` trong pane trỏ đến binary `0.9.5`; ưu tiên đường dẫn này để đọc help và gọi đúng phiên.
- Đã xác minh `HERDR_ENV=1`, trả về JSON thành công từ `pane current --current`, `workspace list`, `agent list`, `agent get` cho pane Pi hiện tại và `plugin list --json`. `integration status` báo tích hợp Pi `current (v9)`.
- Đối chiếu `--skill`, help các nhóm lệnh của cả hai binary và JSON schema socket (`api schema --json`). Schema client liệt kê 102 request variants; không tìm thấy method schedule/heartbeat, project/profile registry hoặc workspace-script lifecycle tương đương Paseo. Phạm vi kết luận là CLI/socket đã khảo sát, không phải mọi addon bên thứ ba.
- Kiểm offline bằng resolver Pi 1.5.2: Pi nhận đủ sáu skill khi project được trust, không nạp skill nào trong bộ khi project không được trust; không có diagnostic về frontmatter. Test không ghi trust store. Kiểm Herdr chỉ đọc: không tạo pane/agent, không gửi prompt, không tạo worktree, không test SSH/plugin trên phiên sống. Chưa xác minh end-to-end advisor/committee/handoff trên Windows. Không có cài đặt, đổi runtime binding BOM, hay reload TUI/Pi.

## Bộ skill trong Pi

| Skill | Phạm vi |
|---|---|
| [`herdr`](../../.agents/skills/herdr/SKILL.md) | Vận hành Herdr TUI và quy tắc dùng chung. |
| [`herdr-advisor`](../../.agents/skills/herdr-advisor/SKILL.md) | Một ý kiến thứ hai, không sửa file. |
| [`herdr-committee`](../../.agents/skills/herdr-committee/SKILL.md) | Hai góc nhìn độc lập, một vòng phản biện có giới hạn. |
| [`herdr-handoff`](../../.agents/skills/herdr-handoff/SKILL.md) | Chuyển việc và tiêu chí nghiệm thu cho agent mới. |
| [`herdr-help`](../../.agents/skills/herdr-help/SKILL.md) | Giải thích, chẩn đoán đọc trước khi đề xuất thay đổi. |
| [`herdr-plugin`](../../.agents/skills/herdr-plugin/SKILL.md) | Tạo, kiểm tra và vận hành plugin **TUI**; không tự install/link. |

Bộ skill ở `.agents/skills/` tương đối với root checkout; Pi tự dò ở phạm vi repo **khi project được trust**. Mở Pi từ checkout bất kỳ, hoặc dùng `/reload` để nạp lại. Nếu Pi hỏi trust, xem nội dung rồi tự quyết định; bộ skill không đổi trust store.
Chọn ví dụ `/skill:herdr` để kiểm tra hướng dẫn hoặc
`/skill:herdr-help vì sao CLI và server khác version?` để chẩn đoán chỉ đọc.
Các workflow tạo agent chỉ chạy khi người dùng yêu cầu **thực hiện**, không
khi hỏi khả năng hay yêu cầu soạn skill. Bản npm Herdgate 0.9.31 trở lên tự đồng bộ
sáu skill khi cài toàn cục (có bật npm scripts), chạy `herdgate install` trên Windows
hoặc sau một lần setup/migrate/update publisher thành công. Bản theo user nằm trong
`~/.pi/agent/skills/herdgate` (hoặc `$PI_CODING_AGENT_DIR/skills/herdgate`).
Có thể chỉ đồng bộ skill bằng `herdgate pi-skills`, không chạm publisher.
Không cần chép thêm vào `~/.agents/skills/`; kiểm tra trùng tên nếu từng cài thủ công.
Skill không phụ thuộc ổ đĩa, username hay thư mục cài Herdr cố định; mỗi máy cần
Herdr CLI/server tương thích và agent đã cài riêng. Có preflight cho Bash/Git Bash và PowerShell.

## Profile và đối chiếu phản hồi Pi

Từ root checkout, với Python 3.11+ (dùng `python3` hoặc `py -3` nếu phù hợp máy):

```text
python .agents/skills/herdr/herdr_pi.py profile list --file .agents/skills/herdr/profiles.example.toml
python .agents/skills/herdr/herdr_pi.py profile show advisor --file .agents/skills/herdr/profiles.example.toml
python .agents/skills/herdr/herdr_pi.py new-request
```

Profile mẫu dùng model mặc định trên máy đích. Muốn cố định model, tạo catalog riêng từ mẫu, thêm `model` dạng `provider/id` và kiểm bằng `pi --list-models`. Có thể chuyển catalog giữa máy; không điền credentials vào notes. `profile show` chỉ in argv để skill dùng khi **được yêu cầu** chạy agent.

Khi đã tạo Pi pane và được yêu cầu gửi việc, dùng ID mới, đặt nguyên `marker` ở dòng đầu prompt rồi gửi qua Herdr bình thường. Để đối chiếu sau khi gửi:

```text
python .agents/skills/herdr/herdr_pi.py observe REQUEST_ID --pane PANE_ID
```

Thay `REQUEST_ID` và `PANE_ID` bằng giá trị thực. `--pane` chỉ dùng trong Herdr và không forward qua `--machine`; nếu chạy trên máy giữ file session thì có thể thay bằng `--session-file` với đường dẫn local tuyệt đối. Thêm `--include-answer` nếu được phép lấy text; mặc định chỉ có trạng thái/ID. Exit `0` = thấy reply, `1` = chưa thấy reply, `2` = không xác minh được. Không tự gửi lại. Helper đọc snapshot Pi v3 tối đa 32 MiB và không điều khiển phiên; nó không xác nhận agent đã hoàn tất hay bảo đảm gửi đúng một lần. Không đồng bộ session giữa các máy.

Nếu đã xác minh ID session Pi đích lúc gửi, thêm `--expect-session SESSION_ID` cho `--pane` hoặc `--session-file`. Fork có thể giữ nguyên marker và entry ID; helper sẽ từ chối nếu header session ID không khớp. Cờ này không xác thực máy đích hoặc bản sao giữ nguyên ID.

Bộ gốc đã kiểm offline với session/profile giả lập và smoke test chỉ đọc trên Windows: lookup pane Pi thật trả `request_not_observed` cho ID mới chưa gửi. Chưa thử gửi thật hoặc smoke test trên macOS/Linux/SSH. [Đặc tả](../../specs/herdr-pi/HERDR_PI_PARITY.md).

Xem thêm [nghiên cứu riêng cho Herdgate](HERDGATE_PI_OBSERVATION.md) về SSH, phân biệt gửi với nhận/phản hồi, và bằng chứng từ thử nghiệm fork trên Pi 1.5.2.

[Nghiên cứu Pi extension và Herdr TUI plugin](HERDR_PI_EXTENSION_RESEARCH.md): khoảng cách với Paseo (không tính SLP), thứ tự triển khai và tiêu chí nghiệm thu. Đây là đề xuất, chưa có extension/plugin kèm theo.

Nguồn: [Herdr stable documentation index](https://herdr.dev/llms.txt),
[Agent automation v0.9.5](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/agent-automation.mdx),
[CLI reference v0.9.5](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/cli-reference.mdx),
[Plugins v0.9.5](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/plugins.mdx).
