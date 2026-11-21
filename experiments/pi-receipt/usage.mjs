#!/usr/bin/env node
// Host-local usage roll-up over the Pi receipt journal — the "what did the
// herd burn this week" view: a daily request/cost table, per-principal spend
// and one total line. The core lives in plugin/server/pi-usage.mjs (shared,
// fail-closed); this CLI only formats. Colors on TTY only, --json for scripts.
//
//   node experiments/pi-receipt/usage.mjs [--base DIR] [--days N] [--json]

import { usageRollup } from '../../plugin/server/pi-usage.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
};
const opt = name => process.argv.includes(`--${name}`);

const base = arg('base') ?? `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/herdgate/pi-receipts`;
const parsedDays = Number(arg('days', '7'));
const rollup = usageRollup({ base, days: Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7 });

if (opt('json')) {
  console.log(JSON.stringify(rollup));
  process.exit(0);
}

const tty = process.stdout.isTTY;
const bold = s => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = s => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const num = v => v.toLocaleString('en-US');
const usd = v => `$${v.toFixed(4)}`;
const when = ts => `${new Date(ts).toISOString().replace('T', ' ').slice(0, 16)}Z`;

function table(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const line = cells => cells.map((c, i) => String(c)[i === 0 ? 'padEnd' : 'padStart'](widths[i])).join('  ');
  console.log(bold(line(header)));
  for (const row of rows) console.log(line(row));
}

console.log(bold(`Days (last ${rollup.days.length})`));
table(['date', 'req', 'replied', 'failed', 'tokens', '$'],
  rollup.days.map(d => [d.date, d.requests, d.replied, d.failed, num(d.tokens), usd(d.costUsd)]));

console.log(`\n${bold('By principal')}`);
if (rollup.byPrincipal.length) {
  table(['principal', 'req', 'replied', 'failed', 'tokens', '$', 'last'],
    rollup.byPrincipal.map(p => [p.principal, p.requests, p.replied, p.failed, num(p.tokens), usd(p.costUsd), when(p.lastTs)]));
} else {
  console.log(dim('(no receipts)'));
}

const t = rollup.total;
console.log(`\n${bold('Total')}  ${t.requests} requests · replied ${t.replied} · failed ${t.failed} · canceled ${t.canceled} · unknown ${t.unknown} · ${num(t.tokens)} tokens · ${usd(t.costUsd)}`);
