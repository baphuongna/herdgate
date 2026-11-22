// Listening-port attribution via process ancestry (see docs/research/
// 2026-11-21-marketplace/deep/portfwd.md — mechanism from herdr-portfwd
// src/discover.rs `ProcessTree::ancestry` + `attribute`, MIT). No lsof/ss/ps
// subprocesses: /proc/net/tcp + /proc/net/tcp6 supply LISTEN sockets with
// their inodes, /proc/<pid>/fd readlinks match inode → owning pid, and a ppid
// walk (cycle-guarded, depth-capped, pid 0 filtered — the kernel is never a
// shell) attributes the port to the session shell it descends from.
// A listener no shell owns lands in `unattributed` — an owner is never
// invented. Torn-safe: pids and fds that vanish or are unreadable mid-scan
// are skipped, never fail the batch.

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ANCESTRY_DEPTH = 32;
const SOCKET_INODE = /^socket:\[(\d+)\]$/;

/** {pid → key} from a mixed list of pids and {pid, key} entries; first wins. */
function shellIndex(shellPids) {
  const shells = new Map();
  for (const entry of Array.isArray(shellPids) ? shellPids : []) {
    const pid = typeof entry === 'number' ? entry : entry?.pid;
    const key = typeof entry === 'number' ? String(entry) : entry?.key ?? String(entry?.pid);
    if (Number.isInteger(pid) && pid > 0 && !shells.has(pid)) shells.set(pid, key);
  }
  return shells;
}

/**
 * /proc/net/tcp(6) LISTEN rows → [{port, proto, inode}]. st "0A" is
 * TCP_LISTEN; the inode is field 10 (parts[9]); the port is the hex half of
 * the local address. Unreadable tables are skipped, not fatal.
 */
function listeningSockets(procDir, file, proto) {
  const rows = [];
  let text;
  try {
    text = readFileSync(join(procDir, file), 'utf8');
  } catch {
    return rows;
  }
  for (const line of text.split('\n').slice(1)) { // header row: "  sl local_address …"
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || parts[3] !== '0A') continue;
    const port = Number.parseInt(parts[1].split(':')[1] ?? '', 16);
    const inode = Number(parts[9]);
    if (Number.isInteger(port) && port > 0 && Number.isInteger(inode) && inode > 0) {
      rows.push({ port, proto, inode });
    }
  }
  return rows;
}

/**
 * One pass over numeric /proc entries: stat (ppid + comm) and fd readlinks.
 * Returns {ppid: Map, comm: Map, byInode: Map inode → pid} — torn-safe.
 */
function scanProcesses(procDir, wantedInodes) {
  const ppid = new Map();
  const comm = new Map();
  const byInode = new Map();
  let names;
  try {
    names = readdirSync(procDir);
  } catch {
    return { ppid, comm, byInode };
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat;
    try {
      stat = readFileSync(join(procDir, name, 'stat'), 'utf8');
    } catch {
      continue; // pid vanished mid-scan — skipped, batch keeps going
    }
    const close = stat.lastIndexOf(')');
    const rest = stat.slice(close + 1).trim().split(/\s+/);
    const parent = Number(rest[1]);
    if (Number.isFinite(parent) && parent > 0) ppid.set(pid, parent); // pid 0 filtered
    if (close > 0) comm.set(pid, stat.slice(stat.indexOf('(') + 1, close));
    let fds;
    try {
      fds = readdirSync(join(procDir, name, 'fd'));
    } catch {
      continue; // no permission / raced away — ppid still counted
    }
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(join(procDir, name, 'fd', fd));
      } catch {
        continue;
      }
      const match = SOCKET_INODE.exec(target);
      if (!match) continue;
      const inode = Number(match[1]);
      if (wantedInodes.has(inode) && !byInode.has(inode)) byInode.set(inode, pid);
    }
  }
  return { ppid, comm, byInode };
}

function commandOf(procDir, pid, comm) {
  try {
    const cmdline = readFileSync(join(procDir, String(pid), 'cmdline'), 'utf8');
    const text = cmdline.split('\0').filter(Boolean).join(' ');
    if (text) return text;
  } catch {
    /* fall through to comm */
  }
  return comm.get(pid) ?? '';
}

/**
 * Attribute listening ports to session shells. shellPids: pids or {pid, key}
 * entries — the key of the matched shell comes back as ownerKey. Returns
 *   {attributed: [{port, proto, pid, cmd, ownerKey}], unattributed: [{port,
 *   proto, pid?, cmd?}]} — sorted by (port, proto), deduped. The owning pid is
 * the process holding the socket; the owner is the shell it descends from.
 * Never invents an owner: unattributed listeners stay unattributed. Missing
 * /proc → empty lists; never throws.
 */
export function attributePorts(shellPids, procDir = '/proc') {
  const shells = shellIndex(shellPids);
  const sockets = [
    ...listeningSockets(procDir, 'net/tcp', 'tcp'),
    ...listeningSockets(procDir, 'net/tcp6', 'tcp6'),
  ];
  const { ppid, comm, byInode } = scanProcesses(procDir, new Set(sockets.map(s => s.inode)));

  const attributed = [];
  const unattributed = [];
  const seenAttributed = new Set();
  const seenUnattributed = new Set();
  for (const { port, proto, inode } of sockets.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))) {
    const pid = byInode.get(inode);
    if (!Number.isInteger(pid)) {
      const id = `${port}/${proto}`;
      if (!seenUnattributed.has(id)) {
        seenUnattributed.add(id);
        unattributed.push({ port, proto }); // socket owner not observable (no fd access)
      }
      continue;
    }
    // ppid walk back to a shell: cycle-guarded, depth-capped, pid 0 filtered.
    let ownerKey;
    let cur = pid;
    const walked = new Set();
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
      if (shells.has(cur)) { ownerKey = shells.get(cur); break; }
      if (walked.has(cur)) break;
      walked.add(cur);
      cur = ppid.get(cur);
      if (!Number.isInteger(cur) || cur <= 0) break;
    }
    if (ownerKey !== undefined) {
      const id = `${port}/${proto}/${pid}`;
      if (!seenAttributed.has(id)) {
        seenAttributed.add(id);
        attributed.push({ port, proto, pid, cmd: commandOf(procDir, pid, comm), ownerKey });
      }
    } else {
      const id = `${port}/${proto}/${pid}`;
      if (!seenUnattributed.has(id)) {
        seenUnattributed.add(id);
        unattributed.push({ port, proto, pid, cmd: commandOf(procDir, pid, comm) });
      }
    }
  }
  return { attributed, unattributed };
}
