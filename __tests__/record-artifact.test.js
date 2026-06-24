// record-artifact.test.js — unit tests for tools/record-artifact.mjs
// Runs via: node --test __tests__/record-artifact.test.js
//
// Each test spins up its own CLAUDE_PROJECT_DIR in a temp dir, calls the
// script as a child process (stdin pipe), and asserts file + JSONL output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(pluginRoot, "tools", "record-artifact.mjs");

// ── helper ────────────────────────────────────────────────────────────────────

function run({ id, stage, status, summary, stdinText = "details body", env = {} }) {
  const args = [];
  if (id      !== undefined) args.push("--id",      id);
  if (stage   !== undefined) args.push("--stage",   stage);
  if (status  !== undefined) args.push("--status",  status);
  if (summary !== undefined) args.push("--summary", summary);

  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    input: stdinText,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return result;
}

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "ra-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── test 1: normal write — findings/<id>.md content correct ──────────────────

test("normal write: findings/<id>.md has correct content", () => {
  const tmp = makeTmp();
  try {
    const result = run({
      id: "test-001",
      stage: "apply",
      status: "done",
      summary: "all good",
      stdinText: "my detailed findings",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });

    assert.equal(result.status, 0, "exit code should be 0; stderr: " + result.stderr);

    const mdPath = join(tmp, ".worker-mode", "state", "findings", "test-001.md");
    assert.ok(existsSync(mdPath), "findings file should exist");
    const content = readFileSync(mdPath, "utf8");
    assert.equal(content, "my detailed findings");
  } finally {
    cleanup(tmp);
  }
});

// ── test 2: artifacts.jsonl appended with all required fields ─────────────────

test("artifacts.jsonl appended with all schema fields", () => {
  const tmp = makeTmp();
  try {
    const result = run({
      id: "test-002",
      stage: "review",
      status: "partial",
      summary: "some done",
      stdinText: "review details",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });

    assert.equal(result.status, 0, result.stderr);

    const jsonlPath = join(tmp, ".worker-mode", "state", "artifacts.jsonl");
    assert.ok(existsSync(jsonlPath), "artifacts.jsonl should exist");

    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "should have exactly one line");

    const rec = JSON.parse(lines[0]);
    assert.equal(rec.id,           "test-002");
    assert.equal(rec.stage,        "review");
    assert.equal(rec.status,       "partial");
    assert.equal(rec.summary,      "some done");
    assert.equal(rec.details_path, "findings/test-002.md");
    assert.equal(typeof rec.source_sha,  "string",  "source_sha must be string");
    assert.equal(typeof rec.created_at,  "string",  "created_at must be string");
    assert.ok(rec.created_at.includes("T"), "created_at should be ISO 8601");
  } finally {
    cleanup(tmp);
  }
});

// ── test 3: id with path traversal chars sanitized ───────────────────────────

test("id with path-traversal chars is sanitized, no escape from findings/", () => {
  const tmp = makeTmp();
  try {
    const result = run({
      id: "../etc/passwd",
      stage: "hack",
      status: "done",
      summary: "should be sanitized",
      stdinText: "body",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });

    // Script should succeed (sanitize, not reject)
    assert.equal(result.status, 0, result.stderr);

    const out = JSON.parse(result.stdout.trim());
    // id must not contain / or ..
    assert.ok(!out.id.includes("/"),  "sanitized id must not contain /");
    assert.ok(!out.id.includes(".."), "sanitized id must not contain ..");

    // The file must land inside findings/, not escape it
    const findingsDir = join(tmp, ".worker-mode", "state", "findings");
    const mdPath = join(findingsDir, out.id + ".md");
    assert.ok(existsSync(mdPath), "file should be inside findings/");
  } finally {
    cleanup(tmp);
  }
});

// ── test 4: multiple calls → jsonl accumulates, not overwritten ───────────────

test("multiple calls accumulate in artifacts.jsonl", () => {
  const tmp = makeTmp();
  try {
    for (let i = 1; i <= 3; i++) {
      const result = run({
        id: "multi-" + String(i).padStart(3, "0"),
        stage: "loop",
        status: "done",
        summary: "call " + i,
        stdinText: "body " + i,
        env: { CLAUDE_PROJECT_DIR: tmp },
      });
      assert.equal(result.status, 0, "call " + i + " failed: " + result.stderr);
    }

    const jsonlPath = join(tmp, ".worker-mode", "state", "artifacts.jsonl");
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3, "should have 3 lines after 3 calls");

    const ids = lines.map((l) => JSON.parse(l).id);
    assert.deepEqual(ids, ["multi-001", "multi-002", "multi-003"]);
  } finally {
    cleanup(tmp);
  }
});

// ── test 5: git unavailable → source_sha = "none" ────────────────────────────

test("git unavailable → source_sha is 'none'", () => {
  const tmp = makeTmp();
  try {
    // Provide a PATH that has no git
    const result = run({
      id: "nogit-001",
      stage: "s",
      status: "done",
      summary: "no git",
      stdinText: "details",
      env: {
        CLAUDE_PROJECT_DIR: tmp,
        PATH: "/usr/bin/false-only-no-git-here", // no git binary
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const jsonlPath = join(tmp, ".worker-mode", "state", "artifacts.jsonl");
    const rec = JSON.parse(readFileSync(jsonlPath, "utf8").trim());
    assert.equal(rec.source_sha, "none");
  } finally {
    cleanup(tmp);
  }
});

// ── test 6: missing required args → exit 1 (fail-loud) ───────────────────────

test("missing --id → exit 1 with ok:false", () => {
  const tmp = makeTmp();
  try {
    const result = run({
      // id omitted
      stage: "s",
      status: "done",
      summary: "x",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });
    assert.equal(result.status, 1, "should exit 1 on missing --id");
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.ok, false);
    assert.ok(typeof out.error === "string" && out.error.length > 0);
  } finally {
    cleanup(tmp);
  }
});

test("missing --stage → exit 1 with ok:false", () => {
  const tmp = makeTmp();
  try {
    const result = run({
      id: "x",
      // stage omitted
      status: "done",
      summary: "x",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });
    assert.equal(result.status, 1);
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.ok, false);
  } finally {
    cleanup(tmp);
  }
});

test("invalid --status value → exit 1 with ok:false", () => {
  const tmp = makeTmp();
  try {
    const result = run({
      id: "x",
      stage: "s",
      status: "invalid-status",
      summary: "x",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });
    assert.equal(result.status, 1);
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.ok, false);
  } finally {
    cleanup(tmp);
  }
});

// ── test 9: duplicate id → second call fails, first file not overwritten ──────

test("duplicate id: second call fails (non-0) and first file content preserved", () => {
  const tmp = makeTmp();
  try {
    const first = run({
      id: "dup-001",
      stage: "s",
      status: "done",
      summary: "first write",
      stdinText: "original content",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });
    assert.equal(first.status, 0, "first call should succeed: " + first.stderr);

    const second = run({
      id: "dup-001",
      stage: "s",
      status: "done",
      summary: "second write",
      stdinText: "overwrite attempt",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });
    assert.notEqual(second.status, 0, "second call with same id should fail");
    const out = JSON.parse(second.stdout.trim());
    assert.equal(out.ok, false);
    assert.ok(out.error.includes("dup-001"), "error should mention the duplicate id");

    // First file must not be overwritten
    const mdPath = join(tmp, ".worker-mode", "state", "findings", "dup-001.md");
    const content = readFileSync(mdPath, "utf8");
    assert.equal(content, "original content", "first file content must not be overwritten");
  } finally {
    cleanup(tmp);
  }
});

// ── test 10: concurrent writes with distinct ids → jsonl line count correct ───

test("concurrent writes (~20 processes, distinct ids) → artifacts.jsonl has 20 lines, all valid JSON", async () => {
  const tmp = makeTmp();
  try {
    const { spawn } = await import("node:child_process");

    const N = 20;
    const procs = Array.from({ length: N }, (_, i) => {
      const id = "concurrent-" + String(i).padStart(3, "0");
      const args = [
        scriptPath,
        "--id", id,
        "--stage", "concurrent",
        "--status", "done",
        "--summary", "concurrent write " + i,
      ];
      const p = spawn(process.execPath, args, {
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
        stdio: ["pipe", "pipe", "pipe"],
      });
      p.stdin.end("details for " + id);
      return new Promise((resolve) => {
        p.on("close", (code) => resolve({ id, code }));
      });
    });

    const results = await Promise.all(procs);
    const failures = results.filter((r) => r.code !== 0);
    assert.equal(failures.length, 0, "all concurrent processes should exit 0; failures: " + JSON.stringify(failures));

    const jsonlPath = join(tmp, ".worker-mode", "state", "artifacts.jsonl");
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert.equal(lines.length, N, "artifacts.jsonl should have exactly " + N + " lines");

    for (const line of lines) {
      const rec = JSON.parse(line); // throws if invalid JSON
      assert.equal(typeof rec.id, "string", "each record must have a string id");
    }
  } finally {
    cleanup(tmp);
  }
});

// ── test 11: missing --status → exit 1 ───────────────────────────────────────

test("missing --status → exit 1 with ok:false", () => {
  const tmp = makeTmp();
  try {
    const result = run({
      id: "x",
      stage: "s",
      // status omitted
      summary: "x",
      env: { CLAUDE_PROJECT_DIR: tmp },
    });
    assert.equal(result.status, 1, "should exit 1 on missing --status");
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.ok, false);
    assert.ok(typeof out.error === "string" && out.error.length > 0);
  } finally {
    cleanup(tmp);
  }
});

// ── test 12: missing --summary → exit 1 ──────────────────────────────────────

test("missing --summary → exit 1 with ok:false", () => {
  const tmp = makeTmp();
  try {
    const result = run({
      id: "x",
      stage: "s",
      status: "done",
      // summary omitted
      env: { CLAUDE_PROJECT_DIR: tmp },
    });
    assert.equal(result.status, 1, "should exit 1 on missing --summary");
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.ok, false);
    assert.ok(typeof out.error === "string" && out.error.length > 0);
  } finally {
    cleanup(tmp);
  }
});
