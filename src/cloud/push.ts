import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIPv4 } from "node:net";
import { createCipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { vapidHeader, type VapidKeys } from "./vapid.ts";

const providers = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);

export function pushEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      providers.has(url.hostname) ? url : null;
  } catch { return null; }
}

// Deliberately use IPv4 only for push: reject private, link-local, reserved and
// other non-global space. Connect to that exact checked address, not a second DNS lookup.
const nonPublic = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublic.addSubnet(address, bits);

export function publicPushAddress(address: string): boolean {
  return isIPv4(address) && !nonPublic.check(address, "ipv4");
}

export async function sendWake(endpoint: URL, keys: VapidKeys, sub: string): Promise<void> {
  return sendPush(endpoint, keys, sub, null, "normal");
}

/** The user-agent half of a web-push subscription (RFC 8291 §2): the P-256 public
 *  point the browser generated (65-byte uncompressed, base64url) and the 16-byte
 *  auth secret. Both arrive via /v1/device/push alongside the endpoint. */
export interface PushKeys {
  p256dh: string;
  auth: string;
}

export interface EncryptSeams {
  /** Fixed 16-byte salt and ephemeral keypair — test seams for deterministic vectors. */
  salt?: Buffer;
  asKeys?: { privateKey: Buffer; publicKey: Buffer };
}

/** Web-push payload encryption (RFC 8291) in the aes128gcm content coding (RFC 8188).
 *
 *  body = salt(16) ‖ rs(4, BE, 4096) ‖ idlen(1, 65) ‖ asPublic(65) ‖ AES-128-GCM(plaintext ‖ 0x02 ‖ pad)
 *
 *  The ephemeral server public key rides in the keyid field — that is how the agent
 *  derives the same IKM without any extra header (the aesgcm "dh=" header is dead).
 *  IKM  = HKDF(salt=auth, ecdh(asPriv, uaPublic), info="WebPush: info"‖ua‖as, 32)
 *  CEK  = HKDF(salt=rand, IKM, info="Content-Encoding: aes128gcm", 16)
 *  NONCE= HKDF(salt=rand, IKM, info="Content-Encoding: nonce", 12)
 *  Plaintext must fit one record: ≤ 4096 − 1 (delimiter) − 16 (GCM tag) − 65… the
 *  record size covers plaintext+delimiter+padding+tag, so payloads stay tiny by design. */
export function encryptPayload(
  plaintext: Buffer,
  uaPublicB64u: string,
  authB64u: string,
  seams: EncryptSeams = {},
): Buffer {
  const uaPublic = Buffer.from(uaPublicB64u, "base64url");
  const auth = Buffer.from(authB64u, "base64url");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh must be a 65-byte uncompressed point");
  if (auth.length !== 16) throw new Error("auth secret must be 16 bytes");
  if (plaintext.length === 0 || plaintext.length > 3000) throw new Error("payload must be 1..3000 bytes");

  const as = seams.asKeys ?? (() => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const d = privateKey.export({ format: "jwk" }) as { d: string };
    return {
      privateKey: Buffer.from(d.d, "base64url"),
      publicKey: Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]),
    };
  })();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(as.privateKey);
  const secret = ecdh.computeSecret(uaPublic);

  const salt = seams.salt ?? randomBytes(16);
  const info = Buffer.concat([Buffer.from("WebPush: info"), uaPublic, as.publicKey]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce"), 12));

  // One record: plaintext ‖ 0x02 delimiter ‖ zero padding, then GCM over the whole thing.
  const rs = 4096;
  const padded = Buffer.concat([plaintext, Buffer.from([0x02]), Buffer.alloc(0)]);
  if (padded.length + 16 > rs) throw new Error("payload does not fit one aes128gcm record");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const idLen = Buffer.from([as.publicKey.length]); // 65
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(rs);
  return Buffer.concat([salt, rsBuf, idLen, as.publicKey, ciphertext]);
}

/** True when a stored subscription can receive payloads (keys captured at subscribe time). */
export function canPayload(k: { p256dh?: string; auth?: string } | undefined): boolean {
  return typeof k?.p256dh === "string" && typeof k?.auth === "string" &&
    Buffer.from(k.p256dh, "base64url").length === 65 && Buffer.from(k.auth, "base64url").length === 16;
}

/** POST to the push service: a silent ping (no body) or an encrypted payload.
 *  `urgent` (needs-you / died) maps to Urgency: high so the platform budgets battery. */
export async function sendPush(
  endpoint: URL,
  keys: VapidKeys,
  sub: string,
  body: Buffer | null,
  urgency: "normal" | "high" = "normal",
): Promise<void> {
  const { hostname, pathname, search, href } = endpoint;
  // Keep the DNS lookup part of the in-flight quota even if it is slow.
  const signal = AbortSignal.timeout(5000);
  const { address } = await lookup(hostname, { family: 4 });
  signal.throwIfAborted();
  if (!publicPushAddress(address)) throw new Error("push endpoint resolved to a non-public address");
  await new Promise<void>((resolve, reject) => {
    const req = request({
      hostname: address, servername: hostname, path: pathname + search,
      method: "POST", agent: false, rejectUnauthorized: true, signal,
      headers: {
        Host: hostname, TTL: "60", Urgency: urgency,
        ...(body
          ? {
              "Content-Encoding": "aes128gcm",
              "Content-Type": "application/octet-stream",
              "Content-Length": String(body.length),
            }
          : { "content-length": "0" }),
        Authorization: vapidHeader(href, keys, sub),
      },
    }, (res) => {
      // No response body or redirect is needed for a wake notification.
      res.destroy();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error("push provider rejected wake"));
    });
    req.once("error", reject);
    req.end(body ?? undefined);
  });
}
