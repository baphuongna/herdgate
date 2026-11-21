# Khảo sát marketplace 12 repo — 21/11 (12 subagent, mỗi repo một agent)

Mỗi báo cáo = nghiên cứu sâu từ source thật (≥5 file/repo qua raw.githubusercontent),
có tham chiếu file-level + checklist áp dụng + anti-patterns.

| Repo | Bài học chủ chốt |
|---|---|
| herdcats | persistent shell + marker framing; input ack queue (coalescing, needsResync-no-replay); photo attachments; dual-runtime detect không tự switch |
| herdrchat | send-path 3 trạng thái delivered/stalled/unverified; checksum-stamped reads (cksum+conditional cat); timeline chat-model (ThreadItem, subagent cards); error taxonomy + humanise() |
| entwurf | identity record một-id tách receipts; retire 3 lớp (preflight refuse + generation check); liveness đọc lúc dispatch |
| herdr-file-viewer | hardened git reads (--no-ext-diff --no-textconv, hooksPath null, scrub env); path:line deep-link; kênh note file→agent |
| herdr-link | inbound wrapper self-describing (agent không cần docs); envelope id adapter-side; lazy gateway MCP; error passthrough phân tầng |
| herdr-mobile-relay | transport cutover menu + guard lock; receipts class read/mutating + ApiError{code}; inventory bootstrap+events+diff-before-broadcast |
| herdr-portfwd | port attribution qua process ancestry (cycle-guard); request/ack high-water mark cross-machine; StateError::Damaged (không bao giờ default-rỗng) |
| ram-overlay | /proc sampler per-agent (cutime/cstime 3-case delta — không thì test build đọc 0%); torn-snapshot discipline; TTL mọi state đẩy xuống |
| herdr-revive | exact-session restore (đã áp: spawn.mjs revive); allowlist programs + launcher rules (chưa cần); benchmark save/restore |
| herdr-plugin-sesh | revision optimistic-concurrency (RecordSwitch); single-observer election flock; stale-fallback snapshot khi transport đứt; fan-out merge cho picker |
| herdr-sidebar | heartbeat tokens liveness (stale>20s = corpse); flock try_lock event bursts; GIT_OPTIONAL_LOCKS=0; graceful Ctrl+Q trước close |
| herdr-agent-usage | port parser Pi JSONL (context sau compaction, model sau model_change, tail-window 8MB); payer model chứng-minh-mới-gộp; quota windows |

## Kế hoạch áp theo wave
- **A Bền vững**: hardened git + Damaged-discipline + flock bursts + heartbeat liveness + send 3-trạng-thái
- **B Observers**: /proc sampler per-agent + parser Pi transcript + port attribution → receipts `usage:<id>` + PWA
- **C Mobile**: persistent shell + input ack + checksum reads + attachments
- **D PWA UX**: chat timeline + path:line deep-link + notes + stale-fallback
- **E Interop**: inbound wrapper + retire 3 lớp + lazy MCP gateway herdgate
