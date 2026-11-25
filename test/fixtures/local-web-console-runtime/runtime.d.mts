import type { ConsoleSnapshot } from "../../../../bin/console-rpc.mjs";

/** One JSONL request the fixture runtime received from the Console. */
export interface FixtureRpcRequest {
  id: string;
  method: string;
  params?: { pane_id?: string; [key: string]: unknown };
}

export interface FixtureRuntime {
  readonly calls: FixtureRpcRequest[];
  close(): Promise<void>;
}

export interface StartFixtureRuntimeOptions {
  /** A session.snapshot payload, or a callback producing one per request. */
  snapshot?: ConsoleSnapshot | ((request: FixtureRpcRequest) => ConsoleSnapshot | Promise<ConsoleSnapshot>);
  /** Static pane.read text, or a callback producing it per request. */
  readText?: string | ((request: FixtureRpcRequest) => string | Promise<string>);
  cols?: number | null;
  rows?: number | null;
}

/** Minimal Herdr-compatible JSONL runtime on a Unix socket for isolated tests. */
export declare function startFixtureRuntime(socketPath: string, options?: StartFixtureRuntimeOptions): Promise<FixtureRuntime>;
