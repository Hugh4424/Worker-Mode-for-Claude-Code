// Test: plugin skeleton structure and manifest integrity
// Run: node --test plugins/Worker-Mode-for-Claude-Code/__tests__/skeleton.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");

test("plugin.json exists and is valid JSON", () => {
  const manifestPath = resolve(pluginRoot, ".claude-plugin/plugin.json");
  assert.ok(existsSync(manifestPath), `.claude-plugin/plugin.json does not exist at ${manifestPath}`);
  const raw = readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    assert.fail(`plugin.json is not valid JSON: ${e.message}`);
  }
  assert.ok(manifest, "parsed manifest must be truthy");
});

test("manifest.name is Worker-Mode-for-Claude-Code", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginRoot, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "Worker-Mode-for-Claude-Code");
});

test("manifest.components declares all 6 component groups", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginRoot, ".claude-plugin/plugin.json"), "utf8"));
  const components = manifest.components;
  assert.ok(components, "manifest.components must exist");
  const required = ["orchestratorProtocol", "workers", "subagentLogHook", "recordScript", "stateTemplate", "checkTool"];
  for (const key of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(components, key), `manifest.components must have key: ${key}`);
  }
});

test("manifest.config.workerLogPath documents the WORKER_LOG_PATH env contract", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginRoot, ".claude-plugin/plugin.json"), "utf8"));
  assert.ok(manifest.config, "manifest.config must exist");
  assert.ok(manifest.config.workerLogPath, "manifest.config.workerLogPath must exist");
  assert.equal(manifest.config.workerLogPath.required, true, "workerLogPath.required must be true");
  // The manifest field is documentary; the live value is the WORKER_LOG_PATH env
  // var. Pin that the doc names the real env var so the field cannot drift back
  // into a dead/unenforced decoration.
  assert.equal(manifest.config.workerLogPath.env, "WORKER_LOG_PATH", "config must name the real env var it maps to");
});

test("SessionStart config guard surfaces a non-blocking reminder, never blocks", () => {
  // The required-config contract is surfaced by a real SessionStart guard that
  // is NON-BLOCKING (exit 0 + additionalContext), preserving the plugin's
  // zero-interception basis. Verify registration + the actual runtime behavior,
  // so the reminder is provably live, not a dead manifest field — and provably
  // non-blocking, not an exit-2 hard stop.
  const hooks = JSON.parse(readFileSync(resolve(pluginRoot, "hooks/hooks.json"), "utf8"));
  assert.ok(Array.isArray(hooks.hooks.SessionStart), "hooks.json must register a SessionStart hook");
  const cmd = JSON.stringify(hooks.hooks.SessionStart);
  assert.ok(cmd.includes("check-config.mjs"), "SessionStart must invoke check-config.mjs");

  const guard = resolve(pluginRoot, "hooks/check-config.mjs");
  assert.ok(existsSync(guard), "check-config.mjs guard must exist");

  const env = { ...process.env };
  delete env.WORKER_LOG_PATH;

  // Unset => NON-BLOCKING reminder: exit 0 (never blocks session) + additionalContext naming the var.
  const unset = spawnSync("node", [guard], { env, encoding: "utf8" });
  assert.equal(unset.status, 0, "guard must NOT block the session (exit 0) when WORKER_LOG_PATH is unset");
  const unsetOut = JSON.parse(unset.stdout);
  assert.equal(unsetOut.hookSpecificOutput.hookEventName, "SessionStart", "must emit SessionStart hookSpecificOutput");
  assert.match(unsetOut.hookSpecificOutput.additionalContext, /WORKER_LOG_PATH/, "reminder must name the missing var");

  // Non-absolute => reminder about absolute path, still non-blocking.
  const rel = spawnSync("node", [guard], { env: { ...env, WORKER_LOG_PATH: "relative/x.jsonl" }, encoding: "utf8" });
  assert.equal(rel.status, 0, "guard must NOT block on a non-absolute path");
  assert.match(JSON.parse(rel.stdout).hookSpecificOutput.additionalContext, /absolute/i, "reminder must flag non-absolute path");

  // Set to an absolute path => silent (exit 0, no reminder).
  const ok = spawnSync("node", [guard], { env: { ...env, WORKER_LOG_PATH: "/tmp/x.jsonl" }, encoding: "utf8" });
  assert.equal(ok.status, 0, "guard must exit 0 when WORKER_LOG_PATH is a valid absolute path");
  assert.equal(ok.stdout.trim(), "", "guard must stay silent when properly configured");
});

test("component directories exist (agents, hooks, templates, tools)", () => {
  const dirs = ["agents", "hooks", "templates", "tools"];
  for (const dir of dirs) {
    const p = resolve(pluginRoot, dir);
    assert.ok(existsSync(p), `directory must exist: ${dir}/ (checked at ${p})`);
  }
});
