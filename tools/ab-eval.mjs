#!/usr/bin/env node
// ab-eval.mjs — one-shot CLI: A/B evaluation scaffold for delegation-improvement experiments.
//
// Reads a batch of Claude Code transcript JSONL files + a worker-log and an assignment map
// (session_id → group: baseline | only-A | only-B | A+B), computes per-session metrics,
// then aggregates by group for side-by-side comparison.
//
// Main metric: first_delegation_gather_count
//   = big self-chunks the foreman made BEFORE the first Agent/Task dispatch in a session.
//   Lower is better (fewer self-reads before delegating). Must be read together with
//   completion_status: an early delegation that fails to finish the task is a negative signal.
//
// Auxiliary metrics (reused from check-metrics.mjs logic):
//   worker_token_ratio, foreman_tool_call_count, total_tokens, duration_ms
//
// Honest-null principle (hard rule matching check-metrics.mjs):
//   Any metric that cannot be computed outputs null, never 0 or a fabricated value.
//   Missing data is ALWAYS explicit, never silently swallowed.
//
// Usage:
//   node ab-eval.mjs --config <path-to-config.json> --log <worker-log.jsonl> [--json]
//   node ab-eval.mjs --config <path> [--json]   (log path can be inside config)
//
// Config file schema:
//   {
//     "worker_log": "<path>",          // optional if --log is passed
//     "sessions": {
//       "<session_id>": {
//         "group": "baseline" | "only-A" | "only-B" | "A+B",
//         "transcript": "<path-to-transcript.jsonl>",
//         "completed": true | false | null  // human annotation; null = unknown
//       }
//     }
//   }
//
// Node ESM, zero external dependencies.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── classifier import ──────────────────────────────────────────────────────────

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const classifierPath = join(pluginRoot, "tools", "lib", "self-work-classifier.mjs");

let isBigSelfChunk;
try {
  ({ isBigSelfChunk } = await import(classifierPath));
} catch (e) {
  process.stderr.write("[ab-eval] Cannot load self-work-classifier: " + e.message + "\n");
  process.exit(1);
}

// ── args ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let config = "";
  let log = "";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") { config = argv[i + 1] || ""; i++; }
    else if (argv[i] === "--log") { log = argv[i + 1] || ""; i++; }
    else if (argv[i] === "--json") { json = true; }
  }
  return { config, log, json };
}

const { config: configArg, log: logArg, json: jsonMode } = parseArgs(process.argv.slice(2));

if (!configArg) {
  process.stderr.write("[ab-eval] --config <path> is required.\n");
  process.exit(1);
}

// ── load config ────────────────────────────────────────────────────────────────

let cfg;
try {
  cfg = JSON.parse(readFileSync(configArg, "utf8"));
} catch (e) {
  process.stderr.write("[ab-eval] Cannot read config: " + configArg + " (" + e.message + ")\n");
  process.exit(1);
}

const sessions = cfg.sessions;
if (!sessions || typeof sessions !== "object" || Object.keys(sessions).length === 0) {
  process.stderr.write("[ab-eval] Config must contain a non-empty 'sessions' object.\n");
  process.exit(1);
}

// Validate groups
const VALID_GROUPS = new Set(["baseline", "only-A", "only-B", "A+B"]);
for (const [sid, s] of Object.entries(sessions)) {
  if (!VALID_GROUPS.has(s.group)) {
    process.stderr.write(
      "[ab-eval] Session " + sid + " has invalid group '" + s.group +
      "'. Valid: baseline | only-A | only-B | A+B\n"
    );
    process.exit(1);
  }
}

// ── load worker-log ────────────────────────────────────────────────────────────

const logPath = logArg || cfg.worker_log || "";
let workerRecords = null; // null = no log provided (all log-derived metrics will be null)

if (logPath) {
  let raw;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (e) {
    process.stderr.write("[ab-eval] Cannot read worker-log: " + logPath + " (" + e.message + ")\n");
    process.exit(1);
  }
  workerRecords = new Map(); // session_id → [records]
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (e) {
      process.stderr.write(
        "[ab-eval] Malformed worker-log line " + lineNo + ": " + e.message + "\n"
      );
      process.exit(1);
    }
    const sid = rec.session_id;
    if (!sid) continue;
    if (!workerRecords.has(sid)) workerRecords.set(sid, []);
    workerRecords.get(sid).push(rec);
  }
}

// ── transcript JSONL helpers ──────────────────────────────────────────────────

function readJsonlLines(filePath) {
  // Returns { lines: Array, hasMalformed: boolean } on success, null on read failure.
  // Fix issue4: malformed lines are tracked so callers can refuse to compute FDGC
  // from a partially-corrupt transcript (honest-null principle).
  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = [];
    let hasMalformed = false;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed));
      } catch {
        // Track malformed lines rather than silently skipping them: a corrupted
        // transcript could yield a falsely-low FDGC (honest-null requires null).
        hasMalformed = true;
      }
    }
    return { lines, hasMalformed };
  } catch {
    return null;
  }
}

// Compute size info from a tool_result content value (string or array of blocks).
function sizeFromContent(content) {
  if (content === null || content === undefined) {
    return { bytes: 0, lines: 0, isError: false };
  }
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block.text === "string") text += block.text;
    }
  }
  return {
    bytes: text.length,
    lines: text.length > 0 ? text.split("\n").length : 0,
    isError: false,
  };
}

// ── completion heuristic ───────────────────────────────────────────────────────
// Returns: true | false | "unknown"
// Priority order:
//   1. Human annotation in config (completed: true/false) — authoritative.
//   2. Heuristic from transcript tail: look for normal session end signals.
//   3. "unknown" if neither available.
//
// Heuristic signals for completion:
//   - Last assistant turn contains NO tool_use blocks (model produced final text response)
//   - OR last few assistant turns mention completion words in text content
// Signals for incompletion:
//   - Transcript ends abruptly mid-tool-call (last line is a tool_result with is_error)
// These are weak signals — when uncertain, output "unknown".

function inferCompletion(annotation, transcriptLines) {
  // Human annotation takes priority.
  if (annotation === true) return true;
  if (annotation === false) return false;
  // Fix issue3: explicit null means the human annotated it as unknown — do NOT
  // fall through to transcript heuristic. Only attempt heuristic when the field
  // was entirely absent from config (represented as the sentinel "auto" here).
  if (annotation === null) return "unknown";
  // annotation === "auto": field was absent → try transcript heuristic.
  if (!transcriptLines || transcriptLines.length === 0) return "unknown";

  // Collect foreman assistant turns (non-sidechain) in order.
  const foremanAsst = transcriptLines.filter(
    (l) => l && l.type === "assistant" && l.isSidechain !== true
  );
  if (foremanAsst.length === 0) return "unknown";

  const lastAsst = foremanAsst[foremanAsst.length - 1];
  const content = lastAsst.message && lastAsst.message.content;
  if (!Array.isArray(content)) return "unknown";

  // If last assistant turn has tool_use blocks → session still in progress or cut off.
  const hasToolUse = content.some((b) => b && b.type === "tool_use");
  if (hasToolUse) return "unknown"; // ended mid-action — cannot tell

  // Last assistant turn is a text-only response → likely a final answer.
  const hasText = content.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.length > 10);
  if (hasText) return true;

  return "unknown";
}

// ── main metric: first_delegation_gather_count ────────────────────────────────
// Counts big self-chunk tool calls from the START of the session up to (not including)
// the first Agent/Task dispatch. If no Agent/Task dispatch exists, counts all turns.
//
// "Before first delegation" window:
//   We walk foreman assistant turns in chronological order. Each turn may contain
//   multiple tool_use calls. We stop counting once we see the first Agent/Task.
//
// Returns: number (0-based count) | null (if transcript unreadable or empty)

function computeFirstDelegationGatherCount(transcriptLines) {
  if (!transcriptLines || transcriptLines.length === 0) return null;

  // Pass 1: collect all tool_result blocks by tool_use_id.
  const resultsByToolUseId = new Map();
  for (const line of transcriptLines) {
    if (!line || line.type !== "user") continue;
    if (line.isSidechain === true) continue;
    const content = line.message && line.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "tool_result") continue;
      const id = block.tool_use_id;
      if (!id) continue;
      const size = sizeFromContent(block.content);
      if (block.is_error) size.isError = true;
      resultsByToolUseId.set(id, size);
    }
  }

  // Pass 2: walk foreman assistant turns in order.
  // Fix issue1: a single assistant turn in real CC transcripts is split across multiple
  // JSONL lines sharing the same message.id (text in one line, tool_use in a sibling).
  // First-wins dedup on message.id would drop the sibling tool_use line entirely,
  // causing FDGC to miss delegation calls or pre-delegation reads. Instead:
  //   (a) collect ALL tool_use blocks across every line, grouped by message.id (in file order).
  //   (b) dedup individual tool_use blocks by their own block.id (toolu_... id).
  // This matches the pattern used in record-worker.mjs orchestratorActionCount.

  // Step 2a: build an ordered list of (msgId, content array) groups, preserving
  // first-seen order of each message.id, but merging all tool_use blocks from siblings.
  const msgOrder = [];              // ordered list of msgIds (first-seen file order)
  const msgToolUses = new Map();    // msgId → Map(tool_use.id → tool_use block)
  const msgToolUsesNoId = new Map(); // msgId → [blocks without an id]

  for (const line of transcriptLines) {
    if (!line || line.type !== "assistant") continue;
    if (line.isSidechain === true) continue;
    const msg = line.message;
    if (!msg) continue;
    const msgId = msg.id || null;

    // Register message order on first encounter.
    if (!msgToolUses.has(msgId)) {
      msgOrder.push(msgId);
      msgToolUses.set(msgId, new Map());
      msgToolUsesNoId.set(msgId, []);
    }

    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || block.type !== "tool_use") continue;
      if (block.id) {
        // Dedup by tool_use block id — same block may appear in multiple split lines.
        if (!msgToolUses.get(msgId).has(block.id)) {
          msgToolUses.get(msgId).set(block.id, block);
        }
      } else {
        // No id — cannot dedup, keep each occurrence (conservative).
        msgToolUsesNoId.get(msgId).push(block);
      }
    }
  }

  // Step 2b: walk merged turns in file order.
  let bigSelfCount = 0;
  let foundFirstDelegation = false;

  for (const msgId of msgOrder) {
    if (foundFirstDelegation) break;
    // Merged tool_use blocks for this logical turn: id-deduped + no-id blocks.
    const blocks = [
      ...msgToolUses.get(msgId).values(),
      ...msgToolUsesNoId.get(msgId),
    ];

    for (const block of blocks) {
      const name = block.name;

      // First Agent/Task = end of pre-delegation window.
      if (name === "Agent" || name === "Task") {
        foundFirstDelegation = true;
        break; // stop processing this turn's tool_uses
      }

      // Check if this tool call is a big self-chunk.
      const paired = resultsByToolUseId.get(block.id) || null;
      const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({
        toolUse: { name, input: block.input || {} },
        result: paired,
      });
      if (isBigSelfRead || isBigSelfWrite) {
        bigSelfCount++;
      }
    }
  }

  return bigSelfCount;
}

// ── auxiliary metrics from worker-log ─────────────────────────────────────────
// Reuses the same logic as check-metrics.mjs: worker_token_ratio, total_tokens,
// foreman_tool_call_count (approximated by orchestrator_action_count), duration_ms.
//
// Returns an object with null for any metric that cannot be computed.

function computeAuxFromWorkerLog(sessionId) {
  if (!workerRecords) {
    // No log provided — all null.
    return {
      worker_token_ratio: null,
      foreman_tool_call_count: null,
      total_tokens: null,
      worker_total_tokens: null,
      orchestrator_tokens: null,
    };
  }
  const rawRecs = workerRecords.get(sessionId) || [];
  if (rawRecs.length === 0) {
    return {
      worker_token_ratio: null,
      foreman_tool_call_count: null,
      total_tokens: null,
      worker_total_tokens: null,
      orchestrator_tokens: null,
    };
  }

  // Fix issue2a: dedup by dispatch_id, matching check-metrics.mjs P1-A logic.
  // In Agent Teams mode the same SubagentStop event can be delivered twice, causing
  // duplicate records. Keep only the first occurrence per dispatch_id.
  const seenDispatchIds = new Set();
  const recs = [];
  for (const r of rawRecs) {
    const did = r.dispatch_id;
    if (did != null && did !== "") {
      if (seenDispatchIds.has(did)) continue; // duplicate — skip
      seenDispatchIds.add(did);
    }
    recs.push(r);
  }

  // Fix issue2b: isolate status=incomplete records, matching check-metrics.mjs P1-B logic.
  // Incomplete placeholders have null/missing numeric fields; including them in token
  // computations would corrupt the result. They still count toward action count
  // (the dispatch was real — only the data is partial).
  const completeRecs = recs.filter((r) => r.status !== "incomplete");

  // delegation action count: use ALL records (complete + incomplete) because the
  // dispatch event is real regardless of data completeness.
  let maxActions = 0;
  for (const r of recs) {
    if (typeof r.orchestrator_action_count === "number" && r.orchestrator_action_count > maxActions) {
      maxActions = r.orchestrator_action_count;
    }
  }

  // Token metrics: completeRecs only. Same null-vs-0 discipline as check-metrics.mjs:
  // missing worker_tokens in ANY complete record → whole worker total is null.
  if (completeRecs.length === 0) {
    // All records are incomplete — refuse to fabricate token metrics.
    return {
      worker_token_ratio: null,
      foreman_tool_call_count: maxActions > 0 ? maxActions : null,
      total_tokens: null,
      worker_total_tokens: null,
      orchestrator_tokens: null,
    };
  }

  const workerTokensMissing = completeRecs.some((r) => typeof r.worker_tokens !== "number");
  let maxOrch = 0;
  let sumWorker = 0;
  for (const r of completeRecs) {
    if (typeof r.orchestrator_tokens === "number" && r.orchestrator_tokens > maxOrch) {
      maxOrch = r.orchestrator_tokens;
    }
    if (typeof r.worker_tokens === "number") sumWorker += r.worker_tokens;
  }

  const workerTotal = workerTokensMissing ? null : sumWorker;
  const tokenDenom = sumWorker + maxOrch;
  const ratio = workerTokensMissing || tokenDenom <= 0 ? null : sumWorker / tokenDenom;
  const totalTok = workerTokensMissing ? null : sumWorker + maxOrch;

  return {
    worker_token_ratio: ratio,
    foreman_tool_call_count: maxActions > 0 ? maxActions : null,
    total_tokens: totalTok,
    worker_total_tokens: workerTotal,
    orchestrator_tokens: maxOrch > 0 ? maxOrch : null,
  };
}

// ── per-session metric computation ────────────────────────────────────────────

function computeSession(sessionId, sessionCfg) {
  const transcriptPath = sessionCfg.transcript || null;
  // Fix issue3: distinguish "completed" key absent (=> "auto" sentinel, allow heuristic)
  // from "completed": null (=> null, explicit unknown, skip heuristic).
  const annotatedCompletion = "completed" in sessionCfg ? sessionCfg.completed : "auto";

  let transcriptResult = null;
  if (transcriptPath) {
    transcriptResult = readJsonlLines(transcriptPath);
  }

  // Fix issue4: malformed transcript lines → FDGC is null (honest-null principle).
  // A partially-corrupt transcript could yield a falsely-low FDGC; null is more honest.
  let firstDelegationGatherCount = null;
  if (transcriptResult !== null) {
    if (transcriptResult.hasMalformed) {
      // Do not compute FDGC from a partially-corrupt transcript.
      firstDelegationGatherCount = null;
    } else {
      firstDelegationGatherCount = computeFirstDelegationGatherCount(transcriptResult.lines);
    }
  }

  const transcriptLines = transcriptResult ? transcriptResult.lines : null;
  const completionStatus = inferCompletion(annotatedCompletion, transcriptLines);

  // Auxiliary from worker-log.
  const aux = computeAuxFromWorkerLog(sessionId);

  return {
    session_id: sessionId,
    group: sessionCfg.group,
    // Main metric + completion (must be read together — plan P1#7).
    first_delegation_gather_count: firstDelegationGatherCount,
    completion_status: completionStatus,  // true | false | "unknown"
    // Auxiliary metrics.
    worker_token_ratio: aux.worker_token_ratio,
    foreman_tool_call_count: aux.foreman_tool_call_count,
    total_tokens: aux.total_tokens,
    worker_total_tokens: aux.worker_total_tokens,
    orchestrator_tokens: aux.orchestrator_tokens,
    // Provenance: harder-to-auto-compute metrics left null (not fabricated).
    rework_count: null,           // ponytail: needs human/agent review to count rework
    result_adoption_rate: null,   // ponytail: hard to auto-judge from transcript alone
  };
}

// ── group aggregation ─────────────────────────────────────────────────────────
// Average over completed-only sessions for the main metric binding (plan P1#7).
// "binding" = only sessions where completion_status === true count in the
// first_delegation_gather_count mean (prevents gaming: early-delegate-and-fail).
//
// Auxiliary metrics averaged over all sessions in the group (completion-agnostic).
//
// null: if no sessions in a group, or all values are null → group value = null.

function mean(values) {
  // values is array of number|null. Filter to numbers; null if none.
  const nums = values.filter((v) => typeof v === "number");
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function aggregateGroups(sessionResults) {
  const byGroup = {};
  for (const VALID_GROUP of ["baseline", "only-A", "only-B", "A+B"]) {
    byGroup[VALID_GROUP] = [];
  }
  for (const sr of sessionResults) {
    if (byGroup[sr.group]) byGroup[sr.group].push(sr);
  }

  const out = {};
  for (const [group, srs] of Object.entries(byGroup)) {
    if (srs.length === 0) {
      out[group] = null; // no data for this group
      continue;
    }

    // Main metric: only over completed sessions (completion_status === true).
    const completedSrs = srs.filter((s) => s.completion_status === true);
    const completionRate =
      srs.length > 0 ? completedSrs.length / srs.length : null;
    const fdgcValues = completedSrs.map((s) => s.first_delegation_gather_count);

    // Auxiliary: all sessions.
    const wtrValues = srs.map((s) => s.worker_token_ratio);
    const ftcValues = srs.map((s) => s.foreman_tool_call_count);
    const ttValues = srs.map((s) => s.total_tokens);

    out[group] = {
      session_count: srs.length,
      completed_count: completedSrs.length,
      // completion_rate: fraction of sessions with confirmed completion.
      // null if no sessions (covered by srs.length === 0 above).
      completion_rate: completionRate,
      // main metric mean over COMPLETED sessions only.
      // null if no completed sessions (binding requirement from plan P1#7).
      first_delegation_gather_count_mean: mean(fdgcValues),
      // auxiliary means over all sessions.
      worker_token_ratio_mean: mean(wtrValues),
      foreman_tool_call_count_mean: mean(ftcValues),
      total_tokens_mean: mean(ttValues),
      // Uncomputed metrics — left null with explanation.
      rework_count_mean: null,           // requires human/agent review
      result_adoption_rate_mean: null,   // requires human/agent review
    };
  }
  return out;
}

// ── compute all sessions ───────────────────────────────────────────────────────

const sessionResults = [];
for (const [sid, scfg] of Object.entries(sessions)) {
  sessionResults.push(computeSession(sid, scfg));
}

const groupSummary = aggregateGroups(sessionResults);

// ── output ─────────────────────────────────────────────────────────────────────

const result = {
  sessions: sessionResults,
  groups: groupSummary,
};

if (jsonMode) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}

// Human-readable table output.
const na = (v) => (v === null || v === undefined ? "N/A" : String(v));
const pct = (v) => v === null || v === undefined ? "N/A" : (v * 100).toFixed(1) + "%";
const num2 = (v) => v === null || v === undefined ? "N/A" : v.toFixed(2);

process.stdout.write("A/B Delegation Evaluation\n");
process.stdout.write("Sessions: " + sessionResults.length + "\n\n");

// Group summary table.
process.stdout.write("── Group Summary ──────────────────────────────────────────────────────────────\n");
const COLS = ["Group", "N", "Done", "Done%", "FDGC_mean*", "wtr_mean", "ftc_mean", "tok_mean"];
const COL_W = [10, 4, 5, 7, 12, 10, 10, 10];
function padR(s, w) { return String(s).padEnd(w); }
process.stdout.write(COLS.map((c, i) => padR(c, COL_W[i])).join(" ") + "\n");
process.stdout.write(COL_W.map((w) => "-".repeat(w)).join(" ") + "\n");

for (const group of ["baseline", "only-A", "only-B", "A+B"]) {
  const g = groupSummary[group];
  if (!g) {
    process.stdout.write(padR(group, COL_W[0]) + " " + padR("(no data)", COL_W[1] + 1 + COL_W[2]) + "\n");
    continue;
  }
  const row = [
    group,
    g.session_count,
    g.completed_count,
    pct(g.completion_rate),
    num2(g.first_delegation_gather_count_mean),
    pct(g.worker_token_ratio_mean),
    num2(g.foreman_tool_call_count_mean),
    num2(g.total_tokens_mean),
  ];
  process.stdout.write(row.map((v, i) => padR(v, COL_W[i])).join(" ") + "\n");
}
process.stdout.write("\n* FDGC = first_delegation_gather_count (mean over COMPLETED sessions only)\n");
process.stdout.write("  Lower FDGC = foreman delegated sooner. Read with Done% — lower FDGC + stable Done% = improvement.\n");
process.stdout.write("  N/A = metric could not be computed (missing data, never fabricated).\n\n");

// Per-session detail.
process.stdout.write("── Per-Session Detail ─────────────────────────────────────────────────────────\n");
for (const sr of sessionResults) {
  process.stdout.write(
    "[" + sr.session_id + "] group=" + sr.group +
    "  FDGC=" + na(sr.first_delegation_gather_count) +
    "  completed=" + na(sr.completion_status) +
    "  wtr=" + pct(sr.worker_token_ratio) +
    "  ftc=" + na(sr.foreman_tool_call_count) +
    "  total_tok=" + na(sr.total_tokens) +
    "\n"
  );
}

process.exit(0);
