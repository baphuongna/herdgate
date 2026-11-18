/**
 * The herdgate envelope: every WebSocket text frame on every leg is one JSON object
 * `{v, t, ...}`. `v` is the protocol version; a peer that receives another `v`
 * closes the socket. Messages are discriminated by the string `t`.
 *
 * Rule of the house: **payload fields are opaque.** The cloud routes them between
 * legs and never inspects, logs or persists them. This keeps the door open for
 * end-to-end encryption later (the payload becomes a ciphertext string and the
 * cloud does not change).
 */

export const PROTOCOL_VERSION = 1;

/** A frame larger than this (bytes, UTF-8) closes the socket (1009). */
export const MAX_FRAME_BYTES = 256 * 1024;

/** A socket that has not sent a valid `hello` by then is closed (4001). */
export const HELLO_TIMEOUT_MS = 10_000;

/** Message-rate ceiling per socket: sustained msgs/s and burst capacity. */
export const RATE_MSG_PER_S = 60;
export const RATE_BURST = 120;

/** An agent pairing code lives this long (device-flow). */
export const AGENT_CODE_TTL_MS = 10 * 60_000;

/** A device pair request (approve-on-host) waits this long for the host. */
export const PAIR_ANSWER_MS = 60_000;

export type Scope = "read" | "act";

export interface Envelope {
  v: number;
  t: string;
  [k: string]: unknown;
}

export function encode(msg: Record<string, unknown>): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
}

/** A syntactically valid envelope of this version, or `null`. */
export function decode(text: string): Envelope | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const e = m as Record<string, unknown>;
  if (e.v !== PROTOCOL_VERSION || typeof e.t !== "string" || e.t === "") return null;
  return e as Envelope;
}

export function isScope(v: unknown): v is Scope {
  return v === "read" || v === "act";
}
