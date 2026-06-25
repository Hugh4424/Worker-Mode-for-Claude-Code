// enforce-backend.test.js — unit tests for hooks/enforce-backend.mjs
// Runs via: node --test __tests__/enforce-backend.test.js
//
// Spawns the hook as a child process, feeds hookData via stdin, asserts stdout
// contains the expected permissionDecision.
//
// HERMETIC: Every test controls its own environment via:
//   - CLAUDE_PROJECT_DIR → tmpDir (fresh per test, no real project state leaks)
//   - OMC_PROBE_HOME     → fake home dir (no real ~/.claude ever read)
//   - WORKER_MODE_BACKEND → explicit in each test
//
// No test reads from the real HOME or inherits real OMC installation state.
// Each "environment type" (plugin / bare / not-installed) is constructed
// synthetically in tmpDir so tests pass on any machine regardless of OMC setup.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookPath = join(pluginRoot, "hooks", "enforce-backend.mjs");

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "enforce-backend-test-"));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

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

// ── fake environment builders ─────────────────────────────────────────────────

/**
 * Create a fake home directory with installed_plugins.json → plugin env.
 * Returns the fakeHome path.
 */
function makePluginHome(installPath = "/fake/omc-install") {
  const fakeHome = join(tmpDir, "plugin-home");
  const pluginsDir = join(fakeHome, ".claude", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "oh-my-claudecode@omc": [
          { scope: "user", installPath, version: "1.0.0" },
        ],
      },
    })
  );
  return fakeHome;
}

/**
 * Create a fake home directory with ≥2 OMC signal files in .claude/agents/ → bare-name env.
 * Returns the fakeHome path.
 */
function makeBareHome(signalFiles = ["executor.md", "explore.md"]) {
  const fakeHome = join(tmpDir, "bare-home");
  const agentsDir = join(fakeHome, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const f of signalFiles) {
    writeFileSync(join(agentsDir, f), `# ${f}`);
  }
  return fakeHome;
}

/**
 * Create an empty fake home directory → OMC not-installed env.
 * Returns the fakeHome path.
 */
function makeEmptyHome() {
  const fakeHome = join(tmpDir, "empty-home");
  mkdirSync(fakeHome, { recursive: true });
  return fakeHome;
}

/**
 * Run the hook with the given hookData as stdin JSON.
 * ALWAYS supplies OMC_PROBE_HOME so the hook never reads the real ~/.claude.
 * Returns { stdout, stderr, status }.
 */
function runHook({ hookData = {}, backend = "omc", fakeHome, extraEnv = {} } = {}) {
  // Require callers to explicitly supply a fakeHome to prevent accidental
  // real-HOME reads. Tests that don't supply one get an empty home (not-installed).
  const resolvedFakeHome = fakeHome || makeEmptyHome();

  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(hookData),
    encoding: "utf8",
    env: {
      // Start from a CLEAN env — NOT process.env — to ensure hermetic isolation.
      // Only supply what the hook needs.
      PATH: process.env.PATH, // needed for node to find itself
      HOME: resolvedFakeHome,
      WORKER_MODE_BACKEND: backend,
      CLAUDE_PROJECT_DIR: tmpDir,
      OMC_PROBE_HOME: resolvedFakeHome,
      ...extraEnv,
    },
  });
  return result;
}

/**
 * parseDecision — strict version.
 * Returns "deny" only when permissionDecision is explicitly "deny".
 * Returns "allow" when output is {} or empty (fail-open).
 * Asserts hook exited 0 (no crash).
 */
function parseDecision(result) {
  assert.equal(result.status, 0, "hook must exit 0 (not crash)\nstderr: " + result.stderr);
  const stdout = (result.stdout || "").trim();
  if (!stdout || stdout === "{}") return "allow";
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.hookSpecificOutput) return "allow";
    const decision =
      parsed.hookSpecificOutput.permissionDecision || parsed.permissionDecision;
    if (decision === "deny") return "deny";
    return "allow";
  } catch {
    return "allow"; // parse failure = fail-open allow
  }
}

/** parseRawOutput — returns the parsed JSON object (or null). */
function parseRawOutput(result) {
  const stdout = (result.stdout || "").trim();
  if (!stdout) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}

/** Extract the deny reason from enforce-log.jsonl. */
function getDenyReason() {
  const entries = readLogEntries();
  const deny = entries.find((e) => e.decision === "deny");
  return deny?.reason || null;
}

// ── test 1: plugin env, omc backend, legacy dispatch → deny (wrong_backend) ──

test("plugin env, backend=omc, Task dispatch legacy (implementer) → deny reason=wrong_backend", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(parseDecision(result), "deny",
    "plugin env: omc backend dispatching legacy agent must be denied\nstdout: " + result.stdout);

  // Lock the specific deny reason.
  const entries = readLogEntries();
  const denyEntry = entries.find((e) => e.decision === "deny");
  assert.ok(denyEntry, "enforce-log must have a deny entry; entries: " + JSON.stringify(entries));
  assert.equal(denyEntry.reason, "wrong_backend",
    "deny reason must be 'wrong_backend'; got: " + denyEntry.reason);
});

// ── test 2: plugin env, omc backend, omc dispatch → allow ────────────────────

test("plugin env, backend=omc, Task dispatch oh-my-claudecode:executor → allow", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  const parsed = parseRawOutput(result);
  assert.ok(!parsed || !parsed.hookSpecificOutput,
    "allow output must NOT contain hookSpecificOutput; got: " + result.stdout);
  assert.equal(parseDecision(result), "allow",
    "plugin env: omc dispatch must be allowed\nstdout: " + result.stdout);
});

// ── test 3: plugin env, legacy backend, omc dispatch → deny (wrong_backend) ──

test("plugin env, backend=legacy, Task dispatch oh-my-claudecode:executor → deny reason=wrong_backend", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "legacy",
    fakeHome,
  });

  assert.equal(parseDecision(result), "deny",
    "legacy backend must deny omc dispatch\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const denyEntry = entries.find((e) => e.decision === "deny");
  assert.ok(denyEntry, "must have deny entry");
  assert.equal(denyEntry.reason, "wrong_backend");
});

// ── test 4: subagent (has agent_id) → always allow ────────────────────────────

test("subagent (has agent_id), any dispatch → allow (exempt)", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      agent_id: "agent-abc-123",
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(parseDecision(result), "allow",
    "subagent with agent_id should be exempt\nstdout: " + result.stdout);
});

// ── test 5: subagent via transcript_path /subagents/ → allow ─────────────────

test("subagent (transcript_path contains /subagents/) → allow (exempt)", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/home/user/.claude/subagents/session-abc.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(parseDecision(result), "allow",
    "subagent via transcript_path should be exempt\nstdout: " + result.stdout);
});

// ── test 6: Agent tool (not Task) → same deny behavior ───────────────────────

test("tool_name=Agent, backend=omc, subagent_type=implementer → deny (dual-name compat)", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Agent",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(parseDecision(result), "deny",
    "Agent tool name should also be intercepted\nstdout: " + result.stdout);
});

// ── test 7: marker + legacy dispatch → deny reason=marker_block ───────────────

test("marker exists + backend=omc + legacy dispatch → deny reason=marker_block", () => {
  const fakeHome = makePluginHome();
  createMarker();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "marker should block legacy dispatch\nstdout: " + result.stdout);

  // Lock specific deny reason in log.
  const entries = readLogEntries();
  const markerEntry = entries.find((e) => e.reason === "marker_block");
  assert.ok(markerEntry, "enforce-log must contain a marker_block entry; entries: " + JSON.stringify(entries));

  // Deny message must reference marker.
  const parsed = parseRawOutput(result);
  const reason = parsed?.hookSpecificOutput?.permissionDecisionReason || "";
  assert.ok(
    reason.includes("marker") || reason.includes("omc-failure"),
    `permissionDecisionReason must reference marker; got: "${reason}"`
  );
});

// ── test 8: marker + omc dispatch → allow (critical: don't kill omc retries) ─

test("marker exists + backend=omc + omc dispatch → allow (marker must NOT block omc)", () => {
  const fakeHome = makePluginHome();
  createMarker();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(parseDecision(result), "allow",
    "marker must NOT block omc dispatches\nstdout: " + result.stdout);
});

// ── test 9: bad JSON → fail-open allow ────────────────────────────────────────

test("hook receives bad JSON → fail-open allow, no crash", () => {
  const fakeHome = makeEmptyHome();

  const result = spawnSync(process.execPath, [hookPath], {
    input: "this is not JSON {{{",
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: fakeHome,
      WORKER_MODE_BACKEND: "omc",
      CLAUDE_PROJECT_DIR: tmpDir,
      OMC_PROBE_HOME: fakeHome,
    },
  });

  assert.equal(result.status, 0, "should exit 0 on bad JSON\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "allow",
    "bad JSON → fail-open allow\nstdout: " + result.stdout);
});

// ── test 10: non-Task/Agent tool (Bash) → allow ───────────────────────────────

test("non-Task/Agent tool (Bash) → allow, no intervention", () => {
  const result = runHook({
    hookData: {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
  });

  assert.equal(parseDecision(result), "allow",
    "Bash tool should not be intercepted\nstdout: " + result.stdout);
});

// ── test 11: spoofed name 'evil:oh-my-claudecode:executor' → unknown → allow ──
// Security fix: classifyAgentBackend no longer uses lastIndexOf(":") to extract base name.
// Any subagentType containing ":" but NOT starting with the known omcPrefix → "unknown".
// "evil:oh-my-claudecode:executor" does not start with "oh-my-claudecode:" → unknown → allow (fail-open).
// enforce-backend logs unknown_agent_allow and passes through without deny.
// This is the correct behaviour: the SDK validates actual agent names; we block wrong-backend
// dispatches, not arbitrary strings from unknown namespaces.

test("plugin env, backend=omc, 'evil:oh-my-claudecode:executor' → unknown → allow (namespace bypass blocked at classify)", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "evil:oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  // Must not crash.
  assert.equal(result.status, 0, "hook must not crash on spoofed name\nstderr: " + result.stderr);
  // classifyAgentBackend("evil:oh-my-claudecode:executor", "oh-my-claudecode:") → "unknown"
  // enforce-backend: unknown → fail-open allow.
  assert.equal(parseDecision(result), "allow",
    "evil: prefix → unknown classification → fail-open allow; got: " + result.stdout);
});

// ── test 12: invalid backend "omcc" → fail-safe to omc, invalid_backend logged ─

test("invalid backend 'omcc' → fail-safe to omc, legacy dispatch denied, invalid_backend logged", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    fakeHome,
    extraEnv: { WORKER_MODE_BACKEND: "omcc" },
    backend: "omcc",
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "invalid backend fail-safes to omc → legacy dispatch denied\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(warnEntry, "enforce-log must contain invalid_backend entry; entries: " + JSON.stringify(entries));
});

// ── test 13: invalid backend "OMC" (uppercase) → fail-safe, invalid_backend ────

test("invalid backend 'OMC' (case-sensitive) → fail-safe to omc, invalid_backend logged", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    fakeHome,
    extraEnv: { WORKER_MODE_BACKEND: "OMC" },
    backend: "OMC",
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "OMC (uppercase) is invalid, fail-safe to omc → legacy denied\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(warnEntry, "enforce-log must contain invalid_backend entry for 'OMC'\nentries: " + JSON.stringify(entries));
});

// ── test 14: invalid backend "omc x" → fail-safe, invalid_backend logged ───────

test("invalid backend 'omc x' (not-trimmable invalid) → fail-safe to omc, invalid_backend logged", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    fakeHome,
    extraEnv: { WORKER_MODE_BACKEND: "omc x" },
    backend: "omc x",
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "'omc x' is invalid backend, fail-safe to omc, legacy denied\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(warnEntry, "enforce-log must have invalid_backend for 'omc x'");
});

// ── test 15: " omc " (trimmed valid) → legacy denied, no invalid_backend ────────

test("backend ' omc ' (spaces) → valid after trim, legacy denied, no invalid_backend log", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    fakeHome,
    extraEnv: { WORKER_MODE_BACKEND: " omc " },
    backend: " omc ",
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "' omc ' trims to 'omc', legacy dispatch should be denied\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(!warnEntry, "no invalid_backend log for ' omc ' (valid after trim)");
});

// ── test 16: WORKER_MODE_BACKEND unset → default omc, omc dispatch allowed ────

test("WORKER_MODE_BACKEND unset → legal default omc, omc dispatch allowed, no invalid_backend log", () => {
  const fakeHome = makePluginHome();

  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    }),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: fakeHome,
      CLAUDE_PROJECT_DIR: tmpDir,
      OMC_PROBE_HOME: fakeHome,
      // WORKER_MODE_BACKEND intentionally absent (deleted)
    },
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "allow",
    "unset env → default omc → omc dispatch allowed\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(!warnEntry, "no invalid_backend log when WORKER_MODE_BACKEND is unset; entries: " + JSON.stringify(entries));
});

// ── test 17: WORKER_MODE_BACKEND="" → default omc, no invalid_backend ──────────

test("WORKER_MODE_BACKEND='' (empty string) → legal default omc, no invalid_backend log", () => {
  const fakeHome = makePluginHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    fakeHome,
    extraEnv: { WORKER_MODE_BACKEND: "" },
    backend: "",
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "allow",
    "empty env → default omc → omc dispatch allowed\nstdout: " + result.stdout);

  const entries = readLogEntries();
  const warnEntry = entries.find((e) => e.reason === "invalid_backend");
  assert.ok(!warnEntry, "no invalid_backend log for empty WORKER_MODE_BACKEND; entries: " + JSON.stringify(entries));
});

// ── test 18: bare-name env (single file) → NOT bare-name, still not-installed ──
// 裸名安装要求 ≥2 个 OMC 特征文件。单个 executor.md 不满足，退化到 not-installed。
// Backend=omc + not-installed → deny reason=omc_not_installed (证明单文件不触发裸名)。

test("bare-name env: single executor.md → NOT bare-name (threshold=2), backend=omc → deny omc_not_installed", () => {
  const fakeHome = join(tmpDir, "single-file-home");
  mkdirSync(join(fakeHome, ".claude", "agents"), { recursive: true });
  writeFileSync(join(fakeHome, ".claude", "agents", "executor.md"), "# executor"); // only ONE signal file

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "executor" }, // bare omc name
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "single signal file: not bare-name, falls through to not-installed → deny\nstdout: " + result.stdout);

  // Deny reason must be omc_not_installed (not wrong_backend, not bare_name_env_skip).
  const entries = readLogEntries();
  const denyEntry = entries.find((e) => e.decision === "deny");
  assert.ok(denyEntry, "must have deny entry");
  assert.equal(denyEntry.reason, "omc_not_installed",
    "single file must not trigger bare-name; reason must be omc_not_installed; got: " + denyEntry.reason);
});

// ── test 19: bare-name env (2 files), backend=omc, legacy dispatch → deny ─────
// 核心新测试：裸名环境下，legacy 基名(implementer)被 classifyAgentBackend 识别为 legacy。
// Backend=omc → deny reason=wrong_backend (证明裸名不再 allow-all，真能拦)。

test("bare-name env (2 signal files), backend=omc, legacy dispatch (implementer) → deny reason=wrong_backend", () => {
  const fakeHome = makeBareHome(["executor.md", "explore.md"]); // ≥2 signal files → bare-name

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" }, // known legacy base name
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "bare-name env: omc backend + legacy agent must be denied (no more allow-all)\nstdout: " + result.stdout);

  // Lock specific reason: wrong_backend (not omc_not_installed, not bare_name_env_skip).
  const entries = readLogEntries();
  const denyEntry = entries.find((e) => e.decision === "deny");
  assert.ok(denyEntry, "must have deny entry; entries: " + JSON.stringify(entries));
  assert.equal(denyEntry.reason, "wrong_backend",
    "bare-name env deny reason must be 'wrong_backend'; got: " + denyEntry.reason);
});

// ── test 20: bare-name env, backend=omc, omc dispatch (executor) → allow ────────
// 裸名 OMC 正常放行：executor 在 OMC 基名清单里，backend=omc → allow。

test("bare-name env (2 signal files), backend=omc, omc dispatch (executor) → allow", () => {
  const fakeHome = makeBareHome(["executor.md", "explore.md"]);

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "executor" }, // known omc base name (bare)
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "allow",
    "bare-name env: omc agent (executor) must be allowed\nstdout: " + result.stdout);
});

// ── test 21: bare-name env, marker + legacy dispatch → deny reason=wrong_backend ─
// 裸名 omc 失败降级 legacy 也要被 marker 检查正确执行（marker 在分类后检查）。

test("bare-name env + marker + legacy dispatch → deny (marker_block takes precedence)", () => {
  const fakeHome = makeBareHome(["executor.md", "explore.md"]);
  createMarker();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "implementer" }, // legacy name
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "bare-name env with marker: legacy dispatch must be denied\nstdout: " + result.stdout);

  // marker_block is checked BEFORE wrong_backend in enforce-backend.mjs execution order.
  // When marker exists + wantsLegacy + backend !== "legacy", marker_block fires first.
  const entries = readLogEntries();
  const denyEntry = entries.find((e) => e.decision === "deny");
  assert.ok(denyEntry, "must have deny entry; entries: " + JSON.stringify(entries));
  assert.equal(denyEntry.reason, "marker_block",
    "bare-name env + marker: deny reason must be 'marker_block' (fires before wrong_backend); got: " + denyEntry.reason);
});

// ── test 22: not-installed env → backend=omc → deny reason=omc_not_installed ───

test("not-installed env (empty home) + backend=omc → deny reason=omc_not_installed with install hint", () => {
  const fakeHome = makeEmptyHome();

  const result = runHook({
    hookData: {
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-claudecode:executor" },
      transcript_path: "/tmp/session-main.jsonl",
    },
    backend: "omc",
    fakeHome,
  });

  assert.equal(result.status, 0, "hook must not crash\nstderr: " + result.stderr);
  assert.equal(parseDecision(result), "deny",
    "OMC not installed + omc backend → deny\nstdout: " + result.stdout);

  // Lock specific reason in log.
  const entries = readLogEntries();
  const denyEntry = entries.find((e) => e.decision === "deny");
  assert.ok(denyEntry, "must have deny entry; entries: " + JSON.stringify(entries));
  assert.equal(denyEntry.reason, "omc_not_installed",
    "deny reason must be 'omc_not_installed'; got: " + denyEntry.reason);

  // Deny message must contain install hint.
  const parsed = parseRawOutput(result);
  const reason = parsed?.hookSpecificOutput?.permissionDecisionReason || "";
  assert.ok(
    reason.includes("安装") || reason.includes("install") || reason.includes("omc_not_installed"),
    `deny message must contain install hint; got: "${reason}"`
  );
});
