export interface PaneSelectionKeyEvent {
  readonly key: string;
  preventDefault(): void;
}

/** Enter and Space activate a read-only pane selector without adding terminal or layout controls. */
export function activateReadPane(
  event: PaneSelectionKeyEvent,
  paneId: string,
  onSelectPane: (paneId: string) => void,
): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelectPane(paneId);
}
