// Web-push payload tier (RFC 8291 + RFC 8188 aes128gcm) and the SW decision table.
// The crypto is verified by DECRYPTING on the user-agent side with the UA private
// key — the same derivation a browser runs — which pins the wire format (salt ‖ rs
// ‖ idlen=65 ‖ asPublic ‖ GCM) far better than eyeballing ciphertext.

import assert from "node:assert/strict";
import test from "node:test";
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { encryptPayload, canPayload } from "../src/cloud/push.ts";
import { generateVapidKeys } from "../src/cloud/vapid.ts";

/** The user-agent side: derive CEK/nonce from the body and decrypt one record. */
function uaDecrypt(body, uaKeys) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idLen = body[20];
  assert.equal(idLen, 65, "keyid carries the 65-byte ephemeral public key");
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  assert.ok(ciphertext.length + 65 <= rs || ciphertext.length <= rs, "ciphertext fits the record size");

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaKeys.privateKey);
  const secret = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info"), uaKeys.publicKey, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, uaKeys.auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  const last = padded[padded.length - 1];
  assert.equal(last, 0x02, "record ends at the 0x02 delimiter (no padding)");
  return padded.subarray(0, padded.length - 1).toString("utf8");
}

function uaKeyPair() {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys(); // 65-byte uncompressed
  return { ecdh, publicKey, privateKey: ecdh.getPrivateKey(), auth: randomBytes(16) };
}

test("push payload: encrypt → UA decrypt round-trip", () => {
  const ua = uaKeyPair();
  const payload = JSON.stringify({ v: 1, kind: "settle", agent: "fleet-research", room: "r_abc123" });
  const body = encryptPayload(Buffer.from(payload, "utf8"), ua.publicKey.toString("base64url"), ua.auth.toString("base64url"));
  assert.equal(uaDecrypt(body, ua), payload);
});

test("push payload: deterministic with injected salt and ephemeral key", () => {
  const ua = uaKeyPair();
  const as = createECDH("prime256v1");
  as.generateKeys();
  const seams = {
    salt: Buffer.alloc(16, 0xab),
    asKeys: { privateKey: as.getPrivateKey(), publicKey: as.getPublicKey() },
  };
  const b64u = (b) => b.toString("base64url");
  const a = encryptPayload(Buffer.from("x"), b64u(ua.publicKey), b64u(ua.auth), seams);
  const b = encryptPayload(Buffer.from("x"), b64u(ua.publicKey), b64u(ua.auth), seams);
  assert.deepEqual(a, b, "same seams → byte-identical body");
  assert.equal(a.subarray(0, 16).toString("hex"), "ab".repeat(16), "salt leads the body");
});

test("push payload: rejects malformed subscriptions and oversize payloads", () => {
  const ua = uaKeyPair();
  const good = { p256dh: ua.publicKey.toString("base64url"), auth: ua.auth.toString("base64url") };
  assert.equal(canPayload(good), true);
  assert.equal(canPayload({ p256dh: good.p256dh, auth: randomBytes(15).toString("base64url") }), false);
  assert.equal(canPayload(undefined), false, "legacy subscriptions cannot take payloads");
  assert.throws(() => encryptPayload(Buffer.from("x"), ua.publicKey.toString("base64url"), randomBytes(15).toString("base64url")));
  assert.throws(() => encryptPayload(Buffer.from("x"), randomBytes(64).toString("base64url"), ua.auth.toString("base64url")));
  assert.throws(() => encryptPayload(Buffer.alloc(4000), good.p256dh, good.auth), /3000/);
});

test("push decision: legacy, clear, suppress, show (with urgency + room deep-link)", async () => {
  await import(new URL("../src/web/push-decision.js", import.meta.url).href);
  const decide = globalThis.hgDecidePush;
  assert.ok(decide, "the module assigns onto globalThis for both worker and Node");

  // Legacy silent ping: no payload → the old wake-or-notify path.
  assert.equal(decide(null, false).kind, "legacy");
  assert.equal(decide("junk", false).kind, "legacy");
  assert.equal(decide({ v: 2, kind: "settle", room: "r" }, false).kind, "legacy");

  // Retraction closes the slot even when a client is visible.
  assert.deepEqual(decide({ type: "clear", tag: "hg:r_1" }, true), { kind: "clear", tag: "hg:r_1" });

  // A visible client already surfaces the news in-app.
  assert.equal(decide({ v: 1, kind: "needs-you", room: "r_1" }, true).kind, "suppress");

  // Show: per-room tag coalesce, renotify, urgency only for needs-you/died.
  const show = decide({ v: 1, kind: "needs-you", agent: "worker-a", room: "r_1" }, false);
  assert.equal(show.kind, "show");
  assert.equal(show.tag, "hg:r_1");
  assert.equal(show.urgent, true);
  assert.match(show.title, /cần bạn/);
  const settle = decide({ v: 1, kind: "settle", agent: "worker-a", room: "r_1" }, false);
  assert.equal(settle.urgent, false);
  assert.match(settle.body, /worker-a/);
  const activity = decide({ v: 1, kind: "activity", room: "r_1" }, false);
  assert.equal(activity.agent, undefined);
  assert.doesNotMatch(activity.body, /undefined/);
});

test("vapid: gate keys still sign for the payload-bearing send path", async () => {
  // The VAPID header path is shared by silent and payload pushes; a quick
  // sign/verify here guards the refactor against key-handling regressions.
  const { vapidHeader, vapidVerify } = await import("../src/cloud/vapid.ts");
  const keys = generateVapidKeys();
  const h = vapidHeader("https://fcm.googleapis.com/fcm/send/x", keys, "mailto:t@herdgate.invalid");
  assert.equal(vapidVerify(h)?.sub, "mailto:t@herdgate.invalid");
});
