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
    summary_return_tokens: 30,
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
