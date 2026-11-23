// C11f — State#save() is an atomic tmp+rename; a kill between the two lines
// strands a state.json.tmp-<rand> forever (observed live: a 3-day-old orphan
// in the home gate's state dir). Boot must sweep its own orphans — exact
// prefix match only, never a stranger's file.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { State } = await import(join(import.meta.dirname, "..", "src", "cloud", "stores.ts"));

const tmp = () => mkdtempSync(join(tmpdir(), "hg-state-hyg-"));

test("State boot sweeps its own orphaned tmp files, leaves strangers alone", () => {
  const dir = tmp();
  try {
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ v: 1, rooms: [{ id: "r1" }], devices: [] }), { mode: 0o600 });
    writeFileSync(`${path}.tmp-joutxcyr5h`, "half a write from a killed process");
    writeFileSync(`${path}.tmp-9z8y7x`, "another orphan");
    writeFileSync(join(dir, "state.json.tmp2-notours"), "different pattern");
    writeFileSync(join(dir, "unrelated.log"), "not a tmp at all");

    const st = new State([], path);
    assert.equal(existsSync(`${path}.tmp-joutxcyr5h`), false, "orphan 1 swept");
    assert.equal(existsSync(`${path}.tmp-9z8y7x`), false, "orphan 2 swept");
    assert.equal(existsSync(join(dir, "state.json.tmp2-notours")), true, "different pattern untouched");
    assert.equal(existsSync(join(dir, "unrelated.log")), true, "stranger untouched");
    assert.equal(st.rooms.length, 1, "the real state still loads");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).rooms[0].id, "r1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("State boot sweeps orphans even when the main state never landed", () => {
  const dir = tmp();
  try {
    const path = join(dir, "state.json");
    writeFileSync(`${path}.tmp-firstever`, "crashed before the very first rename");
    const st = new State([], path); // no ENOENT panic, and the orphan is gone
    assert.equal(existsSync(`${path}.tmp-firstever`), false);
    assert.deepEqual(st.rooms, [], "a fresh state starts empty, honestly");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("State without a path never touches the filesystem", () => {
  const dir = tmp();
  try {
    const before = join(dir, "sentinel");
    writeFileSync(before, "here");
    const st = new State([]); // in-memory only
    st.rooms.push({ id: "r9" } as never); // no path → no save attempt, no sweep
    assert.equal(existsSync(before), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
