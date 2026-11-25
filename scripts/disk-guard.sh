#!/bin/bash
# disk-guard.sh <path> <limit-percent> — the dev-loop timer's ExecCondition.
# Exit 0 when the filesystem holding <path> is below <limit> percent used;
# exit 1 at or above it (systemd then skips the unit: a skipped condition is not
# a failure, so the loop pauses instead of filling the last gigabytes).
# Exit 2 on anything unreadable: fail closed, never run on a guess.
# HG_DISK_PCT_FOR_TEST replaces the df reading (tests only).
set -euo pipefail
export LC_ALL=C

path="${1:-/home}"
limit="${2:-90}"

if [[ ! "$limit" =~ ^[0-9]+$ ]]; then
  echo "disk-guard: limit '${limit}' is not a whole number" >&2
  exit 2
fi

if [ -n "${HG_DISK_PCT_FOR_TEST:-}" ]; then
  pct="$HG_DISK_PCT_FOR_TEST"
else
  pct="$(df --output=pcent -- "$path" 2>/dev/null | tail -n 1 | tr -dc '0-9' || true)"
fi

if [[ ! "$pct" =~ ^[0-9]+$ ]]; then
  echo "disk-guard: cannot read the usage of ${path}" >&2
  exit 2
fi

if [ "$pct" -ge "$limit" ]; then
  echo "disk-guard: ${path} ${pct}% ≥ ${limit}% — skipping" >&2
  exit 1
fi
echo "disk-guard: ${path} ${pct}% < ${limit}%"
