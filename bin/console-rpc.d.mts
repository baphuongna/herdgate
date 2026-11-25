import type { Socket } from "node:net";

/** One layout cell as Herdr reports it in pane layout rects. */
export interface PaneLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Herdr PaneScrollInfo: scroll position plus the terminal's visible row count. */
export interface PaneScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

/** The pane fields the Console consumes; Herdr sends more, which stay opaque here. */
export interface ConsolePaneInfo {
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  focused?: boolean;
  scroll?: PaneScrollInfo | null;
}

export interface PaneLayoutPane {
  pane_id: string;
  focused: boolean;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSplit {
  id: string;
  direction: "right" | "down";
  ratio: number;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSnapshot {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  area: PaneLayoutRect;
  focused_pane_id: string;
  panes: PaneLayoutPane[];
  splits: PaneLayoutSplit[];
}

/** session.snapshot result shape the service validates and mirrors read-only. */
export interface ConsoleSnapshot {
  version?: string;
  protocol?: number;
  workspaces: { workspace_id: string; label?: string }[];
  tabs: { tab_id: string; workspace_id?: string }[];
  panes: ConsolePaneInfo[];
  layouts: PaneLayoutSnapshot[];
  agents: unknown[];
}

/** Dimensions the runtime may report alongside a pane.read frame. */
export interface PaneReadDimensions {
  cols?: number | null;
  rows?: number | null;
}

/** The pane.read result fields the Console validates and forwards. */
export interface PaneReadResult extends PaneReadDimensions {
  pane_id: string;
  text: string;
  truncated: boolean;
  revision?: number;
}

/** Read-only transport surface; no arbitrary method dispatcher is exposed. */
export interface ConsoleRpc {
  snapshot(): Promise<ConsoleSnapshot>;
  readPane(paneId: string): Promise<PaneReadResult>;
}

export interface ConsoleRpcOptions {
  connect: () => Socket;
  timeoutMs?: number;
  paneTimeoutMs?: number;
  maxFrameBytes?: number;
}

export declare function createConsoleRpc(options: ConsoleRpcOptions): Readonly<ConsoleRpc>;

/** Bind a connector to a trusted socket path at setup time. */
export declare function createUnixConnector(socketPath: string): () => Socket;

export declare class ConsoleRpcError extends Error {
  code: string;
  constructor(code: string, message: string);
}

/**
 * Derive terminal cell geometry only from runtime readings or the matching layout.
 * Returns null for a dimension whenever the runtime provides no trustworthy value.
 */
export declare function derivePaneDimensions(snapshot: ConsoleSnapshot | null | undefined, paneId: string, read?: PaneReadDimensions | null): { cols: number | null; rows: number | null };
