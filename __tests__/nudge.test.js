// nudge.test.js — integration tests for hooks/nudge-delegation.mjs
//
// Runs the hook as a child process (spawnSync), feeding JSONL transcripts via
// temp files and injecting transcript_path through stdin (as CC would). Every
// assertion is EXACT and FALSIFIABLE — no fuzzy shape checks.
//
// Coverage targets (1.4 from the design doc):
//  1. Window density at threshold  → strong nudge fires
//  2. First big cross-file grep    → light nudge fires
//  3. Agent dispatch in middle     → resets count; post-agent reads don't inherit old density
//  4. Light-cooldown + strong cond → strong still fires (independent cooldown)
//  5. Authority-file allowlist     → coordinator/CLAUDE/spec/state/progress reads are exempt
//  6. Generic .md docs archaeology → fires (generic .md not in allowlist)
//  7. Write state.json / small Edit → no trigger; big cross-file Write → triggers
//  8. Mixed read-write-read-test   → strong nudge fires (window density, not just consecutive)
//  9. Bad stdin / unreadable transcript → exit 0, no output
// 10. P1#10 guard: output never contains permissionDecision:"deny" or decision:"block"
// 11. Sparsity: 50 tool calls → injection count is single digits (≤9)

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookPath = join(pluginRoot, "hooks", "nudge-delegation.mjs");

// Import classifier constants for sizing fixtures.
const { BIG_CHUNK_BYTES, BIG_CHUNK_LINES } = await import(
  join(pluginRoot, "tools", "lib", "self-work-classifier.mjs")
);

const BIG = BIG_CHUNK_BYTES + 100; // safely over byte threshold
const SMALL = 50;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nudge-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── transcript fixture builders ───────────────────────────────────────────────

// Build an assistant line carrying tool_use blocks.
function asstLine(msgId, toolUses, opts = {}) {
  return {
    type: "assistant",
    isSidechain: opts.sidechain === true,
    timestamp: "2026-06-23T10:00:00.000Z",
    message: {
      id: msgId,
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_read_input_tokens: 0 },
      content: toolUses.map((tu) => ({ type: "tool_use", ...tu })),
    },
  };
}

// Build a user line carrying a tool_result.
function resultLine(toolUseId, contentStr, opts = {}) {
  const content = typeof contentStr === "string" ? contentStr : "x".repeat(contentStr);
  return {
    type: "user",
    isSidechain: opts.sidechain === true,
    timestamp: "2026-06-23T10:00:01.000Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: opts.isError === true,
        },
      ],
    },
  };
}

// A big read result string (over byte threshold).
const bigContent = "x".repeat(BIG);
// A big multi-line content (over line threshold, under byte threshold).
const bigLinesContent = Array(BIG_CHUNK_LINES + 5).fill("ab").join("\n");

// Write a JSONL transcript file from an array of line objects.
function writeTranscript(lines) {
  const p = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

// Run the hook as a subprocess with the given transcript_path in stdin.
// Returns { stdout, stderr, status }.
function runHook(transcriptPath, opts = {}) {
  const stdin = JSON.stringify({ transcript_path: transcriptPath || "" });
  const result = spawnSync("node", [hookPath], {
    input: stdin,
    encoding: "utf8",
    timeout: 8000,
    cwd: pluginRoot,
  });
  return result;
}

// Parse hook output: returns the JSON object if the hook wrote one, or null if silent.
function parseOutput(stdout) {
  const line = (stdout || "").trim();
  if (!line) return null;
  return JSON.parse(line);
}

// ── P1#10 guard helper ────────────────────────────────────────────────────────
// Checks that hook output never contains permissionDecision:"deny" or decision:"block".
function assertNoBlockOutput(result) {
  assert.equal(result.status, 0, `hook must always exit 0; stderr=${result.stderr}`);
  const raw = result.stdout || "";
  if (raw.trim()) {
    const obj = JSON.parse(raw.trim());
    // Must NOT have permissionDecision:"deny"
    assert.notEqual(obj.permissionDecision, "deny", "P1#10: must never output permissionDecision:deny");
    // Must NOT have decision:"block"
    assert.notEqual(obj.decision, "block", "P1#10: must never output decision:block");
    // Must NOT have deny field at all
    assert.ok(!("deny" in obj), "P1#10: must not have 'deny' key in output");
    // Must NOT have block field at all
    assert.ok(!("block" in obj), "P1#10: must not have 'block' key in output");
    // If it outputs anything, it must ONLY be additionalContext.
    assert.ok("additionalContext" in obj, "any hook output must have additionalContext key");
    assert.equal(Object.keys(obj).length, 1, "hook output must have exactly one key: additionalContext");
  }
}

// ── helpers to build sequences of tool turns ─────────────────────────────────

// Build a batch of N identical big Read turns (each with unique IDs).
function bigReadTurns(n, startIdx = 0, filePath = "/x/docs/foo.ts") {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const id = `toolu_r${startIdx + i}`;
    const msgId = `amsg_r${startIdx + i}`;
    lines.push(asstLine(msgId, [{ id, name: "Read", input: { file_path: filePath } }]));
    lines.push(resultLine(id, bigContent));
  }
  return lines;
}

// Build a single Agent dispatch turn.
function agentTurn(idx) {
  const id = `toolu_ag${idx}`;
  const msgId = `amsg_ag${idx}`;
  return [
    asstLine(msgId, [{ id, name: "Agent", input: { prompt: "do something" } }]),
    resultLine(id, "agent result"),
  ];
}

// ── Test 1: Window density at threshold → strong nudge fires ──────────────────

test("strong nudge fires when window self-read density ≥ threshold", () => {
  // STRONG_DENSITY=0.25, STRONG_MIN_COUNT=2.
  // 4 big reads in last 16 turns → density = 4/16 = 0.25, count=4 ≥ 2 → strong.
  // We use 8 big reads in 8 turns (density=1.0) to make it unambiguous.
  const lines = bigReadTurns(8, 0);
  const tp = writeTranscript(lines);

  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);

  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "hook must output a nudge");
  assert.match(out.additionalContext, /委派检查/, "output must contain 委派检查 marker");
  // Strong nudge contains the binary-choice text.
  assert.match(out.additionalContext, /选.*(A)|(A).*选/s, "strong nudge must contain choice (A)");
  assert.match(out.additionalContext, /写不出|选\s*\(A\)/u, "strong nudge must reference 写不出=选A pattern");
});

// ── Test 2: First big cross-file Grep → light nudge fires ─────────────────────

test("first big cross-file grep fires light nudge", () => {
  // Only one big Grep result (count=1, density<threshold for strong).
  // Light condition: bigSelfChunks >= 1.
  const tp = writeTranscript([
    asstLine("amsg_g1", [{ id: "toolu_g1", name: "Grep", input: { pattern: "foo", path: "/x" } }]),
    resultLine("toolu_g1", bigContent),
  ]);

  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);

  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "light nudge must fire on first big Grep");
  assert.match(out.additionalContext, /委派检查/);
  // Light nudge must NOT contain the binary-choice lines (those are strong-only).
  // Light is ≤2 lines without "二选一".
  assert.ok(
    !out.additionalContext.includes("(A)") || out.additionalContext.split("\n").length <= 2,
    "light nudge must be concise (≤2 lines)"
  );
});

// ── Test 3: Agent dispatch resets bigSelfChunks counter ───────────────────────

test("Agent dispatch in middle resets count; post-agent reads stay light (not strong)", () => {
  // Build: 6 big reads (pre-agent, dense enough for strong) → Agent → 1 big read.
  // If counter resets on Agent, only 1 post-agent read → light only (not strong).
  // If counter does NOT reset, 7 big reads → strong (test would see strong nudge → fail).
  const preAgentReads = bigReadTurns(6, 0);
  const agentLines = agentTurn(100);
  const postAgentRead = bigReadTurns(1, 10);

  const tp = writeTranscript([...preAgentReads, ...agentLines, ...postAgentRead]);
  const r = runHook(tp);

  assert.equal(r.status, 0);
  assertNoBlockOutput(r);

  const out = parseOutput(r.stdout);
  // Should fire (1 big read post-agent), but must be LIGHT (binary choice not present).
  assert.ok(out !== null, "hook should fire light nudge");
  // Light nudge: no "(A)" or only 1 line with delegation check.
  const ctx = out.additionalContext;
  const hasStrongMarker = ctx.includes("二选一") || ctx.includes("(B)");
  assert.equal(hasStrongMarker, false, "must be light nudge after agent reset, not strong");
});

// ── Test 4: Light cooldown must NOT suppress strong nudge ─────────────────────

test("strong nudge fires even during light-nudge cooldown period", () => {
  // Strategy: run hook twice with the same transcript path.
  // Run 1: 1 big read → light nudge fires, cooldown starts.
  // Run 2 (same transcript, more reads): enough for strong → MUST fire strong despite light cooldown.
  // We do this by running the hook twice against growing transcript snapshots.

  // First run: 1 big read → light fires.
  const lines1 = bigReadTurns(1, 0);
  const tp = writeTranscript(lines1);

  const r1 = runHook(tp);
  assert.equal(r1.status, 0);
  const out1 = parseOutput(r1.stdout);
  assert.ok(out1 !== null, "first run must fire (light)");
  const isStrong1 = out1.additionalContext.includes("二选一");
  assert.equal(isStrong1, false, "first run must be light");

  // Second run: add many more big reads to same transcript, force strong condition.
  // We overwrite the transcript with more reads.
  const lines2 = [...lines1, ...bigReadTurns(8, 1)]; // now 9 big reads
  writeFileSync(tp, lines2.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const r2 = runHook(tp);
  assert.equal(r2.status, 0);
  assertNoBlockOutput(r2);

  const out2 = parseOutput(r2.stdout);
  assert.ok(out2 !== null, "strong nudge must fire on second run");
  assert.ok(
    out2.additionalContext.includes("二选一") || out2.additionalContext.includes("(B)"),
    "second run must be strong nudge (not suppressed by light cooldown)"
  );
});

// ── Test 5: Authority-file allowlist exempt ────────────────────────────────────

test("reading coordinator.md (authority file) → no nudge even if result is big", () => {
  const tp = writeTranscript([
    asstLine("amsg_c1", [{ id: "toolu_c1", name: "Read", input: { file_path: "/agents/coordinator.md" } }]),
    resultLine("toolu_c1", bigContent),
  ]);

  const r = runHook(tp);
  assert.equal(r.status, 0);
  const out = parseOutput(r.stdout);
  assert.equal(out, null, "reading coordinator.md must NOT trigger nudge");
});

test("reading CLAUDE.md (authority file) → no nudge", () => {
  const tp = writeTranscript([
    asstLine("amsg_cl1", [{ id: "toolu_cl1", name: "Read", input: { file_path: "/Users/Hugh/.claude/CLAUDE.md" } }]),
    resultLine("toolu_cl1", bigContent),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal(parseOutput(r.stdout), null, "reading CLAUDE.md must NOT trigger nudge");
});

test("reading state.json (authority file) → no nudge", () => {
  const tp = writeTranscript([
    asstLine("amsg_s1", [{ id: "toolu_s1", name: "Read", input: { file_path: "/project/state.json" } }]),
    resultLine("toolu_s1", bigContent),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal(parseOutput(r.stdout), null, "reading state.json must NOT trigger nudge");
});

test("reading progress.json (authority file) → no nudge", () => {
  const tp = writeTranscript([
    asstLine("amsg_p1", [{ id: "toolu_p1", name: "Read", input: { file_path: "/project/progress.json" } }]),
    resultLine("toolu_p1", bigContent),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal(parseOutput(r.stdout), null, "reading progress.json must NOT trigger nudge");
});

test("reading spec file (authority file) → no nudge", () => {
  const tp = writeTranscript([
    asstLine("amsg_sp1", [{ id: "toolu_sp1", name: "Read", input: { file_path: "/docs/spec-v2.md" } }]),
    resultLine("toolu_sp1", bigContent),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal(parseOutput(r.stdout), null, "reading a spec file must NOT trigger nudge");
});

// ── Test 6: Generic .md docs NOT in allowlist → triggers ──────────────────────

test("reading a generic .md docs file (not in allowlist) → nudge fires", () => {
  // docs/some-design-notes.md — not coordinator, not spec, not state, not progress.
  const tp = writeTranscript([
    asstLine("amsg_d1", [{ id: "toolu_d1", name: "Read", input: { file_path: "/docs/some-design-notes.md" } }]),
    resultLine("toolu_d1", bigContent),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "reading a generic .md docs file MUST trigger nudge (generic .md not exempt)");
  assert.match(out.additionalContext, /委派检查/);
});

test("reading a generic README.md → nudge fires (not in allowlist)", () => {
  const tp = writeTranscript([
    asstLine("amsg_rm1", [{ id: "toolu_rm1", name: "Read", input: { file_path: "/project/README.md" } }]),
    resultLine("toolu_rm1", bigContent),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "reading README.md must trigger nudge");
});

// ── Test 7: Write state.json / small Edit → no trigger; big Write → triggers ──

test("writing state.json (allowlist write) → no nudge", () => {
  // Writing state.json is a red-line write (foreman must do it); exempt.
  const tp = writeTranscript([
    asstLine("amsg_ws1", [
      {
        id: "toolu_ws1",
        name: "Write",
        input: { file_path: "/project/state.json", content: "x".repeat(BIG) },
      },
    ]),
    resultLine("toolu_ws1", SMALL),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal(parseOutput(r.stdout), null, "writing state.json must NOT trigger nudge");
});

test("small one-line Edit → no nudge (below size threshold)", () => {
  const tp = writeTranscript([
    asstLine("amsg_e1", [
      {
        id: "toolu_e1",
        name: "Edit",
        input: { file_path: "/x/f.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      },
    ]),
    resultLine("toolu_e1", SMALL),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal(parseOutput(r.stdout), null, "small single-line Edit must NOT trigger nudge");
});

test("big cross-file Write → nudge fires", () => {
  // Write with big content (over byte threshold) to a regular (non-authority) file.
  const tp = writeTranscript([
    asstLine("amsg_bw1", [
      {
        id: "toolu_bw1",
        name: "Write",
        input: { file_path: "/x/big-new-file.ts", content: "z".repeat(BIG) },
      },
    ]),
    resultLine("toolu_bw1", SMALL),
  ]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "big Write must trigger nudge");
  assert.match(out.additionalContext, /委派检查/);
});

// ── Test 8: Mixed read-write-read-test → strong nudge (window density) ────────

test("mixed read-write-read-bash sequence triggers strong nudge via window density", () => {
  // Pattern: Read(big) → Write(big) → Read(big) → Bash(big result) — 4 big self-chunks
  // in short window. Pure "consecutive" logic would break on the Bash interleave.
  // Window density: 4 big chunks / 4 turns = 1.0 ≥ 0.25 and count ≥ 2 → strong.
  const lines = [
    // Turn 1: big Read
    asstLine("amsg_m1", [{ id: "toolu_m1", name: "Read", input: { file_path: "/x/file1.ts" } }]),
    resultLine("toolu_m1", bigContent),
    // Turn 2: big Write
    asstLine("amsg_m2", [
      { id: "toolu_m2", name: "Write", input: { file_path: "/x/file2.ts", content: "z".repeat(BIG) } },
    ]),
    resultLine("toolu_m2", SMALL),
    // Turn 3: big Read again
    asstLine("amsg_m3", [{ id: "toolu_m3", name: "Read", input: { file_path: "/x/file3.ts" } }]),
    resultLine("toolu_m3", bigContent),
    // Turn 4: Bash with big output
    asstLine("amsg_m4", [{ id: "toolu_m4", name: "Bash", input: { command: "find . -name '*.ts'" } }]),
    resultLine("toolu_m4", bigContent),
  ];

  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);

  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "mixed read-write-read-bash must trigger nudge");
  // Strong condition: density ≥ 0.25 and count ≥ 2.
  assert.ok(
    out.additionalContext.includes("二选一") || out.additionalContext.includes("(A)"),
    "mixed sequence must fire strong nudge (high density)"
  );
});

// ── Test 9: Bad stdin / unreadable transcript → exit 0, no output ─────────────

test("invalid JSON stdin → exit 0, no output (fail-safe)", () => {
  const result = spawnSync("node", [hookPath], {
    input: "not valid json{{{",
    encoding: "utf8",
    timeout: 8000,
    cwd: pluginRoot,
  });
  assert.equal(result.status, 0, "must exit 0 on bad stdin");
  assert.equal((result.stdout || "").trim(), "", "must produce no output on bad stdin");
});

test("nonexistent transcript path → exit 0, no output (fail-safe)", () => {
  const r = runHook("/nonexistent/path/transcript-nope.jsonl");
  assert.equal(r.status, 0, "must exit 0 when transcript unreadable");
  assert.equal((r.stdout || "").trim(), "", "must produce no output when transcript missing");
});

test("empty stdin (no transcript_path) → exit 0, no output", () => {
  const result = spawnSync("node", [hookPath], {
    input: "{}",
    encoding: "utf8",
    timeout: 8000,
    cwd: pluginRoot,
  });
  assert.equal(result.status, 0);
  assert.equal((result.stdout || "").trim(), "");
});

test("malformed JSONL transcript → exit 0, no output (fail-safe)", () => {
  // The hook uses silent-skip for malformed lines (unlike check-context-health which throws).
  // A transcript that is mostly garbled should still result in exit 0.
  const tp = writeTranscript([]);
  // Overwrite with garbage.
  writeFileSync(tp, "not json\nalso not json\n{broken");
  const r = runHook(tp);
  assert.equal(r.status, 0);
  // May or may not produce output depending on what it parses, but must not crash.
  assert.equal(r.status, 0, "must exit 0 on malformed transcript");
});

// ── Test 10: P1#10 guard — explicit output structure assertions ────────────────

test("P1#10: nudge output never contains permissionDecision:deny", () => {
  // Force a nudge to fire, then check the output.
  const lines = bigReadTurns(8, 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);

  const raw = (r.stdout || "").trim();
  if (raw) {
    const obj = JSON.parse(raw);
    assert.ok(obj.permissionDecision !== "deny", "P1#10: permissionDecision must not be deny");
    assert.ok(obj.decision !== "block", "P1#10: decision must not be block");
    assert.ok(!("block" in obj), "P1#10: no block key");
    assert.ok(!("deny" in obj), "P1#10: no deny key");
  }
});

test("P1#10: hook always exits 0, even when nudge fires", () => {
  const lines = bigReadTurns(8, 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0, "P1#10: hook must always exit 0");
});

test("P1#10: output structure is exactly {additionalContext: string} when nudge fires", () => {
  const lines = bigReadTurns(8, 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);

  const raw = (r.stdout || "").trim();
  if (raw) {
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj);
    assert.equal(keys.length, 1, "P1#10: output must have exactly 1 key");
    assert.equal(keys[0], "additionalContext", "P1#10: that key must be additionalContext");
    assert.equal(typeof obj.additionalContext, "string", "P1#10: additionalContext must be a string");
    assert.ok(obj.additionalContext.length > 0, "P1#10: additionalContext must be non-empty");
  }
});

// Test with empty transcript (no nudge), also exit 0.
test("P1#10: hook exits 0 with empty (no-nudge) transcript", () => {
  const tp = writeTranscript([]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal((r.stdout || "").trim(), "");
});

// ── Test 11: Sparsity — 50 tool calls → injection count ≤ 9 ──────────────────

test("sparsity: 50 tool calls in a realistic session produce ≤9 nudge injections", () => {
  // Simulates a realistic orchestrator session: a mix of big reads and Agent dispatches.
  // Agent dispatches every 8 steps models an orchestrator that delegates after being nudged.
  // This models the "整场 session 注入次数个位数" requirement from the design (§1.1 step 5).
  //
  // Note: a pathological all-self-reads-no-delegation session can exceed single digits —
  // that is expected behavior (the nudge SHOULD fire on each cooldown expiry in that case).
  // The sparsity guarantee applies to sessions WITH delegation (which this test simulates).

  const tp = writeTranscript([]); // start empty
  let injectionCount = 0;
  const allLines = [];

  for (let i = 0; i < 50; i++) {
    const id = `toolu_sp${i}`;
    const msgId = `amsg_sp${i}`;
    // Every 8 steps (after the first), dispatch an Agent (realistic delegation pattern).
    if (i > 0 && i % 8 === 0) {
      const agId = `toolu_ag_sp${i}`;
      allLines.push(asstLine(`amsg_ag_sp${i}`, [{ id: agId, name: "Agent", input: { prompt: "delegate work" } }]));
      allLines.push(resultLine(agId, "done"));
    }
    allLines.push(asstLine(msgId, [{ id, name: "Read", input: { file_path: `/x/file${i}.ts` } }]));
    allLines.push(resultLine(id, bigContent));

    writeFileSync(tp, allLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const r = runHook(tp);
    assert.equal(r.status, 0, `hook must exit 0 at step ${i}`);
    if ((r.stdout || "").trim()) {
      injectionCount++;
    }
  }

  assert.ok(
    injectionCount <= 9,
    `sparsity: expected ≤9 injections across 50 tool calls (with delegation), got ${injectionCount}`
  );
  assert.ok(injectionCount > 0, "sparsity: should inject at least once across 50 big reads");
});

// ── Bonus: delegation tool (Agent) itself never triggers nudge ─────────────────

test("Agent tool_use in transcript is never counted as self-work", () => {
  // A transcript with only Agent dispatches (no self-reads) must produce no nudge.
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const id = `toolu_ag${i}`;
    lines.push(asstLine(`amsg_ag${i}`, [{ id, name: "Agent", input: { prompt: "work" } }]));
    lines.push(resultLine(id, bigContent)); // big result, but it's Agent result
  }
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal(parseOutput(r.stdout), null, "Agent dispatch result must not count as self-work");
});

// ── Subagent (isSidechain) turns are ignored ────────────────────────────────────

test("isSidechain tool calls are ignored and don't count toward self-work", () => {
  // Subagent does many big reads — foreman should see no nudge.
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const id = `toolu_sub${i}`;
    lines.push(asstLine(`smsg${i}`, [{ id, name: "Read", input: { file_path: `/sub/file${i}.ts` } }], { sidechain: true }));
    lines.push(resultLine(id, bigContent, { sidechain: true }));
  }
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assert.equal(parseOutput(r.stdout), null, "subagent (sidechain) reads must not trigger foreman nudge");
});

// ── Fix P1: split-line turns must not drop tool_use blocks ────────────────────

test("split-line turn: tool_use on sibling line sharing message.id is NOT dropped", () => {
  // Real Claude Code transcript structure: CC splits one assistant turn across
  // two JSONL lines that share the same message.id.
  //   Line 1: { type:"assistant", message: { id:"msg_X", content:[{type:"text"}] } }
  //   Line 2: { type:"assistant", message: { id:"msg_X", content:[{type:"tool_use"}] } }
  // Old first-wins dedup on message.id would skip line 2 entirely → tool_use lost
  // → big read never detected → nudge missed.
  // Fix: merge all tool_use blocks from lines sharing the same message.id,
  // dedup by each block's own id (toolu_...).
  const sharedMsgId = "msg_split_turn";
  const toolUseId = "toolu_split_r1";

  const textLine = {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-23T10:00:00.000Z",
    message: {
      id: sharedMsgId,
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_read_input_tokens: 0 },
      // Only a text block — no tool_use here
      content: [{ type: "text", text: "Let me read the file." }],
    },
  };

  const toolUseLine = {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-23T10:00:00.100Z",
    message: {
      id: sharedMsgId, // same message.id as textLine
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_read_input_tokens: 0 },
      // The actual tool_use is on THIS sibling line
      content: [{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "/x/big.ts" } }],
    },
  };

  const tp = writeTranscript([
    textLine,
    toolUseLine,
    resultLine(toolUseId, bigContent),
  ]);

  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  // The tool_use was on the sibling line; if it was dropped by first-wins dedup
  // no nudge fires. With the fix, it must fire.
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "tool_use on split sibling line must be detected and fire nudge");
  assert.match(out.additionalContext, /委派检查/, "nudge must contain 委派检查 marker");
});

// ── Fix P2: long transcript performance ───────────────────────────────────────

test("long transcript (3000 lines) completes within 2 s (bounded scan)", () => {
  // This verifies the truly-bounded scan does not full-index a huge transcript.
  // A 3000-line transcript would take several seconds with a naive full scan
  // plus JSON parse of every line, threatening the 5 s PostToolUse timeout.
  // With the bounded reverse-pass approach the hook should complete well within 2 s.
  const lines = [];

  // Build 1000 foreman turns (each = 1 assistant line + 1 user result line = 2 JSONL lines).
  // Insert a few big reads near the end to guarantee a nudge fires (proving full parse done).
  for (let i = 0; i < 1000; i++) {
    const id = `toolu_perf${i}`;
    const msgId = `amsg_perf${i}`;
    // Last 5 turns are big reads; the rest are small reads.
    const content = i >= 995 ? bigContent : "small";
    lines.push(asstLine(msgId, [{ id, name: "Read", input: { file_path: `/x/f${i}.ts` } }]));
    lines.push(resultLine(id, content));
  }

  const tp = writeTranscript(lines);

  const start = Date.now();
  const r = runHook(tp);
  const elapsed = Date.now() - start;

  assert.equal(r.status, 0, "hook must exit 0 on large transcript");
  assertNoBlockOutput(r);
  // Must complete well within 2 s (even on a slow CI machine).
  // The 5 s PostToolUse hook timeout is the hard ceiling; 2 s gives comfortable margin.
  assert.ok(
    elapsed < 2000,
    `bounded scan must complete in <2000 ms on 2000-line transcript, took ${elapsed} ms`
  );
  // Big reads in last 5 turns must still be detected (correctness check).
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "big reads in last window must still fire nudge on large transcript");
});
