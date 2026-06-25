// check-config.mjs SessionStart hook — TDD tests
// Covers: compact branch, no early-exit swallowing, merged additionalContext output
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(pluginRoot, "hooks", "check-config.mjs");

function run(payload, env = {}) {
  return spawnSync("node", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// ── T1: source=compact → compact reminder present ────────────────────────────
test("check-config: source=compact injects compact restore reminder", () => {
  const r = run({ source: "compact" }, { WORKER_LOG_PATH: "/abs/path/worker-log.jsonl" });
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /current\.json/, "compact reminder must mention current.json");
  assert.match(ctx, /compact|压缩/i, "compact reminder must mention compact/压缩");
});

// ── T2: source=startup → NO compact reminder ─────────────────────────────────
test("check-config: source=startup does NOT inject compact reminder", () => {
  const r = run({ source: "startup" }, { WORKER_LOG_PATH: "/abs/path/worker-log.jsonl" });
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  // stdout may be empty (no reminder needed) or contain only config reminder
  // but must NOT contain compact path mention
  if (r.stdout.trim()) {
    const out = JSON.parse(r.stdout.trim());
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /current\.json/, "startup must not inject compact reminder");
  }
  // empty stdout is also valid (no issues to report)
});

// ── T3: WORKER_LOG_PATH missing + source=compact → BOTH reminders present (no early exit) ──
test("check-config: missing WORKER_LOG_PATH + source=compact → both reminders in one output", () => {
  const r = run({ source: "compact" }, { WORKER_LOG_PATH: "" });
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  assert.ok(r.stdout.trim(), "must produce output when both reminders apply");
  const out = JSON.parse(r.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext;
  // config reminder
  assert.match(ctx, /WORKER_LOG_PATH/, "config reminder must be present");
  // compact reminder — MUST NOT be swallowed by early exit
  assert.match(ctx, /current\.json/, "compact reminder must NOT be swallowed by early exit");
});

// ── T4: WORKER_LOG_PATH missing + source=startup → config reminder, no compact reminder ──
test("check-config: missing WORKER_LOG_PATH + source=startup → only config reminder", () => {
  const r = run({ source: "startup" }, { WORKER_LOG_PATH: "" });
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /WORKER_LOG_PATH/, "config reminder must be present");
  assert.doesNotMatch(ctx, /current\.json/, "no compact reminder for startup");
});

// ── T5: WORKER_LOG_PATH normal + source=startup → backend hint only ──────────
test("check-config: configured path + source=startup → only backend hint (no config/compact reminders)", () => {
  const r = run({ source: "startup" }, { WORKER_LOG_PATH: "/abs/path/worker-log.jsonl" });
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  assert.ok(r.stdout.trim(), "backend hint always produced → non-empty stdout");
  const out = JSON.parse(r.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /当前执行后端/, "backend hint must always be present");
  assert.doesNotMatch(ctx, /WORKER_LOG_PATH/, "no config reminder needed");
  assert.doesNotMatch(ctx, /current\.json/, "no compact reminder for startup");
});

// ── T6: output is single valid JSON (not multiple lines of JSON) ─────────────
test("check-config: output is exactly one valid JSON object when reminders exist", () => {
  const r = run({ source: "compact" }, { WORKER_LOG_PATH: "" });
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "must output exactly one JSON line, not multiple");
  assert.doesNotThrow(() => JSON.parse(lines[0]), "that one line must be valid JSON");
});

// ── T7: non-absolute WORKER_LOG_PATH + source=compact → both reminders ───────
test("check-config: relative WORKER_LOG_PATH + source=compact → both reminders", () => {
  const r = run({ source: "compact" }, { WORKER_LOG_PATH: "relative/path.jsonl" });
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /WORKER_LOG_PATH/, "non-absolute path config reminder present");
  assert.match(ctx, /current\.json/, "compact reminder not swallowed");
});

// ── T8: missing stdin (empty) → falls back gracefully, no crash ──────────────
test("check-config: empty stdin → no crash, exits 0", () => {
  const r = spawnSync("node", [script], {
    input: "",
    encoding: "utf8",
    env: { ...process.env, WORKER_LOG_PATH: "/abs/path/worker-log.jsonl" },
  });
  assert.equal(r.status, 0, `must not crash on empty stdin; stderr=${r.stderr}`);
});

// ── T9: WORKER_MODE_BACKEND unset → omc backend hint ─────────────────────────
test("check-config: WORKER_MODE_BACKEND unset → shows omc backend hint", () => {
  const env = { ...process.env, WORKER_LOG_PATH: "/abs/path/worker-log.jsonl" };
  delete env.WORKER_MODE_BACKEND;
  const r = spawnSync("node", [script], { input: JSON.stringify({ source: "startup" }), encoding: "utf8", env });
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /当前执行后端.*omc/, "unset backend defaults to omc hint");
});

// ── T10: WORKER_MODE_BACKEND=legacy → legacy backend hint ────────────────────
test("check-config: WORKER_MODE_BACKEND=legacy → shows legacy backend hint", () => {
  const r = run(
    { source: "startup" },
    { WORKER_LOG_PATH: "/abs/path/worker-log.jsonl", WORKER_MODE_BACKEND: "legacy" }
  );
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /当前执行后端.*legacy/, "legacy backend hint present");
});
