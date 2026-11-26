// F0 spike tooling (throwaway): bundle the upstream demo transport the way scripts/build-site.ts does.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, appDir] = process.argv.slice(2);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const bundle = await Bun.build({
  entrypoints: [join(root, "site/demo/transport.ts")],
  outdir: appDir,
  naming: "demo-transport.js",
  target: "browser",
  minify: true,
  define: { __APP_VERSION__: JSON.stringify(version) },
});
if (!bundle.success) throw new Error(`demo transport bundle failed:\n${bundle.logs.map(String).join("\n")}`);
const page = join(appDir, "index.html");
let html = readFileSync(page, "utf8");
if (!/<script type="module"/.test(html)) throw new Error("built app has no module script");
// Order: demo transport (backend replacement) → recorder → app. Drop the PWA manifest link (not an installable app here).
html = html.replace(/\s*<link rel="manifest"[^>]*>/, "");
html = html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./hg-recorder.js"></script>\n    <script type="module"');
writeFileSync(page, html);
for (const name of readdirSync(join(appDir, "assets"))) {
  if (!name.endsWith(".js")) continue;
  const file = join(appDir, "assets", name);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll('"/icons/', '"./icons/'));
}
console.log(`demo transport bundled (app ${version}); files: ${readdirSync(appDir).length} top-level, assets: ${readdirSync(join(appDir, "assets")).length}`);
