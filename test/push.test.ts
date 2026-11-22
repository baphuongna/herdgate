import assert from "node:assert/strict";
import test from "node:test";
import { startCloud } from "../src/cloud/gateway.ts";
import { pushEndpoint, publicPushAddress } from "../src/cloud/push.ts";
import { generateVapidKeys, vapidHeader, vapidVerify } from "../src/cloud/vapid.ts";
import { randomBytes } from "node:crypto";
import { DeviceSock } from "./util2.ts";

const token = "push-fixture-owner";
const provider = "https://fcm.googleapis.com/fcm/send/fixture";
const blocked = [
  "http://fcm.googleapis.com/push", "https://127.0.0.1/push", "https://[::1]/push",
  "https://fcm.googleapis.com.example.invalid/push", "https://fcm.googleapis.com:444/push",
  "https://user@fcm.googleapis.com/push", "https://fcm.googleapis.com/push#fragment",
];

test("push: only supported HTTPS services and public IPv4 destinations are allowed", () => {
  for (const endpoint of blocked) assert.equal(pushEndpoint(endpoint), null);
  for (const address of ["127.0.0.1", "10.1.1.1", "169.254.1.1", "100.64.1.1", "172.16.0.2", "192.168.1.2", "224.0.0.1", "::1"]) {
    assert.equal(publicPushAddress(address), false, address);
  }
  assert.equal(publicPushAddress("8.8.8.8"), true);
  const endpoint = pushEndpoint(provider);
  assert.equal(endpoint?.href, provider);
  const keys = generateVapidKeys();
  const contact = "mailto:test@herdgate.invalid";
  const claims = vapidVerify(vapidHeader(endpoint!.href, keys, contact));
  assert.equal(claims?.aud, endpoint!.origin);
  assert.equal(claims?.sub, contact);
});

test("push: an opted-in Gate only stores supported subscriptions, even for a paired device", async () => {
  const keys = generateVapidKeys();
  const cloud = await startCloud({ accounts: [{ id: "a", name: "owner", token }], push: { keys, sub: "mailto:test@herdgate.invalid" } });
  const base = `http://127.0.0.1:${cloud.port}`;
  const d = new DeviceSock(`ws://127.0.0.1:${cloud.port}/v1/device/ws`);
  try {
    const post = (route: string, body: object) => fetch(base + route, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const { code } = await (await post("/v1/agent/code", { name: "test" })).json() as { code: string };
    const { roomId } = await (await post("/v1/agent/approve", { code })).json() as { roomId: string };
    assert.equal((await d.hello({ accountToken: token })).t, "hello");
    await d.send({ t: "pair.begin", roomId, scope: "read", name: "phone" });
    const grant = await d.expect("pair.granted") as unknown as { device: { id: string }; deviceSecret: string };
    const device = grant.device.id;
    const subscribe = (endpoint: string, deviceSecret = grant.deviceSecret, method = "POST") => fetch(base + "/v1/device/push", {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify({ device, deviceSecret, endpoint }),
    });
    assert.deepEqual(await (await fetch(base + "/v1/push/key")).json(), { publicKey: keys.publicBase64Url });
    assert.equal((await subscribe(provider, "wrong")).status, 401);
    for (const endpoint of blocked) assert.equal((await subscribe(endpoint)).status, 400);
    assert.equal((await subscribe(provider)).status, 200);
    assert.equal((await subscribe(provider, grant.deviceSecret, "PUT")).status, 405);
    assert.equal((await subscribe("", grant.deviceSecret, "DELETE")).status, 200);
    // No test sends traffic to a real push provider.
  } finally {
    d.close();
    await cloud.close();
  }
});

test("push: subscriptions may carry RFC 8291 keys for encrypted payloads", async () => {
  const keys = generateVapidKeys();
  const cloud = await startCloud({ accounts: [{ id: "a", name: "owner", token }], push: { keys, sub: "mailto:test@herdgate.invalid" } });
  const base = `http://127.0.0.1:${cloud.port}`;
  const d = new DeviceSock(`ws://127.0.0.1:${cloud.port}/v1/device/ws`);
  try {
    const post = (route: string, body: object) => fetch(base + route, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const { code } = await (await post("/v1/agent/code", { name: "test" })).json() as { code: string };
    const { roomId } = await (await post("/v1/agent/approve", { code })).json() as { roomId: string };
    assert.equal((await d.hello({ accountToken: token })).t, "hello");
    await d.send({ t: "pair.begin", roomId, scope: "read", name: "phone" });
    const grant = await d.expect("pair.granted") as unknown as { device: { id: string }, deviceSecret: string };
    const device = grant.device.id;

    const ua = (await import("node:crypto")).createECDH("prime256v1");
    const p256dh = ua.generateKeys().toString("base64url");
    const auth = randomBytes(16).toString("base64url");
    const subscribe = (extra: object) => fetch(base + "/v1/device/push", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device, deviceSecret: grant.deviceSecret, endpoint: provider, ...extra }),
    });

    // Malformed key material is refused — the gate must not store a dead payload path.
    assert.equal((await subscribe({ p256dh: "AAAA", auth })).status, 400);
    assert.equal((await subscribe({ p256dh, auth: "AAAA" })).status, 400);
    // A good pair is stored and echoed back through the owner's roster.
    assert.equal((await subscribe({ p256dh, auth })).status, 200);
    const roster = await (await fetch(base + `/v1/devices?room=${roomId}`, { headers: { authorization: `Bearer ${token}` } })).json() as { devices: { id: string; push: boolean; payload: boolean }[] };
    const stored = roster.devices.find((x) => x.id === device);
    assert.equal(stored?.push, true);
    assert.equal(stored?.payload, true, "the roster reports a payload-capable subscription without leaking material");
    // Endpoint-only (legacy) subscriptions still register fine — and drop the payload path.
    assert.equal((await subscribe({})).status, 200);
    const roster2 = await (await fetch(base + `/v1/devices?room=${roomId}`, { headers: { authorization: `Bearer ${token}` } })).json() as { devices: { id: string; payload: boolean }[] };
    assert.equal(roster2.devices.find((x) => x.id === device)?.payload, false, "resubscribe without keys drops the payload path");
  } finally {
    d.close();
    await cloud.close();
  }
});
