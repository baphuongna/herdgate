# Local Web Console — build and ship

## Ship contract

The npm package ships the built `console/dist/` artifact only: `manifest.json`, its allowlisted static assets, `notices/LICENSE`, and `notices/THIRD_PARTY_NOTICES.md`. It does not ship `console/vendor/`, `console/src/`, or `console/tools/`; the installed service needs only Node.js ≥22, not the Ovis checkout, Bun, or Vite.

Build the pinned frontend in the separately staged Console build environment with:

```sh
npm run build:console
```

That command uses the staged Bun 1.4.4 toolchain. `scripts/build-release.sh` deliberately does not invoke it: release packaging first validates `console/dist/`, packs to a temporary directory, and checks the real tar listing against the manifest and notices. A missing or invalid bundle blocks the release and prints the build command; it never fetches assets or silently ships an incomplete Console.

Windows lifecycle remains fail-closed (`console_windows_launcher_blocked`) until verified on the target Herdr App/runtime. Do not interpret the Linux fixture smoke test as Windows support.
