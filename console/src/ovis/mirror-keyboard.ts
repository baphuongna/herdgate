export interface MirrorKeyboardEvent { key: string; shiftKey?: boolean; }

export interface ReadOnlyMirrorTerminal {
  textarea: { tabIndex: number } | undefined;
  attachCustomKeyEventHandler(handler: (event: MirrorKeyboardEvent) => boolean): void;
}

/** Keep the xterm helper input out of browser Tab navigation in a read-only mirror. */
export function configureReadOnlyMirrorKeyboard(terminal: ReadOnlyMirrorTerminal): void {
  if (terminal.textarea) terminal.textarea.tabIndex = -1;
  // xterm normally handles Tab and focuses its textarea again on keyup. Let the
  // browser perform its native focus traversal instead, in either direction.
  terminal.attachCustomKeyEventHandler((event) => event.key !== "Tab");
}
