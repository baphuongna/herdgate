/**
 * herdgate E2E payloads — Noise_XX over the opaque payload channel.
 *
 * The PWA copy of `plugin/server/e2e.mjs` (verbatim; a test asserts the two never
 * drift). Everything
 * runs on WebCrypto (`globalThis.crypto.subtle` — Node ≥ 20 exposes the same
 * object globally), so the plugin and the browser execute identical logic.
 *
 * Scheme: Noise_XX with P-256 ECDH, SHA-256 and AES-256-GCM
 * (Noise_XX_P256_AESGCM_SHA256). The device initiates after pairing; the host
 * answers with its long-lived static key (TOFU — the device learns its
 * fingerprint from the decrypted handshake and compares it on every later
 * session). After handshake, payloads travel as `{op:"e2e", n:<u64>, c:<b64>}`;
 * the cloud keeps routing them blind.
 *
 * The cloud never sees any of this: the handshake and all ciphertext travel
 * inside `frame.payload`, which the gateway does not parse (DESIGN.md §3).
 */

/** The Noise protocol name; its hash seeds the chaining state (spec §5.1). */
export const NOISE_NAME = "Noise_XX_P256_AESGCM_SHA256";
export const KEY_LEN = 32;
export const PUB_LEN = 65; // uncompressed P-256 point: 0x04 ‖ X ‖ Y

// ---- byte helpers (kept dependency-free; typed arrays only) ----------------

export function b64e(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64d(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
export const utf8e = (s) => new TextEncoder().encode(s);
export const utf8d = (u8) => new TextDecoder().decode(u8);
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Short human-checkable fingerprint of a static public key (8 bytes, url-safe). */
export function fingerprint(pub) {
  return b64e(pub.slice(0, 8)).replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 12);
}

// ---- WebCrypto plumbing ----------------------------------------------------

const subtle = globalThis.crypto.subtle;

async function sha256(data) {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}
async function hmac(keyBytes, data) {
  const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", key, data));
}
/** Noise's HKDF: two outputs (ck', k) from a chaining key and input key material. */
async function hkdf2(chainingKey, ikm) {
  const temp = await hmac(chainingKey, ikm);
  const o1 = await hmac(temp, new Uint8Array([0x01]));
  const o2 = await hmac(temp, concat(o1, new Uint8Array([0x02])));
  return [o1, o2];
}

/** ECDH over P-256; returns the 32-byte shared secret (the X coordinate). */
async function dh(privJwk, peerPubRaw) {
  const priv = await subtle.importKey("jwk", privJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await subtle.importKey("raw", peerPubRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
}

export async function generateKeyPair() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { jwk, pub };
}

// ---- CipherState (Noise spec §5.2) ------------------------------------------

class CipherState {
  k = null;
  n = 0;
  setKey(k) {
    this.k = k;
  }
  nonce() {
    // 96-bit: 4 zero bytes ‖ BE64(n) — n stays below 2^32 for our lifetimes.
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(8, this.n);
    return iv;
  }
  async encrypt(ad, plaintext) {
    if (this.n >= 0xffffffff) throw new Error("e2e: nonce exhausted");
    const key = await subtle.importKey("raw", this.k, "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(
      await subtle.encrypt({ name: "AES-GCM", iv: this.nonce(), additionalData: ad, tagLength: 128 }, key, plaintext),
    );
    this.n += 1;
    return ct;
  }
  async decrypt(ad, ciphertext) {
    const key = await subtle.importKey("raw", this.k, "AES-GCM", false, ["decrypt"]);
    const pt = new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: this.nonce(), additionalData: ad, tagLength: 128 }, key, ciphertext),
    );
    this.n += 1;
    return pt;
  }
}

// ---- the handshake ----------------------------------------------------------
//
//   device →  e_dev                       (msg1: 65 B raw)
//   host   →  e_host ‖ ENC0(s_host)       (msg2: ENC0 = plaintext when k unset)
//   device →  ENC0(s_dev)                 (msg3)
//
// tokens:  -> e        <- e, ee, s, es        -> s, se
//   ee = DH(e_dev, e_host)   es = DH(e_dev, s_host)   se = DH(e_host, s_dev)
//
// then Split() gives one CipherState per direction; every transport message is
// AES-GCM under it with the final handshake hash as associated data.

class Handshake {
  h = null;
  ck = null;
  cs = new CipherState();
  async reset() {
    const nameBytes = utf8e(NOISE_NAME);
    this.h = nameBytes.length === KEY_LEN ? nameBytes : await sha256(nameBytes);
    this.ck = this.h;
    this.cs = new CipherState();
  }
  async mixHash(data) {
    this.h = await sha256(concat(this.h, data));
  }
  async mixKey(ikm) {
    const [ck, k] = await hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cs = new CipherState();
    this.cs.setKey(k);
  }
  /** The `s` token: transport under the current key, else in the clear (ENC0). */
  async writeTokenStatic(pubRaw) {
    const out = this.cs.k ? await this.cs.encrypt(this.h, pubRaw) : pubRaw;
    await this.mixHash(out);
    return out;
  }
  async readTokenStatic(bytes) {
    const pt = this.cs.k ? await this.cs.decrypt(this.h, bytes) : bytes;
    await this.mixHash(bytes);
    return pt;
  }
  async split() {
    const [k1, k2] = await hkdf2(this.ck, new Uint8Array(0));
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.setKey(k1);
    c2.setKey(k2);
    return [c1, c2];
  }
}

/** The device side (initiator). `self` is {jwk, pub} from generateKeyPair(). */
export class DeviceChannel {
  #hs = new Handshake();
  #self = null;
  #e = null;
  sendCs = null;
  recvCs = null;
  hostFingerprint = null;
  constructor(self) {
    this.#self = self;
  }
  /** msg1 payload for `{op:"e2e.init", e}`. */
  async begin() {
    await this.#hs.reset();
    this.#e = await generateKeyPair();
    await this.#hs.mixHash(this.#e.pub);
    return { e: b64e(this.#e.pub) };
  }
  /** Feed the host's `{op:"e2e.reply", e, c}`; returns the msg3 payload. */
  async acceptReply(msg) {
    const eHost = b64d(msg.e);
    if (eHost.length !== PUB_LEN) throw new Error("e2e: bad host ephemeral");
    await this.#hs.mixHash(eHost);
    await this.#hs.mixKey(await dh(this.#e.jwk, eHost)); // ee
    const sHost = await this.#hs.readTokenStatic(b64d(msg.c)); // s
    if (sHost.length !== PUB_LEN) throw new Error("e2e: bad host static");
    this.hostFingerprint = fingerprint(sHost);
    await this.#hs.mixKey(await dh(this.#e.jwk, sHost)); // es (e_dev × s_host)
    const c = await this.#hs.writeTokenStatic(this.#self.pub); // s_dev
    await this.#hs.mixKey(await dh(this.#self.jwk, eHost)); // se (e_host × s_dev)
    const [c1, c2] = await this.#hs.split();
    this.sendCs = c1; // device → host
    this.recvCs = c2; // host → device
    this.#e = null;
    return { c: b64e(c) };
  }
  ready() {
    return Boolean(this.sendCs && this.recvCs);
  }
  async send(obj) {
    const ct = await this.sendCs.encrypt(this.#hs.h, utf8e(JSON.stringify(obj)));
    return { op: "e2e", n: this.sendCs.n - 1, c: b64e(ct) };
  }
  async recv(msg) {
    const pt = await this.recvCs.decrypt(this.#hs.h, b64d(msg.c));
    return JSON.parse(utf8d(pt));
  }
}

/** The host side (responder): one instance per device. */
export class HostChannel {
  #hs = new Handshake();
  #self = null;
  #e = null;
  sendCs = null;
  recvCs = null;
  deviceFingerprint = null;
  constructor(self) {
    this.#self = self;
  }
  /** Feed the device's `{op:"e2e.init", e}`; returns the msg2 payload. */
  async acceptInit(msg) {
    await this.#hs.reset();
    const eDev = b64d(msg.e);
    if (eDev.length !== PUB_LEN) throw new Error("e2e: bad device ephemeral");
    await this.#hs.mixHash(eDev);
    this.#e = await generateKeyPair();
    await this.#hs.mixHash(this.#e.pub);
    await this.#hs.mixKey(await dh(this.#e.jwk, eDev)); // ee (e_dev × e_host)
    const c = await this.#hs.writeTokenStatic(this.#self.pub); // s_host
    await this.#hs.mixKey(await dh(this.#self.jwk, eDev)); // es (e_dev × s_host)
    return { e: b64e(this.#e.pub), c: b64e(c) };
  }
  /** Feed the device's `{op:"e2e.finish", c}`; the channel is ready afterwards. */
  async acceptFinish(msg) {
    const sDev = await this.#hs.readTokenStatic(b64d(msg.c)); // s_dev
    if (sDev.length !== PUB_LEN) throw new Error("e2e: bad device static");
    this.deviceFingerprint = fingerprint(sDev);
    await this.#hs.mixKey(await dh(this.#e.jwk, sDev)); // se (e_host × s_dev)
    const [c1, c2] = await this.#hs.split();
    this.recvCs = c1; // device → host (c1 encrypts initiator→responder)
    this.sendCs = c2; // host → device
    this.#e = null;
  }
  ready() {
    return Boolean(this.sendCs && this.recvCs);
  }
  async send(obj) {
    const ct = await this.sendCs.encrypt(this.#hs.h, utf8e(JSON.stringify(obj)));
    return { op: "e2e", n: this.sendCs.n - 1, c: b64e(ct) };
  }
  async recv(msg) {
    const pt = await this.recvCs.decrypt(this.#hs.h, b64d(msg.c));
    return JSON.parse(utf8d(pt));
  }
}
