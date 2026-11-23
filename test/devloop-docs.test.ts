// C19 — the DEV-LOOP.md the auto-run agent reads every cycle must stay
// bounded: the Cycle Log archive (docs/DEV-LOOP/LOG-YYYY-MM.md) carries the
// history; the main file carries principles + backlog + lessons + the latest
// rounds (the table sits at the END of the file, where new rows are appended).
// A one-time migration test that pinned "exactly N rows" was rejected in
// review (the next cycle would have turned the suite red); this is the
// durable invariant only.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const DOC = join(ROOT, "docs", "DEV-LOOP.md");
const MAX_BYTES = 32 * 1024;

test("dev-loop docs: the per-cycle prompt file stays bounded, history lives in the monthly archive", () => {
  const size = statSync(DOC).size;
  assert.ok(size <= MAX_BYTES, `docs/DEV-LOOP.md is ${size} bytes (cap ${MAX_BYTES}) — move older Cycle Log rows into docs/DEV-LOOP/LOG-<month>.md`);
  const doc = readFileSync(DOC, "utf8");
  const lines = doc.split("\n");
  const tableAt = lines.findIndex((l) => l.startsWith("## Cycle Log ("));
  assert.ok(tableAt >= 0, "the Cycle Log heading must name the archive convention");
  assert.match(lines[tableAt], /lịch sử đầy đủ: docs\/DEV-LOOP\/LOG-\d{4}-\d{2}\.md/);
  assert.equal(lines.filter((l) => l.startsWith("## Cycle Log")).length, 1, "exactly one Cycle Log table — rows appended at EOF must land in it");
  assert.equal(lines.slice(tableAt).filter((l) => l.startsWith("### ")).length, 0, "the table is the last section, so appended rows stay inside it");
  assert.ok(statSync(join(ROOT, "docs", "DEV-LOOP", "LOG-2026-11.md")).size > 0, "the archive file exists and is non-empty");
});
