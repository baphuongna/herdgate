/**
 * Cloud state: accounts (config-provided), rooms (one host) and devices.
 * Persisted to one JSON file with an atomic tmp+rename write; room tokens are
 * stored **hashed** (sha256), the plaintext exists only at mint time.
 *
 * v0 is a single JSON file — the interfaces are shaped so a Postgres/Redis
 * implementation can replace it without touching the gateway.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Scope } from "../protocol/envelope.ts";
import { randomId, randomToken, sameSecret, sha256Hex } from "./util.ts";

export interface Account {
  id: string;
  name: string;
  /** Config-provided; the only plaintext secret the cloud holds. */
  token: string;
}

export interface RoomRecord {
  id: string;
  accountId: string;
  name: string;
  tokenHash: string;
  created: string;
}

export interface DeviceRecord {
  id: string;
  roomId: string;
  accountId: string;
  name: string;
  scope: Scope;
  created: string;
  /** sha256 of the device's own secret; the plaintext exists only at pair time. */
  secretHash?: string;
  /** The device's web-push subscription endpoint for silent wake pings (VAPID). */
  push?: { endpoint: string; at: string };
  /** SSH public keys this device may log in with (authorized_keys lines, parsed). */
  sshKeys?: { algo: string; b64: string; comment?: string; at: string }[];
}

interface StateFile {
  v: 1;
  rooms: RoomRecord[];
  devices: DeviceRecord[];
}

export class State {
  readonly accounts: Account[];
  rooms: RoomRecord[] = [];
  devices: DeviceRecord[] = [];
  readonly #path: string | null;

  constructor(accounts: Account[], path?: string) {
    this.accounts = accounts;
    this.#path = path ?? null;
    if (this.#path) this.#load();
  }

  #load(): void {
    try {
      const f = JSON.parse(readFileSync(this.#path!, "utf8")) as StateFile;
      if (f.v === 1) {
        this.rooms = f.rooms ?? [];
        this.devices = f.devices ?? [];
      }
    } catch (e) {
      if (!(e instanceof Error && "code" in e && (e as { code?: string }).code === "ENOENT")) {
        throw e;
      }
    }
  }

  #save(): void {
    if (!this.#path) return;
    const file: StateFile = { v: 1, rooms: this.rooms, devices: this.devices };
    const tmp = `${this.#path}.tmp-${Math.random().toString(36).slice(2)}`;
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }

  accountByToken(token: string): Account | null {
    return this.accounts.find((a) => a.token === token) ?? null;
  }

  roomByTokenHash(hash: string): RoomRecord | null {
    return this.rooms.find((r) => r.tokenHash === hash) ?? null;
  }

  roomsOfAccount(accountId: string): RoomRecord[] {
    return this.rooms.filter((r) => r.accountId === accountId);
  }

  addRoom(accountId: string, name: string): { room: RoomRecord; token: string } {
    const token = randomToken(32);
    const room: RoomRecord = {
      id: randomId("r"),
      accountId,
      name,
      tokenHash: sha256Hex(token),
      created: new Date().toISOString(),
    };
    this.rooms.push(room);
    this.#save();
    return { room, token };
  }

  devicesOfRoom(roomId: string): DeviceRecord[] {
    return this.devices.filter((d) => d.roomId === roomId);
  }

  deviceById(id: string): DeviceRecord | null {
    return this.devices.find((d) => d.id === id) ?? null;
  }

  /** Remember (or forget, with a null endpoint) where to wake a device. */
  setDevicePush(id: string, endpoint: string | null): boolean {
    const d = this.deviceById(id);
    if (!d) return false;
    d.push = endpoint ? { endpoint, at: new Date().toISOString() } : undefined;
    if (!endpoint) delete d.push;
    this.#save();
    return true;
  }

  /** A paired device presenting its own secret (not the account token). */
  deviceByCredentials(id: string, secret: string): DeviceRecord | null {
    const d = this.deviceById(id);
    if (!d || !d.secretHash) return null;
    return sameSecret(d.secretHash, sha256Hex(secret)) ? d : null;
  }

  /** Authorize an SSH public key for a device (deduped, capped). */
  addDeviceSshKey(id: string, algo: string, b64: string, comment?: string): boolean {
    const d = this.deviceById(id);
    if (!d) return false;
    d.sshKeys ??= [];
    if (d.sshKeys.some((k) => k.algo === algo && k.b64 === b64)) return true;
    if (d.sshKeys.length >= 5) return false;
    d.sshKeys.push({ algo, b64, comment: comment?.slice(0, 200) || undefined, at: new Date().toISOString() });
    this.#save();
    return true;
  }

  removeDeviceSshKey(id: string, b64: string): boolean {
    const d = this.deviceById(id);
    if (!d?.sshKeys) return false;
    const n = d.sshKeys.length;
    d.sshKeys = d.sshKeys.filter((k) => k.b64 !== b64);
    if (d.sshKeys.length === n) return false;
    if (d.sshKeys.length === 0) delete d.sshKeys;
    this.#save();
    return true;
  }

  /** Un-pair: the owner revoked a device. Its secret dies with it (hash gone),
 *  its websocket is kicked by the gateway, its push subscription with it. */
  removeDevice(id: string): DeviceRecord | null {
    const i = this.devices.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const [gone] = this.devices.splice(i, 1);
    this.#save();
    return gone;
  }

  accountById(id: string): Account | null {
    return this.accounts.find((a) => a.id === id) ?? null;
  }

  /** Mints the device and its one-time secret (returned plaintext, stored hashed). */
  addDevice(room: RoomRecord, name: string, scope: Scope): { device: DeviceRecord; secret: string } {
    const secret = randomToken(32);
    const d: DeviceRecord = {
      id: randomId("d"),
      roomId: room.id,
      accountId: room.accountId,
      name,
      scope,
      created: new Date().toISOString(),
      secretHash: sha256Hex(secret),
    };
    this.devices.push(d);
    this.#save();
    return { device: d, secret };
  }
}
