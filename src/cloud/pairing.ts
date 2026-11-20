/**
 * Host-agent pairing (GitHub-style device flow): the host mints a code, a human
 * approves it from a logged-in device, the host polls for its room token.
 *
 *   host                       cloud                      device (logged in)
 *   POST /v1/agent/code  →  {code, url}
 *   print url ──────────────────────────────────────────▶ user opens url
 *                            POST /v1/agent/approve ◀──── {code} (account token)
 *   GET  /v1/agent/code/:code/status (poll)
 *        ◀── {status:"approved", roomToken}   (returned once, then forgotten)
 */

import { AGENT_CODE_TTL_MS } from "../protocol/envelope.ts";
import { randomCode } from "./util.ts";

export interface MintedCode {
  code: string;
  url: string;
  expiresIn: number;
}

interface Entry {
  code: string;
  hostName: string;
  expires: number;
  approved: boolean;
  /** Plaintext room token, cleared after the first successful poll. */
  roomToken: string | null;
  roomId: string | null;
}

export class AgentCodes {
  readonly #entries: Entry[] = [];
  readonly #now: () => number;
  readonly #publicUrl: string | null;
  readonly #maxPending: number;

  constructor(now: () => number = Date.now, publicUrl: string | null = null, maxPending = 256) {
    this.#now = now;
    this.#publicUrl = publicUrl;
    this.#maxPending = Math.max(1, maxPending);
  }

  mint(hostName: string): MintedCode | null {
    this.#prune();
    // A bounded inventory: an unauthenticated mint loop must not grow memory
    // without limit (audit pairing:unbounded-code-mint).
    if (this.#entries.length >= this.#maxPending) return null;
    const e: Entry = { code: randomCode(8), hostName, expires: this.#now() + AGENT_CODE_TTL_MS, approved: false, roomToken: null, roomId: null };
    this.#entries.push(e);
    return { code: e.code, url: this.#publicUrl ? `${this.#publicUrl.replace(/\/$/, "")}/pair?code=${e.code}` : e.code, expiresIn: AGENT_CODE_TTL_MS / 1000 };
  }

  /** Binds an approved code to a fresh room; the token is handed out via `status`. */
  fulfill(code: string, roomToken: string, roomId: string): boolean {
    this.#prune();
    const e = this.#find(code);
    if (!e) return false;
    e.approved = true;
    e.roomToken = roomToken;
    e.roomId = roomId;
    return true;
  }

  status(code: string): { status: "pending" | "approved" | "unknown"; roomToken?: string; roomId?: string; hostName?: string } {
    this.#prune();
    const e = this.#find(code);
    if (!e) return { status: "unknown" };
    if (!e.approved) return { status: "pending", hostName: e.hostName };
    const out = { status: "approved" as const, roomToken: e.roomToken ?? undefined, roomId: e.roomId ?? undefined, hostName: e.hostName };
    e.roomToken = null; // single retrieval
    return out;
  }

  #find(code: string): Entry | undefined {
    const up = code.trim().toUpperCase();
    return this.#entries.find((e) => e.code === up);
  }

  #prune(): void {
    const now = this.#now();
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i].expires <= now) this.#entries.splice(i, 1);
    }
  }
}
