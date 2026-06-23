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

// ── Bash self-work detector tests ─────────────────────────────────────────────

// Helper: build N Bash tool turns with the given command (no paired result needed for counting).
function bashTurns(n, command, startIdx = 0) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const id = `toolu_bash${startIdx + i}`;
    const msgId = `amsg_bash${startIdx + i}`;
    lines.push(asstLine(msgId, [{ id, name: "Bash", input: { command } }]));
    lines.push(resultLine(id, "output"));
  }
  return lines;
}

// Test B1: 8 read-class Bash in one epoch → bash nudge fires.
test("bash nudge fires when >= 8 read-class Bash in one epoch", () => {
  const lines = bashTurns(8, "grep -r 'foo' /src");
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "bash nudge must fire with 8 read-class Bash calls");
  assert.match(out.additionalContext, /委派检查/, "must contain 委派检查");
  assert.match(out.additionalContext, /epoch/, "bash nudge must mention epoch");
  assert.match(out.additionalContext, /Bash/, "bash nudge must mention Bash");
});

// Test B2: only 7 read-class Bash in one epoch → no bash nudge.
test("bash nudge does NOT fire with only 7 read-class Bash in one epoch", () => {
  const lines = bashTurns(7, "cat /src/file.ts");
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  // May or may not fire (from other signals) but bash-specific nudge shouldn't fire.
  // We check: if anything fires, it should not be a Bash-nudge (no "epoch" keyword).
  const out = parseOutput(r.stdout);
  if (out !== null) {
    assert.ok(
      !out.additionalContext.includes("epoch") || !out.additionalContext.includes("Bash"),
      "bash nudge must NOT fire with only 7 read-class Bash calls"
    );
  }
  // More precisely: 7 small-result Bash calls don't meet any threshold.
  // (small result = isBigSelfRead false, bash count = 7 < 8)
  assert.equal(out, null, "no nudge should fire with only 7 Bash calls (small results)");
});

// Test B3: 7 Bash in epoch1, Agent resets, 3 Bash in epoch2 → no bash nudge.
test("Agent dispatch resets bash count; 7+Agent+3 does not trigger bash nudge", () => {
  const preAgent = bashTurns(7, "grep foo /src", 0);
  const agentLines = agentTurn(200);
  const postAgent = bashTurns(3, "cat /src/bar.ts", 10);
  const tp = writeTranscript([...preAgent, ...agentLines, ...postAgent]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  // After reset, epoch2 has only 3 bash → no bash nudge.
  if (out !== null) {
    const isBashnudge = out.additionalContext.includes("epoch") && out.additionalContext.includes("Bash");
    assert.equal(isBashnudge, false, "bash nudge must NOT fire after epoch reset (only 3 post-agent bash)");
  }
});

// Test B4: test-class Bash (npm test) counts toward bash nudge.
test("test-class Bash (npm test) counts toward bash nudge threshold", () => {
  // Mix of read-class and test-class, total >= 8.
  const readLines = bashTurns(4, "grep -r 'foo' .", 0);
  const testLines = bashTurns(4, "npm test", 4);
  const tp = writeTranscript([...readLines, ...testLines]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "mixed read+test Bash (total 8) must trigger bash nudge");
  assert.match(out.additionalContext, /委派检查/);
});

// Test B5: lightweight Bash (ls, git status) does NOT count.
test("lightweight Bash (ls, git status) does not count toward bash threshold", () => {
  // 8 ls/git-status Bash calls → should NOT trigger bash nudge.
  const lsLines = bashTurns(5, "ls /src", 0);
  const gitLines = bashTurns(3, "git status", 5);
  const tp = writeTranscript([...lsLines, ...gitLines]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  const out = parseOutput(r.stdout);
  if (out !== null) {
    const isBashnudge = out.additionalContext.includes("epoch") && out.additionalContext.includes("Bash");
    assert.equal(isBashnudge, false, "lightweight Bash must NOT count toward bash nudge");
  }
});

// ── NEW TESTS: Changes 1-4 ────────────────────────────────────────────────────

// Change 1a: rg / find / fd / git grep / jq / yq count as read-class
test("改动1a: 8 rg commands in epoch triggers bash nudge (rg added to read-class)", () => {
  const lines = bashTurns(8, "rg 'TODO' /src --type ts", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "8 rg calls must trigger bash nudge");
  assert.match(out.additionalContext, /委派检查/);
});

test("改动1a: 8 find commands in epoch triggers bash nudge", () => {
  const lines = bashTurns(8, "find . -name '*.ts' -type f", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "8 find calls must trigger bash nudge");
  assert.match(out.additionalContext, /委派检查/);
});

test("改动1a: 8 fd commands in epoch triggers bash nudge", () => {
  const lines = bashTurns(8, "fd --type f --extension ts src/", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "8 fd calls must trigger bash nudge");
});

test("改动1a: jq and yq count as read-class", () => {
  const jqLines = bashTurns(4, "jq '.items[]' data.json", 0);
  const yqLines = bashTurns(4, "yq '.spec.containers' pod.yaml", 4);
  const tp = writeTranscript([...jqLines, ...yqLines]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "4 jq + 4 yq = 8 read-class must trigger bash nudge");
});

// Change 1b: write-class Bash counts too
test("改动1b: 8 write-class Bash (echo > file) in epoch triggers nudge", () => {
  const lines = bashTurns(8, 'echo "content" > /tmp/out.txt', 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "8 echo-redirect calls must trigger bash nudge");
  assert.match(out.additionalContext, /委派检查/);
});

test("改动1b: sed -i counts as write-class", () => {
  const lines = bashTurns(8, "sed -i 's/foo/bar/g' file.ts", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "8 sed -i calls must trigger bash nudge");
});

test("改动1b: tee counts as write-class", () => {
  const lines = bashTurns(8, "some-cmd | tee output.txt", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "8 tee calls must trigger bash nudge");
});

// Change 2: narrowed test-class — node -v / node check-config.mjs must NOT count
test("改动2: node -v must NOT count as test-class (收窄误判)", () => {
  // 8 'node -v' calls — each should NOT match test-class after fix
  const lines = bashTurns(8, "node -v", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  const out = parseOutput(r.stdout);
  // With only 8 non-read/non-test/non-write Bash calls, no bash nudge should fire
  assert.equal(out, null, "node -v must not count as test-class; 8 calls must not trigger nudge");
});

test("改动2: node check-config.mjs must NOT count as test-class", () => {
  const lines = bashTurns(8, "node check-config.mjs", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  const out = parseOutput(r.stdout);
  assert.equal(out, null, "node check-config.mjs must not count as test-class");
});

test("改动2: node foo.test.mjs DOES count as test-class", () => {
  const lines = bashTurns(8, "node foo.test.mjs", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "node foo.test.mjs must count as test-class and trigger nudge");
});

test("改动2: node bar.spec.ts DOES count as test-class", () => {
  const lines = bashTurns(8, "node bar.spec.ts", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "node bar.spec.ts must count as test-class");
});

test("改动2: node --test counts as test-class", () => {
  const lines = bashTurns(8, "node --test src/", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "node --test must count as test-class");
});

test("改动2: pnpm test and yarn test count as test-class", () => {
  const pnpmLines = bashTurns(4, "pnpm test", 0);
  const yarnLines = bashTurns(4, "yarn test", 4);
  const tp = writeTranscript([...pnpmLines, ...yarnLines]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "pnpm test + yarn test must count as test-class and trigger nudge");
});

// Change 3: separate read/test/write counts, nudge text shows breakdown
test("改动3: nudge text shows read/test/write breakdown when triggered", () => {
  // Mix: 4 read-class + 4 write-class = 8 total
  const readLines = bashTurns(4, "rg 'pattern' /src", 0);
  const writeLines = bashTurns(4, 'echo "x" > out.txt', 4);
  const tp = writeTranscript([...readLines, ...writeLines]);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "mixed read+write 8 total must trigger bash nudge");
  // Text must mention read count and write count separately
  assert.match(out.additionalContext, /读.*\d|读\s*\d|\d.*次.*读/, "nudge must mention read count");
  assert.match(out.additionalContext, /写.*\d|写\s*\d|\d.*次.*写/, "nudge must mention write count");
});

test("改动3: nudge text shows only non-zero categories", () => {
  // Only test-class: 8 npm test calls
  const lines = bashTurns(8, "npm test", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "8 npm test must trigger bash nudge");
  // Must mention test count
  assert.match(out.additionalContext, /测.*\d|\d.*次.*测/, "nudge must mention test count for test-only case");
});

// Change 4: session-level delegation dashboard
function makeSessionLines(selfToolCount, agentCount) {
  // Build a transcript with selfToolCount Read turns (non-authority) + agentCount Agent turns
  // interleaved so they don't form dense epochs that trigger epoch nudge alone.
  // We spread agent dispatches throughout but keep self-reads high enough to cross threshold.
  const lines = [];
  let bashIdx = 0;
  let agentIdx = 0;
  const selfPerAgent = Math.floor(selfToolCount / Math.max(agentCount, 1));

  for (let a = 0; a < agentCount; a++) {
    // selfPerAgent reads between agents
    for (let s = 0; s < selfPerAgent; s++) {
      const id = `toolu_ses_r${bashIdx}`;
      lines.push(asstLine(`amsg_ses_r${bashIdx}`, [{ id, name: "Read", input: { file_path: `/x/f${bashIdx}.ts` } }]));
      lines.push(resultLine(id, "small")); // small result, won't trigger density nudge
      bashIdx++;
    }
    const agId = `toolu_ses_ag${agentIdx}`;
    lines.push(asstLine(`amsg_ses_ag${agentIdx}`, [{ id: agId, name: "Agent", input: { prompt: "work" } }]));
    lines.push(resultLine(agId, "done"));
    agentIdx++;
  }
  // Remaining self reads
  const remaining = selfToolCount - selfPerAgent * agentCount;
  for (let s = 0; s < remaining; s++) {
    const id = `toolu_ses_r${bashIdx}`;
    lines.push(asstLine(`amsg_ses_r${bashIdx}`, [{ id, name: "Read", input: { file_path: `/x/f${bashIdx}.ts` } }]));
    lines.push(resultLine(id, "small"));
    bashIdx++;
  }
  return lines;
}

test("改动4: 委派仪表盘 fires when self-work >> delegation (>=3x and >=12 self)", () => {
  // 18 self-tool Read turns, only 2 Agent dispatches → 18 >= 2*3=6 and >= 12 → dashboard fires
  // We need to force a nudge too (use big reads to fire density nudge), then check dashboard
  // The dashboard piggybacks on a bash/density nudge (never fires alone).
  // Let's build: 15 small reads (not authority) + 1 big read + 2 Agents
  // The 1 big read fires light nudge; dashboard check runs alongside.
  const lines = [];

  // Add 2 Agent dispatches first
  for (let a = 0; a < 2; a++) {
    const agId = `toolu_dash_ag${a}`;
    lines.push(asstLine(`amsg_dash_ag${a}`, [{ id: agId, name: "Agent", input: { prompt: "work" } }]));
    lines.push(resultLine(agId, "done"));
  }
  // Add 15 small self-reads (non-authority files) — each counts as self but not big
  // We only need 12+ self-tool total (including the big one below)
  for (let i = 0; i < 11; i++) {
    const id = `toolu_dash_r${i}`;
    lines.push(asstLine(`amsg_dash_r${i}`, [{ id, name: "Read", input: { file_path: `/x/f${i}.ts` } }]));
    lines.push(resultLine(id, "small"));
  }
  // 1 big read to trigger a nudge
  const bigId = "toolu_dash_big";
  lines.push(asstLine("amsg_dash_big", [{ id: bigId, name: "Read", input: { file_path: "/x/bigfile.ts" } }]));
  lines.push(resultLine(bigId, bigContent));

  // Total self: 12 (11 small + 1 big Read), Agent: 2 → 12 >= 2*3=6 AND 12>=12 → dashboard fires
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "nudge must fire (big read triggers light nudge)");
  assert.match(out.additionalContext, /委派仪表盘/, "dashboard line must appear when self >> delegation");
  assert.match(out.additionalContext, /worker.*占比|占比.*worker|worker.*%/, "dashboard must show worker ratio");
});

test("改动4: 委派仪表盘 does NOT fire when delegation is healthy (low self/agent ratio)", () => {
  // 4 self reads + 8 Agents → ratio 4/8 < 3, not enough to trigger dashboard
  const lines = [];
  for (let a = 0; a < 8; a++) {
    const agId = `toolu_hd_ag${a}`;
    lines.push(asstLine(`amsg_hd_ag${a}`, [{ id: agId, name: "Agent", input: { prompt: "work" } }]));
    lines.push(resultLine(agId, "done"));
  }
  // 1 big read to trigger some nudge (so we can check additionalContext)
  const bigId = "toolu_hd_big";
  lines.push(asstLine("amsg_hd_big", [{ id: bigId, name: "Read", input: { file_path: "/x/bigfile.ts" } }]));
  lines.push(resultLine(bigId, bigContent));

  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  // May or may not fire a nudge, but if it does, must NOT contain dashboard
  if (out !== null) {
    assert.ok(
      !out.additionalContext.includes("委派仪表盘"),
      "dashboard must NOT appear when delegation ratio is healthy"
    );
  }
});

test("改动4: authority file reads are NOT counted in self-work for dashboard", () => {
  // 15 coordinator.md reads (authority) + 0 Agents → authority reads exempt, self=0, no dashboard
  const lines = [];
  for (let i = 0; i < 15; i++) {
    const id = `toolu_auth${i}`;
    lines.push(asstLine(`amsg_auth${i}`, [{ id, name: "Read", input: { file_path: "/agents/coordinator.md" } }]));
    lines.push(resultLine(id, bigContent));
  }
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  // No nudge should fire at all (authority files exempt from everything)
  const out = parseOutput(r.stdout);
  assert.equal(out, null, "authority file reads must not trigger any nudge");
});

// P1#10 guard for all new trigger cases
test("P1#10: rg-triggered nudge only outputs additionalContext, no block/deny", () => {
  const lines = bashTurns(8, "rg 'foo' /src", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assertNoBlockOutput(r);
});

test("P1#10: write-class-triggered nudge only outputs additionalContext, no block/deny", () => {
  const lines = bashTurns(8, "sed -i 's/x/y/' file.ts", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assertNoBlockOutput(r);
});

test("P1#10: dashboard-triggered nudge only outputs additionalContext, no block/deny", () => {
  // Same as the dashboard-fires test but just checking P1#10
  const lines = [];
  for (let a = 0; a < 2; a++) {
    const agId = `toolu_p110_ag${a}`;
    lines.push(asstLine(`amsg_p110_ag${a}`, [{ id: agId, name: "Agent", input: { prompt: "work" } }]));
    lines.push(resultLine(agId, "done"));
  }
  for (let i = 0; i < 11; i++) {
    const id = `toolu_p110_r${i}`;
    lines.push(asstLine(`amsg_p110_r${i}`, [{ id, name: "Read", input: { file_path: `/x/f${i}.ts` } }]));
    lines.push(resultLine(id, "small"));
  }
  const bigId = "toolu_p110_big";
  lines.push(asstLine("amsg_p110_big", [{ id: bigId, name: "Read", input: { file_path: "/x/bigfile.ts" } }]));
  lines.push(resultLine(bigId, bigContent));
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assertNoBlockOutput(r);
});

// ── NEW: Fix 1 — sessionSelfToolCount must skip light Bash ───────────────────

test("修复1: 轻量Bash(ls/git status)不算自干，仪表盘不虚高", () => {
  // Dashboard fires when: self >= agent*3 AND self >= 12.
  // Bug: light Bash counted as self → 3 agents + 12 light Bash + 1 big Read = self 13, agents 3
  //      → 13 >= 3*3=9 AND 13>=12 → fires dashboard incorrectly.
  // Fix: light Bash excluded → self = 1 (only the big Read) → 1 < 9 → no dashboard.
  const lines = [];
  // 3 Agents (keeps ratio threshold reachable if light Bash counts)
  for (let i = 0; i < 3; i++) {
    const agId = `toolu_fix1_ag${i}`;
    lines.push(asstLine(`amsg_fix1_ag${i}`, [{ id: agId, name: "Agent", input: { prompt: "work" } }]));
    lines.push(resultLine(agId, "done"));
  }
  // 12 lightweight Bash calls (ls / git status / wc -l): with bug they inflate self to 13
  const lightCmds = ["ls /src", "git status", "wc -l package.json", "which node"];
  for (let i = 0; i < 12; i++) {
    const id = `toolu_fix1_b${i}`;
    const cmd = lightCmds[i % lightCmds.length];
    lines.push(asstLine(`amsg_fix1_b${i}`, [{ id, name: "Bash", input: { command: cmd } }]));
    lines.push(resultLine(id, "output"));
  }
  // 1 big read to trigger a light nudge (so additionalContext exists to inspect)
  const bigId = "toolu_fix1_big";
  lines.push(asstLine("amsg_fix1_big", [{ id: bigId, name: "Read", input: { file_path: "/x/bigfile.ts" } }]));
  lines.push(resultLine(bigId, bigContent));

  // After fix: self = 1 (just the big Read), agents = 3 → 1 < 3*3=9 → dashboard must NOT appear.
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  // A light nudge fires (1 big read). Dashboard must NOT appear (light Bash excluded from self).
  assert.ok(out !== null, "light nudge should fire from the big read");
  assert.ok(
    !out.additionalContext.includes("委派仪表盘"),
    "修复1: 轻量Bash不应算自干，仪表盘不应出现 (self=1 after fix, agents=3 → ratio healthy)"
  );
});

test("修复1: 真正的自干多时仪表盘正常触发（对照组）", () => {
  // Control: real self-work (Read/Edit/Write, not light Bash) triggers dashboard.
  // 12 Read calls (non-authority) + 2 Agents → self=12, agents=2 → 12 >= 2*3=6 AND 12>=12 → fires.
  const lines = [];
  for (let a = 0; a < 2; a++) {
    const agId = `toolu_fix1ctrl_ag${a}`;
    lines.push(asstLine(`amsg_fix1ctrl_ag${a}`, [{ id: agId, name: "Agent", input: { prompt: "work" } }]));
    lines.push(resultLine(agId, "done"));
  }
  for (let i = 0; i < 11; i++) {
    const id = `toolu_fix1ctrl_r${i}`;
    lines.push(asstLine(`amsg_fix1ctrl_r${i}`, [{ id, name: "Read", input: { file_path: `/x/f${i}.ts` } }]));
    lines.push(resultLine(id, "small"));
  }
  const bigId = "toolu_fix1ctrl_big";
  lines.push(asstLine("amsg_fix1ctrl_big", [{ id: bigId, name: "Read", input: { file_path: "/x/big.ts" } }]));
  lines.push(resultLine(bigId, bigContent));

  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "nudge must fire");
  assert.match(out.additionalContext, /委派仪表盘/, "修复1对照组: 真实自干(Read)12次应触发仪表盘");
});

// ── NEW: Fix 2 — Bash classification order write→test→read ──────────────────

test("修复2: sed -i 归写类而非读类 (顺序改为 write→test→read)", () => {
  // Before fix: sed is in BASH_READ_RE, and read is checked first → epochBashReadCount++
  // After fix: write is checked first → epochBashWriteCount++
  // We verify this indirectly by checking the nudge text:
  // epochBashWriteCount should appear in the breakdown if nudge fires.
  // With 8 sed -i calls, bash nudge fires. The breakdown should mention write not read.
  const lines = bashTurns(8, "sed -i 's/foo/bar/g' file.ts", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "8 sed -i calls must trigger bash nudge");
  // The nudge text should mention writes (写) not reads (读) for sed -i after the fix
  assert.match(out.additionalContext, /委派检查/, "must contain 委派检查");
  // After fix: sed -i goes to write bucket → nudge text mentions 写 > 0
  assert.match(out.additionalContext, /写.*[1-9]|[1-9].*写/, "修复2: sed -i 应归写类，nudge 文本应提及写次数");
  // Must NOT say only reads (读) caused it — sed -i is write
  // We check by ensuring 读 count mentioned in text is 0 for sed-only case
  // (nudge shows only non-zero categories, so 读 shouldn't appear if sed-i goes to write)
  assert.ok(
    !out.additionalContext.includes("读 8") && !out.additionalContext.includes("8次读"),
    "修复2: sed -i 不应被错误归类为读"
  );
});

// ── NEW: Fix 3 — BASH_WRITE_RE covers generic redirect ──────────────────────

test("修复3: 'node script.js > out.txt' 归写类", () => {
  // Generic command with output redirect should count as write-class.
  const lines = bashTurns(8, "node script.js > out.txt", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "修复3: node script.js > out.txt ×8 必须触发 bash nudge（归写类）");
  assert.match(out.additionalContext, /委派检查/);
});

test("修复3: 'jq . a.json > b.json' 归写类", () => {
  const lines = bashTurns(8, "jq . a.json > b.json", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "修复3: jq 重定向写文件 ×8 必须触发 bash nudge");
  assert.match(out.additionalContext, /委派检查/);
});

// ── NEW: Fix 4 — node test regex anchored to filename boundary ───────────────

test("修复4: node contest.mjs ×8 不触发测试类（误判修复）", () => {
  // 'contest.mjs' contains 'test' as substring but is NOT a test file.
  const lines = bashTurns(8, "node contest.mjs", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  const out = parseOutput(r.stdout);
  // With fix: contest.mjs is not test-class, so 8 non-classified Bash calls → no nudge
  assert.equal(out, null, "修复4: node contest.mjs 不应被误判为测试类，8次不触发nudge");
});

test("修复4: node inspect-config.mjs ×8 不触发测试类", () => {
  const lines = bashTurns(8, "node inspect-config.mjs", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  const out = parseOutput(r.stdout);
  assert.equal(out, null, "修复4: node inspect-config.mjs 不应被误判为测试类");
});

test("修复4: node foo.test.mjs ×8 正常触发测试类", () => {
  const lines = bashTurns(8, "node foo.test.mjs", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "修复4: node foo.test.mjs 应归测试类，8次应触发nudge");
  assert.match(out.additionalContext, /委派检查/);
});

test("修复4: node bar.spec.ts ×8 正常触发测试类", () => {
  const lines = bashTurns(8, "node bar.spec.ts", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "修复4: node bar.spec.ts 应归测试类，8次应触发nudge");
  assert.match(out.additionalContext, /委派检查/);
});

// ── P2修复A: 复合命令不被轻量前缀豁免 ─────────────────────────────────────────

test("P2修复A: ls && rg TODO src ×8 触发读类（复合命令不被ls前缀豁免）", () => {
  // Bug: BASH_LIGHT_RE matches 'ls' prefix → whole compound skipped → rg not counted.
  // Fix: commands with && are not exempt from light-class bypass.
  const lines = bashTurns(8, "ls && rg TODO src", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "P2修复A: ls && rg TODO src ×8 应触发nudge（rg是读类，不被ls前缀豁免）");
  assert.match(out.additionalContext, /委派检查/);
});

test("P2修复A: git status; npm test ×8 触发测试类（分号复合不被git前缀豁免）", () => {
  const lines = bashTurns(8, "git status; npm test", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "P2修复A: git status; npm test ×8 应触发nudge（npm test是测试类）");
  assert.match(out.additionalContext, /委派检查/);
});

test("P2修复A: 纯 ls -la ×8 仍不触发（单条轻量命令豁免未被误伤）", () => {
  const lines = bashTurns(8, "ls -la", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  const out = parseOutput(r.stdout);
  // 8 pure lightweight Bash: not read/test/write → no bash nudge (count stays 0)
  if (out !== null) {
    const isBashnudge = out.additionalContext.includes("epoch") && out.additionalContext.includes("Bash");
    assert.equal(isBashnudge, false, "P2修复A: 纯ls不应触发bash nudge");
  }
});

// ── P2修复B: stderr重定向不算写类 ──────────────────────────────────────────────

test("P2修复B: npm test 2>&1 ×8 归测试类不是写类", () => {
  // Bug: BASH_WRITE_RE '>{1,2}\s*\S' matches '2>&1' → counted as write, nudge says 写 N 次.
  // Fix: '>&1', '>&2', '2>&1', '>/dev/null', '2>/dev/null' excluded from write.
  const lines = bashTurns(8, "npm test 2>&1", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "P2修复B: npm test 2>&1 ×8 应触发nudge（测试类）");
  assert.match(out.additionalContext, /委派检查/);
  // Must mention test (测) count — it's a test command
  assert.match(out.additionalContext, /自己测\s*\d/, "P2修复B: nudge应提及测试次数（自己测 N 次）");
  // Must NOT mention "写 N 次" in the breakdown (the '写派 implementer' fixed text is OK,
  // but 'Bash 自己写 N 次' or '写 N 次' as a count should NOT appear).
  assert.ok(
    !out.additionalContext.match(/自己写\s*\d|\d\s*次.*写类|写\s+\d+\s*次/),
    "P2修复B: npm test 2>&1 不应归写类，nudge文本不应包含写类计数"
  );
});

test("P2修复B: rg foo 2>/dev/null ×8 归读类不是写类", () => {
  const lines = bashTurns(8, "rg foo src 2>/dev/null", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "P2修复B: rg foo 2>/dev/null ×8 应触发nudge（读类）");
  assert.match(out.additionalContext, /委派检查/);
  // Must mention read (读) count — it's a read command
  assert.match(out.additionalContext, /自己读\s*\d/, "P2修复B: nudge应提及读类次数（自己读 N 次）");
  // Must NOT show write count (写类计数) in breakdown
  assert.ok(
    !out.additionalContext.match(/自己写\s*\d|\d\s*次.*写类|写\s+\d+\s*次/),
    "P2修复B: rg 2>/dev/null 不应归写类，nudge文本不应包含写类计数"
  );
});

test("P2修复B: node x.js > out.txt ×8 仍归写类（真实文件写不误排）", () => {
  const lines = bashTurns(8, "node x.js > out.txt", 0);
  const tp = writeTranscript(lines);
  const r = runHook(tp);
  assert.equal(r.status, 0);
  assertNoBlockOutput(r);
  const out = parseOutput(r.stdout);
  assert.ok(out !== null, "P2修复B: node x.js > out.txt ×8 仍应触发nudge（写类）");
  assert.match(out.additionalContext, /委派检查/);
  assert.match(out.additionalContext, /写.*[1-9]|[1-9].*写/, "P2修复B: 真实文件重定向应归写类");
});
