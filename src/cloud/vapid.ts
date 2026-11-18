/**
 * Minimal VAPID (RFC 8292) for silent wake pushes: sign a JWT with an ES256 key and
 * build the `Authorization: vapid t=…, k=…` header. No payload is ever sent — the
 * push exists to wake the phone's service worker, so this is all the protocol we need.
 *
 * Keys are generated once and persisted by the caller (main.ts) so the public key the
 * browsers subscribed to never changes behind their backs.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

export interface VapidKeys {
  /** JWK private key (P-256, d + x + y). Persist this. */
  privateJwk: JsonWebKey;
  /** Raw public point (65 bytes), base64url — what browsers subscribe against. */
  publicBase64Url: string;
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateJwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  const raw = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  // 0x04 ‖ X ‖ Y — the uncompressed point browsers use as applicationServerKey.
  const point = Buffer.concat([Buffer.from([0x04]), b64uDecode(raw.x), b64uDecode(raw.y)]);
  return { privateJwk, publicBase64Url: b64uEncode(point) };
}

export function loadVapidKeys(privateJwk: JsonWebKey): VapidKeys {
  const pub = createPublicKey({ key: privateJwk, format: "jwk" });
  const jwk = pub.export({ format: "jwk" }) as { x: string; y: string };
  const point = Buffer.concat([Buffer.from([0x04]), b64uDecode(jwk.x), b64uDecode(jwk.y)]);
  return { privateJwk, publicBase64Url: b64uEncode(point) };
}

const b64uEncode = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");
const b64uDecode = (s: string): Buffer => Buffer.from(s, "base64url");

/** ES256 signature in the JOSE raw r‖s form (not DER). */
function es256Sign(data: Buffer, privateJwk: JsonWebKey): Buffer {
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  const der = sign("sha256", data, key);
  // DER: 0x30 len 0x02 rlen r 0x02 slen s → strip to 32-byte r + 32-byte s.
  let o = 2;
  const rLen = der[o + 1];
  const r = der.subarray(o + 2, o + 2 + rLen);
  o += 2 + rLen;
  const sLen = der[o + 1];
  const s = der.subarray(o + 2, o + 2 + sLen);
  // DER may carry a leading 0x00 (positive marker): keep the low 32 bytes, left-pad.
  const pad = (b: Buffer): Buffer => {
    const x = b.length > 32 ? b.subarray(b.length - 32) : b;
    return Buffer.concat([Buffer.alloc(32 - x.length), x]);
  };
  return Buffer.concat([pad(r), pad(s)]);
}

/**
 * The Authorization header value for a wake push to `endpoint`.
 * `sub` is a contact mailto (required by the spec); `exp` is hours-limited.
 */
export function vapidHeader(endpoint: string, keys: VapidKeys, sub: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const header = b64uEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub })));
  const sig = es256Sign(Buffer.from(`${header}.${claims}`), keys.privateJwk);
  return `vapid t=${header}.${claims}.${b64uEncode(sig)}, k=${keys.publicBase64Url}`;
}

/** For tests: verify a vapid header against its own k (returns the claims or null). */
export function vapidVerify(header: string): Record<string, unknown> | null {
  const m = header.match(/^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const [h, c, sig] = m[1].split(".");
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64uDecode(m[2]).subarray(1, 33).toString("base64url"), y: b64uDecode(m[2]).subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
  const ok = (() => {
    try {
      // Node's verify needs DER; rebuild it from the raw r‖s.
      const raw = b64uDecode(sig);
      const r = raw.subarray(0, 32);
      const s = raw.subarray(32, 64);
      const tlv = (tag: number, b: Buffer): Buffer => Buffer.concat([Buffer.from([tag, b.length]), b]);
      const der = tlv(0x30, Buffer.concat([tlv(0x02, r), tlv(0x02, s)]));
      return verify("sha256", Buffer.from(`${h}.${c}`), key, der);
    } catch {
      return false;
    }
  })();
  if (!ok) return null;
  return JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Hash an endpoint for logging without leaking it. */
export const endpointTag = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
