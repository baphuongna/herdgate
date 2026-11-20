// Native Herdr terminal controller. Never grants takeover and never interprets a shell command.
import { spawn } from "node:child_process";

const maxLine = 1024 * 1024;

export async function openTerminal(bin, id, cols, rows) {
  const child = spawn(bin, ["terminal", "session", "control", id, "--cols", String(cols), "--rows", String(rows)], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false,
  });
  child.on("error", () => child.stdout.destroy());
  child.stdin.on("error", () => child.stdout.destroy());
  const frames = readFrames(child.stdout);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    child.stdin.end(); // EOF asks Herdr to release the controller.
    const kill = setTimeout(() => child.kill(), 750);
    kill.unref();
    child.once("close", () => clearTimeout(kill));
  }
  const deadline = setTimeout(() => child.stdout.destroy(new Error("Herdr attach timed out")), 4000);
  try {
    const first = await frames.next();
    if (first.done) throw new Error("Herdr declined terminal attach");
    return {
      first: first.value, frames, close,
      send: (message) => new Promise((resolve, reject) => {
        if (closed || !child.stdin.writable) return reject(new Error("Herdr terminal closed"));
        child.stdin.write(JSON.stringify(message) + "\n", (err) => err ? reject(err) : resolve());
      }),
    };
  } catch (err) {
    close();
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}

async function* readFrames(stdout) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stdout) {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end > maxLine || (end < 0 && pending.length > maxLine)) throw new Error("Herdr terminal frame too large");
      if (end < 0) break;
      const msg = JSON.parse(pending.subarray(0, end).toString("utf8"));
      pending = pending.subarray(end + 1);
      if (msg.type === "terminal.closed") return;
      if (msg.type !== "terminal.frame" || msg.encoding !== "ansi" || typeof msg.bytes !== "string") continue;
      if (!validDimension(msg.width) || !validDimension(msg.height)) throw new Error("Invalid Herdr terminal geometry");
      yield { cols: msg.width, rows: msg.height, bytes: Buffer.from(msg.bytes, "base64") };
    }
  }
}

export function validDimension(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}
