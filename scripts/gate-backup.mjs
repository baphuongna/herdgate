#!/usr/bin/env node
// gate-backup — archive the gate's state so "the home machine dies" stops
// meaning "the fleet is gone" (docs/plans/vps-cutover.md, Phase A).
//
// The backup list is exactly the plan's: state.json, the SSH host key (the
// fleet's identity — lose it and every phone re-pairs), vapid.json (push
// identity), attachments/, pi-receipts/, tasks/. Everything sits beside the
// state file, so --state points at state.json and siblings are gathered.
//
// Every archive carries a manifest with per-entry sha256; --verify recomputes
// it byte for byte. An unverifiable backup is not a backup.
//
// No secrets are ever printed — names, hashes, sizes, modes only.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENTRIES = ["state.json", "ssh_host_ed25519.json", "vapid.json", "attachments", "pi-receipts", "tasks"];
const REQUIRED = new Set(["state.json"]);
const USAGE = "usage: gate-backup.mjs [--state <state.json>] [--out <dir>] [--keep N] [--verify <archive>]";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};
const die = (code, msg) => { console.error(msg); process.exit(code); };

const sha256 = (p) => {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
};
const sha256Tree = (p) => { // deterministic digest of a directory: sorted (rel, hash) lines
  const lines = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const cur = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(cur).isDirectory()) walk(cur, r);
      else lines.push(`${r} ${sha256(cur)}`);
    }
  };
  walk(p, "");
  return createHash("sha256").update(lines.join("\n")).digest("hex");
};

function verify(archive) {
  const manifestPath = join(archive, "manifest.json");
  if (!existsSync(manifestPath)) die(1, `verify: no manifest.json in ${archive}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let bad = 0;
  for (const [name, e] of Object.entries(manifest.entries ?? {})) {
    if (e.present === false) continue;
    const p = join(archive, name);
    if (!existsSync(p)) { console.log(`MISMATCH ${name}: missing from archive`); bad++; continue; }
    const digest = statSync(p).isDirectory() ? sha256Tree(p) : sha256(p);
    if (digest !== e.sha256) { console.log(`MISMATCH ${name}: sha256 differs (archive tampered or rotted)`); bad++; }
  }
  if (bad) die(1, `verify: ${bad} entr${bad === 1 ? "y" : "ies"} failed`);
  console.log(`verify OK: ${Object.values(manifest.entries ?? {}).filter((e) => e.present !== false).length} entries, sha256 match`);
}

function backup() {
  const stateFile = arg("state") ?? join(homedir(), ".local", "state", "herdgate", "state.json");
  const outDir = arg("out") ?? join(dirname(stateFile), "backups");
  const keep = Number(arg("keep") ?? 14);
  if (!Number.isInteger(keep) || keep < 1) die(2, `--keep must be an integer >= 1\n${USAGE}`);
  if (!existsSync(stateFile)) die(2, `gate-backup: state file not found: ${stateFile} (pass --state <state.json>)`);
  if (statSync(stateFile).isDirectory()) die(2, `gate-backup: --state must point at the state JSON file, not a directory`);

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const arc = join(outDir, `gate-${stamp}`);
  mkdirSync(arc, { recursive: true });
  const entries = {};
  for (const name of ENTRIES) {
    const src = join(dirname(stateFile), name);
    if (!existsSync(src)) { entries[name] = { present: false }; continue; }
    const dst = join(arc, name);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      for (const item of readdirSync(src)) {
        const s = join(src, item), d = join(dst, item);
        statSync(s).isDirectory() ? mkdirSync(d, { recursive: true }) : copyFileSync(s, d);
      }
      // Digest the ARCHIVED copy, never the live source: hot dirs (pi-receipts
      // lands continuously while the gate serves) race a source-side digest,
      // and the manifest's job is to describe exactly what would be restored.
      entries[name] = { present: true, kind: "dir", sha256: sha256Tree(dst), mode: 0o755 };
    } else {
      copyFileSync(src, dst);
      const mode = statSync(src).mode & 0o777;
      chmodSync(dst, mode); // never relax: the SSH host key must stay 0600
      entries[name] = { present: true, kind: "file", sha256: sha256(dst), size: statSync(dst).size, mode };
    }
  }
  for (const name of REQUIRED) if (entries[name]?.present !== true) die(2, `gate-backup: required ${name} went missing mid-run`);
  writeFileSync(join(arc, "manifest.json"), JSON.stringify({ v: 1, created: new Date().toISOString(), source: stateFile, entries }, null, 1) + "\n");
  writeFileSync(join(outDir, "_latest"), `gate-${stamp}\n`);
  chmodSync(arc, 0o700);

  const archives = readdirSync(outDir).filter((n) => n.startsWith("gate-")).sort();
  while (archives.length > keep) rmSync(join(outDir, archives.shift()), { recursive: true, force: true });
  const present = Object.values(entries).filter((e) => e.present).length;
  console.log(`backup OK: ${arc} (${present}/${ENTRIES.length} entries, keep ${keep})`);
}

if (arg("verify")) verify(arg("verify"));
else if (process.argv.length > 2 && !["--state", "--out", "--keep"].includes(process.argv[2])) die(2, USAGE);
else backup();
