// spool-tool-output.test.js — unit tests for hooks/spool-tool-output.mjs
//
// Strategy: spawn the hook script as a subprocess with crafted stdin payloads,
// inspect stdout (hookSpecificOutput) and verify the spooled file on disk.
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
const HOOK = join(PLUGIN_ROOT, "hooks", "spool-tool-output.mjs");

// Temp dir for spool output (will be set as CLAUDE_PROJECT_DIR).
const TEST_SPOOL_DIR = join(tmpdir(), `spool-test-${Date.now()}-${process.pid}`);
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
    // Ensure spool is enabled by default (no override).
    WORKER_OUTPUT_SPOOL: "",
    ...extraEnv,
  };
  // Remove WORKER_OUTPUT_SPOOL from env if we explicitly cleared it (empty string
  // means "not set" for our logic, which treats only off/0/false as "disabled").
  if (env.WORKER_OUTPUT_SPOOL === "") delete env.WORKER_OUTPUT_SPOOL;

  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
    timeout: 15000,
  });
  return result;
}

// Build a large string exceeding the classifier thresholds (>150 lines OR >6000 bytes).
function bigText(lines = 200) {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}: ${"x".repeat(40)}`).join("\n");
}

// Build a small string well under the thresholds.
function smallText(lines = 10) {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

// Parse the hook stdout into an object (returns null if empty or invalid JSON).
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

function bashPayload(stdout, extra = {}) {
  return {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat /some/file.txt" },
    tool_response: {
      stdout,
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
    ...extra,
  };
}

function readPayload(content, filePath = "/some/source.ts", extra = {}) {
  return {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_response: {
      type: "text",
      file: {
        filePath,
        content,
      },
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
    ...extra,
  };
}

function grepPayload(content, path = "/some/dir", extra = {}) {
  return {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Grep",
    tool_input: { pattern: "TODO", path },
    tool_response: {
      mode: "grep",
      numFiles: 5,
      filenames: ["a.ts", "b.ts"],
      content,
      numLines: content.split("\n").length,
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
    ...extra,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

// ① WORKER_OUTPUT_SPOOL=off → pass-through (no replacement).
test("① WORKER_OUTPUT_SPOOL=off → no replacement", () => {
  const r = runHook(bashPayload(bigText()), { WORKER_OUTPUT_SPOOL: "off" });
  assert.equal(r.status, 0, "should exit 0");
  const out = parseHookOutput(r.stdout);
  assert.equal(out, null, "stdout should be empty (no replacement)");
});

// ② Small output (below classifier threshold) → no replacement.
test("② small Bash output → no replacement", () => {
  const r = runHook(bashPayload(smallText(5)));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.equal(out, null, "small output should not be spooled");
});

// ③ Big Bash → updatedToolOutput preserves stdout/stderr/interrupted/isImage fields.
test("③ big Bash output → spooled; updatedToolOutput preserves shape", () => {
  const stdout = bigText(200);
  const payload = bashPayload(stdout);
  payload.tool_response.stderr = "some warning";
  payload.tool_response.interrupted = false;
  payload.tool_response.isImage = false;
  payload.tool_response.noOutputExpected = false;

  const r = runHook(payload);
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out, "should produce output JSON");
  assert.ok(out.hookSpecificOutput, "should have hookSpecificOutput");
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");

  const updated = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  // stdout replaced with summary
  assert.ok(typeof updated.stdout === "string", "stdout must be a string");
  assert.ok(updated.stdout.includes("[spool-tool-output:"), "stdout should be summary");
  assert.ok(updated.stdout.length < stdout.length, "summary shorter than original");
  // other fields preserved
  assert.equal(updated.interrupted, false, "interrupted preserved");
  assert.equal(updated.isImage, false, "isImage preserved");
  assert.equal(updated.noOutputExpected, false, "noOutputExpected preserved");
  // stderr preserved in original response (not the summary field)
  assert.equal(updated.stderr, "some warning", "stderr field preserved in response");
});

// ④ Big Read → file.content replaced, file.filePath unchanged.
test("④ big Read output → file.content replaced, filePath preserved", () => {
  const content = bigText(200);
  const filePath = "/some/large-file.ts";
  const r = runHook(readPayload(content, filePath));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");

  const updated = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  assert.ok(typeof updated.file === "object", "file field present");
  assert.equal(updated.file.filePath, filePath, "filePath unchanged");
  assert.ok(updated.file.content.includes("[spool-tool-output:"), "content replaced with summary");
  assert.ok(updated.file.content.length < content.length);
  // type field preserved
  assert.equal(updated.type, "text", "type field preserved");
});

// ⑤ Big Grep → content replaced, other fields preserved.
test("⑤ big Grep output → content replaced, metadata preserved", () => {
  const content = bigText(200);
  const r = runHook(grepPayload(content));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput);

  const updated = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  assert.ok(updated.content.includes("[spool-tool-output:"), "content replaced");
  assert.equal(updated.numFiles, 5, "numFiles preserved");
  assert.deepEqual(updated.filenames, ["a.ts", "b.ts"], "filenames preserved");
});

// ⑥ Redline paths → no replacement (full content passes through).
test("⑥a redline path current.json → no replacement", () => {
  const r = runHook(readPayload(bigText(200), "/project/.worker-mode/state/current.json"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "redline path must not be spooled");
});

test("⑥b redline path .worker-mode → no replacement", () => {
  const r = runHook(readPayload(bigText(200), "/project/.worker-mode/state/something.md"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null);
});

test("⑥c redline keyword contract in path → no replacement", () => {
  const r = runHook(readPayload(bigText(200), "/project/agents/contract.md"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null);
});

// ⑦ Subagent exemption via agent_id field.
test("⑦ agent_id present → subagent exemption, no replacement", () => {
  const payload = bashPayload(bigText(200));
  payload.agent_id = "subagent-abc-123";
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "subagent should be exempted");
});

// ⑧ Subagent exemption via transcript_path containing /subagents/.
test("⑧ transcript_path contains /subagents/ → exemption", () => {
  const payload = bashPayload(bigText(200));
  payload.transcript_path = "/home/user/.claude/projects/foo/subagents/worker-123.jsonl";
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null);
});

// ⑨ Invalid JSON on stdin → fail-open (exit 0, no output).
test("⑨ invalid JSON stdin → fail-open exit 0 no output", () => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: TEST_SPOOL_DIR };
  const result = spawnSync("node", [HOOK], {
    input: "THIS IS NOT JSON {{{{",
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, "must exit 0 (fail-open)");
  assert.equal(parseHookOutput(result.stdout), null, "no output on parse failure");
});

// ⑩ Write failure → fail-open (use a non-writable spool dir).
test("⑩ write failure → fail-open exit 0 no output", () => {
  // Point CLAUDE_PROJECT_DIR at a path that cannot be created (e.g. under /dev/null/).
  const r = runHook(bashPayload(bigText(200)), {
    CLAUDE_PROJECT_DIR: "/dev/null/impossible-path-xyz",
  });
  assert.equal(r.status, 0, "must exit 0 even if write fails");
  assert.equal(parseHookOutput(r.stdout), null, "no replacement on write failure");
});

// ⑪ Bash with non-empty stderr → summary includes stderr section.
test("⑪ big Bash with stderr → summary preserves stderr content", () => {
  const payload = bashPayload(bigText(200));
  payload.tool_response.stderr = "Error: module not found\nstack trace line 1\nstack trace line 2";

  const r = runHook(payload);
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput);

  const updated = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  // The summary in stdout should include the preserved stderr section.
  assert.ok(updated.stdout.includes("=== STDERR (preserved) ==="), "stderr section present in summary");
  assert.ok(updated.stdout.includes("module not found"), "stderr content visible in summary");
});

// ⑫ Hook stdout is a single valid JSON object (not multiple lines, not malformed).
test("⑫ hook stdout is exactly one valid JSON object", () => {
  const r = runHook(bashPayload(bigText(200)));
  assert.equal(r.status, 0);
  const rawStdout = r.stdout.trim();
  assert.ok(rawStdout.length > 0, "should produce output for big input");

  // Must parse as a single JSON object.
  let parsed;
  try {
    parsed = JSON.parse(rawStdout);
  } catch (e) {
    assert.fail("stdout is not valid JSON: " + e.message);
  }

  // Should not contain multiple JSON objects (no newline-separated JSONL).
  const lines = rawStdout.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, "must be exactly one JSON line");
  assert.ok(parsed.hookSpecificOutput, "top-level hookSpecificOutput present");
});

// ⑬ Glob payload → fail-open (Glob not in matcher; if somehow routed, no replacement).
test("⑬ Glob payload → fail-open, no replacement", () => {
  const payload = {
    session_id: "test-session",
    hook_event_name: "PostToolUse",
    tool_name: "Glob",
    tool_input: { pattern: "**/*.ts", path: "/project" },
    tool_response: {
      filenames: Array.from({ length: 500 }, (_, i) => `/project/src/file${i}.ts`),
    },
    transcript_path: "/home/user/.claude/projects/myproject/transcript.jsonl",
    cwd: TEST_SPOOL_DIR,
    permission_mode: "default",
  };
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  assert.equal(parseHookOutput(r.stdout), null, "Glob must not be spooled (fail-open)");
});

// ⑭ Spool file exists on disk with correct content (file-on-disk verification).
test("⑭ big Bash → spool file exists on disk with full original content", () => {
  const originalText = bigText(200);
  const r = runHook(bashPayload(originalText));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "must have hookSpecificOutput");

  // Extract the spool path from the summary text.
  const updated = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  const summaryText = updated.stdout;
  const match = summaryText.match(/Full output: (.+\.txt)/);
  assert.ok(match, "summary must contain spool file path");
  const spoolPath = match[1];

  assert.ok(existsSync(spoolPath), `spool file must exist at ${spoolPath}`);
  const spooledContent = readFileSync(spoolPath, "utf8");
  assert.equal(spooledContent, originalText, "spool file must contain the full original output");
});

// ⑮ Escape hatch case/whitespace variants: "OFF", " false ", "0" all disable spooling.
test("⑮ WORKER_OUTPUT_SPOOL case/whitespace variants → no replacement", () => {
  for (const val of ["OFF", " false ", "0", " OFF ", "False"]) {
    const r = runHook(bashPayload(bigText(200)), { WORKER_OUTPUT_SPOOL: val });
    assert.equal(r.status, 0, `exit 0 for WORKER_OUTPUT_SPOOL=${JSON.stringify(val)}`);
    assert.equal(
      parseHookOutput(r.stdout),
      null,
      `no replacement for WORKER_OUTPUT_SPOOL=${JSON.stringify(val)}`
    );
  }
});

// ⑯ Degenerate shapes → fail-open, no crash.
test("⑯a Bash with no stdout field → fail-open", () => {
  const payload = bashPayload(bigText(200));
  delete payload.tool_response.stdout;
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  assert.equal(parseHookOutput(r.stdout), null, "no replacement when stdout absent");
});

test("⑯b Read with no file.content → fail-open", () => {
  const payload = readPayload(bigText(200));
  delete payload.tool_response.file.content;
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  assert.equal(parseHookOutput(r.stdout), null, "no replacement when file.content absent");
});

test("⑯c Grep with no content field → fail-open", () => {
  const payload = grepPayload(bigText(200));
  delete payload.tool_response.content;
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  assert.equal(parseHookOutput(r.stdout), null, "no replacement when content absent");
});

// ⑰ Outermost try/catch: degenerate payload with undefined tool_name → fail-open.
// This exercises the unknown-tool branch + outermost catch for runtime surprises.
test("⑰ degenerate payload (no tool_name) → fail-open exit 0", () => {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: TEST_SPOOL_DIR,
  };
  delete env.WORKER_OUTPUT_SPOOL;

  // Payload is structurally valid JSON but missing tool_name — the hook
  // should hit the unknown-tool branch and exit 0 without crashing.
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "x", tool_response: { stdout: bigText(200) } }),
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, "must exit 0 on degenerate payload");
  assert.equal(parseHookOutput(result.stdout), null, "no replacement on degenerate payload");
});

// ── Bug-3: Bash redline check must use .worker-mode/ token match, not any "/" token ──
//
// Before the fix, toolInputPath for Bash returned the first token containing "/",
// so commands like `bash scripts/gate-check.sh` returned "scripts/gate-check.sh"
// which matched REDLINE_KEYWORDS ("gate") → false redline → big output not spooled.
// Worse, any legitimate large output from non-worker-mode Bash commands with paths
// containing redline words was silently skipped.
//
// After the fix: Bash redline only triggers when the command contains a token that
// starts with ".worker-mode/" or contains "/.worker-mode/".

// Bug-3a: `git status` big output → must be spooled (NOT redline)
// git status has no "/" tokens at all → was already not redline, stays not redline.
test("Bug-3a: git status big output → spooled (not redline)", () => {
  const payload = bashPayload(bigText(200), { tool_input: { command: "git status" } });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "git status big output must be spooled, not skipped as redline");
});

// Bug-3b: command with path containing "gate" keyword → must be spooled (NOT redline)
// e.g. `bash scripts/gate-check.sh` previously triggered redline due to "gate" in path.
test("Bug-3b: Bash with scripts/gate-check.sh path → spooled (not redline)", () => {
  const payload = bashPayload(bigText(200), { tool_input: { command: "bash scripts/gate-check.sh" } });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "bash scripts/gate-check.sh must be spooled (not redline); got null");
});

// Bug-3c: `cat .worker-mode/state/current.json` → must NOT be spooled (is redline)
// After fix: .worker-mode/ token still triggers redline correctly.
test("Bug-3c: cat .worker-mode/state/current.json → redline, not spooled", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "cat .worker-mode/state/current.json" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.equal(out, null, "cat .worker-mode/state/current.json must be redline → no spool");
});

// Bug-3d: absolute path to .worker-mode → must still be redline
test("Bug-3d: Bash with absolute /.worker-mode/ path → redline, not spooled", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "node /home/user/project/.worker-mode/state/tool-output/dump.txt" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.equal(out, null, "absolute /.worker-mode/ path must be redline → no spool");
});

// ── Bug-3e: quoted / variable-prefix .worker-mode paths (Batch-A supplement) ──
//
// toolInputPath Bash branch previously only matched unquoted tokens that started
// with ".worker-mode/" or contained "/.worker-mode/". These four shapes were missed:
//   double-quoted:  cat ".worker-mode/state/current.json"
//   single-quoted:  cat '.worker-mode/state/current.json'
//   var-assignment: FILE=.worker-mode/state/x cat "$FILE"
// After the fix, each token is stripped of leading/trailing quotes before matching,
// and includes(".worker-mode/") catches the variable-assignment prefix.

test("Bug-3e-1: double-quoted .worker-mode path → redline, not spooled", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: 'cat ".worker-mode/state/current.json"' },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.equal(out, null, 'cat ".worker-mode/..." must be redline → no spool');
});

test("Bug-3e-2: single-quoted .worker-mode path → redline, not spooled", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "cat '.worker-mode/state/x'" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.equal(out, null, "cat '.worker-mode/...' must be redline → no spool");
});

test("Bug-3e-3: variable-assignment token with .worker-mode path → redline, not spooled", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "FILE=.worker-mode/state/x cat $FILE" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.equal(out, null, "FILE=.worker-mode/... token must be redline → no spool");
});

// Regression guard: Bug-3b must remain unaffected — gate-check.sh is NOT redline.
test("Bug-3e-4: bash scripts/gate-check.sh still NOT redline (Bug-3b regression guard)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "bash scripts/gate-check.sh" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "scripts/gate-check.sh must still be spooled, not redline");
});

// Ordinary git status big output → spooled (regression guard for Bug-3a).
test("Bug-3e-5: git status big output → spooled, not redline (Bug-3a regression guard)", () => {
  const payload = bashPayload(bigText(200), { tool_input: { command: "git status" } });
  const r = runHook(payload);
  assert.equal(r.status, 0, "must exit 0");
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "git status must be spooled, not redline");
});
