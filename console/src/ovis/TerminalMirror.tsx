import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ConsolePaneScreen } from "../../../src/console/web/view-model.ts";
import { stripUnsafeOsc } from "../../../src/console/web/mirror-gate.ts";
import { configureReadOnlyMirrorKeyboard } from "./mirror-keyboard.ts";

/**
 * Herdgate's read-only port of the terminal surface in Ovis PaneTerminal.tsx
 * (pinned vendor revision b0f20e7). It retains Ovis's xterm/FitAddon rendering
 * engine but deliberately omits HerdrSocket, attach, input, resize, and ACK.
 */
export function OvisTerminalMirror({ screen, stale }: { screen: ConsolePaneScreen | null; stale: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const renderEpoch = useRef(0);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  useEffect(() => {
    if (!host.current) return;
    const instance = new Terminal({
      allowProposedApi: false,
      cursorBlink: false,
      cursorStyle: "bar",
      disableStdin: true,
      scrollback: 0,
      theme: { background: "#11151b", foreground: "#d8dee9", cursor: "#8aa1b5", selectionBackground: "#435268" },
    });
    const fitAddon = new FitAddon();
    instance.loadAddon(fitAddon);
    instance.open(host.current);
    configureReadOnlyMirrorKeyboard(instance);
    terminal.current = instance;
    fit.current = fitAddon;
    const resize = (): void => {
      if (screenRef.current?.cols == null || screenRef.current.rows == null) {
        try { fitAddon.fit(); } catch { /* hidden tabs have no measurable cell grid */ }
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    return () => {
      renderEpoch.current += 1;
      observer.disconnect();
      terminal.current = null;
      fit.current = null;
      instance.dispose();
    };
  }, []);

  useEffect(() => {
    const instance = terminal.current;
    if (!instance || !screen) return;
    const epoch = ++renderEpoch.current;
    instance.write("", () => {
      if (renderEpoch.current !== epoch || terminal.current !== instance) return;
      instance.reset();
      if (screen.cols !== null && screen.rows !== null) {
        instance.resize(Math.max(1, Math.min(screen.cols, 500)), Math.max(1, Math.min(screen.rows, 500)));
      } else {
        try { fit.current?.fit(); } catch { /* wait for the next visible resize */ }
      }
      instance.write(stripUnsafeOsc(screen.ansi));
    });
  }, [screen?.paneId, screen?.runtimeGeneration, screen?.sequence, screen?.ansi, screen?.cols, screen?.rows]);

  return <section className="mirror-frame" aria-label={screen ? `Read-only mirror for ${screen.paneId}` : "Read-only terminal mirror"}>
    {stale && <p className="notice warning" role="status">Mirror refresh failed; showing the last validated snapshot (stale).</p>}
    {screen?.truncated && <p className="notice warning" role="status">Snapshot truncated at the Console size limit.</p>}
    {!screen && <p className="notice" role="status">Waiting for a validated screen snapshot for this pane.</p>}
    <div className="terminal-surface" ref={host} aria-readonly="true" />
    {screen && <p className="frame-meta">Snapshot {screen.sequence} · {screen.cols ?? "?"}×{screen.rows ?? "?"} · {screen.capturedAt}</p>}
  </section>;
}
