#!/usr/bin/env bash
# Build a fresh, deployable release set; never use local config, installed dependencies or live state.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
[[ $# -le 1 ]] || { echo 'usage: build-release.sh [output-directory]' >&2; exit 2; }
VERSION=$(node -p 'require("./package.json").version')
DEST=${1:-"$ROOT/dist/$VERSION"}
[[ "$DEST" = /* ]] || DEST="$ROOT/$DEST"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  echo "release output already exists: $DEST" >&2
  exit 1
fi
mkdir -p "$(dirname "$DEST")"
STAGE=$(mktemp -d "$(dirname "$DEST")/.herdgate-release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/release"
OUT="$STAGE/release"
NAME="herdgate-cloud-$VERSION"
CLOUD="$STAGE/$NAME"
mkdir -p "$CLOUD/runtime/web/icons" "$CLOUD/scripts"

npm run build:cloud -- --outDir "$CLOUD/runtime"
cp src/web/{index.html,app.js,app.css,app.webmanifest,sw.js,e2e.js,push-decision.js,admin.html,admin.js,admin.css,admin-model.js} "$CLOUD/runtime/web/"
cp src/web/icons/{icon.svg,icon-192.png,icon-512.png} "$CLOUD/runtime/web/icons/"
cp templates/cloud/{Dockerfile,compose.yml,compose.env.example,.dockerignore,herdgate-cloud.service,herdgate-cloud-edge.service,Caddyfile.example,README.md} "$CLOUD/"
cp templates/cloud/gitignore.example "$CLOUD/.gitignore"
cp scripts/patch-ssh2.mjs "$CLOUD/scripts/"
cp package-lock.json "$CLOUD/"
# Use the same versions and lock as npm, without the host installer or Pi postinstall.
node --input-type=module - "$CLOUD/package.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const { name, version, type, engines, dependencies } = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = { start: 'node runtime/cloud/main.js', 'ssh-tcp-edge': 'node runtime/cloud/ssh-tcp-edge.js' };
writeFileSync(process.argv[2], JSON.stringify({ name, version, type, engines, private: true, scripts, dependencies }, null, 2) + '\n');
NODE

HOST="herdgate-host-$VERSION.zip"
bash scripts/build-host-bundle.sh "$OUT/$HOST"
cp "$OUT/$HOST" "$CLOUD/runtime/web/herdgate-host.zip"
tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
# The npm tarball is packed with --ignore-scripts (no prepack), so build the compiled cloud it
# ships — the one `herdgate cloud serve` runs from an install — right here, explicitly.
npm run -s build:cloud
npm pack --ignore-scripts --pack-destination "$OUT"
PACK=$(find "$OUT" -maxdepth 1 -type f -name '*.tgz' -print -quit)
[[ -n "$PACK" ]] || { echo 'Release check failed: npm pack did not produce a .tgz' >&2; exit 1; }
tar -tzf "$PACK" > "$STAGE/npm-pack-files.txt"
( cd "$OUT" && sha256sum -- *.tar.gz *.tgz *.zip > SHA256SUMS )
# Move the complete set into place; don't nest or replace an existing release.
mkdir -- "$DEST"
mv -- "$OUT/"* "$DEST/"
printf 'Herdgate %s: %s\n' "$VERSION" "$DEST"
