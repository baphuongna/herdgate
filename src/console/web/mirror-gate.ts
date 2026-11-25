import type { ConsolePaneScreen } from "./view-model.ts";

export interface MirrorRequestKey {
  readonly epoch: number;
  readonly paneId: string;
  readonly runtimeGeneration: string;
}

/** Reject results from earlier A→B→A selections, wrong panes/generations, and replayed frames. */
export class MirrorFrameGate {
  #epoch = 0;
  #paneId: string | null = null;
  #generation: string | null = null;
  #lastSequence = -1;

  select(paneId: string, runtimeGeneration: string): MirrorRequestKey {
    this.#epoch += 1;
    this.#paneId = paneId;
    this.#generation = runtimeGeneration;
    this.#lastSequence = -1;
    return { epoch: this.#epoch, paneId, runtimeGeneration };
  }

  accept(key: MirrorRequestKey, screen: ConsolePaneScreen): boolean {
    if (key.epoch !== this.#epoch || key.paneId !== this.#paneId || key.runtimeGeneration !== this.#generation) return false;
    if (screen.paneId !== key.paneId || screen.runtimeGeneration !== key.runtimeGeneration || screen.sequence <= this.#lastSequence) return false;
    this.#lastSequence = screen.sequence;
    return true;
  }
}

// xterm renders terminal control sequences as terminal operations, never HTML. Strip OSC
// clipboard and clickable-link controls as well, so a read-only mirror cannot copy/open content.
const unsafeOsc = /(?:\u001b\]|\u009d)(?:52|8);[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)/g;
export function stripUnsafeOsc(ansi: string): string {
  return ansi.replace(unsafeOsc, "");
}
