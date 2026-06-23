#!/usr/bin/env node
// check-metrics.mjs — one-shot, post-hoc CLI that reads the unified worker-log JSONL
// and computes the delegation/observation metrics. It is NOT a resident process
// (FR-CHK-003): it reads, prints, and exits — no watchers, no loops, no listeners.
// Node ESM, no external dependencies.
//
// Usage:
//   node check-metrics.mjs --log <path> [--session-record <path>] [--json]
//   WORKER_LOG_PATH=<path> node check-metrics.mjs [--json]

import { readFileSync } from "node:fs";

// ── args ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let log = "";
  let json = false;
  let sessionRecord = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log") {
      log = argv[i + 1] || "";
      i++;
    } else if (argv[i] === "--session-record") {
      // Optional: the orchestrator-side session record (transcript) parsed ONLY when
      // manually passed (FR-CHK-003). Supplies human-wait intervals for inflation.
      sessionRecord = argv[i + 1] || "";
      i++;
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  return { log, json, sessionRecord };
}

const { log: logArg, json, sessionRecord: sessionRecordArg } = parseArgs(process.argv.slice(2));
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

// ── group by session_id ─────────────────────────────────────────────────────

const sessions = new Map();
for (const rec of deduplicatedRecords) {
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
    summary_return_tokens:
      typeof r.summary_return_tokens === "number" ? r.summary_return_tokens : null,
  }));
}

// ── output ──────────────────────────────────────────────────────────────────
// Five OBSERVATION metrics + legacy keys. inflation_denominator_source is a sibling
// label (NOT a metric value) so the metric leaves stay pure number|null (FR-OBS-002).

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
          .map((e) => "[in=" + na(e.dispatch_input_tokens) + " summary=" + na(e.summary_return_tokens) + "]")
          .join(" ");
    process.stdout.write("  dispatch_summary_cost (每次派发 [输入, 摘要] token): " + dscStr + "\n");
    const ic = incompleteCount[sid] || 0;
    process.stdout.write("  incomplete_count (数据残缺的派发占位数): " + ic + "\n");
  }
}

process.exit(0);
