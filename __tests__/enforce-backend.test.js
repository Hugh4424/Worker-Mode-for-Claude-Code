// enforce-backend.test.js — unit tests for hooks/enforce-backend.mjs
// Runs via: node --test __tests__/enforce-backend.test.js
//
// Spawns the hook as a child process, feeds hookData via stdin, asserts stdout
// contains the expected permissionDecision.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookPath = join(pluginRoot, "hooks", "enforce-backend.mjs");

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDir;

// We set CLAUDE_PROJECT_DIR so the hook can find the project root for marker
// and enforce-log paths. Each test gets a fresh temp dir.
function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "enforce-backend-test-"));
}

function teardown() {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

function markerPath() {
  return join(tmpDir, ".worker-mode", "state", "omc-failure.marker");
}

function logPath() {
  return join(tmpDir, ".worker-mode", "state", "enforce-log.jsonl");
}

function createMarker() {
  const dir = dirname(markerPath());
  mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath(), "");
}

function readLogEntries() {
  const p = logPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Run the hook with the given hookData as stdin JSON.
 * Returns { stdout, stderr, status }.
 */
function runHook({ hookData = {}, backend = "omc", extraEnv = {} } = {}) {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(hookData),
    encoding: "utf8",
    env: {
      ...process.env,
      WORKER_MODE_BACKEND: backend,
      CLAUDE_PROJECT_DIR: tmpDir,
      ...extraEnv,
    },
  });
  return result;
}

/**
 * parseDecision — strict version.
 * Returns "deny" only when permissionDecision is explicitly "deny".
 * Returns "allow" when output is {} or empty (fail-open).
 * Throws if the hook crashed (non-zero exit).
 */
function parseDecision(result) {
  assert.equal(result.status, 0, "hook must exit 0 (not crash)\nstderr: " + result.stderr);
  const stdout = (result.stdout || "").trim();
  if (!stdout || stdout === "{}") return "allow"; // empty / bare {} = allow
  try {
    const parsed = JSON.parse(stdout);
    // {} with no hookSpecificOutput → allow
    if (!parsed.hookSpecificOutput) return "allow";
    const decision =
      parsed.hookSpecificOutput.permissionDecision || parsed.permissionDecision;
    if (decision === "deny") return "deny";
    // Any explicit non-deny value (including legacy "allow") counts as allow.
    return "allow";
  } catch {
    return "allow"; // parse failure = fail-open allow
  }
}

/**
 * parseRawOutput — returns the parsed JSON object (or null).
 */
function parseRawOutput(result) {
  const stdout = (result.stdout || "").trim();
  if (!stdout) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => setup());
afterEach(() => teardown());

// ── test 1: main session + omc backend + legacy dispatch → deny ───────────────

test("main session, backend=omc, Task dispatch legacy (implementer) → deny (wrong_backend)", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      // no agent_id = main session
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  const decision = parseDecision(result);
  assert.equal(decision, "deny", "should deny: omc backend dispatching legacy agent\nstdout: " + result.stdout);
});

// ── test 2: main session + omc backend + omc dispatch → allow ─────────────────
// Strict: output must be {} (no hookSpecificOutput, no permissionDecision field).

test("main session, backend=omc, Task dispatch oh-my-claudecode:executor → allow (output is {})", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);

  // Must output {} or empty — must NOT contain "deny" or a hookSpecificOutput block.
  const stdout = (result.stdout || "").trim();
  const parsed = parseRawOutput(result);
  assert.ok(
    !parsed || !parsed.hookSpecificOutput,
    `allow output must NOT contain hookSpecificOutput; got: ${stdout}`
  );
  const decision = parseDecision(result);
  assert.equal(decision, "allow", "should allow: omc backend dispatching omc agent\nstdout: " + stdout);
});

// ── test 3: main session + legacy backend + omc dispatch → deny ───────────────

test("main session, backend=legacy, Task dispatch oh-my-claudecode:executor → deny (wrong_backend)", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "legacy",
  });

  const decision = parseDecision(result);
  assert.equal(decision, "deny", "should deny: legacy backend dispatching omc agent\nstdout: " + result.stdout);
});

// ── test 4: subagent (has agent_id) → always allow ────────────────────────────

test("subagent (has agent_id), any dispatch → allow (exempt)", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      agent_id: "agent-abc-123",
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  const decision = parseDecision(result);
  assert.equal(decision, "allow", "subagent with agent_id should be exempt\nstdout: " + result.stdout);
});

// ── test 5: subagent via transcript_path containing /subagents/ → allow ────────

test("subagent (transcript_path contains /subagents/), any dispatch → allow", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/home/user/.claude/subagents/session-abc.jsonl",
    },
    backend: "omc",
  });

  const decision = parseDecision(result);
  assert.equal(decision, "allow", "subagent via transcript_path should be exempt\nstdout: " + result.stdout);
});

// ── test 6: Agent tool (not Task) → same deny behavior ───────────────────────

test("tool_name=Agent (not Task), main session, backend=omc, subagent_type=implementer → deny (dual-name compat)", () => {
  const result = runHook({
    hookData: {
      tool_name: "Agent",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  const decision = parseDecision(result);
  assert.equal(decision, "deny", "Agent tool name should also be intercepted\nstdout: " + result.stdout);
});

// ── test 7: marker + main session + omc backend + legacy dispatch → deny ───────
// Strict: deny reason must be "marker_block" (not just any deny).

test("marker exists + main session + backend=omc + legacy dispatch → deny (marker_block) with reason code", () => {
  createMarker();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  const decision = parseDecision(result);
  assert.equal(decision, "deny", "marker should block legacy dispatch\nstdout: " + result.stdout);

  // Verify deny reason includes "marker_block" in permissionDecisionReason.
  const parsed = parseRawOutput(result);
  const reason = parsed?.hookSpecificOutput?.permissionDecisionReason || "";
  assert.ok(
    reason.includes("marker") || reason.includes("omc-failure"),
    `permissionDecisionReason must reference marker; got: "${reason}"`
  );

  // Verify enforce-log contains a marker_block entry.
  const entries = readLogEntries();
  const markerEntry = entries.find((e) => e.reason === "marker_block");
  assert.ok(markerEntry, "enforce-log must contain a marker_block entry; entries: " + JSON.stringify(entries));
});

// ── test 8: marker + main session + omc backend + omc dispatch → allow ─────────
// Critical: marker must NOT block omc dispatches (no killing omc retries)

test("marker exists + main session + backend=omc + omc dispatch → allow (critical: don't kill omc)", () => {
  createMarker();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  const decision = parseDecision(result);
  assert.equal(decision, "allow", "marker must NOT block omc dispatches\nstdout: " + result.stdout);
});

// ── test 9: bad JSON / missing fields → fail-open allow ────────────────────────

test("hook receives bad JSON → fail-open allow, no crash", () => {
  const result = spawnSync(process.execPath, [hookPath], {
    input: "this is not JSON {{{",
    encoding: "utf8",
    env: {
      ...process.env,
      WORKER_MODE_BACKEND: "omc",
      CLAUDE_PROJECT_DIR: tmpDir,
    },
  });

  assert.equal(result.status, 0, "should exit 0 on bad JSON\nstderr: " + result.stderr);
  const decision = parseDecision(result);
  assert.equal(decision, "allow", "bad JSON → fail-open allow\nstdout: " + result.stdout);
});

// ── test 10: non-Task/Agent tool (e.g., Bash) → allow, no intervention ─────────

test("non-Task/Agent tool (Bash) → allow, no intervention", () => {
  const result = runHook({
    hookData: {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  const decision = parseDecision(result);
  assert.equal(decision, "allow", "Bash tool should not be intercepted\nstdout: " + result.stdout);
});

// ── test 11: startsWith security — spoofed name with omc prefix in middle → deny
// "evil:oh-my-claudecode:executor" must NOT be classified as omc dispatch.

test("spoofed subagent_type 'evil:oh-my-claudecode:executor' → deny (startsWith guard)", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "evil:oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  const decision = parseDecision(result);
  assert.equal(decision, "deny", "spoofed omc prefix in middle must be denied\nstdout: " + result.stdout);
});

// ── test 12: invalid backend "omcc" → fail-safe to omc, legacy dispatch → deny ─

test("invalid backend 'omcc' → fail-safe to omc, legacy dispatch denied, invalid_backend logged", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omcc", // invalid
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  const decision = parseDecision(result);
  assert.equal(decision, "deny", "invalid backend fail-safes to omc → legacy dispatch denied\nstdout: " + result.stdout);

  // enforce-log must have an invalid_backend warning entry.
  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(warnEntry, "enforce-log must contain invalid_backend entry; entries: " + JSON.stringify(entries));
});

// ── test 13: invalid backend "OMC" (uppercase) → fail-safe to omc ──────────────

test("invalid backend 'OMC' (case-sensitive) → fail-safe to omc, invalid_backend logged", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "OMC", // invalid: case-sensitive
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  const decision = parseDecision(result);
  assert.equal(decision, "deny", "OMC (uppercase) is invalid, fail-safe to omc → legacy denied\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(warnEntry, "enforce-log must contain invalid_backend entry for 'OMC'\nentries: " + JSON.stringify(entries));
});

// ── test 14: invalid backend "omc " (trailing space) → fail-safe to omc ────────

test("invalid backend 'omc ' (trailing space, trimmed then invalid) → fail-safe to omc, invalid_backend logged", () => {
  // Note: the hook does trim(), so "omc " after trim() becomes "omc" — which IS valid.
  // The spec says trim first then validate, so "omc " with space should actually be valid
  // after trim. We test with "omc\t" (tab) which after trim is "omc" too... Instead
  // test a value that stays invalid after trim: " omc " becomes "omc" (valid) but
  // "omc x" stays "omc x" (invalid). Use "omc x" to cover non-trimmable invalid case,
  // and separately verify trim works with " omc ".
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    extraEnv: { WORKER_MODE_BACKEND: "omc x" }, // invalid after trim
    backend: "omc", // overridden by extraEnv
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  // "omc x" is invalid → fail-safe to omc → legacy dispatch denied
  const decision = parseDecision(result);
  assert.equal(decision, "deny", "'omc x' is invalid backend, fail-safe to omc, legacy denied\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(warnEntry, "enforce-log must have invalid_backend for 'omc x'");
});

// ── test 15: " omc " (spaces around valid value) → valid after trim, legacy denied ─

test("backend ' omc ' (spaces) → valid after trim (omc), legacy dispatch denied, no invalid_backend log", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    extraEnv: { WORKER_MODE_BACKEND: " omc " }, // valid after trim
    backend: "omc",
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  const decision = parseDecision(result);
  assert.equal(decision, "deny", "' omc ' trims to 'omc', legacy dispatch should be denied\nstdout: " + result.stdout);

  // Must NOT have logged invalid_backend (it's valid after trim).
  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(!warnEntry, "no invalid_backend log for ' omc ' (valid after trim)");
});

// ── test 16: env WORKER_MODE_BACKEND unset → legal default omc, no invalid_backend ─
// (阻塞3: empty/unset env is the legal default, must NOT be treated as invalid)

test("WORKER_MODE_BACKEND unset (deleted) → legal default omc, omc dispatch allowed, no invalid_backend log", () => {
  // Run hook with WORKER_MODE_BACKEND explicitly deleted from env
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    }),
    encoding: "utf8",
    env: (() => {
      const e = { ...process.env, CLAUDE_PROJECT_DIR: tmpDir };
      delete e.WORKER_MODE_BACKEND; // explicitly unset
      return e;
    })(),
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  const decision = parseDecision(result);
  assert.equal(decision, "allow", "unset env → default omc → omc dispatch allowed\nstdout: " + result.stdout);

  // Must NOT have logged invalid_backend (unset env is the legal default).
  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(!warnEntry, "no invalid_backend log when WORKER_MODE_BACKEND is unset; entries: " + JSON.stringify(entries));
});

// ── test 17: env WORKER_MODE_BACKEND="" (empty string) → legal default omc, no invalid_backend ─

test("WORKER_MODE_BACKEND='' (empty string) → legal default omc, no invalid_backend log", () => {
  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    extraEnv: { WORKER_MODE_BACKEND: "" }, // empty string
    backend: "", // override runHook's default "omc"
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  const decision = parseDecision(result);
  assert.equal(decision, "allow", "empty env → default omc → omc dispatch allowed\nstdout: " + result.stdout);

  // Must NOT have logged invalid_backend.
  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(!warnEntry, "no invalid_backend log for empty WORKER_MODE_BACKEND; entries: " + JSON.stringify(entries));
});
