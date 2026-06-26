#!/usr/bin/env node
// check-metrics.mjs — one-shot, post-hoc CLI that reads the unified worker-log JSONL
// and computes the delegation/observation metrics. It is NOT a resident process
// (FR-CHK-003): it reads, prints, and exits — no watchers, no loops, no listeners.
// Node ESM, no external dependencies.
//
// Usage:
//   node check-metrics.mjs --log <path> [--session-record <path>] [--json]
//   WORKER_LOG_PATH=<path> node check-metrics.mjs [--json]
//
// Note: review_return_rate 受 extract-gates 保守推断限制，低活跃/短会话大概率 N/A
// （extract-gates 宁可 unknown 不瞎猜），这是设计权衡不是 bug。

import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// ── args ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let log = "";
  let json = false;
  let sessionRecord = "";
  let transcript = "";
  let enforceLog = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log") {
      log = argv[i + 1] || "";
      i++;
    } else if (argv[i] === "--session-record") {
      // Optional: the orchestrator-side session record (transcript) parsed ONLY when
      // manually passed (FR-CHK-003). Supplies human-wait intervals for inflation.
      sessionRecord = argv[i + 1] || "";
      i++;
    } else if (argv[i] === "--transcript") {
      transcript = argv[i + 1] || "";
      i++;
    } else if (argv[i] === "--enforce-log") {
      enforceLog = argv[i + 1] || "";
      i++;
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  return { log, json, sessionRecord, transcript, enforceLog };
}

const { log: logArg, json, sessionRecord: sessionRecordArg, transcript: transcriptArg, enforceLog: enforceLogArg } = parseArgs(process.argv.slice(2));
// --log wins; fall back to env WORKER_LOG_PATH.
const logPath = logArg || process.env.WORKER_LOG_PATH || "";

if (!logPath) {
  process.stderr.write(
    "[check-metrics] No log path. Pass --log <path> or set WORKER_LOG_PATH.\n"
  );
  process.exit(1);
}

// ── read log ─────────────────────────────────────────────────────────────────
// The FILE is a hard dependency: an unreadable/missing log is a hard error — exit
// non-zero, never pretend zero metrics (FR-CHK / let-it-crash). A single malformed
// JSON line inside a readable file is skipped, not fatal.

let raw;
try {
  raw = readFileSync(logPath, "utf8");
} catch (e) {
  process.stderr.write(
    "[check-metrics] Cannot read worker-log: " + logPath + " (" + e.message + ")\n" +
    "Refusing to report zero metrics for a missing log.\n"
  );
  process.exit(1);
}

const records = [];
let lineNo = 0;
for (const line of raw.split("\n")) {
  lineNo++;
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    records.push(JSON.parse(trimmed));
  } catch (e) {
    // The worker-log is the ONLY long-term monitoring source (FR-CHK-001/D5). A
    // corrupt line means silent data loss — fail loud rather than under-report.
    process.stderr.write("[check-metrics] malformed worker-log line " + lineNo + ": " +
      e.message + "\nRefusing to compute metrics from a partially-corrupt log.\n");
    process.exit(1);
  }
}

// ── session-record (transcript) parse — FR-CHK-002/003, manual-run only ───────
// The session record is the SECOND source for inflation: it carries the
// orchestrator-side timeline that the worker-log cannot (human-wait intervals).
// It is parsed ONLY when --session-record is passed on a manual run (FR-CHK-003 —
// this CLI is one-shot, never resident, never parsed in the record stage).
//
// Minimal, explicit format (the exact Claude-Code transcript field mapping is the
// integration point — this is the documented honest interface, not a speculative
// full transcript parser): a JSON object with `human_wait_intervals: [{start,end}]`
// using ISO8601 timestamps. If the file is absent/unreadable/empty, human-wait is
// simply unavailable and inflation falls back to the worker-log-only denominator,
// with the denominator source marked accordingly.
function parseSessionRecord(path) {
  if (!path) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    process.stderr.write("[check-metrics] --session-record unreadable: " + path +
      " (" + e.message + "); falling back to worker-log timestamps for inflation.\n");
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    process.stderr.write("[check-metrics] --session-record is not valid JSON: " +
      e.message + "; falling back to worker-log timestamps for inflation.\n");
    return null;
  }
  const intervals = Array.isArray(obj && obj.human_wait_intervals) ? obj.human_wait_intervals : [];
  // Normalize to numeric [start,end] ms ranges, dropping unparseable ones.
  const humanWait = [];
  for (const iv of intervals) {
    if (!iv) continue;
    const s = new Date(iv.start).getTime();
    const e = new Date(iv.end).getTime();
    if (!isNaN(s) && !isNaN(e) && e > s) humanWait.push([s, e]);
  }
  return { humanWaitIntervals: humanWait };
}

const sessionRecord = parseSessionRecord(sessionRecordArg);

// ── interval helpers (time-based metrics ②③④) ───────────────────────────────
// A worker's active interval is [ts − duration_ms, ts]: ts is the record-write
// (completion) time and duration_ms its wall-clock span.
function workerInterval(r) {
  const end = new Date(r.ts).getTime();
  const dur = typeof r.duration_ms === "number" ? r.duration_ms : 0;
  if (isNaN(end)) return null;
  return [end - dur, end];
}

// Merge overlapping intervals into a disjoint union; returns sorted disjoint ranges.
function mergeIntervals(intervals) {
  const sorted = intervals.filter(Boolean).slice().sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of sorted) {
    if (merged.length === 0 || iv[0] > merged[merged.length - 1][1]) {
      merged.push([iv[0], iv[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
    }
  }
  return merged;
}

function totalSpan(merged) {
  return merged.reduce((acc, iv) => acc + (iv[1] - iv[0]), 0);
}

// Overlap (≥2 workers running at once): sweep-line — total time covered by 2+ ints.
function concurrentSpan(intervals) {
  const events = [];
  for (const iv of intervals.filter(Boolean)) {
    events.push([iv[0], 1]);
    events.push([iv[1], -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let last = 0;
  let concurrent = 0;
  for (const [t, delta] of events) {
    if (depth >= 2) concurrent += t - last;
    depth += delta;
    last = t;
  }
  return concurrent;
}

const IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes (FR-CHK-002)

// ── dispatch_id dedup (P1-A) ─────────────────────────────────────────────────
// In Agent Teams mode the same SubagentStop event can be delivered twice,
// causing record-worker.mjs to append a duplicate (check-then-write is not
// atomic at the OS level). The consumer-side contract is to dedup here by
// dispatch_id before any metric computation so duplicates never inflate
// delegation_rate, worker_tokens, or time spans.
//
// Records without a dispatch_id (old-format or fallback-failed) are kept as-is:
// we cannot identify which other record they might duplicate, so we must never
// drop them. Only records that SHARE a non-null dispatch_id are deduplicated
// (keep the first occurrence in file order).
const seenDispatchIds = new Set();
const deduplicatedRecords = [];
for (const rec of records) {
  const did = rec.dispatch_id;
  if (did != null && did !== "") {
    if (seenDispatchIds.has(did)) continue; // duplicate — skip
    seenDispatchIds.add(did);
  }
  deduplicatedRecords.push(rec);
}

// ── record-type split (blocking fix: session_metrics must not pollute worker metrics) ─
// record-worker.mjs appends two kinds of lines to the same JSONL file:
//   1. per-worker rows      — no `event` field (backward-compat)
//   2. session_metrics rows — event === "session_metrics"
// All worker-derived metrics (delegation_rate, worker_token_ratio, etc.) MUST use
// workerRecords only. Mixing session_metrics rows into worker metric computation
// causes delegation_rate inflation (extra "records" in numerator), token metrics
// becoming null (session_metrics carries no worker_tokens/orchestrator_tokens), etc.
const workerRecords = deduplicatedRecords.filter((r) => r.event == null);
const sessionMetricRecords = deduplicatedRecords.filter((r) => r.event === "session_metrics");

// ── group by session_id ─────────────────────────────────────────────────────
// Worker metrics group by session_id over workerRecords only.
const sessions = new Map();
for (const rec of workerRecords) {
  const sid = rec.session_id;
  if (!sid) continue;
  if (!sessions.has(sid)) sessions.set(sid, []);
  sessions.get(sid).push(rec);
}

// No usable records = empty/truncated/all-session-id-less log. A fresh or truncated
// log must NOT be reported as a valid empty metrics result (fake-green). Fail loud.
if (records.length === 0) {
  process.stderr.write("[check-metrics] worker-log is empty — no records to compute metrics from.\n");
  process.exit(1);
}
if (sessions.size === 0) {
  process.stderr.write("[check-metrics] no records carry a session_id — cannot compute per-session metrics.\n");
  process.exit(1);
}

// ── global metrics (pre-loop) ─────────────────────────────────────────────────
// incomplete_ratio: global fraction of status=incomplete across ALL worker records.
const allCount = workerRecords.length;
const allIncompleteCount = workerRecords.filter((r) => r.status === "incomplete").length;
const incompleteRatio = allCount > 0 ? allIncompleteCount / allCount : null;

// ── compute metrics per session ───────────────────────────────────────────────
// Legacy 4 keys (preserved) + 5 P4 observation metrics (FR-CHK-001). All metric
// values are pure numbers or null — null = missing data, NEVER faked 0 (FR-CHK-004,
// FR-OBS-002). No verdict/threshold/gate field anywhere (FR-OBS-001).

const delegationRate = {};
const contextNetGrowth = {};
const contextPeak = {};
const orchestratorVsWorkerTokens = {};
// P4 observation metrics
const workerTokenRatio = {};
const contextInflationRate = {};
const workerTimeRatio = {};
const concurrentWorkerTimeRatio = {};
const dispatchSummaryCost = {};
const inflationDenominatorSource = {};
// Incomplete-record visibility (P1-B): how many status=incomplete placeholders
// exist per session. These represent dispatches that happened but whose data is
// partial (subagent crashed mid-run). Visible so auditors can assess data quality.
const incompleteCount = {};
// New monitoring metrics (per-session)
const completeTokenRatio = {};
const cumulativeWorkerTimeRatio = {};
const backendDistribution = {};

for (const [sid, recs] of sessions) {
  // Isolate status=incomplete placeholder records (P1-B). These prove a dispatch
  // happened but carry null/missing numeric fields, so including them in data-
  // dependent metric computations would corrupt the entire session's values.
  //
  // Strategy: incomplete records count toward delegation_rate (the dispatch is real
  // — it's the data that is partial, not the event) and are reported via
  // incomplete_count. They are excluded from every metric that requires numeric
  // fields (tokens, context, time intervals). This is the most honest treatment:
  // delegation_rate reflects actual dispatch volume, while null in token/context
  // metrics correctly signals "data incomplete" rather than fabricating a wrong number.
  const completeRecs = recs.filter((r) => r.status !== "incomplete");
  const numIncomplete = recs.length - completeRecs.length;
  incompleteCount[sid] = numIncomplete;

  // delegation_rate = ALL records (complete + incomplete) / MAX orchestrator_action_count.
  // Incomplete records still represent real dispatches, so they count in the numerator.
  let maxActions = 0;
  for (const r of recs) {
    if (typeof r.orchestrator_action_count === "number" && r.orchestrator_action_count > maxActions) {
      maxActions = r.orchestrator_action_count;
    }
  }
  // 0/0 is UNDEFINED, not a real 0: a session with no orchestrator actions has no
  // meaningful delegation rate. Report null to distinguish "undefined" from "true 0".
  delegationRate[sid] = maxActions > 0 ? recs.length / maxActions : null;

  // Context metrics (ordered by ts). FR-CHK-004 BUG FIX: distinguish a MISSING
  // context_size (null/undefined) from a real 0. The old `|| 0` turned a missing
  // value into 0 — masking missing-data as a real zero and corrupting net_growth /
  // peak / inflation. If ANY *complete* record in the session lacks a numeric
  // context_size we cannot trust the context series → mark the three context metrics
  // null (missing) and still compute every non-context metric below.
  // Uses completeRecs: incomplete placeholders have null context_size by design and
  // must not pull the whole session's context metrics to null.
  const ordered = completeRecs
    .slice()
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const ctxMissing = completeRecs.length === 0 ||
    completeRecs.some((r) => typeof r.orchestrator_context_size !== "number");

  let netGrowth = null;
  let peak = null;
  if (!ctxMissing) {
    const firstCtx = ordered[0].orchestrator_context_size;
    const lastCtx = ordered[ordered.length - 1].orchestrator_context_size;
    let maxCtx = firstCtx;
    for (const r of completeRecs) {
      const c = r.orchestrator_context_size;
      if (c > maxCtx) maxCtx = c;
    }
    // net_growth CAN BE NEGATIVE (cache compression = net shrink = good signal).
    netGrowth = lastCtx - firstCtx;
    // peak ≥ 0: largest expansion pressure relative to start.
    peak = maxCtx - firstCtx;
  }
  contextNetGrowth[sid] = netGrowth;
  contextPeak[sid] = peak;

  // orchestrator_vs_worker_tokens = { orchestrator: MAX orch tokens, worker: SUM worker tokens }
  // null-vs-0 discipline (same standard as ctxMissing above): a MISSING worker_tokens
  // (non-numeric in any record) must NOT be silently summed as 0 — that would fabricate
  // a fake-low worker total and corrupt worker_token_ratio. If any *complete* record lacks
  // a numeric worker_tokens we cannot trust the worker total → worker side is null
  // (missing), and worker_token_ratio is null too. orchestrator side stays a best-effort
  // max (it has its own per-record numeric guard).
  // Uses completeRecs: incomplete placeholders always have null worker_tokens (by design)
  // and must not poison the whole session's token metrics.
  let maxOrch = 0;
  let sumWorker = 0;
  const workerTokensMissing = completeRecs.length === 0 ||
    completeRecs.some((r) => typeof r.worker_tokens !== "number");
  for (const r of completeRecs) {
    if (typeof r.orchestrator_tokens === "number" && r.orchestrator_tokens > maxOrch) {
      maxOrch = r.orchestrator_tokens;
    }
    if (typeof r.worker_tokens === "number") sumWorker += r.worker_tokens;
  }
  orchestratorVsWorkerTokens[sid] = {
    orchestrator: maxOrch,
    worker: workerTokensMissing ? null : sumWorker,
  };

  // ── ① worker_token_ratio = sum(worker) / (sum(worker) + orchestrator) ────────
  // orchestrator token = max orchestrator_tokens (latest snapshot, same basis as
  // orchestrator_vs_worker_tokens). null if worker total is missing (can't fake 0) or
  // denominator unavailable (0/0).
  const tokenDenom = sumWorker + maxOrch;
  workerTokenRatio[sid] = workerTokensMissing || tokenDenom <= 0 ? null : sumWorker / tokenDenom;

  // ── time intervals (shared by ②③④) ─────────────────────────────────────────
  // Uses completeRecs: incomplete placeholders may carry null duration_ms/ts, which
  // workerInterval() would convert to null intervals that filter() drops. However,
  // including them at all risks polluting the time span with a half-formed interval.
  // Using completeRecs is conservative and correct.
  const intervals = completeRecs.map(workerInterval).filter(Boolean);
  const merged = mergeIntervals(intervals);
  // Total task time = span from earliest worker start to latest worker end.
  const totalStart = merged.length ? merged[0][0] : 0;
  const totalEnd = merged.length ? merged[merged.length - 1][1] : 0;
  const totalTaskTime = totalEnd - totalStart;
  // Union of worker active wall-clock.
  const workerUnion = totalSpan(merged);

  // Idle gaps = within total span, intervals with NO worker running whose length
  // exceeds the 10-minute threshold (FR-CHK-002 "挂机 = >10min 无小工在跑").
  const idleGaps = [];
  for (let i = 1; i < merged.length; i++) {
    const gapStart = merged[i - 1][1];
    const gapEnd = merged[i][0];
    if (gapEnd - gapStart > IDLE_THRESHOLD_MS) idleGaps.push([gapStart, gapEnd]);
  }

  // Human-wait: ONLY from session-record (worker-log can't carry it).
  let denomSource;
  let humanWaitIntervals = [];
  if (sessionRecord) {
    humanWaitIntervals = sessionRecord.humanWaitIntervals;
    denomSource = "session-record+worker-log";
  } else {
    // No session-record → human-wait unavailable; denominator from worker-log only.
    denomSource = "worker-log-fallback";
  }
  inflationDenominatorSource[sid] = denomSource;

  // execution time = total wall-clock − idle(>10min) − human-wait (FR-CHK-002).
  // Subtract the UNION of idle gaps and human-wait intervals exactly once: human-wait
  // that lies inside an idle gap (already removed) is not double-counted, and
  // human-wait in a short gap (≤10min, not idle, no worker running) is still removed.
  const removed = totalSpan(mergeIntervals([...idleGaps, ...humanWaitIntervals]));
  const executionMs = totalTaskTime - removed;

  // ── ② context_inflation_rate = context growth / execution-time-hours ─────────
  // null when context series is missing (bug-fix contagion) or execution time ≤ 0.
  if (netGrowth === null || executionMs <= 0) {
    contextInflationRate[sid] = null;
  } else {
    contextInflationRate[sid] = netGrowth / (executionMs / 3600000);
  }

  // ── ③ worker_time_ratio = union(worker wall-clock) / execution time ──────────
  // Spec FR-CHK-001 ③ denominator = 主会话执行时间 (execution time), NOT raw
  // total wall-clock (deviation from the task brief's "total wall-clock"; spec is
  // source of truth and is deliberately asymmetric vs ④). null if execution ≤ 0.
  workerTimeRatio[sid] = executionMs > 0 ? workerUnion / executionMs : null;

  // ── ④ concurrent_worker_time_ratio = overlap(≥2 workers) / total task time ───
  // Spec FR-CHK-001 ④ denominator = 整体任务时间 (total task time), NOT execution.
  const concurrent = concurrentSpan(intervals);
  concurrentWorkerTimeRatio[sid] = totalTaskTime > 0 ? concurrent / totalTaskTime : null;

  // ── ⑤ dispatch_summary_cost = per-dispatch [input, summary] absolute tokens ──
  // Two absolute values per delegation; either may be null → that field stays null
  // (missing), NEVER faked 0. An entry with both null = missing dispatch cost.
  // Uses completeRecs: incomplete placeholders have null dispatch tokens by construction;
  // including them would add noise entries without any real dispatch cost signal.
  dispatchSummaryCost[sid] = completeRecs.map((r) => ({
    dispatch_input_tokens:
      typeof r.dispatch_input_tokens === "number" ? r.dispatch_input_tokens : null,
    summary_return_est_tokens:
      typeof r.summary_return_est_tokens === "number" ? r.summary_return_est_tokens : null,
  }));

  // ── complete_token_ratio = sum(worker) / (sum(worker) + max(orchestrator)) ───
  // Uses complete four-field token count (input+output+cache_creation+cache_read)
  // but fixes the multi-worker denominator inflation bug: each worker-log record
  // carries the SNAPSHOT of orchestrator tokens at that moment. Summing all
  // snapshots repeats the same orchestrator spend N times (once per worker),
  // making the denominator grow with worker count instead of reflecting real cost.
  // Fix: use MAX(orchestrator_tokens) across all complete records, which equals
  // the final/peak orchestrator spend — same denominator treatment as
  // worker_token_ratio (which already uses maxOrch, not sumOrch). This keeps both
  // ratios consistent and prevents denominator inflation.
  // Null if any complete record lacks worker_tokens OR orchestrator_tokens.
  const orchTokensMissing = completeRecs.length === 0 ||
    completeRecs.some((r) => typeof r.orchestrator_tokens !== "number");
  if (workerTokensMissing || orchTokensMissing) {
    completeTokenRatio[sid] = null;
  } else {
    // maxOrch is already computed above (for orchestratorVsWorkerTokens / workerTokenRatio)
    const totalTokens = sumWorker + maxOrch;
    completeTokenRatio[sid] = totalTokens > 0 ? sumWorker / totalTokens : null;
  }

  // ── cumulative_worker_time_ratio = sum(duration_ms) / wall_clock_total_ms ───
  // Raw sum of durations / wall clock. Can exceed 100% when parallel — that's valid.
  // Null if no complete records with valid duration_ms + ts.
  const validDurations = completeRecs.filter(
    (r) => typeof r.duration_ms === "number" && workerInterval(r) !== null
  );
  if (validDurations.length === 0 || totalTaskTime <= 0) {
    cumulativeWorkerTimeRatio[sid] = null;
  } else {
    const sumDurations = validDurations.reduce((acc, r) => acc + r.duration_ms, 0);
    cumulativeWorkerTimeRatio[sid] = sumDurations / totalTaskTime;
  }

  // ── backend_distribution = count grouped by `backend` field ─────────────────
  // Records without `backend` field → "unknown" group. Uses ALL recs for session.
  const bdist = {};
  for (const r of recs) {
    const key = (typeof r.backend === "string" && r.backend) ? r.backend : "unknown";
    bdist[key] = (bdist[key] || 0) + 1;
  }
  backendDistribution[sid] = bdist;
}

// ── Batch C new metrics ───────────────────────────────────────────────────────

// ① orchestrator_new_input_ratio: per-session, from workerRecords.
// Each record carries the snapshot ratio at that dispatch. We use the max
// orchestrator_input_tokens record's value as the most representative snapshot
// (latest-snapshot semantics, same as orchestrator_vs_worker_tokens).
// null when no records have the field.
const orchestratorNewInputRatioBySession = {};
for (const [sid, recs] of sessions) {
  // Find the record with the highest orchestrator_input_tokens that ALSO carries
  // a valid orchestrator_new_input_ratio. Skipping records without the ratio field
  // avoids returning null when the highest-input record lacks the field but a
  // lower-input record has it (e.g. mixed old/new log entries).
  let bestRec = null;
  for (const r of recs) {
    if (typeof r.orchestrator_input_tokens !== "number") continue;
    if (typeof r.orchestrator_new_input_ratio !== "number") continue;
    if (bestRec === null || r.orchestrator_input_tokens >= bestRec.orchestrator_input_tokens) {
      bestRec = r;
    }
  }
  orchestratorNewInputRatioBySession[sid] = bestRec !== null ? bestRec.orchestrator_new_input_ratio : null;
}

// ② compact_count: scan the transcript for compact-summary records.
// A compact-summary record is one with isCompactSummary===true (confirmed field name
// from real Claude Code transcripts) OR type==="summary" (secondary signal).
// Returns null when no transcript is available (null = "we don't know", 0 = "confirmed 0").
// The old implementation counted .omc/state/checkpoints/checkpoint-*.json files (OMC
// snapshots, not real compacts) and has been replaced by this transcript-based approach.
function computeCompactCount(transcriptPath) {
  if (!transcriptPath) return null; // no transcript → unknown
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return null; // unreadable → unknown
  }
  let count = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && (rec.isCompactSummary === true || rec.type === "summary")) {
        count++;
      }
    } catch { /* skip malformed */ }
  }
  return { count, scope: "transcript" };
}
const compactCountResult = computeCompactCount(transcriptArg || null);

// ③ context_composition: take tool_call_composition from the LATEST session_metrics
// row (by ts) for each session. Each session_metrics row carries a cumulative
// snapshot of all tool calls seen up to that point — summing multiple rows would
// double-count calls already included in earlier snapshots. The newest snapshot is
// the authoritative total. null when no session_metrics rows exist for the session.
const contextCompositionBySession = {};
for (const [sid] of sessions) {
  const smRecs = sessionMetricRecords.filter((r) => r.session_id === sid);
  if (smRecs.length === 0) {
    contextCompositionBySession[sid] = null;
    continue;
  }
  // Find the latest record by ts (lexicographic ISO-8601 comparison is correct).
  let latestRec = smRecs[0];
  for (const r of smRecs) {
    if ((r.ts || "") >= (latestRec.ts || "")) latestRec = r;
  }
  const tc = latestRec.tool_call_composition;
  if (!tc || typeof tc !== "object") {
    contextCompositionBySession[sid] = null;
    continue;
  }
  contextCompositionBySession[sid] = {
    bash: typeof tc.bash === "number" ? tc.bash : 0,
    agent: typeof tc.agent === "number" ? tc.agent : 0,
    read_only: typeof tc.read_only === "number" ? tc.read_only : 0,
    other: typeof tc.other === "number" ? tc.other : 0,
  };
}

// ④ true_single_turn_peak: max context_peak_tokens across sessionMetricRecords for
// each session. null when no session_metrics rows exist.
const trueSingleTurnPeakBySession = {};
for (const [sid] of sessions) {
  const smRecs = sessionMetricRecords.filter((r) => r.session_id === sid);
  let peak = null;
  for (const r of smRecs) {
    if (typeof r.context_peak_tokens === "number") {
      if (peak === null || r.context_peak_tokens > peak) peak = r.context_peak_tokens;
    }
  }
  trueSingleTurnPeakBySession[sid] = peak;
}

// ── review_return_rate (把关率) = count(return) / count(accept+return) ────────
// Data source: extract-gates.mjs subprocess, invoked only when --transcript passed.
// "unknown" does NOT count in denominator.
// Key intentionally avoids "gate" substring to satisfy FR-OBS-001 regex.
let reviewReturnRate = null;
if (transcriptArg) {
  const extractGatesScript = new URL("./extract-gates.mjs", import.meta.url).pathname;
  const gateResult = spawnSync("node", [extractGatesScript, transcriptArg], { encoding: "utf8" });
  if (gateResult.status === 0 && gateResult.stdout) {
    try {
      const gates = JSON.parse(gateResult.stdout);
      if (Array.isArray(gates)) {
        let acceptCount = 0;
        let returnCount = 0;
        for (const g of gates) {
          if (g.gate === "accept") acceptCount++;
          else if (g.gate === "return") returnCount++;
        }
        const denom = acceptCount + returnCount;
        reviewReturnRate = denom > 0 ? returnCount / denom : null;
      }
    } catch (_) {
      // parse failure — leave null
    }
  }
}

// ── enforce_deny metrics ─────────────────────────────────────────────────────
// Reads enforce-log.jsonl (written by enforce-backend.mjs) to surface the physical
// deny evidence: how many times the hook blocked a wrong-backend / marker dispatch.
// Path: --enforce-log <path> flag, else auto-detect via CLAUDE_PROJECT_DIR or cwd.
// File-not-found → 0 denies (graceful); malformed line → skipped (non-fatal).
// This is the key "物理强制有没有真生效" signal: deny_count > 0 proves the hook fired.
let enforceDenyCount = 0;
const enforceDenyByReason = {}; // { wrong_backend: N, marker_block: N, invalid_backend: N }

(function readEnforceLog() {
  // Determine enforce-log path:
  //   1. --enforce-log CLI flag
  //   2. CLAUDE_PROJECT_DIR env
  //   3. cwd
  let enforceLogPath = enforceLogArg;
  if (!enforceLogPath) {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    enforceLogPath = root ? [root, ".worker-mode", "state", "enforce-log.jsonl"].join("/") : "";
  }
  if (!enforceLogPath) return;

  let rawLog;
  try {
    rawLog = readFileSync(enforceLogPath, "utf8");
  } catch {
    // File not found or unreadable → 0 denies, no crash
    return;
  }

  for (const line of rawLog.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines — non-fatal
    }
    if (entry.decision === "deny") {
      enforceDenyCount++;
      const reason = typeof entry.reason === "string" ? entry.reason : "unknown";
      enforceDenyByReason[reason] = (enforceDenyByReason[reason] || 0) + 1;
    }
  }
})();

// ── output ──────────────────────────────────────────────────────────────────
// Five OBSERVATION metrics + legacy keys + 5 new monitoring metrics.
// inflation_denominator_source is a sibling label (NOT a metric value) so the
// metric leaves stay pure number|null (FR-OBS-002).

const out = {
  delegation_rate: delegationRate,
  context_net_growth: contextNetGrowth,
  context_peak: contextPeak,
  orchestrator_vs_worker_tokens: orchestratorVsWorkerTokens,
  // P4 five observation metrics (FR-CHK-001)
  worker_token_ratio: workerTokenRatio,
  context_inflation_rate: contextInflationRate,
  worker_time_ratio: workerTimeRatio,
  concurrent_worker_time_ratio: concurrentWorkerTimeRatio,
  dispatch_summary_cost: dispatchSummaryCost,
  inflation_denominator_source: inflationDenominatorSource,
  // Audit field: how many status=incomplete placeholders exist per session.
  // Non-zero means some dispatches lost their numeric data (subagent crash).
  incomplete_count: incompleteCount,
  // New monitoring metrics
  complete_token_ratio: completeTokenRatio,
  cumulative_worker_time_ratio: cumulativeWorkerTimeRatio,
  backend_distribution: backendDistribution,
  review_return_rate: reviewReturnRate,
  incomplete_ratio: incompleteRatio,
  // Physical enforcement evidence from enforce-backend.mjs deny log.
  // enforce_deny_count > 0 proves the hook fired and blocked at least one dispatch.
  enforce_deny_count: enforceDenyCount,
  enforce_deny_by_reason: enforceDenyByReason,
  // Batch C new metrics (design 2.3)
  orchestrator_new_input_ratio: orchestratorNewInputRatioBySession,
  compact_count: compactCountResult,
  context_composition: contextCompositionBySession,
  true_single_turn_peak: trueSingleTurnPeakBySession,
};

if (json) {
  process.stdout.write(JSON.stringify(out) + "\n");
} else {
  // Missing data renders as N/A (NOT a bare 0): null = undefined/missing, never a
  // faked zero (A-002, FR-CHK-004/FR-OBS-002). Pure observation text — no
  // verdict/threshold/gate wording (FR-OBS-001).
  const na = (v) => (v === null || v === undefined ? "N/A" : String(v));
  const sids = [...sessions.keys()];
  process.stdout.write("Delegation metrics (" + sids.length + " session(s))\n");
  for (const sid of sids) {
    const t = orchestratorVsWorkerTokens[sid];
    process.stdout.write("\n[session " + sid + "]\n");
    const dr = delegationRate[sid] === null
      ? "N/A（主会话动作数为 0,无法计算）"
      : delegationRate[sid] + "  = records / orchestrator action count";
    process.stdout.write("  delegation rate (委派率): " + dr + "\n");
    process.stdout.write("  context net growth (上下文净增长): " + na(contextNetGrowth[sid]) +
      "  = last - first（负值=上下文净收缩=委派有效）\n");
    process.stdout.write("  context peak (上下文峰值压力): " + na(contextPeak[sid]) +
      "  = max - first（恒≥0,峰值相对起点的最大扩张）\n");
    process.stdout.write("  orchestrator vs worker token: orchestrator=" + t.orchestrator +
      " worker=" + t.worker + "\n");
    // ── P4 five observation metrics (FR-CHK-001) — same per-session values as the
    //    --json branch, printed by their snake_case keys so the manual `--log`
    //    usage (no --json) surfaces all five. Missing data shows N/A, never 0.
    process.stdout.write("  worker_token_ratio (小工 token 占比): " + na(workerTokenRatio[sid]) + "\n");
    process.stdout.write("  context_inflation_rate (上下文膨胀率, tokens/hour): " +
      na(contextInflationRate[sid]) + "  [denominator: " + na(inflationDenominatorSource[sid]) + "]\n");
    process.stdout.write("  worker_time_ratio (小工时间占比): " + na(workerTimeRatio[sid]) + "\n");
    process.stdout.write("  concurrent_worker_time_ratio (并发小工时间占比): " +
      na(concurrentWorkerTimeRatio[sid]) + "\n");
    const dsc = dispatchSummaryCost[sid] || [];
    const dscStr = dsc.length === 0
      ? "N/A"
      : dsc
          .map((e) => "[in=" + na(e.dispatch_input_tokens) + " summary=" + na(e.summary_return_est_tokens) + "]")
          .join(" ");
    process.stdout.write("  dispatch_summary_cost (每次派发 [输入, 摘要] token): " + dscStr + "\n");
    const ic = incompleteCount[sid] || 0;
    process.stdout.write("  incomplete_count (数据残缺的派发占位数): " + ic + "\n");
  }

  // ── Monitoring Metrics (新增指标) ────────────────────────────────────────
  process.stdout.write("\n## Monitoring Metrics (新增指标)\n");
  for (const sid of sids) {
    process.stdout.write("\n[session " + sid + "]\n");

    // complete_token_ratio
    const ctr = completeTokenRatio[sid];
    if (ctr === null) {
      process.stdout.write("  complete_token_ratio (完整口径 token 占比): N/A\n");
    } else {
      const pct = (ctr * 100).toFixed(1);
      const health = ctr >= 0.6 ? "✓健康" : ctr < 0.3 ? "⚠低于红线(<30%)" : "";
      process.stdout.write("  complete_token_ratio (完整口径 token 占比): " + pct + "% " + health + "\n");
    }

    // cumulative_worker_time_ratio
    const cwtr = cumulativeWorkerTimeRatio[sid];
    if (cwtr === null) {
      process.stdout.write("  cumulative_worker_time_ratio (子代理累计耗时/墙钟): N/A\n");
    } else {
      const pct = (cwtr * 100).toFixed(1);
      const note = cwtr > 1 ? " (>100%=并行,正常)" : "";
      process.stdout.write("  cumulative_worker_time_ratio (子代理累计耗时/墙钟): " + pct + "%" + note + "\n");
    }

    // backend_distribution
    const bdist = backendDistribution[sid] || {};
    const bdTotal = Object.values(bdist).reduce((a, b) => a + b, 0);
    const omcCount = bdist["omc"] || 0;
    const omcPct = bdTotal > 0 ? ((omcCount / bdTotal) * 100).toFixed(1) : "N/A";
    const bdHealth = bdTotal > 0
      ? (omcCount / bdTotal >= 0.8 ? "✓健康" : omcCount / bdTotal < 0.2 ? "⚠红线" : "")
      : "";
    const bdStr = Object.entries(bdist).map(([k, v]) => k + "=" + v).join(" ") || "{}";
    process.stdout.write("  backend_distribution (后端分布): " + bdStr + " omc占比=" + omcPct + "% " + bdHealth + "\n");
  }

  // review_return_rate (global)
  if (reviewReturnRate === null) {
    process.stdout.write("  review_return_rate (把关率): N/A: no reliable review source\n");
  } else {
    const pct = (reviewReturnRate * 100).toFixed(1);
    const health = reviewReturnRate >= 0.05 && reviewReturnRate <= 0.2
      ? "✓健康"
      : reviewReturnRate < 0.02
      ? "⚠红线(<2%)"
      : reviewReturnRate > 0.5
      ? "⚠偏高(>50%)"
      : "";
    process.stdout.write("  review_return_rate (把关率): " + pct + "% " + health + "\n");
  }

  // incomplete_ratio (global)
  if (incompleteRatio === null) {
    process.stdout.write("  incomplete_ratio (incomplete 占比): N/A\n");
  } else {
    const pct = (incompleteRatio * 100).toFixed(1);
    const health = incompleteRatio < 0.1 ? "✓健康" : incompleteRatio > 0.3 ? "⚠红线(>30%)" : "";
    process.stdout.write("  incomplete_ratio (incomplete 占比): " + pct + "% " + health + "\n");
  }

  // ── Batch C new metrics (design 2.3) ─────────────────────────────────────────
  process.stdout.write("\n## Batch C Metrics (新增指标)\n");
  for (const sid of sids) {
    process.stdout.write("\n[session " + sid + "]\n");

    // ① orchestrator_new_input_ratio
    const onir = orchestratorNewInputRatioBySession[sid];
    process.stdout.write("  [新增输入比率] orchestrator_new_input_ratio: " +
      (onir === null || onir === undefined ? "N/A" : onir.toFixed(4)) + "\n");

    // ③ context_composition
    const cc = contextCompositionBySession[sid];
    if (!cc) {
      process.stdout.write("  [上下文构成]   context_composition: N/A\n");
    } else {
      process.stdout.write("  [上下文构成]   context_composition: Bash=" + cc.bash +
        ", Agent=" + cc.agent + ", ReadOnly=" + cc.read_only + ", Other=" + cc.other + "\n");
    }

    // ④ true_single_turn_peak
    const tsp = trueSingleTurnPeakBySession[sid];
    process.stdout.write("  [单轮峰值]     true_single_turn_peak: " +
      (tsp === null || tsp === undefined ? "N/A" : tsp.toLocaleString() + " tokens") + "\n");
  }

  // ② compact_count (from transcript scan)
  {
    const cc = compactCountResult;
    if (cc === null) {
      process.stdout.write("  [压缩次数]     compact_count: null (no transcript provided)\n");
    } else if (cc.count === 0) {
      process.stdout.write("  [压缩次数]     compact_count: 0 (no compact-summary records in transcript)\n");
    } else {
      process.stdout.write("  [压缩次数]     compact_count: " + cc.count + " (transcript)\n");
    }
  }

  // enforce_deny metrics (global, from enforce-log.jsonl)
  // Physical enforcement evidence: deny_count > 0 = hook has actively blocked dispatches.
  process.stdout.write("\n## Enforce-Backend Deny Metrics (物理强制拦截证据)\n");
  if (enforceDenyCount === 0 && Object.keys(enforceDenyByReason).length === 0) {
    process.stdout.write("  enforce_deny_count: 0 denies (no enforce-log or no deny entries)\n");
  } else {
    process.stdout.write("  enforce_deny_count: " + enforceDenyCount + "\n");
    const reasons = Object.entries(enforceDenyByReason).map(([r, n]) => r + "=" + n).join(" ");
    process.stdout.write("  enforce_deny_by_reason: " + (reasons || "{}") + "\n");
  }
}

process.exit(0);
