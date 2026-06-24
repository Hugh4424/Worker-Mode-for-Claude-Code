// self-work-classifier.mjs — shared "foreman self-read / delegatable" classifier.
// Consumed by check-context-health.mjs (retrospective health check). The two-layer
// API is kept split so both a single-call judgment and a full-session aggregation
// can share identical thresholds and classification logic without duplicating constants.
// (Historical note: Layer 1 was also designed to be callable from a PostToolUse hook;
// that nudge hook has since been removed, so the only live consumer now is the
// retrospective health check. Layer 1 remains pure/stateless and hook-safe by design.)
//
// Two-layer API (hard requirement — do not merge into one function):
//   Layer 1 — isBigSelfChunk({ toolUse, result })
//     Pure single-call judgment: is THIS one tool invocation a big self-chunk?
//     No cross-turn state; only local data needed.
//
//   Layer 2 — aggregateDelegatable({ toolUses, mutatedFiles })
//     Full-session aggregation: which big reads were likely delegatable?
//     Requires cross-turn mutatedFiles knowledge (built by the caller).
//
// Node ESM, zero external dependencies.

// ── exported constants ────────────────────────────────────────────────────────────
// Shared by all consumers; change here, not in each caller.
export const BIG_CHUNK_LINES = 150;
export const BIG_CHUNK_BYTES = 6000;
export const COMPACTION_DROP_TOKENS = 100000;

// ── internal tool sets ────────────────────────────────────────────────────────────
// Reads: big cost lives in the returned RESULT.
// Writes: big cost lives in the INPUT text (the result is a tiny ack).
// Agent/Task are delegation events — the opposite of self-work.
// Glob is included: a big Glob result dumps many file paths into the foreman context
// and should be treated as a big self-read (same as a broad Grep or Bash find).
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

// ── size helpers ──────────────────────────────────────────────────────────────────

function countLines(s) {
  // Real line count, not newline count: a 151-line file with NO trailing newline
  // has only 150 "\n" but is 151 lines. split("\n").length gives 151 — matches the
  // repo's own large_read_intercept (content.split("\n").length), so the >150 boundary
  // fires correctly. Empty string is 0 lines (not 1).
  // NOTE: for multi-block / multi-field content the callers SUM per-piece line
  // counts, which can over-count by ~1 per extra piece. That only ever makes a read
  // MORE likely flagged big (never misses), and big-chunk is a tunable heuristic, so
  // the over-approx is acceptable; tighten only if false-positives matter.
  return typeof s === "string" && s.length > 0 ? s.split("\n").length : 0;
}

function resultBytes(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    // content can be an array of {type:"text",text} blocks
    return content.reduce((n, b) => n + (b && typeof b.text === "string" ? b.text.length : 0), 0);
  }
  return 0;
}

function resultLines(content) {
  if (typeof content === "string") return countLines(content);
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + (b && typeof b.text === "string" ? countLines(b.text) : 0), 0);
  }
  return 0;
}

function inputBytes(input) {
  if (!input || typeof input !== "object") return 0;
  // Self-write cost lives in the written text, not the tiny tool_result. Sum the
  // text-bearing fields a Write/Edit carries.
  let n = 0;
  for (const k of ["content", "new_string", "old_string"]) {
    if (typeof input[k] === "string") n += input[k].length;
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e.new_string === "string") n += e.new_string.length;
    }
  }
  return n;
}

function inputLines(input) {
  if (!input || typeof input !== "object") return 0;
  let n = 0;
  for (const k of ["content", "new_string", "old_string"]) {
    if (typeof input[k] === "string") n += countLines(input[k]);
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e.new_string === "string") n += countLines(e.new_string);
    }
  }
  return n;
}

// ── resolveTargetFile (used by aggregateDelegatable) ─────────────────────────────
// Resolve the single file a read targets, or null if unresolvable (→ ambiguous).
//   Read → input.file_path (a single file)
//   Grep → input.path only if it looks like a file (has an extension); a dir → null
//   Bash → unresolvable (arbitrary command) → null
export function resolveTargetFile(name, input) {
  if (name === "Read") {
    return input && typeof input.file_path === "string" ? input.file_path : null;
  }
  if (name === "Grep") {
    const p = input && typeof input.path === "string" ? input.path : null;
    // a path with a file extension on its basename → treat as a file; otherwise dir.
    if (p && /\.[A-Za-z0-9]+$/.test(p.split("/").pop() || "")) return p;
    return null;
  }
  // Bash and anything else: unresolvable.
  return null;
}

// ── Layer 1: isBigSelfChunk ───────────────────────────────────────────────────────
// Pure single-call judgment. Only inspects this one tool invocation — no cross-turn
// state, no mutatedFiles. Safe to call from a PostToolUse hook with only local data.
//
// Parameters:
//   toolUse — { name: string, input: object }  (the tool_use block from the transcript)
//   result  — { bytes: number, lines: number, isError: boolean } | null
//              (pre-computed from the tool_result block; null if no result yet)
//
// Returns { isBigSelfRead, isBigSelfWrite, reason }
//   isBigSelfRead  — true if this is a Read/Grep/Bash call whose result is big
//   isBigSelfWrite — true if this is a Write/Edit/MultiEdit call whose input is big
//   reason         — human-readable string explaining the verdict (for logging/debugging)
//
// Agent/Task tools return { isBigSelfRead: false, isBigSelfWrite: false } — they are
// delegation events, not self-work.
export function isBigSelfChunk({ toolUse, result }) {
  const name = toolUse && toolUse.name;
  const input = toolUse && toolUse.input;

  // Delegation tools are never self-work.
  if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
    return { isBigSelfRead: false, isBigSelfWrite: false, reason: "delegation tool or unknown" };
  }

  if (WRITE_TOOLS.has(name)) {
    const bytes = inputBytes(input);
    const lines = inputLines(input);
    const big = bytes >= BIG_CHUNK_BYTES || lines > BIG_CHUNK_LINES;
    return {
      isBigSelfRead: false,
      isBigSelfWrite: big,
      reason: big
        ? `write input: ${bytes} bytes / ${lines} lines`
        : `write input small: ${bytes} bytes / ${lines} lines`,
    };
  }

  // READ_TOOLS: size by result
  const bytes = result ? result.bytes : 0;
  const lines = result ? result.lines : 0;
  const big = bytes >= BIG_CHUNK_BYTES || lines > BIG_CHUNK_LINES;
  return {
    isBigSelfRead: big,
    isBigSelfWrite: false,
    reason: big
      ? `read result: ${bytes} bytes / ${lines} lines`
      : `read result small: ${bytes} bytes / ${lines} lines`,
  };
}

// ── Layer 2: aggregateDelegatable ─────────────────────────────────────────────────
// Full-session aggregation: which big reads were likely delegatable?
// Requires the full set of tool_uses (with their paired results) and the set of
// files that were mutated anywhere in the session.
//
// Parameters:
//   toolUses    — Map<id, { name, input, result: { bytes, lines, isError } | null }>
//                 Each entry is one foreman tool_use, keyed by tool_use_id.
//   mutatedFiles — Set<string> of file paths the foreman wrote/edited in this session.
//
// Returns delegatableRange: [floor, floor + ambiguous]
//   floor     — count of big reads that are clearly delegatable:
//                 resolvable to a single file, that file was never mutated, no error.
//   ceiling   — floor + ambiguous (reads whose target is unresolvable: Grep/Bash/etc.)
//
// Delegatable heuristic buckets:
//   floor     : Read → resolvable file → not later mutated → no error.
//   ambiguous : Grep-over-dir / Bash → target unresolvable → ceiling only.
//   excluded  : file IS later mutated, OR result is an error → reactive, not delegatable.
//   writes    : never delegatable (the foreman was authoring, not just reading).
export function aggregateDelegatable({ toolUses, mutatedFiles }) {
  let floor = 0;
  let ambiguous = 0;

  for (const [, { name, input, result }] of toolUses.entries()) {
    const isRead = READ_TOOLS.has(name);
    const isWrite = WRITE_TOOLS.has(name);
    if (!isRead && !isWrite) continue;

    // Determine if this call was a big chunk.
    const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({ toolUse: { name, input }, result });
    if (!isBigSelfRead && !isBigSelfWrite) continue;

    // Only reads are candidates for delegation.
    if (!isRead) continue;

    // Error-driven reads are reactive → not delegatable.
    if (result && result.isError) continue;

    const fp = resolveTargetFile(name, input);
    if (fp === null) {
      ambiguous++; // unresolvable target → ceiling only
    } else if (mutatedFiles.has(fp)) {
      // file resolved but later mutated → excluded from both floor and ceiling
    } else {
      floor++; // resolvable + never mutated + no error → clearly delegatable
    }
  }

  return [floor, floor + ambiguous];
}
