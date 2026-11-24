/**
 * The publisher's socket to the cloud needs the same verdict as the agent's
 * (see test/agent-keepalive.test.ts for the incident): a ping every interval, and three
 * intervals of silence mean gone — even though `readyState` still says OPEN. In the journal
 * this was the home publisher sitting out 23:07:55 → 23:21:04 on 2026-11-21 with the tunnel
 * back since 23:11:37.
 *
 * The publisher runs as the real child process (`serve` + HERDGATE_PUBLISHER_CHILD=1)
 * against the quiet cloud; the interval is shortened through HERDGATE_KEEPALIVE_MS.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quietCloud, sleep, waitFor } from "./util-keepalive.ts";

const INDEX = new URL("../plugin/server/index.mjs", import.meta.url);

function publisher(dir: string, port: number): { child: ChildProcess; stderr: () => string } {
  writeFileSync(
    join(dir, "herdgate.env"),
    [`HERDGATE_URL=http://127.0.0.1:${port}`, "HERDGATE_ROOM_TOKEN=keepalive-fixture-token"].join("\n"),
  );
  const child = spawn(process.execPath, [INDEX.pathname, "serve"], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: dir,
      HERDGATE_PUBLISHER_CHILD: "1",
      HERDGATE_KEEPALIVE_MS: "250",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  assert.ok(child.stderr, "stderr is piped");
  child.stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  return { child, stderr: () => err };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
}

test("publisher: a cloud that goes silent while the socket stays open is redialed", { timeout: 20_000 }, async () => {
  const cloud = await quietCloud();
  const dir = mkdtempSync(join(tmpdir(), "hg-keepalive-"));
  const { child, stderr } = publisher(dir, cloud.port);
  try {
    await waitFor(() => /connected to http:\/\/127\.0\.0\.1:\d+/.test(stderr()), 8_000, "the publisher's first hello");
    await sleep(900); // several keepalive intervals on a healthy link
    assert.equal(cloud.conns(), 1, `a healthy link is never redialed: ${stderr()}`);
    assert.ok(cloud.pings() >= 2, `the publisher sends pings of its own (${cloud.pings()})`);

    cloud.mute();
    await waitFor(() => cloud.conns() >= 2, 8_000, "a second connection after the cloud went silent");
    assert.match(stderr(), /silent.*redialing/, "the verdict is on the record");
  } finally {
    await stop(child);
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
