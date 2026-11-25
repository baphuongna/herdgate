import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ConsoleApiClient, ConsoleApiError, type ConsoleCapabilities } from "../../src/console/web/client.ts";
import { MirrorFrameGate } from "../../src/console/web/mirror-gate.ts";
import { mirrorViewModel, type ConsolePaneScreen, type ConsoleSessionSnapshot } from "../../src/console/web/view-model.ts";
import { stripUnsafeOsc } from "../../src/console/web/mirror-gate.ts";

function messageOf(error: unknown): string {
  if (error instanceof ConsoleApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The local Console request failed";
}

/** Read-only ANSI surface on Ovis's pinned xterm engine; no Ovis socket or input addon is mounted. */
function OvisTerminalMirror({ screen, stale }: { screen: ConsolePaneScreen; stale: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const renderEpoch = useRef(0);

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
    terminal.current = instance;
    fit.current = fitAddon;
    const resize = (): void => {
      if (screen.cols === null || screen.rows === null) {
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
    if (!instance) return;
    const epoch = ++renderEpoch.current;
    // Wait for older queued writes to drain before resetting; late frames cannot paint over a newer one.
    instance.write("", () => {
      if (renderEpoch.current !== epoch || terminal.current !== instance) return;
      instance.reset();
      if (screen.cols !== null && screen.rows !== null) {
        const cols = Math.max(1, Math.min(screen.cols, 500));
        const rows = Math.max(1, Math.min(screen.rows, 500));
        instance.resize(cols, rows);
      } else {
        try { fit.current?.fit(); } catch { /* wait for the next visible resize */ }
      }
      instance.write(stripUnsafeOsc(screen.ansi));
    });
  }, [screen.paneId, screen.runtimeGeneration, screen.sequence, screen.ansi, screen.cols, screen.rows]);

  return <section className="mirror-frame" aria-label={`Read-only mirror for ${screen.paneId}`}>
    {stale && <p className="notice warning" role="status">Mirror refresh failed; showing the last validated snapshot (stale).</p>}
    {screen.truncated && <p className="notice warning" role="status">Snapshot truncated at the Console size limit.</p>}
    <div className="terminal-surface" ref={host} aria-readonly="true" />
    <p className="frame-meta">Snapshot {screen.sequence} · {screen.cols ?? "?"}×{screen.rows ?? "?"} · {screen.capturedAt}</p>
  </section>;
}

export function ConsoleApp() {
  const [api] = useState(() => new ConsoleApiClient());
  const [capabilities, setCapabilities] = useState<ConsoleCapabilities | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [apiError, setApiError] = useState("");
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<ConsoleSessionSnapshot | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [screen, setScreen] = useState<ConsolePaneScreen | null>(null);
  const [screenStale, setScreenStale] = useState(false);
  const [sessionStale, setSessionStale] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const snapshotRef = useRef<ConsoleSessionSnapshot | null>(null);
  const selectedRef = useRef<string | null>(null);
  const generationRef = useRef<string | null>(null);
  const gate = useRef(new MirrorFrameGate());

  useEffect(() => {
    let alive = true;
    void api.capabilities().then((value) => { if (alive) setCapabilities(value); }).catch((error: unknown) => {
      if (alive) setApiError(messageOf(error));
    });
    return () => { alive = false; };
  }, [api]);

  const applySnapshot = useCallback((next: ConsoleSessionSnapshot): void => {
    const previousGeneration = generationRef.current;
    generationRef.current = next.runtimeGeneration;
    snapshotRef.current = next;
    setSnapshot(next);
    if (next.runtime !== "available") {
      selectedRef.current = null;
      setSelectedPaneId(null);
      setScreen(null);
      setSessionStale(false);
      return;
    }
    if (previousGeneration !== null && previousGeneration !== next.runtimeGeneration) {
      selectedRef.current = null;
      setSelectedPaneId(null);
      setScreen(null);
      setSessionStale(false);
      return;
    }
    setSessionStale(false);
    const selected = selectedRef.current;
    if (selected && !next.panes.some((pane) => pane.id === selected)) {
      selectedRef.current = null;
      setSelectedPaneId(null);
      setScreen(null);
      return;
    }
    if (previousGeneration === null && selected === null) {
      const focused = next.focused.paneId;
      const initial = focused && next.panes.some((pane) => pane.id === focused) ? focused : null;
      selectedRef.current = initial;
      setSelectedPaneId(initial);
    }
  }, []);

  const expireAuthentication = useCallback((): void => {
    setAuthenticated(false);
    setSnapshot(null);
    snapshotRef.current = null;
    selectedRef.current = null;
    setSelectedPaneId(null);
    setScreen(null);
    setScreenStale(false);
    setSessionStale(false);
    generationRef.current = null;
  }, []);

  const refreshSession = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await api.fetchSession(signal);
      applySnapshot(next);
      setApiError("");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ConsoleApiError && error.status === 401) {
        expireAuthentication();
        setApiError("Local viewer session expired; enter a new one-time code.");
        return;
      }
      setApiError(messageOf(error));
      setSessionStale(true);
    }
  }, [api, applySnapshot, expireAuthentication]);

  useEffect(() => {
    if (!authenticated) return;
    let alive = true;
    let running = false;
    const controller = new AbortController();
    const refresh = async (): Promise<void> => {
      if (!alive || running || document.visibilityState !== "visible") return;
      running = true;
      try { await refreshSession(controller.signal); } finally { running = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [authenticated, refreshSession]);

  useEffect(() => {
    if (sessionStale) {
      setScreenStale(true);
      return;
    }
    if (!authenticated || !snapshot || snapshot.runtime !== "available" || !snapshot.runtimeGeneration || !selectedPaneId) {
      setScreen(null);
      return;
    }
    const requestKey = gate.current.select(selectedPaneId, snapshot.runtimeGeneration);
    const controller = new AbortController();
    let alive = true;
    let running = false;
    setScreen(null);
    setScreenStale(false);
    const refresh = async (): Promise<void> => {
      if (!alive || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const next = await api.fetchScreen(selectedPaneId, snapshot.runtimeGeneration!, controller.signal);
        if (alive && gate.current.accept(requestKey, next)) {
          setScreen(next);
          setScreenStale(false);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (alive && error instanceof ConsoleApiError && error.status === 401) {
          expireAuthentication();
          setApiError("Local viewer session expired; enter a new one-time code.");
          return;
        }
        if (alive && error instanceof ConsoleApiError && error.status === 404) {
          selectedRef.current = null;
          setSelectedPaneId(null);
          setScreen(null);
          setScreenStale(false);
          setApiError("The selected pane is no longer available. Choose another pane.");
          return;
        }
        if (alive && error instanceof ConsoleApiError && error.status === 409) {
          setScreen(null);
          setScreenStale(false);
          setApiError("The runtime changed while reading this pane; refreshing the session.");
          void refreshSession(controller.signal);
          return;
        }
        if (alive) {
          setApiError(messageOf(error));
          setScreenStale(true);
        }
      } finally { running = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [api, authenticated, expireAuthentication, refreshSession, selectedPaneId, sessionStale, snapshot?.runtime, snapshot?.runtimeGeneration]);

  const redeem = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const input = codeInput.current;
    const code = input?.value ?? "";
    if (input) input.value = "";
    setCodeError("");
    setBusy(true);
    try {
      await api.redeem(code);
      setAuthenticated(true);
    } catch (error) { setCodeError(messageOf(error)); }
    finally { setBusy(false); }
  };

  const logout = async (): Promise<void> => {
    setBusy(true);
    try { await api.logout(); } catch (error) { setApiError(messageOf(error)); }
    expireAuthentication();
    setBusy(false);
  };

  const choosePane = (paneId: string): void => {
    const current = snapshotRef.current;
    if (!current || current.runtime !== "available" || !current.panes.some((pane) => pane.id === paneId)) return;
    selectedRef.current = paneId;
    gate.current.select(paneId, current.runtimeGeneration ?? "");
    setSelectedPaneId(paneId);
    setScreen(null);
  };

  const currentPane = snapshot?.panes.find((pane) => pane.id === selectedPaneId) ?? null;
  const currentTab = currentPane ? snapshot?.tabs.find((tab) => tab.id === currentPane.tabId && tab.workspaceId === currentPane.workspaceId) ?? null : null;
  const currentWorkspace = currentPane ? snapshot?.workspaces.find((workspace) => workspace.id === currentPane.workspaceId) ?? null : null;
  const tabs = useMemo(() => currentWorkspace ? snapshot?.tabs.filter((tab) => tab.workspaceId === currentWorkspace.id) ?? [] : [], [snapshot, currentWorkspace?.id]);
  const panes = useMemo(() => currentTab ? snapshot?.panes.filter((pane) => pane.tabId === currentTab.id && pane.workspaceId === currentTab.workspaceId) ?? [] : [], [snapshot, currentTab?.id, currentTab?.workspaceId]);
  const model = snapshot ? mirrorViewModel(snapshot, selectedPaneId, screen ?? undefined) : null;

  if (!authenticated) return <main className="console-shell auth-shell">
    <header className="brand"><span className="brand-mark" aria-hidden="true">H</span><div><h1>Herdgate Console</h1><p>Local, read-only view of the selected Herdr session</p></div></header>
    <section className="auth-card" aria-labelledby="login-title">
      <h2 id="login-title">Unlock this browser tab</h2>
      <p>Enter the short-lived code printed by <code>herdgate console login</code>. Reloading requires a new login.</p>
      <form onSubmit={(event) => { void redeem(event); }}>
        <label htmlFor="local-code">One-time local code</label>
        <input id="local-code" ref={codeInput} name="code" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} inputMode="text" maxLength={256} required />
        <button type="submit" disabled={busy}>{busy ? "Checking…" : "Unlock Console"}</button>
      </form>
      {codeError && <p className="notice error" role="alert">{codeError}</p>}
      {apiError && <p className="notice error" role="status">Console status: {apiError}</p>}
      {capabilities && <p className="status-line">Console {capabilities.console}; runtime {capabilities.runtime}; read-only.</p>}
    </section>
    <footer>Local access only · no Ovis account, relay, or remote connection</footer>
  </main>;

  const workspaces = snapshot?.workspaces ?? [];
  const runtimeStatus = sessionStale ? "Runtime status stale" : !snapshot ? "Loading session…" : snapshot.runtime === "available" ? "Runtime connected" : snapshot.runtime === "ambiguous" ? "Runtime selection required" : "Runtime unavailable";
  return <main className="console-shell app-shell">
    <header className="topbar">
      <div className="brand compact"><span className="brand-mark" aria-hidden="true">H</span><div><h1>Herdgate Console</h1><p>{runtimeStatus} · read-only</p></div></div>
      <button type="button" className="quiet-button" onClick={() => { void logout(); }} disabled={busy}>Lock tab</button>
    </header>
    <div className="layout">
      <aside className="sidebar" aria-label="Session layout">
        <section><h2>Workspaces</h2>
          {workspaces.length === 0 ? <p className="muted">No workspace data available.</p> : workspaces.map((workspace) => <button key={workspace.id} className={`nav-item ${currentWorkspace?.id === workspace.id ? "selected" : ""}`} type="button" onClick={() => {
            const tab = snapshot?.tabs.find((item) => item.workspaceId === workspace.id);
            const pane = tab && snapshot?.panes.find((item) => item.tabId === tab.id && item.workspaceId === workspace.id);
            if (pane) choosePane(pane.id);
          }}>{workspace.label}</button>)}
        </section>
        {currentWorkspace && <section><h2>Tabs · {currentWorkspace.label}</h2>
          {tabs.map((tab) => <button key={tab.id} className={`nav-item ${currentTab?.id === tab.id ? "selected" : ""}`} type="button" onClick={() => {
            const pane = snapshot?.panes.find((item) => item.tabId === tab.id && item.workspaceId === tab.workspaceId);
            if (pane) choosePane(pane.id);
          }}>{tab.label}</button>)}
        </section>}
        {currentTab && <section><h2>Panes · {currentTab.label}</h2>
          {panes.map((pane) => <button key={pane.id} className={`nav-item pane-item ${selectedPaneId === pane.id ? "selected" : ""}`} type="button" onClick={() => choosePane(pane.id)}><span>{pane.title}</span><small>{pane.id}</small></button>)}
        </section>}
        <p className="capability-note">Terminal input, resize, layout changes, chat, inbox, and remote features are not supported in this mode.</p>
      </aside>
      <section className="main-view" aria-live="polite">
        <div className="view-heading"><div><p className="eyebrow">{currentWorkspace?.label ?? "LOCAL SESSION"} {currentTab ? ` / ${currentTab.label}` : ""}</p><h2>{currentPane?.title ?? "Session mirror"}</h2></div>{currentPane && <code>{currentPane.id}</code>}</div>
        {apiError && <p className="notice error" role="status">{apiError}</p>}
        {!snapshot && <div className="empty-state"><h3>Reading local session…</h3><p>The Console stays available even if the selected Herdr runtime is offline.</p></div>}
        {snapshot?.runtime === "ambiguous" && <div className="empty-state"><h3>Runtime selection required</h3><p>Herdgate has more than one possible runtime. Select one in host configuration; the Console will not guess.</p></div>}
        {snapshot?.runtime === "unavailable" && <div className="empty-state"><h3>Herdr runtime unavailable</h3><p>The Console is running, but it cannot read a verified session right now. Existing content is not shown as live.</p></div>}
        {snapshot?.runtime === "available" && !currentPane && <div className="empty-state"><h3>Select a pane</h3><p>No selected pane is available in the current snapshot. Choose a pane from the layout list.</p></div>}
        {currentPane && model?.state === "ready" && model.mirror.kind === "ansi-snapshot" && <OvisTerminalMirror screen={screen!} stale={screenStale || sessionStale} />}
        {currentPane && model?.state === "ready" && model.mirror.kind === "unavailable" && <div className="empty-state"><h3>Mirror unavailable</h3><p>{screenStale ? "The last screen read failed; no stale frame is presented as live." : "Waiting for a validated screen snapshot for this pane and runtime generation."}</p></div>}
        {currentPane && model?.state === "selection-required" && <div className="empty-state"><h3>Pane layout unavailable</h3><p>The selected pane is not associated with a verified workspace and tab in this snapshot.</p></div>}
      </section>
    </div>
  </main>;
}
