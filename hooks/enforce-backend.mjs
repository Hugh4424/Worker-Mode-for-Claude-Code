#!/usr/bin/env node
// enforce-backend.mjs — PreToolUse hook: enforces backend consistency.
// Denies Task/Agent dispatches that cross the backend boundary (omc ↔ legacy).
// Also blocks legacy dispatches when omc-failure.marker is present (unless
// dispatch already targeting omc — never kill omc retries).
//
// Two codex bug fixes baked in:
// (a) Subagent exemption: use Boolean(agent_id) || transcript_path.includes("/subagents/")
//     NOT agent_id !== session_id (main session has undefined agent_id; undefined !== sessionId
//     is always true → every dispatch would wrongly appear to be a subagent).
// (b) Marker blocking: only block wantsLegacy dispatches, NOT omc dispatches.
//     Marker signals omc having trouble; blocking omc retries would be counterproductive.
//
// Backend classification (codex fix — replaces old startsWith(prefix) approach):
// - Uses classifyAgentBackend(subagentType, omcPrefix) → "omc" | "legacy" | "unknown"
// - Classification is based on the agent base-name roster, NOT prefix matching.
// - Works correctly in ALL environments including bare-name (prefix="") where startsWith("")
//   would match everything and provide no protection.
// - "unknown" agents are always allowed (fail-open for unrecognised agents).
//
// OMC installation detection:
// - resolveOmcPrefix() detects plugin ("oh-my-claudecode:"), bare-name (""), or not-installed (null).
// - Not-installed (prefix=null) + backend=omc: configuration error → deny with install hint.
//
// Fail-open on any exception (try-catch around entire logic).
// Only logs denies to .worker-mode/state/enforce-log.jsonl (O_APPEND atomic).
// Node ESM, zero external dependencies except tools/lib/resolve-omc-prefix.mjs.

import { readFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOmcPrefix, classifyAgentBackend } from "../tools/lib/resolve-omc-prefix.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── allow / deny output helpers ───────────────────────────────────────────────

function allow() {
  // Output empty object — Claude Code interprets absence of deny as allow.
  // Do NOT output permissionDecision: "allow"; only deny carries hookSpecificOutput.
  process.stdout.write("{}\n");
  process.exit(0);
}

function deny(message, logEntry) {
  // Append to enforce-log.jsonl (non-blocking)
  if (logEntry) {
    try {
      const stateDir = logEntry._stateDir;
      if (stateDir) {
        mkdirSync(stateDir, { recursive: true });
        const logPath = join(stateDir, "enforce-log.jsonl");
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          tool_name: logEntry.tool_name,
          subagent_type: logEntry.subagent_type,
          backend: logEntry.backend,
          decision: "deny",
          reason: logEntry.reason,
        }) + "\n";
        const fd = openSync(logPath, "a");
        try {
          writeSync(fd, Buffer.from(line, "utf8"));
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // write failure is non-blocking — never block the hook on log I/O
    }
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    }) + "\n"
  );
  process.exit(0);
}

function logNote(note, stateDir) {
  // Append informational note to enforce-log.jsonl (non-blocking, never deny).
  if (!stateDir) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    const logPath = join(stateDir, "enforce-log.jsonl");
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      decision: "note",
      ...note,
    }) + "\n";
    const fd = openSync(logPath, "a");
    try {
      writeSync(fd, Buffer.from(line, "utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    // non-blocking
  }
}

// ── stdin ─────────────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {
    return {}; // fail-open: bad JSON → empty object
  }
}

// ── project root resolution ───────────────────────────────────────────────────
// Mirror record-worker.mjs: use CLAUDE_PROJECT_DIR if set, else hookData.cwd.

function findStateDir(hookData) {
  const root = process.env.CLAUDE_PROJECT_DIR || hookData.cwd || "";
  if (!root) return null;
  return join(root, ".worker-mode", "state");
}

// ── main ──────────────────────────────────────────────────────────────────────

try {
  const hookData = readStdin();

  // 1. Only intercept Task or Agent tool calls.
  const toolName = hookData.tool_name || "";
  if (toolName !== "Task" && toolName !== "Agent") {
    allow();
  }

  // 2. Subagent exemption (codex fix a):
  //    Use Boolean(agent_id) || transcript_path.includes("/subagents/").
  //    Do NOT use agent_id !== session_id — main session has undefined agent_id,
  //    so undefined !== sessionId would always be true and break everything.
  const isSubagent =
    Boolean(hookData.agent_id) ||
    String(hookData.transcript_path || "").includes("/subagents/");
  if (isSubagent) {
    allow();
  }

  // 3. Get subagent_type — if missing, allow (nothing to enforce).
  const subagentType = hookData.tool_input?.subagent_type;
  if (!subagentType) {
    allow();
  }

  // 4. Read backend (default: "omc"). Trim and validate — only "omc" or "legacy"
  //    are accepted (case-sensitive).
  //    - env unset / empty string → LEGAL default "omc", no warning logged.
  //    - env set to a non-empty value that is neither "omc" nor "legacy" → invalid,
  //      fail-safe to "omc" AND log invalid_backend warning to enforce-log.jsonl.
  //    This mirrors the design contract: omc is the default, never invalid.
  const rawEnv = process.env.WORKER_MODE_BACKEND;
  const rawBackend = (rawEnv || "").trim();
  const stateDir = findStateDir(hookData);
  let backend;
  if (rawBackend === "omc" || rawBackend === "legacy") {
    backend = rawBackend;
  } else if (!rawBackend) {
    // env unset or empty string → legal default omc, no warning
    backend = "omc";
  } else {
    // Non-empty but unrecognised value → truly invalid, fail-safe + warn
    backend = "omc";
    // Log invalid_backend warning (best-effort, non-blocking).
    if (stateDir) {
      try {
        mkdirSync(stateDir, { recursive: true });
        const logPath = join(stateDir, "enforce-log.jsonl");
        const line =
          JSON.stringify({
            ts: new Date().toISOString(),
            tool_name: toolName,
            subagent_type: subagentType,
            backend: rawBackend,
            decision: "warn",
            reason: "invalid_backend",
          }) + "\n";
        const fd = openSync(logPath, "a");
        try {
          writeSync(fd, Buffer.from(line, "utf8"));
        } finally {
          closeSync(fd);
        }
      } catch {
        // non-blocking
      }
    }
  }

  // 5. Resolve OMC installation prefix dynamically.
  //    cwd from hookData (or CLAUDE_PROJECT_DIR) so we detect project-level bare agents too.
  const cwd = process.env.CLAUDE_PROJECT_DIR || hookData.cwd || process.cwd();
  // OMC_PROBE_HOME allows tests to inject a fake home directory for resolveOmcPrefix.
  const probeHome = process.env.OMC_PROBE_HOME || undefined;
  const { prefix: omcPrefix, source: omcSource, installPath: omcInstallPath } =
    resolveOmcPrefix({ cwd, home: probeHome });

  // 5a. OMC not installed (prefix=null) + backend=omc: configuration error.
  if (omcPrefix === null && backend === "omc") {
    deny(
      `WORKER_MODE_BACKEND=omc 但未检测到 OMC 安装。` +
        `\n请按 OMC 官方方式安装：/plugin marketplace add + /plugin install oh-my-claudecode@omc` +
        `\n或设 WORKER_MODE_BACKEND=legacy 使用自研 worker。` +
        `\n（当前检测到的 omc 前缀：${omcPrefix}，来源：${omcSource}）`,
      {
        _stateDir: stateDir,
        tool_name: toolName,
        subagent_type: subagentType,
        backend,
        reason: "omc_not_installed",
      }
    );
  }

  // 6. Classify agent backend using name roster (replaces old startsWith approach).
  //    classifyAgentBackend extracts the base name and looks it up in known rosters.
  //    Works in ALL environments — including bare-name (prefix="") where startsWith("")
  //    would match everything and provide no protection.
  //    "unknown" agents → allow (fail-open, we never deny what we don't recognise).
  const classification = classifyAgentBackend(subagentType, omcPrefix);

  // Determine target direction from classification.
  // Note: for legacy backend path, if omcPrefix is null we fall back to "oh-my-claudecode:"
  // for the deny message only (never used for classification logic).
  const effectivePrefixForMsg = omcPrefix !== null ? omcPrefix : "oh-my-claudecode:";
  const targetIsOmc = classification === "omc";
  const targetIsLegacy = classification === "legacy";
  // unknown agents are neither — they pass through (fail-open).
  const wantsLegacy = targetIsLegacy;
  const wantsOmc = targetIsOmc;

  // Log a note when we see an unknown agent (informational, not a deny).
  if (classification === "unknown") {
    logNote(
      {
        reason: "unknown_agent_allow",
        subagent_type: subagentType,
        backend,
        omc_source: omcSource,
        message: `Agent '${subagentType}' (base-name not in known rosters) — allowing (fail-open).`,
      },
      stateDir
    );
    allow();
  }

  // 7. Marker blocking (codex fix b):
  //    Only block legacy dispatches when marker is present — NOT omc dispatches.
  //    Blocking omc retries when omc is struggling would be counterproductive.
  //    Important: marker check runs AFTER classification, so bare-name omc agents
  //    that fail and produce a marker will correctly block subsequent legacy dispatches.
  const markerFile = stateDir ? join(stateDir, "omc-failure.marker") : null;
  const markerExists = markerFile ? existsSync(markerFile) : false;

  if (markerExists && wantsLegacy && backend !== "legacy") {
    deny(
      `omc-failure.marker 存在，已阻止降级到 legacy 后端。` +
        `请先排查 marker 原因，然后：删除 marker 后重试，` +
        `或设 WORKER_MODE_BACKEND=legacy 显式切换，` +
        `或运行 node tools/clear-failure-marker.mjs 清除。`,
      {
        _stateDir: stateDir,
        tool_name: toolName,
        subagent_type: subagentType,
        backend,
        reason: "marker_block",
      }
    );
  }

  // 8. Normal routing consistency check.
  if (backend === "omc" && wantsLegacy) {
    deny(
      `当前 omc 后端，请派 ${effectivePrefixForMsg}* agent（当前检测前缀：${omcPrefix}，来源：${omcSource}）；` +
        `要用 legacy 请设 WORKER_MODE_BACKEND=legacy`,
      {
        _stateDir: stateDir,
        tool_name: toolName,
        subagent_type: subagentType,
        backend,
        reason: "wrong_backend",
      }
    );
  }

  if (backend === "legacy" && wantsOmc) {
    deny(
      `当前 legacy 后端，请派自研 worker；要用 omc 请设 WORKER_MODE_BACKEND=omc` +
        `（当前检测前缀：${omcPrefix}，来源：${omcSource}）`,
      {
        _stateDir: stateDir,
        tool_name: toolName,
        subagent_type: subagentType,
        backend,
        reason: "wrong_backend",
      }
    );
  }

  // 9. All checks passed → allow.
  allow();
} catch {
  // Fail-open: any unhandled exception → allow with empty output.
  process.stdout.write("{}\n");
  process.exit(0);
}
