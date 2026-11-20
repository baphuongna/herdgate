/**
 * The SSH leg: phones reach the host's herdr-core through herdgate.
 *
 *   phone (Herdr app "add machine") ──SSH──▶ herdgate sshd ──agent WS──▶ host bridge ──spawn──▶ hc connect
 *
 * What this module owns:
 *   - the SSH listener (ssh2): authenticates a PAIRED DEVICE (username = device id,
 *     password = the device secret `pair.granted` issued once), never an account token;
 *   - one SSH exec session ⇒ one bridge channel: bytes from the phone go to the host as
 *     opaque `ssh.*` frames (the cloud never inspects them — the host's bridge decides
 *     what a `read` device may do);
 *   - its own per-IP auth-failure strikes, host key minted once and persisted 0600.
 *
 * What it deliberately does NOT do: no shell, no sftp, no port forwarding, no agent
 * forwarding. Only `exec` — the phone speaks the herdr-core API over stdin/stdout
 * (`ssh <host> hc connect`), and that channel is relayed byte by byte.
 */

import { createHash, createPublicKey, generateKeyPairSync as nodeKeyPair, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as tcpServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import ssh2Pkg from "ssh2";
import { type State } from "./stores.ts";
import { randomToken } from "./util.ts";

const { Server } = ssh2Pkg;
const utils = (ssh2Pkg as unknown as { utils?: { generateKeyPairSync?(type: string): { private: string; public: string } } }).utils;

const MAX_CHANNELS_PER_DEVICE = 3;
const AUTH_STRIKES = 5;
const AUTH_BLOCK_MS = 60_000;

/** The algos herdgate authorizes for device keys. */
const SSH_KEY_ALGOS = new Set(["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"]);

/** Fingerprint of an SSH public key blob, OpenSSH style (`SHA256:…`, no padding). */
export function sshKeyFingerprint(b64: string): string {
  return "SHA256:" + createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64").replace(/=+$/, "");
}

/** Parse a `authorized_keys`-style line → { algo, b64, comment } | null. */
export function parseAuthorizedKey(line: string): { algo: string; b64: string; comment?: string } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [algo, b64, ...rest] = parts;
  if (!SSH_KEY_ALGOS.has(algo) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let blob: Buffer;
  try {
    blob = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  // The blob must open with its own algo name (SSH wire format's first string).
  if (blob.length < 8 || blob.readUInt32BE(0) !== algo.length || blob.subarray(4, 4 + algo.length).toString() !== algo) return null;
  return { algo, b64, comment: rest.join(" ").slice(0, 200) || undefined };
}

/** SSH wire pubkey blob → a node KeyObject for verification; null when unparsable. */
function sshPubKeyToKeyObject(algo: string, data: Buffer): KeyObject | null {
  let off = 0;
  const rstr = (): Buffer | null => {
    if (off + 4 > data.length) return null;
    const len = data.readUInt32BE(off);
    off += 4;
    if (off + len > data.length) return null;
    const b = data.subarray(off, off + len);
    off += len;
    return b;
  };
  const mpintB64url = (b: Buffer): string => (b[0] === 0 ? b.subarray(1) : b).toString("base64url");
  try {
    if (algo === "ssh-ed25519") {
      rstr(); // the algo string, redundant with the wire-level algorithm name
      const raw = rstr();
      if (!raw || raw.length !== 32) return null;
      return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    }
    if (algo === "ssh-rsa") {
      rstr(); // the algo string
      const e = rstr();
      const n = rstr();
      if (!e || !n) return null;
      return createPublicKey({ key: { kty: "RSA", e: mpintB64url(e), n: mpintB64url(n) }, format: "jwk" });
    }
    const m = algo.match(/^ecdsa-sha2-nistp(256|384|521)$/);
    if (m) {
      rstr(); // the algo string
      rstr(); // the curve name, redundant with the algo
      const point = rstr();
      if (!point || point[0] !== 4) return null;
      const byteLen = { "256": 32, "384": 48, "521": 66 }[m[1] as "256" | "384" | "521"];
      if (point.length !== 1 + 2 * byteLen) return null;
      return createPublicKey({
        key: { kty: "EC", crv: `P-${m[1]}`, x: point.subarray(1, 1 + byteLen).toString("base64url"), y: point.subarray(1 + byteLen).toString("base64url") },
        format: "jwk",
      });
    }
  } catch {
    return null;
  }
  return null;
}

export interface SshConfig {
  port?: number;
  bind?: string;
  /** Where the host key lives; `dirname(statePath)` by default. Ephemeral if absent. */
  keyPath?: string;
  /** Deadline from transport accept through successful SSH user authentication. */
  authTimeoutMs?: number;
}

export interface SshDeps {
  config: SshConfig;
  state: State;
  log: (line: string) => void;
  /**
   * Gateway: deliver an opaque payload to the device's ROOM AGENT, addressed from the
   * device (that is the channel the host bridge reads). False when the host is offline.
   */
  sendAsDevice(deviceId: string, payload: Record<string, unknown>): boolean;
  /** Gateway: is that device's socket open right now? */
  deviceOnline(deviceId: string): boolean;
}

export interface SshHandle {
  port: number | null;
  bind: string | null;
  hostKeyFingerprint: string | null;
  /**
   * Feed a virtual (non-TCP) socket into the SSH server — how the bridge leg
   * (`/v1/bridge/ws`) delivers a phone's raw SSH bytes. Auth, strikes and the
   * read-only allowlist apply unchanged; `socket.remoteAddress` is the strike key.
   */
  inject(socket: Duplex & { remoteAddress?: string }): void;
  /** Disconnect a revoked device, or just sessions authenticated with a removed key. */
  revoke(deviceId: string, fingerprint?: string): void;
  close(): Promise<void>;
  /** Gateway calls this when a HOST sends an `ssh.*` frame to a device. */
  onHostFrame(deviceId: string, payload: Record<string, unknown>): boolean;
}

interface ChannelStream {
  write(chunk: Buffer): boolean;
  end(chunk?: Buffer): void;
  exit(code: number): void;
  stderr: { write(chunk: Buffer): boolean };
}

interface Channel {
  deviceId: string;
  ch: string;
  stream: ChannelStream | null;
  /** The phone keeps sending after we asked the host to stop; drop until CLOSE arrives. */
  closing: boolean;
}

export async function startSshd(deps: SshDeps): Promise<SshHandle | null> {
  // Enabled/disabled is the gateway's decision (`ssh` unset ⇒ no leg). Port 0 is a
  // legitimate ephemeral listener (tests), not "off".
  const port = deps.config.port ?? 2222;
  const bind = deps.config.bind ?? "127.0.0.1";

  const hostKey = loadOrMintHostKey(deps);
  const channels = new Map<string, Channel>(); // `${deviceId}:${ch}` → channel
  const strikes = new Map<string, { n: number; until: number }>();

  const ipOf = (ctx: { ip?: string }): string => ctx.ip ?? "?";
  const blocked = (ip: string): boolean => {
    const f = strikes.get(ip);
    return Boolean(f && f.until > Date.now());
  };
  const strike = (ip: string): void => {
    const f = strikes.get(ip) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= AUTH_STRIKES) {
      f.until = Date.now() + AUTH_BLOCK_MS;
      f.n = 0;
      deps.log(`ssh: ${ip} blocked for ${AUTH_BLOCK_MS / 1000}s after repeated failures`);
    }
    strikes.set(ip, f);
  };

  type Transport = Duplex & { remoteAddress?: string };
  interface Peer {
    socket: Transport;
    ip: string;
    deadline: NodeJS.Timeout | null;
    deviceId?: string;
    fingerprint?: string;
  }
  const peers = new Map<Transport, Peer>();
  const authTimeoutMs = deps.config.authTimeoutMs ?? 12_000;

  const channelKey = (deviceId: string, ch: string): string => `${deviceId}:${ch}`;
  const deviceChannels = (deviceId: string): Channel[] => [...channels.values()].filter((c) => c.deviceId === deviceId);

  /** To the HOST, addressed as the device (the bridge on the host consumes these). */
  const toHost = (deviceId: string, payload: Record<string, unknown>): boolean => deps.sendAsDevice(deviceId, payload);

  const server = new Server({ hostKeys: [hostKey.private] }, (client, info) => {
    // ssh2's server-side Client stores the socket supplied to injectSocket as
    // _sock (1.17). Do not authorize a connection if that transport is unknown.
    const socket = (client as unknown as { _sock?: Transport })._sock;
    const peer = socket && peers.get(socket);
    client.on("error", () => socket?.destroy());
    if (!peer) { client.end(); return; }
    const ip = info?.ip ?? "?";
    client.on("authentication", (ctx) => {
      if (blocked(ip)) return ctx.reject();
      // The initial `none` request discovers supported methods. An empty list
      // can make clients stop before offering a key. Keep the list independent
      // of whether this username is registered.
      const reject = () => ctx.reject(["publickey", "password"]);
      const id = ctx.username.trim();
      const rec = /^d_[A-Za-z0-9]+$/.test(id) ? deps.state.deviceById(id) : null;
      if (ctx.method === "publickey") {
        // Non-interactive clients (herdr-core's `machine add` shells out to system ssh,
        // which prefers keys and the agent) log in with a registered public key. ssh2
        // parses the request; verifying the signature (RFC 4252 §7, `ctx.blob` is the
        // exact signed bytes) is ours. A request WITHOUT a signature is the client
        // asking "would you take this key?" — accepting answers PK_OK (ssh2 does that).
        const pk = ctx as unknown as { key?: { algo: string; data: Buffer }; signature?: Buffer; blob?: Buffer; hashAlgo?: string };
        const key = pk.key;
        if (!rec || !key?.data) return reject();
        const entry = rec.sshKeys?.find((k) => k.algo === key.algo && Buffer.from(k.b64, "base64").equals(key.data));
        if (!entry) return reject(); // agent key not for us: no strike, just no
        if (!pk.signature) return ctx.accept();
        const keyObj = sshPubKeyToKeyObject(key.algo, key.data);
        if (!keyObj || !cryptoVerify(pk.hashAlgo ?? undefined, pk.blob ?? Buffer.alloc(0), keyObj, pk.signature)) {
          strike(ip);
          deps.log(`ssh: bad key signature for ${rec.id} from ${ip}`);
          return reject();
        }
        peer.deviceId = rec.id;
        peer.fingerprint = sshKeyFingerprint(entry.b64);
        deps.log(`ssh: device ${rec.id} (${rec.name}, ${rec.scope}) authenticated with key ${peer.fingerprint} from ${ip}`);
        return ctx.accept();
      }
      if (ctx.method !== "password") {
        // Per-device passwords (and registered public keys) are the only ways in.
        return reject();
      }
      const ok = rec ? deps.state.deviceByCredentials(id, ctx.password ?? "") : null;
      if (!ok) {
        strike(ip);
        deps.log(`ssh: auth failed for "${id.slice(0, 12)}" from ${ip}`);
        return reject();
      }
      peer.deviceId = ok.id;
      peer.fingerprint = undefined;
      deps.log(`ssh: device ${ok.id} (${ok.name}, ${ok.scope}) authenticated from ${ip}`);
      ctx.accept();
    });

    const owned = new Map<string, Channel>();
    const closeChannel = (channel: Channel) => {
      const { deviceId, ch } = channel;
      owned.delete(ch);
      if (!channels.delete(channelKey(deviceId, ch))) return;
      toHost(deviceId, { op: "ssh.close", ch });
    };

    client.on("ready", () => {
      if (peer.deadline) clearTimeout(peer.deadline);
      peer.deadline = null;
      client.on("session", (accept, reject) => {
        if (peer.socket.destroyed || !peer.deviceId || !deps.state.deviceById(peer.deviceId)) return reject();
        const session = accept();
        session.on("sftp", (acceptSftp, rejectSftp) => rejectSftp());
        session.on("shell", (acceptShell, rejectShell) => rejectShell());
        // Clients like herdr-core's `machine add` ask for a PTY while probing; the
        // real process runs on the host leg over pipes regardless, so accepting the
        // request (without allocating anything) is honest and keeps exec-only policy.
        session.on("pty", (accept) => accept());
        session.on("exec", (acceptExec, rejectExec, info) => {
          const dvc = peer.deviceId ? deps.state.deviceById(peer.deviceId) : null;
          if (peer.socket.destroyed || !dvc || (peer.fingerprint && !dvc.sshKeys?.some(k => sshKeyFingerprint(k.b64) === peer.fingerprint))) return rejectExec();
          if (blocked(ip)) return rejectExec();

          // No device-socket gate here: a phone on the SSH leg has no WebSocket open.
          // Reachability is the host agent's, and it fails honestly below (exit 111).
          const ch = randomToken(6).replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
          if (deviceChannels(dvc.id).length >= MAX_CHANNELS_PER_DEVICE) {
            deps.log(`ssh: ${dvc.id} hit the channel cap`);
            return rejectExec();
          }
          const stream = acceptExec();
          const channel: Channel = { deviceId: dvc.id, ch, stream, closing: false };
          channels.set(channelKey(dvc.id, ch), channel);
          owned.set(ch, channel);

          // Ask the host to run it. The command travels inside the opaque payload; the
          // host's bridge decides whether to run it and answers ssh.granted / ssh.denied.
          const opened = toHost(dvc.id, { op: "ssh.open", ch, cmd: String(info.command ?? "") });
          if (!opened) {
            closeChannel(channel);
            stream.exit(111);
            stream.end(Buffer.from("herdgate: the host is not connected\r\n"));
            return;
          }

          stream.on("data", (buf: Buffer) => {
            if (channel.closing) return;
            toHost(dvc.id, { op: "ssh.data", ch, b64: buf.toString("base64") });
          });
          stream.on("end", () => {
            // The client closed its stdin (an exec script is complete): tell the
            // host, so script channels can match and spawned processes see EOF.
            if (!channel.closing) toHost(dvc.id, { op: "ssh.eof", ch });
          });
          stream.on("close", () => closeChannel(channel));
          stream.stderr?.on?.("data", () => {
            /* stderr is merged by the phone side in exec mode; drop duplicates */
          });
        });
      });
    });

    client.on("close", () => {
      for (const c of owned.values()) closeChannel(c);
      if (peer.deviceId && deviceChannels(peer.deviceId).length === 0) deps.log(`ssh: device ${peer.deviceId} disconnected`);
    });
  });

  const inject = (socket: Transport): void => {
    const ip = socket.remoteAddress ?? "?";
    const pending = [...peers.values()].filter(p => p.deadline !== null);
    if (peers.size >= 128 || pending.length >= 32 || pending.filter(p => p.ip === ip).length >= 12) {
      socket.destroy();
      return;
    }
    const peer: Peer = { socket, ip, deadline: setTimeout(() => socket.destroy(), authTimeoutMs) };
    peer.deadline?.unref();
    peers.set(socket, peer);
    socket.once("close", () => {
      if (peer.deadline) clearTimeout(peer.deadline);
      peers.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    try { server.injectSocket(socket as Socket); }
    catch { socket.destroy(); }
  };
  const tcp = tcpServer(inject);
  await new Promise<void>((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(port, bind, () => resolve());
  });

  const addr = tcp.address();
  const realPort = typeof addr === "object" && addr ? addr.port : null;
  deps.log(`ssh: listening on ${bind}:${realPort} (devices auth with their device id + key)`);

  return {
    port: realPort,
    bind,
    hostKeyFingerprint: hostKey.fingerprint,
    inject,
    revoke(deviceId, fingerprint) {
      for (const peer of peers.values()) {
        if (peer.deviceId === deviceId && (fingerprint === undefined || peer.fingerprint === fingerprint)) {
          peer.socket.destroy();
        }
      }
    },
    /** The HOST's ssh.* frames come back through the agent leg; write them into the phone's stream. */
    onHostFrame(deviceId, payload) {
      const op = typeof payload.op === "string" ? payload.op : "";
      const ch = typeof payload.ch === "string" ? payload.ch : "";
      const channel = channels.get(channelKey(deviceId, ch));
      if (!channel) return false;

      if (op === "ssh.granted") return true;
      if (op === "ssh.denied") {
        // The host refused (scope, command, no hc): close the channel honestly.
        const reason = typeof payload.reason === "string" ? payload.reason : "refused by the host";
        channel.closing = true;
        channel.stream?.write(Buffer.from(`herdgate: ${reason}\r\n`));
        channel.stream?.exit(111);
        channel.stream?.end();
        channels.delete(channelKey(deviceId, ch));
        return true;
      }
      if (op === "ssh.data") {
        const b64 = typeof payload.b64 === "string" ? payload.b64 : "";
        if (b64.length > 400_000) return true; // over the frame budget
        const buf = Buffer.from(b64, "base64");
        try {
          if (payload.stderr === true) channel.stream?.stderr.write(buf);
          else channel.stream?.write(buf);
        } catch {
          /* the phone vanished mid-write; close carries it */
        }
        return true;
      }
      if (op === "ssh.closed") {
        channel.closing = true;
        const code = typeof payload.code === "number" ? payload.code : 0;
        const reason = typeof payload.reason === "string" ? payload.reason : undefined;
        if (reason) channel.stream?.write(Buffer.from(`herdgate: ${reason}\r\n`));
        channel.stream?.exit(code);
        channel.stream?.end();
        channels.delete(channelKey(deviceId, ch));
      }
      return true;
    },
    async close() {
      for (const peer of peers.values()) peer.socket.destroy();
      await new Promise<void>((done) => tcp.close(() => done()));
    },
  } satisfies SshHandle;
}

/** Mint once, keep at mode 0600; ephemeral (per-boot) when no key path is configured. */
function loadOrMintHostKey(deps: SshDeps): { private: string; public: string; fingerprint: string } {
  const path = deps.config.keyPath;
  if (path) {
    try {
      const f = JSON.parse(readFileSync(path, "utf8")) as { private: string; public: string };
      if (typeof f.private !== "string" || !f.private || typeof f.public !== "string" || !f.public) throw new Error("invalid key");
      return { private: f.private, public: f.public, fingerprint: fingerprintOf(f.public) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("cannot load existing SSH host key; restore it from backup");
    }
  }
  // ssh2.utils generates the OpenSSH format directly; the node-crypto path is the fallback.
  const key =
    utils?.generateKeyPairSync
      ? (() => {
          const k = utils.generateKeyPairSync("ed25519");
          return { private: k.private, public: k.public };
        })()
      : (() => {
          const { publicKey, privateKey } = nodeKeyPair("ed25519");
          return {
            private: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            public: publicKey.export({ type: "spki", format: "pem" }).toString(),
          };
        })();
  const fingerprint = fingerprintOf(key.public);
  if (path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ ...key, fingerprint }), { mode: 0o600, flag: "wx" });
    deps.log(`ssh: host key minted at ${path} (${fingerprint})`);
  } else {
    deps.log(`ssh: ephemeral host key (${fingerprint}) — set HERDGATE_SSH_KEY to keep it`);
  }
  return { ...key, fingerprint };
}

/** SHA256 fingerprint in the same `SHA256:…` shape OpenSSH prints. */
function fingerprintOf(publicKeyText: string): string {
  const base64 = publicKeyText.replace(/^.*?\n/, "").replace(/\n.*$/, "").replace(/\s+/g, "");
  const digest = createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}
