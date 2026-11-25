# Ovis L1 read-only adapter provenance

The vendored snapshot under `console/vendor/ovis/` is kept byte-for-byte at `b0f20e7bcf87f770638c26b8c74e77ef8fd84131`. No upstream files are patched in place. License and third-party notices remain alongside the snapshot.

## Runtime import trace

```text
console/src/entry.tsx
  -> console/src/ui.tsx (auth/session/screen polling and pane selection)
    -> console/src/ovis/ReadOnlySessionView.tsx
      -> console/vendor/ovis/src/components/TabStrip.tsx  (real Ovis tab component, closable=false)
      -> console/vendor/ovis/src/components/PaneCanvas.tsx (real Ovis pane/layout component, watching=true)
      -> console/src/ovis/TerminalMirror.tsx (read-only port of the xterm rendering surface from
         console/vendor/ovis/src/components/PaneTerminal.tsx; no Ovis attach/input/ACK path)
```

`ConsoleApiClient` validates the a9a260f runtime wire schema and retains the validated Ovis `SessionSnapshot` in memory for the component adapter. Workspace choice remains a small Herdgate-owned selector: Ovis `Sidebar` performs persistent preferences/worktree discovery and exposes broader controls, so importing it would violate the L1 storage/capability boundary.

The adapter provides a read-only Ovis `MachineContext` through the Vite `machineContext.tsx` alias: all `useMachineApi()` methods reject locally before transport, and `AppLayoutContext` offers no mutations. It sets `watching`, disables tab closing/new-terminal controls, blocks context/action menus, and mounts no `App` or `PaneTerminal`. At entry, a fetch firewall blocks remote origins and every `/api/*` route outside the explicit Herdgate Console read/auth allowlist, including Ovis telemetry/API paths. The Vite aliases also redirect Ovis `settings.ts` and `lastViewedPane.ts` to memory-only shims; the vendored files themselves are unchanged. Pane selection only changes the browser's selected ID; screen polling remains the only allowed Ovis-facing data path through Herdgate's typed client. Node tests exercise both hard-deny layers and assert blocked calls never reach the supplied fetcher. This is application-level fetch evidence, not a measured browser network trace. The runtime service still independently rejects every non-allowlisted write request.

This is a deliberately scoped Ovis component integration, **not full Ovis frontend parity**. The terminal renderer is an attributed read-only port because upstream `PaneTerminal` is inseparable from Ovis WebSocket attach and input hooks. See the source-level Node contract test for the exact import trace. A production Vite bundle and browser/UI acceptance remain blocked by the separate toolchain/dependency preflight in `console/README.md`.
