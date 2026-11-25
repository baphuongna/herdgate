export const CONSOLE_CSP_HEADER: string;
export const CONSOLE_CSP_META: string;

export interface ConsoleAssetEntry {
  path: string;
  type: string;
}

export interface ConsoleAssetManifest {
  version: 1;
  index: "index.html";
  files: Record<string, ConsoleAssetEntry>;
}

export interface SandboxArgs {
  repositoryPath: string;
  consolePath: string;
  distPath: string;
  nodePath: string;
  vitePath: string;
}

export function assertRealNodeModules(nodeModulesPath: string): Promise<void>;
export function createAssetAllowlist(distDirectory: string): Promise<ConsoleAssetManifest>;
export function verifyBuildOutput(distDirectory: string): Promise<ConsoleAssetManifest>;
export function sandboxArgs(paths: SandboxArgs): string[];
