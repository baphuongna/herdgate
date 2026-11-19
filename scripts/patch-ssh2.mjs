#!/usr/bin/env node
/**
 * ssh2 1.17.0 ships a malformed `server-sig-algs` EXT_INFO: two string literals
 * concatenated without the comma (`…nistp521` + `rsa-sha2-512…`). OpenSSH clients
 * parse that garbled list, conclude Ed25519 signing is not allowed, and silently
 * give up after USERAUTH_PK_OK — publickey auth can never complete against ssh2
 * servers. This fixes the literal in place, idempotently, until an upstream
 * release carries the fix.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let path;
try {
  path = require.resolve("ssh2/lib/protocol/Protocol.js");
} catch {
  console.error("patch-ssh2: ssh2 not installed, nothing to do");
  process.exit(0);
}
let src = readFileSync(path, "utf8");
const broken = /ecdsa-sha2-nistp521'\s*\+\s*'rsa-sha2-512/;
if (broken.test(src)) {
  src = src.replace(broken, "ecdsa-sha2-nistp521'\n    + ',rsa-sha2-512");
  writeFileSync(path, src);
  console.error(`patch-ssh2: fixed server-sig-algs in ${path}`);
} else if (src.includes("nistp521'\n    + ',rsa-sha2-512") || /nistp521,\s*'?\+?\s*'?rsa-sha2-512/.test(src)) {
  console.error("patch-ssh2: already patched");
} else {
  console.error("patch-ssh2: upstream source changed — check whether the bug is fixed upstream, then drop this patch");
  process.exit(1);
}
