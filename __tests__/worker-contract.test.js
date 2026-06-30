// EC-WRK test — summary-only cost-reduction contract pinned into each worker body (Phase 2).
// Each of the 6 worker agents must carry BOTH anchors of the summary-only cost
// contract so the orchestrator's context stays light:
//   - "只回结构化摘要"  (return ONLY a structured summary)
//   - "文件引用"        (reference files by path; don't dump raw content)
// Both must be present (AND, not OR): deleting either anchor from ANY single
// worker body must redden this test.
//
// Membership is pinned with STRING LITERALS, one assert block per worker file
// (NOT a loop over a list) — a loop can iterate fewer items and silently pass
// when a member is missing, a known false-green trap. Each file is asserted
// distinctly so removing a contract phrase from any single worker reddens it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentsDir = join(pluginRoot, "agents");

// Split a markdown file into (frontmatter, body) by the YAML --- fences.
function splitFrontmatter(raw, label) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${label} must have YAML frontmatter delimited by --- fences`);
  return { frontmatter: m[1], body: m[2] };
}

function readWorker(name) {
  const raw = readFileSync(join(agentsDir, name), "utf8");
  return splitFrontmatter(raw, name);
}

// The summary-only contract: BOTH anchors must be present in each worker body.
const SUMMARY_ANCHOR = "只回结构化摘要"; // return ONLY a structured summary
const REFERENCE_ANCHOR = "文件引用"; // reference files by path, not raw content

// --- file-reader.md -------------------------------------------------------
test("file-reader.md body carries BOTH summary-only contract anchors", () => {
  const { body } = readWorker("file-reader.md");
  assert.ok(body.includes(SUMMARY_ANCHOR), "file-reader.md body must contain 只回结构化摘要");
  assert.ok(body.includes(REFERENCE_ANCHOR), "file-reader.md body must contain 文件引用");
});
test("file-reader.md description has proactively wording", () => {
  const { frontmatter } = readWorker("file-reader.md");
  assert.match(frontmatter, /description:[\s\S]*proactively/i, "file-reader.md description must say 'Use proactively'");
});
test("file-reader.md pins explicit maxTurns for long-running delegated work", () => {
  const { frontmatter } = readWorker("file-reader.md");
  assert.match(frontmatter, /^maxTurns: 500$/m, "file-reader.md frontmatter must pin maxTurns: 500");
});

// --- researcher.md --------------------------------------------------------
test("researcher.md body carries BOTH summary-only contract anchors", () => {
  const { body } = readWorker("researcher.md");
  assert.ok(body.includes(SUMMARY_ANCHOR), "researcher.md body must contain 只回结构化摘要");
  assert.ok(body.includes(REFERENCE_ANCHOR), "researcher.md body must contain 文件引用");
});
test("researcher.md description has proactively wording", () => {
  const { frontmatter } = readWorker("researcher.md");
  assert.match(frontmatter, /description:[\s\S]*proactively/i, "researcher.md description must say 'Use proactively'");
});
test("researcher.md pins explicit maxTurns for long-running delegated work", () => {
  const { frontmatter } = readWorker("researcher.md");
  assert.match(frontmatter, /^maxTurns: 500$/m, "researcher.md frontmatter must pin maxTurns: 500");
});

// --- implementer.md -------------------------------------------------------
test("implementer.md body carries BOTH summary-only contract anchors", () => {
  const { body } = readWorker("implementer.md");
  assert.ok(body.includes(SUMMARY_ANCHOR), "implementer.md body must contain 只回结构化摘要");
  assert.ok(body.includes(REFERENCE_ANCHOR), "implementer.md body must contain 文件引用");
});
test("implementer.md description has proactively wording", () => {
  const { frontmatter } = readWorker("implementer.md");
  assert.match(frontmatter, /description:[\s\S]*proactively/i, "implementer.md description must say 'Use proactively'");
});
test("implementer.md pins explicit maxTurns for long-running delegated work", () => {
  const { frontmatter } = readWorker("implementer.md");
  assert.match(frontmatter, /^maxTurns: 500$/m, "implementer.md frontmatter must pin maxTurns: 500");
});

// --- reviewer.md ----------------------------------------------------------
test("reviewer.md body carries BOTH summary-only contract anchors", () => {
  const { body } = readWorker("reviewer.md");
  assert.ok(body.includes(SUMMARY_ANCHOR), "reviewer.md body must contain 只回结构化摘要");
  assert.ok(body.includes(REFERENCE_ANCHOR), "reviewer.md body must contain 文件引用");
});
test("reviewer.md description has proactively wording", () => {
  const { frontmatter } = readWorker("reviewer.md");
  assert.match(frontmatter, /description:[\s\S]*proactively/i, "reviewer.md description must say 'Use proactively'");
});
test("reviewer.md pins explicit maxTurns for long-running delegated work", () => {
  const { frontmatter } = readWorker("reviewer.md");
  assert.match(frontmatter, /^maxTurns: 500$/m, "reviewer.md frontmatter must pin maxTurns: 500");
});

// --- qa.md ----------------------------------------------------------------
test("qa.md body carries BOTH summary-only contract anchors", () => {
  const { body } = readWorker("qa.md");
  assert.ok(body.includes(SUMMARY_ANCHOR), "qa.md body must contain 只回结构化摘要");
  assert.ok(body.includes(REFERENCE_ANCHOR), "qa.md body must contain 文件引用");
});
test("qa.md description has proactively wording", () => {
  const { frontmatter } = readWorker("qa.md");
  assert.match(frontmatter, /description:[\s\S]*proactively/i, "qa.md description must say 'Use proactively'");
});
test("qa.md pins explicit maxTurns for long-running delegated work", () => {
  const { frontmatter } = readWorker("qa.md");
  assert.match(frontmatter, /^maxTurns: 500$/m, "qa.md frontmatter must pin maxTurns: 500");
});

// --- fixer.md -------------------------------------------------------------
test("fixer.md body carries BOTH summary-only contract anchors", () => {
  const { body } = readWorker("fixer.md");
  assert.ok(body.includes(SUMMARY_ANCHOR), "fixer.md body must contain 只回结构化摘要");
  assert.ok(body.includes(REFERENCE_ANCHOR), "fixer.md body must contain 文件引用");
});
test("fixer.md description has proactively wording", () => {
  const { frontmatter } = readWorker("fixer.md");
  assert.match(frontmatter, /description:[\s\S]*proactively/i, "fixer.md description must say 'Use proactively'");
});
test("fixer.md pins explicit maxTurns for long-running delegated work", () => {
  const { frontmatter } = readWorker("fixer.md");
  assert.match(frontmatter, /^maxTurns: 500$/m, "fixer.md frontmatter must pin maxTurns: 500");
});

// --- coordinator.md -------------------------------------------------------
test("coordinator.md pins explicit maxTurns for long-running foreman work", () => {
  const { frontmatter } = readWorker("coordinator.md");
  assert.match(frontmatter, /^maxTurns: 500$/m, "coordinator.md frontmatter must pin maxTurns: 500");
});
