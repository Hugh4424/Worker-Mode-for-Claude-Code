#!/usr/bin/env node
// record-worker.mjs — SubagentStop hook: appends one JSON record per worker.
// Post-hoc logging only; no interception, no behavior change (FR-LOG-006).
// Node ESM, no external dependencies.
//
// KNOWN LIMITATION — subagent crash before SubagentStop fires:
//   When a subagent exits abnormally (API stream timeout, server disconnect, etc.)
//   Claude Code may not fire SubagentStop at all, so this hook never runs and the
//   dispatch goes completely unrecorded. This is a fundamental hook-mechanism
//   constraint that cannot be fixed inside record-worker.mjs.
//   Root fix requires a complementary SubagentStart hook that pre-creates a
//   placeholder record (keyed by dispatch_id) which this hook then upserts on
//   success. That two-hook design is the correct long-term solution; it is NOT
//   implemented here. When SubagentStop does fire but the transcript is incomplete
//   (partial crash), this script writes a status=incomplete placeholder instead of
//   dropping the record entirely (see "incomplete path" below).

import { createRequire } from "node:module";
import { readFileSync, existsSync, mkdirSync, appendFileSync, openSync, writeSync, closeSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveOmcPrefix, classifyAgentBackend } from "../tools/lib/resolve-omc-prefix.mjs";

// ── single-run wall-clock guard (FR-REC-004 ②) ────────────────────────────────
// The script is fully synchronous, so a timer/AbortController would never fire.
// Instead capture a wall-clock start and check elapsed time right before the
// append; if the single run exceeds the (env-overridable) limit we failHard and
// write NO record — a slow/hung collection must never silently append.
const RUN_START_MS = Date.now();
const RUN_TIMEOUT_MS = (() => {
  const raw = process.env.WORKER_RECORD_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30000; // default 30s ceiling
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
})();

// ── helpers ──────────────────────────────────────────────────────────────────

// Read a transcript JSONL. The FILE itself is a hard dependency: if it cannot be
// read, throw so the caller fails loud (no silent zero-metric records — let it
// crash). Malformed INDIVIDUAL lines in a readable file are still skipped.
function readJsonlLines(filePath) {
  const raw = readFileSync(filePath, "utf8"); // throws if unreadable — intentional
  const lines = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines — never throw on a single bad transcript line
    }
  }
  return lines;
}

// Hard-dependency failure: print guidance and exit non-zero WITHOUT writing any
// record. Used only for infrastructure/config failures (missing paths, unreadable
// transcripts, timeout exceeded) where even a placeholder would be misleading.
// For "transcript arrived but metrics incomplete" use writeIncomplete() instead.
function failHard(reason) {
  process.stderr.write("[record-worker] hard-dependency failure: " + reason + "\n" +
    "Refusing to write a worker-log record with missing metrics. No record appended.\n");
  process.exit(1);
}

// Soft-dependency failure: transcript arrived (SubagentStop fired) but the data
// inside is incomplete (subagent crashed mid-run). We write a status=incomplete
// placeholder with whatever fields we have, so the dispatch is not lost entirely.
// Callers must provide the partial record object (fields may be null/0/"") and
// logPath (workerLogPath is available at call site but not here at definition time).
function writeIncomplete(reason, partialRecord, logPath) {
  // Same single-run time bound as the normal record path (FR-REC-004 ②):
  // if we are already over budget, refuse to write anything — even a placeholder.
  // "over time-limit" is a hard-dependency failure (infrastructure problem),
  // not a soft one; writeIncomplete is for data-quality issues, not hung runs.
  const elapsedMs = Date.now() - RUN_START_MS;
  if (RUN_TIMEOUT_MS === 0 || elapsedMs > RUN_TIMEOUT_MS) {
    failHard("single-run time limit exceeded (" + elapsedMs +
      "ms > " + RUN_TIMEOUT_MS + "ms); no record appended (incomplete path)");
  }
  process.stderr.write("[record-worker] incomplete data, writing placeholder: " + reason + "\n");
  const record = Object.assign({}, partialRecord, {
    status: "incomplete",
    incomplete_reason: reason,
  });
  mkdirSync(dirname(logPath), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  const fd = openSync(logPath, "a");
  try {
    writeSync(fd, Buffer.from(line, "utf8"));
  } finally {
    closeSync(fd);
  }
  process.exit(0);
}

// A valid usage-bearing assistant message: has an id and a usage object carrying at
// least one numeric token field. Required-usage messages are filtered through this
// at the SOURCE so missing usage can never silently become a zero metric.
function hasValidUsage(l) {
  return l && l.type === "assistant" && l.message && l.message.id && l.message.usage &&
    (typeof l.message.usage.input_tokens === "number" || typeof l.message.usage.output_tokens === "number");
}

// Input-side usage check: at least one input-side field (input_tokens, cache_creation, or
// cache_read) is present as a number. Used for input-class metrics (orchestrator_input_tokens,
// orchestrator_new_input_tokens, orchestrator_new_input_ratio, context_peak) so that
// messages carrying ONLY output_tokens do not contribute a spurious zero to input sums,
// and messages with only cache fields are correctly included.
function hasInputUsage(l) {
  if (!l || !l.message || !l.message.id || !l.message.usage) return false;
  const u = l.message.usage;
  return (
    typeof u.input_tokens === "number" ||
    typeof u.cache_creation_input_tokens === "number" ||
    typeof u.cache_read_input_tokens === "number"
  );
}

// ── stdin ─────────────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {
    return {};
  }
}

// ── config guard (SIG-002 / FR-PKG-002) ──────────────────────────────────────

const workerLogPath = process.env.WORKER_LOG_PATH || "";
if (!workerLogPath) {
  process.stderr.write(
    "[record-worker] Configuration error: WORKER_LOG_PATH is not set.\n" +
    "Set WORKER_LOG_PATH to the absolute path of the unified worker-log JSONL file.\n" +
    "Example: export WORKER_LOG_PATH=/path/to/worker-log.jsonl\n"
  );
  process.exit(1);
}
if (!isAbsolute(workerLogPath)) {
  process.stderr.write(
    "[record-worker] Configuration error: WORKER_LOG_PATH must be an absolute path, got: " + workerLogPath + "\n" +
    "A relative path would resolve against the current working directory and scatter records.\n" +
    "Example: export WORKER_LOG_PATH=/path/to/worker-log.jsonl\n"
  );
  process.exit(1);
}

// ── parse stdin ───────────────────────────────────────────────────────────────

const hookData = readStdin();
const sessionId = hookData.session_id || "";
const orchPath = hookData.transcript_path || "";
const subPath = hookData.agent_transcript_path || "";
const lastMsg = hookData.last_assistant_message || "";
// subagent_type source (FR-REC-002): SubagentStop stdin carries `agent_type`
// (the dispatched agent's frontmatter name). Sentinel "unknown" when absent so a
// missing type is a legal recorded state, never an empty/missing field.
const subagentType = hookData.agent_type || "unknown";
// backend: classify via shared roster-based function (not hardcoded startsWith).
// classifyAgentBackend handles bare-name envs ("executor" → "omc") and plugin envs
// ("oh-my-claudecode:executor" → "omc") correctly without prefix-matching brittleness.
// "unknown" agents fall back to "legacy" label for logging purposes (conservative).
const hookCwdForProbe = hookData.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const probeHomeForRecord = process.env.OMC_PROBE_HOME || undefined;
const { prefix: omcPrefixForRecord } = resolveOmcPrefix({ cwd: hookCwdForProbe, home: probeHomeForRecord });
const agentClassification = classifyAgentBackend(subagentType, omcPrefixForRecord);
const backend = agentClassification === "omc" ? "omc" : "legacy";
// cwd is the orchestrator working directory — used to run the version-diff source.
const hookCwd = hookData.cwd || "";

// ── dispatch_id: idempotency key (FR-REC-005) ────────────────────────────────
// AGENT_TEAMS=1 mode can deliver the same SubagentStop to multiple processes.
// We guard with a dispatch_id (toolUseId from sibling meta.json, or transcript
// filename fallback) checked against the log before writing.
// Concurrency: check-then-write is NOT atomic; rare duplicates are deduplicated
// on next read (same dispatch_id). O_APPEND keeps lines non-interleaved.
// TODO: if duplicate rate rises, add O_EXCL lockfile around read-check-write.

// Read dispatch_id early (before any transcript processing) so we can bail fast.
function computeDispatchId(agentTranscriptPath) {
  if (!agentTranscriptPath) return null;
  // Preferred: toolUseId from sibling .meta.json (globally unique per dispatch).
  const metaPath = agentTranscriptPath.replace(/\.jsonl$/, ".meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const id = meta && meta.toolUseId;
    if (typeof id === "string" && id) return id;
  } catch { /* no meta → fall through */ }
  // Fallback: session_id + ":" + agent transcript filename. Using only the
  // basename risks cross-session collision when the same agent filename is
  // reused across sessions (e.g. test/recovery flows). Prefixing with
  // session_id makes the key session-scoped and much harder to collide.
  return sessionId + ":" + basename(agentTranscriptPath);
}

const dispatchId = computeDispatchId(subPath);

// Idempotency check: scan existing log for a record with the same dispatch_id.
// Only perform the scan when the log file exists and dispatchId is known.
if (dispatchId && existsSync(workerLogPath)) {
  try {
    const existing = readFileSync(workerLogPath, "utf8");
    for (const rawLine of existing.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        if (rec && rec.dispatch_id === dispatchId) {
          // Duplicate: this dispatch_id is already recorded. Skip silently.
          process.stderr.write(
            "[record-worker] skipping duplicate: dispatch_id " + dispatchId + " already in log\n"
          );
          process.exit(0);
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* log unreadable — proceed to write (best-effort) */ }
}

// ── orchestrator transcript (SESSION fields) ──────────────────────────────────

// Transcript paths are hard dependencies — missing path = cannot compute metrics.
if (!orchPath) failHard("stdin.transcript_path (orchestrator transcript) missing");
if (!subPath) failHard("stdin.agent_transcript_path (subagent transcript) missing");

let orchLines;
try {
  orchLines = readJsonlLines(orchPath);
} catch (e) {
  failHard("orchestrator transcript unreadable: " + orchPath + " (" + e.message + ")");
}
// Only assistant messages with a valid usage object count toward session metrics.
const orchAssistantMsgs = orchLines.filter(hasValidUsage);
// All orchestrator assistant messages (regardless of usage) for tool-use counting.
// tool_call_composition is a behavioral statistic and must not depend on usage integrity.
const orchAllAssistantMsgs = orchLines.filter((l) => l && l.type === "assistant" && l.message);

// Dedup by message.id (over the usage-valid set — for token/context metrics).
// Keep the record with the highest output_tokens for each id: streaming produces
// intermediate snapshots (output=1) before the final value; first-seen would keep
// the snapshot and severely underestimate output. Taking max output is always correct.
const orchBestById = new Map();
for (const l of orchAssistantMsgs) {
  const id = l.message.id;
  const out = l.message.usage?.output_tokens ?? 0;
  if (!orchBestById.has(id) || out > (orchBestById.get(id).message.usage?.output_tokens ?? 0)) {
    orchBestById.set(id, l);
  }
}
const orchDeduped = [...orchBestById.values()];

// Dedup by message.id (over the input-usage set — for input-class metrics only).
// hasInputUsage guards: only messages with at least one input-side field are included,
// so output-only messages cannot contribute a spurious 0 to input sums, and
// cache-only messages (cache_read or cache_creation without input_tokens) are included.
// Same max-output dedup strategy as orchDeduped.
const orchInputMsgs = orchLines.filter(hasInputUsage);
const orchInputBestById = new Map();
for (const l of orchInputMsgs) {
  const id = l.message.id;
  const out = l.message.usage?.output_tokens ?? 0;
  if (!orchInputBestById.has(id) || out > (orchInputBestById.get(id).message.usage?.output_tokens ?? 0)) {
    orchInputBestById.set(id, l);
  }
}
const orchInputDeduped = [...orchInputBestById.values()];

// orchestrator_tokens: sum of (input + output + cache_read + cache_creation) per unique message
let orchestratorTokens = 0;
for (const l of orchDeduped) {
  const u = l.message.usage || {};
  orchestratorTokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// orchestrator_input_tokens: pure-input context (input + cache_creation + cache_read) per unique message
// orchestrator_new_input_tokens: non-cache-read new input (input + cache_creation) per unique message
// orchestrator_new_input_ratio: new input / total input (null when denominator is 0)
// These are pure input-side metrics; output_tokens is intentionally excluded.
// Uses orchInputDeduped (not orchDeduped): hasInputUsage ensures only messages with at
// least one input-side field are included — output-only messages are excluded to prevent
// a spurious true-0 from polluting the input sum, and cache-only messages are included.
let orchestratorInputTokens = 0;
let orchestratorNewInputTokens = 0;
for (const l of orchInputDeduped) {
  const u = l.message.usage || {};
  const inp = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  orchestratorInputTokens += inp + cacheCreate + cacheRead;
  orchestratorNewInputTokens += inp + cacheCreate;
}
const orchestratorNewInputRatio = orchestratorInputTokens > 0
  ? orchestratorNewInputTokens / orchestratorInputTokens
  : null;

// orchestrator_action_count: count DISTINCT tool_use blocks across ALL (pre-dedup)
// assistant messages. CC splits one turn across multiple lines sharing message.id
// (text line + tool_use sibling), so counting orchDeduped would undercount.
// We scan all lines and dedup by block.id (toolu_...); blocks without id each count once.
const seenToolUseIds = new Set();
let orchestratorActionCount = 0;
for (const l of orchAssistantMsgs) {
  const content = l.message.content || [];
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    if (block.id) {
      if (seenToolUseIds.has(block.id)) continue;
      seenToolUseIds.add(block.id);
    }
    orchestratorActionCount++;
  }
}

// orchestrator_context_size: latest assistant message's input_tokens + cache_read_input_tokens
// "latest" = last in file order among all (pre-dedup) assistant messages
let orchestratorContextSize = 0;
if (orchAssistantMsgs.length > 0) {
  const latest = orchAssistantMsgs[orchAssistantMsgs.length - 1];
  const u = latest.message.usage || {};
  orchestratorContextSize = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

// dispatch_input_tokens (FR-REC-002, metric ⑤): FULL input context cost
// (input_tokens + cache_read + cache_creation) of the orchestrator message that
// dispatched THIS worker. Join key = toolUseId from sibling meta.json (do NOT
// use "the last Agent dispatch" — that misattributes parallel workers).
// If meta absent, unreadable, or no match → null (not 0; missing ≠ zero).
function readDispatchToolUseId(subTranscriptPath) {
  const metaPath = subTranscriptPath.replace(/\.jsonl$/, ".meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const id = meta && meta.toolUseId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null; // no sibling meta / unreadable / malformed → no join key
  }
}

let dispatchInputTokens = null;
const dispatchToolUseId = readDispatchToolUseId(subPath);
if (dispatchToolUseId) {
  for (const l of orchAssistantMsgs) {
    const content = (l.message && l.message.content) || [];
    const matches = Array.isArray(content) &&
      content.some((b) => b && b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && b.id === dispatchToolUseId);
    if (!matches) continue;
    const u = l.message.usage || {};
    // Sum all three fields: bare input_tokens is a tiny cache-miss crumb (commonly 2);
    // actual context sits in cache_read + cache_creation. Sum = real dispatch cost.
    const inTok = typeof u.input_tokens === "number" ? u.input_tokens : 0;
    const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
    const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
    if (
      typeof u.input_tokens === "number" ||
      typeof u.cache_read_input_tokens === "number" ||
      typeof u.cache_creation_input_tokens === "number"
    ) {
      dispatchInputTokens = inTok + cacheRead + cacheCreate;
    }
    break; // toolUseId is unique → record the single correlated dispatch only
  }
}

// ── subagent transcript (WORKER fields) ──────────────────────────────────────

let subLines;
try {
  subLines = readJsonlLines(subPath);
} catch (e) {
  failHard("subagent transcript unreadable: " + subPath + " (" + e.message + ")");
}
// Only assistant messages with a valid usage object count toward worker metrics.
const subAssistantMsgs = subLines.filter(hasValidUsage);

// Dedup by message.id, keeping the record with the highest output_tokens for each id.
// Streaming produces intermediate snapshots (output=1) before the final value; keeping
// the first-seen record would severely underestimate output_tokens.
const subBestById = new Map();
for (const l of subAssistantMsgs) {
  const id = l.message.id;
  const out = l.message.usage?.output_tokens ?? 0;
  if (!subBestById.has(id) || out > (subBestById.get(id).message.usage?.output_tokens ?? 0)) {
    subBestById.set(id, l);
  }
}
const subDeduped = [...subBestById.values()];

// worker_tokens: sum of (input + output + cache_read + cache_creation) per unique message
let workerTokens = 0;
for (const l of subDeduped) {
  const u = l.message.usage || {};
  workerTokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// summary_return_tokens (FR-REC-002, metric ⑤): tokens the worker's summary added
// to the orchestrator context. NOT the worker's own output_tokens (different metric;
// original bug used that, misreporting internal output as orchestrator cost).
// CC transcripts (T013a): tool_result block has no token field; only token field on
// Agent result is subagent's own self-usage — wrong. → null until transcript format
// exposes this field. null = missing; NOT 0, NOT subagent output_tokens.
const summaryReturnTokens = null;

// model: from the first subagent assistant message that has a model field
let model = "";
for (const l of subAssistantMsgs) {
  if (l.message.model) { model = l.message.model; break; }
}

// duration_ms: (last timestamp − first timestamp) across all lines with .timestamp
const allTimestamps = subLines
  .filter((l) => l && l.timestamp)
  .map((l) => new Date(l.timestamp).getTime())
  .filter((t) => !isNaN(t));

let durationMs = 0;
if (allTimestamps.length >= 2) {
  durationMs = Math.max(...allTimestamps) - Math.min(...allTimestamps);
}

// ── last_assistant_message parsing (work / result / files) ───────────────────

const msgLines = lastMsg.split("\n");
const work = msgLines[0] || lastMsg;

let result = "";
let sessionRecordFiles = []; // session-record source: parsed from last_assistant_message
for (const line of msgLines) {
  const lower = line.toLowerCase();
  if (lower.startsWith("result:")) {
    result = line.slice("result:".length).trim();
  } else if (lower.startsWith("files:")) {
    const raw = line.slice("files:".length).trim();
    sessionRecordFiles = raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

// ── files two-source collection + parallel-conflict marker (FR-REC-003) ───────
// Version-diff source (PREFERRED): the actually-changed files per `git diff` in the
// orchestrator cwd. Pure read of the working tree — not a network/model call. A
// non-git cwd, clean tree, or git error yields an empty set (best-effort, never throws).
function versionDiffFiles(cwd) {
  if (!cwd) return [];
  try {
    // `timeout` bounds the ONE blocking subprocess that could hang (e.g. parallel
    // workers contending on the same git index). execFileSync is synchronous, so a
    // post-hoc wall-clock check could never interrupt a hung git — the per-call
    // timeout is what actually bounds it. On timeout it throws → caught → empty set
    // → falls back to the session-record source (legal per FR-REC-003).
    const out = execFileSync("git", ["-C", cwd, "diff", "--name-only", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // not a git repo / git unavailable / clean tree / timed out — version-diff empty
  }
}

const versionDiff = versionDiffFiles(hookCwd);

// Preference: version-diff source wins when present; else fall back to session-record;
// else "unknown" (legal missing state per FR-REC-003 ②). conflict_marker (FR-REC-003 ③):
// when BOTH sources have content but disagree, that is the parallel-contamination case
// (concurrent workers blur the diff, D6/codex M4) — mark it, never silently pick one.
let files;
let conflictMarker = false;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
if (versionDiff.length > 0) {
  files = versionDiff;
  if (sessionRecordFiles.length > 0 && !sameSet(versionDiff, sessionRecordFiles)) {
    conflictMarker = true;
  }
} else if (sessionRecordFiles.length > 0) {
  files = sessionRecordFiles;
} else {
  files = "unknown";
}

// ── required-field validation ─────────────────────────────────────────────────
// If the transcripts were readable but yield no usable metrics the data is
// incomplete (subagent likely crashed mid-run). We no longer drop the record
// entirely — instead we write a status=incomplete placeholder so the dispatch
// is traceable. Fields that cannot be computed are recorded as null.
// The partial record below carries all fields available at this point; the
// writeIncomplete() call merges in status/incomplete_reason before appending.
const partialRecord = {
  session_id: sessionId,
  orchestrator_action_count: orchAssistantMsgs.length > 0 ? orchestratorActionCount : null,
  orchestrator_tokens: orchAssistantMsgs.length > 0 ? orchestratorTokens : null,
  orchestrator_input_tokens: orchAssistantMsgs.length > 0 ? orchestratorInputTokens : null,
  orchestrator_new_input_tokens: orchAssistantMsgs.length > 0 ? orchestratorNewInputTokens : null,
  orchestrator_new_input_ratio: orchAssistantMsgs.length > 0 ? orchestratorNewInputRatio : null,
  orchestrator_context_size: orchAssistantMsgs.length > 0 ? orchestratorContextSize : null,
  worker_tokens: subAssistantMsgs.length > 0 ? workerTokens : null,
  duration_ms: allTimestamps.length >= 2 ? durationMs : null,
  model: model || null,
  work: work || null,
  result: result || null,
  files,
  subagent_type: subagentType,
  backend,
  dispatch_input_tokens: dispatchInputTokens,
  summary_return_tokens: summaryReturnTokens,
  conflict_marker: conflictMarker,
  dispatch_id: dispatchId,
  ts: new Date().toISOString(),
};

if (orchAssistantMsgs.length === 0) {
  writeIncomplete(
    "orchestrator transcript has no assistant messages with usage — session metrics unavailable",
    partialRecord, workerLogPath
  );
}
if (subAssistantMsgs.length === 0) {
  writeIncomplete(
    "subagent transcript has no assistant messages with usage — worker_tokens unavailable",
    partialRecord, workerLogPath
  );
}
if (allTimestamps.length < 2) {
  writeIncomplete(
    "subagent transcript lacks >=2 timestamps — duration_ms unavailable",
    partialRecord, workerLogPath
  );
}
if (!model) {
  writeIncomplete(
    "subagent transcript has no model field — model unavailable",
    partialRecord, workerLogPath
  );
}

// ── assemble record ───────────────────────────────────────────────────────────

const record = {
  // SESSION fields
  session_id: sessionId,
  orchestrator_action_count: orchestratorActionCount,
  orchestrator_tokens: orchestratorTokens,
  orchestrator_input_tokens: orchestratorInputTokens,
  orchestrator_new_input_tokens: orchestratorNewInputTokens,
  orchestrator_new_input_ratio: orchestratorNewInputRatio,
  orchestrator_context_size: orchestratorContextSize,
  // WORKER fields
  worker_tokens: workerTokens,
  duration_ms: durationMs,
  model,
  work,
  result,
  files,
  // Phase 3 additions (SIG-002 / FR-REC-002,003): null/"unknown" for missing data.
  subagent_type: subagentType,
  backend,
  dispatch_input_tokens: dispatchInputTokens,
  summary_return_tokens: summaryReturnTokens,
  conflict_marker: conflictMarker,
  // Idempotency key (FR-REC-005): toolUseId from sibling meta.json, or agent
  // transcript filename as fallback. Used by duplicate-suppression check above
  // and by consumers to deduplicate when Agent Teams delivers the event twice.
  dispatch_id: dispatchId,
  // status: "ok" | "incomplete" (incomplete written by writeIncomplete above).
  // "failed" state is NOT implemented here: SubagentStop hookData carries no
  // reliable failure signal (no is_error, no stop_reason, no result.error field
  // exposed in this hook event). Adding a failed branch without a signal source
  // would produce false negatives (succeeded agents mis-labeled failed) and pollute
  // monitoring. PONYTAIL: implement failed + omc-failure.marker once SubagentStop
  // exposes a reliable failure field (e.g. hookData.is_error or hookData.exit_code).
  status: "ok",
  ts: new Date().toISOString(),
};

// Single-run time bound (FR-REC-004 ②): if collection took longer than the limit,
// failHard and write NOTHING — a hung/slow run must not silently append. A limit of
// 0 means "no time budget" and always trips (so the guard is deterministically
// testable without racing a sub-millisecond synchronous run).
const elapsedMs = Date.now() - RUN_START_MS;
if (RUN_TIMEOUT_MS === 0 || elapsedMs > RUN_TIMEOUT_MS) {
  failHard("single-run time limit exceeded (" + elapsedMs +
    "ms > " + RUN_TIMEOUT_MS + "ms); no record appended");
}

// ── session_metrics (B2) — computed from the same orchDeduped set ────────────
// context_peak_tokens: max single-turn total input across all orch messages
// (formula: input_tokens + cache_creation_input_tokens + cache_read_input_tokens,
// same as orchestrator_input_tokens per-turn, reflecting true context burden).
// We use orchInputDeduped (deduped by message.id, input-side fields present) so
// output-only messages (turnTotal=0) do not participate in the peak — consistent
// with the input/new_input fields that also use orchInputDeduped.
// When orchInputDeduped is empty (no input-side data at all), we record null
// (not 0) to signal "no input-side data available" rather than a fake zero.
let contextPeakTokens = null;
for (const l of orchInputDeduped) {
  const u = l.message.usage || {};
  const inp = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const turnTotal = inp + cacheCreate + cacheRead;
  if (contextPeakTokens === null || turnTotal > contextPeakTokens) contextPeakTokens = turnTotal;
}

// tool_call_composition: count distinct tool_use blocks across ALL orchestrator
// assistant messages (orchAllAssistantMsgs, not orchAssistantMsgs), classified
// by tool name. Tool composition is a behavioral statistic that must not depend
// on usage completeness — a tool_use block without usage would be silently missed
// if we restricted to the usage-valid set.
// Bash → bash; Task|Agent → agent; Read|Grep|Glob → read_only; else → other.
const seenToolUseIdsForComposition = new Set();
const toolCallComposition = { bash: 0, agent: 0, read_only: 0, other: 0 };
for (const l of orchAllAssistantMsgs) {
  const content = l.message.content || [];
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    if (block.id) {
      if (seenToolUseIdsForComposition.has(block.id)) continue;
      seenToolUseIdsForComposition.add(block.id);
    }
    const name = block.name || "";
    if (name === "Bash") {
      toolCallComposition.bash++;
    } else if (name === "Task" || name === "Agent") {
      toolCallComposition.agent++;
    } else if (name === "Read" || name === "Grep" || name === "Glob") {
      toolCallComposition.read_only++;
    } else {
      toolCallComposition.other++;
    }
  }
}

// ── atomic append (FR-LOG-004/005: concurrency-safe) ─────────────────────────
// O_APPEND flag on POSIX: each write() is positioned at end atomically by the kernel.
// A single write of one JSON line (≤ PIPE_BUF on most systems) is guaranteed atomic.

mkdirSync(dirname(workerLogPath), { recursive: true });

const line = JSON.stringify(record) + "\n";
const buf = Buffer.from(line, "utf8");

// Open with O_WRONLY | O_CREAT | O_APPEND (0x401 | 0x40 | 0x400 = platform-specific;
// use the string flags form for portability).
const fd = openSync(workerLogPath, "a");
try {
  writeSync(fd, buf);
} finally {
  closeSync(fd);
}

// ── session_metrics event (B2) — append as independent record after per-worker ─
// Consumers distinguish this from per-worker rows by event=="session_metrics".
// Per-worker rows do NOT get an event field (backward compatibility preserved).
const sessionMetricsRecord = {
  event: "session_metrics",
  session_id: sessionId,
  context_peak_tokens: contextPeakTokens,
  tool_call_composition: toolCallComposition,
  ts: new Date().toISOString(),
};
const sessionMetricsLine = JSON.stringify(sessionMetricsRecord) + "\n";
const smBuf = Buffer.from(sessionMetricsLine, "utf8");
const smFd = openSync(workerLogPath, "a");
try {
  writeSync(smFd, smBuf);
} finally {
  closeSync(smFd);
}

process.exit(0);
