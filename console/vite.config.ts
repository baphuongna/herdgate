import { copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(root, "vendor/ovis");
const modules = path.join(vendor, "node_modules");
const dist = path.join(root, "dist");

export default {
  root,
  base: "/",
  publicDir: false,
  envDir: path.join(os.tmpdir(), "herdgate-console-empty-env"),
  envPrefix: [],
  cacheDir: path.join(os.tmpdir(), "herdgate-console-vite-cache"),
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  resolve: {
    alias: [
      // Ovis components share preference modules that persist to browser storage. The L1 surface is read-only and tab-local.
      { find: /(?:^|.*\/)settings\.ts$/, replacement: path.join(root, "src/ovis/settings-shim.tsx") },
      { find: /(?:^|.*\/)lastViewedPane\.ts$/, replacement: path.join(root, "src/ovis/last-viewed-pane-shim.ts") },
      { find: /(?:^|.*\/)machineContext\.tsx$/, replacement: path.join(root, "src/ovis/machine-context-shim.tsx") },
      { find: /(?:^|.*\/)i18n\.ts$/, replacement: path.join(root, "src/ovis/i18n-shim.ts") },
      { find: /^react\/jsx-runtime$/, replacement: path.join(modules, "react/jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(modules, "react/jsx-dev-runtime.js") },
      { find: /^react$/, replacement: path.join(modules, "react/index.js") },
      { find: /^react-dom\/client$/, replacement: path.join(modules, "react-dom/client.js") },
      { find: /^@xterm\/xterm\/css\/xterm\.css$/, replacement: path.join(modules, "@xterm/xterm/css/xterm.css") },
      { find: /^@xterm\/xterm$/, replacement: path.join(modules, "@xterm/xterm") },
      { find: /^@xterm\/addon-fit$/, replacement: path.join(modules, "@xterm/addon-fit") },
    ],
  },
  build: {
    outDir: dist,
    assetsDir: "assets",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    manifest: false,
    rollupOptions: { input: path.join(root, "index.html") },
  },
  plugins: [{
    name: "herdgate-console-notices",
    async closeBundle() {
      const notices = path.join(dist, "notices");
      await mkdir(notices, { recursive: true });
      await copyFile(path.join(vendor, "LICENSE"), path.join(notices, "LICENSE"));
      await copyFile(path.join(vendor, "THIRD_PARTY_NOTICES.md"), path.join(notices, "THIRD_PARTY_NOTICES.md"));
    },
  }],
};
