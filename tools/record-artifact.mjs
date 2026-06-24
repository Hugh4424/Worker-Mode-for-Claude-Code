#!/usr/bin/env node
// record-artifact.mjs — CLI helper: worker calls this via Bash to persist one artifact.
// Node ESM, zero external dependencies.
//
// Usage (stdin mode, preferred):
//   echo "<details body>" | node tools/record-artifact.mjs \
//     --id <id> --stage <stage> --status <done|partial|failed> --summary "<one-liner>"
//
// Root dir: env CLAUDE_PROJECT_DIR, fallback process.cwd().
// State dir: <root>/.worker-mode/state/
// Writes:    findings/<id>.md  (details body from stdin)
//            artifacts.jsonl   (one appended JSONL line, O_APPEND atomic)
//
// Output:
//   success → stdout: {"ok":true,"id":"...","details_path":"findings/..."}
//   failure → stdout: {"ok":false,"error":"..."} + exit 1 (fail-loud)

import { mkdirSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

// ── parse args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] ?? true;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function failHard(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

// ── validate required args ────────────────────────────────────────────────────

const { id: rawId, stage, status, summary } = args;

if (!rawId)    failHard("missing required arg: --id");
if (!stage)    failHard("missing required arg: --stage");
if (!status)   failHard("missing required arg: --status");
if (!summary)  failHard("missing required arg: --summary");

const VALID_STATUSES = new Set(["done", "partial", "failed"]);
if (!VALID_STATUSES.has(status)) {
  failHard("--status must be one of: done, partial, failed; got: " + status);
}

// ── id sanitize (security: prevent path traversal) ───────────────────────────
// ponytail: strict allowlist only; upgrade path: allow dots if slug needs them

const id = String(rawId).replace(/[^a-zA-Z0-9\-_]/g, "_");
if (id !== rawId) {
  // Silently normalized — not an error, but the caller sees the canonical id
}

// ── read details from stdin ───────────────────────────────────────────────────

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch (err) {
    failHard("stdin read failed: " + err.message);
  }
}

const details = readStdin();

// ── resolve paths ─────────────────────────────────────────────────────────────

const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir    = join(projectRoot, ".worker-mode", "state");
const findingsDir = join(stateDir, "findings");
const artifactsPath = join(stateDir, "artifacts.jsonl");
const detailsRelPath = "findings/" + id + ".md";
const detailsAbsPath = join(findingsDir, id + ".md");

// ── mkdir -p ──────────────────────────────────────────────────────────────────

try {
  mkdirSync(findingsDir, { recursive: true });
} catch (err) {
  failHard("mkdir failed: " + err.message);
}

// ── write findings/<id>.md ────────────────────────────────────────────────────

try {
  const buf = Buffer.from(details, "utf8");
  const fd = openSync(detailsAbsPath, "wx"); // exclusive create — prevents silent overwrite on duplicate id
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
} catch (err) {
  if (err.code === "EEXIST") {
    failHard("artifact id already exists: " + id);
  }
  failHard("write findings failed: " + err.message);
}

// ── resolve git HEAD sha (short 8) ───────────────────────────────────────────
// ponytail: global git lookup; per-worktree if multi-repo needed

let sourceSha = "none";
try {
  sourceSha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // git unavailable or not a repo — keep "none"
}

// ── build JSONL record ────────────────────────────────────────────────────────

const record = {
  id,
  stage,
  status,
  source_sha: sourceSha,
  created_at: new Date().toISOString(),
  summary,
  details_path: detailsRelPath,
};

// ── O_APPEND atomic append to artifacts.jsonl ────────────────────────────────
// Mirrors record-worker.mjs:507-519 pattern.

try {
  const line = JSON.stringify(record) + "\n";
  const buf  = Buffer.from(line, "utf8");
  const fd   = openSync(artifactsPath, "a");
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
} catch (err) {
  failHard("append artifacts.jsonl failed: " + err.message);
}

// ── success ───────────────────────────────────────────────────────────────────

process.stdout.write(
  JSON.stringify({ ok: true, id, details_path: detailsRelPath }) + "\n"
);
process.exit(0);
