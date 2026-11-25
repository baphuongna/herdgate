/** The gate's own log lines, kept in memory for the owner's admin page.
 *
 *  A filter aid, not a parser: `kind` is read off the prefixes `log()` already uses, so a new
 *  kind of line needs no bookkeeping here to show up (it lands in `other`). The ring is bounded
 *  and dies with the process on purpose — the system journal remains the record of truth.
 */

export type EventKind = "gate" | "pair" | "device" | "agent" | "ssh" | "other";

export function eventKind(line: string): EventKind {
  if (/\b(listening on|shutting down|refusing to start)\b/.test(line) || line.startsWith("gate ")) return "gate";
  if (line.startsWith("ssh:")) return "ssh";
  if (line.startsWith("agent ")) return "agent";
  if (line.startsWith("device ")) return "device";
  if (line.startsWith("room ")) return "pair";
  return "other";
}

export interface GateEvent {
  seq: number;
  at: string;
  line: string;
  kind: EventKind;
}

export class EventRing {
  readonly cap: number;
  readonly #items: GateEvent[] = [];
  #seq = 0;

  constructor(cap = 300) {
    this.cap = Math.max(1, Math.floor(cap));
  }

  push(line: string, at = new Date().toISOString()): GateEvent {
    const e: GateEvent = { seq: ++this.#seq, at, line, kind: eventKind(line) };
    this.#items.push(e);
    if (this.#items.length > this.cap) this.#items.splice(0, this.#items.length - this.cap);
    return e;
  }

  /** Everything after `after`. Anything that is not a non-negative safe integer means "all". */
  since(after: unknown): GateEvent[] {
    return typeof after === "number" && Number.isSafeInteger(after) && after >= 0 ? this.#items.filter((e) => e.seq > after) : this.#items.slice();
  }

  get length(): number {
    return this.#items.length;
  }
}
