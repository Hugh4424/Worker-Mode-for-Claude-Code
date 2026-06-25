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

  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
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

  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
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

  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
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

  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
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

  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
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

  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
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

  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
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

  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.status, "incomplete", "empty subagent transcript must yield status=incomplete");
});
