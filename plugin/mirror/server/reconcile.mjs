// Mirror reconcile planning — pure. The watch loop feeds the remote fleet and
// the local mirror workspace's tabs in, and gets the smallest set of actions
// out. Ownership is by label convention: tabs named M:<paneId> in the mirror
// workspace belong to us, everything else is untouchable.

export const MIRROR_TAB_PREFIX = "M:";
export const MIRROR_CAP = 6; // mirrored panes per room — a sidebar, not a clone

/** Rank remote panes for mirroring: agent panes first (working, then blocked,
 *  then the rest), then plain terminals — stable within a class by pane id. */
export function rankPanes(panes) {
  const cls = (p) => {
    if (p?.agent) return p.status === "working" ? 0 : p.status === "blocked" ? 1 : 2;
    return 3;
  };
  return [...panes]
    .filter((p) => p && typeof p.id === "string" && p.id)
    .sort((a, b) => cls(a) - cls(b) || String(a.id).localeCompare(String(b.id)));
}

/** @param {{panes: {id: string, agent?: string|null, status?: string}[]}} remote
 *  @param {{tabId: string, label: string}[]} existingTabs of the mirror workspace
 *  @returns {{create: string[], close: {tabId: string, paneId: string}[], keep: string[]}} */
export function planMirrors(remote, existingTabs, cap = MIRROR_CAP) {
  const wanted = rankPanes(Array.isArray(remote?.panes) ? remote.panes : []).slice(0, cap).map((p) => p.id);
  const ours = (Array.isArray(existingTabs) ? existingTabs : [])
    .filter((t) => typeof t?.label === "string" && t.label.startsWith(MIRROR_TAB_PREFIX))
    .map((t) => ({ tabId: String(t.tabId), paneId: t.label.slice(MIRROR_TAB_PREFIX.length) }));
  const create = wanted.filter((id) => !ours.some((t) => t.paneId === id));
  const close = ours.filter((t) => !wanted.includes(t.paneId));
  const keep = ours.filter((t) => wanted.includes(t.paneId)).map((t) => t.paneId);
  return { create, close, keep };
}

/** The mirror workspace's label — the ownership marker. */
export function mirrorWorkspaceLabel(roomId) {
  return `🏠 ${String(roomId ?? "").slice(0, 16)}`;
}

/** The command line a fresh mirror tab runs. Single-quoted, env included —
 *  the tab's shell has none of the plugin's environment. */
export function streamCommandLine(configDir, selfDir, paneId) {
  const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
  return `HERDR_PLUGIN_CONFIG_DIR=${q(configDir)} node ${q(selfDir + "/index.mjs")} stream ${q(paneId)}`;
}
