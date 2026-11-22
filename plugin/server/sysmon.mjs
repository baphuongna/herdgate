// Per-machine /proc sampler: CPU/RAM attribution for process trees (Pi session
// shells and their descendants), no cgroups and no dependencies — plain fs.
// Mechanism ported from herdr-pc-ram-and-cpu-usage-overlay (MIT, EZCorp; see
// docs/research/2026-11-21-marketplace/deep/ram.md): one scan_proc() pass over
// /proc/<pid>/stat per call, parse_stat() cutting after the LAST ')' (comm may
// contain spaces and parens), subtree() DFS with a visited set, and
// delta_jiffies() with the cutime/cstime 3-case so short-lived children — cargo
// test, spawned build tools — still count:
//   alive in both scans  → after - before
//   born inside window   → whole jiffies (all of it happened in the window)
//   died inside window   → its before-jiffies are subtracted, because the
//                          kernel folded its whole lifetime into the cutime of
//                          a still-living ancestor (ppid walk through pids that
//                          vanished too, cycle-guarded and depth-capped).
// CPU is a share of the whole machine: ΣΔjiffies / CLK_TCK / elapsed_s / nproc
// × 100, clamped to [0, 100]. RAM is the Σ statm resident field × page size.
// Torn-safe: a pid that disappears mid-scan is skipped, never fails the batch;
// a missing /proc yields [] rather than a throw.

import { readdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

const MAX_WALK_DEPTH = 32; // ppid-ancestry walks: cycle guard + depth cap
const DEFAULT_CLK_TCK = 100; // USER_HZ on mainstream Linux
const DEFAULT_PAGE_SIZE = 4096; // statm counts pages, not bytes

/**
 * Parse /proc/<pid>/stat. The comm field is parenthesized and may itself
 * contain spaces and parentheses, so fields are read after the LAST ')'.
 * Returns {pid, ppid, utime, stime, cutime, cstime, jiffies, comm} or null.
 */
export function parseStat(text) {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const open = text.indexOf('(');
  const pid = Number(text.slice(0, open).trim());
  const comm = open >= 0 && close > open ? text.slice(open + 1, close) : '';
  // rest[0]=state rest[1]=ppid … rest[11]=utime rest[12]=stime
  // rest[13]=cutime rest[14]=cstime (fields 3..17 of the stat line)
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const cutime = Number(rest[13]);
  const cstime = Number(rest[14]);
  if (!Number.isInteger(pid) || !Number.isFinite(ppid) || !Number.isFinite(utime)
    || !Number.isFinite(stime) || !Number.isFinite(cutime) || !Number.isFinite(cstime)) return null;
  return { pid, ppid, comm, utime, stime, cutime, cstime, jiffies: utime + stime + cutime + cstime };
}

/**
 * One pass over procDir: every numeric /proc entry's stat, torn-safe (a pid
 * that vanishes between readdir and read is skipped). Returns Map pid → stat.
 */
export function scanProc(procDir) {
  const scan = new Map();
  let names;
  try {
    names = readdirSync(procDir);
  } catch {
    return scan;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let text;
    try {
      text = readFileSync(join(procDir, name, 'stat'), 'utf8');
    } catch {
      continue; // pid vanished mid-scan — drop it, do not fail the batch
    }
    const stat = parseStat(text);
    if (stat && stat.pid === pid) scan.set(pid, stat);
  }
  return scan;
}

/** ppid → [child pids] graph from one scan. */
export function childrenMap(scan) {
  const map = new Map();
  for (const stat of scan.values()) {
    if (!map.has(stat.ppid)) map.set(stat.ppid, []);
    map.get(stat.ppid).push(stat.pid);
  }
  return map;
}

/** DFS from a root over the children graph, visited-set guarded against cycles. */
export function subtreeOf(rootPid, children) {
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return seen;
}

/**
 * The nearest ancestor of a dead pid that is still alive in the after-scan —
 * the process whose cutime absorbed the dead pid's folded lifetime CPU. Walks
 * the ppid chain through pids that vanished too; pid 0 (kernel) ends the walk;
 * cycle-guarded, depth-capped. Returns the pid or undefined.
 */
function livingAncestor(deadPid, before, after) {
  let cur = before.get(deadPid)?.ppid ?? 0;
  const seen = new Set([deadPid]);
  for (let depth = 0; cur > 0 && depth < MAX_WALK_DEPTH; depth++) {
    if (seen.has(cur)) return undefined; // cycle in garbage data — give up, not up
    if (after.has(cur)) return cur;
    seen.add(cur);
    cur = before.get(cur)?.ppid ?? 0;
  }
  return undefined;
}

/**
 * delta_jiffies between two scans for one root's subtrees (3-case; see module
 * header). The subtraction for the dead case only applies when the absorbing
 * living ancestor is itself inside the after-subtree — if the fold landed on a
 * process outside the measured tree, the CPU left the tree with the child.
 */
export function deltaJiffies(before, after, subBefore, subAfter) {
  let total = 0;
  for (const pid of subAfter) {
    const now = after.get(pid);
    const was = before.get(pid);
    total += was ? now.jiffies - was.jiffies : now.jiffies; // alive / born-in-window
  }
  for (const pid of subBefore) {
    if (after.has(pid)) continue; // still alive — already covered above
    const ancestor = livingAncestor(pid, before, after);
    if (ancestor !== undefined && subAfter.has(ancestor)) total -= before.get(pid).jiffies;
  }
  return total;
}

/** Σ statm resident field (field 2, pages) × page size; unreadable pids count 0. */
function sumRss(procDir, pids, pageSize) {
  let bytes = 0;
  for (const pid of pids) {
    try {
      const fields = readFileSync(join(procDir, String(pid), 'statm'), 'utf8').trim().split(/\s+/);
      const resident = Number(fields[1]);
      if (Number.isFinite(resident)) bytes += resident * pageSize;
    } catch {
      continue;
    }
  }
  return bytes;
}

// Per-procDir sampling state: the previous scan and its clock reading. The
// caller sets the cadence (daemon-style refresh); the first call is a baseline
// with cpuPct 0, every later call is the delta against the stored scan.
const state = new Map();

function readdirable(dir) {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sample CPU/RAM for every root's process tree. roots: [{pid, key}] — pid is
 * the tree root (a session shell), key travels back on the result row:
 *   [{key, cpuPct, ramBytes, procs}]
 * cpuPct is a share of the whole machine (0..100, clamped); ramBytes sums
 * statm RSS over the live subtree; procs counts live subtree members. A root
 * that vanished returns zeros; a missing procDir returns []. Never throws.
 * opts: {clkTck, nproc, pageSize, clock} — all injectable for deterministic
 * tests (defaults: 100, os.cpus().length, 4096, Date.now).
 */
export function sysSnapshot(roots, procDir = '/proc', opts = {}) {
  const list = Array.isArray(roots) ? roots : [];
  const scan = scanProc(procDir);
  if (scan.size === 0 && !readdirable(procDir)) return []; // no /proc → [], never a throw
  const previous = state.get(procDir);
  const clock = typeof opts.clock === 'function' ? opts.clock : Date.now;
  const now = clock();
  const clkTck = Number.isFinite(opts.clkTck) && opts.clkTck > 0 ? opts.clkTck : DEFAULT_CLK_TCK;
  const nproc = Number.isFinite(opts.nproc) && opts.nproc > 0 ? opts.nproc : cpus().length;
  const pageSize = Number.isFinite(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : DEFAULT_PAGE_SIZE;

  const children = childrenMap(scan);
  const results = [];
  for (const root of list) {
    const pid = Number(typeof root === 'object' ? root?.pid : root);
    const key = typeof root === 'object' ? root?.key : String(pid);
    // A root missing from the scan has no subtree at all (subtreeOf would
    // otherwise count the root itself while the delta loop has no stat for it).
    const sub = Number.isInteger(pid) && scan.has(pid) ? subtreeOf(pid, children) : new Set();
    let cpuPct = 0;
    if (previous && sub.size) {
      const elapsedS = (now - previous.at) / 1000;
      if (elapsedS > 0 && previous.scan.has(pid)) {
        const subBefore = subtreeOf(pid, childrenMap(previous.scan));
        const delta = deltaJiffies(previous.scan, scan, subBefore, sub);
        cpuPct = Math.min(100, Math.max(0, (delta / clkTck / elapsedS / nproc) * 100));
      }
    }
    results.push({ key, cpuPct, ramBytes: sumRss(procDir, sub, pageSize), procs: sub.size });
  }
  state.set(procDir, { scan, at: now });
  return results;
}
