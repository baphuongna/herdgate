// Predictive local echo — a reduced mosh-style port of herdr-mirror's predict.rs.
// Keystrokes echo locally the moment they are typed (the round trip reads as
// lag otherwise), but ONLY once the authoritative screen has confirmed
// CONFIRM_THRESHOLD consecutive predictions; one contradiction while a
// prediction is past the RTT grace and still missing disables echoing until
// it earns trust again. Expired predictions surface as ghosts for the caller
// to erase — never leave a guessed password character on screen.

export const CONFIRM_THRESHOLD = 2;
export const CONFIRM_GRACE_MS = 150; // one round trip: a frame this fresh may simply predate the key
export const ECHO_TIMEOUT_MS = 1200;
export const MAX_PENDING = 32;

export class PredEcho {
  /** @param {{now?: () => number}} [opts] clock injection for tests */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.enabled = false;
    this.confirms = 0;
    /** @type {{text: string, at: number}[]} */
    this.pending = [];
  }

  /** A key was pressed. Always queues (silent predictions are how trust is
   *  earned); echoes only while enabled. @returns {{echo: boolean}} */
  key(text) {
    if (typeof text !== "string" || !text) return { echo: this.enabled };
    if (this.pending.length >= MAX_PENDING) this.pending.shift(); // oldest guess drops first
    this.pending.push({ text, at: this.now() });
    return { echo: this.enabled };
  }

  /** The authoritative screen text arrived. Predictions are matched in order;
   *  a still-missing prediction past the RTT grace is a contradiction (echo
   *  off), one inside the grace stays pending (the frame predates the key),
   *  and one past the echo timeout is a ghost the caller must erase.
   *  @param {string} tail */
  confirm(tail) {
    const text = typeof tail === "string" ? tail : "";
    const now = this.now();
    let rest = text;
    const matched = [];
    const unmatched = [];
    for (const p of this.pending) {
      const idx = rest.indexOf(p.text);
      if (idx >= 0) {
        matched.push(p);
        rest = rest.slice(idx + p.text.length);
      } else unmatched.push(p);
    }
    const ghosts = unmatched.filter((p) => now - p.at > ECHO_TIMEOUT_MS);
    const live = unmatched.filter((p) => now - p.at <= ECHO_TIMEOUT_MS);
    const contradictions = live.filter((p) => now - p.at > CONFIRM_GRACE_MS);
    const stillPending = live.filter((p) => now - p.at <= CONFIRM_GRACE_MS);
    if (text && contradictions.length) {
      this.enabled = false;
      this.confirms = 0;
      this.pending = [];
      return { matched: matched.length, mismatch: true, ghosts: ghosts.map((g) => g.text), enabled: false };
    }
    this.pending = stillPending;
    if (text && matched.length) {
      this.confirms += 1;
      if (this.confirms >= CONFIRM_THRESHOLD) this.enabled = true;
    }
    return { matched: matched.length, mismatch: false, ghosts: ghosts.map((g) => g.text), enabled: this.enabled };
  }

  /** Full-screen apps (vim, htop, the TUIs) fight line echo — the caller
   *  detects them and drops trust immediately. */
  disable() {
    this.enabled = false;
    this.confirms = 0;
    this.pending = [];
  }

  /** The predicted-but-unconfirmed suffix, for a dim overlay while echoing. */
  pendingView() {
    return this.pending.map((p) => p.text).join("");
  }
}

/** Cheap full-screen heuristic on the authoritative text: alternate-screen
 *  sequences or the usual suspects by name. Mirrors stop echoing there. */
export function looksFullScreen(ansi, title = "") {
  if (/\x1b\[\?(?:1049|1047|47)h/.test(String(ansi ?? ""))) return true;
  return /\b(vim|nvim|vi|htop|less|tmux|emacs)\b/i.test(String(title ?? ""));
}
