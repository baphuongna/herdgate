import type { AddressInfo } from "node:net";
import type { ConsoleRpc } from "./console-rpc.mjs";

export declare const CONSOLE_CSP: string;

export interface ConsoleAssetEntry {
  /** Absolute path of the asset inside the validated manifest root. */
  path: string;
  type: string;
}

export interface ConsoleAssets {
  root: string;
  files: Map<string, ConsoleAssetEntry>;
}

/** Loads and validates a console/dist manifest; throws console_assets_missing when absent. */
export declare function validateConsoleAssets(assetsDir: string): ConsoleAssets;

export type ConsoleRuntimeStatus = "online" | "unavailable";

export interface ConsoleServiceOptions {
  rpc?: ConsoleRpc | null;
  assetsDir: string;
  now?: () => number;
  log?: (line: string) => void;
  instanceId?: string;
  /** Opt-in public hostname (plain hostname, HTTPS assumed). When set, that Host (plus the loopback door) is accepted, edge address headers are tolerated, and redeem is budgeted per client address. */
  publicHost?: string | null;
}

export interface ConsoleService {
  /** Loopback origin; assigned by start() before the service accepts requests. */
  readonly origin: string;
  readonly runtimeGeneration: string;
  readonly runtimeAvailable: boolean;
  issueLoginCode(): string;
  invalidateRuntime(): void;
  probeRuntime(): Promise<ConsoleRuntimeStatus>;
  start(options?: { host?: string; port?: number }): Promise<AddressInfo>;
  stop(): Promise<void>;
}

export declare function createConsoleService(options: ConsoleServiceOptions): ConsoleService;
