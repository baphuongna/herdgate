/* Fuzzy file matcher — the herdr-file-viewer scoring (fuzzy.rs) in web form:
 * case-insensitive subsequence over the whole path, with a basename bonus (a
 * match landing wholly inside the file's own name outranks one that needs
 * directory characters) and shorter-path tie-breaks. Pure, no I/O; loaded by
 * app.js as a module and by Node tests through the globalThis assignment. */
(function (root) {
  "use strict";

  /** score(path, lowercased query chars) → number | null (null = no match).
   * Lower is better. Basename-only matches beat anything needing directories;
   * then fewer gap jumps; then the shorter path. */
  function score(queryChars, path) {
    const lower = path.toLowerCase();
    const slash = lower.lastIndexOf("/");
    const baseAt = slash + 1; // where the basename starts
    let qi = 0;
    let gaps = 0;
    let prev = -1;
    let inBase = true; // every matched char so far landed inside the basename
    for (let i = 0; i < lower.length && qi < queryChars.length; i++) {
      if (lower[i] !== queryChars[qi]) continue;
      if (i < baseAt) inBase = false; // this hit needed a directory character
      if (prev >= 0 && i > prev + 1) gaps += i - prev - 1; // tighter runs win
      prev = i;
      qi++;
    }
    if (qi < queryChars.length) return null; // ran out of path before query
    // A basename-hit bonus so large it always outranks directory-dependent runs.
    return (inBase ? 0 : 1_000_000) + gaps * 10 + lower.length;
  }

  /** Indices of `candidates` matching `query`, best-first (stable on ties). */
  function matchAndRank(query, candidates) {
    if (!query) return [];
    const qc = query.toLowerCase().split("");
    const scored = [];
    for (let i = 0; i < candidates.length; i++) {
      const s = score(qc, candidates[i]);
      if (s !== null) scored.push([i, s]);
    }
    scored.sort((a, b) => a[1] - b[1] || a[0] - b[0]); // stable: original order on ties
    return scored.map((x) => x[0]);
  }

  /** Smartcase in-file search (search.rs): literal substring, never a regex;
   *  a query with ANY uppercase matches case-sensitively, all-lowercase matches
   *  anywhere. Returns match [start, end) offsets per line, in order. */
  function searchLine(line, query) {
    if (!query) return [];
    const hay = /[A-Z]/.test(query) ? line : line.toLowerCase();
    const needle = /[A-Z]/.test(query) ? query : query.toLowerCase();
    const hits = [];
    let at = 0;
    for (;;) {
      const i = hay.indexOf(needle, at);
      if (i === -1) return hits;
      hits.push([i, i + query.length]);
      at = i + query.length;
    }
  }

  root.hgFuzzy = { matchAndRank, searchLine };
})(typeof self !== "undefined" ? self : globalThis);
