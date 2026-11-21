/**
 * QR pairing (pairfob lesson): wherever a host prints a pairing code, it can
 * also print an ASCII QR of `https://<gate>/#pair=<code>` so a phone opens the
 * PWA with the code prefilled. The pure pieces live in src/agent/qr.ts; these
 * tests pin the payload format and the TTY render decision (a spy stands in for
 * qrcode-terminal — the library itself must never load in tests).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pairingQrPayload, printPairingQr, renderPairingQr } from "../src/agent/qr.ts";

test("qr: pairingQrPayload builds the PWA prefill URL", () => {
  const p = pairingQrPayload("https://herd.example.com", "AB12CD34");
  assert.equal(p, "https://herd.example.com/#pair=AB12CD34");
  // Format: https://<gate>/#pair=<code> — no query, no extra path, no odd chars.
  assert.match(p, /^https:\/\/[^/?#]+\/#pair=[A-Za-z0-9]+$/);
  assert.ok(p.includes("AB12CD34"));
});

test("qr: pairingQrPayload normalises the gate URL but keeps its origin", () => {
  assert.equal(pairingQrPayload("https://gate.io///", "AB12CD34"), "https://gate.io/#pair=AB12CD34");
  assert.equal(pairingQrPayload(" http://127.0.0.1:8787/ ", "AB12CD34"), "http://127.0.0.1:8787/#pair=AB12CD34");
});

test("qr: pairingQrPayload refuses junk instead of encoding it", () => {
  assert.throws(() => pairingQrPayload("not a url", "AB12CD34"), /gate URL/);
  assert.throws(() => pairingQrPayload("ftp://gate.io", "AB12CD34"), /gate URL/);
  assert.throws(() => pairingQrPayload("https://gate.io", "AB 12"), /pairing code/);
  assert.throws(() => pairingQrPayload("https://gate.io", "AB/12"), /pairing code/);
  assert.throws(() => pairingQrPayload("https://gate.io", "A;rm -rf"), /pairing code/);
  assert.throws(() => pairingQrPayload("https://gate.io", ""), /pairing code/);
});

test("qr: no TTY → URL line only, the QR renderer is never called", () => {
  const calls: string[] = [];
  const spy = (payload: string): string => {
    calls.push(payload);
    return "SHOULD NOT APPEAR";
  };
  const { lines, usedQr } = renderPairingQr("https://gate.io/#pair=AB12CD34", { isTTY: false, renderQr: spy });
  assert.equal(calls.length, 0, "renderQr must not run without a TTY");
  assert.equal(usedQr, false);
  assert.deepEqual(lines, ["https://gate.io/#pair=AB12CD34"]);
});

test("qr: TTY → framed guidance + URL + the rendered QR", () => {
  const calls: string[] = [];
  const { lines, usedQr } = renderPairingQr("https://gate.io/#pair=AB12CD34", {
    isTTY: true,
    renderQr: (payload) => {
      calls.push(payload);
      return "▀▀█ QR █▀▀";
    },
  });
  assert.deepEqual(calls, ["https://gate.io/#pair=AB12CD34"], "renderer gets the exact payload");
  assert.equal(usedQr, true);
  assert.ok(lines.some((l) => l.includes("Quét bằng điện thoại để mở PWA đã điền sẵn code")));
  assert.ok(lines.some((l) => l.includes("#pair=AB12CD34")));
  assert.ok(lines.some((l) => l.includes("▀▀█ QR █▀▀")));
});

test("qr: printPairingQr logs through the sink and skips the renderer without a TTY", () => {
  const calls: string[] = [];
  const logged: string[] = [];
  const usedQr = printPairingQr("https://gate.io/#pair=AB12CD34", (l) => logged.push(l), {
    isTTY: false,
    renderQr: (p) => {
      calls.push(p);
      return "QR";
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(usedQr, false);
  assert.deepEqual(logged, ["https://gate.io/#pair=AB12CD34"]);
});

test("qr: printPairingQr on a TTY prints the QR block through the sink", () => {
  const logged: string[] = [];
  const usedQr = printPairingQr("https://gate.io/#pair=AB12CD34", (l) => logged.push(l), {
    isTTY: true,
    renderQr: () => "▀█▀",
  });
  assert.equal(usedQr, true);
  assert.ok(logged.includes("▀█▀"));
  assert.ok(logged.some((l) => l.includes("#pair=AB12CD34")));
});
