import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { createSshBridge } from "../plugin/server/ssh.mjs";

const bin = "/opt/herdr/bin/herdr";
const HEAD = "printf '\n%s\n' 'herdr-remote-output-ready:1'\n";
const exec = `${HEAD}exec ${bin} --session sample remote-client-bridge`;

test("TUI bridge accepts only fixed commands, bound to the publisher session and act scope", () => {
  const calls: unknown[][] = [];
  const messages: Record<string, unknown>[] = [];
  const bridge = createSshBridge({
    send: (_, p) => messages.push(p),
    scopeOf: (d) => d === "owner" ? "act" : "read",
    resolveHerdrBin: () => bin,
    session: "sample",
    spawnImpl: (...args) => { calls.push(args); throw new Error("test stub"); },
  });
  for (const [device, cmd] of [["viewer", exec], ["viewer", "/bin/sh -s"], ["owner", `${exec}; exit`], ["owner", exec.replace("sample", "other")], ["owner", exec.replace(bin, "/tmp/herdr")]]) {
    bridge.handle(device, { op: "ssh.open", ch: "abc", cmd });
    assert.equal(messages.at(-1)?.op, "ssh.denied");
  }
  assert.equal(calls.length, 0);
  bridge.handle("owner", { op: "ssh.open", ch: "abc", cmd: exec });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), [bin, ["--session", "sample", "remote-client-bridge"]]);
  assert.equal((calls[0][2] as { shell: boolean }).shell, false);
});

test("Windows bootstrap advertises the configured executable, never runs uploaded PowerShell, and requires act", () => {
  const winBin = String.raw`C:\Users\Test User\Herdr\herdr.exe`;
  const header = "[Console]::Out.WriteLine(); [Console]::Out.WriteLine('herdr-remote-output-ready:1'); [Console]::Out.Flush(); $ProgressPreference = 'SilentlyContinue'; ";
  const encode = (script: string) => "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + Buffer.from(header + script, "utf16le").toString("base64");
  const messages: Record<string, unknown>[] = [];
  const calls: unknown[][] = [];
  const bridge = createSshBridge({
    platform: "win32", session: "default", tuiOnly: true,
    resolveHerdrBin: () => winBin,
    scopeOf: (d) => d === "controller" ? "act" : "read",
    send: (_, p) => messages.push(p),
    spawnImpl: (...args) => { calls.push(args); throw new Error("test stub"); },
  });
  const open = (device: string, cmd: string) => bridge.handle(device, { op: "ssh.open", ch: "one", cmd });
  const discover = readFileSync(new URL("./fixtures/herdr-win-discovery.ps.txt", import.meta.url), "utf8").trimEnd();
  const stream = `$process = Start-Process -FilePath '${winBin}' -ArgumentList remote-client-bridge -NoNewWindow -PassThru -ErrorAction Stop; $null = $process.Handle; $process.WaitForExit(); exit $process.ExitCode`;
  open("controller", encode(discover));
  const discoveryReply = Buffer.from(String(messages.find((p) => p.op === "ssh.data")?.b64), "base64").toString();
  assert.ok(discoveryReply.includes("herdr-remote-path:1:" + Buffer.from(winBin).toString("base64")));
  for (const [device, command] of [["viewer", encode(stream)], ["controller", encode(stream + "; exit 0")], ["controller", encode(stream.replace(winBin, "C:/other/herdr.exe"))], ["controller", "hc connect"]]) {
    open(device, command);
    assert.equal(messages.at(-1)?.op, "ssh.denied");
  }
  assert.equal(calls.length, 0);
  open("controller", encode(stream));
  assert.deepEqual(calls[0].slice(0, 2), [winBin, ["remote-client-bridge"]]);
  assert.equal((calls[0][2] as { shell: boolean }).shell, false);
});

test("Mobile TUI act sends an idle response immediately and coalesces the following burst in order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  const chunks: string[] = [];
  const bridge = createSshBridge({
    send: (_, p) => { if (p.op === "ssh.data") chunks.push(Buffer.from(String(p.b64), "base64").toString()); },
    scopeOf: () => "act", tuiOnly: true,
    mobileTuiAdapter: { device: "d_phone", scope: "act", script: "/mobile-tui-core.mjs" },
    spawnImpl: () => proc as unknown as ChildProcess,
  });
  bridge.handle("d_phone", { op: "ssh.open", ch: "c", cmd: "hc connect" });
  proc.stdout.write("first");
  assert.deepEqual(chunks, ["first"]);
  for (const text of ["burst", "ed"]) proc.stdout.write(text);
  assert.deepEqual(chunks, ["first"]);
  t.mock.timers.tick(20);
  assert.deepEqual(chunks, ["first", "bursted"]);
  proc.stdout.write("tail");
  proc.emit("close", 0, null);
  t.mock.timers.tick(20);
  assert.deepEqual(chunks, ["first", "bursted", "tail"]);
});

test("Windows mobile opt-in accepts fixed Core commands only for act devices", () => {
  const calls: unknown[][] = [];
  const messages: Record<string, unknown>[] = [];
  const hc = String.raw`C:\Users\Test User\AppData\Local\Programs\herdr-core\herdr-core.exe`;
  const core = String.raw`.\AppData\Local\Programs\herdr-core\herdr-core.exe`;
  const bootstrap = `cmd /d /c "if exist ${core} (${core} connect) else (echo herdr-core is not installed here 1>&2 & exit /b 127)"`;
  const bridge = createSshBridge({
    platform: "win32", tuiOnly: true, mobileHcBin: hc,
    resolveHerdrBin: () => null,
    scopeOf: (d) => d === "phone" ? "act" : "read",
    send: (_, p) => messages.push(p),
    spawnImpl: (...args) => { calls.push(args); throw new Error("test stub"); },
  });
  const open = (device: string, cmd: string) => bridge.handle(device, { op: "ssh.open", ch: "a", cmd });
  for (const [device, cmd] of [["viewer", "hc connect"], ["phone", "hc exec hostname"], ["phone", "hc server stop"], ["phone", `${bootstrap} & echo NO`], ["phone", 'powershell.exe -Command "hc connect"'], ["phone", "hc connect --other"]]) {
    open(device, cmd);
    assert.equal(messages.at(-1)?.op, "ssh.denied");
  }
  assert.equal(calls.length, 0);
  for (const cmd of ["hc connect", "herdr-core.exe connect", bootstrap, "hc server status --json"]) open("phone", cmd);
  assert.deepEqual(calls.map(([bin, args]) => [bin, args]), [[hc, ["connect"]], [hc, ["connect"]], [hc, ["connect"]], [hc, ["server", "status", "--json"]]]);
  assert.ok(calls.every(([, , opts]) => (opts as { shell: boolean }).shell === false));
});

test("Windows Mobile TUI runs the read-only adapter for one read device without replacing the TUI bridge", () => {
  const calls: unknown[][] = [];
  const messages: Record<string, unknown>[] = [];
  const script = String.raw`C:\Users\Test User\Herdgate\mobile-tui-core.mjs`;
  const winBin = String.raw`C:\Users\Test User\Herdr\herdr.exe`;
  const stream = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`[Console]::Out.WriteLine(); [Console]::Out.WriteLine('herdr-remote-output-ready:1'); [Console]::Out.Flush(); $ProgressPreference = 'SilentlyContinue'; $process = Start-Process -FilePath '${winBin}' -ArgumentList remote-client-bridge -NoNewWindow -PassThru -ErrorAction Stop; $null = $process.Handle; $process.WaitForExit(); exit $process.ExitCode`, "utf16le").toString("base64")}`;
  const bridge = createSshBridge({
    platform: "win32", tuiOnly: true, mobileTuiAdapter: { device: "d_phone", script }, session: "default",
    resolveHerdrBin: () => winBin,
    scopeOf: (d) => d === "d_controller" ? "act" : "read",
    send: (_, p) => messages.push(p),
    spawnImpl: (...args) => { calls.push(args); throw new Error("test stub"); },
  });
  const open = (device: string, cmd: string) => bridge.handle(device, { op: "ssh.open", ch: "a", cmd });
  for (const [device, cmd] of [["d_other", "hc connect"], ["d_controller", "hc connect"], ["d_phone", "hc exec hostname"], ["d_phone", stream], ["d_phone", "hc connect; exit"]]) {
    open(device, cmd);
    assert.equal(messages.at(-1)?.op, "ssh.denied");
  }
  assert.equal(calls.length, 0);
  open("d_phone", "hc connect");
  open("d_controller", stream);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [[process.execPath, [script, "connect"]], [winBin, ["remote-client-bridge"]]]);
  assert.ok(calls.every(([, , opts]) => (opts as { shell: boolean }).shell === false));
});

test("Windows interactive Mobile adapter requires the configured device AND act scope", () => {
  const calls: unknown[][] = [];
  const messages: Record<string, unknown>[] = [];
  const script = String.raw`C:\Herdgate\mobile-tui-core.mjs`;
  let phoneScope: "act" | "read" = "read";
  const bridge = createSshBridge({
    platform: "win32", tuiOnly: true, mobileTuiAdapter: { device: "d_phone", script, scope: "act" },
    scopeOf: (d) => d === "d_phone" ? phoneScope : "act",
    send: (_, p) => messages.push(p),
    spawnImpl: (...args) => { calls.push(args); throw new Error("test stub"); },
  });
  const open = (device: string, cmd: string) => bridge.handle(device, { op: "ssh.open", ch: "a", cmd });
  open("d_phone", "hc connect");
  open("d_other_act", "hc connect");
  assert.equal(calls.length, 0);
  phoneScope = "act";
  open("d_phone", "hc connect --interactive");
  assert.equal(calls.length, 0);
  open("d_phone", "hc connect");
  assert.deepEqual(calls[0]?.slice(0, 2), [process.execPath, [script, "--interactive", "connect"]]);
  assert.ok(messages.some((p) => p.op === "ssh.granted" && p.scope === "act"));
});

test("Linux standalone Mobile can scope interactive Core to exactly one act device", () => {
  const calls: unknown[][] = [];
  const messages: Record<string, unknown>[] = [];
  const script = "/local/mobile-tui-core.mjs";
  const bridge = createSshBridge({
    platform: "linux", tuiOnly: true, mobileTuiAdapter: { device: "d_controller", script, scope: "act" },
    resolveHerdrBin: () => null,
    scopeOf: (d) => d === "d_controller" ? "act" : d === "d_viewer" ? "read" : null,
    send: (_, p) => messages.push(p), spawnImpl: (...args) => { calls.push(args); throw new Error("test stub"); },
  });
  const open = (device: string, cmd: string) => bridge.handle(device, { op: "ssh.open", ch: "a", cmd });
  open("d_other", "hc connect");
  open("d_controller", "hc connect --interactive");
  open("d_controller", "hc exec hostname");
  assert.equal(calls.length, 0);
  open("d_controller", "hc connect");
  open("d_viewer", "hc connect");
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [[process.execPath, [script, "--interactive", "connect"]]]);
  assert.equal(messages.at(-1)?.op, "ssh.denied");
});

test("TUI probe waits for SSH EOF, buffers fragments, refuses non-template scripts", () => {
  const messages: Record<string, unknown>[] = [];
  const bridge = createSshBridge({
    send: (_, p) => messages.push(p),
    scopeOf: () => "act",
    resolveHerdrBin: () => bin,
    spawnImpl: () => { assert.fail("these probes must not spawn a process"); },
  });
  try {
    function probe(parts: string[]) {
      messages.length = 0;
      const send = (op: string, other = {}) => bridge.handle("owner", { op, ch: "probe", ...other });
      send("ssh.open", { cmd: "/bin/sh -s" });
      for (const part of parts) send("ssh.data", { b64: Buffer.from(part).toString("base64") });
      assert.deepEqual(messages.map((p) => p.op), ["ssh.granted"]);
      send("ssh.eof");
    }
    probe([HEAD, "uname -s\n", "uname -m\n"]);
    assert.match(Buffer.from(String(messages[1].b64), "base64").toString(), /^\nherdr-remote-output-ready:1\n(?:Linux|Darwin)\n/);
    assert.equal(messages.at(-1)?.code, 0);
    function assertProbeDenied() {
      assert.equal(messages.at(-1)?.code, 111);
      assert.equal(messages[1].stderr, true);
      assert.match(Buffer.from(String(messages[1].b64), "base64").toString(), /unsupported Herdr probe/);
    }
    probe([HEAD, "uname -s\nuname -m\n", "echo extra\n"]);
    assertProbeDenied();
    if (process.platform === "linux") {
      const fixture = readFileSync(new URL("./fixtures/herdr-discovery.sh.txt", import.meta.url), "utf8");
      const candidate = fixture.replace("version=0.9.5", "version=0.9.6-preview.2026.11.19");
      probe([HEAD, candidate]);
      assert.equal(Buffer.from(String(messages[1].b64), "base64").toString(), `\nherdr-remote-output-ready:1\n${bin}\n`);
      assert.equal(messages.at(-1)?.code, 0);
      probe([(HEAD + candidate).replaceAll("\n", "\r\n")]);
      assert.equal(messages.at(-1)?.code, 0);
      probe([HEAD, candidate.replace("version=", "version=invalid#")]);
      assertProbeDenied();
      probe([HEAD, candidate, "\nprintf 'unexpected'\n"]);
      assertProbeDenied();
    }
  } finally {
    bridge.closeAll();
  }
});
