// Fleet panel rendering — pure. The pane command feeds a fleet.detail.result
// payload in and gets lines out; tests do the same without a Herdr.

const STATUS_GLYPH = { working: "▶", blocked: "⚠", idle: "·", unknown: "·", waiting: "…" };

function clip(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** @returns {string[]} the panel's lines */
export function drawFleet(fleet, { room = "", ageMs = null, error = null } = {}) {
  const lines = [];
  const roomTag = room ? String(room).slice(0, 24) : "—";
  lines.push(`🏠 herdgate mirror — room ${roomTag}`);
  if (error) {
    lines.push(`lỗi: ${clip(error, 70)}`);
    lines.push("đang thử lại… · q đóng · r làm mới ngay");
    return lines;
  }
  const agents = Array.isArray(fleet?.agents) ? fleet.agents : [];
  const panes = Array.isArray(fleet?.panes) ? fleet.panes : [];
  const herdr = typeof fleet?.herdr === "string" ? fleet.herdr : "?";
  const age = ageMs === null || !Number.isFinite(ageMs) ? "?" : `${Math.max(0, Math.round(ageMs / 1000))}s`;
  lines.push(`herdr ${clip(herdr, 40)} · cập nhật ${age} trước`);
  const count = (s) => agents.filter((a) => a?.status === s).length;
  lines.push(`agents (${agents.length}): working ${count("working")} · blocked ${count("blocked")}`);
  for (const a of agents.slice(0, 12)) {
    lines.push(`  ${clip(a.agent ?? "?", 10).padEnd(10)} ${(STATUS_GLYPH[a.status] ?? "·")} ${clip(a.status, 8).padEnd(8)} ${clip(a.pane, 8).padEnd(8)} ${clip(a.title, 34)}`);
  }
  if (agents.length > 12) lines.push(`  … +${agents.length - 12} agent khác`);
  lines.push(`panes (${panes.length}):`);
  for (const p of panes.slice(0, 16)) {
    const tag = p.agent ? `[${clip(p.agent, 6)}]` : "[term ]";
    lines.push(`  ${clip(p.id, 8).padEnd(8)} ${tag} ${clip(p.title, 44)}`);
  }
  if (panes.length > 16) lines.push(`  … +${panes.length - 16} pane khác`);
  lines.push("");
  lines.push("q đóng · r làm mới");
  return lines;
}

/** fleet.detail.result arrives over the wire; keep only shapes the panel draws. */
export function sanitizeFleet(payload) {
  if (!payload || typeof payload !== "object") return { agents: [], panes: [], herdr: "?" };
  const clean = (list, max) => (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x === "object")
    .slice(0, max)
    .map((x) => ({
      agent: typeof x.agent === "string" ? x.agent : null,
      status: typeof x.status === "string" ? x.status : "unknown",
      pane: typeof x.pane === "string" ? x.pane : "",
      id: typeof x.id === "string" ? x.id : "",
      title: typeof x.title === "string" ? x.title : "",
      cwd: typeof x.cwd === "string" ? x.cwd : "",
    }));
  return {
    herdr: typeof payload.herdr === "string" ? payload.herdr.slice(0, 64) : "?",
    takenAt: typeof payload.takenAt === "string" ? payload.takenAt : "",
    agents: clean(payload.agents, 64),
    panes: clean(payload.panes, 128),
  };
}
