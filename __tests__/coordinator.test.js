// EC-CRD test — coordinator.md foreman-identity agent (Phase 1).
// The authoritative foreman guidance now lives in agents/coordinator.md (a
// wildcard Agent with full tools), retiring the old SessionStart protocol
// injection. CLAUDE.md becomes a truth-source / generic-capability supplement.
//
// Field membership is pinned with STRING LITERALS (not loops over a list) — a
// loop over a member list can't catch a missing member (it just iterates fewer
// items), a known false-green trap. Each red-line category is asserted distinctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const coordinatorPath = join(pluginRoot, "agents", "coordinator.md");

// Split a markdown file into (frontmatter, body) by the YAML --- fences.
function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, "coordinator.md must have YAML frontmatter delimited by --- fences");
  return { frontmatter: m[1], body: m[2] };
}

// The six worker names that MUST NOT be hardcoded as the coordinator's tool set.
const WORKER_NAMES = ["file-reader", "fixer", "implementer", "qa", "researcher", "reviewer"];

test("coordinator.md exists", () => {
  assert.ok(existsSync(coordinatorPath), "agents/coordinator.md must exist");
});

test("frontmatter declares a wildcard Agent with full tools (not a fixed worker list)", () => {
  const raw = readFileSync(coordinatorPath, "utf8");
  const { frontmatter } = splitFrontmatter(raw);

  // Must have a name and a tools field.
  assert.match(frontmatter, /^name:\s*coordinator\s*$/m, "frontmatter must name the agent 'coordinator'");
  assert.match(frontmatter, /^tools:/m, "frontmatter must declare a tools field");

  // Positive: tools must express wildcard Agent capability. Removing the
  // wildcard '*' (e.g. swapping it for a fixed list) makes this go RED.
  const toolsLine = frontmatter.match(/^tools:\s*(.+)$/m);
  assert.ok(toolsLine, "tools field must be present and inline");
  assert.match(toolsLine[1], /\*/, "tools must express wildcard (full) tool access via '*'");

  // The Agent (subagent dispatch) capability must be present — a foreman that
  // cannot dispatch is not a foreman. Pin the literal so dropping it goes RED.
  assert.ok(frontmatter.includes("Agent"), "frontmatter must grant the Agent (subagent dispatch) capability");

  // Negative: the tools field must NOT hardcode the 6 worker names as its set.
  // Asserted per-name with literals so adding any one of them goes RED.
  assert.ok(!toolsLine[1].includes("file-reader"), "tools must not hardcode worker name: file-reader");
  assert.ok(!toolsLine[1].includes("fixer"), "tools must not hardcode worker name: fixer");
  assert.ok(!toolsLine[1].includes("implementer"), "tools must not hardcode worker name: implementer");
  assert.ok(!toolsLine[1].includes("qa"), "tools must not hardcode worker name: qa");
  assert.ok(!toolsLine[1].includes("researcher"), "tools must not hardcode worker name: researcher");
  assert.ok(!toolsLine[1].includes("reviewer"), "tools must not hardcode worker name: reviewer");
});

test("body carries foreman identity + default-mode-is-delegate (D7)", () => {
  const raw = readFileSync(coordinatorPath, "utf8");
  const { body } = splitFrontmatter(raw);
  assert.ok(body.includes("你是工头（orchestrator）"), "body must declare the foreman identity anchor");
  assert.match(body, /调度/, "default mode must mention 调度 (dispatch)");
  assert.match(body, /派活/, "default mode must mention 派活 (delegate work)");
  assert.match(body, /收摘要/, "default mode must mention 收摘要 (collect summaries)");
  assert.match(body, /判断/, "default mode must mention 判断 (judge)");
});

test("body carries red-line category 1 — read execution prompts/playbook (assert distinctly)", () => {
  const raw = readFileSync(coordinatorPath, "utf8");
  const { body } = splitFrontmatter(raw);
  assert.match(body, /读执行(剧本|提示词)|执行剧本|执行提示词/, "red-line 1: read execution playbook / prompts yourself");
});

test("body carries red-line category 2 — read progress/state files (assert distinctly)", () => {
  const raw = readFileSync(coordinatorPath, "utf8");
  const { body } = splitFrontmatter(raw);
  assert.match(body, /读进度|进度.*状态|状态文件/, "red-line 2: read progress/state files yourself");
});

test("body carries red-line category 3 — in-context judgment (assert distinctly)", () => {
  const raw = readFileSync(coordinatorPath, "utf8");
  const { body } = splitFrontmatter(raw);
  assert.match(body, /当前上下文的判断|需要当前上下文/, "red-line 3: judgment that needs current context");
});

test("body carries red-line category 4 — distill experience from current session (assert distinctly)", () => {
  const raw = readFileSync(coordinatorPath, "utf8");
  const { body } = splitFrontmatter(raw);
  assert.match(body, /从当前会话沉淀经验|沉淀经验/, "red-line 4: distill experience from the current session");
});

test("body carries the D8 concise-scope-dispatch cost contract", () => {
  const raw = readFileSync(coordinatorPath, "utf8");
  const { body } = splitFrontmatter(raw);
  // D8: dispatch with a concise scope to reduce token cost.
  assert.match(body, /简洁\s*scope|简洁的?\s*scope|简洁范围/i, "must state the concise-scope dispatch contract");
  assert.match(body, /降本|省.*token|token.*成本|成本/, "must tie concise scope to reducing token/cost");
});
