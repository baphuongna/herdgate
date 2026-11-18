// The phone path, for real: ssh → herdgate → hc connect → real herdr-core JSON-RPC.
import { Client } from "ssh2";
import { readFileSync } from "node:fs";

const conf = JSON.parse(readFileSync("/tmp/live-ssh-device.json", "utf8")); // {id, secret, port}
const conn = new Client();
await new Promise((res, rej) => {
  conn.on("ready", res).on("error", rej).connect({
    host: "127.0.0.1",
    port: conf.port,
    username: conf.id,
    password: conf.secret,
    readyTimeout: 10_000,
  });
});
console.log("SSH: authenticated as", conf.id);

const stream = await new Promise((res, rej) => conn.exec("hc connect", (e, s) => (e ? rej(e) : res(s))));
const lines = [];
let buf = "";
stream.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    lines.push(JSON.parse(buf.slice(0, i)));
    buf = buf.slice(i + 1);
  }
});

const send = (m) => stream.write(JSON.stringify(m) + "\n");
const waitFor = async (pred, label, ms = 15_000) => {
  const t0 = Date.now();
  for (;;) {
    const hit = lines.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await new Promise((r) => setTimeout(r, 100));
  }
};

// hello (plain mode — the read-scope path the phone gets by default)
send({ jsonrpc: "2.0", id: 1, method: "hello", params: { calls_you: "phone" } });
const hello = await waitFor((m) => m.id === 1, "hello reply");
console.log("hello →", hello.result.core.name, "| version", hello.result.version, "| methods:", hello.result.methods.length);

// the phone's Inbox: terminal.list over the REAL core
send({ jsonrpc: "2.0", id: 2, method: "terminal.list", params: {} });
const list = await waitFor((m) => m.id === 2, "terminal.list");
const ts = list.result.terminals ?? [];
console.log("terminals:", ts.length, ts.map((t) => `${t.address}${t.name ? ":" + t.name : ""}`).join(" "));

// events subscription works too (read)
send({ jsonrpc: "2.0", id: 3, method: "events.subscribe", params: {} });
const sub = await waitFor((m) => m.id === 3, "events.subscribe");
console.log("events.subscribe → seq", sub.result.seq, "| terminals", (sub.result.terminals ?? []).length);

console.log("READ SCOPE OVER REAL HC: ok");
conn.end();
