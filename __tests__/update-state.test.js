// update-state.test.js — unit tests for tools/update-state.mjs
// Runs via: node --test __tests__/update-state.test.js
//
// Spins up child process per test with CLAUDE_PROJECT_DIR → tmp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(pluginRoot, "tools", "update-state.mjs");

function run(stdinJson, env = {}) {
  const input = typeof stdinJson === "string" ? stdinJson : JSON.stringify(stdinJson);
  return spawnSync(process.execPath, [scriptPath], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "us-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function statePath(tmp) {
  return join(tmp, ".worker-mode", "state", "current.json");
}

// ── test 1: current.json 不存在时从模板初始化创建 ────────────────────────────

test("creates current.json from template when it does not exist", () => {
  const tmp = makeTmp();
  try {
    const result = run({ stage: "INIT", progress: "0%" }, { CLAUDE_PROJECT_DIR: tmp });

    assert.equal(result.status, 0, "should exit 0; stderr: " + result.stderr);

    const p = statePath(tmp);
    assert.ok(existsSync(p), "current.json should have been created");

    const data = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(data.stage, "INIT", "stage should be patched in");
    assert.equal(data.progress, "0%", "progress should be patched in");
  } finally {
    cleanup(tmp);
  }
});

// ── test 2: 已存在时 merge 更新只改传入字段、保留其余 ───────────────────────

test("merge-updates only supplied fields, preserves rest", () => {
  const tmp = makeTmp();
  try {
    // First write to set initial state
    run({ stage: "PHASE_A", progress: "50%", open_risks: ["risk1"] }, { CLAUDE_PROJECT_DIR: tmp });

    // Second write only updates stage, progress stays
    const result = run({ stage: "PHASE_B" }, { CLAUDE_PROJECT_DIR: tmp });
    assert.equal(result.status, 0, result.stderr);

    const data = JSON.parse(readFileSync(statePath(tmp), "utf8"));
    assert.equal(data.stage, "PHASE_B", "stage should be updated");
    assert.equal(data.progress, "50%", "progress should be preserved");
    assert.deepEqual(data.open_risks, ["risk1"], "open_risks should be preserved");
  } finally {
    cleanup(tmp);
  }
});

// ── test 3: updated_at 被刷新 ────────────────────────────────────────────────

test("updated_at is refreshed on every write", () => {
  const tmp = makeTmp();
  try {
    run({ stage: "A" }, { CLAUDE_PROJECT_DIR: tmp });
    const firstData = JSON.parse(readFileSync(statePath(tmp), "utf8"));
    const firstTs = firstData.updated_at;
    assert.ok(typeof firstTs === "string" && firstTs.includes("T"), "updated_at must be ISO 8601");

    // Brief pause then second write
    const result = run({ stage: "B" }, { CLAUDE_PROJECT_DIR: tmp });
    assert.equal(result.status, 0, result.stderr);

    const secondData = JSON.parse(readFileSync(statePath(tmp), "utf8"));
    assert.ok(typeof secondData.updated_at === "string", "updated_at must be string");
    // updated_at must be a valid ISO timestamp
    assert.ok(!isNaN(Date.parse(secondData.updated_at)), "updated_at must parse as date");
  } finally {
    cleanup(tmp);
  }
});

// ── test 4: 原子写（写坏不留半个文件） ──────────────────────────────────────

test("atomic write: output is always valid JSON (no partial file)", () => {
  const tmp = makeTmp();
  try {
    const result = run({ stage: "ATOMIC", next_steps: ["step1", "step2"] }, { CLAUDE_PROJECT_DIR: tmp });
    assert.equal(result.status, 0, result.stderr);

    const raw = readFileSync(statePath(tmp), "utf8");
    // Must parse without throwing — proves no partial write survived
    const data = JSON.parse(raw);
    assert.equal(data.stage, "ATOMIC");
  } finally {
    cleanup(tmp);
  }
});

// ── test 5: 非法 stdin JSON → fail-loud exit 1 ───────────────────────────────

test("invalid stdin JSON → exit 1 with ok:false", () => {
  const tmp = makeTmp();
  try {
    const result = run("this is not json {{{{", { CLAUDE_PROJECT_DIR: tmp });
    assert.equal(result.status, 1, "should exit 1 on bad JSON");
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.ok, false);
    assert.ok(typeof out.error === "string" && out.error.length > 0, "error must be non-empty string");
  } finally {
    cleanup(tmp);
  }
});

// ── test 6: 写出来的是合法 JSON ──────────────────────────────────────────────

test("written file is always valid parseable JSON", () => {
  const tmp = makeTmp();
  try {
    run(
      {
        stage: "VALIDATE",
        progress: "75%",
        next_steps: ["do A", "do B"],
        open_risks: ["risk X"],
        verification_status: "pass",
      },
      { CLAUDE_PROJECT_DIR: tmp }
    );

    const raw = readFileSync(statePath(tmp), "utf8");
    let data;
    assert.doesNotThrow(() => {
      data = JSON.parse(raw);
    }, "file must be valid JSON");

    // Spot-check a few fields survive
    assert.equal(data.stage, "VALIDATE");
    assert.equal(data.verification_status, "pass");
    assert.deepEqual(data.next_steps, ["do A", "do B"]);
  } finally {
    cleanup(tmp);
  }
});

// ── test 7: stdout carries {ok:true, path} on success ────────────────────────

test("success stdout has ok:true and path", () => {
  const tmp = makeTmp();
  try {
    const result = run({ stage: "OUT" }, { CLAUDE_PROJECT_DIR: tmp });
    assert.equal(result.status, 0, result.stderr);

    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.ok, true);
    assert.ok(typeof out.path === "string" && out.path.length > 0, "path must be non-empty string");
    assert.ok(out.path.endsWith("current.json"), "path should point to current.json");
  } finally {
    cleanup(tmp);
  }
});
