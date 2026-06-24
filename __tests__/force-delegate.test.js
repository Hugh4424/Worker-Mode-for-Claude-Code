// force-delegate.test.js — PreToolUse hook unit tests.
// Tests invoke the hook as a subprocess (exactly as Claude Code would),
// pass JSON on stdin, check stdout + exit code.
//
// Convention: "allow" = exit 0 + no JSON output (or output without deny).
//             "deny"  = exit 0 + JSON with permissionDecision=="deny".

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookScript = join(pluginRoot, "hooks", "force-delegate.mjs");

function runHook(payload, extraEnv = {}) {
  // Build env: inherit process.env, but ALWAYS clear WORKER_FORCE_DELEGATE
  // so a parent shell with WORKER_FORCE_DELEGATE=off doesn't silently allow
  // everything. Tests that need it disabled pass it explicitly via extraEnv.
  const baseEnv = { ...process.env };
  delete baseEnv.WORKER_FORCE_DELEGATE;
  const env = { ...baseEnv, ...extraEnv };

  const result = spawnSync("node", [hookScript], {
    input: JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  let parsed = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      // not JSON — treat as no-output (allow)
    }
  }
  return { exitCode: result.status, stdout: result.stdout, parsed };
}

function isAllow({ exitCode, parsed }) {
  if (exitCode !== 0) return false;
  if (!parsed) return true; // no JSON output = allow
  const decision = parsed?.hookSpecificOutput?.permissionDecision;
  return decision !== "deny";
}

function isDeny({ exitCode, parsed }) {
  if (exitCode !== 0) return false;
  return parsed?.hookSpecificOutput?.permissionDecision === "deny";
}

function getDenyReason({ parsed }) {
  return parsed?.hookSpecificOutput?.permissionDecisionReason ?? null;
}

// ── 1. Sub-agent Write → allow ────────────────────────────────────────────────
test("1. sub-agent call (agent_id present) + Write → allow", () => {
  const payload = {
    agent_id: "agent-abc-123",
    tool_name: "Write",
    tool_input: { file_path: "/project/src/foo.ts", content: "export const x = 1;" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow, got: ${JSON.stringify(r.parsed)}`);
});

// ── 2. Main session Write code → deny ────────────────────────────────────────
test("2. main session Write code file → deny + guidance", () => {
  const payload = {
    tool_name: "Write",
    tool_input: { file_path: "/project/src/auth.ts", content: "export function login() {}" },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny, got: ${JSON.stringify(r.parsed)}`);
  const reason = getDenyReason(r);
  assert.ok(reason && reason.length > 10, "deny reason should be non-empty guidance");
  assert.ok(reason.includes("Task") || reason.includes("派"), "reason should mention delegation");
});

// ── 3. Escape valve: semantic-keyword paths → allow ───────────────────────────
test("3a. Write project-state.md (contains 'state') → allow", () => {
  const payload = {
    tool_name: "Write",
    tool_input: { file_path: "/project/project-state.md", content: '{"phase":2}' },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for state path, got: ${JSON.stringify(r.parsed)}`);
});

test("3b. Write foo/journal/x.md (contains 'journal') → allow", () => {
  const payload = {
    tool_name: "Write",
    tool_input: { file_path: "/project/foo/journal/x.md", content: "log entry" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for journal path, got: ${JSON.stringify(r.parsed)}`);
});

test("3c. Write handoff-note.md (contains 'handoff') → allow", () => {
  const payload = {
    tool_name: "Write",
    tool_input: { file_path: "/project/handoff-note.md", content: "phase done" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for handoff file, got: ${JSON.stringify(r.parsed)}`);
});

test("3d. Write design-doc.md (no semantic keyword) → deny", () => {
  const payload = {
    tool_name: "Write",
    tool_input: { file_path: "/project/design-doc.md", content: "# Design" },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for plain md, got: ${JSON.stringify(r.parsed)}`);
});

test("3e. Write README.md (no semantic keyword) → deny", () => {
  const payload = {
    tool_name: "Write",
    tool_input: { file_path: "/project/README.md", content: "# readme" },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for README.md, got: ${JSON.stringify(r.parsed)}`);
});

// ── 4. Main session Edit code → deny ─────────────────────────────────────────
test("4. main session Edit code → deny", () => {
  const payload = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/project/src/server.ts",
      old_string: "const port = 3000",
      new_string: "const port = 8080",
    },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for Edit, got: ${JSON.stringify(r.parsed)}`);
});

// ── 5. Main session Task/Agent → allow ───────────────────────────────────────
test("5a. main session Task → allow (delegation encouraged)", () => {
  const payload = {
    tool_name: "Task",
    tool_input: { description: "implement auth module", prompt: "Write src/auth.ts" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for Task, got: ${JSON.stringify(r.parsed)}`);
});

test("5b. main session Agent → allow", () => {
  const payload = {
    tool_name: "Agent",
    tool_input: { prompt: "run the tests" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for Agent, got: ${JSON.stringify(r.parsed)}`);
});

// ── 6. Main session Read → allow ─────────────────────────────────────────────
test("6. main session Read → allow", () => {
  const payload = {
    tool_name: "Read",
    tool_input: { file_path: "/project/agents/coordinator.md" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for Read, got: ${JSON.stringify(r.parsed)}`);
});

// ── 7. Main session Bash ls → allow ──────────────────────────────────────────
test("7. main session Bash ls -la → allow (light query)", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "ls -la /project/src" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for ls, got: ${JSON.stringify(r.parsed)}`);
});

// ── 8. Main session Bash echo redirect → deny ────────────────────────────────
test("8. main session Bash 'echo x > foo.ts' → deny (file write)", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "echo 'export const x = 1' > src/foo.ts" },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for redirect write, got: ${JSON.stringify(r.parsed)}`);
});

// ── 9. Main session Bash npm test → deny ─────────────────────────────────────
test("9. main session Bash 'npm test' → deny (run tests)", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for npm test, got: ${JSON.stringify(r.parsed)}`);
  const reason = getDenyReason(r);
  assert.ok(reason && reason.includes("测试"), "reason should mention tests");
});

// ── 10. Main session Bash cat → allow ────────────────────────────────────────
test("10. main session Bash 'cat small.txt' → allow (light read)", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "cat package.json" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for cat, got: ${JSON.stringify(r.parsed)}`);
});

// ── 11. WORKER_FORCE_DELEGATE=off → allow everything ────────────────────────
test("11. WORKER_FORCE_DELEGATE=off + main session Write → allow (switch off)", () => {
  const payload = {
    tool_name: "Write",
    tool_input: { file_path: "/project/src/feature.ts", content: "code" },
  };
  const r = runHook(payload, { WORKER_FORCE_DELEGATE: "off" });
  assert.ok(isAllow(r), `expected allow when switch is off, got: ${JSON.stringify(r.parsed)}`);
});

test("11b. WORKER_FORCE_DELEGATE=0 → allow", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/project/x.ts", content: "" } };
  const r = runHook(payload, { WORKER_FORCE_DELEGATE: "0" });
  assert.ok(isAllow(r), "expected allow with WORKER_FORCE_DELEGATE=0");
});

test("11c. WORKER_FORCE_DELEGATE=false → allow", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/project/x.ts", content: "" } };
  const r = runHook(payload, { WORKER_FORCE_DELEGATE: "false" });
  assert.ok(isAllow(r), "expected allow with WORKER_FORCE_DELEGATE=false");
});

// ── 12. Bad payload (non-JSON) → allow (fail-open) ───────────────────────────
test("12. malformed stdin (non-JSON) → allow (fail-open)", () => {
  const result = spawnSync("node", [hookScript], {
    input: "not json at all { broken",
    env: { ...process.env },
    encoding: "utf8",
  });
  // Must exit 0, no crash, no deny output
  assert.equal(result.status, 0, "hook must exit 0 even on bad input");
  const out = result.stdout.trim();
  if (out) {
    const parsed = JSON.parse(out);
    assert.notEqual(
      parsed?.hookSpecificOutput?.permissionDecision,
      "deny",
      "bad payload must not result in deny"
    );
  }
});

// ── 13. Deny output JSON structure is correct ─────────────────────────────────
test("13. deny output has correct hookSpecificOutput structure", () => {
  const payload = {
    tool_name: "Write",
    tool_input: { file_path: "/project/src/impl.ts", content: "code" },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), "should be deny");

  const out = r.parsed;
  assert.ok(out && typeof out === "object", "stdout must be a JSON object");
  assert.ok("hookSpecificOutput" in out, "must have hookSpecificOutput key");

  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, "PreToolUse", "hookEventName must be PreToolUse");
  assert.equal(h.permissionDecision, "deny", "permissionDecision must be 'deny'");
  assert.ok(
    typeof h.permissionDecisionReason === "string" && h.permissionDecisionReason.length > 0,
    "permissionDecisionReason must be a non-empty string"
  );
});

// ── Additional edge cases ─────────────────────────────────────────────────────

test("Bash 'node --test __tests__/foo.test.js' → deny (run tests)", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "node --test __tests__/force-delegate.test.js" },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for node --test, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'git diff' → allow (light git)", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "git diff HEAD" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for git diff, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'git log --oneline' → allow (light git)", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "git log --oneline -10" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for git log, got: ${JSON.stringify(r.parsed)}`);
});

test("MultiEdit code → deny", () => {
  const payload = {
    tool_name: "MultiEdit",
    tool_input: {
      file_path: "/project/src/util.ts",
      edits: [{ old_string: "a", new_string: "b" }],
    },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for MultiEdit, got: ${JSON.stringify(r.parsed)}`);
});

test("sub-agent with empty string agent_id → main session rules apply (Write → deny)", () => {
  const payload = {
    agent_id: "",
    tool_name: "Write",
    tool_input: { file_path: "/project/src/x.ts", content: "code" },
  };
  const r = runHook(payload);
  assert.ok(isDeny(r), `empty agent_id should be treated as main session, got: ${JSON.stringify(r.parsed)}`);
});

test("Grep → allow", () => {
  const payload = {
    tool_name: "Grep",
    tool_input: { pattern: "TODO", path: "/project/src" },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), "Grep should always be allowed");
});

test("TodoWrite → allow", () => {
  const payload = {
    tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "implement auth", status: "pending", priority: "high", id: "1" }] },
  };
  const r = runHook(payload);
  assert.ok(isAllow(r), "TodoWrite should always be allowed");
});

// ── Bypass / boundary cases (blocking issues) ────────────────────────────────

test("Bash 'ls > src/x.ts' → deny (redirect bypassed light-allowlist)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "ls > src/x.ts" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for ls redirect, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'git diff > patch.ts' → deny (redirect on git command)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "git diff > patch.ts" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash heredoc 'cat <<EOF > src/x.ts' → deny", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cat <<EOF > src/x.ts\nhello\nEOF" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for heredoc write, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'echo x | tee src/x.ts' → deny (pipe into tee writes code)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "echo x | tee src/x.ts" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for tee write, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'cat data.txt | tee logs/state.md' → allow (tee to dispatch-output)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cat data.txt | tee logs/state.md" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow: tee to state path, got: ${JSON.stringify(r.parsed)}`);
});

test("Write src/statement.ts → deny (overwide semantic match: 'state' not bounded)", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/project/src/statement.ts", content: "x" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for statement.ts, got: ${JSON.stringify(r.parsed)}`);
});

test("Write src/status.ts → deny (overwide: .ts not a doc extension)", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/project/src/status.ts", content: "x" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for status.ts, got: ${JSON.stringify(r.parsed)}`);
});

test("Write CLAUDE.md → allow (red-line memory file)", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/project/CLAUDE.md", content: "# rules" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for CLAUDE.md, got: ${JSON.stringify(r.parsed)}`);
});

test("Write .claude/memory/foo.md → allow (red-line .claude/ tree)", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/project/.claude/memory/foo.md", content: "x" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for .claude/ path, got: ${JSON.stringify(r.parsed)}`);
});

test("Write notes/progress-log.md → allow (dispatch output: doc ext + bounded keyword)", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/project/notes/progress-log.md", content: "x" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for progress-log.md, got: ${JSON.stringify(r.parsed)}`);
});

test("agent_id:{} (non-string) + Write code → deny (not a real sub-agent)", () => {
  const payload = { agent_id: {}, tool_name: "Write", tool_input: { file_path: "/project/src/x.ts", content: "x" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny: non-string agent_id must not bypass, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'bun test' → deny", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "bun test" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for bun test, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'cargo test' → deny", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cargo test" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for cargo test, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'npm t' → deny (short form npm test)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "npm t" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for npm t, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'node scripts/generate-test-fixtures.js' → allow (not a test runner)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "node scripts/generate-test-fixtures.js" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for generator script, got: ${JSON.stringify(r.parsed)}`);
});

// ── New blocking patterns (dd, inline scripts, cp/mv, curl/wget) ─────────────

test("Bash 'dd if=a of=x.ts' → deny (dd direct write)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "dd if=src.bin of=x.ts" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for dd of=, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'python3 -c ...' → deny (inline script writer)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "python3 -c \"open('x.ts','w').write('code')\"" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for python3 -c, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'node -e ...' → deny (inline script writer)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "node -e \"require('fs').writeFileSync('x.ts','')\"" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for node -e, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'perl -e ...' → deny (inline script writer)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "perl -e 'print 42'" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for perl -e, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'cp src.ts dst.ts' → deny (cp to source code ext)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cp src.ts dst.ts" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for cp .ts, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'cp a.txt b.txt' → allow (pure data file copy, not source code)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cp a.txt b.txt" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for cp .txt, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'mv old.js new.js' → deny (mv source file)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "mv old.js new.js" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for mv .js, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'curl http://x -o x.ts' → deny (curl download to file)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "curl http://example.com -o x.ts" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny for curl -o, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'cat data >| logs/state.md' → allow (>| clobber to dispatch-output, escape valve)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cat data >| logs/state.md" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow: >| to state path triggers escape valve, got: ${JSON.stringify(r.parsed)}`);
});

// ── stderr redirect / /dev/null false-positive fixes ─────────────────────────

test("Bash 'wc -l /a/state.json 2>/dev/null' → allow (stderr redirect, pure read)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "wc -l /a/state.json 2>/dev/null" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'cat foo.md 2>/dev/null' → allow (stderr redirect, pure read)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cat foo.md 2>/dev/null" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'grep x foo 2>&1' → allow (fd dup, pure read)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "grep x foo 2>&1" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'ls -la 2>/dev/null' → allow (stderr to /dev/null, pure read)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "ls -la 2>/dev/null" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'find . -name x 2>/dev/null' → allow (stderr redirect, pure read)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "find . -name x 2>/dev/null" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'cat a 2>/dev/null > foo.ts' → deny (stdout writes code file despite stderr redirect)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "cat a 2>/dev/null > foo.ts" } };
  const r = runHook(payload);
  assert.ok(isDeny(r), `expected deny, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'echo x > /dev/null' → allow (write to device file = no-op)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "echo x > /dev/null" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for /dev/null target, got: ${JSON.stringify(r.parsed)}`);
});

test("Bash 'node x.js 2>/dev/null' → allow (run script with stderr redirect, not node -e)", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "node x.js 2>/dev/null" } };
  const r = runHook(payload);
  assert.ok(isAllow(r), `expected allow for node script with stderr redirect, got: ${JSON.stringify(r.parsed)}`);
});
