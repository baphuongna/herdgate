// dev.herdgate.loop — the boot line typed into the pane's shell.
//
// The pane's shell is whatever the host picked: POSIX sh, PowerShell, or
// cmd.exe. The old boot (`cd X && pi "$(cat Y)"`) only parsed in the first
// one. The default below is shell-free by construction:
//   - pi reads the prompt file through its `@file` argument — a plain
//     quoted path every shell passes verbatim (quotes also neutralize
//     PowerShell's `@` splatting); no $( ) substitution anywhere;
//   - the pane is BORN in cfg.cwd (tab.create cwd, herdr >= 0.9.5), so
//     there is no `cd` to spell differently per shell (cmd needs /d,
//     PowerShell rejects it).
// Owners with a different shell or agent escape through loop.json's
// `bootCommand` template ({cwd}, {promptFile}); the plugin always appends
// Enter itself.
export const DEFAULT_BOOT = 'pi "@{promptFile}"';
const MAX_BOOT_COMMAND = 500;

export function validateBootCommand(cmd) {
  if (cmd === undefined) return null; // optional — absent means default
  if (typeof cmd !== "string") return "loop.json: `bootCommand` must be a string";
  if (cmd.length < 1 || cmd.length > MAX_BOOT_COMMAND) {
    return `loop.json: \`bootCommand\` must be 1-${MAX_BOOT_COMMAND} chars`;
  }
  if (/[\r\n]/.test(cmd)) {
    return "loop.json: `bootCommand` must not contain newlines (the plugin types Enter itself)";
  }
  return null;
}

export function buildBoot(cfg) {
  const tpl = typeof cfg?.bootCommand === "string" ? cfg.bootCommand : DEFAULT_BOOT;
  return tpl.replaceAll("{cwd}", String(cfg?.cwd ?? "")).replaceAll("{promptFile}", String(cfg?.promptFile ?? ""));
}

// What pane.send_text receives: the command plus Enter.
export function bootText(cfg) {
  return buildBoot(cfg) + "\r";
}
