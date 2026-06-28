// spool-agent-output.test.js — unit tests for hooks/spool-agent-output.mjs
//
// Strategy: spawn the hook script as a subprocess with crafted stdin payloads,
// inspect stdout (hookSpecificOutput.updatedToolOutput) and verify spooled file on disk.
// All temp dirs are cleaned up after tests.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = dirname(__dirname);
const HOOK = join(PLUGIN_ROOT, "hooks", "spool-agent-output.mjs");

// Temp dir for spool output.
const TEST_SPOOL_DIR = join(tmpdir(), `spool-agent-test-${Date.now()}-${process.pid}`);
mkdirSync(TEST_SPOOL_DIR, { recursive: true });

after(() => {
  try {
    rmSync(TEST_SPOOL_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────

function runHook(payload, extraEnv = {}) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: TEST_SPOOL_DIR,
    ...extraEnv,
  };
  // Ensure spool is enabled by default (remove disabling env overrides).
  if (env.WORKER_OUTPUT_SPOOL === "") delete env.WORKER_OUTPUT_SPOOL;

  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
    timeout: 15000,
  });
  return result;
}

function bigText(chars = 3000) {
  let s = "";
  while (s.length < chars) {
    s += "The quick brown fox jumps over the lazy dog. ";
  }
  return s.slice(0, chars);
}

function smallText(chars = 500) {
  let s = "";
  while (s.length < chars) {
    s += "Short line. ";
  }
  return s.slice(0, chars);
}

function parseHookOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { __parseError: stdout };
  }
}

// ── test fixtures ─────────────────────────────────────────────────────────────

// Agent completed tool_response shape — content is array of ContentBlock objects.
function agentCompletedPayload(text, extra = {}) {
  return {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: "do stuff", prompt: "please do stuff" },
    tool_response: {
      status: "completed",
      content: [
        { type: "text", text },
      ],
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
    ...extra,
  };
}

// Agent tool_response where content is a raw string (legacy/unusual shape).
function agentStringPayload(text, extra = {}) {
  return {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: "do stuff", prompt: "please do stuff" },
    tool_response: {
      status: "completed",
      content: text,
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
    ...extra,
  };
}

// Task tool_response — similar shape to Agent.
function taskPayload(text, extra = {}) {
  return {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: { description: "do stuff", prompt: "please do stuff" },
    tool_response: {
      status: "completed",
      content: [
        { type: "text", text },
      ],
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
    ...extra,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

// ─ Scene ①: Agent completed, big output → updatedToolOutput is OBJECT, not string ─
test("① Agent completed big output → updatedToolOutput is object, not string", () => {
  const text = bigText(3000);
  const r = runHook(agentCompletedPayload(text));
  assert.equal(r.status, 0, "should exit 0");

  const out = parseHookOutput(r.stdout);
  assert.ok(out, "should produce output JSON");
  assert.ok(out.hookSpecificOutput, "should have hookSpecificOutput");
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");

  const uto = out.hookSpecificOutput.updatedToolOutput;
  // THIS is the A0-bug root regression guard: type must be object, not string.
  assert.equal(typeof uto, "object", "updatedToolOutput must be an object, not a string");

  // Content must still be an array (clone of original structure).
  assert.ok(Array.isArray(uto.content), "content must remain an array");
  assert.ok(uto.content.length >= 1, "content array non-empty");
  assert.equal(uto.content[0].type, "text", "content[0].type must be 'text'");
  assert.ok(
    uto.content[0].text.includes("[spool-agent-output]"),
    "content[0].text must contain summary prefix"
  );
  assert.ok(uto.content[0].text.length < text.length, "summary shorter than original");
});

// ─ Scene ②: Agent completed → status:"completed" preserved ─
test("② Agent completed → status field preserved in updatedToolOutput", () => {
  const r = runHook(agentCompletedPayload(bigText(3000)));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  const uto = out.hookSpecificOutput.updatedToolOutput;

  assert.equal(uto.status, "completed", "status must remain 'completed'");
  // Ensure we didn't accidentally drop or mutate the status field.
  assert.equal(typeof uto.status, "string", "status must be a string");
});

// ─ Scene ③: Summary written into content[0].text ─
test("③ Agent completed → summary written into content[0].text", () => {
  const originalText = bigText(3000);
  const r = runHook(agentCompletedPayload(originalText));
  const out = parseHookOutput(r.stdout);
  const uto = out.hookSpecificOutput.updatedToolOutput;

  const summary = uto.content[0].text;
  assert.ok(summary.includes("[spool-agent-output]"), "summary has prefix tag");
  assert.ok(summary.includes("总长:"), "summary includes total char count");
  assert.ok(summary.includes("完整输出:"), "summary includes spool path ref");
  assert.ok(summary.includes("=== 摘要 ==="), "summary includes head excerpt");
  // Original content is NOT in the summary (only the head portion).
  assert.ok(summary.length < originalText.length, "summary must be shorter than original");
});

// ─ Scene ④: Small output (under threshold) → no replacement ─
test("④ Agent small output → no replacement (exit 0, empty stdout)", () => {
  const r = runHook(agentCompletedPayload(smallText(800)));
  assert.equal(r.status, 0, "should exit 0");
  const out = parseHookOutput(r.stdout);
  // Hook writes "{}" on no-replacement (empty JSON object, not empty string).
  assert.ok(!out.hookSpecificOutput, "small output must not trigger spool");
});

// ─ Scene ⑤: OUTPUT_LIMIT boundary → exactly at limit = no spool, above = spool ─
test("⑤a exactly at OUTPUT_LIMIT_CHARS (1200) → no spool (not above threshold)", () => {
  const text = bigText(1200); // exactly at limit
  const r = runHook(agentCompletedPayload(text));
  assert.equal(r.status, 0, "should exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(!out.hookSpecificOutput, "exactly at limit must not spool (only above limit)");
});

test("⑤b just above OUTPUT_LIMIT_CHARS (1201) → spool triggers", () => {
  const text = bigText(1201);
  const r = runHook(agentCompletedPayload(text));
  assert.equal(r.status, 0, "should exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "just above limit must trigger spool");
  assert.equal(typeof out.hookSpecificOutput.updatedToolOutput, "object");
});

// ─ Scene ⑥: Task → same spool behavior as Agent ─
test("⑥ Task completed big output → spooled like Agent", () => {
  const text = bigText(3000);
  const r = runHook(taskPayload(text));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput);

  const uto = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof uto, "object", "updatedToolOutput must be an object");
  assert.ok(Array.isArray(uto.content), "content must be an array");
  assert.ok(uto.content[0].text.includes("[spool-agent-output]"), "summary prefixed");
  assert.equal(uto.status, "completed", "Task status preserved");
});

// ─ Scene ⑦: Non-Agent/Task tool → fail-open, no replacement ─
test("⑦ Bash tool → not routed, no replacement", () => {
  const payload = agentCompletedPayload(bigText(3000));
  payload.tool_name = "Bash";
  const r = runHook(payload);
  assert.equal(r.status, 0, "should exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(!out.hookSpecificOutput, "Bash must be ignored by agent spool hook");
});

// ─ Scene ⑧: WORKER_OUTPUT_SPOOL=off → pass-through ─
test("⑧ WORKER_OUTPUT_SPOOL=off → no replacement", () => {
  const r = runHook(agentCompletedPayload(bigText(3000)), { WORKER_OUTPUT_SPOOL: "off" });
  assert.equal(r.status, 0, "should exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(!out.hookSpecificOutput, "spool disabled → no replacement");
});

// ─ Scene ⑨: Invalid JSON stdin → fail-open ─
test("⑨ invalid JSON stdin → fail-open exit 0 no output", () => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: TEST_SPOOL_DIR };
  const result = spawnSync("node", [HOOK], {
    input: "THIS IS NOT JSON {{{{",
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, "must exit 0 (fail-open)");
  const out = parseHookOutput(result.stdout);
  assert.ok(!out.hookSpecificOutput, "no output on parse failure");
});

// ─ Scene ⑩: Missing tool_response → fail-open ─
test("⑩ missing tool_response → fail-open, no replacement", () => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: TEST_SPOOL_DIR };
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Agent", session_id: "x" }),
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, "must exit 0");
  const out = parseHookOutput(result.stdout);
  assert.ok(!out.hookSpecificOutput, "no replacement when tool_response absent");
});

// ─ Scene ⑪: Write failure → fail-open ─
test("⑪ write failure → fail-open exit 0 no output", () => {
  const r = runHook(agentCompletedPayload(bigText(3000)), {
    CLAUDE_PROJECT_DIR: "/dev/null/impossible-path-xyz",
  });
  assert.equal(r.status, 0, "must exit 0 even if write fails");
  const out = parseHookOutput(r.stdout);
  assert.ok(!out.hookSpecificOutput, "no replacement on write failure");
});

// ─ Scene ⑫: Output structure matches original Agent tool_response shape ─
test("⑫ output preserves original Agent tool_response structure (clone, not mutate)", () => {
  const text = bigText(3000);
  const payload = agentCompletedPayload(text);
  // Add extra fields that exist on real Agent responses.
  payload.tool_response.subtype = "success";
  payload.tool_response.uuid = "abc-123-def";

  const r = runHook(payload);
  const out = parseHookOutput(r.stdout);
  const uto = out.hookSpecificOutput.updatedToolOutput;

  // Core structure intact.
  assert.equal(uto.status, "completed", "status preserved");
  assert.ok(Array.isArray(uto.content), "content is array");
  // Extra fields preserved.
  assert.equal(uto.subtype, "success", "subtype preserved");
  assert.equal(uto.uuid, "abc-123-def", "uuid preserved");
  // Content is replaced (not mutated in-place on original).
  const originalContentLength = payload.tool_response.content[0].text.length;
  assert.ok(
    uto.content[0].text.length < originalContentLength,
    "content replaced with shorter summary"
  );
});

// ─ Scene ⑬: Agent with string content → spooled with replaced content ─
test("⑬ Agent with string content → summary replaces content string", () => {
  const text = bigText(3000);
  const r = runHook(agentStringPayload(text));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput);

  const uto = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof uto, "object", "updatedToolOutput must be an object");
  assert.equal(typeof uto.content, "string", "content must be string (original shape preserved)");
  assert.ok(uto.content.includes("[spool-agent-output]"), "content replaced with summary");
  assert.ok(uto.content.length < text.length, "summary shorter than original");
});

// ─ Scene ⑭: Unrecognised content shape → fail-open ─
test("⑭ unrecognised content shape (not string, not array) → fail-open", () => {
  const payload = {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: "do stuff", prompt: "please do stuff" },
    tool_response: {
      status: "completed",
      content: 42, // number — unrecognised shape
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
  };
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  // The extractText returns "" for unexpected content (length 0 ≤ threshold), so no spool.
  // But even if it somehow gets past, the unrecognised-shape branch exits 0.
});

// ─ Scene ⑮: HOOK stdout shape is valid single JSON object ─
test("⑮ hook stdout is exactly one valid JSON object", () => {
  const r = runHook(agentCompletedPayload(bigText(3000)));
  assert.equal(r.status, 0);
  const rawStdout = r.stdout.trim();
  assert.ok(rawStdout.length > 0, "should produce output for big input");

  let parsed;
  try {
    parsed = JSON.parse(rawStdout);
  } catch (e) {
    assert.fail("stdout is not valid JSON: " + e.message);
  }

  const lines = rawStdout.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, "must be exactly one JSON line");
  assert.ok(parsed.hookSpecificOutput, "top-level hookSpecificOutput present");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
});

// ─ Scene ⑯: Async/remote agent — hook runs fail-open for incomplete shape ─
// The hook has no special async/remote branch; it processes whatever tool_response
// it receives. If the agent is still running (incomplete status), the content may
// be a placeholder. The hook should either process it normally or fail-open.
test("⑯a Agent with status 'running' (incomplete async agent) → content empty, no spool", () => {
  const payload = {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: "remote work", prompt: "do async stuff" },
    tool_response: {
      status: "running",
      content: [{ type: "text", text: "Agent is still running..." }],
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
  };
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  // Content is short ("Agent is still running...") < 1200 → no spool.
  const out = parseHookOutput(r.stdout);
  assert.ok(!out.hookSpecificOutput, "small remote agent output → no spool");
});

test("⑯b Agent with missing content field → fail-open", () => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: TEST_SPOOL_DIR };
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      session_id: "test-session",
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { description: "do stuff", prompt: "do stuff" },
      tool_response: {
        status: "completed",
        // no content field
      },
      transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
      cwd: TEST_SPOOL_DIR,
      permission_mode: "default",
    }),
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, "must exit 0");
  // extractText returns "" from missing content → totalChars=0 ≤ 1200 → no spool.
});

// ─ Scene ⑰: Spool file exists on disk with correct content ─
test("⑰ big Agent output → spool file exists on disk with full original content", () => {
  const originalText = bigText(3000);
  const r = runHook(agentCompletedPayload(originalText));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput);

  const uto = out.hookSpecificOutput.updatedToolOutput;
  const summaryText = uto.content[0].text;
  const match = summaryText.match(/完整输出: (.+\.md)/);
  assert.ok(match, "summary must contain spool file path");
  const spoolPath = match[1];

  assert.ok(existsSync(spoolPath), `spool file must exist at ${spoolPath}`);
  const spooledContent = readFileSync(spoolPath, "utf8");
  assert.equal(spooledContent, originalText, "spool file must contain full original output");
});

// ─ Scene ⑱: WORKER_OUTPUT_SPOOL case/whitespace variants ─
test("⑱ WORKER_OUTPUT_SPOOL case/whitespace variants → no replacement", () => {
  for (const val of ["OFF", " false ", "0", " OFF ", "False"]) {
    const r = runHook(agentCompletedPayload(bigText(3000)), { WORKER_OUTPUT_SPOOL: val });
    assert.equal(r.status, 0, `exit 0 for WORKER_OUTPUT_SPOOL=${JSON.stringify(val)}`);
    const out = parseHookOutput(r.stdout);
    assert.ok(
      !out.hookSpecificOutput,
      `no replacement for WORKER_OUTPUT_SPOOL=${JSON.stringify(val)}`
    );
  }
});

// ─ Scene ⑲: Agent with large output and agent_id → still spooled (agent_id exemption NOT in this hook) ─
// Unlike spool-tool-output.mjs, this hook does NOT exempt subagents by agent_id.
// It only checks tool_name === "Agent" or "Task".
test("⑲ Agent with agent_id present → still spooled (no subagent exemption)", () => {
  const text = bigText(3000);
  const r = runHook(agentCompletedPayload(text, { agent_id: "subagent-abc-123" }));
  assert.equal(r.status, 0, "should exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "agent with agent_id must still be spooled");
  assert.equal(typeof out.hookSpecificOutput.updatedToolOutput, "object");
});
