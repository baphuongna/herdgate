// Safe update policy primitives shared by the Herdgate updaters.
//
// Lessons baked in from herdr-updater:
//   - never guess a version: anything that does not parse as strict semver is
//     null, and a failed comparison is the ERROR state "unknown" — it is never
//     silently treated as "current" or "up to date";
//   - order only by semver precedence (0.10.0 > 0.9.0 > 0.9.0-rc.1), never by
//     string or numeric inequality;
//   - update decisions are recorded in an append-only JSONL history.
import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const HISTORY_FILE = "update-history.jsonl";

// Official semver grammar; build metadata is allowed but ignored for precedence.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const NUMERIC = /^\d+$/;

/** Parse a strict semver string into precedence parts; anything else is null (never a guess). */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = VERSION.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Compare two versions by semver precedence: -1 | 0 | 1, or null when either side does not parse. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  const ra = left.prerelease;
  const rb = right.prerelease;
  if (!ra.length || !rb.length) {
    if (ra.length === rb.length) return 0;
    // A prerelease sorts below the plain release: 0.9.0 > 0.9.0-rc.1.
    return ra.length ? -1 : 1;
  }
  const shared = Math.min(ra.length, rb.length);
  for (let i = 0; i < shared; i++) {
    const x = ra[i];
    const y = rb[i];
    const xn = NUMERIC.test(x);
    const yn = NUMERIC.test(y);
    if (xn && yn) {
      const order = Number(x) - Number(y);
      if (order) return order < 0 ? -1 : 1;
    } else if (xn !== yn) {
      // Numeric identifiers sort below alphanumeric ones.
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (ra.length === rb.length) return 0;
  // A larger set of pre-release fields has higher precedence: alpha < alpha.1.
  return ra.length < rb.length ? -1 : 1;
}

/** installed vs latest: same | behind | ahead, or unknown (parse failed — an error state, not "current"). */
export function relation(installed, latest) {
  const order = compareVersions(installed, latest);
  if (order === null) return "unknown";
  return order < 0 ? "behind" : order > 0 ? "ahead" : "same";
}

/** HERDGATE_UPDATE_POLICY: only the exact value "auto" opts in; anything else fails closed to notify. */
export function policyFromEnv(env) {
  return env && env.HERDGATE_UPDATE_POLICY === "auto" ? "auto" : "notify";
}

/** Append one decision record as JSONL; the file is only ever appended to, never rewritten. */
export function appendHistory(stateDir, record) {
  if (!stateDir || typeof stateDir !== "string") throw new TypeError("appendHistory requires a state directory");
  if (!record || typeof record !== "object") throw new TypeError("appendHistory requires a record");
  mkdirSync(stateDir, { recursive: true });
  const entry = {
    at: typeof record.at === "string" && record.at ? record.at : new Date().toISOString(),
    from: record.from ?? null,
    to: record.to ?? null,
    relation: record.relation ?? null,
    action: record.action ?? null,
  };
  const host = record.host ?? hostname();
  if (host) entry.host = host;
  // Flag "a" positions at the end and never truncates an existing history.
  appendFileSync(join(stateDir, HISTORY_FILE), JSON.stringify(entry) + "\n", { flag: "a" });
  return entry;
}
