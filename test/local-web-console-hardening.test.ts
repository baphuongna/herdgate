import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONSOLE_CSP_HEADER, CONSOLE_CSP_META } from "../console/tools/build-console.mjs";
import { installConsoleStorageGuard, type ConsoleStorage, type ConsoleStorageHost } from "../console/src/ovis/storage-guard.ts";
import { activateReadPane } from "../console/src/ovis/pane-select-key.ts";
import { configureReadOnlyMirrorKeyboard } from "../console/src/ovis/mirror-keyboard.ts";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const consoleRoot = path.join(repo, "console");
const vendorRoot = path.join(consoleRoot, "vendor/ovis");
const expectedSettingsFields = [
  "lockedAgents", "agentLocks", "autoTabNames", "phoneTabs", "statusIndicators",
  "sidebarAgentTree", "sidebarBackgroundWorkspaces", "sidebarContext", "sidebarRows", "terminalMirrorWrap",
];

async function resolveSource(from: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) return null;
  let target = path.resolve(path.dirname(from), specifier.split("?", 1)[0]!);
  const normalized = target.split(path.sep).join("/");
  if (normalized.startsWith(`${vendorRoot}/`) && /\/settings\.ts$/.test(normalized)) target = path.join(consoleRoot, "src/ovis/settings-shim.tsx");
  else if (normalized.startsWith(`${vendorRoot}/`) && /\/lastViewedPane\.ts$/.test(normalized)) target = path.join(consoleRoot, "src/ovis/last-viewed-pane-shim.ts");
  else if (normalized.startsWith(`${vendorRoot}/`) && /\/machineContext\.tsx$/.test(normalized)) target = path.join(consoleRoot, "src/ovis/machine-context-shim.tsx");
  else if (normalized.startsWith(`${vendorRoot}/`) && /\/i18n\.ts$/.test(normalized)) target = path.join(consoleRoot, "src/ovis/i18n-shim.ts");
  const candidates = [target, ...[".ts", ".tsx", ".js", ".jsx", ".css", ".json"].map((extension) => `${target}${extension}`),
    path.join(target, "index.ts"), path.join(target, "index.tsx")];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try the next Vite-style extension */ }
  }
  return null;
}

async function builtSourceGraph(entry: string): Promise<Map<string, string>> {
  const modules = new Map<string, string>();
  const visit = async (file: string): Promise<void> => {
    if (modules.has(file) || !/\.(?:[cm]?[jt]sx?|css)$/.test(file)) return;
    const source = await readFile(file, "utf8");
    modules.set(file, source);
    const imports = /\bfrom\s*["']([^"']+)["']|\bimport\s*(?:\(\s*)?["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const target = await resolveSource(file, match[1] ?? match[2]!);
      if (target) await visit(target);
    }
  };
  await visit(entry);
  return modules;
}

test("Ovis settings shim follows the complete vendor defaults and all settings read in the build graph", async () => {
  const shimPath = path.join(consoleRoot, "src/ovis/settings-shim.tsx");
  const shim = await readFile(shimPath, "utf8");
  assert.match(shim, /import\s*\{\s*DEFAULT_SETTINGS\s*\}\s*from\s*["']\.\.\/\.\.\/vendor\/ovis\/src\/lib\/settings["']/,
    "the import intentionally omits .ts so the settings alias cannot redirect it back to the shim");
  assert.match(shim, /Object\.freeze\(\{\s*\.\.\.DEFAULT_SETTINGS\s*\}\)/,
    "spreading the complete default object prevents hand-maintained partial Settings drift");

  const graph = await builtSourceGraph(path.join(consoleRoot, "src/entry.tsx"));
  const vendorModules = [...graph.entries()].filter(([file]) => file.startsWith(vendorRoot + path.sep));
  assert.ok(vendorModules.length > 0, `the settings check must inspect the Console build graph; found ${graph.size} modules: ${[...graph.keys()].slice(0, 5).join(", ")}`);
  for (const field of expectedSettingsFields) {
    assert.ok(vendorModules.some(([, source]) => new RegExp(`\\bsettings\\.${field}\\b`).test(source)),
      `expected ${field} to be consumed by a vendor module in the Console build graph`);
  }
  assert.ok(vendorModules.some(([, source]) => /\bupdate\s*:\s*updateSettings\b/.test(source)),
    "PaneCanvas consumes the SettingsContext update method separately from Settings fields");
  assert.match(shim, /update:\s*\(_value:\s*unknown\)\s*:\s*void\s*=>\s*\{\s*\}/,
    "the update method is present but read-only");
});

test("importing the Console settings shim is storage- and network-silent", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "console-settings-vite-"));
  const vendorPackage = path.join(vendorRoot, "package.json");
  const require = createRequire(pathToFileURL(vendorPackage));
  const vitePath = require.resolve("vite");
  const reactMock = path.join(temp, "react.mjs");
  const jsxMock = path.join(temp, "jsx-runtime.mjs");
  await writeFile(reactMock, "export const createContext = (value) => ({ value, Provider() {} }); export const useContext = (context) => context.value;\n");
  await writeFile(jsxMock, "export const jsx = () => null; export const jsxs = jsx;\n");
  const { createServer } = await import(pathToFileURL(vitePath).href);
  const server = await createServer({ configFile: false, root: consoleRoot, cacheDir: temp, logLevel: "silent", resolve: { alias: [
    { find: "react/jsx-runtime", replacement: jsxMock },
    { find: "react/jsx-dev-runtime", replacement: jsxMock },
    { find: "react", replacement: reactMock },
  ] }, server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const accessCounts = { local: 0, session: 0, fetch: 0 };
  const remember = (object: object, key: string): void => { previous.set(`${object === globalThis ? "global" : "window"}:${key}`, Object.getOwnPropertyDescriptor(object, key)); };
  const fakeWindow: Record<string, unknown> = {};
  for (const [key, kind] of [["localStorage", "local"], ["sessionStorage", "session"]] as const) {
    Object.defineProperty(fakeWindow, key, { configurable: true, get: () => { accessCounts[kind] += 1; throw new Error(`${kind} storage read during settings module load`); } });
    remember(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, get: () => { accessCounts[kind] += 1; throw new Error(`${kind} storage read during settings module load`); } });
  }
  remember(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  remember(globalThis, "fetch");
  globalThis.fetch = (async () => { accessCounts.fetch += 1; throw new Error("network access during settings module load"); }) as typeof fetch;
  try {
    const sourceModule = await server.ssrLoadModule("/src/ovis/settings-shim.tsx");
    const vendorModule = await server.ssrLoadModule("/vendor/ovis/src/lib/settings.ts");
    const defaults = sourceModule.settings as Record<string, unknown>;
    assert.deepEqual(defaults, vendorModule.DEFAULT_SETTINGS, "the actual Console alias-resolved shim exposes every vendor default");
    for (const field of expectedSettingsFields) assert.ok(field in defaults, `vendor DEFAULT_SETTINGS is missing ${field}`);
    assert.deepEqual(accessCounts, { local: 0, session: 0, fetch: 0 });
  } finally {
    for (const key of ["localStorage", "sessionStorage"]) {
      const descriptor = previous.get(`global:${key}`);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    const windowDescriptor = previous.get("global:window");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window");
    const fetchDescriptor = previous.get("global:fetch");
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor); else Reflect.deleteProperty(globalThis, "fetch");
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("Console metadata CSP omits the header-only frame directive in source and built HTML", async () => {
  const extract = (html: string): string => {
    const meta = html.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i)?.[0];
    return meta?.match(/\bcontent="([^"]*)"/i)?.[1] ?? "";
  };
  assert.equal(CONSOLE_CSP_HEADER, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; child-src 'none'; frame-src 'none'; manifest-src 'none'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  assert.equal(CONSOLE_CSP_META, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; child-src 'none'; frame-src 'none'; manifest-src 'none'; form-action 'self'; object-src 'none'; base-uri 'none'");
  assert.equal(CONSOLE_CSP_HEADER, `${CONSOLE_CSP_META}; frame-ancestors 'none'`, "header remains exact meta plus the header-only directive");
  const sourceHtml = await readFile(path.join(consoleRoot, "index.html"), "utf8");
  assert.equal(extract(sourceHtml), CONSOLE_CSP_META);
  assert.match(sourceHtml, /<link rel="icon" href="data:,"\s*\/>/);
  assert.doesNotMatch(sourceHtml, /https?:\/\//i);
  try {
    const builtHtml = await readFile(path.join(consoleRoot, "dist/index.html"), "utf8");
    assert.equal(extract(builtHtml), CONSOLE_CSP_META);
    assert.match(builtHtml, /<link rel="icon" href="data:,"\s*\/>/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
});

test("memory-only storage guard isolates tab storage and restores original descriptors", () => {
  const makeStorage = (values: Map<string, string>): ConsoleStorage => ({
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(String(key)) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(String(key)); },
    setItem(key, value) { values.set(String(key), String(value)); },
  });
  const nativeLocal = makeStorage(new Map([['persisted', 'local']]));
  const nativeSession = makeStorage(new Map([['persisted', 'session']]));
  const host: ConsoleStorageHost = {
    get localStorage() { return nativeLocal; },
    get sessionStorage() { return nativeSession; },
  };
  const localDescriptor = Object.getOwnPropertyDescriptor(host, "localStorage");
  const sessionDescriptor = Object.getOwnPropertyDescriptor(host, "sessionStorage");
  const restore = installConsoleStorageGuard(host);
  try {
    const local = host.localStorage;
    const session = host.sessionStorage;
    assert.notEqual(local, nativeLocal);
    assert.notEqual(session, nativeSession);
    assert.equal(local.getItem("persisted"), null);
    assert.equal(session.getItem("persisted"), null);
    local.setItem("key", "local only");
    assert.equal(local.getItem("key"), "local only");
    assert.equal(session.getItem("key"), null, "local and session memory stores are separate");
    session.setItem("key", "session only");
    assert.equal(local.getItem("key"), "local only");
  } finally { restore(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(host, "localStorage"), localDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(host, "sessionStorage"), sessionDescriptor);
});

test("Enter and Space select the focused read-only pane without creating a mutation path", () => {
  const selected: string[] = [];
  const preventions: string[] = [];
  for (const key of ["Enter", " "]) {
    activateReadPane({ key, preventDefault: () => { preventions.push(key); } }, "w1:p2", (paneId) => selected.push(paneId));
  }
  activateReadPane({ key: "ArrowDown", preventDefault: () => { preventions.push("unexpected"); } }, "w1:p2", (paneId) => selected.push(paneId));
  assert.deepEqual(selected, ["w1:p2", "w1:p2"]);
  assert.deepEqual(preventions, ["Enter", " "]);
});

test("read-only pane adapter keeps every pane in a split tab selectable", async () => {
  const view = await readFile(path.join(consoleRoot, "src/ovis/ReadOnlySessionView.tsx"), "utf8");
  const css = await readFile(path.join(consoleRoot, "src/console.css"), "utf8");
  const paneCanvas = await readFile(path.join(vendorRoot, "src/components/PaneCanvas.tsx"), "utf8");
  const tabStrip = await readFile(path.join(vendorRoot, "src/components/TabStrip.tsx"), "utf8");
  const snapshot = {
    workspaces: [{ workspace_id: "w1" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1" }],
    panes: [
      { pane_id: "p1", tab_id: "t1", workspace_id: "w1" },
      { pane_id: "p2", tab_id: "t1", workspace_id: "w1" },
    ],
    layouts: [{ tab_id: "t1", area: { x: 0, y: 0, width: 200, height: 80 }, panes: [
      { pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 80 } },
      { pane_id: "p2", focused: false, rect: { x: 100, y: 0, width: 100, height: 80 } },
    ] }],
  };
  const cells = snapshot.layouts[0]!.panes.map((pane) => pane.pane_id);
  const requested: string[] = [];
  const onSelectPane = (paneId: string): void => { requested.push(paneId); };
  assert.deepEqual(cells, ["p1", "p2"], "the two-pane layout carries both selectable pane identities");
  assert.match(paneCanvas, /layoutCells\(layout\)/);
  assert.match(view, /onSelect=\{\(paneId\) => \{[\s\S]*?active\.classList\.contains\("ovis-pane-not-selected"\)[\s\S]*?onSelectPane\(paneId\);[\s\S]*?\}\}/);
  assert.match(tabStrip, /const soloPanes = useMediaQuery\(SOLO_PANE_QUERY\)/, "narrow/single-pane Ovis layouts have a separate pane picker");
  assert.match(tabStrip, /const paneList = own\.length < 2 \? \[\] : own\.map\(\(pane\)/);
  assert.match(tabStrip, /run: \(\) => pickPane\(pane, typing\)/);
  assert.match(tabStrip, /if \(!typing\) \{ onSelectPane\(pane\.pane_id\); return; \}/);
  assert.doesNotMatch(view, /\bsolo(?:\s|=|\n)/, "all split cells must remain rendered and non-inert");
  assert.match(paneCanvas, /if \(event\.button === 0 && !paneContextPress\(event, apple\) && !active\)\s*\{\s*onSelect\(item\.pane_id, false\)/s);
  assert.match(view, /Select this pane to read its mirror\./);
  assert.match(view, /className="ovis-pane-not-selected" tabIndex=\{0\} role="button"/);
  assert.match(view, /aria-label=\{`Read pane \$\{pane\.label \?\?/);
  assert.match(view, /onKeyDown=\{\(event\) => activateReadPane\(event, pane\.pane_id, onSelectPane\)\}/);
  assert.doesNotMatch(view, /ovis-pane-not-selected"[^>]*aria-hidden/);
  assert.match(css, /\.ovis-pane-not-selected:focus-visible\s*\{/);
  for (const paneId of cells) onSelectPane(paneId);
  assert.deepEqual(requested, ["p1", "p2"]);
});

test("read-only mirror keeps xterm's helper textarea out of Tab traversal", () => {
  const textarea = { tabIndex: 0 };
  let keyHandler: ((event: { key: string; shiftKey?: boolean }) => boolean) | undefined;
  configureReadOnlyMirrorKeyboard({
    textarea,
    attachCustomKeyEventHandler: (handler) => { keyHandler = handler; },
  });
  assert.equal(textarea.tabIndex, -1, "xterm's otherwise tabbable helper input is removed from sequential focus order");
  assert.ok(keyHandler);
  assert.equal(keyHandler({ key: "Tab" }), false, "xterm must not cancel or refocus on forward Tab");
  assert.equal(keyHandler({ key: "Tab", shiftKey: true }), false, "xterm must not cancel or refocus on reverse Tab");
  assert.equal(keyHandler({ key: "Enter" }), true, "other key handling remains unchanged");
});

test("hidden Ovis panes are inert and focusable panes become active only when shown", async () => {
  const paneCanvas = await readFile(path.join(vendorRoot, "src/components/PaneCanvas.tsx"), "utf8");
  const css = await readFile(path.join(vendorRoot, "src/components/PaneCanvas.css"), "utf8");
  assert.match(paneCanvas, /const hidden = offTab \|\| \(alone !== null && alone !== item\.pane_id\)/);
  assert.match(paneCanvas, /aria-hidden=\{hidden \|\| undefined\} inert=\{hidden \|\| undefined\}/,
    "off-tab and non-visible split panes must be removed from sequential focus and the accessibility tree");
  assert.match(paneCanvas, /role="button" tabIndex=\{0\}/, "a visible pane placeholder remains keyboard focusable");
  assert.match(css, /\.pane-frame\.is-hidden \{ visibility: hidden; pointer-events: none; \}/);
});
