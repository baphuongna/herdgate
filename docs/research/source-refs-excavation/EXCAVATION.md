# Đào line-by-line 7 source-ref + orch — UI & tiện ích cho herdgate

Gốc: `/home/bom/source/my-herdr/source-refs/` (+ `my-herdr/orchestrator/web`).
Mục tiêu: **không chỉ lấy kỷ luật — lấy UI + tiện ích** về cho PWA / Mobile TUI / SSH leg / plugin.
Trạng thái mỗi file: `DONE` (đọc hết từng dòng) · `NEXT` · `LATER`.
Bảng đối chiếu cuối: bài học → nơi đáp trong herdgate.

## 1. collie/web — PWA mobile-first điều khiển herdr (React + Vite, ~10k dòng không-test)

### Đã đọc TRỌN TỪNG DÒNG
| File | Dòng | Bài học rút ra |
|---|---|---|
| `src/App.tsx` | 19 | IdleLock unmount router = pause mọi polling; BusyBar mutation-strip toàn cục |
| `src/router.tsx` | 39 | router module-scope sống qua lock; xoá `remix-router-transitions` tránh phantom transition |
| `src/routes/home.tsx` | 92 | Triage "Needs you" (accent) đầu trang → SpaceOverview → rest groups; StatusArea fixed ngoài scroller |
| `src/routes/detail.tsx` | 84 | freshPane bootstrap + seen-theo-paneId (bug pane→pane); pane chết bounce Home chỉ khi snapshot khỏe |
| `src/components/agent-chat.tsx` | 711 | Xem mục "Vàng" dưới |

### VÀNG từ agent-chat.tsx (đọc xong 711 dòng)
1. **Mirror freeze**: `following` bool + cặp `{text, revision}` đóng băng cùng lúc — scroll lên là text đứng yên, có nút jump-to-latest + chỉ báo `hasNew`. Object.is bailout chống re-render mỗi poll.
2. **Race guard theo revision**: mọi tap (prompt-select/wizard/preview/multi-select) re-fetch tươi → so revision + re-derive menu → chỉ khớp sạch mới gửi keys. So với **revision của cặp đóng băng** (revision live đã chạy tiếp — so với nó là mù).
3. **Terminal draft rescue**: draft kẹt trên dòng "❯" → extract qua adapter → `useStableTerminalDraft` (~1.5s ổn định mới hiện, tránh flash chính tin nhắn mình vừa gửi) → preview read-only + "Take over".
4. **Statusline re-surface**: stripChrome lược khỏi mirror nhưng hiện lại 1 dòng chrome trên composer (branch/model/ctx) — cùng adapter, không drift.
5. **Find-in-output**: mở find = đóng băng tail; đếm match + prev/next + scroll-into-view.
6. **Load-older scrollback**: grow requestedLines → adopt khi fetch grown đáp (key theo requestedLines, poll cũ không adopt sớm) → re-anchor scrollTop theo height-delta.
7. **focusFromMirror**: tap mirror focus composer, TRỪ khi trúng control tương tác / đang select text.
8. **Đóng băng cặp khi guard**: mọi handler gửi keys đều `setFollowing(true) + revalidate + scrollToBottom` sau Sent.

### NEXT — đọc tiếp theo (theo thứ tự)
- [ ] `components/composer.tsx` (646) — cluster send/keys/quick/slash/image-upload/display-prefs
- [ ] `lib/blocks.ts` (164) + `lib/ansi.ts` (244) + `components/ansi-output.tsx` (288) — **grammar engine**: parse ANSI → prompt-select/wizard/preview/multi-select thành control native
- [ ] `lib/prompt-action.ts` (76) · `wizard-action.ts` (95) · `preview-action.ts` (254) · `multi-select-action.ts` (234) — guard-first submit + macro Down→Up→verify→Enter
- [ ] `lib/api.ts` (336) · `lib/loaders.ts` (298) — polling/revalidation/requestedLines map
- [ ] `hooks/`: use-swipe, use-long-press, use-pending-confirm, use-terminal-draft, use-connection-lost, use-polling, use-idle-lock, use-display-prefs, use-loading-stalled, use-transitions
- [ ] `components/`: nav-tray (238), command-palette, connection-banner (217), tab-strip (145), pane-strip (145), pane-actions-sheet (149), tab-actions-sheet (156), agent-sidebar (144), space-view/overview, new-space-sheet, wizard-block (247), multi-select-block (188), preview-select-block (275), find-bar, status-badge, update-banner, session-switcher, idle-lock, busy-bar, dog-gallop, build-stamp
- [ ] `routes/space.tsx` (138) · `settings.tsx` (156) · `root.tsx` (117)
- [ ] `lib/`: agent-commands (184), push (154) + push-decision (70), self-update (177), connection-health (152), key-queue (64), busy (60), destructive (38), find (68), pwa (128), reload-guard (56), session, spaces, nav, format, status, types (202)
- [ ] `sw.ts` + `index.css` + `components/ui/*` (sheet, chat/chat-message-list, badge, button, card, chip, switch)

### LATER
- `*.test.*` (10k dòng test — đọc khi port từng phần tương ứng)

## 2. herdr-app — desktop app Rust (56 file / 37.668 dòng)
NEXT: `src/vt.rs` (VT parser), `mirror.rs`, `mod_files.rs` (giao diện = file!), `process_cwd.rs`, `update.rs`, `sprites.rs` (animation), defaults/AGENTS.md.
Liên hệ herdgate: `app-mod/herdgate` hiện đã là mod herdr-app — đọc để hiểu contrzt giữa mod Files vs API.

## 3. herdr-file-viewer — viewer Rust (87 file / 52.399 dòng)
NEXT: `fuzzy.rs`, `search.rs`, `text_layout.rs`, `render.rs`, `git.rs`, `main.rs`.
Ứng viên: op `file.view` cho SSH leg (deep-link path:line), fuzzy search receipt/transcript.

## 4. herdr-mirror — plugin Rust (15 file / 5.918 dòng)
NEXT: `mirror.rs`, `predict.rs`, `docker.rs`, `grid.rs`, `pane.rs`.

## 5. herdr-reviewr — review TUI Rust (29 file / 21.319 dòng)
NEXT: `diff.rs`, `world.rs`, `turn.rs`, `keymap.rs`, `git.rs`.
Ứng viên: review diff của agent cho Pi (`review` skill đã có sẵn khung).

## 6. herdr-remote — herdi-ios + herdi-mac + relay + web + demo-worker
NEXT: `herdi-mac/Sources/*` (MenuBarPanel, RelayConnection, Updater, KeychainHelper), `herdi-ios/`, `relay/`, `web/`, `QUICKSTART.md`.
Liên hệ herdgate: thiết kế native client + relay riêng — so với gate + Noise.

## 7. herdr (TUI chính) — Rust vendor portable-pty
LATER (đã nghiên cứu sâu ở research trước: api/mod, panes, restart_policy, attach).
Mở: `vendor/portable-pty.patches.md` — patch local cần biết.

## 8. my-herdr/orchestrator/web — htmx + Rust (orchestrator của user)
NEXT: `web/dist/app.js`, `index.html`; `plugin/`, `crates/` (tên), `README.md`.

## Ưu tiên PORT về herdgate (cập nhật khi đào tiếp)
| # | Từ đâu | Cái gì | Đáp vào đâu | Độ khó |
|---|---|---|---|---|
| P1 | agent-chat | Mirror freeze + follow-tail + hasNew | PWA app.js (đang mirror luôn re-render) | Vừa |
| P2 | agent-chat | Load-older scrollback + scroll anchor | PWA (view op đã có requestedLines?) | Vừa |
| P3 | agent-chat | Find-in-output | PWA | Vừa |
| P4 | blocks/ansi | Grammar: ANSI → control native (prompt-select trước tiên) | PWA + Mobile TUI | Lớn |
| P5 | agent-chat | Race guard revision cho mọi tap | PWA act path | Vừa |
| P6 | collie lib | Idle lock + BusyBar + connection banner | PWA | Nhỏ |
| P7 | self-update/sw/reload-guard | PWA update discipline | PWA sw.js | Vừa |
| P8 | push/push-decision | Decision logic push (đã có VAPID, đối chiếu) | gate + PWA | Nhỏ |
| P9 | file-viewer | fuzzy + search + text_layout | receipt/transcript search (đã có BM25 — đối chiếu) | LATER |
| P10 | reviewr | diff viewer | op `diff.view` cho SSH leg + Pi | LATER |

## Ghi chú excavation
- Marketplace 12 repo: báo cáo đầy đủ ở `docs/research/2026-11-21-marketplace/` (đã xong wave A–E kỷ luật; phần UI của 12 repo đó phần lớn trùng tính năng với collie — collie là bản full-source gần lineage nhất nên đào trước).
- Nguyên tắc: đọc DONE mới ghi bài học; mọi bài học phải ghi file+dòng gốc.
