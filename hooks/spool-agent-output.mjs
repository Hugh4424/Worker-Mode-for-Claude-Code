#!/usr/bin/env node
// spool-agent-output.mjs — PostToolUse hook: truncates large Task/Agent tool_output,
// spooling the full subagent summary to disk and replacing the in-context text with
// a compact summary stub + file path.
// Goal: reduce foreman context bloat from long subagent summaries (critic/code-reviewer
// reports can reach 3500+ chars, 16 dispatches ≈ 56K context inflation).
//
// Matcher: Task|Agent (separate hook entry, non-overlapping with Bash|Read|Grep spooler).
// Fail-open on ALL errors — exit 0 without hookSpecificOutput (= no replacement).
//
// Node ESM, zero external dependencies.

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// ── config ────────────────────────────────────────────────────────────────────
const MAX_CHARS = 2000;          // truncation threshold
const KEEP_CHARS = 300;          // summary stub length
const SPOOL_DIR = ".worker-mode/spool";
const EVENTS_LOG = join(SPOOL_DIR, "spool-events.jsonl");

// ── stdin ─────────────────────────────────────────────────────────────────────
function readStdin() {
  try {
    return JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {
    return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function shortHash(s, len = 6) {
  return createHash("sha256").update(s).digest("hex").slice(0, len);
}

function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch {}
}

function isoNow() {
  return new Date().toISOString();
}

function logEvent(entry) {
  try {
    ensureDir(SPOOL_DIR);
    appendFileSync(EVENTS_LOG, JSON.stringify(entry) + "\n");
  } catch {}
}

// ── main ──────────────────────────────────────────────────────────────────────
const data = readStdin();
if (!data) {
  process.stderr.write("[spool-agent-output] stdin parse failed, pass-through\n");
  process.exit(0);
}

// Only Task/Agent tools
if (data.tool_name !== "Task" && data.tool_name !== "Agent") {
  process.exit(0);
}

// Subagent context — skip
if (data.agent_id) {
  process.exit(0);
}

// Subagent transcript path — skip (same exemption as spool-tool-output.mjs)
if (typeof data.transcript_path === "string" && data.transcript_path.includes("/subagents/")) {
  process.exit(0);
}

const text = typeof data.tool_response === "string" ? data.tool_response : "";
if (!text) {
  process.exit(0);
}

const inputBytes = Buffer.byteLength(text, "utf8");
const inputLines = text.split("\n").length;

if (text.length <= MAX_CHARS) {
  logEvent({
    ts: isoNow(),
    tool: data.tool_name,
    input_bytes: inputBytes,
    input_lines: inputLines,
    action: "passed_through",
    threshold_bypass_reason: `chars=${text.length} <= max=${MAX_CHARS}`
  });
  process.exit(0);
}

// ── spool + truncate ──────────────────────────────────────────────────────────
try {
  ensureDir(SPOOL_DIR);
  const ts = isoNow().replace(/[:.]/g, "-");
  const hash = shortHash(text);
  const spoolPath = join(SPOOL_DIR, `agent-${ts}-${hash}.txt`);
  writeFileSync(spoolPath, text, "utf8");

  const stub = text.slice(0, KEEP_CHARS);
  const replacement = `[完整回报已落盘: ${spoolPath}]\n\n### 摘要(前${KEEP_CHARS}字)\n${stub}...`;

  logEvent({
    ts: isoNow(),
    tool: data.tool_name,
    input_bytes: inputBytes,
    input_lines: inputLines,
    action: "spooled",
    spool_path: spoolPath,
    truncated_chars: text.length,
    kept_chars: KEEP_CHARS
  });

  process.stdout.write(JSON.stringify({
    hookEventName: "PostToolUse",
    hookSpecificOutput: {
      updatedToolOutput: replacement
    }
  }));
  process.exit(0);
} catch (e) {
  process.stderr.write(`[spool-agent-output] write failed: ${e.message}, pass-through\n`);
  process.exit(0);
}
