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

  const updated = out.hookSpecificOutput.updatedToolOutput;
  // updatedToolOutput is now the raw object (not JSON-stringified)
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

  const updated = out.hookSpecificOutput.updatedToolOutput;
  // updatedToolOutput is now the raw object (not JSON-stringified)
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

  const updated = out.hookSpecificOutput.updatedToolOutput;
  // updatedToolOutput is now the raw object (not JSON-stringified)
  assert.ok(updated.content.includes("[spool-tool-output:"), "content replaced");
  assert.equal(updated.numFiles, 5, "numFiles preserved");
  assert.deepEqual(updated.filenames, ["a.ts", "b.ts"], "filenames preserved");
});

// ⑥ Redline paths (.worker-mode/ directory segment, regex-based) → no replacement.
test("⑥a redline path .worker-mode/state/current.json → no replacement", () => {
  // Exempt via .worker-mode directory-segment regex, not keyword.
  const r = runHook(readPayload(bigText(200), "/project/.worker-mode/state/current.json"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "redline path must not be spooled");
});

test("⑥b redline path .worker-mode → no replacement", () => {
  const r = runHook(readPayload(bigText(200), "/project/.worker-mode/state/something.md"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null);
});

// contract.md is NO LONGER redline — keyword model replaced by directory-segment regex.
test("⑥c contract.md no longer redline → spooled", () => {
  const r = runHook(readPayload(bigText(200), "/project/agents/contract.md"));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "contract.md must now be spooled (keyword model removed)");
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

  const updated = out.hookSpecificOutput.updatedToolOutput;
  // updatedToolOutput is now the raw object (not JSON-stringified)
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
  const updated = out.hookSpecificOutput.updatedToolOutput;
  // updatedToolOutput is now the raw object (not JSON-stringified)
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
// B2 refactor: isRedlinePath now uses a directory-segment regex — Bash token
// extraction unchanged; the regex replaces the keyword-based isRedlinePath.

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

// ══════════════════════════════════════════════════════════════════════════════════
// Bug-5: updatedToolOutput must be an OBJECT matching Claude Code schema,
// not a JSON string. (CC rejects strings: "expected object, received string".)
// ══════════════════════════════════════════════════════════════════════════════════
test("Bug-5a: updatedToolOutput is an object, not a string (Bash)", () => {
  const r = runHook(bashPayload(bigText(200)));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "must have hookSpecificOutput");

  const uto = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof uto, "object", "updatedToolOutput must be an object, not a string");

  // It must parse as the tool response shape — no double-parse needed
  assert.ok(typeof uto.stdout === "string", "stdout must be a string");
  assert.ok(uto.stdout.includes("[spool-tool-output:"), "stdout should be summary");
});

test("Bug-5b: updatedToolOutput is an object, not a string (Read)", () => {
  const r = runHook(readPayload(bigText(200)));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput);

  const uto = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof uto, "object", "updatedToolOutput must be an object, not a string");

  assert.ok(typeof uto.file === "object", "file field present");
  assert.ok(uto.file.content.includes("[spool-tool-output:"), "content replaced");
});

test("Bug-5c: updatedToolOutput is an object, not a string (Grep)", () => {
  const r = runHook(grepPayload(bigText(200)));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput);

  const uto = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof uto, "object", "updatedToolOutput must be an object, not a string");

  assert.ok(typeof uto.content === "string", "content must be a string");
  assert.ok(uto.content.includes("[spool-tool-output:"), "content replaced");
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

// ══════════════════════════════════════════════════════════════════════════════════
// B2: Directory-segment boundary tests for isRedlinePath regex
// (.worker-mode must be a full directory segment, not part of a longer name)
// ══════════════════════════════════════════════════════════════════════════════════

// ── B2-NOT: paths that should be SPOOLED (keyword model would have exempted) ──

test("B2-NOT-1: Read /src/state-manager.ts → spooled", () => {
  // "state" was a keyword, now not exempt — .worker-mode/ not in path.
  const r = runHook(readPayload(bigText(200), "/src/state-manager.ts"));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "/src/state-manager.ts must be spooled");
});

test("B2-NOT-2: Read /docs/progress-report.md → spooled", () => {
  // "progress" was a keyword, now not exempt.
  const r = runHook(readPayload(bigText(200), "/docs/progress-report.md"));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "/docs/progress-report.md must be spooled");
});

test("B2-NOT-3: Grep path=/docs/reviews/ → spooled", () => {
  // "reviews" was a keyword, now not exempt.
  const r = runHook(grepPayload(bigText(200), "/docs/reviews/"));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "Grep /docs/reviews/ must be spooled");
});

test("B2-NOT-4: Read /scripts/gate-check.sh → spooled", () => {
  // "gate" was a keyword, now not exempt.
  const r = runHook(readPayload(bigText(200), "/scripts/gate-check.sh"));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, "/scripts/gate-check.sh must be spooled");
});

test("B2-NOT-5: Read .worker-mode-backup/x.md → spooled", () => {
  // .worker-mode-backup is NOT a directory segment match — regex requires / before/after.
  const r = runHook(readPayload(bigText(200), "/tmp/foo.worker-mode-backup/x.md"));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, ".worker-mode-backup must be spooled (not a dir segment)");
});

test("B2-NOT-6: Read .worker-mode-old/x.md → spooled", () => {
  // .worker-mode-old is NOT a directory segment match.
  const r = runHook(readPayload(bigText(200), "/tmp/.worker-mode-old/x.md"));
  assert.equal(r.status, 0);
  const out = parseHookOutput(r.stdout);
  assert.ok(out && out.hookSpecificOutput, ".worker-mode-old must be spooled (not a dir segment)");
});

// ── B2-EXEMPT: paths that should NOT be spooled (redline) ──

test("B2-EXEMPT-1: Read /project/.worker-mode/state/current.json → not spooled", () => {
  const r = runHook(readPayload(bigText(200), "/project/.worker-mode/state/current.json"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, ".worker-mode/state/current.json must be redline");
});

test("B2-EXEMPT-2: Read .worker-mode/state/artifacts.jsonl → not spooled", () => {
  const r = runHook(readPayload(bigText(200), ".worker-mode/state/artifacts.jsonl"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, ".worker-mode/state/artifacts.jsonl must be redline");
});

test("B2-EXEMPT-3: Read .worker-mode/state/findings/x.md → not spooled", () => {
  const r = runHook(readPayload(bigText(200), ".worker-mode/state/findings/x.md"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, ".worker-mode/state/findings/x.md must be redline");
});

test("B2-EXEMPT-4: Grep path=.worker-mode/state/ → not spooled", () => {
  const r = runHook(grepPayload(bigText(200), ".worker-mode/state/"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "Grep .worker-mode/state/ must be redline");
});

test("B2-EXEMPT-5: Bash FILE=.worker-mode/state/x → not spooled", () => {
  // Env-assignment token still matched via = boundary in regex.
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "FILE=.worker-mode/state/x cat $FILE" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "FILE=.worker-mode/state/x must be redline");
});

// ══════════════════════════════════════════════════════════════════════════════════
// Codex 二审 Blocking 1: quoted env assignment漏豁免
// FILE="..." 内部引号导致不再命中 regex，被错误 spool。
// 修法: 规范化 token 时把内部引号也去掉。
// ══════════════════════════════════════════════════════════════════════════════════

test("Blocking1-a: FILE=\".worker-mode/state/x\" cat \"$FILE\" → not spooled", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: 'FILE=".worker-mode/state/x" cat "$FILE"' },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "FILE=\"...\" must be redline → no spool");
});

test("Blocking1-b: FILE='.worker-mode/state/x' cat \"$FILE\" → not spooled", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "FILE='.worker-mode/state/x' cat \"$FILE\"" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "FILE='...' must be redline → no spool");
});

// ══════════════════════════════════════════════════════════════════════════════════
// Codex 二审 Blocking 2: 方向反转 — 撤负向过滤，宽松匹配
// 这些场景在宽松匹配下会被豁免（不 spool）—— 接受的已知误豁免。
// 宁可误豁免（损失少量 spool 覆盖率），不可漏豁免（截断工头状态读取）。
// ══════════════════════════════════════════════════════════════════════════════════

test("Blocking2-a: grep \".worker-mode/state\" /tmp/log.txt → exempt (not spooled)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: 'grep ".worker-mode/state" /tmp/log.txt' },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "grep .worker-mode/ pattern → exempt under loose match");
});

test("Blocking2-b: echo \".worker-mode/state/x\" → exempt (not spooled)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: 'echo ".worker-mode/state/x"' },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "echo .worker-mode/ text → exempt under loose match");
});

test("Blocking2-c: curl https://example.com/.worker-mode/state/x → exempt (not spooled)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "curl https://example.com/.worker-mode/state/x" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "curl URL with .worker-mode/ → exempt under loose match");
});

test("Blocking2-d: command with # .worker-mode/state/x comment → exempt (not spooled)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "cat /tmp/log.txt # .worker-mode/state/x" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "comment with .worker-mode/ → exempt under loose match");
});

// ══════════════════════════════════════════════════════════════════════════════════
// Codex 三审: 负向过滤导致的漏豁免 — 宽松匹配修复
// 这些命令之前被负向过滤误伤（echo/grep/rg 命令名识别跳过 operand），
// 导致 .worker-mode/ 路径被错误 spool。宽松匹配下应豁免。
// ══════════════════════════════════════════════════════════════════════════════════

test("Codex3-a: echo ok && cat .worker-mode/state/x → exempt (not spooled)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "echo ok && cat .worker-mode/state/x" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "echo ok && cat .worker-mode/state/x must be redline");
});

test("Codex3-b: grep -e TODO .worker-mode/state/x → exempt (not spooled)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "grep -e TODO .worker-mode/state/x" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "grep -e TODO .worker-mode/state/x must be redline");
});

test("Codex3-c: grep --regexp=TODO .worker-mode/state/x → exempt (not spooled)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "grep --regexp=TODO .worker-mode/state/x" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "grep --regexp=TODO .worker-mode/state/x must be redline");
});

test("Codex3-d: rg -e TODO .worker-mode/state/x → exempt (not spooled)", () => {
  const payload = bashPayload(bigText(200), {
    tool_input: { command: "rg -e TODO .worker-mode/state/x" },
  });
  const r = runHook(payload);
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "rg -e TODO .worker-mode/state/x must be redline");
});

// ══════════════════════════════════════════════════════════════════════════════════
// Codex 二审 Blocking 3: 补豁免边界测试（确认 regex 目录段匹配正确）
// ══════════════════════════════════════════════════════════════════════════════════

test("Blocking3-a: Read /a/.worker-mode/b → not spooled", () => {
  const r = runHook(readPayload(bigText(200), "/a/.worker-mode/b"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "/a/.worker-mode/b must be redline");
});

test("Blocking3-b: Read /a/.worker-mode (结尾无斜杠) → not spooled", () => {
  const r = runHook(readPayload(bigText(200), "/a/.worker-mode"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "/a/.worker-mode must be redline");
});

test("Blocking3-c: Read ./.worker-mode/state/current.json → not spooled", () => {
  const r = runHook(readPayload(bigText(200), "./.worker-mode/state/current.json"));
  assert.equal(r.status, 0);
  assert.equal(parseHookOutput(r.stdout), null, "./.worker-mode/state/current.json must be redline");
});
