import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateConsoleAssets } from "../bin/console-service.mjs";

const NOTICE_FILES = [
  "console/dist/notices/LICENSE",
  "console/dist/notices/THIRD_PARTY_NOTICES.md",
];

function packError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function normalizeTarPath(value) {
  if (typeof value !== "string" || value.includes("\\") || value.startsWith("/")) {
    throw packError("console_tar_listing_invalid", "tar listing contains an unsafe path");
  }
  let path = value.replace(/\/+$/, "");
  while (path.startsWith("./")) path = path.slice(2);
  if (path === "package" || path === "") return null;
  if (path.startsWith("package/")) path = path.slice("package/".length);
  if (path.split("/").some((part) => part === ".." || part === ".")) {
    throw packError("console_tar_listing_invalid", "tar listing contains a traversal path");
  }
  return path;
}

/** Verify the concrete npm tar listing against the Console build manifest. */
export function assertConsolePackContents(tarballPaths, distDir) {
  if (!Array.isArray(tarballPaths)) throw packError("console_tar_listing_invalid", "tar listing must be an array of paths");
  if (typeof distDir !== "string" || !distDir) throw packError("console_dist_missing", "Console build directory path is required");
  const root = resolve(distDir);
  let rootStat;
  try { rootStat = statSync(root); } catch { throw packError("console_dist_missing", `Console build directory is missing: ${root}`); }
  if (!rootStat.isDirectory()) throw packError("console_dist_missing", `Console build path is not a directory: ${root}`);

  let manifest;
  try {
    const manifestStat = lstatSync(join(root, "manifest.json"));
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("manifest must be a regular file");
    validateConsoleAssets(root);
    manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  } catch {
    throw packError("console_manifest_invalid", "Console manifest or a referenced asset is missing or invalid");
  }

  for (const path of NOTICE_FILES) {
    const diskPath = join(root, path.slice("console/dist/".length));
    try {
      const stat = lstatSync(diskPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    } catch {
      throw packError("console_notice_missing", `required Console notice is missing: ${path}`);
    }
  }

  const packed = new Set(tarballPaths.map(normalizeTarPath).filter(Boolean));
  if ([...packed].some((path) => /^console\/(?:vendor|src|tools)(?:\/|$)/i.test(path))) {
    throw packError("console_pack_contains_source", "Console vendor, source, and build-tool trees must not ship in the npm tarball");
  }

  const required = new Set([
    "console/dist/manifest.json",
    ...NOTICE_FILES,
    ...Object.values(manifest.files).map((entry) => `console/dist/${entry.path}`),
  ]);
  for (const path of required) {
    if (packed.has(path)) continue;
    if (NOTICE_FILES.includes(path)) throw packError("console_pack_missing_notice", `npm tarball is missing ${path}`);
    if (path === "console/dist/manifest.json") throw packError("console_pack_missing_manifest", "npm tarball is missing console/dist/manifest.json");
    throw packError("console_pack_missing_file", `npm tarball is missing manifest asset ${path}`);
  }
  return { requiredFiles: [...required].sort() };
}
