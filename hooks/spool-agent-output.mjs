#!/usr/bin/env node
// spool-agent-output.mjs — PostToolUse hook: spools large Agent/Task output to disk,
// replacing the in-context text with a compact summary + file path.
// Goal: reduce foreman context bloat from large subagent returns.
//
// Fail-open on ALL errors: stdin parse failure, write failure, unknown shape —
// exit 0 without printing hookSpecificOutput (= no replacement).
// All debug/status logging goes to stderr only.
//
// Node ESM, zero external dependencies.

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── constants ─────────────────────────────────────────────────────────────────

const OUTPUT_LIMIT_CHARS = 1200;
const SUMMARY_HEAD_CHARS = 200;

// ── stdin ─────────────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {
    return null; // parse failure → fail-open
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

function sanitise(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

function spoolFilename(toolName, ts) {
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${sanitise(toolName)}-${ts}-${rand}.md`;
}

function spoolDir() {
  const base = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(base, ".worker-mode", "state", "agent-output");
}

function buildSummary(text, totalChars, spoolPath) {
  const head = text.slice(0, SUMMARY_HEAD_CHARS);
  const ellipsis = totalChars > SUMMARY_HEAD_CHARS ? "..." : "";
  return (
    `[spool-agent-output] 总长: ${totalChars} chars | ` +
    `完整输出: ${spoolPath} | ` +
    `=== 摘要 === ${head}${ellipsis}`
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

try {
  const payload = readStdin();
  if (!payload) {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  // Escape hatch
  const spoolEnv = (process.env.WORKER_OUTPUT_SPOOL || "").trim().toLowerCase();
  if (spoolEnv === "off" || spoolEnv === "0" || spoolEnv === "false") {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const { tool_name, tool_response } = payload;
  const toolName = tool_name || "";

  if (toolName !== "Agent" && toolName !== "Task") {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  if (!tool_response || typeof tool_response !== "object") {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const text = extractText(tool_response.content);
  const totalChars = text.length;

  if (totalChars <= OUTPUT_LIMIT_CHARS) {
    // Small output, pass through
    process.stdout.write("{}\n");
    process.exit(0);
  }

  // Big output: spool to disk
  const ts = Date.now();
  const dir = spoolDir();
  mkdirSync(dir, { recursive: true });
  const filename = spoolFilename(toolName, ts);
  const spoolPath = join(dir, filename);
  writeFileSync(spoolPath, text, { encoding: "utf8", mode: 0o600 });

  const summary = buildSummary(text, totalChars, spoolPath);

  // Replace content with summary
  let updatedResponse;
  if (typeof tool_response.content === "string") {
    updatedResponse = { ...tool_response, content: summary };
  } else if (Array.isArray(tool_response.content)) {
    updatedResponse = { ...tool_response, content: [{ type: "text", text: summary }] };
  } else {
    // Unrecognised shape → fail-open
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: updatedResponse,
    },
  };

  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
} catch (e) {
  process.stderr.write("[spool-agent-output] error: " + String(e) + "\n");
  process.stdout.write("{}\n");
  process.exit(0);
}
