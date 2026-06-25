// resolve-omc-prefix.test.js — unit tests for tools/lib/resolve-omc-prefix.mjs
// Runs via: node --test __tests__/resolve-omc-prefix.test.js
//
// Constructs synthetic filesystem structures in a temp directory to test all
// four detection scenarios without touching the real HOME or cwd.
//
// Bare-name detection threshold: ≥2 OMC signal files must co-exist.
// A single matching file does NOT trigger bare-name mode (prevents false positives
// from user-created files like executor.md).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveOmcPrefix, classifyAgentBackend } from "../tools/lib/resolve-omc-prefix.mjs";

let root; // temp dir root for each test

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omc-prefix-test-"));
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDir(...parts) {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

function touch(filePath) {
  writeFileSync(filePath, "");
}

function fakeHome() {
  return join(root, "home");
}

function fakeCwd() {
  return join(root, "cwd");
}

// ── test 1: project-bare requires ≥2 signal files (single file NOT enough) ───

test("project-bare: single executor.md alone → NOT project-bare (threshold=2)", () => {
  const agentsDir = makeDir("cwd", ".claude", "agents");
  touch(join(agentsDir, "executor.md")); // only one signal file
  makeDir("home", ".claude", "agents");

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  // Single file must NOT trigger bare-name — prevents false positives.
  assert.notEqual(result.source, "project-bare",
    "single executor.md must not trigger bare-name (threshold=2)");
});

// ── test 2: project-bare: two signal files → detected ─────────────────────────

test("project-bare: executor.md + explore.md in cwd/.claude/agents/ → prefix='', source='project-bare'", () => {
  const agentsDir = makeDir("cwd", ".claude", "agents");
  touch(join(agentsDir, "executor.md"));
  touch(join(agentsDir, "explore.md")); // second signal file
  makeDir("home", ".claude", "agents");

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.prefix, "", "bare-name install: prefix must be empty string");
  assert.equal(result.source, "project-bare");
});

// ── test 3: coordinator.md alone does NOT count as bare OMC ──────────────────

test("project agents/ with only coordinator.md → not project-bare (coordinator is Worker-Mode)", () => {
  const agentsDir = makeDir("cwd", ".claude", "agents");
  touch(join(agentsDir, "coordinator.md")); // Worker-Mode agent, not OMC signal

  // Also no user bare, no plugin
  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  // Should fall through to not-installed (no plugin file either)
  assert.equal(result.source, "not-installed");
});

// ── test 4: user-bare requires ≥2 signal files ────────────────────────────────

test("user-bare: executor.md + debugger.md in home/.claude/agents/ → prefix='', source='user-bare'", () => {
  // No project-level agents
  makeDir("cwd");

  const agentsDir = makeDir("home", ".claude", "agents");
  touch(join(agentsDir, "executor.md"));
  touch(join(agentsDir, "debugger.md")); // second signal file

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.prefix, "");
  assert.equal(result.source, "user-bare");
});

// ── test 5: project-bare wins over user-bare ─────────────────────────────────

test("project-bare takes priority over user-bare", () => {
  const projectAgents = makeDir("cwd", ".claude", "agents");
  touch(join(projectAgents, "executor.md"));
  touch(join(projectAgents, "explore.md"));

  const userAgents = makeDir("home", ".claude", "agents");
  touch(join(userAgents, "executor.md"));
  touch(join(userAgents, "explore.md"));

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.source, "project-bare");
});

// ── test 6: plugin install via installed_plugins.json ────────────────────────

test("plugin: installed_plugins.json has oh-my-claudecode@omc key → prefix='oh-my-claudecode:', source='plugin'", () => {
  makeDir("cwd");
  const pluginsDir = makeDir("home", ".claude", "plugins");
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "oh-my-claudecode@omc": [
          {
            scope: "user",
            installPath: "/fake/path",
            version: "1.0.0",
          },
        ],
      },
    })
  );

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.prefix, "oh-my-claudecode:");
  assert.equal(result.source, "plugin");
});

// ── test 6b: plugin returns installPath from installed_plugins.json ───────────

test("plugin: resolveOmcPrefix returns installPath from installed_plugins.json", () => {
  makeDir("cwd");
  const pluginsDir = makeDir("home", ".claude", "plugins");
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "oh-my-claudecode@omc": [
          {
            scope: "user",
            installPath: "/absolute/install/path",
            version: "2.0.0",
          },
        ],
      },
    })
  );

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.installPath, "/absolute/install/path",
    "installPath must come from installed_plugins.json entry");
});

// ── test 7: plugin key with different marketplace suffix ─────────────────────

test("plugin: oh-my-claudecode@other-marketplace → prefix='oh-my-claudecode:'", () => {
  makeDir("cwd");
  const pluginsDir = makeDir("home", ".claude", "plugins");
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "oh-my-claudecode@some-other-marketplace": [{ installPath: "/x" }],
      },
    })
  );

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.prefix, "oh-my-claudecode:");
  assert.equal(result.source, "plugin");
});

// ── test 8: not-installed (no agents, no plugin file) ────────────────────────

test("not-installed: no agents dirs, no plugin file → prefix=null, source='not-installed'", () => {
  makeDir("cwd");
  makeDir("home");

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.prefix, null);
  assert.equal(result.source, "not-installed");
});

// ── test 9: project-bare wins over plugin ────────────────────────────────────

test("project-bare (2 signal files) takes priority over plugin install", () => {
  const projectAgents = makeDir("cwd", ".claude", "agents");
  touch(join(projectAgents, "executor.md"));
  touch(join(projectAgents, "explore.md"));

  const pluginsDir = makeDir("home", ".claude", "plugins");
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "oh-my-claudecode@omc": [{ installPath: "/fake" }] },
    })
  );

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.source, "project-bare");
  assert.equal(result.prefix, "");
});

// ── test 10: user-bare wins over plugin ──────────────────────────────────────

test("user-bare (2 signal files) takes priority over plugin install", () => {
  makeDir("cwd");
  const userAgents = makeDir("home", ".claude", "agents");
  touch(join(userAgents, "executor.md"));
  touch(join(userAgents, "explore.md"));

  const pluginsDir = makeDir("home", ".claude", "plugins");
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "oh-my-claudecode@omc": [{ installPath: "/fake" }] },
    })
  );

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.source, "user-bare");
  assert.equal(result.prefix, "");
});

// ── test 11: corrupt installed_plugins.json → degrade gracefully ─────────────

test("corrupt installed_plugins.json → falls through to not-installed", () => {
  makeDir("cwd");
  const pluginsDir = makeDir("home", ".claude", "plugins");
  writeFileSync(join(pluginsDir, "installed_plugins.json"), "not valid JSON {{{");

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.prefix, null);
  assert.equal(result.source, "not-installed");
});

// ── test 12: installed_plugins.json with no matching key ─────────────────────

test("installed_plugins.json with unrelated keys only → not-installed", () => {
  makeDir("cwd");
  const pluginsDir = makeDir("home", ".claude", "plugins");
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "superpowers@claude-plugins-official": [{ installPath: "/x" }],
        "codex@openai-codex": [{ installPath: "/y" }],
      },
    })
  );

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.prefix, null);
  assert.equal(result.source, "not-installed");
});

// ── test 13: returns object with prefix + source + installPath always ─────────

test("always returns object with prefix, source, and installPath fields", () => {
  makeDir("cwd");
  makeDir("home");

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.ok("prefix" in result, "must have prefix field");
  assert.ok("source" in result, "must have source field");
  assert.ok("installPath" in result, "must have installPath field (new in must4)");
});

// ── test 14: bare-name installPath is the agents directory ────────────────────

test("bare-name install: installPath is the agents directory path", () => {
  const agentsDir = makeDir("cwd", ".claude", "agents");
  touch(join(agentsDir, "executor.md"));
  touch(join(agentsDir, "explore.md"));

  const result = resolveOmcPrefix({ cwd: fakeCwd(), home: fakeHome() });
  assert.equal(result.source, "project-bare");
  assert.equal(result.installPath, agentsDir,
    "installPath for bare-name install must be the agents directory");
});

// ── classifyAgentBackend unit tests ──────────────────────────────────────────

// Test 15: OMC base names in plugin env
test("classifyAgentBackend: omc base names (plugin env) → 'omc'", () => {
  const prefix = "oh-my-claudecode:";
  const omcAgents = [
    "oh-my-claudecode:executor",
    "oh-my-claudecode:debugger",
    "oh-my-claudecode:architect",
    "oh-my-claudecode:code-reviewer",
    "oh-my-claudecode:planner",
    "oh-my-claudecode:writer",
    "oh-my-claudecode:verifier",
    "oh-my-claudecode:explore",
    "oh-my-claudecode:qa-tester",
    "oh-my-claudecode:document-specialist",
  ];
  for (const agent of omcAgents) {
    const result = classifyAgentBackend(agent, prefix);
    assert.equal(result, "omc", `expected 'omc' for '${agent}'`);
  }
});

// Test 16: Legacy base names in plugin env
test("classifyAgentBackend: legacy base names (plugin env) → 'legacy'", () => {
  const prefix = "oh-my-claudecode:";
  const legacyAgents = [
    "implementer",
    "fixer",
    "qa",
    "reviewer",
    "researcher",
    "file-reader",
  ];
  for (const agent of legacyAgents) {
    const result = classifyAgentBackend(agent, prefix);
    assert.equal(result, "legacy", `expected 'legacy' for '${agent}'`);
  }
});

// Test 17: Bare-name env — omc agents without prefix
test("classifyAgentBackend: bare-name env (prefix='') — omc base names → 'omc'", () => {
  const prefix = "";
  const omcBareAgents = [
    "executor",
    "debugger",
    "architect",
    "code-reviewer",
    "planner",
    "writer",
    "verifier",
    "explore",
  ];
  for (const agent of omcBareAgents) {
    const result = classifyAgentBackend(agent, prefix);
    assert.equal(result, "omc", `bare-name: expected 'omc' for '${agent}'`);
  }
});

// Test 18: Bare-name env — legacy agents without prefix
test("classifyAgentBackend: bare-name env (prefix='') — legacy base names → 'legacy'", () => {
  const prefix = "";
  const legacyBareAgents = [
    "implementer",
    "fixer",
    "qa",
    "reviewer",
    "researcher",
  ];
  for (const agent of legacyBareAgents) {
    const result = classifyAgentBackend(agent, prefix);
    assert.equal(result, "legacy", `bare-name: expected 'legacy' for '${agent}'`);
  }
});

// Test 19: Unknown agents → 'unknown' (fail-open)
// Note: "superpowers:executor" → lastIndexOf(":") → base="executor" → OMC roster → "omc".
// This is expected: classifyAgentBackend classifies by base-name, not by full namespace.
// Agents that do NOT have a base-name in either roster → "unknown".
test("classifyAgentBackend: unknown agent names → 'unknown' (fail-open)", () => {
  const unknownAgents = [
    "my-custom-agent",
    "coordinator",       // Worker-Mode's own — not in OMC roster
    "random-thing",
    "superpowers:my-custom-agent", // different namespace, unknown base-name
  ];
  for (const agent of unknownAgents) {
    const result = classifyAgentBackend(agent, "oh-my-claudecode:");
    assert.equal(result, "unknown", `expected 'unknown' for '${agent}'`);
  }
});

// Test 20: Namespace bypass — "other:executor" and "evil:...:executor" must be "unknown"
// Security fix: lastIndexOf(":") base extraction allowed "other:executor" → "executor" → omc.
// New logic: any subagentType containing ":" but NOT starting with omcPrefix → "unknown" immediately.
test("classifyAgentBackend: namespace bypass inputs → 'unknown' (security fix)", () => {
  const prefix = "oh-my-claudecode:";
  // "other:executor" — different namespace, executor base would match OMC roster without fix
  assert.equal(
    classifyAgentBackend("other:executor", prefix),
    "unknown",
    "'other:executor' must be unknown (not omc) — namespace bypass blocked"
  );
  // "evil:oh-my-claudecode:executor" — omc prefix buried in middle, not at start
  assert.equal(
    classifyAgentBackend("evil:oh-my-claudecode:executor", prefix),
    "unknown",
    "'evil:oh-my-claudecode:executor' must be unknown — namespace bypass blocked"
  );
  // Also check with bare prefix
  assert.equal(
    classifyAgentBackend("other:executor", ""),
    "unknown",
    "'other:executor' with bare prefix must be unknown"
  );
});

// Test 20b: Plugin env correct classification — oh-my-claudecode:executor → omc
test("classifyAgentBackend: plugin env 'oh-my-claudecode:executor' → 'omc'", () => {
  assert.equal(
    classifyAgentBackend("oh-my-claudecode:executor", "oh-my-claudecode:"),
    "omc",
    "plugin env: prefixed omc agent must classify as omc"
  );
});

// Test 20c: Bare-name env — executor → omc, implementer → legacy (locked values)
test("classifyAgentBackend: bare-name env — 'executor' → 'omc', 'implementer' → 'legacy'", () => {
  assert.equal(
    classifyAgentBackend("executor", ""),
    "omc",
    "bare-name: executor must be omc"
  );
  assert.equal(
    classifyAgentBackend("implementer", ""),
    "legacy",
    "bare-name: implementer must be legacy"
  );
});

// Test 21: null/undefined/empty input → 'unknown'
test("classifyAgentBackend: null/undefined/empty input → 'unknown'", () => {
  assert.equal(classifyAgentBackend(null, "oh-my-claudecode:"), "unknown");
  assert.equal(classifyAgentBackend(undefined, "oh-my-claudecode:"), "unknown");
  assert.equal(classifyAgentBackend("", "oh-my-claudecode:"), "unknown");
  assert.equal(classifyAgentBackend(null, ""), "unknown");
});

// Test 22: coordinator → 'unknown' (belongs to Worker-Mode, not OMC)
test("classifyAgentBackend: coordinator → 'unknown' (Worker-Mode agent, not in OMC roster)", () => {
  assert.equal(classifyAgentBackend("coordinator", ""), "unknown");
  assert.equal(classifyAgentBackend("oh-my-claudecode:coordinator", "oh-my-claudecode:"), "unknown",
    "coordinator must not be in OMC roster even when prefixed");
});
