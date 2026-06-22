// EC-PROTO test — orchestrator 工头协议 + compactPrompt identity anchor.
// Asserts CLAUDE.md carries the four required elements (FR-ORCH-001~004) and
// settings-compact.json preserves the foreman identity anchor (FR-ORCH-005, D8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const claudeMdPath = join(pluginRoot, "CLAUDE.md");
const compactPath = join(pluginRoot, "settings-compact.json");
// The authoritative foreman guidance now lives in coordinator.md (truth source),
// no longer pushed via a SessionStart injection hook (inject-protocol.mjs retired).
const coordinatorPath = join(pluginRoot, "agents", "coordinator.md");
const injectHookPath = join(pluginRoot, "hooks", "inject-protocol.mjs");

// The foreman identity anchor string — must appear verbatim in BOTH the protocol
// and the compactPrompt so it survives auto-compaction (D8).
const IDENTITY_ANCHOR = "你是工头（orchestrator）";

test("CLAUDE.md exists", () => {
  assert.ok(existsSync(claudeMdPath), "CLAUDE.md must exist");
});

test("CLAUDE.md element 1 — foreman identity (FR-ORCH-001)", () => {
  const c = readFileSync(claudeMdPath, "utf8");
  assert.ok(c.includes(IDENTITY_ANCHOR), "must declare foreman identity anchor");
  assert.match(c, /调度|派活|收摘要|判断/, "must define default mode as dispatch/delegate/summarize/judge");
});

test("CLAUDE.md element 2 — delegation judgment by principle, not a fixed list (FR-ORCH-002/D9)", () => {
  const c = readFileSync(claudeMdPath, "utf8");
  assert.match(c, /原则/, "must give judgment principles");
  assert.match(c, /不(枚举|写死|给清单|列清单)/, "must explicitly avoid a fixed enumerated boundary list");
});

test("CLAUDE.md element 3 — explicitly protect work the orchestrator must do itself (FR-ORCH-003/D7)", () => {
  const c = readFileSync(claudeMdPath, "utf8");
  // The four protected activities: read prompts, read progress/state, in-context judgment, distill experience.
  assert.match(c, /提示词|执行提示/, "protect: reading execution prompts");
  assert.match(c, /进度|状态文件/, "protect: reading progress/state files");
  assert.match(c, /沉淀|经验/, "protect: distilling experience");
  assert.match(c, /自己(干|做)/, "must mark these as do-it-yourself, not delegated");
});

test("CLAUDE.md element 4 — context accounting awareness (FR-ORCH-004)", () => {
  const c = readFileSync(claudeMdPath, "utf8");
  assert.match(c, /上下文/, "must mention context");
  assert.match(c, /变笨|变慢|变贵|占满|清醒/, "must frame self-reading-heavy-content as degrading own context");
});

test("CLAUDE.md is pure-incentive — no interception/permission-block language (FR-ORCH-006/D1)", () => {
  const c = readFileSync(claudeMdPath, "utf8");
  // Must NOT claim to intercept/block/restrict — it is incentive-only.
  assert.ok(!/拦截主会话|限制工具|阻拦你动手|禁止你 Edit/.test(c), "must not introduce interception/permission-block mechanisms");
});

test("settings-compact.json exists and is valid JSON with compactPrompt", () => {
  assert.ok(existsSync(compactPath), "settings-compact.json must exist");
  const j = JSON.parse(readFileSync(compactPath, "utf8"));
  assert.ok(typeof j.compactPrompt === "string" && j.compactPrompt.length > 0, "must declare a non-empty compactPrompt");
});

test("settings-compact.json compactPrompt preserves the foreman identity anchor (FR-ORCH-005/D8)", () => {
  const j = JSON.parse(readFileSync(compactPath, "utf8"));
  assert.ok(j.compactPrompt.includes(IDENTITY_ANCHOR), "compactPrompt must preserve the identity anchor verbatim");
});

// --- Truth-source migration: foreman guidance now lives in coordinator.md body,
// not via the retired SessionStart injection (inject-protocol.mjs). ---

test("coordinator.md is the foreman-guidance truth source (carries identity + default mode)", () => {
  assert.ok(existsSync(coordinatorPath), "agents/coordinator.md must exist as the truth source");
  const c = readFileSync(coordinatorPath, "utf8");
  assert.ok(c.includes(IDENTITY_ANCHOR), "coordinator.md body must declare the foreman identity anchor");
  assert.match(c, /调度|派活|收摘要|判断/, "coordinator.md must define default mode as dispatch/delegate/summarize/judge");
});

test("foreman guidance is no longer pushed via the retired inject-protocol.mjs hook", () => {
  // The old SessionStart protocol-injection hook is retired; its file must be gone.
  assert.ok(!existsSync(injectHookPath), "hooks/inject-protocol.mjs must be deleted (injection retired)");
  // hooks.json must not reference the retired injector (other hooks stay intact).
  const hooks = readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8");
  assert.ok(!hooks.includes("inject-protocol"), "hooks.json must not reference inject-protocol.mjs");
});
