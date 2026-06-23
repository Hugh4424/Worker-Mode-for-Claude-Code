// ab-eval.test.js — unit/integration tests for tools/ab-eval.mjs
//
// Coverage:
//   (a) first_delegation_gather_count correct on a known transcript
//   (b) completion binding: early-delegate + incomplete session NOT counted in FDGC mean
//   (c) four-group aggregation values correct
//   (d) missing data outputs null, never 0
//
// Uses node --test runner (zero external deps). Fixtures are inline JSONL.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const abEvalScript = join(pluginRoot, "tools", "ab-eval.mjs");

// ── classifier constants (imported for sizing fixtures) ───────────────────────

const { BIG_CHUNK_BYTES, BIG_CHUNK_LINES } = await (async () => {
  const classifierPath = join(pluginRoot, "tools", "lib", "self-work-classifier.mjs");
  return import(classifierPath);
})();

// ── temp dir lifecycle ─────────────────────────────────────────────────────────

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ab-eval-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ── transcript builders ───────────────────────────────────────────────────────

// Build an assistant line with given tool_use blocks.
function asstLine(msgId, toolUses) {
  return {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-23T10:00:00.000Z",
    message: {
      id: msgId,
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_read_input_tokens: 0 },
      content: toolUses.map((tu) => ({ type: "tool_use", ...tu })),
    },
  };
}

// Build an assistant text-only line (signals final response / session complete).
function asstTextLine(msgId, text) {
  return {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-23T10:00:01.000Z",
    message: {
      id: msgId,
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_read_input_tokens: 0 },
      content: [{ type: "text", text }],
    },
  };
}

// Build a user line with tool_result blocks.
function resultLine(toolUseId, contentStr, isError = false) {
  const content = typeof contentStr === "string" ? contentStr : "x".repeat(contentStr);
  return {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-23T10:00:01.000Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  };
}

// Large content: just over BIG_CHUNK_BYTES threshold.
const BIG = BIG_CHUNK_BYTES + 10;
const bigContent = "x".repeat(BIG);

// Small content: well under both thresholds.
const smallContent = "x".repeat(50);

// Write a transcript JSONL file from an array of line objects.
function writeTranscript(lines) {
  const p = join(dir, "t-" + Math.random().toString(36).slice(2) + ".jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

// Write a config JSON file.
function writeConfig(cfg) {
  const p = join(dir, "config-" + Math.random().toString(36).slice(2) + ".json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

// Write a minimal worker-log JSONL.
function writeWorkerLog(records) {
  const p = join(dir, "worker-log-" + Math.random().toString(36).slice(2) + ".jsonl");
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

// Run ab-eval.mjs with given args, always --json for machine-readable output.
function run(args, extraArgs = []) {
  const result = spawnSync("node", [abEvalScript, ...args, "--json", ...extraArgs], {
    encoding: "utf8",
    timeout: 10000,
    cwd: pluginRoot,
  });
  return result;
}

// ── test (a): first_delegation_gather_count on a known transcript ─────────────
// Transcript: 3 big Reads, then 1 Agent dispatch, then 1 more big Read (after delegation).
// Expected FDGC = 3 (only the pre-delegation reads count).

test("(a) first_delegation_gather_count counts only pre-delegation big self-chunks", () => {
  const lines = [
    // Big Read #1
    asstLine("msg1", [{ id: "tu1", name: "Read", input: { file_path: "/x/a.ts" } }]),
    resultLine("tu1", bigContent),
    // Big Read #2
    asstLine("msg2", [{ id: "tu2", name: "Read", input: { file_path: "/x/b.ts" } }]),
    resultLine("tu2", bigContent),
    // Big Read #3
    asstLine("msg3", [{ id: "tu3", name: "Read", input: { file_path: "/x/c.ts" } }]),
    resultLine("tu3", bigContent),
    // First Agent dispatch — FDGC window closes here.
    asstLine("msg4", [{ id: "tu4", name: "Agent", input: { prompt: "analyze" } }]),
    resultLine("tu4", "agent done"),
    // Big Read #4 AFTER delegation — must NOT count toward FDGC.
    asstLine("msg5", [{ id: "tu5", name: "Read", input: { file_path: "/x/d.ts" } }]),
    resultLine("tu5", bigContent),
    // Final text response (signals completion).
    asstTextLine("msg6", "All done. The implementation is complete."),
  ];

  const transcriptPath = writeTranscript(lines);
  const configPath = writeConfig({
    sessions: {
      sessA: { group: "baseline", transcript: transcriptPath },
    },
  });

  const r = run(["--config", configPath]);
  assert.equal(r.status, 0, "must exit 0; stderr=" + r.stderr);
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessA");
  assert.ok(sess, "session sessA must be in output");
  assert.equal(sess.first_delegation_gather_count, 3,
    "FDGC must be 3 (pre-delegation big reads only)");
});

// Small reads do not count toward FDGC.
test("(a-2) small reads before delegation do NOT count toward FDGC", () => {
  const lines = [
    asstLine("msg1", [{ id: "tu1", name: "Read", input: { file_path: "/x/small.ts" } }]),
    resultLine("tu1", smallContent), // small — under threshold
    asstLine("msg2", [{ id: "tu2", name: "Agent", input: { prompt: "do it" } }]),
    resultLine("tu2", "done"),
    asstTextLine("msg3", "Task complete."),
  ];

  const tp = writeTranscript(lines);
  const cp = writeConfig({ sessions: { sessB: { group: "only-A", transcript: tp } } });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0");
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessB");
  assert.equal(sess.first_delegation_gather_count, 0,
    "FDGC must be 0 when no big reads before first delegation");
});

// No Agent at all: all big reads count.
test("(a-3) no Agent dispatch in session: all big reads count toward FDGC", () => {
  const lines = [
    asstLine("msg1", [{ id: "tu1", name: "Read", input: { file_path: "/x/a.ts" } }]),
    resultLine("tu1", bigContent),
    asstLine("msg2", [{ id: "tu2", name: "Read", input: { file_path: "/x/b.ts" } }]),
    resultLine("tu2", bigContent),
    asstTextLine("msg3", "OK done."),
  ];

  const tp = writeTranscript(lines);
  const cp = writeConfig({ sessions: { sessC: { group: "baseline", transcript: tp } } });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0");
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessC");
  assert.equal(sess.first_delegation_gather_count, 2,
    "FDGC=2 when no delegation (all big reads counted)");
});

// ── test (b): completion binding ──────────────────────────────────────────────
// An "early-delegate but incomplete" session must NOT be counted in FDGC mean.
// Group has 2 sessions: one completed (FDGC=1), one incomplete (FDGC=0).
// Group FDGC mean = 1.0 (only completed session's value).

test("(b) early-delegate + incomplete session excluded from FDGC group mean", () => {
  // Session 1: completed, FDGC=1 (one big read before delegation).
  const linesCompleted = [
    asstLine("m1", [{ id: "t1", name: "Read", input: { file_path: "/x/a.ts" } }]),
    resultLine("t1", bigContent),
    asstLine("m2", [{ id: "t2", name: "Agent", input: { prompt: "go" } }]),
    resultLine("t2", "done"),
    asstTextLine("m3", "Task is done."),
  ];
  const tp1 = writeTranscript(linesCompleted);

  // Session 2: incomplete (annotated false), FDGC=0 (agent dispatched first).
  // If binding works, this session's FDGC=0 must NOT drag the group mean down.
  const linesIncomplete = [
    asstLine("m4", [{ id: "t4", name: "Agent", input: { prompt: "go" } }]),
    resultLine("t4", "agent done"),
    // No final text response → transcript ends mid-session (or annotated false)
  ];
  const tp2 = writeTranscript(linesIncomplete);

  const cp = writeConfig({
    sessions: {
      sessCompleted: { group: "only-B", transcript: tp1, completed: true },
      sessIncomplete: { group: "only-B", transcript: tp2, completed: false },
    },
  });

  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0; stderr=" + r.stderr);
  const out = JSON.parse(r.stdout);

  // sessIncomplete must have completion_status === false.
  const incomplete = out.sessions.find((s) => s.session_id === "sessIncomplete");
  assert.equal(incomplete.completion_status, false,
    "annotated-false session must have completion_status=false");

  // Group "only-B" FDGC mean = 1.0 (only sessCompleted, FDGC=1).
  const g = out.groups["only-B"];
  assert.ok(g, "only-B group must exist");
  assert.equal(g.completed_count, 1, "only 1 completed session");
  assert.equal(g.first_delegation_gather_count_mean, 1,
    "FDGC mean = 1.0, incomplete session excluded");
});

// ── test (c): four-group aggregation ─────────────────────────────────────────
// Create one session per group, each with known FDGC values.
// Verify aggregation math is correct.

test("(c) four-group aggregation values correct", () => {
  // Each group: 1 completed session with a distinct FDGC value.
  function sessionLines(fdgcReads) {
    // fdgcReads big Reads, then one Agent, then final text.
    const ls = [];
    for (let i = 0; i < fdgcReads; i++) {
      ls.push(asstLine("m_r" + i, [{ id: "t_r" + i, name: "Read", input: { file_path: "/x/f" + i + ".ts" } }]));
      ls.push(resultLine("t_r" + i, bigContent));
    }
    ls.push(asstLine("m_ag", [{ id: "t_ag", name: "Agent", input: { prompt: "go" } }]));
    ls.push(resultLine("t_ag", "done"));
    ls.push(asstTextLine("m_end", "All complete."));
    return ls;
  }

  const tBaseline = writeTranscript(sessionLines(4));
  const tOnlyA = writeTranscript(sessionLines(2));
  const tOnlyB = writeTranscript(sessionLines(1));
  const tAB = writeTranscript(sessionLines(0));

  const cp = writeConfig({
    sessions: {
      sBaseline: { group: "baseline",   transcript: tBaseline, completed: true },
      sOnlyA:   { group: "only-A",     transcript: tOnlyA,    completed: true },
      sOnlyB:   { group: "only-B",     transcript: tOnlyB,    completed: true },
      sAB:      { group: "A+B",        transcript: tAB,       completed: true },
    },
  });

  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0");
  const out = JSON.parse(r.stdout);

  assert.equal(out.groups["baseline"].first_delegation_gather_count_mean, 4,
    "baseline FDGC mean = 4");
  assert.equal(out.groups["only-A"].first_delegation_gather_count_mean, 2,
    "only-A FDGC mean = 2");
  assert.equal(out.groups["only-B"].first_delegation_gather_count_mean, 1,
    "only-B FDGC mean = 1");
  assert.equal(out.groups["A+B"].first_delegation_gather_count_mean, 0,
    "A+B FDGC mean = 0");

  // Completion rates all 1.0 (all annotated true).
  assert.equal(out.groups["baseline"].completion_rate, 1, "baseline completion_rate = 1");
  assert.equal(out.groups["A+B"].completion_rate, 1, "A+B completion_rate = 1");
});

// ── test (d): missing data outputs null, never 0 ──────────────────────────────

test("(d) missing transcript → first_delegation_gather_count is null, not 0", () => {
  // No transcript path provided.
  const cp = writeConfig({
    sessions: {
      sessNoTranscript: { group: "baseline" /* no transcript */ },
    },
  });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0");
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessNoTranscript");
  assert.strictEqual(sess.first_delegation_gather_count, null,
    "FDGC must be null (not 0) when transcript is missing");
});

test("(d) no worker-log → auxiliary token metrics are null, not 0", () => {
  // No --log and no worker_log in config.
  const tp = writeTranscript([asstTextLine("m1", "done")]);
  const cp = writeConfig({
    sessions: { sessNoLog: { group: "only-A", transcript: tp } },
  });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0");
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessNoLog");
  assert.strictEqual(sess.worker_token_ratio, null,
    "worker_token_ratio must be null when no log");
  assert.strictEqual(sess.total_tokens, null,
    "total_tokens must be null when no log");
  assert.strictEqual(sess.foreman_tool_call_count, null,
    "foreman_tool_call_count must be null when no log");
});

test("(d) group with only unknown-completion sessions → FDGC mean null, not 0", () => {
  // Session completes=null (unknown) so it's excluded from FDGC mean.
  // The group mean should be null (no completed sessions to average over).
  const lines = [
    asstLine("m1", [{ id: "t1", name: "Read", input: { file_path: "/x/a.ts" } }]),
    resultLine("t1", bigContent),
    // No Agent, no final text: completion = unknown.
  ];
  const tp = writeTranscript(lines);
  const cp = writeConfig({
    sessions: { sessUnknown: { group: "only-B", transcript: tp } },
  });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0");
  const out = JSON.parse(r.stdout);
  const g = out.groups["only-B"];
  assert.strictEqual(g.first_delegation_gather_count_mean, null,
    "FDGC mean must be null when all sessions have unknown completion");
});

// ── test: worker-log aux metrics wired correctly ───────────────────────────────

test("worker-log aux metrics computed correctly from log records", () => {
  // Session with 2 worker records.
  const tp = writeTranscript([asstTextLine("m1", "Done.")]);
  const logPath = writeWorkerLog([
    {
      session_id: "sessLog",
      orchestrator_action_count: 20,
      orchestrator_tokens: 800,
      orchestrator_context_size: 5000,
      worker_tokens: 100,
      duration_ms: 5000,
      model: "claude-sonnet-4-6",
      work: "task1",
      result: "ok",
      files: [],
      ts: "2026-06-23T10:00:00Z",
    },
    {
      session_id: "sessLog",
      orchestrator_action_count: 20,
      orchestrator_tokens: 1000,
      orchestrator_context_size: 6000,
      worker_tokens: 200,
      duration_ms: 5000,
      model: "claude-sonnet-4-6",
      work: "task2",
      result: "ok",
      files: [],
      ts: "2026-06-23T10:00:05Z",
    },
  ]);

  const cp = writeConfig({
    sessions: { sessLog: { group: "A+B", transcript: tp, completed: true } },
  });

  const r = run(["--config", cp, "--log", logPath]);
  assert.equal(r.status, 0, "must exit 0; stderr=" + r.stderr);
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessLog");

  // max orch = 1000, sum worker = 300, ratio = 300/1300
  const expectedRatio = 300 / 1300;
  assert.ok(
    Math.abs(sess.worker_token_ratio - expectedRatio) < 0.0001,
    "worker_token_ratio = 300/1300 ≈ " + expectedRatio
  );
  assert.equal(sess.total_tokens, 1300, "total_tokens = 1000 + 300");
  assert.equal(sess.foreman_tool_call_count, 20, "foreman_tool_call_count = max action count");
});

// ── test: invalid group name fails fast ───────────────────────────────────────

test("invalid group name exits non-zero with error message", () => {
  const tp = writeTranscript([asstTextLine("m1", "done")]);
  const cp = writeConfig({
    sessions: { sessInvalid: { group: "treatment", transcript: tp } },
  });
  const r = run(["--config", cp]);
  assert.notEqual(r.status, 0, "must exit non-zero for invalid group");
  assert.match(r.stderr || "", /invalid group|treatment/i, "must report invalid group");
});

// ── test: missing --config fails fast ─────────────────────────────────────────

test("missing --config exits non-zero with error", () => {
  const r = spawnSync("node", [abEvalScript, "--json"], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(r.status, 0, "must exit non-zero when --config is missing");
  assert.match(r.stderr || "", /--config/i, "must mention --config in error");
});

// ── test: human-readable output mode ──────────────────────────────────────────

test("human-readable output (no --json) exits 0 and contains group table headers", () => {
  const tp = writeTranscript([asstTextLine("m1", "Done!")]);
  const cp = writeConfig({
    sessions: { sessHR: { group: "baseline", transcript: tp, completed: true } },
  });
  const r = spawnSync("node", [abEvalScript, "--config", cp], {
    encoding: "utf8",
    timeout: 10000,
    cwd: pluginRoot,
  });
  assert.equal(r.status, 0, "must exit 0; stderr=" + r.stderr);
  assert.match(r.stdout, /FDGC|delegation|Group/i, "output must mention FDGC or delegation");
  assert.match(r.stdout, /baseline/i, "output must show group name");
});

// ── test: rework_count and result_adoption_rate are always null ───────────────

test("rework_count and result_adoption_rate are always null (not computable automatically)", () => {
  const tp = writeTranscript([asstTextLine("m1", "Done.")]);
  const cp = writeConfig({
    sessions: { sessNull: { group: "A+B", transcript: tp, completed: true } },
  });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0");
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessNull");
  assert.strictEqual(sess.rework_count, null, "rework_count always null");
  assert.strictEqual(sess.result_adoption_rate, null, "result_adoption_rate always null");
  const g = out.groups["A+B"];
  assert.strictEqual(g.rework_count_mean, null, "group rework_count_mean always null");
  assert.strictEqual(g.result_adoption_rate_mean, null, "group result_adoption_rate_mean always null");
});

// ── fix-verification tests ────────────────────────────────────────────────────
// (a) issue1: split-line tool_use not lost to message.id first-wins dedup.
// A real CC transcript may emit one assistant turn as two JSONL lines with the same
// message.id: a text block in one line, tool_use block(s) in a sibling line.
// The old first-wins dedup would drop the sibling → miss the tool_use entirely.

test("(fix1) split-line tool_use (shared message.id) is not dropped from FDGC computation", () => {
  // Session: one assistant turn split across two lines sharing msg id "split1".
  //   - line A: text block only (no tool_use)
  //   - line B: tool_use Read (big) with same message.id "split1"
  // Then an Agent dispatch on a new message.id.
  // Expected FDGC = 1 (the big Read from the split line must be counted).
  const splitLineText = {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-23T10:00:00.000Z",
    message: {
      id: "split1",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_read_input_tokens: 0 },
      content: [{ type: "text", text: "Thinking..." }],
    },
  };
  const splitLineTool = {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-23T10:00:00.001Z",
    message: {
      id: "split1", // same message.id — this is the sibling line
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_read_input_tokens: 0 },
      content: [{ type: "tool_use", id: "tu_split", name: "Read", input: { file_path: "/x/big.ts" } }],
    },
  };
  const lines = [
    splitLineText,
    splitLineTool,
    resultLine("tu_split", bigContent), // big result
    asstLine("msg_agent", [{ id: "tu_agent", name: "Agent", input: { prompt: "go" } }]),
    resultLine("tu_agent", "done"),
    asstTextLine("msg_end", "All complete."),
  ];

  const tp = writeTranscript(lines);
  const cp = writeConfig({
    sessions: { sessSplit: { group: "baseline", transcript: tp, completed: true } },
  });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0; stderr=" + r.stderr);
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessSplit");
  assert.equal(sess.first_delegation_gather_count, 1,
    "split-line tool_use (shared message.id sibling) must be counted: FDGC=1");
});

// (b) issue2: duplicate dispatch_id not double-counted; status=incomplete not polluting tokens.

test("(fix2a) duplicate dispatch_id in worker-log is not double-counted in aux metrics", () => {
  const tp = writeTranscript([asstTextLine("m1", "Done.")]);
  // Two records with same dispatch_id — should be treated as one.
  const logPath = writeWorkerLog([
    {
      session_id: "sessDup",
      dispatch_id: "did-001",
      orchestrator_action_count: 10,
      orchestrator_tokens: 500,
      worker_tokens: 200,
      status: "ok",
      ts: "2026-06-23T10:00:00Z",
    },
    {
      session_id: "sessDup",
      dispatch_id: "did-001", // duplicate
      orchestrator_action_count: 10,
      orchestrator_tokens: 500,
      worker_tokens: 200,
      status: "ok",
      ts: "2026-06-23T10:00:00Z",
    },
  ]);
  const cp = writeConfig({
    sessions: { sessDup: { group: "A+B", transcript: tp, completed: true } },
  });
  const r = run(["--config", cp, "--log", logPath]);
  assert.equal(r.status, 0, "must exit 0; stderr=" + r.stderr);
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessDup");
  // After dedup: 1 record. worker=200, orch=500, total=700, ratio=200/700.
  assert.equal(sess.total_tokens, 700,
    "duplicate dispatch_id must not double-count: total_tokens=700 not 1400");
  const expectedRatio = 200 / 700;
  assert.ok(
    Math.abs(sess.worker_token_ratio - expectedRatio) < 0.0001,
    "worker_token_ratio must reflect single (deduped) record: 200/700"
  );
});

test("(fix2b) status=incomplete record does NOT pull sibling complete record token metrics to null", () => {
  const tp = writeTranscript([asstTextLine("m1", "Done.")]);
  // One complete record + one incomplete placeholder (no worker_tokens).
  const logPath = writeWorkerLog([
    {
      session_id: "sessInc",
      dispatch_id: "did-A",
      orchestrator_action_count: 5,
      orchestrator_tokens: 400,
      worker_tokens: 150,
      status: "ok",
      ts: "2026-06-23T10:00:00Z",
    },
    {
      session_id: "sessInc",
      dispatch_id: "did-B",
      orchestrator_action_count: 5,
      orchestrator_tokens: null,
      worker_tokens: null, // incomplete — no numeric data
      status: "incomplete",
      incomplete_reason: "subagent crash",
      ts: "2026-06-23T10:00:05Z",
    },
  ]);
  const cp = writeConfig({
    sessions: { sessInc: { group: "baseline", transcript: tp, completed: true } },
  });
  const r = run(["--config", cp, "--log", logPath]);
  assert.equal(r.status, 0, "must exit 0; stderr=" + r.stderr);
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessInc");
  // Incomplete record must not poison sibling complete record's token metrics.
  assert.notStrictEqual(sess.total_tokens, null,
    "total_tokens must not be null — complete record has valid data");
  assert.equal(sess.total_tokens, 550,
    "total_tokens = orch(400) + worker(150) from complete record only");
});

// (c) issue3: explicit completed:null → "unknown", not heuristic-inferred completed.

test("(fix3) explicit completed:null in config → completion_status is 'unknown', heuristic not applied", () => {
  // Transcript has a text-only final response that the heuristic would infer as completed.
  // But completed:null means the human said "unknown" — heuristic must not override.
  const lines = [
    asstLine("m1", [{ id: "t1", name: "Read", input: { file_path: "/x/a.ts" } }]),
    resultLine("t1", bigContent),
    asstTextLine("m2", "Task is done. Everything completed successfully."),
  ];
  const tp = writeTranscript(lines);
  const cp = writeConfig({
    sessions: {
      sessExplicitNull: { group: "only-A", transcript: tp, completed: null },
    },
  });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0; stderr=" + r.stderr);
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessExplicitNull");
  assert.equal(sess.completion_status, "unknown",
    "explicit completed:null must yield 'unknown', not heuristic-inferred true");
});

// (d) issue4: malformed transcript line → FDGC is null, not a falsely-low value.

test("(fix4) malformed JSONL line in transcript → FDGC is null (honest-null, not fake low value)", () => {
  // Write a transcript where one line is malformed JSON. The session has 2 big reads
  // and an Agent dispatch, but the corrupt line makes the transcript untrustworthy.
  // FDGC must be null rather than some value computed from partial data.
  const goodLine1 = JSON.stringify(asstLine("m1", [{ id: "t1", name: "Read", input: { file_path: "/x/a.ts" } }]));
  const goodLine2 = JSON.stringify(resultLine("t1", bigContent));
  const malformedLine = "{ this is not valid JSON }}}";
  const goodLine3 = JSON.stringify(asstLine("m2", [{ id: "t2", name: "Agent", input: { prompt: "go" } }]));
  const goodLine4 = JSON.stringify(resultLine("t2", "done"));
  const goodLine5 = JSON.stringify(asstTextLine("m3", "Done."));

  const tp = join(dir, "malformed-transcript.jsonl");
  writeFileSync(tp, [goodLine1, goodLine2, malformedLine, goodLine3, goodLine4, goodLine5].join("\n") + "\n");

  const cp = writeConfig({
    sessions: { sessMalformed: { group: "baseline", transcript: tp, completed: true } },
  });
  const r = run(["--config", cp]);
  assert.equal(r.status, 0, "must exit 0 (malformed transcript is per-session, not fatal)");
  const out = JSON.parse(r.stdout);
  const sess = out.sessions.find((s) => s.session_id === "sessMalformed");
  assert.strictEqual(sess.first_delegation_gather_count, null,
    "malformed transcript line → FDGC must be null, not a falsely-low value");
});
