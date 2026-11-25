import type { SessionSnapshot as OvisSessionSnapshot } from "../../../console/vendor/ovis/shared/protocol.ts";

/** Typed boundary for the Herdgate read-only Console frontend adapter. */
export interface ConsoleSessionSnapshot {
  runtime: 'available' | 'unavailable';
  runtimeGeneration: string | null;
  workspaces: readonly { id: string; label: string }[];
  tabs: readonly { id: string; workspaceId: string; label: string }[];
  panes: readonly { id: string; tabId: string; workspaceId: string; title: string }[];
  focused: { workspaceId: string | null; tabId: string | null; paneId: string | null };
  /** Validated source snapshot retained for the isolated Ovis TabStrip/PaneCanvas adapter. */
  ovisSnapshot?: OvisSessionSnapshot;
}

export interface ConsolePaneScreen {
  paneId: string;
  runtimeGeneration: string;
  sequence: number;
  cols: number | null;
  rows: number | null;
  ansi: string;
  capturedAt: string;
  truncated: boolean;
}

export type MirrorViewModel =
  | { state: 'runtime-unavailable' }
  | { state: 'selection-required'; reason: 'pane-not-in-snapshot' | 'no-pane-selected' }
  | {
      state: 'ready';
      selection: { workspaceId: string; tabId: string; paneId: string };
      workspaceLabel: string;
      tabLabel: string;
      paneTitle: string;
      mirror:
        | { kind: 'ansi-snapshot'; sequence: number; cols: number | null; rows: number | null; capturedAt: string; truncated: boolean; ansi: string }
        | { kind: 'unavailable'; reason: 'screen-unavailable' | 'screen-pane-mismatch' | 'screen-generation-mismatch' };
    };

/**
 * Project a validated layout and an optional screen read into presentation data.
 * Missing or mismatched backend evidence is represented as unavailable, never as
 * an empty-but-successful screen. IDs remain source IDs; labels are presentation only.
 */
export function mirrorViewModel(
  snapshot: ConsoleSessionSnapshot,
  selectedPaneId: string | null,
  screen?: ConsolePaneScreen,
): MirrorViewModel {
  if (snapshot.runtime !== 'available') return { state: 'runtime-unavailable' };
  if (selectedPaneId === null) return { state: 'selection-required', reason: 'no-pane-selected' };

  const pane = snapshot.panes.find((candidate) => candidate.id === selectedPaneId);
  if (!pane) return { state: 'selection-required', reason: 'pane-not-in-snapshot' };
  const tab = snapshot.tabs.find((candidate) => candidate.id === pane.tabId && candidate.workspaceId === pane.workspaceId);
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === pane.workspaceId);
  if (!tab || !workspace) return { state: 'selection-required', reason: 'pane-not-in-snapshot' };

  let mirror: Extract<MirrorViewModel, { state: 'ready' }>['mirror'] = { kind: 'unavailable', reason: 'screen-unavailable' };
  if (screen) {
    if (screen.paneId !== pane.id) mirror = { kind: 'unavailable', reason: 'screen-pane-mismatch' };
    else if (snapshot.runtimeGeneration === null || screen.runtimeGeneration !== snapshot.runtimeGeneration) {
      mirror = { kind: 'unavailable', reason: 'screen-generation-mismatch' };
    } else mirror = {
      kind: 'ansi-snapshot',
      sequence: screen.sequence,
      cols: screen.cols,
      rows: screen.rows,
      capturedAt: screen.capturedAt,
      truncated: screen.truncated,
      ansi: screen.ansi,
    };
  }

  return {
    state: 'ready',
    selection: { workspaceId: pane.workspaceId, tabId: pane.tabId, paneId: pane.id },
    workspaceLabel: workspace.label,
    tabLabel: tab.label,
    paneTitle: pane.title,
    mirror,
  };
}
