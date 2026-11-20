#!/usr/bin/env bash
# The default still puts the bundle in the PWA's web root. For staging, pass a ZIP path.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
[[ $# -le 1 ]] || { echo "usage: build-host-bundle.sh [output.zip]" >&2; exit 2; }
DEST=${1:-"$DIR/src/web/herdgate-host.zip"}
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
mkdir -p "$OUT/host/mod/herdgate" "$OUT/host/plugin/server" "$OUT/host/windows" "$OUT/host/templates"
cp "$DIR/app-mod/herdgate/"{main.js,mod.json,herdgate.svg} "$OUT/host/mod/herdgate/"
cp "$DIR/plugin/herdr-plugin.toml" "$OUT/host/plugin/"
cp "$DIR/plugin/server/"*.mjs "$OUT/host/plugin/server/"
cp "$DIR/windows/"*.mjs "$OUT/host/windows/"
cp "$DIR/templates/herdgate-via.mjs" "$OUT/host/templates/"
cp "$DIR/dist-readme.md" "$OUT/host/README.md"
( cd "$OUT/host" && zip -qr "$OUT/host.zip" mod plugin windows templates README.md )
mkdir -p "$(dirname "$DEST")"
mv -- "$OUT/host.zip" "$DEST"
printf '%s\n' "$DEST"
