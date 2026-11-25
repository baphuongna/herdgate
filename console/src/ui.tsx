import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConsoleApiClient, ConsoleApiError, type ConsoleCapabilities } from "../../src/console/web/client.ts";
import { MirrorFrameGate, transitionMirrorSelection } from "../../src/console/web/mirror-gate.ts";
import { mirrorViewModel, type ConsolePaneScreen, type ConsoleSessionSnapshot } from "../../src/console/web/view-model.ts";
import { OvisReadOnlySessionView } from "./ovis/ReadOnlySessionView.tsx";

function messageOf(error: unknown): string {
  if (error instanceof ConsoleApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The local Console request failed";
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
    if (!authenticated) return;
    let alive = true;
    void api.capabilities().then((value) => { if (alive) setCapabilities(value); }).catch((error: unknown) => {
      if (alive) setApiError(messageOf(error));
    });
    return () => { alive = false; };
  }, [api, authenticated]);

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
    setCapabilities(null);
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
      if (error instanceof ConsoleApiError && error.status === 503) {
        applySnapshot({ runtime: "unavailable", runtimeGeneration: null, workspaces: [], tabs: [], panes: [], focused: { workspaceId: null, tabId: null, paneId: null } });
        setApiError(messageOf(error));
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
    const runtimeGeneration = current.runtimeGeneration;
    if (!runtimeGeneration) return;
    transitionMirrorSelection(gate.current,
      { paneId: selectedRef.current, runtimeGeneration: generationRef.current },
      { paneId, runtimeGeneration },
      () => {
        selectedRef.current = paneId;
        setSelectedPaneId(paneId);
        setScreen(null);
      });
  };

  const currentPane = snapshot?.panes.find((pane) => pane.id === selectedPaneId) ?? null;
  const currentTab = currentPane ? snapshot?.tabs.find((tab) => tab.id === currentPane.tabId && tab.workspaceId === currentPane.workspaceId) ?? null : null;
  const currentWorkspace = currentPane ? snapshot?.workspaces.find((workspace) => workspace.id === currentPane.workspaceId) ?? null : null;
  const model = snapshot ? mirrorViewModel(snapshot, selectedPaneId, screen ?? undefined) : null;

  if (!authenticated) return <main className="console-shell auth-shell">
    <header className="brand"><span className="brand-mark" aria-hidden="true">H</span><div><h1>Herdgate Console</h1><p>Local, read-only view of the selected Herdr session</p></div></header>
    <section className="auth-card" aria-labelledby="login-title">
      <h2 id="login-title">Unlock this browser tab</h2>
      <p>Enter the short-lived code printed by <code>herdgate console login</code>. Reloading requires a new login.</p>
      <form onSubmit={(event) => { void redeem(event); }}>
        <label htmlFor="local-code">One-time local code</label>
        <input id="local-code" ref={codeInput} name="code" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} inputMode="text" minLength={64} maxLength={64} pattern="[0-9a-f]{64}" required />
        <button type="submit" disabled={busy}>{busy ? "Checking…" : "Unlock Console"}</button>
      </form>
      {codeError && <p className="notice error" role="alert">{codeError}</p>}
      {apiError && <p className="notice error" role="status">Console status: {apiError}</p>}
    </section>
    <footer>Local access only · no Ovis account, relay, or remote connection · <a href="/notices/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">Third-party notices</a></footer>
  </main>;

  const workspaces = snapshot?.workspaces ?? [];
  const runtimeStatus = sessionStale ? "Runtime status stale" : !snapshot ? "Loading session…" : snapshot.runtime === "available" ? "Runtime connected" : "Runtime unavailable";
  return <main className="console-shell app-shell">
    <header className="topbar">
      <div className="brand compact"><span className="brand-mark" aria-hidden="true">H</span><div><h1>Herdgate Console</h1><p>{runtimeStatus} · {capabilities?.transport ?? "checking"} · read-only</p></div></div>
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
        <p className="capability-note">Terminal input, resize, layout changes, chat, inbox, and remote features are not supported in this mode.</p>
      </aside>
      <section className="main-view" aria-live="polite">
        <div className="view-heading"><div><p className="eyebrow">{currentWorkspace?.label ?? "LOCAL SESSION"} {currentTab ? ` / ${currentTab.label}` : ""}</p><h2>{currentPane?.title ?? "Session mirror"}</h2></div>{currentPane && <code>{currentPane.id}</code>}</div>
        {apiError && <p className="notice error" role="status">{apiError}</p>}
        {!snapshot && <div className="empty-state"><h3>Reading local session…</h3><p>The Console stays available even if the selected Herdr runtime is offline.</p></div>}
        {snapshot?.runtime === "unavailable" && <div className="empty-state"><h3>Herdr runtime unavailable</h3><p>The Console is running, but it cannot read a verified session right now. Existing content is not shown as live.</p></div>}
        {snapshot?.runtime === "available" && !currentPane && <div className="empty-state"><h3>Select a pane</h3><p>No selected pane is available in the current snapshot. Choose a pane from the layout list.</p></div>}
        {currentPane && model?.state === "ready" && snapshot?.ovisSnapshot && <OvisReadOnlySessionView snapshot={snapshot} selectedPaneId={selectedPaneId} screen={screen} stale={screenStale || sessionStale} onSelectPane={choosePane} />}
        {currentPane && model?.state === "selection-required" && <div className="empty-state"><h3>Pane layout unavailable</h3><p>The selected pane is not associated with a verified workspace and tab in this snapshot.</p></div>}
      </section>
    </div>
    <footer className="console-footer"><a href="/notices/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">Third-party notices</a></footer>
  </main>;
}
