export type ViewedScope = "workspace" | "tab";

// Ovis remembers this preference in browser storage. L1 intentionally keeps selection tab-local,
// so the upstream helper's API is present but its storage-backed implementation is not wired.
export function lastViewedPane(_scope: ViewedScope, _machineId: string, _id: string): undefined {
  return undefined;
}

export function rememberViewedPane(_scope: ViewedScope, _machineId: string, _id: string, _paneId: string): void {
  // No localStorage/IndexedDB persistence in Herdgate L1.
}

export function forgetViewedPane(): void {
  // No persisted selection to clear.
}
