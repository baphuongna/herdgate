import WebSocket from "ws";
const base = "http://127.0.0.1:8962";
const ws = new WebSocket(base.replace("http","ws") + "/v1/device/ws");
const inbox = [];
ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ v: 1, t: "hello", accountToken: "live-ssh", name: "phone" }));
await new Promise((r) => setTimeout(r, 400));
const roomId = inbox.find((m) => m.t === "hello").agents[0].roomId;
ws.send(JSON.stringify({ v: 1, t: "pair.begin", roomId, name: "my-phone", scope: "read" }));
await new Promise((r) => setTimeout(r, 400));
const g = inbox.find((m) => m.t === "pair.granted");
if (!g) { console.error("NO GRANT", inbox.map((m) => m.t)); process.exit(1); }
console.log(JSON.stringify({ id: g.device.id, secret: g.deviceSecret, port: 2299 }));
