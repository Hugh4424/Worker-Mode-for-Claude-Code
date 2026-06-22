#!/usr/bin/env node
// record-worker.mjs — SubagentStop hook: appends one 11-field JSON record per worker.
// Post-hoc logging only; no interception, no behavior change (FR-LOG-006).
// Node ESM, no external dependencies.

import { createRequire } from "node:module";
import { readFileSync, mkdirSync, appendFileSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

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
// record, so the worker-log never accumulates fake all-zero metrics that would
// corrupt the CHK delegation/context/token metrics.
function failHard(reason) {
  process.stderr.write("[record-worker] hard-dependency failure: " + reason + "\n" +
    "Refusing to write a worker-log record with missing metrics. No record appended.\n");
  process.exit(1);
}

// A valid usage-bearing assistant message: has an id and a usage object carrying at
// least one numeric token field. Required-usage messages are filtered through this
// at the SOURCE so missing usage can never silently become a zero metric.
function hasValidUsage(l) {
  return l && l.type === "assistant" && l.message && l.message.id && l.message.usage &&
    (typeof l.message.usage.input_tokens === "number" || typeof l.message.usage.output_tokens === "number");
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
// cwd is the orchestrator working directory — used to run the version-diff source.
const hookCwd = hookData.cwd || "";

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
// Tool-use action counting needs assistant messages regardless of usage, but we
// dedup/count over the SAME valid-usage set so a usage-less message cannot inflate
// or zero out the picture inconsistently; action count is derived below from this set.

// Dedup by message.id
const orchSeenIds = new Set();
const orchDeduped = [];
for (const l of orchAssistantMsgs) {
  if (!orchSeenIds.has(l.message.id)) {
    orchSeenIds.add(l.message.id);
    orchDeduped.push(l);
  }
}

// orchestrator_tokens: sum of (input + output) per unique message
let orchestratorTokens = 0;
for (const l of orchDeduped) {
  const u = l.message.usage || {};
  orchestratorTokens += (u.input_tokens || 0) + (u.output_tokens || 0);
}

// orchestrator_action_count: count DISTINCT tool_use blocks across ALL (pre-dedup)
// assistant messages. Claude Code splits one assistant turn across multiple JSONL
// lines sharing a message.id (text in one line, tool_use in a sibling line), so
// counting over orchDeduped (kept first line per message.id) would discard the
// tool_use sibling and undercount. We therefore scan every line. But scanning
// raw lines could overcount if the same tool_use block were ever echoed across
// multiple lines, so we dedupe by each tool_use's own `id` (toolu_...). Blocks
// without an id fall back to counting each occurrence. Token sums stay on the
// deduped set (usage is redundant across the split); only this count scans all.
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

// dispatch_input_tokens (FR-REC-002, plan L91, metric ⑤): the FULL input context
// cost (input_tokens + cache_read_input_tokens + cache_creation_input_tokens) on the
// orchestrator assistant message that dispatched THIS SPECIFIC worker via a tool_use
// with name "Agent". A session may contain multiple/parallel Agent dispatches, so we
// must NOT take "the last Agent dispatch" — that would misattribute another worker's
// (or another turn's) cost as this worker's, fabricating false per-worker data.
//
// The reliable join key (verified against real CC transcripts, T013a): the subagent
// transcript at agent_transcript_path (subagents/agent-XXX.jsonl) has a SIBLING
// agent-XXX.meta.json carrying { toolUseId } — the exact id of the Agent tool_use
// block that created this worker. We read that toolUseId, find the orchestrator
// assistant message whose content has a tool_use{name:"Agent", id===toolUseId}, and
// record THAT message's full input context (the three usage fields summed; bare
// input_tokens alone is a cache-miss crumb, commonly 2). If the meta is absent/unparseable,
// carries no toolUseId, or no matching dispatch exists, record null (NOT 0, NOT the last
// dispatch's value) — missing-data must stay distinguishable and never misattributed.
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
      content.some((b) => b && b.type === "tool_use" && b.name === "Agent" && b.id === dispatchToolUseId);
    if (!matches) continue;
    const u = l.message.usage || {};
    // The real dispatch context cost is the FULL input the dispatching message
    // carried, not the bare input_tokens. In Claude Code the dispatching turn
    // almost always hits the prompt cache, so input_tokens is a tiny remainder
    // (commonly 2) while the actual context sits in cache_read_input_tokens
    // (tens/hundreds of thousands) + cache_creation_input_tokens. Sum all three
    // so dispatch_input_tokens reflects context cost, not the uncached crumb.
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

// Dedup by message.id
const subSeenIds = new Set();
const subDeduped = [];
for (const l of subAssistantMsgs) {
  if (!subSeenIds.has(l.message.id)) {
    subSeenIds.add(l.message.id);
    subDeduped.push(l);
  }
}

// worker_tokens: sum of (input + output) per unique message
let workerTokens = 0;
for (const l of subDeduped) {
  const u = l.message.usage || {};
  workerTokens += (u.input_tokens || 0) + (u.output_tokens || 0);
}

// summary_return_tokens (FR-REC-002, plan L92, metric ⑤): the ORCHESTRATOR-SIDE
// tool_result token cost — the tokens the returned summary added back into the
// orchestrator context. This is NOT the subagent's own output_tokens (a different
// quantity; using it would misreport the worker's internal output as orchestrator
// cost — the original bug). Verified against real CC transcripts (T013a): the
// orchestrator tool_result content-block carries only {content,is_error,tool_use_id,
// type} with NO token field, and the only token-bearing field on the Agent result
// (toolUseResult.usage / totalTokens) is the subagent's OWN aggregate self-usage,
// which is precisely the forbidden fallback. The orchestrator-side tool_result token
// is therefore not a recorded field and cannot be extracted → record null (NOT 0,
// NOT the subagent output_tokens). null = missing-data is correct here. If a future
// transcript format exposes this token, this is the single place to parse it.
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

// ── required-field validation (hard dependencies — let it crash, no fake zeros) ──
// If the transcripts were readable but yield no usable metrics, the record would be
// all-zeros and silently poison CHK. Treat the derived metrics as hard requirements.
if (orchAssistantMsgs.length === 0) {
  failHard("orchestrator transcript has no assistant messages with usage — cannot compute session metrics");
}
if (subAssistantMsgs.length === 0) {
  failHard("subagent transcript has no assistant messages with usage — cannot compute worker tokens");
}
if (allTimestamps.length < 2) {
  failHard("subagent transcript lacks >=2 timestamps — cannot compute duration_ms");
}
if (!model) {
  failHard("subagent transcript has no model field — cannot record worker model");
}

// ── assemble record ───────────────────────────────────────────────────────────

const record = {
  // SESSION fields
  session_id: sessionId,
  orchestrator_action_count: orchestratorActionCount,
  orchestrator_tokens: orchestratorTokens,
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
  dispatch_input_tokens: dispatchInputTokens,
  summary_return_tokens: summaryReturnTokens,
  conflict_marker: conflictMarker,
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

process.exit(0);
