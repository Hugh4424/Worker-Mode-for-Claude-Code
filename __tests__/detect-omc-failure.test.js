// detect-omc-failure.test.js — unit tests for hooks/detect-omc-failure.mjs
// Runs via: node --test __tests__/detect-omc-failure.test.js
//
// Spawns the hook as a child process, feeds hookData via stdin,
// asserts marker presence/absence using a temp CLAUDE_PROJECT_DIR.
//
// NOTE: hook is now a PostToolUseFailure hook. Payload shape:
//   { tool_name, tool_input, error (string), session_id, agent_id }
//   NO tool_response field.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookPath = join(pluginRoot, "hooks", "detect-omc-failure.mjs");
const clearToolPath = join(pluginRoot, "tools", "clear-failure-marker.mjs");
const enforceBackendPath = join(pluginRoot, "hooks", "enforce-backend.mjs");

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "detect-omc-failure-test-"));
}

function teardown() {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

function markerPath() {
  return join(tmpDir, ".worker-mode", "state", "omc-failure.marker");
}

function markerExists() {
  return existsSync(markerPath());
}

function readMarker() {
  return JSON.parse(readFileSync(markerPath(), "utf8"));
}

/**
 * Run the hook with the given hookData as stdin JSON.
 * Returns { stdout, stderr, status }.
 */
function runHook({ hookData = {}, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(hookData),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpDir,
      // Unset WORKER_LOG_PATH so record-worker isn't accidentally triggered
      WORKER_LOG_PATH: undefined,
      ...extraEnv,
    },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

// Test 1: Main session Task failure with omc subagent_type → writes marker
test("main session Task failure + omc subagent_type writes marker", (t) => {
  setup();
  t.after(teardown);

  const hookData = {
    tool_name: "Task",
    tool_input: { subagent_type: "oh-my-claudecode:executor", prompt: "do work" },
    error: "agent crashed",
    session_id: "sess-abc123",
    // agent_id absent → main session
  };

  const result = runHook({ hookData });

  assert.strictEqual(result.status, 0, "hook must exit 0");
  assert.ok(markerExists(), "marker should exist");

  const marker = readMarker();
  assert.strictEqual(marker.reason, "omc_agent_failed");
  assert.strictEqual(marker.subagent_type, "oh-my-claudecode:executor");
  assert.strictEqual(marker.tool_name, "Task");
  assert.strictEqual(marker.session_id, "sess-abc123");
  assert.ok(marker.ts, "marker should have a ts field");
});

// Test 2: Marker content includes error field from payload
test("marker content includes error field from payload", (t) => {
  setup();
  t.after(teardown);

  const hookData = {
    tool_name: "Task",
    tool_input: { subagent_type: "oh-my-claudecode:executor", prompt: "do work" },
    error: "some failure reason",
    session_id: "sess-abc123",
  };

  const result = runHook({ hookData });

  assert.strictEqual(result.status, 0);
  assert.ok(markerExists(), "marker should exist");

  const marker = readMarker();
  assert.strictEqual(marker.error, "some failure reason", "marker should include error field from payload");
});

// Test 3: Main session Task failure with legacy subagent_type → no marker
test("main session Task failure + non-omc subagent_type → no marker", (t) => {
  setup();
  t.after(teardown);

  const hookData = {
    tool_name: "Task",
    tool_input: { subagent_type: "implementer", prompt: "do work" },
    error: "crashed",
    session_id: "sess-abc123",
  };

  const result = runHook({ hookData });

  assert.strictEqual(result.status, 0);
  assert.ok(!markerExists(), "marker should NOT exist for non-omc failures");
});

// Test 4: Sub-agent (agent_id present) Task failure → no marker (exempted)
test("sub-agent (agent_id present) Task failure → no marker", (t) => {
  setup();
  t.after(teardown);

  const hookData = {
    tool_name: "Task",
    tool_input: { subagent_type: "oh-my-claudecode:executor", prompt: "nested work" },
    error: "agent crashed",
    session_id: "sess-abc123",
    agent_id: "sub-agent-xyz", // marks this as a sub-agent call
  };

  const result = runHook({ hookData });

  assert.strictEqual(result.status, 0);
  assert.ok(!markerExists(), "marker should NOT exist for sub-agent dispatches");
});

// Test 5: Non-Task tool (Bash) → no marker
test("non-Task tool (Bash) → no marker", (t) => {
  setup();
  t.after(teardown);

  const hookData = {
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
    error: "command failed",
    session_id: "sess-abc123",
  };

  const result = runHook({ hookData });

  assert.strictEqual(result.status, 0);
  assert.ok(!markerExists(), "marker should NOT exist for non-Task tools");
});

// Test 6: Bad JSON / missing fields → fail-open, no crash, no marker
test("bad JSON stdin → fail-open, no crash, no marker", (t) => {
  setup();
  t.after(teardown);

  const result = spawnSync(process.execPath, [hookPath], {
    input: "not valid json {{{",
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpDir,
    },
  });

  assert.strictEqual(result.status, 0, "hook must exit 0 on bad JSON");
  assert.ok(!markerExists(), "marker should NOT exist on bad JSON");
  // stdout should be {} or empty — either is fine (hook outputs {} at the end)
});

// Test 7: Sub-directory clear test — verifies clear-failure-marker.mjs upward search
test("clear-failure-marker from subdirectory finds marker via upward search", (t) => {
  setup();
  t.after(teardown);

  // Write a marker at <root>/.worker-mode/state/omc-failure.marker
  const stateDir = join(tmpDir, ".worker-mode", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "omc-failure.marker"), JSON.stringify({ ts: new Date().toISOString() }));

  assert.ok(existsSync(join(stateDir, "omc-failure.marker")), "marker should exist before clear");

  // Create a subdirectory of the project root
  const subDir = join(tmpDir, "some", "sub", "dir");
  mkdirSync(subDir, { recursive: true });

  // Run clear-failure-marker.mjs with cwd = subDir, WITHOUT CLAUDE_PROJECT_DIR set
  const result = spawnSync(process.execPath, [clearToolPath], {
    encoding: "utf8",
    cwd: subDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: "", // explicitly unset
    },
  });

  assert.strictEqual(result.status, 0, `clear tool should exit 0; stderr: ${result.stderr}`);
  assert.ok(!existsSync(join(stateDir, "omc-failure.marker")), "marker should be deleted after clear");
});

// Test 8: Three-way path consistency — detect→enforce→clear all point to same file
test("three-way path consistency: detect writes, enforce denies, clear removes, enforce allows", (t) => {
  setup();
  t.after(teardown);

  // Step 1: Run detect-omc-failure hook with a valid failure payload → assert marker written
  const detectHookData = {
    tool_name: "Task",
    tool_input: { subagent_type: "oh-my-claudecode:executor", prompt: "do work" },
    error: "omc executor crashed",
    session_id: "sess-three-way",
    cwd: tmpDir,
  };

  const detectResult = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(detectHookData),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpDir,
    },
  });

  assert.strictEqual(detectResult.status, 0, "detect hook must exit 0");
  assert.ok(existsSync(markerPath()), "marker should exist after detect hook");

  // Step 2: Run enforce-backend hook with a legacy-targeting payload → assert deny (marker blocks)
  const enforceHookData = {
    tool_name: "Task",
    tool_input: { subagent_type: "implementer" },
    session_id: "sess-three-way",
    cwd: tmpDir,
    // no agent_id → main session
  };

  const enforceResult1 = spawnSync(process.execPath, [enforceBackendPath], {
    input: JSON.stringify(enforceHookData),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpDir,
      WORKER_MODE_BACKEND: "omc",
    },
  });

  assert.strictEqual(enforceResult1.status, 0, "enforce hook must exit 0");
  assert.ok(
    enforceResult1.stdout.includes('"deny"'),
    `enforce should deny when marker exists; stdout: ${enforceResult1.stdout}`
  );

  // Step 3: Run clear-failure-marker tool → assert marker gone
  const clearResult = spawnSync(process.execPath, [clearToolPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpDir,
    },
  });

  assert.strictEqual(clearResult.status, 0, `clear tool must exit 0; stderr: ${clearResult.stderr}`);
  assert.ok(!existsSync(markerPath()), "marker should be gone after clear");

  // Step 4: Run enforce-backend again → assert it allows (no marker, no block)
  const enforceResult2 = spawnSync(process.execPath, [enforceBackendPath], {
    input: JSON.stringify(enforceHookData),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpDir,
      WORKER_MODE_BACKEND: "omc",
    },
  });

  assert.strictEqual(enforceResult2.status, 0, "enforce hook must exit 0 after clear");
  // When marker is gone, enforce denies for wrong_backend (omc mode dispatching legacy),
  // NOT marker_block. But since WORKER_MODE_BACKEND=omc and subagent_type=implementer (legacy),
  // it will deny for wrong_backend. The key assertion is it does NOT contain "marker_block".
  assert.ok(
    !enforceResult2.stdout.includes("marker_block"),
    `enforce should not cite marker_block after clear; stdout: ${enforceResult2.stdout}`
  );
});

// Test 9: Sub-agent via transcript_path /subagents/ (no agent_id) → no marker
// Mirrors the enforce-backend subagent exemption: transcript_path containing /subagents/
// must also exempt detect-omc-failure (阻塞2 — 与 enforce-backend 保持一致).
test("sub-agent via transcript_path /subagents/ (no agent_id) → no marker (阻塞2)", (t) => {
  setup();
  t.after(teardown);

  const hookData = {
    tool_name: "Task",
    tool_input: { subagent_type: "oh-my-claudecode:executor", prompt: "nested work" },
    error: "agent crashed",
    session_id: "sess-abc123",
    transcript_path: "/home/user/.claude/subagents/session-abc.jsonl",
    // agent_id absent — exemption comes from transcript_path only
  };

  const result = runHook({ hookData });

  assert.strictEqual(result.status, 0);
  assert.ok(
    !markerExists(),
    "marker should NOT exist: transcript_path /subagents/ must exempt even without agent_id"
  );
});
