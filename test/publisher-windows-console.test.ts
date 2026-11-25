import assert from "node:assert/strict";
import childProcess, { type ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { promisify } from "node:util";

test("background Herdr snapshot, pane list and screen reads hide console windows", async () => {
  const calls: { bin: string; args: string[]; options: ExecFileOptions }[] = [];
  const replacement = Object.assign(() => {
    throw new Error("expected the promisified execFile");
  }, {
    [promisify.custom]: async (bin: string, args: string[], options: ExecFileOptions) => {
      calls.push({ bin, args, options });
      const op = args.slice(0, 2).join(" ");
      if (op === "api snapshot") return { stdout: '{"result":{"snapshot":{"version":"0.9.5"}}}' };
      if (op === "pane list") return { stdout: '{"panes":[{"pane_id":"w1:p1"}]}' };
      if (op === "agent read") throw Object.assign(new Error("not an agent"), { stderr: "agent_not_found" });
      if (op === "pane read") return { stdout: "screen" };
      throw new Error(`unexpected command: ${op}`);
    },
  });
  const original = childProcess.execFile;
  childProcess.execFile = replacement as unknown as typeof original;
  syncBuiltinESMExports();
  try {
    const entry = new URL("../plugin/server/common.mjs", import.meta.url);
    const { herdrSnapshot, herdrPanes, herdrRead } = await import(entry.href) as {
      herdrSnapshot(bin: string): Promise<{ version: string }>;
      herdrPanes(bin: string): Promise<{ id: string }[]>;
      herdrRead(bin: string, pane: string, lines: number, timeout: number): Promise<string>;
    };
    assert.equal((await herdrSnapshot("herdr.exe")).version, "0.9.5");
    assert.equal((await herdrPanes("herdr.exe"))[0].id, "w1:p1");
    assert.equal(await herdrRead("herdr.exe", "w1:p1", 40, 2500), "screen");
    assert.deepEqual(calls.map(({ args }) => args.slice(0, 2)), [
      ["api", "snapshot"], ["pane", "list"], ["agent", "read"], ["pane", "read"],
    ]);
    assert.deepEqual(calls.map(({ options }) => options.timeout), [8000, 8000, 2500, 2500]);
    for (const { bin, args, options } of calls) {
      assert.equal(bin, "herdr.exe");
      assert.equal(options.windowsHide, true, args.join(" "));
    }
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
});
