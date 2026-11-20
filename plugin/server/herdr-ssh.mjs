// Herdr v0.9.5 remote host protocol. Compare generated command templates; none
// of the received shell text is executed. Only the publisher's chosen binary
// and session can be used. See upstream src/remote/attach.rs.
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { translateWindowsHerdr } from "./herdr-ssh-win.mjs";

export const MARKER = "\nherdr-remote-output-ready:1\n";
const HEAD = "printf '\n%s\n' 'herdr-remote-output-ready:1'\n";
const q = (s) => /^[a-zA-Z0-9@%_+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
const sh = (script) => `/bin/sh -c ${q(script)}`;

function executable(bin) {
  try {
    if (!isAbsolute(bin) || /[\r\n\0]/.test(bin) || !statSync(bin).isFile()) return false;
    accessSync(bin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveHerdr(env = process.env) {
  const explicit = env.HERDGATE_HERDR_BIN?.trim();
  if (explicit) return executable(explicit) ? explicit : null;
  if (process.platform === "win32") {
    const bin = env.HERDR_BIN_PATH?.trim();
    return bin && executable(bin) ? bin : null;
  }
  return [env.HERDR_BIN_PATH ?? "", join(homedir(), ".local/bin/herdr"), "/usr/local/bin/herdr", "/usr/bin/herdr"].find(executable) ?? null;
}

function candidates(os) {
  return `home=\${HOME:-}
user=\${USER:-}
version=<client-version>
emit() {
    path=$1
    if [ -n "$path" ] && [ -x "$path" ]; then
        printf '%s\\n' "$path"
    fi
}
if [ -n "$home" ]; then
    emit "$home/.local/bin/herdr"
fi
${os === "darwin" ? '    emit "/opt/homebrew/bin/herdr"\n    emit "/usr/local/bin/herdr"' : '    emit "/home/linuxbrew/.linuxbrew/bin/herdr"'}
if [ -n "$home" ]; then
    emit "$home/.local/share/mise/installs/herdr/$version/bin/herdr"
    emit "$home/.local/share/mise/installs/herdr/$version/herdr"
    emit "$home/.local/share/mise/installs/github-ogulcancelik-herdr/$version/herdr"
    emit "$home/.nix-profile/bin/herdr"
fi
if [ -n "$user" ]; then
    emit "/etc/profiles/per-user/$user/bin/herdr"
fi
emit "/nix/var/nix/profiles/default/bin/herdr"
emit "/run/current-system/sw/bin/herdr"
`;
}

export function translateHerdr(input, { bin, session = "default", stdin = false, os = process.platform, arch = process.arch }) {
  if (!bin || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(session)) return null;
  // Interpret only the probe text, never the bridge data. Windows clients can send CRLF.
  input = input.replaceAll("\r\n", "\n");
  if (os === "win32") return translateWindowsHerdr(input, { bin, session, stdin, arch }, MARKER, HEAD);
  if (!["linux", "darwin"].includes(os)) return null;
  const body = input.startsWith(HEAD) ? input.slice(HEAD.length).replace(/\n+$/, "") : null;
  const path = q(bin);
  const sessionArgs = session === "default" ? [] : ["--session", session];
  const prefix = [path, ...sessionArgs].join(" ");
  const reply = (s) => ({ reply: MARKER + s });
  const run = (args, closeStdin = stdin) => ({ args, closeStdin });
  if (body === "command -v herdr") return reply(`${bin}\n`);
  if (stdin) {
    if (body === "uname -s\nuname -m") {
      return reply(`${os === "linux" ? "Linux" : "Darwin"}\n${{ x64: "x86_64", arm64: "aarch64" }[arch] ?? arch}\n`);
    }
    // Herdr embeds the client build ID in the probe. Ignore just that token;
    // the rest of the script must match and the result is always the host binary.
    const discovery = body?.replace(/^version=\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][a-zA-Z0-9.+-]{1,64})?$/m, "version=<client-version>");
    if (discovery !== body && discovery === candidates(os).trimEnd()) return reply(`${bin}\n`);
    if (body === `test -x ${path} && ${path} status client --json`) return run(["status", "client", "--json"]);
    if (body === `${prefix} status server --json`) return run([...sessionArgs, "status", "server", "--json"]);
    if (body === `exec ${prefix} remote-client-bridge </dev/null`) return run([...sessionArgs, "remote-client-bridge"]);
  } else {
    for (const option of ["", " --idle-timeout-v1"]) {
      if (body === `exec ${prefix} remote-client-bridge${option}`) {
        return run([...sessionArgs, "remote-client-bridge", ...(option ? [option.trim()] : [])]);
      }
    }
    const api = `${path} --session ${session} remote-api-bridge`;
    const cached = `if capability=$(${api} --check </dev/null 2>/dev/null) && [ "$capability" = herdr-api-bridge-v1 ]; then
${HEAD}exec ${api}
else
    printf '%s\\n' 'herdr-machine-metadata-stale-v1' >&2
    exit 78
fi`;
    if (input === sh(cached) || body === `exec ${api}`) return run(["--session", session, "remote-api-bridge"]);
  }
  return null;
}
