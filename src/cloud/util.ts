/** Small crypto/format helpers for the cloud side. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison (both hashed first to equalise length). */
export function sameSecret(a: string, b: string): boolean {
  const ha = Buffer.from(sha256Hex(a), "utf8");
  const hb = Buffer.from(sha256Hex(b), "utf8");
  return timingSafeEqual(ha, hb);
}

/** Short, human-typable codes without lookalikes (no 0/O/1/I). */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function randomCode(len = 8): string {
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

/** Reads a JSON object body with a size cap; `null` when not a small object. */
export async function readJsonBody(req: import("node:http").IncomingMessage, maxBytes = 4096): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
