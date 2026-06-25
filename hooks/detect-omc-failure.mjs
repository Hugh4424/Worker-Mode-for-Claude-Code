#!/usr/bin/env node
// detect-omc-failure.mjs — PostToolUseFailure hook: detects Task/Agent failures for omc backends
// and writes .worker-mode/state/omc-failure.marker as a fail-stop signal.
//
// PostToolUseFailure only fires when the tool has already failed — entering this hook
// already means failure. No need to check is_error; the event itself is the signal.
// Payload shape: { tool_name, tool_input, error (string), session_id, agent_id }
//                NO tool_response field.
//
// Single responsibility: write the marker. enforce-backend.mjs reads it; clear-failure-marker.mjs removes it.
// Marker path MUST stay in sync with those two files:
//   join(CLAUDE_PROJECT_DIR || cwd, ".worker-mode", "state", "omc-failure.marker")
//
// Fail-open on ALL errors: bad stdin, missing fields, write failure → exit 0 silently.
// PostToolUseFailure output: empty object {} (no deny needed; this is an observer hook).
// Node ESM, zero external dependencies.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOmcPrefix, classifyAgentBackend } from "../tools/lib/resolve-omc-prefix.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── stdin ─────────────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {
    return null; // parse failure → fail-open
  }
}

// ── project root resolution ────────────────────────────────────────────────────
// Mirror enforce-backend.mjs and clear-failure-marker.mjs exactly:
//   process.env.CLAUDE_PROJECT_DIR || hookData.cwd
// so all three files resolve the same marker path.

function findMarkerPath(hookData) {
  const root = process.env.CLAUDE_PROJECT_DIR || hookData.cwd || "";
  if (!root) return null;
  return join(root, ".worker-mode", "state", "omc-failure.marker");
}

// ── main ──────────────────────────────────────────────────────────────────────

try {
  const payload = readStdin();

  // Fail-open on bad stdin.
  if (!payload || typeof payload !== "object") {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const { tool_name, tool_input, error, session_id, agent_id } = payload;

  // 1. Only process Task or Agent tools.
  if (tool_name !== "Task" && tool_name !== "Agent") {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  // 2. Sub-agent exemption: only trigger on orchestrator-dispatched tasks.
  //    Mirrors enforce-backend.mjs exactly (与 enforce-backend 保持一致):
  //      Boolean(agent_id) || transcript_path contains "/subagents/"
  //    Do NOT use agent_id !== session_id — main session has undefined agent_id;
  //    undefined !== sessionId is always true → every dispatch wrongly exempt.
  const isSubagent =
    Boolean(agent_id) ||
    String(payload.transcript_path || "").includes("/subagents/");
  if (isSubagent) {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  // 3. Only write marker for omc failures.
  //    Use classifyAgentBackend (not hardcoded startsWith) so bare-name OMC agents
  //    (e.g. "executor" without prefix) are also correctly detected as omc failures.
  const subagentType = tool_input?.subagent_type || "";
  const cwd = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const probeHome = process.env.OMC_PROBE_HOME || undefined;
  const { prefix: omcPrefix } = resolveOmcPrefix({ cwd, home: probeHome });
  const agentClass = classifyAgentBackend(subagentType, omcPrefix);
  if (agentClass !== "omc") {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  // 4. Write marker.
  const markerPath = findMarkerPath(payload);
  if (!markerPath) {
    // No project root resolvable — fail-open.
    process.stdout.write("{}\n");
    process.exit(0);
  }

  try {
    const markerDir = join(markerPath, "..");
    mkdirSync(markerDir, { recursive: true });
    const content = JSON.stringify({
      ts: new Date().toISOString(),
      subagent_type: subagentType,
      tool_name,
      reason: "omc_agent_failed",
      error: error || null,
      session_id: session_id || null,
    });
    writeFileSync(markerPath, content, { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    // Write failure → fail-open, no crash.
    process.stderr.write("[detect-omc-failure] write failed, fail-open: " + e.message + "\n");
  }

} catch {
  // Any unhandled exception → fail-open.
}

process.stdout.write("{}\n");
process.exit(0);
