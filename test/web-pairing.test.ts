import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { startCloud } from "../src/cloud/gateway.ts";
import { DeviceSock } from "./util2.ts";
import { DeviceChannel, HostChannel, fingerprint, generateKeyPair } from "../plugin/server/e2e.mjs";

// Run the actual browser module with a minimal DOM and real loopback WebSockets.
class Element {
  hidden = true;
  value = "";
  open = false;
  className = "";
  textContent = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  handlers = new Map<string, (event: { preventDefault(): void; target: Element }) => void>();
  nodes = new Map<string, Element>();
  get content() { return this; }
  focus() {}
  close() {}
  setAttribute() {}
  cloneNode() { return new Element(); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  find(check: (node: Element) => boolean): Element | undefined {
    if (check(this)) return this;
    for (const node of this.children) {
      const hit = node.find(check);
      if (hit) return hit;
    }
  }
  closest() { return this; }
  querySelector(id: string) {
    if (!this.nodes.has(id)) this.nodes.set(id, new Element());
    return this.nodes.get(id)!;
  }
  addEventListener(event: string, cb: (event: { preventDefault(): void; target: Element }) => void) { this.handlers.set(event, cb); }
  fire(event: string, target = this) { this.handlers.get(event)?.({ preventDefault() {}, target }); }
}

async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(20);
  }
  assert.fail(message);
}

test("web: separate room pairings survive reload, and pinned rooms reject plaintext and a changed host key", async () => {
  const accountToken = "web-pair-owner";
  const cloud = await startCloud({ accounts: [{ id: "a", name: "owner", token: accountToken }], log: () => {} });
  const base = `http://127.0.0.1:${cloud.port}`;
  const ws = base.replace("http", "ws");
  const sockets: { close(): void }[] = [];
  try {
    const host = async (name: string) => {
      const post = (path: string, body: object) => fetch(`${base}/v1/agent/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accountToken}` }, body: JSON.stringify(body) });
      const { code } = await (await post("code", { name })).json() as { code: string };
      assert.equal((await post("approve", { code })).status, 200);
      const { roomId, roomToken } = await (await fetch(`${base}/v1/agent/code/${code}/status`)).json() as { roomId: string; roomToken: string };
      const agent = new DeviceSock(`${ws}/v1/agent/ws`);
      sockets.push(agent);
      await agent.hello({ roomToken, info: { name, version: "test" } });
      return { agent, roomId, roomToken };
    };
    const home = await host("Home");
    const laptop = await host("Laptop");
    const old = new DeviceSock(`${ws}/v1/device/ws`);
    sockets.push(old);
    await old.hello({ accountToken });
    await old.send({ t: "pair.begin", roomId: home.roomId, scope: "read", name: "existing" });
    const grant = await old.expect("pair.granted") as unknown as { device: { id: string }; deviceSecret: string };
    old.close();
    const storage = new Map([["herdgate.token", accountToken], ["herdgate.device", grant.device.id], ["herdgate.deviceSecret", grant.deviceSecret]]);
    const source = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8").replace(/^import .* from "\/e2e.js";$/m, "");
    const browser = (realCrypto = false) => {
      const doc = new Element();
      const $ = (id: string) => doc.querySelector(id);
      runInNewContext(source, {
        document: Object.assign(doc, { getElementById: $, createElement: () => new Element() }), Element,
        navigator: { userAgent: "test" }, location: { origin: base },
        localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
        WebSocket: class extends WebSocket { constructor(url: string) { super(url); sockets.push(this); } },
        generateKeyPair: realCrypto ? generateKeyPair : async () => ({ jwk: {}, pub: new Uint8Array() }),
        DeviceChannel: realCrypto ? DeviceChannel : class { ready() { return false; } async begin() { return { e: "mock" }; } },
        fetch, btoa, atob, setTimeout, clearTimeout,
      });
      const row = (id: string) => $("room-list").children.find((node) => node.querySelector(".row").dataset.roomId === id);
      return { $, back: () => doc.fire("click", $("back")), row, open: (id: string) => row(id)!.querySelector(".rowbtn").fire("click") };
    };
    const roster = async (roomId: string) => ((await (await fetch(`${base}/v1/devices?room=${roomId}`, { headers: { authorization: `Bearer ${accountToken}` } })).json()) as { devices: { id: string; name: string; scope: string; connected: boolean; keys: number }[] }).devices;
    const ui = browser();
    await until(() => ui.$("room-name").textContent === "Home", "the legacy device should open Home");
    ui.back();
    ui.open(laptop.roomId);
    ui.$("pair-name").value = "home-tui";
    ui.$("pair-scope").value = "act";
    ui.$("pair-form").fire("submit");
    const ask = await laptop.agent.expect("pair.request", 1_500);
    assert.equal(ask.scope, "act");
    assert.deepEqual((await roster(home.roomId)).map(({ id, connected }) => ({ id, connected })), [{ id: grant.device.id, connected: true }]);
    assert.match(ui.$("pair-status").textContent, /Waiting for the host/);
    laptop.agent.close();
    await until(() => ui.$("pair-error").textContent.includes("host disconnected"), "host loss should end the pairing immediately, not after the approval timeout");
    assert.deepEqual(await roster(laptop.roomId), []);
    const rebound = new DeviceSock(`${ws}/v1/agent/ws`);
    sockets.push(rebound);
    await rebound.hello({ roomToken: laptop.roomToken, info: { name: "Laptop", version: "test" } });
    ui.$("pair-form").fire("submit");
    const denied = await rebound.expect("pair.request", 1_500);
    await rebound.send({ t: "pair.response", requestId: denied.requestId, ok: false });
    await until(() => ui.$("pair-error").textContent.includes("denied on the host"), "host denial must be displayed");
    assert.deepEqual(await roster(laptop.roomId), []);
    ui.$("pair-form").fire("submit");
    const retry = await rebound.expect("pair.request", 1_500);
    await rebound.send({ t: "pair.response", requestId: retry.requestId, ok: true });
    await until(() => ui.$("room-name").textContent === "Laptop", "Laptop should open after host approval");
    const view = ui.$("view");
    const ssh = view.find((node) => node.className === "ssh");
    const form = ssh?.find((node) => node.className === "pubkey-input");
    const devices = view.find((node) => node.className === "devices");
    assert.ok(ssh && form && devices, "SSH setup is available before the publisher sends a view");
    await until(() => ui.$("status").textContent === "online", "Laptop device socket should be attached");
    const paired = await roster(laptop.roomId);
    assert.deepEqual(paired.map(({ name, scope }) => ({ name, scope })), [{ name: "home-tui", scope: "act" }]);
    ssh.open = true;
    devices.open = true;
    form.value = "ssh-ed25519 pending key";
    for (const version of ["live-1", "live-2", "live-3"]) {
      await rebound.send({ t: "frame", device: paired[0].id, payload: { op: "view", view: { summary: { herdr: version } } } });
      await until(() => Boolean(view.find((node) => node.textContent === version)), "the live summary still updates");
      assert.equal(view.find((node) => node.className === "ssh"), ssh, "live frames must not replace the SSH controls");
      assert.equal(view.find((node) => node.className === "devices"), devices, "live frames must not replace the roster controls");
      assert.ok(ssh.open && devices.open);
      assert.equal(view.find((node) => node.className === "pubkey-input")?.value, "ssh-ed25519 pending key");
    }
    const { x } = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    const publicBlob = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.from(x!, "base64url")]);
    form.value = `ssh-ed25519 ${publicBlob.toString("base64")} test-mobile`;
    ssh.find((node) => node.textContent === "Add key")!.fire("click");
    await until(() => Boolean(ssh.find((node) => node.textContent.endsWith(" test-mobile"))), "Add key should work after live updates");
    const phone = new DeviceSock(`${ws}/v1/device/ws`);
    sockets.push(phone);
    await phone.hello({ accountToken });
    await phone.send({ t: "pair.begin", roomId: laptop.roomId, scope: "read", name: "phone-viewer" });
    const phoneGrant = await phone.expect("pair.granted") as unknown as { device: { id: string } };
    ssh.fire("toggle");
    const picker = ssh.find((node) => node.className === "ssh-user-select");
    assert.ok(picker, "SSH panel has a username picker");
    await until(() => picker.children.some((o) => o.value === phoneGrant.device.id), "new phone is listed");
    assert.ok(!picker.children.some((o) => o.value === grant.device.id), "Home pairing stays outside the Laptop picker");
    picker.value = phoneGrant.device.id;
    picker.fire("change");
    assert.ok(ssh.find((node) => node.textContent.includes(`${phoneGrant.device.id}@`)), "SSH command follows the selected username");
    form.value = `ssh-ed25519 ${publicBlob.toString("base64")} phone-viewer`;
    ssh.find((node) => node.textContent === "Add key")!.fire("click");
    await until(() => Boolean(ssh.find((node) => node.textContent.endsWith(" phone-viewer"))), "owner adds key to the selected account");
    const stored = await roster(laptop.roomId);
    assert.equal(stored.find((d) => d.id === phoneGrant.device.id)?.keys, 1);
    assert.equal(stored.find((d) => d.id === paired[0].id)?.keys, 1, "browser account key is unchanged");
    ui.back();
    assert.match(ui.row(home.roomId)!.querySelector(".meta").textContent, /paired · read/);
    assert.match(ui.row(laptop.roomId)!.querySelector(".meta").textContent, /paired · act/);
    ui.open(home.roomId);
    await until(() => ui.$("room-name").textContent === "Home" && ui.$("status").textContent === "online", "Home should reconnect with its original key");
    assert.deepEqual((await roster(home.roomId)).map(({ id }) => id), [grant.device.id]);
    const other = browser();
    await until(() => Boolean(other.row(home.roomId) && other.row(laptop.roomId)), "reload should remember both pairings");
    other.open(laptop.roomId);
    await until(() => other.$("room-name").textContent === "Laptop" && other.$("status").textContent === "online", "second tab can open Laptop");
    assert.equal((await roster(home.roomId))[0].connected, true);
    assert.equal((await roster(laptop.roomId))[0].connected, true);

    // Use the real Noise implementation in a fresh tab with an existing pin.
    const identity = await generateKeyPair();
    const pinKey = `herdgate.e2efp.${laptop.roomId}`;
    const pin = await fingerprint(identity.pub);
    storage.set(pinKey, pin);
    const secure = browser(true);
    await until(() => Boolean(secure.row(laptop.roomId)), "secure tab sees the room");
    secure.open(laptop.roomId);
    const readPayload = async (op: string) => {
      for (;;) {
        const frame = await rebound.expect("frame");
        const payload = frame.payload as { op: string; e: string; c: string; n?: number };
        if (payload.op === op && payload.e !== "mock") return payload;
      }
    };
    const initial = await readPayload("e2e.init");
    const spoofed = { op: "view", view: { summary: { herdr: "untrusted-view" } } };
    const sendToTab = (payload: object) => rebound.send({ t: "frame", device: paired[0].id, payload });
    await sendToTab(spoofed);
    const channel = new HostChannel(identity);
    await sendToTab({ op: "e2e.reply", ...await channel.acceptInit(initial) });
    await channel.acceptFinish(await readPayload("e2e.finish"));
    await sendToTab({ op: "e2e.ready" });
    assert.deepEqual(await channel.recv(await readPayload("e2e")), { op: "view" });
    await sendToTab(await channel.send({ op: "view", view: { summary: { herdr: "verified-view" } } }));
    await until(() => Boolean(secure.$("view").find(n => n.textContent === "verified-view")), "secure tab renders authenticated content");
    assert.equal(secure.$("view").find(n => n.textContent === "untrusted-view"), undefined);
    await sendToTab(spoofed);
    const replacement = new HostChannel(await generateKeyPair());
    await sendToTab({ op: "e2e.reply", ...await replacement.acceptInit(await readPayload("e2e.init")) });
    await until(() => /Host key changed/.test(secure.$("e2e-note").textContent), "a changed key must block the room");
    assert.equal(storage.get(pinKey), pin);
    assert.equal(secure.$("view").find(n => n.textContent === "untrusted-view" || n.textContent === "verified-view"), undefined);
  } finally {
    for (const socket of sockets) socket.close();
    await cloud.close();
  }
});
