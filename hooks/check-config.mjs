#!/usr/bin/env node
// check-config.mjs — SessionStart config reminder (FR-PKG-002 / SIG-002)
//
// plugin.json has no native "required config" mechanism, so this SessionStart
// hook surfaces the mandatory WORKER_LOG_PATH at session startup — at the moment
// work begins, not after the first worker finishes.
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

import { isAbsolute } from "node:path";

const workerLogPath = process.env.WORKER_LOG_PATH || "";

function remind(message) {
  // SessionStart additionalContext: surfaced to the model so it can relay the
  // reminder to the user. exit 0 — non-blocking.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[Worker-Mode-for-Claude-Code] ${message}`,
      },
    }) + "\n"
  );
  process.exit(0);
}

if (!workerLogPath) {
  remind(
    "WORKER_LOG_PATH is not set — delegation metrics will not be recorded until you configure it. " +
      "Set it to an absolute path, e.g. export WORKER_LOG_PATH=/abs/path/to/worker-log.jsonl"
  );
}

if (!isAbsolute(workerLogPath)) {
  remind(
    `WORKER_LOG_PATH is set to a non-absolute path ("${workerLogPath}"). ` +
      "Use an absolute path so records always land in the same place regardless of cwd, " +
      "e.g. export WORKER_LOG_PATH=/abs/path/to/worker-log.jsonl"
  );
}

// Configured with an absolute path. Nothing to surface.
process.exit(0);
