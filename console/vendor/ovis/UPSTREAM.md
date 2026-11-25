# Ovis source snapshot

- Repository: `https://github.com/devswha/ovis.git`
- Pinned revision: `b0f20e7bcf87f770638c26b8c74e77ef8fd84131` (verified from `/tmp/ovis-fork-check.OTCATe` HEAD)
- License: MIT; upstream `LICENSE` and `THIRD_PARTY_NOTICES.md` are retained alongside `package.json`, the complete upstream `bun.lock`, and all upstream `patches/`.
- `SOURCE-MANIFEST.txt` records SHA-256, upstream-relative path, and byte length for every imported file. Verify each row and byte count with `console/tools/verify-ovis-source.mjs` through `test/local-web-console-frontend.test.ts`.

## Import selection

The frontend source closure was traced from `src/main.tsx` through relative TS/TSX/JS/CSS/JSON and static asset imports, including CSS `url()` references. All source files in that closure are copied byte-for-byte. The complete `src/assets/` and `src/fonts/` asset trees are retained. The four public artwork files and upstream HTML/Vite configuration are retained for provenance/audit; `upstream-index.html` and `upstream-vite.config.ts` are not the Herdgate build inputs.

Not imported: Ovis `server/`, `relay/`, `push-relay/`, `app/`, CI/release/site workflows, test files, generated PWA service worker/manifest, installers, and unrelated repository content. The browser frontend is broad and imports account, relay, update, and other screens; retaining that source does not enable or claim those capabilities. A Herdgate-owned entrypoint/build must exclude their boot/network paths and show unsupported features honestly.

## Reproduction and build status

The source archive was populated from the clean pinned checkout with a relative-import closure walk, plus the stated static assets, upstream lock/licensing/patches, and audit inputs. The source file count, aggregate bytes, and every file digest are in `SOURCE-MANIFEST.txt`. Source integrity validation is now available through the local test.

Upstream declares Bun `1.4.4` and builds with `bun run build`; that upstream command uses Ovis build scripts and is **not** the Herdgate build command and was not run. This environment has Bun `1.3.13`; its local package cache is only 2.5 MB and the Ovis dependency set is not installed. No install, lifecycle script, upstream build, or network fetch was run. Any Herdgate build must use an audited isolated toolchain and run offline after controlled dependency provisioning.
