#!/usr/bin/env node
// update-state.mjs — CLI helper: coordinator calls this via Bash to safely
// create or update .worker-mode/state/current.json (atomic write, no JSON hand-crafting).
// Node ESM, zero external dependencies.
//
// Usage (stdin JSON patch, merge into current.json):
//   echo '{"stage":"X","next_steps":["..."],"verification_status":"not_run"}' \
//     | node tools/update-state.mjs
//
// Root dir: env CLAUDE_PROJECT_DIR, fallback process.cwd().
// Template: templates/state-current.json (base structure when current.json absent)
//
// Output:
//   success → stdout: {"ok":true,"path":"<abs path to current.json>"}
//   failure → stdout: {"ok":false,"error":"..."} + exit 1 (fail-loud)
//
// All debug/trace output → stderr. stdout = machine-readable result only.
//
// ponytail: flat merge only (top-level fields); nested deep-merge if needed later

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// ── fail-loud helper ──────────────────────────────────────────────────────────

function failHard(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

// ── resolve paths ─────────────────────────────────────────────────────────────

const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const pluginRoot  = dirname(dirname(fileURLToPath(import.meta.url)));
const templatePath = join(pluginRoot, "templates", "state-current.json");
const stateDir    = join(projectRoot, ".worker-mode", "state");
const targetPath  = join(stateDir, "current.json");

// ── read stdin ────────────────────────────────────────────────────────────────

let stdinRaw;
try {
  stdinRaw = readFileSync(0, "utf8");
} catch (err) {
  failHard("stdin read failed: " + err.message);
}

let patch;
try {
  patch = JSON.parse(stdinRaw);
} catch (err) {
  failHard("stdin is not valid JSON: " + err.message);
}

if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
  failHard("stdin JSON must be a plain object (patch fields to merge)");
}

// ── load base: existing current.json or template ──────────────────────────────

let base;
if (existsSync(targetPath)) {
  try {
    base = JSON.parse(readFileSync(targetPath, "utf8"));
  } catch (err) {
    failHard("failed to parse existing current.json: " + err.message);
  }
} else {
  // Initialize from template; strip _schema comment-like keys if desired.
  // ponytail: keep _schema field — harmless, helps readers identify the version
  try {
    base = JSON.parse(readFileSync(templatePath, "utf8"));
  } catch (err) {
    failHard("failed to read template state-current.json: " + err.message);
  }
}

// ── merge patch → base (top-level flat merge) ─────────────────────────────────

const merged = Object.assign({}, base, patch, {
  updated_at: new Date().toISOString(),
});

// ── mkdir -p ──────────────────────────────────────────────────────────────────

try {
  mkdirSync(stateDir, { recursive: true });
} catch (err) {
  failHard("mkdir failed: " + err.message);
}

// ── atomic write: write temp → rename ────────────────────────────────────────
// Prevents a half-written file surviving on crash.

const tmpPath = targetPath + ".tmp." + randomBytes(4).toString("hex");
try {
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  renameSync(tmpPath, targetPath);
} catch (err) {
  // Best-effort cleanup of tmp file — ignore secondary errors
  try { unlinkSync(tmpPath); } catch { /* ignore */ }
  failHard("atomic write failed: " + err.message);
}

// ── success ───────────────────────────────────────────────────────────────────

process.stdout.write(JSON.stringify({ ok: true, path: targetPath }) + "\n");
process.exit(0);
