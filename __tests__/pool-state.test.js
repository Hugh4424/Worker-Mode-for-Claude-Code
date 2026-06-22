// EC-POOL + EC-STATE test — 6 generic workers with routing descriptions (FR-POOL),
// and a generic project-state template with no project-specific residue (FR-STATE).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentsDir = join(pluginRoot, "agents");
const statePath = join(pluginRoot, "templates", "project-state.md");

// The exact 6 generic worker roles (D3). Membership asserted by literal list so the
// test cannot pass if a role is missing (loop-over-list cannot falsify membership).
const REQUIRED_WORKERS = ["researcher", "file-reader", "implementer", "reviewer", "qa", "fixer"];

function readAgent(name) {
  const p = join(agentsDir, `${name}.md`);
  assert.ok(existsSync(p), `agent ${name}.md must exist`);
  return readFileSync(p, "utf8");
}

test("EC-POOL: all 6 required worker agent files exist", () => {
  for (const w of REQUIRED_WORKERS) {
    assert.ok(existsSync(join(agentsDir, `${w}.md`)), `${w}.md must exist`);
  }
});

test("EC-POOL: each worker has frontmatter name matching its role", () => {
  for (const w of REQUIRED_WORKERS) {
    const c = readAgent(w);
    assert.match(c, new RegExp(`^name:\\s*${w}\\s*$`, "m"), `${w}.md frontmatter name must be ${w}`);
  }
});

test("EC-POOL: each worker description uses the 'Use proactively when' routing pattern (FR-POOL-002/D10)", () => {
  for (const w of REQUIRED_WORKERS) {
    const c = readAgent(w);
    const desc = c.match(/^description:\s*(.+)$/m);
    assert.ok(desc, `${w}.md must have a description`);
    assert.match(desc[1], /[Uu]se proactively when/, `${w}.md description must use 'Use proactively when X' routing pattern`);
  }
});

test("EC-POOL: workers are generic — project knowledge fed via state file, not hardcoded (FR-POOL-003)", () => {
  // No worker body may hardcode a concrete project name / repo path as its identity.
  // Each must reference reading the project-state file / assigned paths for context.
  for (const w of REQUIRED_WORKERS) {
    const c = readAgent(w);
    assert.match(c, /project-state|状态文件|被指派的(文件)?路径|assigned path/i,
      `${w}.md must source project context from the state file / assigned paths (generic role)`);
  }
});

test("EC-STATE: project-state template exists", () => {
  assert.ok(existsSync(statePath), "templates/project-state.md must exist");
});

test("EC-STATE: state template is generic — no project-specific residue", () => {
  const c = readFileSync(statePath, "utf8");
  // Must NOT contain this very task's name or other concrete task slugs (would be residue).
  assert.ok(!/Worker-Mode-for-Claude-Code/.test(c), "state template must not hardcode this plugin's name");
  assert.ok(!/multica-agenthub/.test(c), "state template must not hardcode a concrete repo name");
  // Must read like a fillable generic template (placeholders), not a filled instance.
  assert.match(c, /<[^>]+>|\{\{[^}]+\}\}|＜|填写|placeholder/i, "state template must contain fillable placeholders");
});

test("EC-STATE: state template explains worker self-fetch / heavy-content-stays-out-of-orchestrator (FR-STATE-003)", () => {
  const c = readFileSync(statePath, "utf8");
  assert.match(c, /自取|self-fetch|凭.*路径/i, "must explain workers self-fetch context");
  assert.match(c, /重内容.*(不进|从不进).*主会话|主会话.*只读.*轻量|不.*先全读.*再/i,
    "must state heavy content never enters the orchestrator (anti-fake-delegation, FR-STATE-003)");
});
