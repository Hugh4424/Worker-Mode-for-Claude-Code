#!/usr/bin/env node
// spool-tool-output.mjs — PostToolUse hook: spools large tool outputs to disk,
// replacing the in-context text with a compact summary + file path.
// Goal: reduce foreman context bloat from large self-reads (Bash/Read/Grep).
//
// Fail-open on ALL errors: stdin parse failure, write failure, unknown shape,
// unrecognised tool — exit 0 without printing hookSpecificOutput (= no replacement).
// All debug/status logging goes to stderr only.
//
// Node ESM, zero external dependencies.
//
// ponytail: PostToolUseFailure CANNOT reuse this script. Its payload shape is
// { tool_name, tool_input, error, session_id, agent_id } with NO tool_response
// field — only an error string. This script needs tool_response to extract text,
// so it will always fail-open on failure events. Spooling failure output requires
// a separate script that reads payload.error directly (not in this batch).

import { readFileSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";

// ── stdin ─────────────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {
    return null; // parse failure → fail-open
  }
}

// ── classifier ────────────────────────────────────────────────────────────────
// Dynamic import so we can gracefully fail-open if the module path is wrong.
let isBigSelfChunk;
try {
  // __dirname not available in ESM; resolve relative to this file.
  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const mod = await import(join(__dirname, "../tools/lib/self-work-classifier.mjs"));
  isBigSelfChunk = mod.isBigSelfChunk;
} catch (e) {
  process.stderr.write("[spool-tool-output] failed to load classifier, fail-open: " + e.message + "\n");
  process.exit(0);
}

// ── constants ─────────────────────────────────────────────────────────────────

// Redline: only paths inside a .worker-mode/ directory segment are exempt from
// spooling — these are Worker-Mode's own state files the foreman must read in full.
// Uses directory-segment boundary matching (not substring includes) so that
// /tmp/foo.worker-mode-backup/x or /repo/bar.worker-mode.md are NOT exempted.
// The `=` boundary preserves Bash env-assignment tokens like FILE=.worker-mode/state/x.
const WORKER_MODE_SEGMENT_RE = /(^|[=\/])\.worker-mode([\/]|$)/;

// Head/tail line count for summary.
// ponytail: fixed head+tail truncation may drop critical middle content (e.g. a
// function body sandwiched between a long import block and a long export list).
// Upgrade path: semantic-section truncation (detect blank-line paragraph breaks,
// keep first+last N sections instead of raw lines). Only worth building if
// false-negatives from mid-file crops become observable problems.
const SUMMARY_HEAD_LINES = 20;
const SUMMARY_TAIL_LINES = 20;

// Retention thresholds
const SPOOL_MAX_FILES = 100;
const SPOOL_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const SPOOL_CLEANUP_FRACTION = 0.20;      // delete oldest 20%

// ── helpers ──────────────────────────────────────────────────────────────────

function isRedlinePath(pathStr) {
  if (typeof pathStr !== "string" || !pathStr) return false;
  return WORKER_MODE_SEGMENT_RE.test(pathStr);
}

// ── Bash token scanner ────────────────────────────────────────────────────────
// Loose matching: prefer false-exempt over false-spool.
//
// Redline errors are asymmetric:
//   miss-exempt (fail to exempt a .worker-mode/ path) → foreman state reads
//     are spool-truncated → SEVERE, breaks redline's core purpose.
//   false-exempt (exempt a non-path .worker-mode/ mention like a grep pattern
//     or echo text) → one big output misses spooling → MILD, coverage loss only.
//
// Therefore we deliberately avoid shell parsing — no command-name recognition,
// no URL filtering, no comment stops, no pattern-operand skipping. Any token
// that contains .worker-mode/ as a directory segment triggers exemption.
// Returns the normalized token string, or "" if no worker-mode path found.
function extractBashRedlinePath(cmd) {
  if (!cmd || typeof cmd !== "string") return "";
  const tokens = cmd.split(/\s+/);
  if (tokens.length === 0) return "";

  for (const t of tokens) {
    // Normalize: strip ALL quotes so env assignments like
    //   FILE=".worker-mode/state/x" → FILE=.worker-mode/state/x
    // match the segment regex via the `=` boundary.
    const normalized = t.replace(/["']/g, "");
    if (isRedlinePath(normalized)) return normalized;
  }
  return "";
}

// Extract the "interesting path" from a tool invocation for redline checks.
function toolInputPath(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (toolName === "Read") return toolInput.file_path || "";
  if (toolName === "Grep") return toolInput.path || "";
  if (toolName === "Bash") return extractBashRedlinePath(toolInput.command || "");
  return "";
}

// Sanitise a string for use as a filename fragment.
function sanitise(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

// Generate a unique spool filename.
function spoolFilename(sessionId, toolName) {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  const pid = process.pid;
  return `${sanitise(sessionId)}-${sanitise(toolName)}-${ts}-${pid}-${rand}.txt`;
}

// Resolve the spool directory root.
function spoolRoot(cwd) {
  const base =
    process.env.CLAUDE_PROJECT_DIR ||
    cwd ||
    process.cwd();
  return join(base, ".worker-mode", "state", "tool-output");
}

// Resolve the event log directory root.
function eventLogRoot(cwd) {
  const base =
    process.env.CLAUDE_PROJECT_DIR ||
    cwd ||
    process.cwd();
  return join(base, ".worker-mode", "spool");
}

// Build a compact text summary (head + tail + stats).
function buildSummary(text, totalBytes, spoolPath, toolName, toolResponse) {
  const lines = text.split("\n");
  const totalLines = lines.length;
  let head, tail, middle;

  if (totalLines <= SUMMARY_HEAD_LINES + SUMMARY_TAIL_LINES) {
    // Short enough — this branch shouldn't normally be reached (classifier guards),
    // but be safe: summarise anyway if we're here.
    head = lines;
    tail = [];
    middle = "";
  } else {
    head = lines.slice(0, SUMMARY_HEAD_LINES);
    tail = lines.slice(-SUMMARY_TAIL_LINES);
    middle = `\n...[${totalLines - SUMMARY_HEAD_LINES - SUMMARY_TAIL_LINES} lines omitted] ...\n`;
  }

  const parts = [
    `[spool-tool-output: ${toolName} output truncated for context efficiency]`,
    `Total: ${totalLines} lines / ${totalBytes} bytes`,
    `Full output: ${spoolPath}`,
    "",
    "=== HEAD ===",
    head.join("\n"),
    middle,
    tail.length > 0 ? "=== TAIL ===" : "",
    tail.length > 0 ? tail.join("\n") : "",
  ];

  // For Bash: if stderr is non-empty, always append it in full (up to a cap)
  // so the foreman can diagnose failures. Never spool away the error signal.
  const stderr = toolResponse && toolResponse.stderr;
  if (toolName === "Bash" && typeof stderr === "string" && stderr.trim()) {
    const stderrLines = stderr.split("\n");
    const MAX_STDERR = 50;
    const stderrFragment =
      stderrLines.length > MAX_STDERR
        ? stderrLines.slice(-MAX_STDERR).join("\n")
        : stderr;
    parts.push("", "=== STDERR (preserved) ===", stderrFragment);
  }

  return parts.filter((p) => p !== null && p !== undefined).join("\n");
}

// ── retention cleanup ─────────────────────────────────────────────────────────

function cleanupSpoolDir(dir) {
  try {
    const entries = readdirSync(dir);
    if (entries.length === 0) return;

    let totalSize = 0;
    const files = [];
    for (const name of entries) {
      const fp = join(dir, name);
      try {
        const st = statSync(fp);
        if (st.isFile()) {
          files.push({ path: fp, mtime: st.mtimeMs, size: st.size });
          totalSize += st.size;
        }
      } catch {
        // ignore unreadable entries
      }
    }

    const overFiles = files.length > SPOOL_MAX_FILES;
    const overBytes = totalSize > SPOOL_MAX_BYTES;
    if (!overFiles && !overBytes) return;

    // Sort oldest first, delete oldest 20% (ceil)
    files.sort((a, b) => a.mtime - b.mtime);
    const deleteCount = Math.ceil(files.length * SPOOL_CLEANUP_FRACTION);
    for (let i = 0; i < deleteCount; i++) {
      try {
        unlinkSync(files[i].path);
      } catch {
        // ignore unlink failures
      }
    }

    process.stderr.write(
      `[spool-tool-output] retention cleanup: deleted ${deleteCount} oldest files (${overFiles ? "file count" : ""}${overFiles && overBytes ? " + " : ""}${overBytes ? "size" : ""} threshold exceeded)\n`
    );
  } catch (e) {
    process.stderr.write("[spool-tool-output] retention cleanup failed, continuing: " + e.message + "\n");
  }
}

// ── event logging ─────────────────────────────────────────────────────────────

function logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath }) {
  try {
    const dir = eventLogRoot(cwd);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "spool-events.jsonl");
    const entry = {
      ts: new Date().toISOString(),
      tool: toolName,
      input_bytes: textBytes,
      input_lines: textLines,
      action,
      ...(spoolPath ? { spool_path: spoolPath } : {}),
    };
    appendFileSync(logPath, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch (e) {
    process.stderr.write("[spool-tool-output] event log failed: " + e.message + "\n");
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  let action = "passed_through";
  let textBytes = 0;
  let textLines = 0;
  let spoolPath = null;
  let cwd = null;
  let toolName = "";

  try {
    // 1. Read stdin.
    const payload = readStdin();
    if (payload === null) {
      // Parse failure → fail-open, no replacement.
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    // 2. Escape hatch.
    const spoolEnv = (process.env.WORKER_OUTPUT_SPOOL || "").trim().toLowerCase();
    if (spoolEnv === "off" || spoolEnv === "0" || spoolEnv === "false") {
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    const { session_id, tool_name, tool_input, tool_response, transcript_path, cwd: payloadCwd, agent_id } = payload;
    cwd = payloadCwd;
    toolName = tool_name || "";

    // 3. Subagent exemption: only spool foreman self-reads, not subagent output.
    if (agent_id) {
      process.stderr.write("[spool-tool-output] subagent (agent_id present), skipping\n");
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }
    if (typeof transcript_path === "string" && transcript_path.includes("/subagents/")) {
      process.stderr.write("[spool-tool-output] subagent (transcript_path /subagents/), skipping\n");
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    // 4. Redline: Worker-Mode state paths (.worker-mode/ directory) are exempt from spooling.
    const inputPath = toolInputPath(tool_name, tool_input);
    if (isRedlinePath(inputPath)) {
      action = "redline_skip";
      process.stderr.write("[spool-tool-output] redline path, skipping: " + inputPath + "\n");
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    // 5. Use classifier to decide if this is a big chunk.
    // isBigSelfChunk expects { toolUse: {name, input}, result: {bytes, lines, isError} }.
    // We compute bytes/lines from the actual text field of the tool_response.
    let textContent = null;
    let fieldPath = null; // describes which field we'll replace

    if (!tool_response || typeof tool_response !== "object") {
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    if (tool_name === "Bash") {
      const stdout = tool_response.stdout;
      if (typeof stdout === "string") {
        textContent = stdout;
        fieldPath = "stdout";
      }
    } else if (tool_name === "Read") {
      const file = tool_response.file;
      if (file && typeof file === "object" && typeof file.content === "string") {
        textContent = file.content;
        fieldPath = "file.content";
      }
    } else if (tool_name === "Grep") {
      const content = tool_response.content;
      if (typeof content === "string") {
        textContent = content;
        fieldPath = "content";
      }
    } else {
      // ponytail: Glob removed from matcher (hooks.json) — filenames lists are rarely
      // large enough to justify spooling (YAGNI / no-op bloat: disk write without
      // context reduction). Upgrade path: add "Glob" back to matcher and implement
      // filenames-array truncation here if glob result sets become observable bloat.
      //
      // Unknown tool (or Glob if somehow still routed here) → fail-open.
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    if (textContent === null) {
      // Shape not recognised (field missing) → fail-open.
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    textBytes = textContent.length;
    textLines = textContent.split("\n").length;

    const { isBigSelfRead } = isBigSelfChunk({
      toolUse: { name: tool_name, input: tool_input || {} },
      result: { bytes: textBytes, lines: textLines, isError: false },
    });

    if (!isBigSelfRead) {
      // Small output, no spooling needed.
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    // 6. Big chunk: spool original, build summary, shape-preserving replace.

    // a. Spool original to disk (with retention cleanup first).
    try {
      const dir = spoolRoot(cwd);
      mkdirSync(dir, { recursive: true });
      cleanupSpoolDir(dir);
      const filename = spoolFilename(session_id || "unknown", tool_name);
      spoolPath = join(dir, filename);
      writeFileSync(spoolPath, textContent, { encoding: "utf8", mode: 0o600 });
      action = "spooled";
    } catch (e) {
      // Write failure → fail-open, no replacement.
      process.stderr.write("[spool-tool-output] write failed, fail-open: " + e.message + "\n");
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    // b. Generate summary.
    const summary = buildSummary(textContent, textBytes, spoolPath, tool_name, tool_response);

    // c. Shape-preserving clone: only overwrite the one text field.
    let updatedResponse;
    try {
      if (fieldPath === "stdout") {
        // Bash: replace stdout, keep all other fields (stderr, interrupted, isImage, etc.)
        updatedResponse = { ...tool_response, stdout: summary };
      } else if (fieldPath === "file.content") {
        // Read: replace file.content, keep file.filePath and other file fields
        updatedResponse = {
          ...tool_response,
          file: { ...tool_response.file, content: summary },
        };
      } else if (fieldPath === "content") {
        // Grep: replace content, keep mode/numFiles/filenames/numLines
        updatedResponse = { ...tool_response, content: summary };
      } else {
        // fieldPath unrecognised → fail-open.
        logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
        process.exit(0);
      }
    } catch (e) {
      process.stderr.write("[spool-tool-output] shape clone failed, fail-open: " + e.message + "\n");
      logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
      process.exit(0);
    }

    // d. Emit single JSON to stdout for Claude Code to consume.
    // updatedToolOutput must be the raw object — Claude Code validates the shape
    // and rejects strings ("expected object, received string").
    const out = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: updatedResponse,
      },
    };

    process.stdout.write(JSON.stringify(out) + "\n");
    logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
    process.exit(0);
  } catch (e) {
    // Outermost catch: any unexpected exception (including isBigSelfChunk not being
    // a function, or other runtime errors) → fail-open, no replacement.
    process.stderr.write("[spool-tool-output] unexpected error, fail-open: " + String(e) + "\n");
    logEvent({ cwd, toolName, textBytes, textLines, action, spoolPath });
    process.exit(0);
  }
})();
