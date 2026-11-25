import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PIN = "b0f20e7bcf87f770638c26b8c74e77ef8fd84131";

export async function verifyOvisSource(rootUrl) {
  const root = fileURLToPath(rootUrl);
  const vendor = path.join(root, "console/vendor/ovis");
  const manifest = await readFile(path.join(vendor, "SOURCE-MANIFEST.txt"), "utf8");
  const files = [];
  let bytes = 0;

  for (const line of manifest.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([^\0]+)  ([0-9]+)$/.exec(line);
    if (!match) throw new Error(`invalid Ovis source manifest row: ${line}`);
    const [, expectedHash, relative, expectedLength] = match;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new Error(`unsafe Ovis source manifest path: ${relative}`);
    }
    const content = await readFile(path.join(vendor, relative));
    if (content.length !== Number(expectedLength)) throw new Error(`Ovis source length mismatch: ${relative}`);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`Ovis source hash mismatch: ${relative}`);
    files.push(relative);
    bytes += content.length;
  }

  const provenance = await readFile(path.join(vendor, "UPSTREAM.md"), "utf8");
  if (!provenance.includes(`Pinned revision: \`${PIN}\``)) throw new Error("Ovis source pin mismatch");
  for (const required of ["LICENSE", "THIRD_PARTY_NOTICES.md", "bun.lock", "patches/@xterm%2Fxterm@6.0.0.patch", "src/App.tsx", "src/components/PaneTerminal.tsx", "src/lib/markdownPreview.worker.ts", "src/lib/highlight.worker.ts", "shared/ghostty/ghostty-vt.wasm", "shared/herdr-api.generated.ts"]) {
    if (!files.includes(required)) throw new Error(`required Ovis frontend source missing: ${required}`);
  }
  if (files.some((file) => /^(server|relay|push-relay|app)\//.test(file))) throw new Error("Ovis backend files must not be vendored");
  if (files.some((file) => /(^|\/)(sw\.js|pwa\.ts|manifest\.webmanifest)$/.test(file))) throw new Error("Ovis PWA runtime must not be vendored");

  const entry = path.join(root, "console/src/entry.tsx");
  let localEntrypoint = null;
  try {
    await stat(entry);
    localEntrypoint = "console/src/entry.tsx";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const buildReady = localEntrypoint !== null && await stat(path.join(root, "console/vite.config.ts")).then(() => true, () => false);
  return {
    revision: PIN,
    fileCount: files.length,
    bytes,
    files,
    localEntrypoint,
    buildReady,
    upstreamPwaRegistrationExcluded: !files.some((file) => file === "src/pwa.ts" || file === "public/sw.js"),
  };
}
