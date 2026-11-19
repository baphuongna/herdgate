/** Shared test helper: a device-leg WebSocket with promise-based receive. */
import WebSocket from "ws";

export interface Recv {
  t: string;
  [k: string]: unknown;
}

export class DeviceSock {
  readonly ws: WebSocket;
  readonly #inbox: Recv[] = [];
  readonly #waiters: ((m: Recv) => void)[] = [];
  readonly #closed: (() => void)[] = [];
  readonly opened: Promise<void>;
  #closedFlag = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("error", () => {});
    this.opened = new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", (e) => rej(e));
    });
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Recv;
      const w = this.#waiters.shift();
      if (w) w(m);
      else this.#inbox.push(m);
    });
    this.ws.on("close", () => {
      this.#closedFlag = true;
      for (const cb of this.#closed.splice(0)) cb();
    });
  }

  async send(m: Record<string, unknown>): Promise<void> {
    await this.opened;
    this.ws.send(JSON.stringify({ v: 1, ...m }));
  }

  /** Send hello and resolve with the FIRST reply (ok or error — caller judges). */
  async hello(fields: Record<string, unknown>): Promise<Recv> {
    await this.send({ t: "hello", ...fields });
    return this.next(5_000);
  }

  next(timeoutMs = 5_000): Promise<Recv> {
    const hit = this.#inbox.shift();
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("no message in time")), timeoutMs);
      const onEarlyClose = (): void => {
        clearTimeout(t);
        res({ t: "_closed" }); // the cloud hung up without a word — that IS the answer
      };
      if (this.#closedFlag) return onEarlyClose();
      this.#closed.push(onEarlyClose);
      this.#waiters.push((m) => {
        clearTimeout(t);
        const i = this.#closed.indexOf(onEarlyClose);
        if (i >= 0) this.#closed.splice(i, 1);
        res(m);
      });
    });
  }

  async expect(t: string, timeoutMs = 5_000): Promise<Recv> {
    for (;;) {
      const m = await this.next(timeoutMs);
      if (m.t === t) return m;
    }
  }

  expectClose(timeoutMs = 5_000): Promise<void> {
    if (this.#closedFlag) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("socket did not close")), timeoutMs);
      this.#closed.push(() => {
        clearTimeout(t);
        res();
      });
    });
  }

  get closed(): boolean {
    return this.#closedFlag;
  }

  close(): void {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}
