// extract-gates.test.js — unit tests for tools/extract-gates.mjs
// Runs via: node --test __tests__/extract-gates.test.js
//
// Constructs fake transcripts matching real Claude Code JSONL structure:
//   - type=assistant with message.content [{type:"tool_use", name:"Agent", id, input:{subagent_type, prompt}}]
//   - type=user with message.content [{type:"tool_result", tool_use_id, content:[{type:"text",text}]}]

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(pluginRoot, "tools", "extract-gates.mjs");

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "eg-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Build a minimal assistant record with an Agent tool_use */
function agentDispatch({ id, subagentType = "executor", prompt = "do something", ts = "2026-01-01T00:00:00.000Z", sessionId = "sess-001" }) {
  return {
    type: "assistant",
    sessionId,
    timestamp: ts,
    uuid: "uuid-" + id,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "Agent",
          id,
          input: { subagent_type: subagentType, prompt, description: "test agent" },
        },
      ],
    },
  };
}

/** Build a minimal user record with a tool_result */
function agentResult({ toolUseId, text = "task completed successfully", sessionId = "sess-001" }) {
  return {
    type: "user",
    sessionId,
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

/** Build an assistant text-only record (orchestrator continues without dispatch) */
function assistantText({ text = "Moving on to next task now.", sessionId = "sess-001" }) {
  return {
    type: "assistant",
    sessionId,
    timestamp: "2026-01-01T00:02:00.000Z",
    uuid: "uuid-text-" + Math.random(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

/** Write JSONL file from array of objects and run the script */
function runOnRecords(records) {
  const tmp = makeTmp();
  const jsonlPath = join(tmp, "transcript.jsonl");
  try {
    writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = spawnSync(process.execPath, [scriptPath, jsonlPath], {
      encoding: "utf8",
    });
    return { result, tmp };
  } catch (e) {
    cleanup(tmp);
    throw e;
  }
}

function parseOutput(result) {
  return JSON.parse(result.stdout.trim());
}

// ── test 1: accept — orchestrator continues different task after result ─────────

test("gate=accept when orchestrator continues to unrelated work after result", () => {
  const records = [
    agentDispatch({ id: "tu-001", prompt: "research competitors" }),
    agentResult({ toolUseId: "tu-001", text: "Research complete. Found 5 competitors." }),
    assistantText({ text: "Great findings. Now let me write the report based on the research." }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 1, "should have 1 gate record");
    assert.equal(gates[0].gate, "accept", "gate should be accept");
    assert.equal(gates[0].dispatch_subagent_type, "executor");
    assert.equal(gates[0].source, "auto");
    assert.equal(typeof gates[0].evidence, "string");
    assert.equal(typeof gates[0].session_id, "string");
  } finally {
    cleanup(tmp);
  }
});

// ── test 2: return — next Agent dispatch has fix keywords ──────────────────────

test("gate=return when next Agent dispatch contains fix/retry keywords", () => {
  const records = [
    agentDispatch({ id: "tu-002", prompt: "implement the feature" }),
    agentResult({ toolUseId: "tu-002", text: "Done, but tests failed." }),
    assistantText({ text: "The tests failed. I need to fix this." }),
    agentDispatch({ id: "tu-003", prompt: "fix the failing tests and retry the implementation" }),
    agentResult({ toolUseId: "tu-003", text: "Tests now passing." }),
    assistantText({ text: "All done." }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 2, "should have 2 gate records");
    assert.equal(gates[0].gate, "return", "first gate should be return (retry dispatch followed)");
    assert.ok(gates[0].evidence.length > 0, "evidence should be non-empty");
  } finally {
    cleanup(tmp);
  }
});

// ── test 3: escalate removed — last dispatch with failure result → unknown ────
// escalate was removed (folded into unknown) because "result contains error/failed"
// triggers on normal completions like "error was fixed". Prefer unknown over fake data.

test("gate=unknown (not escalate) when last dispatch has failure result and session ends", () => {
  const records = [
    agentDispatch({ id: "tu-004", prompt: "deploy to production" }),
    agentResult({
      toolUseId: "tu-004",
      text: "Deploy failed: error connecting to server. Unable to complete.",
    }),
    // No more records — session ends after failure
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 1, "should have 1 gate record");
    // escalate is removed — folded into unknown. Failure signal alone is not
    // sufficient (could be "error was fixed" or task complete).
    assert.equal(gates[0].gate, "unknown", "gate should be unknown (escalate removed)");
    assert.notEqual(gates[0].gate, "escalate", "gate must NOT be escalate (removed)");
  } finally {
    cleanup(tmp);
  }
});

// ── test 4: unknown — ambiguous sequence (result present but no clear signal) ───

test("gate=unknown for ambiguous sequence with no clear follow-up", () => {
  const records = [
    agentDispatch({ id: "tu-005", prompt: "analyze the codebase" }),
    agentResult({ toolUseId: "tu-005", text: "Analysis complete." }),
    // Only a very short text, not clearly moving on to another task
    {
      type: "assistant",
      sessionId: "sess-001",
      timestamp: "2026-01-01T00:02:00.000Z",
      uuid: "uuid-short",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Ok." }], // too short to be "moving on"
      },
    },
    // No further Agent dispatches
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 1, "should have 1 gate record");
    assert.equal(gates[0].gate, "unknown", "gate should be unknown for ambiguous case");
  } finally {
    cleanup(tmp);
  }
});

// ── test 5: empty transcript → no crash, empty array ──────────────────────────

test("empty transcript returns empty array without crashing", () => {
  const { result, tmp } = runOnRecords([]);
  try {
    assert.equal(result.status, 0, "exit code 0 for empty input");
    const gates = parseOutput(result);
    assert.ok(Array.isArray(gates), "output should be array");
    assert.equal(gates.length, 0, "empty transcript → empty array");
  } finally {
    cleanup(tmp);
  }
});

// ── test 6: bad JSON lines → no crash, parses good lines ──────────────────────

test("bad JSON lines are skipped without crashing", () => {
  const tmp = makeTmp();
  const jsonlPath = join(tmp, "bad.jsonl");
  try {
    const goodRecord = agentDispatch({ id: "tu-006", prompt: "do work" });
    const lines = [
      "NOT VALID JSON {{{",
      JSON.stringify(goodRecord),
      JSON.stringify(agentResult({ toolUseId: "tu-006" })),
      "another bad line",
      JSON.stringify(assistantText({ text: "Continuing with next analysis task now." })),
    ];
    writeFileSync(jsonlPath, lines.join("\n") + "\n");

    const result = spawnSync(process.execPath, [scriptPath, jsonlPath], { encoding: "utf8" });
    assert.equal(result.status, 0, "exit code 0 with bad JSON lines; stderr: " + result.stderr);
    const gates = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(gates), "output should be array");
    // Should process the good Agent record
    assert.equal(gates.length, 1, "should have 1 gate from the valid Agent dispatch");
  } finally {
    cleanup(tmp);
  }
});

// ── test 7: output format — all required fields present on every record ─────────

test("every output record has required fields with valid gate enum", () => {
  const VALID_GATES = new Set(["accept", "return", "unknown"]); // escalate removed
  const records = [
    agentDispatch({ id: "tu-007", subagentType: "reviewer", prompt: "review the PR" }),
    agentResult({ toolUseId: "tu-007", text: "Review done. LGTM." }),
    assistantText({ text: "Thanks. Now moving on to the next PR to review." }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    for (const rec of gates) {
      assert.ok("ts" in rec, "record must have ts field");
      assert.equal(rec.source, "auto", "source must be 'auto'");
      assert.ok("dispatch_subagent_type" in rec, "record must have dispatch_subagent_type");
      assert.ok(VALID_GATES.has(rec.gate), "gate must be valid enum value, got: " + rec.gate);
      assert.equal(typeof rec.session_id, "string", "session_id must be string");
      assert.equal(typeof rec.evidence, "string", "evidence must be string");
      assert.ok(rec.evidence.length > 0, "evidence must not be empty");
    }
  } finally {
    cleanup(tmp);
  }
});

// ── test 8: multiple dispatches in one session ────────────────────────────────

test("multiple dispatches in sequence each get their own gate record", () => {
  const records = [
    agentDispatch({ id: "tu-010", prompt: "research topic A" }),
    agentResult({ toolUseId: "tu-010", text: "Research on A complete." }),
    agentDispatch({ id: "tu-011", prompt: "research topic B" }),
    agentResult({ toolUseId: "tu-011", text: "Research on B complete." }),
    assistantText({ text: "Both research tasks finished. Writing summary now." }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 2, "two dispatches → two gate records");
    for (const g of gates) {
      assert.ok(["accept", "return", "unknown"].includes(g.gate)); // escalate removed
    }
  } finally {
    cleanup(tmp);
  }
});

// ── test 9: missing file argument → exit 1 ────────────────────────────────────

test("missing file argument exits with code 1", () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.equal(result.status, 1, "should exit 1 when no file arg provided");
  assert.ok(result.stderr.includes("Usage"), "stderr should show usage hint");
});

// ── test 10: Chinese retry keywords trigger return ───────────────────────────
// "修复构建警告并重试" contains "重试" (retry) which is a strong back-reference keyword.

test("gate=return when next dispatch has Chinese retry keyword (重试)", () => {
  const records = [
    agentDispatch({ id: "tu-020", prompt: "执行构建任务" }),
    agentResult({ toolUseId: "tu-020", text: "构建完成，但有警告。" }),
    agentDispatch({ id: "tu-021", prompt: "修复构建警告并重试" }),
    agentResult({ toolUseId: "tu-021", text: "警告已修复。" }),
    assistantText({ text: "任务完成。" }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 2);
    assert.equal(gates[0].gate, "return", "重试 keyword should trigger return");
  } finally {
    cleanup(tmp);
  }
});

// ── test 11 (tricky): unrelated next task with "fix" word → accept, NOT return ──
// Old logic: gate=return (false positive — "fix" matched even for unrelated task)
// New logic: gate=accept (generic "fix" without retry/redo is excluded from return)

test("gate=accept (NOT return) when next dispatch is unrelated but prompt contains 'fix'", () => {
  const records = [
    agentDispatch({ id: "tu-030", prompt: "research competitor pricing" }),
    agentResult({ toolUseId: "tu-030", text: "Research complete. Found 5 competitors." }),
    assistantText({ text: "Great. Now moving on to the UI work." }),
    agentDispatch({ id: "tu-031", prompt: "fix the CSS layout bug on the homepage" }),
    agentResult({ toolUseId: "tu-031", text: "CSS bug fixed." }),
    assistantText({ text: "All done." }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 2, "should have 2 gate records");
    // First dispatch (research) followed by unrelated "fix CSS" task → must NOT be return
    // Old logic would have wrongly returned "return" because "fix" matched FIX_KEYWORDS
    assert.ok(
      gates[0].gate === "accept" || gates[0].gate === "unknown",
      `first gate must be accept or unknown, not return; got: ${gates[0].gate}`
    );
    assert.notEqual(gates[0].gate, "return", "unrelated 'fix' task must NOT trigger return");
  } finally {
    cleanup(tmp);
  }
});

// ── test 12 (tricky): parallel dispatches — siblings must not mis-detect each other ──
// Two tool_use items in the same assistant message are parallel siblings.
// Neither should be detected as a "return" for the other.

test("parallel dispatches (siblings in same message) do not mis-detect each other as return", () => {
  // Build an assistant record with TWO Agent tool_uses (parallel)
  const parallelAssistant = {
    type: "assistant",
    sessionId: "sess-parallel",
    timestamp: "2026-01-01T00:00:00.000Z",
    uuid: "uuid-parallel",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "Agent",
          id: "tu-040",
          input: { subagent_type: "executor", prompt: "research topic A", description: "parallel A" },
        },
        {
          type: "tool_use",
          name: "Agent",
          id: "tu-041",
          input: { subagent_type: "executor", prompt: "retry the B analysis from scratch", description: "parallel B" },
        },
      ],
    },
  };
  const records = [
    parallelAssistant,
    agentResult({ toolUseId: "tu-040", text: "Research A complete.", sessionId: "sess-parallel" }),
    agentResult({ toolUseId: "tu-041", text: "Analysis B complete.", sessionId: "sess-parallel" }),
    assistantText({ text: "Both parallel tasks finished. Writing summary." }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 2, "two parallel dispatches → two gate records");
    // tu-040's "next dispatch" is tu-041 (sibling, same idx=0). tu-041.idx=0, tu-040's resultIdx=1.
    // Since 0 > 1 is false, tu-041 must NOT be considered a sequential return for tu-040.
    assert.notEqual(gates[0].gate, "return",
      "parallel sibling with retry keyword must NOT trigger return for its co-sibling");
  } finally {
    cleanup(tmp);
  }
});

// ── test 13 (tricky): result text contains "error" but it's a normal completion ──
// "fixed the error successfully" should NOT be escalate (escalate is removed).
// Verify it's accept or unknown, never escalate.

test("result containing 'error' in normal completion context → accept or unknown, never escalate", () => {
  const records = [
    agentDispatch({ id: "tu-050", prompt: "fix the authentication error" }),
    agentResult({ toolUseId: "tu-050", text: "Fixed the error successfully. All tests pass." }),
    assistantText({ text: "Authentication is now working correctly. Moving on to deployment." }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 1, "should have 1 gate record");
    // escalate is removed — must never appear regardless of result text
    assert.notEqual(gates[0].gate, "escalate", "escalate must never appear (removed)");
    // Orchestrator continues with "Moving on" text (>30 chars) → accept
    assert.ok(
      gates[0].gate === "accept" || gates[0].gate === "unknown",
      `gate must be accept or unknown; got: ${gates[0].gate}`
    );
  } finally {
    cleanup(tmp);
  }
});

// ── test 14 (tricky): Chinese "修复了上个错误，现在做X" as NEW dispatch prompt ──
// The NEW dispatch says "fix the previous error, now do X" — this is ambiguous
// phrasing used in a new task prompt, NOT a back-reference retry.
// The PREVIOUS dispatch must NOT be mis-detected as return.
// Only strong retry/redo keywords (再试/重试) should trigger return.

test("Chinese 'fixed the previous error, now do X' as new dispatch → previous NOT mis-detected as return", () => {
  const records = [
    agentDispatch({ id: "tu-060", prompt: "分析代码库" }),
    agentResult({ toolUseId: "tu-060", text: "分析完成。" }),
    assistantText({ text: "分析结果已收到。" }),
    // Next dispatch: "修复了上个错误，现在做X" — mentions "fixing previous error" but
    // the phrase "修复了" (already fixed) describes context, not a retry command.
    // There's no 再试/重试 here, so previous dispatch must NOT be marked return.
    agentDispatch({ id: "tu-061", prompt: "修复了上个错误，现在做代码重构" }),
    agentResult({ toolUseId: "tu-061", text: "重构完成。" }),
    assistantText({ text: "重构任务完成。" }),
  ];
  const { result, tmp } = runOnRecords(records);
  try {
    assert.equal(result.status, 0, "exit code 0; stderr: " + result.stderr);
    const gates = parseOutput(result);
    assert.equal(gates.length, 2, "should have 2 gate records");
    // First dispatch (分析代码库) followed by a new task that mentions "修复了" but no 再试/重试.
    // Old logic with FIX_KEYWORDS would have caught 修复 → return (false positive).
    // New logic: 修复 alone without 再试/重试 is not a RETURN_KEYWORD → must NOT be return.
    assert.notEqual(gates[0].gate, "return",
      "Chinese '修复了上个错误，现在做X' without 再试/重试 must NOT trigger return");
    assert.ok(
      gates[0].gate === "accept" || gates[0].gate === "unknown",
      `first gate must be accept or unknown; got: ${gates[0].gate}`
    );
  } finally {
    cleanup(tmp);
  }
});
