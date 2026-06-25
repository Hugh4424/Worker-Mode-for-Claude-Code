#!/usr/bin/env node
// check-config.mjs — SessionStart config reminder + compact restore reminder
// (FR-PKG-002 / SIG-002 / D-降本)
//
// plugin.json has no native "required config" mechanism, so this SessionStart
// hook surfaces the mandatory WORKER_LOG_PATH at session startup — at the moment
// work begins, not after the first worker finishes.
//
// Also: when source="compact" (auto-compression restart), injects a reminder to
// read .worker-mode/state/current.json to restore stage/progress/risks before
// resuming orchestration.
//
// IMPORTANT — pure reminder, never a block: this plugin promises "zero
// interception, nothing ever stops you" (FR-ORCH-006 / FR-LOG-006). SessionStart
// is a non-blockable event, and using a blocking-style exit here would still
// contradict that basis by framing a missing config as an error fed to the
// model. So this guard ALWAYS exits 0 and, when the config is missing/invalid,
// injects a reminder via SessionStart `additionalContext` (the supported way to
// surface startup context). It never blocks the session. The actual fail-loud
// hard stop stays where it belongs — in record-worker.mjs, right before writing
// a record (so we never silently write to the wrong place).
//
// Design: collect ALL messages first, then emit ONE merged additionalContext.
// Never process.exit(0) mid-way — that would swallow subsequent reminders.
// ponytail: reuses existing hook file, no new hook added.

import { isAbsolute } from "node:path";

// ── read stdin payload (source field distinguishes startup vs compact) ────────
// Confirmed from real transcripts: hookName = "SessionStart:<source>"; stdin
// payload carries a top-level `source` field with values "startup", "compact",
// "resume", "clear". See openviking session-start.mjs for corroboration.
let source = "startup"; // safe default
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString().trim();
  if (raw) {
    const payload = JSON.parse(raw);
    source = payload.source || "startup";
  }
} catch {
  // fail-open: unparseable stdin → treat as normal startup, no compact branch
}

const workerLogPath = process.env.WORKER_LOG_PATH || "";
const workerModeBackend = process.env.WORKER_MODE_BACKEND || "omc";

// ── collect all reminders, emit once at the end ──────────────────────────────
const messages = [];

// Config reminder (unchanged logic, just no longer exits early)
if (!workerLogPath) {
  messages.push(
    "WORKER_LOG_PATH not set — delegation metrics not recorded until you configure it. " +
      "Set it absolute path, e.g. export WORKER_LOG_PATH=/abs/path/to/worker-log.jsonl"
  );
} else if (!isAbsolute(workerLogPath)) {
  messages.push(
    `WORKER_LOG_PATH is set non-absolute path ("${workerLogPath}"). ` +
      "Use absolute path records always land in the same place regardless of cwd, " +
      "e.g. export WORKER_LOG_PATH=/abs/path/to/worker-log.jsonl"
  );
}

// Backend hint — always shown so foreman knows which routing is active
if (workerModeBackend === "legacy") {
  messages.push("[Worker-Mode] 当前执行后端: legacy（派活走 agents/ 下自研 worker）");
} else {
  messages.push("[Worker-Mode] 当前执行后端: omc（派活走 oh-my-claudecode:* agent）");
}

// Compact restore reminder (D-降本: post-compression, reload state from disk)
if (source === "compact") {
  messages.push(
    "压缩后请先读 .worker-mode/state/current.json 恢复阶段/进度/风险，再继续调度；" +
      "详细发现在 .worker-mode/state/artifacts.jsonl。"
  );
}

// ── emit one merged output (or nothing if no reminders) ──────────────────────
if (messages.length > 0) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[Worker-Mode-for-Claude-Code] ${messages.join("\n")}`,
      },
    }) + "\n"
  );
}

process.exit(0);
