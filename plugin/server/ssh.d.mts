import type { ChildProcess } from "node:child_process";

export interface SshBridgeOptions {
  send(device: string, payload: Record<string, unknown>): void;
  scopeOf(device: string): "read" | "act" | null;
  log?(line: string): void;
  resolve?: () => string | null;
  resolveHerdrBin?: () => string | null;
  session?: string;
  platform?: NodeJS.Platform;
  tuiOnly?: boolean;
  mobileHcBin?: string | null;
  mobileTuiAdapter?: { device: string; script: string; scope?: "read" | "act" } | null;
  trustedReadCore?: string | null;
  spawnImpl?: (bin: string, args: string[], opts: { stdio: ("pipe" | null)[]; shell: boolean; windowsHide?: boolean; env?: NodeJS.ProcessEnv }) => ChildProcess;
}

export interface SshBridge {
  handle(device: string, payload: unknown): boolean;
  dropDevice(device: string): void;
  closeAll(): void;
}

export const READ_METHODS: Set<string>;
export function translateBootstrap(cmd: string): string | null;
export function createSshBridge(options: SshBridgeOptions): SshBridge;
