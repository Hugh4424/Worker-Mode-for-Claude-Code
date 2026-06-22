// check-context-health test — read-only post-hoc analysis of a FOREMAN (main-session)
// Claude Code transcript. It reports two numbers: (1) big self-read/self-write chunk
// count + how many were delegatable (a RANGE), and (2) compaction-aware context growth.
//
// All fixtures are small hand-built JSONL temp files so every assertion is EXACT and
// FALSIFIABLE. The two load-bearing traps are pinned with their own tests:
//   - dedup trap: one assistant turn split across two lines sharing message.id; a
//     tool_use must be counted ONCE by its OWN toolu_ id, not dropped by message.id dedup.
//   - compaction trap: a mid-session context drop must NOT make growth look small via a
//     naive last-first; growth is the compaction-aware segmented sum.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(pluginRoot, "tools", "check-context-health.mjs");

const { analyzeContextHealth, BIG_CHUNK_BYTES, BIG_CHUNK_LINES, COMPACTION_DROP_TOKENS } =
  await import(scriptPath);

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cch-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ── fixture builders ──────────────────────────────────────────────────────────
// A transcript is foreman lines (isSidechain:false) plus optional subagent lines
// (isSidechain:true) which must be ignored by BOTH metrics.

function writeTranscript(lines) {
  const p = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

// assistant line carrying tool_use blocks + usage
function asst(id, content, usage, opts = {}) {
  return {
    type: "assistant",
    isSidechain: opts.sidechain === true,
    timestamp: opts.ts || "2026-06-19T10:00:00.000Z",
    message: { id, model: "claude-opus-4-8", usage: usage || null, content },
  };
}

// user line carrying a tool_result for a given tool_use id, with content sized by `bytes`.
// opts.content overrides the generated payload verbatim (used to inject real newlines).
function toolResult(toolUseId, bytes, opts = {}) {
  const content = typeof opts.content === "string" ? opts.content : "x".repeat(bytes);
  return {
    type: "user",
    isSidechain: opts.sidechain === true,
    timestamp: opts.ts || "2026-06-19T10:00:01.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: opts.isError === true }] },
    toolUseResult: opts.toolUseResult || { stdout: content, stderr: "", interrupted: false },
  };
}

const BIG = BIG_CHUNK_BYTES + 100; // safely over the byte threshold
const SMALL = 50;

// ── Metric 1: big self-read/self-write count ────────────────────────────────────

test("counts a big Read result as a big self-read", () => {
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/never.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_1", BIG),
  ]);
  const r = analyzeContextHealth(t);
  assert.equal(r.bigSelfReads, 1);
});

test("a SMALL read is NOT a big self-read", () => {
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/small.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_1", SMALL),
  ]);
  assert.equal(analyzeContextHealth(t).bigSelfReads, 0);
});

test("a many-SHORT-lines read (>BIG_CHUNK_LINES but <BIG_CHUNK_BYTES) is a big self-read", () => {
  // 200 lines of "ab\n" = 600 bytes — well under the 6000-byte bound but well over the
  // 150-line bound. A long file of many short lines is clearly a big read; byte-only
  // logic misses it. Revert big to bytes-only → this goes RED (bigSelfReads=0).
  const manyShortLines = Array(200).fill("ab").join("\n"); // 200 lines, ~599 bytes
  assert.ok(manyShortLines.length < BIG_CHUNK_BYTES, "fixture must stay under the byte bound");
  assert.ok((manyShortLines.match(/\n/g) || []).length > BIG_CHUNK_LINES, "fixture must exceed the line bound");
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/long.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_1", 0, { content: manyShortLines }),
  ]);
  assert.equal(analyzeContextHealth(t).bigSelfReads, 1);
});

test("BOUNDARY: a 151-line read with NO trailing newline (150 '\\n') is still big", () => {
  // The off-by-one: 151 lines joined by "\n" has only 150 newline CHARS. Counting
  // newlines gives 150, which is NOT > 150 → the read is wrongly missed. Counting
  // LINES (split("\n").length) gives 151 > 150 → correctly flagged. This pins the
  // boundary the 200-line test was too loose to catch. Revert countLines to a newline
  // count → this goes RED (bigSelfReads=0).
  const exactly151 = Array(151).fill("z").join("\n"); // 151 lines, 150 "\n", ~301 bytes
  assert.ok(exactly151.length < BIG_CHUNK_BYTES, "fixture must stay under the byte bound");
  assert.equal((exactly151.match(/\n/g) || []).length, BIG_CHUNK_LINES, "fixture has exactly 150 newline chars");
  assert.equal(exactly151.split("\n").length, BIG_CHUNK_LINES + 1, "but is 151 real lines");
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/edge.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_1", 0, { content: exactly151 }),
  ]);
  assert.equal(analyzeContextHealth(t).bigSelfReads, 1);
});

test("a big Edit (self-write) counts via its INPUT size, not result size", () => {
  // Edit results are tiny; the write cost is the input content. A big new_string must
  // register as a self-write even though its tool_result is small.
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_e", name: "Edit", input: { file_path: "/x/f.ts", old_string: "a", new_string: "z".repeat(BIG) } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_e", SMALL),
  ]);
  assert.equal(analyzeContextHealth(t).bigSelfReads, 1);
});

test("Agent/Task dispatches are NOT counted as self-work", () => {
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_ag", name: "Agent", input: { prompt: "z".repeat(BIG) } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_ag", BIG),
    asst("a2", [{ type: "tool_use", id: "toolu_tk", name: "Task", input: { prompt: "z".repeat(BIG) } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_tk", BIG),
  ]);
  assert.equal(analyzeContextHealth(t).bigSelfReads, 0);
});

test("subagent (isSidechain) tool calls are ignored", () => {
  const t = writeTranscript([
    asst("s1", [{ type: "tool_use", id: "toolu_sub", name: "Read", input: { file_path: "/x/sub.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }, { sidechain: true }),
    toolResult("toolu_sub", BIG, { sidechain: true }),
  ]);
  assert.equal(analyzeContextHealth(t).bigSelfReads, 0);
});

// ── DEDUP TRAP ──────────────────────────────────────────────────────────────────

test("DEDUP TRAP: a tool_use split across two lines sharing message.id counts ONCE", () => {
  // Real Claude Code split turn: same message.id "a1" on two lines, text on one,
  // the tool_use sibling on the other. Counting must dedup by the tool_use's OWN
  // toolu_ id, never drop it via message.id dedup. Revert that → this goes RED (0).
  const t = writeTranscript([
    asst("a1", [{ type: "text", text: "Reading." }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    asst("a1", [{ type: "tool_use", id: "toolu_dup", name: "Read", input: { file_path: "/x/never.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_dup", BIG),
    // and the exact same tool_use id echoed on yet another line must still be ONE.
    asst("a1", [{ type: "tool_use", id: "toolu_dup", name: "Read", input: { file_path: "/x/never.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
  ]);
  assert.equal(analyzeContextHealth(t).bigSelfReads, 1);
});

// ── DELEGATABLE RANGE ───────────────────────────────────────────────────────────

test("delegatable range brackets: never-touched read = floor; later-Edited read = excluded", () => {
  // Two big reads. /x/keep.ts is never mutated → clearly delegatable (floor & ceiling).
  // /x/edit.ts is Edited later in the session → NOT delegatable (excluded from both).
  // Expect bigSelfReads = 2 (both reads big), delegatableRange = [1,1].
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_keep", name: "Read", input: { file_path: "/x/keep.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_keep", BIG),
    asst("a2", [{ type: "tool_use", id: "toolu_re", name: "Read", input: { file_path: "/x/edit.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_re", BIG),
    asst("a3", [{ type: "tool_use", id: "toolu_ed", name: "Edit", input: { file_path: "/x/edit.ts", old_string: "a", new_string: "b" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_ed", SMALL),
  ]);
  const r = analyzeContextHealth(t);
  assert.equal(r.bigSelfReads, 2);
  assert.deepEqual(r.delegatableRange, [1, 1]);
});

test("ambiguous big read (Grep over a dir / Bash) lifts the CEILING only", () => {
  // A big Grep whose target is a directory (unresolvable to one file) is ambiguous:
  // it should NOT be in the floor but SHOULD be in the ceiling. Combined with one
  // clearly-delegatable file read, range must be [1,2] — proving floor<ceiling is
  // computed, not hardcoded.
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_keep", name: "Read", input: { file_path: "/x/keep.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_keep", BIG),
    asst("a2", [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "foo", path: "/x" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_grep", BIG),
  ]);
  const r = analyzeContextHealth(t);
  assert.equal(r.bigSelfReads, 2);
  assert.deepEqual(r.delegatableRange, [1, 2]);
});

test("error-driven big read is NOT delegatable (excluded from both floor and ceiling)", () => {
  // A big read whose result is an error (is_error) is reactive debugging, not a
  // self-contained delegatable read. floor & ceiling stay 0 though bigSelfReads=1.
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_err", name: "Read", input: { file_path: "/x/boom.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_err", BIG, { isError: true }),
  ]);
  const r = analyzeContextHealth(t);
  assert.equal(r.bigSelfReads, 1);
  assert.deepEqual(r.delegatableRange, [0, 0]);
});

// ── Metric 2: context growth (compaction-aware) ─────────────────────────────────

test("simple monotonic growth = last - first", () => {
  const t = writeTranscript([
    asst("a1", [{ type: "text", text: "1" }], { input_tokens: 100, cache_read_input_tokens: 0 }),   // 100
    asst("a2", [{ type: "text", text: "2" }], { input_tokens: 100, cache_read_input_tokens: 200 }), // 300
    asst("a3", [{ type: "text", text: "3" }], { input_tokens: 100, cache_read_input_tokens: 400 }), // 500
  ]);
  const r = analyzeContextHealth(t);
  assert.equal(r.contextNetGrowth, 400);
  assert.equal(r.contextPeak, 400);
  assert.equal(r.compactionsDetected, 0);
});

test("COMPACTION TRAP: a 200k mid-session drop is compaction-aware, NOT naive last-first", () => {
  // Series: 50k → 250k → (compact) 30k → 130k.
  // Naive last-first = 130k - 50k = 80k  (LYING — ignores the 200k of work done pre-compact).
  // Compaction-aware = seg1(250k-50k=200k) + seg2(130k-30k=100k) = 300k.
  // compactionsDetected must be 1. Peak = 250k - 50k = 200k.
  const t = writeTranscript([
    asst("a1", [{ type: "text", text: "1" }], { input_tokens: 50000, cache_read_input_tokens: 0 }),      // 50k
    asst("a2", [{ type: "text", text: "2" }], { input_tokens: 50000, cache_read_input_tokens: 200000 }), // 250k
    asst("a3", [{ type: "text", text: "3" }], { input_tokens: 30000, cache_read_input_tokens: 0 }),      // 30k  (compacted)
    asst("a4", [{ type: "text", text: "4" }], { input_tokens: 30000, cache_read_input_tokens: 100000 }), // 130k
  ]);
  const r = analyzeContextHealth(t);
  assert.equal(r.compactionsDetected, 1);
  assert.equal(r.contextNetGrowth, 300000); // NOT 80000
  assert.notEqual(r.contextNetGrowth, 80000);
  assert.equal(r.contextPeak, 200000);
});

test("context series dedups by message.id (split turn is one data point, not two)", () => {
  // Same message.id "a2" on two lines (split turn). Counted once at 300, so growth 200.
  // If dedup-by-id is dropped, the duplicate 300 still yields the same value here, so we
  // make the second copy carry a DIFFERENT usage to prove only the first is taken.
  const t = writeTranscript([
    asst("a1", [{ type: "text", text: "1" }], { input_tokens: 100, cache_read_input_tokens: 0 }),     // 100
    asst("a2", [{ type: "text", text: "2" }], { input_tokens: 100, cache_read_input_tokens: 200 }),   // 300 (kept)
    asst("a2", [{ type: "tool_use", id: "toolu_z", name: "Bash" }], { input_tokens: 999999, cache_read_input_tokens: 0 }), // ignored dup
  ]);
  const r = analyzeContextHealth(t);
  assert.equal(r.contextNetGrowth, 200);
  assert.equal(r.contextPeak, 200);
});

test("subagent turns do not pollute the context series", () => {
  const t = writeTranscript([
    asst("a1", [{ type: "text", text: "1" }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    asst("s1", [{ type: "text", text: "sub" }], { input_tokens: 999999, cache_read_input_tokens: 0 }, { sidechain: true }),
    asst("a2", [{ type: "text", text: "2" }], { input_tokens: 100, cache_read_input_tokens: 300 }),
  ]);
  const r = analyzeContextHealth(t);
  assert.equal(r.contextNetGrowth, 300);
});

// ── thresholds are named + tunable ──────────────────────────────────────────────

test("thresholds are exported numeric consts", () => {
  assert.equal(typeof BIG_CHUNK_BYTES, "number");
  assert.equal(typeof BIG_CHUNK_LINES, "number");
  assert.equal(typeof COMPACTION_DROP_TOKENS, "number");
});

// ── robustness ──────────────────────────────────────────────────────────────────

test("missing transcript file throws (let-it-crash, never fabricate zeros)", () => {
  assert.throws(() => analyzeContextHealth(join(dir, "nope.jsonl")));
});

test("a malformed (non-blank) JSON line THROWS with its line number (let-it-crash, never silently drop)", () => {
  // Silently skipping a corrupt line can drop a tool_use and produce a silently-WRONG
  // count. A genuinely malformed transcript must fail LOUD, not fabricate a number.
  // Revert to silent-skip → this goes RED (no throw). The /line 2/ check pins the
  // reported line number so the message can't drift to a useless error either.
  const p = join(dir, "bad.jsonl");
  const good = JSON.stringify(asst("a1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/never.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }));
  const res = JSON.stringify(toolResult("toolu_1", BIG));
  writeFileSync(p, good + "\n" + "{not json" + "\n" + res + "\n");
  assert.throws(() => analyzeContextHealth(p), /malformed JSONL at line 2/);
});

test("blank / whitespace-only lines are still skipped (not corruption), never throw", () => {
  // Blank lines are normal JSONL padding, not corruption: they must be skipped without
  // throwing, and must not perturb the counts.
  const p = join(dir, "blanks.jsonl");
  const good = JSON.stringify(asst("a1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/never.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }));
  const res = JSON.stringify(toolResult("toolu_1", BIG));
  // leading blank line, a whitespace-only line in the middle, trailing newlines.
  writeFileSync(p, "\n" + good + "\n   \t\n" + res + "\n\n");
  assert.doesNotThrow(() => analyzeContextHealth(p));
  assert.equal(analyzeContextHealth(p).bigSelfReads, 1);
});

// ── CLI report wording (blind spots must be stated) ─────────────────────────────

test("CLI report states the three blind spots from the design doc", () => {
  const t = writeTranscript([
    asst("a1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/never.ts" } }], { input_tokens: 100, cache_read_input_tokens: 0 }),
    toolResult("toolu_1", BIG),
  ]);
  const r = spawnSync("node", [scriptPath, t], { encoding: "utf8" });
  assert.equal(r.status, 0, `CLI must exit 0; stderr=${r.stderr}`);
  const out = r.stdout.toLowerCase();
  // (1) measures own context cost, not whether work SHOULD have been delegated
  assert.match(out, /own context/);
  assert.match(out, /not.*(whether|should).*delegat/);
  // (2) delegatable is a heuristic RANGE, not exact
  assert.match(out, /heuristic/);
  assert.match(out, /range/);
  // (3) does not score delegation rate
  assert.match(out, /not.*(score|rate)/);
});

test("CLI with no path argument exits non-zero", () => {
  const r = spawnSync("node", [scriptPath], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
});

// ── integration smoke test on a REAL transcript (degrades gracefully) ────────────
// Committed evidence that the script runs end-to-end on a genuine Claude transcript,
// without committing any private/huge transcript. Asserts shape/invariants only —
// NEVER exact metric values (a real transcript changes between runs). If no real
// transcript is on this machine, the test SKIPS with a clear message (never fails,
// never fabricates). We pick a known-complete past session by name first, then fall
// back to any other *.jsonl that parses cleanly — important because Fix 1 now THROWS
// on a truncated/corrupt line (e.g. a live session mid-write), and a smoke test must
// not surface that as a shape failure. We do NOT catch-and-swallow the parse error of
// the chosen file once selected — that would mask Fix 1's let-it-crash.
test("smoke: analyzeContextHealth runs on a real Claude transcript (skips if none present)", (t) => {
  const projectsDir = "/Users/Hugh/.claude/projects/-Users-Hugh-Hugh-Project-multica-agenthub";
  const preferred = join(projectsDir, "f106a633-32e0-400b-8fb6-0d10159b97f7.jsonl");

  // Build the candidate list: the known-complete file first, then every other *.jsonl.
  let candidates = [];
  if (existsSync(projectsDir)) {
    const all = readdirSync(projectsDir).filter((f) => f.endsWith(".jsonl")).map((f) => join(projectsDir, f));
    candidates = [preferred, ...all.filter((f) => f !== preferred)].filter((f) => existsSync(f));
  } else if (existsSync(preferred)) {
    candidates = [preferred];
  }

  // Choose the first candidate that parses cleanly (a truncated final line throws under
  // Fix 1; that's a property of THAT file, not a script bug — try the next one).
  let chosen = null;
  let r = null;
  for (const f of candidates) {
    try {
      r = analyzeContextHealth(f);
      chosen = f;
      break;
    } catch {
      // corrupt/truncated transcript on disk — not our concern for a smoke test; try next.
    }
  }

  if (!chosen) {
    t.skip("no real Claude transcript found on this machine (clean *.jsonl absent); smoke coverage skipped");
    return;
  }

  // Shape / invariants only — values vary with the real transcript.
  assert.equal(typeof r.bigSelfReads, "number");
  assert.ok(r.bigSelfReads >= 0, "bigSelfReads must be a non-negative count");
  // contextNetGrowth can legitimately be negative (a non-compacted segment may shrink),
  // so assert finiteness, NOT non-negativity.
  assert.ok(Number.isFinite(r.contextNetGrowth), "contextNetGrowth must be a finite number");
  assert.equal(typeof r.compactionsDetected, "number");
  assert.ok(r.compactionsDetected >= 0, "compactionsDetected must be a non-negative count");
  assert.ok(Array.isArray(r.delegatableRange) && r.delegatableRange.length === 2, "delegatableRange is a 2-tuple");
  const [lo, hi] = r.delegatableRange;
  assert.ok(Number.isFinite(lo) && Number.isFinite(hi), "delegatableRange entries are numbers");
  assert.ok(lo <= hi, "delegatableRange must be sorted [floor, ceiling]");
});
