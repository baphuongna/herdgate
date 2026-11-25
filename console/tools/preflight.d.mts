export interface ConsolePreflightReport {
  requiredNode: string;
  actualNode: string;
  nodeOk: boolean;
  requiredBun: string;
  actualBun: string | null;
  actualBunPath: string | null;
  bunOk: boolean;
  lock: {
    present: boolean;
    lockfileVersion: number;
    bytes: number;
    sha256: string;
    manifestMatches: boolean;
    frozenInstallSupported: boolean;
  };
  cache: { path: string; entryCount: number; bytes: number; contents: string };
  packageCount: number;
  missingPackages: string[];
  installedPackages: Array<{ name: string; required: string; installed: string }>;
  buildReady: boolean;
  blockers: string[];
  preloadCommand: string;
  installAttempted: false;
  credentialsUsed: false;
}

export function inspectConsolePreflight(rootUrl: URL): Promise<ConsolePreflightReport>;
