/**
 * Pairing QR output (lesson from pairfob): wherever a host prints a pairing
 * code for a human to retype into the PWA, it can also hand the code to a
 * camera. The phone opens `https://<gate>/#pair=<code>` and the PWA prefills
 * the code — the human only presses approve.
 *
 * Pure pieces first (`pairingQrPayload`, `renderPairingQr` — no I/O, fully
 * testable), then one console wrapper (`printPairingQr`). The `qrcode-terminal`
 * dependency loads lazily and only when the stream is an interactive TTY, so
 * non-interactive hosts print just the URL line and never touch the library.
 */
import { createRequire } from "node:module";

/** The URL a phone camera opens: the PWA with the pairing code prefilled. */
export function pairingQrPayload(gateUrl: string, code: string): string {
  const base = gateUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(base)) {
    throw new Error(`pairing QR: gate URL must be http(s)://…, got: ${JSON.stringify(gateUrl)}`);
  }
  // Pairing codes are `randomCode` output (no-lookalike alphanumerics); anything
  // else would leak into a URL, so refuse it here rather than encode it.
  if (!/^[A-Za-z0-9]{4,64}$/.test(code)) {
    throw new Error(`pairing QR: pairing code must be 4–64 alphanumerics, got: ${JSON.stringify(code)}`);
  }
  return `${base}/#pair=${code}`;
}

export interface QrRenderOpts {
  /** Interactive check; defaults to `process.stdout.isTTY` in `printPairingQr`. */
  isTTY?: boolean;
  /** ASCII-QR renderer (injectable — tests pass a spy instead of the library). */
  renderQr?: (payload: string) => string;
}

/** Build the lines to print: framed guidance + URL + ASCII QR on a TTY,
 *  a plain URL line otherwise (no QR call — grep-safe for scripts and logs). */
export function renderPairingQr(payload: string, o: QrRenderOpts = {}): { lines: string[]; usedQr: boolean } {
  if (!o.isTTY) return { lines: [payload], usedQr: false };
  const lines = [
    "── pairing " + "─".repeat(46),
    "Quét bằng điện thoại để mở PWA đã điền sẵn code",
    payload,
  ];
  const qr = (o.renderQr ?? defaultQr)(payload);
  lines.push(...qr.split("\n"));
  lines.push("─".repeat(56));
  return { lines, usedQr: true };
}

/** Print the payload (and, on a TTY, its QR) through `log`. Returns whether a
 *  QR was rendered. Throws only if the QR library itself fails to render. */
export function printPairingQr(payload: string, log: (line: string) => void, o: QrRenderOpts = {}): boolean {
  const { lines, usedQr } = renderPairingQr(payload, { isTTY: o.isTTY ?? process.stdout.isTTY ?? false, renderQr: o.renderQr });
  for (const line of lines) log(line);
  return usedQr;
}

/** The real renderer: `qrcode-terminal` is CJS and only worth loading when an
 *  interactive human is actually looking. Its callback is synchronous. */
function defaultQr(payload: string): string {
  const require = createRequire(import.meta.url);
  const mod = require("qrcode-terminal") as {
    generate: (text: string, opts: { small: boolean }, cb: (qr: string) => void) => void;
  };
  let out = "";
  mod.generate(payload, { small: true }, (qr) => {
    out = qr;
  });
  return out;
}
