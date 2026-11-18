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

import { createHash, generateKeyPairSync as nodeKeyPair } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import ssh2Pkg from "ssh2";
import { type DeviceRecord, type State } from "./stores.ts";
import { randomToken } from "./util.ts";

const { Server } = ssh2Pkg;
const utils = (ssh2Pkg as unknown as { utils?: { generateKeyPairSync?(type: string): { private: string; public: string } } }).utils;

const MAX_CHANNELS_PER_DEVICE = 3;
const AUTH_STRIKES = 5;
const AUTH_BLOCK_MS = 60_000;

export interface SshConfig {
  port?: number;
  bind?: string;
  /** Where the host key lives; `dirname(statePath)` by default. Ephemeral if absent. */
  keyPath?: string;
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
  close(): Promise<void>;
  /** Gateway calls this when a HOST sends an `ssh.*` frame to a device. */
  onHostFrame(deviceId: string, payload: Record<string, unknown>): void;
}

interface ChannelStream {
  write(chunk: Buffer): boolean;
  end(chunk?: Buffer): void;
  exit(code: number): void;
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

  const channelKey = (deviceId: string, ch: string): string => `${deviceId}:${ch}`;
  const deviceChannels = (deviceId: string): Channel[] => [...channels.values()].filter((c) => c.deviceId === deviceId);

  /** To the HOST, addressed as the device (the bridge on the host consumes these). */
  const toHost = (deviceId: string, payload: Record<string, unknown>): boolean => deps.sendAsDevice(deviceId, payload);

  const server = new Server({ hostKeys: [hostKey.private] }, (client, info) => {
    const ip = info?.ip ?? "?";
    let device: DeviceRecord | null = null;

    client.on("error", () => {
      /* the socket layer reports the close itself */
    });

    let dev: DeviceRecord | null = null; // narrowed alias for the closures below
    client.on("authentication", (ctx) => {
      if (blocked(ip)) return ctx.reject();
      if (ctx.method !== "password") {
        // Only per-device passwords in v0: the phone's "add machine" flow always has a
        // password field, and a device secret is exactly that.
        return ctx.reject();
      }
      const id = ctx.username.trim();
      const rec = /^d_[A-Za-z0-9]+$/.test(id) ? deps.state.deviceByCredentials(id, ctx.password ?? "") : null;
      if (!rec) {
        strike(ip);
        deps.log(`ssh: auth failed for "${id.slice(0, 12)}" from ${ip}`);
        return ctx.reject();
      }
      device = rec;
      dev = rec;
      deps.log(`ssh: device ${rec.id} (${rec.name}, ${rec.scope}) authenticated from ${ip}`);
      ctx.accept();
    });

    client.on("ready", () => {
      client.on("session", (accept, reject) => {
        const session = accept();
        session.on("sftp", (acceptSftp, rejectSftp) => rejectSftp());
        session.on("shell", (acceptShell, rejectShell) => rejectShell());
        session.on("exec", (acceptExec, rejectExec, info) => {
          const dvc = dev;
          if (!dvc) return rejectExec();
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

          // Ask the host to run it. The command travels inside the opaque payload; the
          // host's bridge decides whether to run it and answers ssh.granted / ssh.denied.
          const opened = toHost(dvc.id, { op: "ssh.open", ch, cmd: String(info.command ?? "") });
          if (!opened) {
            channels.delete(channelKey(dvc.id, ch));
            stream.exit(111);
            stream.end(Buffer.from("herdgate: the host is not connected\r\n"));
            return;
          }

          stream.on("data", (buf: Buffer) => {
            if (channel.closing) return;
            toHost(dvc.id, { op: "ssh.data", ch, b64: buf.toString("base64") });
          });
          stream.on("close", () => {
            channels.delete(channelKey(dvc.id, ch));
            toHost(dvc.id, { op: "ssh.close", ch });
          });
          stream.stderr?.on?.("data", () => {
            /* stderr is merged by the phone side in exec mode; drop duplicates */
          });
        });
      });
    });

    client.on("close", () => {
      const dvc = dev;
      if (dvc) {
        for (const c of deviceChannels(dvc.id)) {
          channels.delete(channelKey(c.deviceId, c.ch));
          toHost(dvc.id, { op: "ssh.close", ch: c.ch });
        }
        if (deviceChannels(dvc.id).length === 0) deps.log(`ssh: device ${dvc.id} disconnected`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => resolve());
  });

  const addr = server.address();
  const realPort = typeof addr === "object" && addr ? addr.port : null;
  deps.log(`ssh: listening on ${bind}:${realPort} (devices auth with their device id + key)`);

  return {
    port: realPort,
    bind,
    hostKeyFingerprint: hostKey.fingerprint,
    /** The HOST's ssh.* frames come back through the agent leg; write them into the phone's stream. */
    onHostFrame(deviceId, payload) {
      const op = typeof payload.op === "string" ? payload.op : "";
      const ch = typeof payload.ch === "string" ? payload.ch : "";
      const channel = channels.get(channelKey(deviceId, ch));
      if (!channel) return;

      if (op === "ssh.granted") {
        channel.closing = false;
        return;
      }
      if (op === "ssh.denied") {
        // The host refused (scope, command, no hc): close the channel honestly.
        const reason = typeof payload.reason === "string" ? payload.reason : "refused by the host";
        channel.closing = true;
        channel.stream?.write(Buffer.from(`herdgate: ${reason}\r\n`));
        channel.stream?.exit(111);
        channel.stream?.end();
        channels.delete(channelKey(deviceId, ch));
        return;
      }
      if (op === "ssh.data") {
        const b64 = typeof payload.b64 === "string" ? payload.b64 : "";
        if (b64.length > 400_000) return; // over the frame budget; the rate limiter catches floods
        const buf = Buffer.from(b64, "base64");
        try {
          channel.stream?.write(buf);
        } catch {
          /* the phone vanished mid-write; close carries it */
        }
        return;
      }
      if (op === "ssh.closed") {
        channel.closing = true;
        const code = typeof payload.code === "number" ? payload.code : 0;
        const reason = typeof payload.reason === "string" ? payload.reason : undefined;
        if (reason) channel.stream?.write(Buffer.from(`herdgate: ${reason}\r\n`));
        channel.stream?.exit(code);
        channel.stream?.end();
        channels.delete(channelKey(deviceId, ch));
        return;
      }
    },
    async close() {
      for (const c of channels.values()) {
        c.stream?.end();
      }
      channels.clear();
      await new Promise<void>((done) => server.close(() => done()));
    },
  } satisfies SshHandle;
}

/** Mint once, keep at mode 0600; ephemeral (per-boot) when no key path is configured. */
function loadOrMintHostKey(deps: SshDeps): { private: string; public: string; fingerprint: string } {
  const path = deps.config.keyPath;
  if (path && existsSync(path)) {
    try {
      const f = JSON.parse(readFileSync(path, "utf8")) as { private: string; public: string; fingerprint: string };
      if (f.private && f.public) return f;
    } catch {
      /* fall through and re-mint */
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...key, fingerprint }), { mode: 0o600 });
    chmodSync(path, 0o600);
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
