#!/usr/bin/env node
// Host-local GC for the Pi receipt journal — the "Luggage" sweep: receipts
// older than --days (default 90) go, except unknown ones (fail-closed: unclear
// evidence stays) and receipts a device still watches. Orphan watch intents are
// retired too. Dry-run by default; --apply actually deletes (tmp+rename all the
// way down). The core lives in plugin/server/pi-receipt-gc.mjs (shared,
// fail-closed); this CLI only formats. Colors on TTY only, --json for scripts.
//
//   node experiments/pi-receipt/gc.mjs [--base DIR] [--days N] [--apply] [--json]

import { gcJournal } from '../../plugin/server/pi-receipt-gc.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
};
const opt = name => process.argv.includes(`--${name}`);

const base = arg('base') ?? `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/herdgate/pi-receipts`;
const parsedDays = Number(arg('days', '90'));
const report = gcJournal({
  base,
  days: Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 90,
  apply: opt('apply'),
});

if (opt('json')) {
  console.log(JSON.stringify(report));
  process.exit(0);
}

const tty = process.stdout.isTTY;
const bold = s => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = s => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const when = ts => `${new Date(ts).toISOString().replace('T', ' ').slice(0, 16)}Z`;
const kb = bytes => (bytes / 1024).toFixed(1);

console.log(bold(`Receipt journal GC ${opt('apply') ? '(apply)' : '(dry run)'} — ${dim(base)}, receipts older than ${Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 90} days`));

function table(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const line = cells => cells.map((c, i) => String(c)[i === 0 || i === 1 ? 'padEnd' : 'padStart'](widths[i])).join('  ');
  console.log(bold(line(header)));
  for (const row of rows) console.log(line(row));
}

if (report.candidates.length) {
  table(['id', 'scope', 'date', 'status', 'KB'],
    report.candidates.map(c => [c.id, c.scope, when(c.ts), c.status, kb(c.bytes)]));
} else {
  console.log(dim('(no candidates — nothing older than the window)'));
}

console.log(`\n${bold('Total')}  ${report.candidates.length} candidates · ${kb(report.bytesReclaimable)} KB reclaimable · keptUnknown ${report.keptUnknown} (old unknown receipts are kept — fail-closed)`);
if (report.orphanCursors.length) {
  console.log(`${bold('Orphan cursors')}  ${report.orphanCursors.length} watch intent(s) pointing at receipts no journal holds${opt('apply') ? ' — retired' : ' — retired with --apply'}`);
}
for (const error of report.errors) {
  console.log(dim(`error: ${error.scope ?? '(base)'} ${error.code}`));
}
if (report.applied) {
  console.log(`\n${bold('Applied')} — deleted ${report.deleted} receipts, freed ${kb(report.bytesFreed)} KB.`);
} else {
  console.log(`\n${dim('Dry run — re-run with --apply to delete.')}`);
}
