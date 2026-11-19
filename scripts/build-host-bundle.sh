#!/usr/bin/env bash
# Đóng gói bộ cài host (mod + publisher) và đặt vào web root của gate để tải về.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
mkdir -p "$OUT/herdgate-host/mod"
cp -r "$DIR/app-mod/herdgate" "$OUT/herdgate-host/mod/"
cp -r "$DIR/plugin" "$OUT/herdgate-host/"
cp "$DIR/dist-readme.md" "$OUT/herdgate-host/README.md"
( cd "$OUT/herdgate-host" && zip -qr "$DIR/src/web/herdgate-host.zip" mod plugin README.md )
echo "src/web/herdgate-host.zip: $(stat -c%s "$DIR/src/web/herdgate-host.zip") bytes"
