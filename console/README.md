# Local Console frontend toolchain

This is an isolated **build-only** workspace. The runtime package remains Herdgate's Node process; do not run Vite, Bun's server, Ovis `src/main.tsx`, an Ovis server, or an upstream install script on the user's machine.

## Commands

From the repository root, with the pinned runtime first on `PATH`:

```sh
LC_ALL=C PATH=/home/bom/.nvm/versions/node/v22.23.5/bin:$PATH \
  /home/bom/.nvm/versions/node/v22.23.5/bin/node console/tools/preflight.mjs

cd console
LC_ALL=C PATH=/home/bom/.nvm/versions/node/v22.23.5/bin:$PATH bun run build:console
```

The preflight exits `2` when any required version, direct dependency, lock consistency, entrypoint, or build config is missing. The build command refuses to run unless preflight is green, then runs Vite only inside `bwrap --unshare-net` with a cleared environment, isolated HOME/TMP, read-only source, and only `console/dist` writable. If bubblewrap is unavailable, it refuses to build unsandboxed. The output is `console/dist/index.html`, hashed `/assets/`, bundled notices, and `asset-manifest.json`; the manifest is the static-file allowlist. The app base is `/`, not `/console/`.

## Pinned dependencies and preload (not performed here)

`vendor/ovis/package.json` and `vendor/ovis/bun.lock` are the exact upstream-pinned manifest/lock (`bun@1.4.4`, lockfile v2); the upstream patched-dependency files are retained. The upstream dependency manifest includes build and non-shipped Ovis packages so the frozen upstream lock can be used unchanged. These packages are build inputs only; no Ovis server/runtime is copied into `dist`. `console/package.json` intentionally declares no duplicate dependency graph and does not modify the root package.

Preload only from an already-approved offline dependency cache and a locally staged Bun 1.4.4 binary. Do **not** fetch, install globally, use a developer's npm credentials, run any Ovis installer, or run package lifecycle scripts. Set the paths to those local staged inputs, create the isolated `node_modules` destination, and run this frozen, networkless install:

```sh
WORKTREE=/home/bom/source/herdgate-console-web
BUN=/opt/herdgate-toolchain/bun-1.4.4
CACHE=/opt/herdgate-console-cache/bun-1.4.4
mkdir -p "$WORKTREE/console/vendor/ovis/node_modules" "$CACHE"
test "$("$BUN" --version)" = 1.4.4
bwrap --unshare-net --die-with-parent --ro-bind / / \
  --tmpfs /tmp --dir /tmp/herdgate-preload --dir /tmp/herdgate-preload/worktree \
  --dir /tmp/herdgate-preload/cache --dir /tmp/herdgate-preload/tools \
  --ro-bind "$WORKTREE" /tmp/herdgate-preload/worktree \
  --bind "$WORKTREE/console/vendor/ovis/node_modules" /tmp/herdgate-preload/worktree/console/vendor/ovis/node_modules \
  --bind "$CACHE" /tmp/herdgate-preload/cache \
  --ro-bind "$BUN" /tmp/herdgate-preload/tools/bun \
  --tmpfs /home --tmpfs /root --tmpfs /run --dir /tmp/herdgate-preload/home \
  --proc /proc --dev /dev \
  --chdir /tmp/herdgate-preload/worktree/console/vendor/ovis --clearenv \
  --setenv PATH /tmp/herdgate-preload/tools:/usr/bin:/bin --setenv HOME /tmp/herdgate-preload/home \
  --setenv TMPDIR /tmp --setenv LC_ALL C --setenv CI 1 \
  -- /tmp/herdgate-preload/tools/bun install --frozen-lockfile --ignore-scripts --cache-dir=/tmp/herdgate-preload/cache
```

If anything is absent from the staged cache, the isolated install fails rather than reaching the network. Confirm the Bun lock still matches the package manifest by rerunning preflight. The `--ignore-scripts` flag suppresses root and dependency lifecycle scripts; the private cache and `node_modules` are the only writable install destinations. After preload, run the build command above; it independently denies networking and does not inherit credentials or user configuration.

## Current preflight snapshot

This worktree was inspected with Node `v22.23.5`. Bun on `PATH` is `/home/bom/.local/bin/bun` version `1.3.13`, not required `1.4.4`. `vendor/ovis/bun.lock` is 66,172 bytes, lockfile v2, SHA-256 `d4e40245456c0d874a7f0af1ef45aa47fa2256c465a3995866d260f6f442ad47`, and matches the pinned package manifest. The default Bun cache `/home/bom/.bun/install/cache` has 11 opaque files totaling 2,532,574 bytes; it does not identify installed packages. All 36 pinned direct Ovis dependencies are missing under `vendor/ovis/node_modules`, including React `^19.3.0`, xterm `6.0.0`, addon-fit `0.11.0`, Vite `^8.3.4`, and the remaining app/build dependencies. No install or network fetch has been attempted.

## Integration boundary

`console/src/ui.tsx` provides the local login, workspace/tab/pane selection, refresh gating, explicit offline/ambiguous states, and read-only ANSI mirror. It uses the same pinned Ovis `@xterm/xterm` and fit addon used by Ovis terminal UI; it does **not** mount Ovis `App` or `PaneTerminal`, whose current APIs attach Ovis's WebSocket and expose input/write operations. The typed Herdgate client calls only `capabilities`, `auth/redeem`, `auth/logout`, `session`, and `pane/:id/screen`; unsupported writes are not implemented. This adapter surface is tested against the worktree HTTP fixture. It is not evidence of a production daemon endpoint, a built bundle, or a browser-level zero-egress test.
