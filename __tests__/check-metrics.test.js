// check-metrics.test.js — unit tests for tools/check-metrics.mjs
// Runs via: node --test __tests__/check-metrics.test.js
//
// Tests cover:
//   - review_return_rate = N/A when all gates are unknown (denom = 0)
//   - complete_token_ratio = null when worker_tokens or orchestrator_tokens missing

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(pluginRoot, "tools", "check-metrics.mjs");

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "chk-metrics-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Build a minimal worker-log JSONL record with required fields */
function makeWorkerRecord(overrides = {}) {
  return {
    session_id: "sess-001",
    ts: "2026-01-01T01:00:00.000Z",
    duration_ms: 30000,
    status: "ok",
    orchestrator_action_count: 10,
    orchestrator_context_size: 1000,
    orchestrator_tokens: 500,
    worker_tokens: 200,
    dispatch_input_tokens: 50,
    summary_return_est_tokens: 30,
    backend: "omc",
    ...overrides,
  };
}

/** Write worker-log JSONL file from array of record objects */
function writeWorkerLog(dir, records) {
  const logPath = join(dir, "worker-log.jsonl");
  writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return logPath;
}

/** Build a minimal assistant dispatch record for a transcript */
function agentDispatch({ id, prompt = "do something", ts = "2026-01-01T00:00:00.000Z" }) {
  return {
    type: "assistant",
    sessionId: "sess-001",
    timestamp: ts,
    uuid: "uuid-" + id,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "Agent",
          id,
          input: { subagent_type: "executor", prompt, description: "test agent" },
        },
      ],
    },
  };
}

/** Build a minimal user tool_result record for a transcript */
function agentResult({ toolUseId, text = "task completed" }) {
  return {
    type: "user",
    sessionId: "sess-001",
    timestamp: "2026-01-01T00:01:00.000Z",
    uuid: "uuid-result-" + toolUseId,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [{ type: "text", text }],
        },
      ],
    },
  };
}

/** Write transcript JSONL file and return path */
function writeTranscript(dir, records) {
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(transcriptPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return transcriptPath;
}

/**
 * Run check-metrics.mjs with --json flag.
 * Returns parsed JSON output.
 */
function runMetrics(logPath, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--log", logPath, ...extraArgs],
    { encoding: "utf8" }
  );
  return result;
}

// ── Case A: review_return_rate is N/A when all gates are unknown (denom = 0) ───

test("review_return_rate is N/A when all gates are unknown (denom = 0)", () => {
  const tmp = makeTmp();
  try {
    // Construct a transcript with dispatches but NO clear follow-up (all → unknown):
    // Each dispatch has a result but no subsequent assistant text > 30 chars and
    // no next dispatch with retry keywords — ambiguous → unknown.
    const transcriptRecords = [
      agentDispatch({ id: "tu-001", prompt: "analyze codebase" }),
      agentResult({ toolUseId: "tu-001", text: "Analysis done." }),
      // Short assistant text: too short to count as "moving on" (< 30 chars), no next dispatch
      {
        type: "assistant",
        sessionId: "sess-001",
        timestamp: "2026-01-01T00:02:00.000Z",
        uuid: "uuid-short",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Ok." }], // < 30 chars → unknown
        },
      },
    ];

    const logPath = writeWorkerLog(tmp, [makeWorkerRecord()]);
    const transcriptPath = writeTranscript(tmp, transcriptRecords);

    // Run WITHOUT --json to check human-readable output contains "N/A"
    const result = runMetrics(logPath, ["--transcript", transcriptPath]);

    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    assert.ok(
      result.stdout.includes("review_return_rate") && result.stdout.includes("N/A"),
      "stdout should contain review_return_rate with N/A; got: " + result.stdout
    );

    // Also verify JSON output returns null (null = N/A semantics, never 0)
    const jsonResult = runMetrics(logPath, ["--transcript", transcriptPath, "--json"]);
    assert.equal(jsonResult.status, 0, "exit code 0 for --json; stderr: " + jsonResult.stderr);
    const metrics = JSON.parse(jsonResult.stdout.trim());
    assert.equal(
      metrics.review_return_rate,
      null,
      "review_return_rate must be null (N/A) when denom=0, not 0 or a number"
    );
    assert.notEqual(metrics.review_return_rate, 0, "review_return_rate must NOT be 0 when denom=0");
  } finally {
    cleanup(tmp);
  }
});

// ── Case B: complete_token_ratio is null when worker_tokens missing ────────────

test("complete_token_ratio is null when worker_tokens missing", () => {
  const tmp = makeTmp();
  try {
    // Record has orchestrator_tokens but no worker_tokens (missing field)
    const record = makeWorkerRecord();
    delete record.worker_tokens;

    const logPath = writeWorkerLog(tmp, [record]);
    const result = runMetrics(logPath, ["--json"]);

    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());
    const sid = "sess-001";

    assert.ok(
      metrics.complete_token_ratio !== undefined,
      "complete_token_ratio key must exist in output"
    );
    assert.equal(
      metrics.complete_token_ratio[sid],
      null,
      "complete_token_ratio must be null when worker_tokens missing, not NaN or 0"
    );
    assert.notEqual(
      metrics.complete_token_ratio[sid],
      0,
      "complete_token_ratio must NOT be 0 when data is missing"
    );
    // Ensure it's not NaN (NaN !== null but both are bad)
    assert.ok(
      !Number.isNaN(metrics.complete_token_ratio[sid]),
      "complete_token_ratio must not be NaN"
    );
  } finally {
    cleanup(tmp);
  }
});

// ── Case B (2): complete_token_ratio is null when orchestrator_tokens missing ──


test("complete_token_ratio is null when orchestrator_tokens missing", () => {
  const tmp = makeTmp();
  try {
    // Record has worker_tokens but no orchestrator_tokens (missing field)
    const record = makeWorkerRecord();
    delete record.orchestrator_tokens;

    const logPath = writeWorkerLog(tmp, [record]);
    const result = runMetrics(logPath, ["--json"]);

    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());
    const sid = "sess-001";

    assert.ok(
      metrics.complete_token_ratio !== undefined,
      "complete_token_ratio key must exist in output"
    );
    assert.equal(
      metrics.complete_token_ratio[sid],
      null,
      "complete_token_ratio must be null when orchestrator_tokens missing, not NaN or 0"
    );
    assert.notEqual(
      metrics.complete_token_ratio[sid],
      0,
      "complete_token_ratio must NOT be 0 when data is missing"
    );
    assert.ok(
      !Number.isNaN(metrics.complete_token_ratio[sid]),
      "complete_token_ratio must not be NaN"
    );
  } finally {
    cleanup(tmp);
  }
});

// ── Case C: complete_token_ratio denominator not inflated by multiple workers ─
// (阻塞6: fix uses max(orchestrator_tokens) not sum — denom must not grow with worker count)

test("complete_token_ratio uses max(orchestrator_tokens) so denominator is not inflated by multiple workers (阻塞6)", async () => {
  const { mkdtempSync: mktmpC, writeFileSync: wfC, rmSync: rmC } = await import("node:fs");
  const { join: joinC } = await import("node:path");
  const { tmpdir: tmpdirC } = await import("node:os");

  const sid = "sess-multi";
  const orchTokens = 1000; // same orchestrator snapshot in every record
  const workerTokensEach = 200;

  // Single-worker: ratio = 200 / (200 + 1000) ≈ 0.1667
  const tmp1 = mktmpC(joinC(tmpdirC(), "chk-metrics-c1-"));
  try {
    const lp1 = joinC(tmp1, "worker-log.jsonl");
    const rec1 = makeWorkerRecord({ session_id: sid, orchestrator_tokens: orchTokens, worker_tokens: workerTokensEach });
    wfC(lp1, JSON.stringify(rec1) + "\n");
    const r1 = runMetrics(lp1, ["--json"]);
    assert.equal(r1.status, 0, "exit 0 single-worker; stderr: " + r1.stderr);
    const m1 = JSON.parse(r1.stdout.trim());
    const ratio1 = m1.complete_token_ratio[sid];
    assert.ok(ratio1 !== null, "ratio1 must not be null");

    // Three workers with same orchestrator snapshot:
    //   correct (max orch): 600 / (600 + 1000) = 0.375  → differs from ratio1
    //   wrong (sum orch):   600 / (600 + 3000) ≈ 0.167  → equals ratio1 (bug)
    const tmp3 = mktmpC(joinC(tmpdirC(), "chk-metrics-c3-"));
    try {
      const lp3 = joinC(tmp3, "worker-log.jsonl");
      const recs3 = [
        makeWorkerRecord({ session_id: sid, orchestrator_tokens: orchTokens, worker_tokens: workerTokensEach, ts: "2026-01-01T01:00:00.000Z" }),
        makeWorkerRecord({ session_id: sid, orchestrator_tokens: orchTokens, worker_tokens: workerTokensEach, ts: "2026-01-01T01:01:00.000Z" }),
        makeWorkerRecord({ session_id: sid, orchestrator_tokens: orchTokens, worker_tokens: workerTokensEach, ts: "2026-01-01T01:02:00.000Z" }),
      ];
      wfC(lp3, recs3.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const r3 = runMetrics(lp3, ["--json"]);
      assert.equal(r3.status, 0, "exit 0 three-worker; stderr: " + r3.stderr);
      const m3 = JSON.parse(r3.stdout.trim());
      const ratio3 = m3.complete_token_ratio[sid];

      // With max(orch)=1000: 600/(600+1000) = 0.375
      const expectedRatio3 = (3 * workerTokensEach) / (3 * workerTokensEach + orchTokens);
      assert.ok(
        Math.abs(ratio3 - expectedRatio3) < 0.001,
        "three-worker ratio should be " + expectedRatio3.toFixed(4) + " (max orch denom), got " + ratio3
      );
      // If denom were sum(orch)=3000, ratio3 ≈ ratio1 ≈ 0.167. Assert they meaningfully differ.
      assert.ok(
        Math.abs(ratio3 - ratio1) > 0.05,
        "ratio3 (" + ratio3 + ") should differ from ratio1 (" + ratio1 + ") — equal means denom is inflated"
      );
    } finally {
      rmC(tmp3, { recursive: true, force: true });
    }
  } finally {
    rmC(tmp1, { recursive: true, force: true });
  }
});

// ── Case D: enforce_deny metrics from enforce-log.jsonl ───────────────────────
// (阻塞5: check-metrics must read enforce-log and report deny counts by reason)

import { mkdirSync as mkdirSyncD, writeFileSync as wfD } from "node:fs";

test("enforce_deny_count counts deny entries from enforce-log.jsonl grouped by reason (阻塞5)", () => {
  const tmp = makeTmp();
  try {
    const stateDir = join(tmp, ".worker-mode", "state");
    mkdirSyncD(stateDir, { recursive: true });
    const enforceLogPath = join(stateDir, "enforce-log.jsonl");
    const entries = [
      { ts: "2026-01-01T00:00:01Z", decision: "deny", reason: "wrong_backend" },
      { ts: "2026-01-01T00:00:02Z", decision: "deny", reason: "wrong_backend" },
      { ts: "2026-01-01T00:00:03Z", decision: "deny", reason: "marker_block" },
      { ts: "2026-01-01T00:00:04Z", decision: "warn", reason: "invalid_backend" }, // warn not deny
      { ts: "2026-01-01T00:00:05Z", decision: "deny", reason: "wrong_backend" },
    ];
    wfD(enforceLogPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const logPath = writeWorkerLog(tmp, [makeWorkerRecord()]);
    const result = runMetrics(logPath, ["--enforce-log", enforceLogPath, "--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    assert.equal(metrics.enforce_deny_count, 4, "must count 4 deny entries (3 wrong_backend + 1 marker_block)");
    assert.equal(metrics.enforce_deny_by_reason.wrong_backend, 3, "wrong_backend must be 3");
    assert.equal(metrics.enforce_deny_by_reason.marker_block, 1, "marker_block must be 1");
    assert.equal(
      metrics.enforce_deny_by_reason.invalid_backend,
      undefined,
      "invalid_backend must not appear in deny counts (it is a warn entry)"
    );
  } finally {
    cleanup(tmp);
  }
});

test("enforce_deny_count is 0 and no crash when enforce-log.jsonl does not exist (阻塞5 graceful)", () => {
  const tmp = makeTmp();
  try {
    const logPath = writeWorkerLog(tmp, [makeWorkerRecord()]);
    const nonexistentLog = join(tmp, ".worker-mode", "state", "enforce-log.jsonl");

    const result = runMetrics(logPath, ["--enforce-log", nonexistentLog, "--json"]);
    assert.equal(result.status, 0, "exit 0 even when enforce-log missing; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    assert.equal(metrics.enforce_deny_count, 0, "enforce_deny_count must be 0 when file missing");
    assert.deepEqual(metrics.enforce_deny_by_reason, {}, "enforce_deny_by_reason must be empty when file missing");
  } finally {
    cleanup(tmp);
  }
});

// ── Batch C: mixed-log pollution test (codex 阻塞1) ───────────────────────────
// A worker-log containing both per-worker rows AND session_metrics rows must NOT
// let session_metrics rows pollute worker-derived metrics (delegation_rate, etc.).
// This is the core bug codex reported: 1 worker + 1 session_metrics → delegation_rate
// goes from 0.1 to 0.2, token metrics become null.

import { mkdirSync } from "node:fs";

test("mixed log: session_metrics rows must not pollute worker-derived metrics (codex 阻塞1)", () => {
  const tmp = makeTmp();
  try {
    const sid = "sess-mixed";
    // One complete worker record: 4 orchestrator actions, worker_tokens=200, orchestrator_tokens=1000
    const workerRow = makeWorkerRecord({
      session_id: sid,
      orchestrator_action_count: 4,
      orchestrator_tokens: 1000,
      worker_tokens: 200,
      ts: "2026-01-01T01:00:00.000Z",
      duration_ms: 30000,
      status: "ok",
    });
    // A session_metrics row (event field present) — must be filtered out of worker metrics
    const sessionMetricsRow = {
      event: "session_metrics",
      session_id: sid,
      context_peak_tokens: 85000,
      tool_call_composition: { bash: 5, agent: 2, read_only: 3, other: 1 },
      ts: "2026-01-01T01:00:01.000Z",
    };

    const logPath = join(tmp, "worker-log.jsonl");
    writeFileSync(logPath,
      JSON.stringify(workerRow) + "\n" +
      JSON.stringify(sessionMetricsRow) + "\n"
    );

    const result = runMetrics(logPath, ["--json"]);
    assert.equal(result.status, 0, "exit 0 for mixed log; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    // delegation_rate = workerRows / orchestrator_action_count = 1 / 4 = 0.25
    // (NOT 2/4=0.5 which would happen if session_metrics row counted as a worker dispatch)
    assert.ok(
      Math.abs(metrics.delegation_rate[sid] - 0.25) < 0.001,
      "delegation_rate must be 1/4=0.25, not 2/4=0.5 (session_metrics row must not inflate numerator); got " +
        metrics.delegation_rate[sid]
    );

    // complete_token_ratio = worker_tokens / (worker_tokens + orchestrator_tokens)
    //                      = 200 / (200 + 1000) = 200/1200 ≈ 0.1667
    assert.ok(
      metrics.complete_token_ratio[sid] !== null,
      "complete_token_ratio must not be null — session_metrics row (no worker_tokens) must not contaminate"
    );
    assert.ok(
      Math.abs(metrics.complete_token_ratio[sid] - 200 / 1200) < 0.001,
      "complete_token_ratio must be 200/1200≈0.1667; got " + metrics.complete_token_ratio[sid]
    );

    // worker_token_ratio = worker_tokens / (worker_tokens + orchestrator_tokens)
    //                    = 200 / (200 + 1000) = 200/1200 ≈ 0.1667
    assert.ok(
      metrics.worker_token_ratio[sid] !== null,
      "worker_token_ratio must not be null — session_metrics row must be excluded from worker metrics"
    );
    assert.ok(
      Math.abs(metrics.worker_token_ratio[sid] - 200 / 1200) < 0.001,
      "worker_token_ratio must be 200/1200≈0.1667; got " + metrics.worker_token_ratio[sid]
    );
  } finally {
    cleanup(tmp);
  }
});

// ── Batch C: context_composition from session_metrics rows ───────────────────

test("context_composition: aggregates tool_call_composition from session_metrics rows", () => {
  const tmp = makeTmp();
  try {
    const sid = "sess-comp";
    const workerRow = makeWorkerRecord({ session_id: sid });
    const sm1 = {
      event: "session_metrics",
      session_id: sid,
      context_peak_tokens: 10000,
      tool_call_composition: { bash: 3, agent: 1, read_only: 2, other: 0 },
      ts: "2026-01-01T01:00:01.000Z",
    };
    const sm2 = {
      event: "session_metrics",
      session_id: sid,
      context_peak_tokens: 20000,
      tool_call_composition: { bash: 2, agent: 3, read_only: 1, other: 1 },
      ts: "2026-01-01T01:00:02.000Z",
    };

    const logPath = join(tmp, "worker-log.jsonl");
    writeFileSync(logPath,
      JSON.stringify(workerRow) + "\n" +
      JSON.stringify(sm1) + "\n" +
      JSON.stringify(sm2) + "\n"
    );

    const result = runMetrics(logPath, ["--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    const cc = metrics.context_composition[sid];
    assert.ok(cc !== null && cc !== undefined, "context_composition must not be null");
    // sm1 (ts 01:00:01): bash=3, agent=1, read_only=2, other=0 — earlier snapshot
    // sm2 (ts 01:00:02): bash=2, agent=3, read_only=1, other=1 — latest snapshot (cumulative)
    // Correct: take latest snapshot (sm2). Wrong (sum): bash=5, agent=4, read_only=3, other=1.
    // These values differ from the sum so the test will FAIL if code reverts to summing.
    assert.equal(cc.bash, 2, "context_composition bash must be from latest snapshot (sm2=2), NOT sum (5)");
    assert.equal(cc.agent, 3, "context_composition agent must be from latest snapshot (sm2=3), NOT sum (4)");
    assert.equal(cc.read_only, 1, "context_composition read_only must be from latest snapshot (sm2=1), NOT sum (3)");
    assert.equal(cc.other, 1, "context_composition other must be from latest snapshot (sm2=1)");
  } finally {
    cleanup(tmp);
  }
});

// ── Batch C: true_single_turn_peak from session_metrics rows ─────────────────

test("true_single_turn_peak: max context_peak_tokens across session_metrics rows", () => {
  const tmp = makeTmp();
  try {
    const sid = "sess-peak";
    const workerRow = makeWorkerRecord({ session_id: sid });
    const sm1 = {
      event: "session_metrics",
      session_id: sid,
      context_peak_tokens: 85000,
      tool_call_composition: { bash: 1, agent: 0, read_only: 0, other: 0 },
      ts: "2026-01-01T01:00:01.000Z",
    };
    const sm2 = {
      event: "session_metrics",
      session_id: sid,
      context_peak_tokens: 120000,
      tool_call_composition: { bash: 0, agent: 1, read_only: 0, other: 0 },
      ts: "2026-01-01T01:00:02.000Z",
    };
    const sm3 = {
      event: "session_metrics",
      session_id: sid,
      context_peak_tokens: 60000,
      tool_call_composition: { bash: 0, agent: 0, read_only: 1, other: 0 },
      ts: "2026-01-01T01:00:03.000Z",
    };

    const logPath = join(tmp, "worker-log.jsonl");
    writeFileSync(logPath,
      JSON.stringify(workerRow) + "\n" +
      JSON.stringify(sm1) + "\n" +
      JSON.stringify(sm2) + "\n" +
      JSON.stringify(sm3) + "\n"
    );

    const result = runMetrics(logPath, ["--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    assert.equal(
      metrics.true_single_turn_peak[sid],
      120000,
      "true_single_turn_peak must be max context_peak_tokens across all session_metrics rows = 120000"
    );
  } finally {
    cleanup(tmp);
  }
});

// ── Batch C: orchestrator_new_input_ratio from worker records ─────────────────

test("orchestrator_new_input_ratio: taken from worker record with highest orchestrator_input_tokens", () => {
  const tmp = makeTmp();
  try {
    const sid = "sess-ratio";
    // Two worker records. The one with higher orchestrator_input_tokens should supply the ratio.
    const rec1 = makeWorkerRecord({
      session_id: sid,
      orchestrator_input_tokens: 1000,
      orchestrator_new_input_tokens: 100,
      orchestrator_new_input_ratio: 0.10,
      ts: "2026-01-01T01:00:00.000Z",
    });
    const rec2 = makeWorkerRecord({
      session_id: sid,
      orchestrator_input_tokens: 5000,
      orchestrator_new_input_tokens: 600,
      orchestrator_new_input_ratio: 0.12,
      ts: "2026-01-01T01:01:00.000Z",
    });

    const logPath = join(tmp, "worker-log.jsonl");
    writeFileSync(logPath,
      JSON.stringify(rec1) + "\n" +
      JSON.stringify(rec2) + "\n"
    );

    const result = runMetrics(logPath, ["--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    // rec2 has higher orchestrator_input_tokens (5000 > 1000) → its ratio (0.12) wins
    assert.ok(
      Math.abs(metrics.orchestrator_new_input_ratio[sid] - 0.12) < 1e-9,
      "orchestrator_new_input_ratio must come from highest-input-tokens record (rec2=0.12); got " +
        metrics.orchestrator_new_input_ratio[sid]
    );
  } finally {
    cleanup(tmp);
  }
});

// ── Batch C: compact_count — updated for transcript-based implementation ───────
// compact_count now scans the transcript for isCompactSummary=true records instead
// of counting .omc/state/checkpoints/*.json files (OMC snapshots ≠ real compacts).

test("compact_count: null when no transcript passed (even if checkpoint dir exists)", () => {
  const tmp = makeTmp();
  try {
    // Set up a fake .omc/state/checkpoints directory (old behavior would have counted these)
    const checkpointDir = join(tmp, ".omc", "state", "checkpoints");
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(join(checkpointDir, "checkpoint-001.json"),
      JSON.stringify({ session_id: "sess-A", ts: "2026-01-01T00:01:00.000Z" }));

    const workerRow = makeWorkerRecord({ session_id: "sess-A" });
    const logPath = join(tmp, "worker-log.jsonl");
    writeFileSync(logPath, JSON.stringify(workerRow) + "\n");

    // Run WITHOUT --transcript: compact_count must be null (not 1 from checkpoint file)
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--log", logPath, "--json"],
      { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: tmp } }
    );
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    assert.equal(
      metrics.compact_count,
      null,
      "compact_count must be null without --transcript (checkpoint files are ignored); got " +
        JSON.stringify(metrics.compact_count)
    );
  } finally {
    cleanup(tmp);
  }
});

test("compact_count: 0 when transcript provided but has no compact-summary records", () => {
  const tmp = makeTmp();
  try {
    const workerRow = makeWorkerRecord({ session_id: "sess-nocheckpoints" });
    const logPath = join(tmp, "worker-log.jsonl");
    writeFileSync(logPath, JSON.stringify(workerRow) + "\n");

    // Transcript with ordinary records (no isCompactSummary)
    const transcriptPath = join(tmp, "transcript.jsonl");
    writeFileSync(transcriptPath,
      JSON.stringify({ type: "user", message: { role: "user", content: [] }, uuid: "u1" }) + "\n"
    );

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--log", logPath, "--transcript", transcriptPath, "--json"],
      { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: tmp } }
    );
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    assert.notEqual(metrics.compact_count, null, "compact_count must not be null when transcript provided");
    assert.equal(
      metrics.compact_count.count,
      0,
      "compact_count.count must be 0 when transcript has no compact-summary records; got " +
        JSON.stringify(metrics.compact_count)
    );
    assert.equal(metrics.compact_count.scope, "transcript", "scope must be 'transcript'");
  } finally {
    cleanup(tmp);
  }
});

// ── Tie-break tests (codex 终审) ─────────────────────────────────────────────

// context_composition tie-break: same ts → take the LAST record encountered
test("context_composition tie-break: same ts takes last-encountered session_metrics record", () => {
  const tmp = makeTmp();
  try {
    const sid = "sess-tiebreak-cc";
    const workerRow = makeWorkerRecord({ session_id: sid });
    // Two session_metrics rows with IDENTICAL ts — tie-break must favour the later one in log order.
    const sm1 = {
      event: "session_metrics",
      session_id: sid,
      context_peak_tokens: 10000,
      tool_call_composition: { bash: 1, agent: 0, read_only: 0, other: 0 },
      ts: "2026-01-01T01:00:00.000Z", // identical ts
    };
    const sm2 = {
      event: "session_metrics",
      session_id: sid,
      context_peak_tokens: 20000,
      tool_call_composition: { bash: 0, agent: 5, read_only: 0, other: 0 },
      ts: "2026-01-01T01:00:00.000Z", // identical ts — appears AFTER sm1 in log
    };

    const logPath = join(tmp, "worker-log.jsonl");
    writeFileSync(logPath,
      JSON.stringify(workerRow) + "\n" +
      JSON.stringify(sm1) + "\n" +
      JSON.stringify(sm2) + "\n"
    );

    const result = runMetrics(logPath, ["--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    const cc = metrics.context_composition[sid];
    assert.ok(cc !== null && cc !== undefined, "context_composition must not be null");
    // sm2 appears later in the log → it must win the tie-break.
    // sm2 has agent=5; sm1 has agent=0. Reverting to > (first-wins) would give agent=0 and fail.
    assert.equal(cc.agent, 5,
      "tie-break: last-encountered record (sm2, agent=5) must win; first-wins would give agent=0");
    assert.equal(cc.bash, 0,
      "tie-break: bash must come from sm2 (bash=0), not sm1 (bash=1)");
  } finally {
    cleanup(tmp);
  }
});

// orchestrator_new_input_ratio tie-break: same input_tokens → take the LAST record encountered
test("orchestrator_new_input_ratio tie-break: same orchestrator_input_tokens takes last-encountered record", () => {
  const tmp = makeTmp();
  try {
    const sid = "sess-tiebreak-ratio";
    // Two worker records with IDENTICAL orchestrator_input_tokens but different ratios.
    const rec1 = makeWorkerRecord({
      session_id: sid,
      orchestrator_input_tokens: 3000,
      orchestrator_new_input_tokens: 300,
      orchestrator_new_input_ratio: 0.10,
      ts: "2026-01-01T01:00:00.000Z",
    });
    const rec2 = makeWorkerRecord({
      session_id: sid,
      orchestrator_input_tokens: 3000, // identical — tie
      orchestrator_new_input_tokens: 750,
      orchestrator_new_input_ratio: 0.25,
      ts: "2026-01-01T01:01:00.000Z", // appears AFTER rec1 in log
    });

    const logPath = join(tmp, "worker-log.jsonl");
    writeFileSync(logPath,
      JSON.stringify(rec1) + "\n" +
      JSON.stringify(rec2) + "\n"
    );

    const result = runMetrics(logPath, ["--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    // rec2 appears later in the log → its ratio (0.25) must win the tie-break.
    // Reverting to > (first-wins) would keep rec1's ratio (0.10) and fail this assertion.
    assert.ok(
      Math.abs(metrics.orchestrator_new_input_ratio[sid] - 0.25) < 1e-9,
      "tie-break: last-encountered record (rec2, ratio=0.25) must win; first-wins would give 0.10; got " +
        metrics.orchestrator_new_input_ratio[sid]
    );
  } finally {
    cleanup(tmp);
  }
});

// ── Bug-2: computeCompactCount must scan transcript, not checkpoint files ───────

// Build a minimal compact-summary transcript record (isCompactSummary=true is the
// real field confirmed from actual Claude Code transcripts).
function makeCompactRecord({ useIsCompactSummary = true, useTypeSummary = false } = {}) {
  const rec = {
    parentUuid: "uuid-parent",
    isSidechain: false,
    type: useTypeSummary ? "summary" : "user",
    message: { role: "user", content: [{ type: "text", text: "Summary of prior context." }] },
    uuid: "uuid-compact-" + Math.random().toString(36).slice(2),
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "sess-compact",
  };
  if (useIsCompactSummary) rec.isCompactSummary = true;
  return rec;
}

// Bug-2a: transcript with isCompactSummary records → compact_count equals that count
test("Bug-2a: compact_count counts isCompactSummary=true records in transcript", () => {
  const tmp = makeTmp();
  try {
    const logPath = writeWorkerLog(tmp, [makeWorkerRecord()]);
    // Write a transcript with 2 compact summary records
    const transcriptPath = join(tmp, "transcript.jsonl");
    const recs = [
      makeCompactRecord({ useIsCompactSummary: true }),
      makeCompactRecord({ useIsCompactSummary: true }),
      agentDispatch({ id: "tu-a1" }),
    ];
    writeFileSync(transcriptPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = runMetrics(logPath, ["--transcript", transcriptPath, "--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    // compact_count.count must be 2 (transcript scan), not 0 (checkpoint dir, which doesn't exist)
    assert.ok(metrics.compact_count !== undefined, "compact_count key must exist");
    assert.equal(
      metrics.compact_count.count,
      2,
      "compact_count.count must equal number of isCompactSummary=true records; got " +
        JSON.stringify(metrics.compact_count)
    );
  } finally {
    cleanup(tmp);
  }
});

// Bug-2b: no transcript passed → compact_count must be null (not 0)
test("Bug-2b: compact_count is null when no transcript is passed", () => {
  const tmp = makeTmp();
  try {
    const logPath = writeWorkerLog(tmp, [makeWorkerRecord()]);

    // Run WITHOUT --transcript so there is no transcript to scan
    const result = runMetrics(logPath, ["--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    assert.ok(metrics.compact_count !== undefined, "compact_count key must exist");
    // null = "we don't know" (no transcript); 0 = "confirmed 0 compacts"
    assert.equal(
      metrics.compact_count,
      null,
      "compact_count must be null when no transcript provided; got " + JSON.stringify(metrics.compact_count)
    );
  } finally {
    cleanup(tmp);
  }
});

// Bug-2c: transcript with 0 summary records → compact_count.count = 0 (not null)
test("Bug-2c: compact_count is 0 when transcript has no summary records", () => {
  const tmp = makeTmp();
  try {
    const logPath = writeWorkerLog(tmp, [makeWorkerRecord()]);
    const transcriptPath = join(tmp, "transcript.jsonl");
    // Transcript exists but has no compact-summary records
    const recs = [agentDispatch({ id: "tu-b1" }), agentResult({ toolUseId: "tu-b1" })];
    writeFileSync(transcriptPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = runMetrics(logPath, ["--transcript", transcriptPath, "--json"]);
    assert.equal(result.status, 0, "exit 0; stderr: " + result.stderr);
    const metrics = JSON.parse(result.stdout.trim());

    assert.ok(metrics.compact_count !== undefined, "compact_count key must exist");
    assert.equal(
      metrics.compact_count.count,
      0,
      "compact_count.count must be 0 (confirmed no compacts) when transcript has no summary records; got " +
        JSON.stringify(metrics.compact_count)
    );
    assert.notEqual(
      metrics.compact_count,
      null,
      "compact_count must NOT be null when transcript was provided (null means no transcript)"
    );
  } finally {
    cleanup(tmp);
  }
});
