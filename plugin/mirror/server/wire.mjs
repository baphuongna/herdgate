/** Wire-side pacing for the stream mirror: when may we ask for a frame?
 *
 * The publisher throttles term.read (1/s). The poll loop asks every 1.6s as a
 * safety net; predictive echo also wants a frame RIGHT after a key batch is
 * flushed, so a confirmation comes back in ~1 RTT instead of waiting for the
 * poll. Both asks go through one AskScheduler so they share the throttle
 * budget instead of stacking into busy replies. */

export class AskScheduler {
  /** @param {{minIntervalMs?: number, now?: () => number}} [opts] */
  constructor({ minIntervalMs = 1_000, now = () => Date.now() } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.lastAsk = -Infinity;
  }

  mark() {
    this.lastAsk = this.now();
  }

  /** How long to wait before the next ask is allowed (0 = now). Pure — the
   *  caller decides whether to actually ask, then calls mark(). */
  nextDelayMs() {
    const elapsed = this.now() - this.lastAsk;
    return elapsed >= this.minIntervalMs ? 0 : this.minIntervalMs - elapsed;
  }
}
