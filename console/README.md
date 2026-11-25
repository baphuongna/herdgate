# Local Console frontend toolchain

This is an isolated **build-only** workspace. The runtime package remains Herdgate's Node process; do not run Vite, Bun's server, Ovis `src/main.tsx`, an Ovis server, or an upstream install script on the user's machine.

## Commands

From the repository root, with the pinned runtime first on `PATH`:

```sh
export PATH=/home/bom/.cache/herdgate-console-toolchain/bun-bin:/home/bom/.nvm/versions/node/v22.23.5/bin:$PATH
LC_ALL=C /home/bom/.nvm/versions/node/v22.23.5/bin/node console/tools/preflight.mjs

cd console
LC_ALL=C bun run build:console
```

The preflight exits `2` when any required version, direct dependency, lock consistency, entrypoint, or build config is missing. The build command refuses to run unless preflight is green, then runs Vite only inside `bwrap --unshare-net` with a cleared environment, isolated HOME/TMP, read-only source, and only `console/dist` writable. It passes `--configLoader runner` so Vite does not emit temporary config bundles beside the read-only config. Aliases that redirect Ovis state modules consume the full relative import ID and resolve to absolute worktree paths, avoiding duplicate module IDs. The build also refuses a symlinked `vendor/ovis/node_modules` before entering the sandbox. Output includes `console/dist/index.html`, hashed `/assets/`, notices and **`manifest.json` in the runtime service's `{ version, index, files: { urlPath: { path, type } } }` schema**; `notices/LICENSE` is manifest-allowlisted as `text/plain; charset=utf-8` and `THIRD_PARTY_NOTICES.md` as `text/markdown; charset=utf-8`. The app base is `/`, not `/console/`.

## Pinned dependencies and offline toolchain

`vendor/ovis/package.json` and `vendor/ovis/bun.lock` are the exact upstream-pinned manifest/lock (`bun@1.4.4`, lockfile v2); patched-dependency files are retained. The root manifest is unchanged. These packages are build inputs only; no Ovis server/runtime is copied into `dist`.

### Recreate the staged toolchain/cache without Internet or secrets

The build in this worktree used Node `v22.23.5` and the separately staged Bun `1.4.4` binary at `/home/bom/.cache/herdgate-console-toolchain/bun-1.4.4/bun-linux-x64/bun` (SHA-256 `10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235`, checked against Bun's official `SHASUMS256.txt`). The staged registry contains only lock-derived package metadata/tarballs; 249 lock package entries were checked against `bun.lock` SHA-512 integrity, and optional platform artifacts are included. The read-only `registry-stub.py` serves that staged tree only on `127.0.0.1:18777`; it has no credentials, write methods, or external-network path. Keep the binary, registry, and Bun cache in an approved local staging directory. Do not fetch/install globally, use a developer's npm credentials, run an Ovis installer, or allow lifecycle scripts.

For a fresh `node_modules` from already-staged artifacts, run the registry stub and Bun in the **same** isolated network namespace. This lets Bun reach loopback while denying all external networking; only the cache and `node_modules` are writable:

```sh
WORKTREE=/home/bom/source/herdgate-console-web
TOOLCHAIN=/home/bom/.cache/herdgate-console-toolchain
BUN="$TOOLCHAIN/bun-1.4.4/bun-linux-x64/bun"
mkdir -p "$WORKTREE/console/vendor/ovis/node_modules"
test "$("$BUN" --version)" = 1.4.4
printf '%s  %s\n' 10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235 "$BUN" | sha256sum -c -
bwrap --unshare-net --die-with-parent --ro-bind / / \
  --tmpfs /tmp --dir /tmp/herdgate-preload --dir /tmp/herdgate-preload/worktree \
  --dir /tmp/herdgate-preload/cache --dir /tmp/herdgate-preload/tools \
  --ro-bind "$WORKTREE" /tmp/herdgate-preload/worktree \
  --bind "$WORKTREE/console/vendor/ovis/node_modules" /tmp/herdgate-preload/worktree/console/vendor/ovis/node_modules \
  --bind "$TOOLCHAIN/cache-bun-1.4.4" /tmp/herdgate-preload/cache \
  --ro-bind "$BUN" /tmp/herdgate-preload/tools/bun \
  --ro-bind "$TOOLCHAIN/registry-stub.py" /tmp/herdgate-preload/registry-stub.py \
  --ro-bind "$TOOLCHAIN/local-registry" /tmp/herdgate-preload/registry \
  --tmpfs /home --tmpfs /root --tmpfs /run --dir /tmp/herdgate-preload/home \
  --proc /proc --dev /dev \
  --chdir /tmp/herdgate-preload/worktree/console/vendor/ovis --clearenv \
  --setenv PATH /tmp/herdgate-preload/tools:/usr/bin:/bin --setenv HOME /tmp/herdgate-preload/home \
  --setenv TMPDIR /tmp --setenv LC_ALL C --setenv CI 1 --setenv NPM_CONFIG_USERCONFIG /dev/null \
  -- /bin/sh -ec 'python3 /tmp/herdgate-preload/registry-stub.py /tmp/herdgate-preload/registry 18777 & registry_pid=$!; trap "kill $registry_pid 2>/dev/null || true" EXIT; sleep 1; /tmp/herdgate-preload/tools/bun install --registry=http://127.0.0.1:18777 --frozen-lockfile --ignore-scripts --cache-dir=/tmp/herdgate-preload/cache'
```

Then rerun preflight and the sandboxed build command above. `--ignore-scripts` suppresses root/dependency lifecycle scripts; an unavailable package makes the local registry return 404 instead of falling back to the Internet. No registry token or other secret is required.

### Verified build snapshot

With `PATH=/home/bom/.cache/herdgate-console-toolchain/bun-bin:/home/bom/.nvm/versions/node/v22.23.5/bin:$PATH`, preflight reported `buildReady: true`, 36/36 direct dependencies present, and zero blockers. `LC_ALL=C bun run build:console` completed in the network-isolated bubblewrap sandbox. It wrote `console/dist/index.html` and `{ version, index, files }` `manifest.json`; the manifest allowlists 99 files totaling 4,285,007 bytes (100 files in `dist`, including the manifest and two notices). The bundled JS is 819,209 bytes (SHA-256 `cab65eed9e3607278214ad5838d66ade514cd88a65c931d68245b3672b3a9d82`) and CSS is 185,729 bytes (SHA-256 `97e7e8222c984ee62a6bac70924b4e1723ac34360cb2a60b660edeb8256eb0d3`). Vite reports an expected bundle-size warning (>500 kB) and harmless stripped `use client` directives in lucide-react. The build output is ignored by Git (`/dist/`); rerun the command to reproduce it.

## Read-only settings, storage and CSP

The Ovis settings shim imports the pinned `DEFAULT_SETTINGS` without a `.ts` suffix (so Vite's `settings.ts` alias cannot alias the import back to the shim) and freezes a complete copy; its `update` callback is a no-op. The imported settings module is covered by a Vite SSR load test that traps `localStorage`, `sessionStorage`, and `fetch`; it performs no such access at module load. The entry installs a tab-local in-memory `localStorage`/`sessionStorage` replacement before mounting React. It restores original property descriptors when torn down; nothing Ovis writes survives reload.

The metadata CSP matches the runtime policy exactly. `'unsafe-inline'` is limited to `style-src` because xterm 6's DOM renderer creates inline style attributes and style elements for ANSI colors, bold, and underline. `script-src` remains `'self'`. External fetches initiated by CSS remain blocked: `img-src` and `font-src` only allow `'self'` (images additionally allow `data:`).

Chrome's regular (non-headless) password manager may offer “Save password?” for the one-time login code despite `autocomplete="off"`; verify that prompt manually in Chrome before release. Headless browser runs do not establish this behavior.

## Integration boundary

`console/src/entry.tsx` mounts the Herdgate shell (`ui.tsx`), which handles local login and runtime polling. Its selected-session view imports the pinned Ovis `TabStrip` and `PaneCanvas` source through `console/src/ovis/ReadOnlySessionView.tsx`; the terminal xterm surface is an attributed read-only port, not Ovis `PaneTerminal`. Workspace choice stays Herdgate-owned rather than importing Ovis `Sidebar` and its stored preferences/worktree features. The exact trace and capability boundary are documented in `console/patches/README.md`. The typed client adapts the a9a260f runtime schema and calls only `capabilities`, `auth/redeem`, `auth/logout`, `session`, and `pane/:id/screen`. The Vite machine-context alias hard-denies all Ovis machine API methods before transport; the entry-installed network guard permits only those typed local fetch routes (plus the two auth POSTs) and disables WebSocket/EventSource constructors. Node tests verify representative machine API rejections and route/socket blocking. Static build scanning is not a measured browser network trace.

## Build and ship

The npm package ships the built `console/dist/` artifact only: `manifest.json`, its allowlisted static assets, `notices/LICENSE`, and `notices/THIRD_PARTY_NOTICES.md`. It does not ship `console/vendor/`, `console/src/`, or `console/tools/`; the installed service needs only Node.js ≥22, not the Ovis checkout, Bun, or Vite.

Build the pinned frontend in the separately staged Console build environment with:

```sh
npm run build:console
```

That command uses the staged Bun 1.4.4 toolchain. `scripts/build-release.sh` deliberately does not invoke it: release packaging first validates `console/dist/`, packs to a temporary directory, and checks the real tar listing against the manifest and notices. A missing or invalid bundle blocks the release and prints the build command; it never fetches assets or silently ships an incomplete Console.

Windows lifecycle remains fail-closed (`console_windows_launcher_blocked`) until verified on the target Herdr App/runtime. Do not interpret the Linux fixture smoke test as Windows support.
