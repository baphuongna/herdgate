# experiments/ovis-fork — F0/F1 spike (26/11/2026)

Proof that the fork works: the **unmodified** Ovis app (`devswha/ovis` @ `fe3058a3`, 0.5.9) builds offline and
runs on the real Herdr session through a Herdgate transport, as a watching device. Spec: `docs/specs/2026-11-26-ovis-frontend-fork.md`.

Throwaway tools, kept as the starting point for F2 (they are not shipped and not imported by anything).

| File | Role |
| --- | --- |
| `tools/finish-demo.mjs` | Bundles upstream's own `site/demo/transport.ts` and injects it before the app (what `scripts/build-site.ts` does) — the reference backend. |
| `tools/hg-recorder.js` | Records every `fetch` / `WebSocket` / `EventSource` the app uses, in order; `window.__hgMode = "fail"` answers 503 for `/api/*`. |
| `tools/boot-contract.mjs` | Loads the app in headless Chrome over CDP and prints the measured boot contract. |
| `tools/src/herdgate-transport.ts` | F1: Herdgate's backend replacement (watch role; reads `/hg/*`; refuses writes). |
| `tools/hg-source.mjs` | F1 data source: static app + `/hg/session`, `/hg/pane/:id` through Herdr RPC. |
| `tools/console-rpc.mjs` | Herdr JSONL RPC adapter (from `95ef12a:bin/console-rpc.mjs`). |
| `tools/run-f1.mjs` | Loads the app with the Herdgate transport, reports state, clicks the Terminal lens. |
| `evidence/boot-contract.json` | Measured contract, phases A (demo) and B (503). |
| `evidence/f1-run.json` | F1 run on the real session (session content stripped). |

## Reproduce (numbers are from this host, 26/11)

```sh
PIN=fe3058a39947f73fdcca3ef50aaacb55dc5f326b; T=/tmp/ovis-f0
git clone -q --depth 1 https://github.com/devswha/ovis.git /tmp/ovis-pin && git -C /tmp/ovis-pin checkout -q "$PIN"
mkdir -p "$T"/{home,app,bun-install}
env -i PATH=/usr/bin:/bin HOME=$T/home BUN_INSTALL=$T/bun-install CI=1 \
  ~/.cache/herdgate-console-toolchain/bun-bin/bun install --frozen-lockfile --ignore-scripts   # 7 s, 249 packages
bwrap --die-with-parent --new-session --unshare-net --ro-bind / / --bind /tmp/ovis-pin /tmp/ovis-pin --bind $T $T \
  --proc /proc --dev /dev --chdir /tmp/ovis-pin --clearenv --setenv PATH ~/.cache/herdgate-console-toolchain/bun-bin:/usr/bin:/bin \
  --setenv HOME $T/home --setenv TMPDIR $T --setenv CI 1 --setenv NODE_ENV production \
  bun --bun node_modules/.bin/vite build --outDir $T/app --emptyOutDir --logLevel warn          # 17 s, no network
# then: finish-demo.mjs <clone> <appDir> (reference backend) and/or bun build tools/src/herdgate-transport.ts
#       node tools/hg-source.mjs <appDir> 41291 ; node tools/boot-contract.mjs http://127.0.0.1:41291 out
```

Gotcha measured here: a CDP target created with `background: true` is `hidden`, and the app defers its calls — measure in a foreground tab.
