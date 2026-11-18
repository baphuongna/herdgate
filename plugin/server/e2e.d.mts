/**
 * Types for the E2E crypto module (plugin/server/e2e.mjs — plain JS on WebCrypto).
 * The PWA copy (src/web/e2e.js) is byte-identical; both share this declaration.
 */

export declare const NOISE_NAME: string;
export declare const KEY_LEN: number;
export declare const PUB_LEN: number;

export declare function b64e(u8: Uint8Array): string;
export declare function b64d(s: string): Uint8Array;
export declare function utf8e(s: string): Uint8Array;
export declare function utf8d(u8: Uint8Array): string;
export declare function concat(...parts: Uint8Array[]): Uint8Array;
export declare function fingerprint(pub: Uint8Array): string;
export declare function generateKeyPair(): Promise<{ jwk: JsonWebKey; pub: Uint8Array }>;

export interface NoiseWire {
  op: string;
  n?: number;
  c?: string;
  e?: string;
}

export declare class DeviceChannel {
  constructor(self: { jwk: JsonWebKey; pub: Uint8Array });
  begin(): Promise<{ e: string }>;
  acceptReply(msg: { e: string; c: string }): Promise<{ c: string }>;
  ready(): boolean;
  hostFingerprint: string | null;
  send(obj: unknown): Promise<{ op: string; n: number; c: string }>;
  recv(msg: { op: string; n?: number; c: string }): Promise<Record<string, unknown>>;
}

export declare class HostChannel {
  constructor(self: { jwk: JsonWebKey; pub: Uint8Array });
  acceptInit(msg: { e: string }): Promise<{ e: string; c: string }>;
  acceptFinish(msg: { c: string }): Promise<void>;
  ready(): boolean;
  deviceFingerprint: string | null;
  send(obj: unknown): Promise<{ op: string; n: number; c: string }>;
  recv(msg: { op: string; n?: number; c: string }): Promise<Record<string, unknown>>;
}
