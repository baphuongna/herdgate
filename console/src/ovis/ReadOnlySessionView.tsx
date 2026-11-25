import type { KeyboardEvent, MouseEvent } from "react";
import type { ConsolePaneScreen, ConsoleSessionSnapshot } from "../../../src/console/web/view-model.ts";
import { MachineContext } from "./machine-context-shim.tsx";
import type { SessionSnapshot } from "../../vendor/ovis/shared/protocol.ts";
import { PaneCanvas } from "../../vendor/ovis/src/components/PaneCanvas.tsx";
import { TabStrip } from "../../vendor/ovis/src/components/TabStrip.tsx";
import { SettingsProvider } from "./settings-shim.tsx";
import { OvisTerminalMirror } from "./TerminalMirror.tsx";

export interface ReadOnlySessionViewProps {
  snapshot: ConsoleSessionSnapshot;
  selectedPaneId: string | null;
  screen: ConsolePaneScreen | null;
  stale: boolean;
  onSelectPane: (paneId: string) => void;
}

function blockedContextMenu(event: MouseEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}
function blockActionMenuKey(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/**
 * Adapter entry for the pinned Ovis workspace/tab/pane composition. The Ovis
 * TabStrip and PaneCanvas source components are mounted directly; selection is
 * browser-local and all mutation affordances are disabled or blocked here.
 */
export function OvisReadOnlySessionView({ snapshot, selectedPaneId, screen, stale, onSelectPane }: ReadOnlySessionViewProps) {
  const source = snapshot.ovisSnapshot as SessionSnapshot | undefined;
  if (!source || snapshot.runtime !== "available") return null;
  const selectedPane = source.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  const workspace = selectedPane ? source.workspaces.find((item) => item.workspace_id === selectedPane.workspace_id) ?? null : null;
  if (!selectedPane || !workspace) return <div className="empty-state"><h3>Select a pane</h3><p>No pane is selected in the current runtime snapshot.</p></div>;

  return <SettingsProvider>
    <MachineContext.Provider value="local">
      <div className="ovis-l1-session" onContextMenuCapture={blockedContextMenu} onKeyDownCapture={blockActionMenuKey}>
        <TabStrip
          snapshot={source}
          workspace={workspace}
          selectedPane={selectedPane}
          onSelectPane={onSelectPane}
          onNewTab={() => {}}
          onNewTerminal={async () => {}}
          closable={false}
          browserTabs
        />
        <div className="ovis-l1-pane-area">
          <PaneCanvas
            snapshot={source}
            pane={selectedPane}
            selectedPaneId={selectedPaneId}
            onSelect={(paneId) => onSelectPane(paneId)}
            onChanged={() => {}}
            watching
            renderPane={(pane) => pane && pane.pane_id === selectedPaneId
              ? <OvisTerminalMirror screen={screen?.paneId === pane.pane_id ? screen : null} stale={stale} />
              : <div className="ovis-pane-not-selected" aria-hidden="true">Select this pane to read its mirror.</div>}
          />
        </div>
        <p className="ovis-l1-readonly-note">Ovis layout components · read-only mirror. Input, resize, layout mutation, chat, and inbox are disabled.</p>
      </div>
    </MachineContext.Provider>
  </SettingsProvider>;
}
