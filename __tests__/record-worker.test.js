// record-worker.test.js — unit tests for the 5 changes made to hooks/record-worker.mjs:
// 1. worker_tokens includes cache_read + cache_creation (not just input + output)
// 2. orchestrator_tokens includes cache_read + cache_creation
// 3. dispatch join accepts name="Task" in addition to name="Agent"
// 4. backend field present in record ("omc" / "legacy")
// 5. status is "ok" / "incomplete" (failed not implemented; no reliable signal source)
//
// Runs via: node --test __tests__/record-worker.test.js

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const recordScript = join(pluginRoot, "hooks", "record-worker.mjs");

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "record-worker-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function writeJsonl(filePath, records) {
  writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// Read all JSONL records from a log file (skips empty lines, ignores parse errors).
function readAllRecords(logPath) {
  const raw = readFileSync(logPath, "utf8");
  const records = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return records;
}

// Read the first (per-worker) record from the log. The log now has 2 lines per run:
// line 1 = per-worker record (no event field), line 2 = session_metrics event.
function readFirstRecord(logPath) {
  return readAllRecords(logPath)[0];
}

function runHook(stdinJson, logPath, extraEnv = {}) {
  return spawnSync(process.execPath, [recordScript], {
    input: stdinJson,
    encoding: "utf8",
    env: {
      ...process.env,
      WORKER_LOG_PATH: logPath,
      ...extraEnv,
    },
  });
}

/**
 * Build a minimal fixture with full control over token fields.
 * orchMessages: array of message objects with {id, model, usage, content}
 * subMessages: array of message objects with {id, model, usage}
 * agentType: the agent_type field in hookData
 */
function makeCustomFixture({ orchMessages, subMessages, agentType = "implementer", dispatchToolUseId = null }) {
  const orchPath = join(dir, "orch.jsonl");
  const subPath = join(dir, "sub.jsonl");

  const orchLines = orchMessages.map((m) => ({
    type: "assistant",
    timestamp: "2026-06-19T10:00:00.000Z",
    message: {
      id: m.id,
      model: m.model || "claude-opus-4-8",
      usage: m.usage,
      content: m.content || [],
    },
  }));

  const subLines = subMessages.map((m) => ({
    type: "assistant",
    timestamp: m.timestamp || "2026-06-19T10:00:30.000Z",
    message: {
      id: m.id,
      model: m.model || "claude-sonnet-4-6",
      usage: m.usage,
      content: m.content || [],
    },
  }));

  writeJsonl(orchPath, orchLines);
  writeJsonl(subPath, subLines);

  // If a dispatchToolUseId is given, write the sibling .meta.json so the hook
  // can join orchestrator dispatch to this subagent.
  if (dispatchToolUseId) {
    const metaPath = subPath.replace(/\.jsonl$/, ".meta.json");
    writeFileSync(metaPath, JSON.stringify({ toolUseId: dispatchToolUseId }));
  }

  return JSON.stringify({
    session_id: "sess-test",
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: agentType,
    last_assistant_message: "did work\nresult: done\nfiles: x.ts",
    hook_event_name: "SubagentStop",
    cwd: dir,
  });
}

// ── test 1: worker_tokens includes cache fields ───────────────────────────────

test("worker_tokens: sums input+output+cache_read+cache_creation (not just input+output)", () => {
  const logPath = join(dir, "worker-log.jsonl");

  // s1 deduped: 100 + 200 + 50000 + 3000 = 53300
  // s2: 50 + 100 + 40000 + 1000 = 41150
  // total: 94450
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    ],
    subMessages: [
      {
        id: "s1",
        usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50000, cache_creation_input_tokens: 3000 },
      },
      // s1 duplicate (same id) — must be deduped, not counted twice
      {
        id: "s1",
        timestamp: "2026-06-19T10:00:31.000Z",
        usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50000, cache_creation_input_tokens: 3000 },
      },
      {
        id: "s2",
        timestamp: "2026-06-19T10:00:35.000Z",
        usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 40000, cache_creation_input_tokens: 1000 },
      },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(
    rec.worker_tokens,
    53300 + 41150,
    "worker_tokens must sum all 4 token fields: input+output+cache_read+cache_creation"
  );
});

// ── test 2: orchestrator_tokens includes cache fields ─────────────────────────

test("orchestrator_tokens: sums input+output+cache_read+cache_creation (not just input+output)", () => {
  const logPath = join(dir, "worker-log.jsonl");

  // o1 deduped: 10 + 5 + 8000 + 2000 = 10015
  // o2: 20 + 8 + 15000 + 500 = 15528
  // total: 25543
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 },
        content: [{ type: "text", text: "hello" }],
      },
      // o1 duplicate — must be deduped
      {
        id: "o1",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 },
        content: [{ type: "tool_use", id: "toolu_x", name: "Bash" }],
      },
      {
        id: "o2",
        usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 15000, cache_creation_input_tokens: 500 },
        content: [],
      },
    ],
    subMessages: [
      {
        id: "s1",
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(
    rec.orchestrator_tokens,
    10015 + 15528,
    "orchestrator_tokens must sum all 4 token fields: input+output+cache_read+cache_creation"
  );
});

// ── test 3: backend field — omc / legacy / startsWith boundary ────────────────

test("backend field: oh-my-claudecode:executor → omc", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const stdinJson = makeCustomFixture({
    agentType: "oh-my-claudecode:executor",
    orchMessages: [{ id: "o1", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
    subMessages: [{ id: "s1", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(rec.backend, "omc", "oh-my-claudecode:executor should map to backend=omc");
});

test("backend field: implementer → legacy", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const stdinJson = makeCustomFixture({
    agentType: "implementer",
    orchMessages: [{ id: "o1", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
    subMessages: [{ id: "s1", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(rec.backend, "legacy", "implementer should map to backend=legacy");
});

test("backend field: unknown namespace 'legacy-oh-my-claudecode:executor' → backend=unknown (namespace bypass fix)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const stdinJson = makeCustomFixture({
    // Security fix: classifyAgentBackend no longer uses lastIndexOf(":") to extract base name.
    // Any subagentType containing ":" but NOT starting with the known omcPrefix → "unknown".
    // "legacy-oh-my-claudecode:executor" does not start with "oh-my-claudecode:" → unknown.
    // This closes the namespace bypass: "other:executor" can no longer be misclassified as omc.
    agentType: "legacy-oh-my-claudecode:executor",
    orchMessages: [{ id: "o1", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
    subMessages: [{ id: "s1", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  // record-worker maps classifyAgentBackend result: omc→"omc", anything else (legacy/unknown)→"legacy".
  // "legacy-oh-my-claudecode:executor" → classifyAgentBackend returns "unknown" (unknown namespace)
  // → record-worker coerces to "legacy" (unknown agents are not omc, so they fall into legacy bucket).
  assert.equal(
    rec.backend,
    "legacy",
    "legacy-oh-my-claudecode:executor → classifyAgentBackend='unknown' → record-worker coerces to 'legacy'"
  );
});

// ── test 4: dispatch join matches name="Task" (not just name="Agent") ─────────

test("dispatch_input_tokens: joins on tool_use name=Task (not just name=Agent)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const toolUseId = "toolu_task_dispatch_1";

  // Orchestrator dispatched this worker via a Task tool_use (not Agent).
  // dispatch_input_tokens should be populated from that message.
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 12000,
          cache_creation_input_tokens: 80,
        },
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "Task", // <-- Task, not Agent
            input: { subagent_type: "implementer" },
          },
        ],
      },
    ],
    subMessages: [
      { id: "s1", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
    dispatchToolUseId: toolUseId,
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  // dispatch_input_tokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens = 10 + 12000 + 80 = 12090
  assert.equal(
    rec.dispatch_input_tokens,
    12090,
    "dispatch_input_tokens must be populated when orchestrator uses name=Task (not just name=Agent)"
  );
  assert.notEqual(
    rec.dispatch_input_tokens,
    null,
    "dispatch_input_tokens must not be null when a Task dispatch is matched"
  );
});

// ── test 5: status field — ok / incomplete ────────────────────────────────────

test("status field: successful record has status=ok", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const stdinJson = makeCustomFixture({
    orchMessages: [{ id: "o1", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
    // Need >= 2 distinct timestamps for duration_ms check to pass
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(rec.status, "ok", "successful record must have status=ok");
});

test("status field: empty subagent transcript has status=incomplete", () => {
  const logPath = join(dir, "worker-log.jsonl");

  // Write empty subagent transcript
  const orchPath = join(dir, "orch-incomplete.jsonl");
  const subPath = join(dir, "sub-incomplete.jsonl");
  writeJsonl(orchPath, [
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } },
  ]);
  writeFileSync(subPath, ""); // empty transcript

  const stdinJson = JSON.stringify({
    session_id: "sess-incomplete",
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: "implementer",
    last_assistant_message: "result: done",
    hook_event_name: "SubagentStop",
    cwd: dir,
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0 even for incomplete\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(rec.status, "incomplete", "empty subagent transcript must yield status=incomplete");
});

// ── B1: orchestrator_input_tokens / orchestrator_new_input_tokens / orchestrator_new_input_ratio ──

test("B1: orchestrator_input_tokens sums input+cache_creation+cache_read (no output_tokens)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // o1: input=100, cache_creation=2000, cache_read=50000, output=999 (must NOT count output)
  // o2: input=50,  cache_creation=500,  cache_read=10000
  // orchestrator_input_tokens = (100+2000+50000) + (50+500+10000) = 52100 + 10550 = 62650
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: { input_tokens: 100, output_tokens: 999, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000 },
      },
      {
        id: "o2",
        usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 10000 },
      },
    ],
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(rec.orchestrator_input_tokens, 62650,
    "orchestrator_input_tokens = sum of (input+cache_creation+cache_read) across deduped orch msgs, no output");
});

test("B1: orchestrator_new_input_tokens sums input+cache_creation only (excludes cache_read)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // o1: input=100, cache_creation=2000, cache_read=50000
  // o2: input=50,  cache_creation=500,  cache_read=10000
  // orchestrator_new_input_tokens = (100+2000) + (50+500) = 2100 + 550 = 2650
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: { input_tokens: 100, output_tokens: 999, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000 },
      },
      {
        id: "o2",
        usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 10000 },
      },
    ],
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(rec.orchestrator_new_input_tokens, 2650,
    "orchestrator_new_input_tokens = sum of (input+cache_creation) only, no cache_read");
});

test("B1: orchestrator_new_input_ratio = new_input / total_input", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // orchestrator_new_input_tokens = 2650, orchestrator_input_tokens = 62650
  // ratio = 2650 / 62650 ≈ 0.04230...
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: { input_tokens: 100, output_tokens: 999, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000 },
      },
      {
        id: "o2",
        usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 10000 },
      },
    ],
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  const expected = 2650 / 62650;
  assert.ok(
    Math.abs(rec.orchestrator_new_input_ratio - expected) < 1e-9,
    `orchestrator_new_input_ratio expected ~${expected}, got ${rec.orchestrator_new_input_ratio}`
  );
});

test("B1: orchestrator_new_input_ratio is null when orchestrator_input_tokens is 0", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // All token fields zero → denominator = 0 → ratio must be null, not NaN/Infinity
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ],
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  assert.equal(rec.orchestrator_new_input_ratio, null,
    "orchestrator_new_input_ratio must be null when denominator is 0, not NaN/Infinity");
});

test("B1: missing usage object on message does not produce erroneous zero metrics", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // o-nousage has no usage field at all — hasValidUsage filters it out, so it
  // must NOT contribute to any token sum. Only o1 (valid usage) counts.
  const orchPath = join(dir, "orch-nousage.jsonl");
  const subPath = join(dir, "sub-nousage.jsonl");

  writeJsonl(orchPath, [
    // valid message
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z",
      message: { id: "o1", model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
        content: [] } },
    // message WITHOUT usage — must be skipped entirely by hasValidUsage
    { type: "assistant", timestamp: "2026-06-19T10:00:01.000Z",
      message: { id: "o2", model: "claude-opus-4-8", content: [] } },
  ]);
  writeJsonl(subPath, [
    { type: "assistant", timestamp: "2026-06-19T10:00:30.000Z",
      message: { id: "s1", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:35.000Z",
      message: { id: "s2", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
  ]);

  const stdinJson = JSON.stringify({
    session_id: "sess-nousage",
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: "implementer",
    last_assistant_message: "did work\nresult: done",
    hook_event_name: "SubagentStop",
    cwd: dir,
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  // Only o1 counted: orchestrator_input_tokens = 10+100+1000 = 1110
  assert.equal(rec.orchestrator_input_tokens, 1110,
    "missing-usage message must be skipped; only valid-usage message counts");
  // orchestrator_new_input_tokens = 10+100 = 110
  assert.equal(rec.orchestrator_new_input_tokens, 110,
    "orchestrator_new_input_tokens must exclude the no-usage message");
});

// ── B2: session_metrics event appended as independent record ──────────────────

test("B2: session_metrics event appended as second record with event field", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const stdinJson = makeCustomFixture({
    orchMessages: [
      { id: "o1", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    ],
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const records = readAllRecords(logPath);
  assert.equal(records.length, 2, "log must have exactly 2 records: per-worker + session_metrics");

  const perWorker = records[0];
  const sessionMetrics = records[1];

  // per-worker row must NOT have event field (backward compat)
  assert.equal(perWorker.event, undefined, "per-worker record must not have an event field");
  // session_metrics row must have event=="session_metrics"
  assert.equal(sessionMetrics.event, "session_metrics",
    "second record must have event='session_metrics'");
  assert.equal(sessionMetrics.session_id, "sess-test",
    "session_metrics must carry session_id");
  assert.ok("context_peak_tokens" in sessionMetrics, "session_metrics must have context_peak_tokens");
  assert.ok("tool_call_composition" in sessionMetrics, "session_metrics must have tool_call_composition");
  assert.ok("ts" in sessionMetrics, "session_metrics must have ts");
});

test("B2: context_peak_tokens is the max single-turn total input across deduped orch messages", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // o1: input=100, cache_creation=200, cache_read=500  → turn total = 800
  // o2: input=50,  cache_creation=100, cache_read=5000 → turn total = 5150  ← peak
  // o3: input=10,  cache_creation=0,   cache_read=100  → turn total = 110
  const stdinJson = makeCustomFixture({
    orchMessages: [
      { id: "o1", usage: { input_tokens: 100, output_tokens: 9, cache_creation_input_tokens: 200, cache_read_input_tokens: 500 } },
      { id: "o2", usage: { input_tokens: 50, output_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000 } },
      { id: "o3", usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } },
    ],
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const records = readAllRecords(logPath);
  const sessionMetrics = records.find((rec) => rec.event === "session_metrics");
  assert.ok(sessionMetrics, "session_metrics record must exist");
  assert.equal(sessionMetrics.context_peak_tokens, 5150,
    "context_peak_tokens must be the max single-turn (input+cache_creation+cache_read), which is o2=5150");
});

test("B2: tool_call_composition counts tool_use blocks by category", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // Orchestrator messages contain:
  //   Bash × 2, Task × 1, Agent × 1, Read × 1, Grep × 1, Glob × 1, Write × 1 (other)
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [
          { type: "tool_use", id: "tu1", name: "Bash" },
          { type: "tool_use", id: "tu2", name: "Bash" },
          { type: "tool_use", id: "tu3", name: "Task" },
          { type: "tool_use", id: "tu4", name: "Agent" },
        ],
      },
      {
        id: "o2",
        usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [
          { type: "tool_use", id: "tu5", name: "Read" },
          { type: "tool_use", id: "tu6", name: "Grep" },
          { type: "tool_use", id: "tu7", name: "Glob" },
          { type: "tool_use", id: "tu8", name: "Write" },
        ],
      },
    ],
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const records = readAllRecords(logPath);
  const sessionMetrics = records.find((rec) => rec.event === "session_metrics");
  assert.ok(sessionMetrics, "session_metrics record must exist");

  const comp = sessionMetrics.tool_call_composition;
  assert.equal(comp.bash, 2, "bash count must be 2");
  assert.equal(comp.agent, 2, "agent count must be 2 (Task + Agent)");
  assert.equal(comp.read_only, 3, "read_only count must be 3 (Read + Grep + Glob)");
  assert.equal(comp.other, 1, "other count must be 1 (Write)");
});

// ── Boundary: output-only message must NOT be counted as input-0 ──────────────
// A message with only output_tokens (no input/cache fields) passes hasValidUsage
// but must be excluded from orchestratorInputTokens via hasInputUsage, so it does
// not inject a spurious true-0 into the input sum.

test("hasInputUsage boundary: output-only message excluded from input metrics", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const orchPath = join(dir, "orch-outputonly.jsonl");
  const subPath = join(dir, "sub-outputonly.jsonl");

  writeJsonl(orchPath, [
    // Valid input-bearing message: input=100, cache_creation=500, cache_read=2000
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z",
      message: { id: "o1", model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 2000 },
        content: [] } },
    // Output-only message: only output_tokens, NO input-side fields at all.
    // hasValidUsage passes it (output_tokens is a number), but hasInputUsage must exclude it.
    // If it were included it would contribute 0 to orchestratorInputTokens — masking missing data.
    { type: "assistant", timestamp: "2026-06-19T10:00:01.000Z",
      message: { id: "o-outputonly", model: "claude-opus-4-8",
        usage: { output_tokens: 500 },
        content: [] } },
  ]);
  writeJsonl(subPath, [
    { type: "assistant", timestamp: "2026-06-19T10:00:30.000Z",
      message: { id: "s1", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:35.000Z",
      message: { id: "s2", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
  ]);

  const stdinJson = JSON.stringify({
    session_id: "sess-outputonly",
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: "implementer",
    last_assistant_message: "did work\nresult: done",
    hook_event_name: "SubagentStop",
    cwd: dir,
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  // Only o1 is input-bearing: orchestratorInputTokens = 100 + 500 + 2000 = 2600
  assert.equal(rec.orchestrator_input_tokens, 2600,
    "output-only message (o-outputonly) must be excluded from orchestratorInputTokens");
  // orchestratorNewInputTokens = 100 + 500 = 600 (no cache_read)
  assert.equal(rec.orchestrator_new_input_tokens, 600,
    "output-only message must be excluded from orchestratorNewInputTokens");
});

// ── Boundary: cache-only message (no input_tokens) must count in input metrics ─
// A message with cache_read or cache_creation but NO input_tokens must be included
// in input sums (hasInputUsage passes it; it contributes real cache costs).

test("hasInputUsage boundary: cache-only message (no input_tokens) correctly counted in input metrics", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const orchPath = join(dir, "orch-cacheonly.jsonl");
  const subPath = join(dir, "sub-cacheonly.jsonl");

  writeJsonl(orchPath, [
    // Cache-only: no input_tokens field, only cache_read + cache_creation.
    // hasInputUsage must include this; it represents real context cost.
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z",
      message: { id: "o-cacheonly", model: "claude-opus-4-8",
        usage: { output_tokens: 20, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 },
        content: [] } },
  ]);
  writeJsonl(subPath, [
    { type: "assistant", timestamp: "2026-06-19T10:00:30.000Z",
      message: { id: "s1", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:35.000Z",
      message: { id: "s2", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
  ]);

  const stdinJson = JSON.stringify({
    session_id: "sess-cacheonly",
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: "implementer",
    last_assistant_message: "did work\nresult: done",
    hook_event_name: "SubagentStop",
    cwd: dir,
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  // Cache-only message: orchestratorInputTokens = 0 (no input_tokens) + 1000 + 5000 = 6000
  assert.equal(rec.orchestrator_input_tokens, 6000,
    "cache-only message must be included in orchestratorInputTokens (cache_creation + cache_read)");
  // orchestratorNewInputTokens = cache_creation only = 1000
  assert.equal(rec.orchestrator_new_input_tokens, 1000,
    "cache-only message: new_input = cache_creation only (no cache_read), = 1000");
});

// ── Boundary: message.id dedup for B1 new fields ─────────────────────────────
// Duplicate message.id must not be double-counted in orchestratorInputTokens /
// orchestratorNewInputTokens (orchInputDeduped guards this).

test("B1 dedup: duplicate message.id not double-counted in input metrics", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // o1 appears twice with the same message.id — must only count once.
  const stdinJson = makeCustomFixture({
    orchMessages: [
      {
        id: "o1",
        usage: { input_tokens: 200, output_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 3000 },
      },
      // Exact duplicate — same id, same usage. Must be deduped.
      {
        id: "o1",
        usage: { input_tokens: 200, output_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 3000 },
      },
    ],
    subMessages: [
      { id: "s1", timestamp: "2026-06-19T10:00:30.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { id: "s2", timestamp: "2026-06-19T10:00:35.000Z", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ],
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const rec = readFirstRecord(logPath);
  // Only one instance of o1 should count: 200 + 1000 + 3000 = 4200
  assert.equal(rec.orchestrator_input_tokens, 4200,
    "duplicate message.id must be deduped: orchestratorInputTokens must count o1 exactly once");
  // orchestratorNewInputTokens = 200 + 1000 = 1200 (once, not twice)
  assert.equal(rec.orchestrator_new_input_tokens, 1200,
    "duplicate message.id must be deduped: orchestratorNewInputTokens must count o1 exactly once");
});

// ── Boundary: tool_use block.id dedup in tool_call_composition ────────────────
// The same tool_use block appearing in multiple sibling message lines (CC splits
// one turn across multiple lines sharing message.id) must not be double-counted
// in tool_call_composition. block.id dedup guards this.

test("tool_use block.id dedup: same block.id in two orch lines counted only once in composition", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const orchPath = join(dir, "orch-blockdedup.jsonl");
  const subPath = join(dir, "sub-blockdedup.jsonl");

  // CC transcript pattern: same message.id split across two lines (text + tool_use sibling).
  // Both lines carry the same block.id "tu-bash-1". Must count as 1 Bash, not 2.
  writeJsonl(orchPath, [
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z",
      message: { id: "o1", model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: "text", text: "Running command" }] } },
    // Sibling line with same message.id but tool_use content (CC split pattern)
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z",
      message: { id: "o1", model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: "tool_use", id: "tu-bash-1", name: "Bash", input: { command: "ls" } }] } },
    // A genuinely new message with a different tool_use block (different block.id)
    { type: "assistant", timestamp: "2026-06-19T10:00:01.000Z",
      message: { id: "o2", model: "claude-opus-4-8",
        usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: "tool_use", id: "tu-read-1", name: "Read", input: { path: "x.ts" } }] } },
  ]);
  writeJsonl(subPath, [
    { type: "assistant", timestamp: "2026-06-19T10:00:30.000Z",
      message: { id: "s1", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:35.000Z",
      message: { id: "s2", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
  ]);

  const stdinJson = JSON.stringify({
    session_id: "sess-blockdedup",
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: "implementer",
    last_assistant_message: "did work\nresult: done",
    hook_event_name: "SubagentStop",
    cwd: dir,
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const records = readAllRecords(logPath);
  const sessionMetrics = records.find((rec) => rec.event === "session_metrics");
  assert.ok(sessionMetrics, "session_metrics record must exist");

  const comp = sessionMetrics.tool_call_composition;
  // tu-bash-1 appears in two sibling lines sharing message.id o1 → must count as 1 Bash
  assert.equal(comp.bash, 1,
    "block.id dedup: tu-bash-1 in two sibling lines must count as 1 Bash (not 2)");
  // tu-read-1 is a new unique block → 1 read_only
  assert.equal(comp.read_only, 1,
    "tu-read-1 must count as 1 read_only");
  assert.equal(comp.agent, 0, "no agent blocks");
  assert.equal(comp.other, 0, "no other blocks");
});

// ── Boundary: all output-only orch messages → context_peak_tokens must be null ──
// When every orchestrator message lacks input-side fields (orchInputDeduped is empty),
// context_peak_tokens must be null, not 0 (0 is a fake value that would pollute monitoring).

test("B2 boundary: context_peak_tokens is null when all orch messages are output-only", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const orchPath = join(dir, "orch-alloutput.jsonl");
  const subPath = join(dir, "sub-alloutput.jsonl");

  writeJsonl(orchPath, [
    // Both messages have only output_tokens — no input-side fields at all.
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z",
      message: { id: "o-out1", model: "claude-opus-4-8",
        usage: { output_tokens: 300 },
        content: [] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:01.000Z",
      message: { id: "o-out2", model: "claude-opus-4-8",
        usage: { output_tokens: 500 },
        content: [] } },
  ]);
  // Sub transcript needs >=2 timestamps to avoid the "incomplete" early-exit path
  // (which skips writing session_metrics). Two messages with different timestamps suffice.
  writeJsonl(subPath, [
    { type: "assistant", timestamp: "2026-06-19T10:00:30.000Z",
      message: { id: "s1", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:35.000Z",
      message: { id: "s2", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [] } },
  ]);

  const stdinJson = JSON.stringify({
    session_id: "sess-alloutput",
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: "implementer",
    last_assistant_message: "did work\nresult: done",
    hook_event_name: "SubagentStop",
    cwd: dir,
  });

  const r = runHook(stdinJson, logPath);
  assert.equal(r.status, 0, "must exit 0\nstderr: " + r.stderr);

  const records = readAllRecords(logPath);
  const sessionMetrics = records.find((rec) => rec.event === "session_metrics");
  assert.ok(sessionMetrics, "session_metrics record must exist");
  assert.strictEqual(sessionMetrics.context_peak_tokens, null,
    "context_peak_tokens must be null (not 0) when all orch messages are output-only");
});
