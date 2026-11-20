// Exact Herdr v0.9.5 command templates from upstream src/remote/attach.rs.
// PowerShell is never invoked. The only child is the locally configured Herdr.
const ENCODED = "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ";
const HEADER = "[Console]::Out.WriteLine(); [Console]::Out.WriteLine('herdr-remote-output-ready:1'); [Console]::Out.Flush(); $ProgressPreference = 'SilentlyContinue'; ";
const PLATFORM = "$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }; [Console]::Out.WriteLine('herdr-windows:' + $arch); exit 0";
const DISCOVERY = String.raw`function Emit-HerdrPath([string]$CandidatePath) { if ([string]::IsNullOrWhiteSpace($CandidatePath) -or -not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) { return }; $candidateFullPath = [System.IO.Path]::GetFullPath($CandidatePath); $encodedCandidate = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($candidateFullPath)); [Console]::Out.WriteLine('herdr-remote-path:1:' + $encodedCandidate) }; $pathCommand = Get-Command herdr.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -ne $pathCommand) { Emit-HerdrPath $pathCommand.Source }; $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process -Filter "Name = 'herdr.exe' OR Name = 'herdr-dev.exe'" -ErrorAction SilentlyContinue | ForEach-Object { $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue; if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $userSid) { Emit-HerdrPath $_.ExecutablePath } }; $herdrHome = if ([string]::IsNullOrWhiteSpace($env:HERDR_HOME)) { Join-Path $env:USERPROFILE '.herdr' } else { $env:HERDR_HOME }; $activeJunction = Get-Item -LiteralPath (Join-Path $herdrHome 'packages\standalone\current') -Force -ErrorAction SilentlyContinue; if ($null -ne $activeJunction -and -not [string]::IsNullOrWhiteSpace([string]$activeJunction.Target)) { Emit-HerdrPath (Join-Path ([string]$activeJunction.Target) 'herdr.exe') }; exit 0`;
const q = (s) => /^(?!-)[a-zA-Z0-9_./:+=-]+$/.test(s) ? s : `'${s.replaceAll("'", "''")}'`;
const status = (bin, args) => `& ${[bin, ...args].map(q).join(" ")}; exit $LASTEXITCODE`;
const bridge = (bin, args) => `$process = Start-Process -FilePath ${q(bin)} -ArgumentList ${q(args.join(" "))} -NoNewWindow -PassThru -ErrorAction Stop; $null = $process.Handle; $process.WaitForExit(); exit $process.ExitCode`;

export function translateWindowsHerdr(input, { bin, session, stdin, arch }, marker, posixHead) {
  // Only a local, absolute drive path selected by the owner; no UNC targets.
  if (!/^[a-z]:[\\/]/i.test(bin) || /[\x00-\x1f\x7f]/.test(bin) || !/\.exe$/i.test(bin)) return null;
  if (stdin) {
    // A real Windows host cannot run uname; Herdr then tries the Windows probe.
    return input.replace(/\n+$/, "") === posixHead + "uname -s\nuname -m" ? { reply: "", code: 1 } : null;
  }
  if (input.length > 8192 || !input.startsWith(ENCODED)) return null;
  const encoded = input.slice(ENCODED.length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length % 2 || bytes.toString("base64") !== encoded) return null;
  const script = bytes.toString("utf16le");
  if (!script.startsWith(HEADER)) return null;
  const body = script.slice(HEADER.length);
  if (body === PLATFORM) {
    const name = { x64: "AMD64", arm64: "ARM64", ia32: "x86" }[arch];
    return name ? { reply: marker + `herdr-windows:${name}\n` } : null;
  }
  if (body === DISCOVERY) {
    return { reply: marker + `herdr-remote-path:1:${Buffer.from(bin).toString("base64")}\n` };
  }
  const sessionArgs = session === "default" ? [] : ["--session", session];
  for (const args of [["status", "client", "--json"], [...sessionArgs, "status", "server", "--json"]]) {
    if (body === status(bin, args)) return { args, closeStdin: true };
  }
  const clientArgs = [...sessionArgs, "remote-client-bridge"];
  if (body === bridge(bin, clientArgs)) return { args: clientArgs };
  const apiArgs = ["--session", session, "remote-api-bridge"];
  const probe = `$capability = & ${q(bin)} --session ${q(session)} remote-api-bridge --check 2>$null; if ($LASTEXITCODE -ne 0 -or $capability -ne 'herdr-api-bridge-v1') { [Console]::Error.WriteLine('herdr-machine-metadata-stale-v1'); exit 78 }; `;
  if (body === bridge(bin, [...apiArgs, "--check"])) return { args: [...apiArgs, "--check"], closeStdin: true };
  if (body === bridge(bin, apiArgs) || body === probe + bridge(bin, apiArgs)) return { args: apiArgs };
  return null;
}
