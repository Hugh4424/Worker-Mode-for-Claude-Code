// EC-CHK test — check-metrics.mjs computes the 3 delegation metrics from a worker-log,
// validated against the SAME real sample produced by record-worker.mjs (closed loop:
// the record schema must truly support metric computation).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checkScript = join(pluginRoot, "tools", "check-metrics.mjs");

// Two real records for session "sessA", as emitted by record-worker.mjs.
// Hand-computed expected metrics (locked literally so the test can falsify wrong math):
//   delegation rate  = records / orchestrator_action_count = 2 / 10 = 0.2
//   context growth   = last context_size - first = 1500 - 1000 = 500
//   orchestrator vs worker tokens = max orchestrator_tokens (900) vs sum worker_tokens (50+70=120)
const SAMPLE = [
  { session_id: "sessA", orchestrator_action_count: 10, orchestrator_tokens: 600, orchestrator_context_size: 1000, worker_tokens: 50, duration_ms: 3000, model: "claude-sonnet-4-6", work: "did 1", result: "ok", files: ["f1.ts"], ts: "2026-06-19T11:11:26.845Z" },
  { session_id: "sessA", orchestrator_action_count: 10, orchestrator_tokens: 900, orchestrator_context_size: 1500, worker_tokens: 70, duration_ms: 3000, model: "claude-sonnet-4-6", work: "did 2", result: "ok", files: ["f2.ts"], ts: "2026-06-19T11:11:26.896Z" },
];

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "chk-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(logPath, json = true) {
  const args = [checkScript, "--log", logPath];
  if (json) args.push("--json");
  return spawnSync("node", args, { encoding: "utf8" });
}

// Same as run() but also passes a --session-record path (dual-source inflation, FR-CHK-002).
function runWithSession(logPath, sessionRecordPath, json = true) {
  const args = [checkScript, "--log", logPath, "--session-record", sessionRecordPath];
  if (json) args.push("--json");
  return spawnSync("node", args, { encoding: "utf8" });
}

function writeSample() {
  const p = join(dir, "worker-log.jsonl");
  writeFileSync(p, SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

test("EC-CHK: computes all three metrics (FR-CHK-001)", () => {
  const p = writeSample();
  const r = run(p);
  assert.equal(r.status, 0, `check-metrics must exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok("delegation_rate" in out, "must output delegation_rate");
  assert.ok("context_net_growth" in out, "must output context_net_growth");
  assert.ok("context_peak" in out, "must output context_peak");
  assert.ok("orchestrator_vs_worker_tokens" in out, "must output orchestrator_vs_worker_tokens");
});

test("EC-CHK: delegation rate = records / action count (matches hand calc)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  // per session sessA: 2 records / 10 actions = 0.2
  const sess = out.delegation_rate.sessA ?? out.delegation_rate;
  assert.equal(Number(sess), 0.2, "delegation rate sessA = 2/10 = 0.2");
});

test("EC-CHK: context net growth = last - first context_size per session", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  const g = out.context_net_growth.sessA ?? out.context_net_growth;
  assert.equal(Number(g), 500, "context net growth sessA = 1500 - 1000 = 500");
});

test("EC-CHK: context peak = max context_size - first per session", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  const p = out.context_peak.sessA ?? out.context_peak;
  assert.equal(Number(p), 500, "context peak sessA = max(1500) - 1000 = 500");
});

test("EC-CHK: orchestrator vs worker tokens (orchestrator max vs summed worker)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  const t = out.orchestrator_vs_worker_tokens.sessA ?? out.orchestrator_vs_worker_tokens;
  assert.equal(Number(t.orchestrator), 900, "orchestrator tokens = max 900");
  assert.equal(Number(t.worker), 120, "summed worker tokens = 50 + 70 = 120");
});

test("EC-CHK: empty/missing log fails loud, not silent zero (FR-CHK / let-it-crash)", () => {
  const r = run(join(dir, "does-not-exist.jsonl"));
  assert.notEqual(r.status, 0, "missing log must exit non-zero, not pretend zero metrics");
});

test("EC-CHK: human-readable output mode also works (FR-CHK-002 check command)", () => {
  const p = writeSample();
  const r = run(p, false);
  assert.equal(r.status, 0, "non-json mode exits 0");
  assert.match(r.stdout, /delegation|委派|context|token/i, "prints human-readable metrics");
});

test("EC-CHK: empty worker-log fails loud, not empty-metrics fake-green (round-2 fix)", () => {
  const empty = join(dir, "empty-worker-log.jsonl");
  writeFileSync(empty, "");
  const r = run(empty);
  assert.notEqual(r.status, 0, "empty log must exit non-zero, not print empty metric objects");
});

test("EC-CHK: malformed worker-log line fails loud with line info (round-2 fix)", () => {
  const bad = join(dir, "bad-worker-log.jsonl");
  // one valid record + one corrupt line
  writeFileSync(bad, JSON.stringify(SAMPLE[0]) + "\n{not valid json\n");
  const r = run(bad);
  assert.notEqual(r.status, 0, "malformed line must exit non-zero (no silent skip)");
  assert.match((r.stderr || ""), /malformed|line/i, "must report the malformed line");
});

// ── P4: delegation rate denominator 0 → null (undefined), NOT 0 (real zero) ──────
// A session whose orchestrator_action_count is always 0 has an undefined delegation
// rate (0/0), which must be reported as null — distinct from a true 0 rate.
const ZERO_ACTION_SAMPLE = [
  { session_id: "sessZ", orchestrator_action_count: 0, orchestrator_tokens: 600, orchestrator_context_size: 1000, worker_tokens: 50, duration_ms: 3000, model: "claude-sonnet-4-6", work: "did 1", result: "ok", files: ["f1.ts"], ts: "2026-06-19T11:11:26.845Z" },
  { session_id: "sessZ", orchestrator_action_count: 0, orchestrator_tokens: 900, orchestrator_context_size: 1500, worker_tokens: 70, duration_ms: 3000, model: "claude-sonnet-4-6", work: "did 2", result: "ok", files: ["f2.ts"], ts: "2026-06-19T11:11:26.896Z" },
];

function writeZeroActionSample() {
  const p = join(dir, "zero-action-worker-log.jsonl");
  writeFileSync(p, ZERO_ACTION_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

test("EC-CHK (P4): delegation rate is null when orchestrator action count is 0 (undefined ≠ real 0)", () => {
  const out = JSON.parse(run(writeZeroActionSample()).stdout);
  // JSON null survives JSON.parse as `null`; "sessZ" in delegation_rate must be null.
  assert.ok("sessZ" in out.delegation_rate, "must still list the session");
  assert.strictEqual(out.delegation_rate.sessZ, null, "delegation rate sessZ = null (0/0 undefined)");
});

test("EC-CHK (P4): human-readable output prints N/A for undefined delegation rate", () => {
  const r = run(writeZeroActionSample(), false);
  assert.equal(r.status, 0, "non-json mode exits 0");
  assert.match(r.stdout, /N\/A/, "delegation rate line prints N/A when action count is 0");
});

// ── P3: split context metric — cache compression makes net_growth negative ───────
// A session whose context_size rises to a peak then is compressed below its start:
// net_growth = last - first < 0 (net shrink = good signal, NOT a bug),
// peak = max - first > 0 (peak expansion pressure relative to start).
const COMPRESSION_SAMPLE = [
  { session_id: "sessC", orchestrator_action_count: 10, orchestrator_tokens: 600, orchestrator_context_size: 1000, worker_tokens: 50, duration_ms: 3000, model: "claude-sonnet-4-6", work: "start", result: "ok", files: ["f1.ts"], ts: "2026-06-19T11:11:26.845Z" },
  { session_id: "sessC", orchestrator_action_count: 10, orchestrator_tokens: 700, orchestrator_context_size: 3000, worker_tokens: 60, duration_ms: 3000, model: "claude-sonnet-4-6", work: "peak", result: "ok", files: ["f2.ts"], ts: "2026-06-19T11:11:27.000Z" },
  { session_id: "sessC", orchestrator_action_count: 10, orchestrator_tokens: 900, orchestrator_context_size: 800, worker_tokens: 70, duration_ms: 3000, model: "claude-sonnet-4-6", work: "compressed", result: "ok", files: ["f3.ts"], ts: "2026-06-19T11:11:28.000Z" },
];

function writeCompressionSample() {
  const p = join(dir, "compression-worker-log.jsonl");
  writeFileSync(p, COMPRESSION_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

test("EC-CHK (P3): net_growth is negative on cache compression (net shrink = good signal, not a bug)", () => {
  const out = JSON.parse(run(writeCompressionSample()).stdout);
  const net = out.context_net_growth.sessC ?? out.context_net_growth;
  // last (800) - first (1000) = -200
  assert.equal(Number(net), -200, "net_growth sessC = 800 - 1000 = -200 (negative = net shrink)");
});

test("EC-CHK (P3): peak is positive = max - first, independent of net shrink", () => {
  const out = JSON.parse(run(writeCompressionSample()).stdout);
  const peak = out.context_peak.sessC ?? out.context_peak;
  // max(3000) - first(1000) = 2000
  assert.equal(Number(peak), 2000, "peak sessC = max(3000) - 1000 = 2000");
});

// ════════════════════════════════════════════════════════════════════════════
// P4: five OBSERVATION metrics + dual-source inflation + missing-data bug fix
//   metric keys (plan ch.4): worker_token_ratio, context_inflation_rate,
//   worker_time_ratio, concurrent_worker_time_ratio, dispatch_summary_cost
// ════════════════════════════════════════════════════════════════════════════

const FIVE_METRIC_KEYS = [
  "worker_token_ratio",
  "context_inflation_rate",
  "worker_time_ratio",
  "concurrent_worker_time_ratio",
  "dispatch_summary_cost",
];

// ── T020/T021a: 5 metric keys present, each asserted independently ────────────
test("EC-CHK (P4): worker_token_ratio key is present (FR-CHK-001 ①)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  assert.ok("worker_token_ratio" in out, "must output worker_token_ratio");
});
test("EC-CHK (P4): context_inflation_rate key is present (FR-CHK-001 ②)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  assert.ok("context_inflation_rate" in out, "must output context_inflation_rate");
});
test("EC-CHK (P4): worker_time_ratio key is present (FR-CHK-001 ③)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  assert.ok("worker_time_ratio" in out, "must output worker_time_ratio");
});
test("EC-CHK (P4): concurrent_worker_time_ratio key is present (FR-CHK-001 ④)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  assert.ok("concurrent_worker_time_ratio" in out, "must output concurrent_worker_time_ratio");
});
test("EC-CHK (P4): dispatch_summary_cost key is present (FR-CHK-001 ⑤)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  assert.ok("dispatch_summary_cost" in out, "must output dispatch_summary_cost");
});

// ── ① worker_token_ratio = sum(worker) / (sum(worker) + orchestrator) ─────────
test("EC-CHK (P4): worker_token_ratio = sum(worker)/(sum(worker)+orchestrator)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  const r = out.worker_token_ratio.sessA;
  // sum worker = 50+70 = 120; orchestrator (max) = 900; 120/(120+900) = 120/1020
  assert.ok(Math.abs(Number(r) - 120 / 1020) < 1e-9, "worker_token_ratio sessA = 120/1020");
});

// ── ② context_inflation_rate dual-source: subtracts idle>10min AND human-wait ─
// Worker-log carries worker intervals [ts-duration_ms, ts]; idle>10min gaps are
// derivable from those alone. human-wait can ONLY come from the session-record.
// Sample: two workers far apart in time creating a >10min idle gap between them,
// plus a session-record declaring a human-wait interval. The denominator
// (execution time) must subtract BOTH; deleting either subtraction reddens.
//
// Timeline (ms epoch via ISO):
//   worker1: [t0, t0+60s]      (duration 60000)
//   worker2: [t0+1260s, t0+1320s]  (duration 60000)  -> gap = 1200s = 20min > 10min idle
//   total wall-clock = t0 .. t0+1320s = 1320s
//   idle (>10min, no worker running) = 1200s
//   human-wait (from session-record) = 120s, placed INSIDE a running region so it
//     is not already counted as idle (here: during worker1's active window does not
//     make sense; instead place it overlapping no worker but we count it separately).
//   To keep the two subtractions independent & non-overlapping, human-wait is a
//   declared interval that does NOT coincide with the idle gap:
//     human-wait = [t0+10s, t0+130s] = 120s, which sits inside worker1's window so it
//     is NOT part of idle — execution = 1320 - 1200(idle) - 120(human) = 0? bad.
//   Use clearly separable numbers instead (see below): pick total/idle/human distinct.
const INFLATE_T0 = Date.parse("2026-06-20T00:00:00.000Z");
function iso(ms) { return new Date(ms).toISOString(); }
// worker1 active [0s,60s], worker2 active [1260s,1320s] -> total 1320s, idle gap 1200s.
const INFLATE_SAMPLE = [
  { session_id: "sessI", orchestrator_action_count: 4, orchestrator_tokens: 600, orchestrator_context_size: 1000, worker_tokens: 50, duration_ms: 60000, model: "claude-sonnet-4-6", work: "w1", result: "ok", files: ["f1.ts"], dispatch_input_tokens: 10, summary_return_tokens: null, ts: iso(INFLATE_T0 + 60000) },
  { session_id: "sessI", orchestrator_action_count: 4, orchestrator_tokens: 900, orchestrator_context_size: 4000, worker_tokens: 70, duration_ms: 60000, model: "claude-sonnet-4-6", work: "w2", result: "ok", files: ["f2.ts"], dispatch_input_tokens: 20, summary_return_tokens: null, ts: iso(INFLATE_T0 + 1320000) },
];
function writeInflateSample() {
  const p = join(dir, "inflate-worker-log.jsonl");
  writeFileSync(p, INFLATE_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
// Session-record declares a human-wait interval that lies OUTSIDE the idle gap
// (inside worker1's active window [0s,60s]), so it is independently subtracted and
// does not double-count the idle. human-wait = [10s,40s] = 30s.
function writeSessionRecord() {
  const p = join(dir, "session-record.json");
  writeFileSync(p, JSON.stringify({
    human_wait_intervals: [
      { start: iso(INFLATE_T0 + 10000), end: iso(INFLATE_T0 + 40000) }, // 30s
    ],
  }));
  return p;
}

test("EC-CHK (P4): inflation denominator subtracts idle>10min AND human-wait (FR-CHK-002)", () => {
  const out = JSON.parse(runWithSession(writeInflateSample(), writeSessionRecord()).stdout);
  const rate = out.context_inflation_rate.sessI;
  // context growth = last(4000) - first(1000) = 3000
  // total wall-clock = 1320s; idle>10min = 1200s; human-wait = 30s
  // execution time = 1320 - 1200 - 30 = 90s = 0.025 hours
  // inflation rate = 3000 / 0.025 = 120000 tokens/hour
  // Falsifiable: if idle NOT subtracted -> exec=1290-30=1260? different. if human NOT
  // subtracted -> exec=120s -> rate=90000. Both deletions change the number.
  const execHours = (1320 - 1200 - 30) / 3600;
  const expected = 3000 / execHours;
  assert.ok(Math.abs(Number(rate) - expected) < 1e-6,
    `inflation rate sessI = 3000 / ((1320-1200-30)/3600) = ${expected}, got ${rate}`);
});

// Human-wait in a SHORT gap (≤10min, NOT idle, no worker running) must still be
// subtracted. This discriminates the union-subtraction fix from the buggy
// "intersect human-wait with active union" approach (which would drop it = 0 removed).
const SHORTGAP_SAMPLE = [
  // worker1 active [0s,60s]
  { session_id: "sessS", orchestrator_action_count: 4, orchestrator_tokens: 600, orchestrator_context_size: 1000, worker_tokens: 50, duration_ms: 60000, model: "claude-sonnet-4-6", work: "w1", result: "ok", files: ["f1.ts"], dispatch_input_tokens: 10, summary_return_tokens: null, ts: iso(INFLATE_T0 + 60000) },
  // worker2 active [360s,420s] -> gap = 300s = 5min (≤10min, NOT idle)
  { session_id: "sessS", orchestrator_action_count: 4, orchestrator_tokens: 900, orchestrator_context_size: 4000, worker_tokens: 70, duration_ms: 60000, model: "claude-sonnet-4-6", work: "w2", result: "ok", files: ["f2.ts"], dispatch_input_tokens: 20, summary_return_tokens: null, ts: iso(INFLATE_T0 + 420000) },
];
function writeShortGapSample() {
  const p = join(dir, "shortgap-worker-log.jsonl");
  writeFileSync(p, SHORTGAP_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
function writeShortGapSession() {
  const p = join(dir, "shortgap-session-record.json");
  // human-wait [120s,240s] = 120s, sitting INSIDE the 5min short gap (no worker, NOT idle)
  writeFileSync(p, JSON.stringify({
    human_wait_intervals: [{ start: iso(INFLATE_T0 + 120000), end: iso(INFLATE_T0 + 240000) }],
  }));
  return p;
}
test("EC-CHK (P4): human-wait in a short (≤10min) gap is still subtracted (FR-CHK-002)", () => {
  const out = JSON.parse(runWithSession(writeShortGapSample(), writeShortGapSession()).stdout);
  const rate = out.context_inflation_rate.sessS;
  // total = 420s; idle>10min = 0 (gap is 5min); human-wait = 120s (in the short gap)
  // execution = 420 - 0 - 120 = 300s; growth = 4000-1000 = 3000
  // Falsifiable: the buggy "intersect with active union" subtracts 0 here -> exec=420.
  const expected = 3000 / (300 / 3600);
  assert.ok(Math.abs(Number(rate) - expected) < 1e-6,
    `short-gap human-wait must subtract: 3000/((420-120)/3600)=${expected}, got ${rate}`);
});

test("EC-CHK (P4): inflation falls back to worker-log timestamps when no session-record, marks source", () => {
  const out = JSON.parse(run(writeInflateSample()).stdout); // no --session-record
  const rate = out.context_inflation_rate.sessI;
  // no session-record -> human-wait cannot be subtracted; only idle removed.
  // execution = 1320 - 1200 = 120s = 1/30 hour; rate = 3000 / (120/3600) = 90000
  const expected = 3000 / (120 / 3600);
  assert.ok(Math.abs(Number(rate) - expected) < 1e-6,
    `fallback inflation = 3000 / (120/3600) = ${expected}, got ${rate}`);
  // the denominator source must be marked (sibling key, NOT inside a metric value).
  assert.ok("inflation_denominator_source" in out, "must mark inflation denominator source");
  assert.match(String(out.inflation_denominator_source.sessI), /worker-log|worker_log|fallback/i,
    "fallback source marked as worker-log when session-record absent");
});

// ── ③ worker_time_ratio = union(worker wall-clock) / execution time ───────────
test("EC-CHK (P4): worker_time_ratio = union(worker)/execution time", () => {
  const out = JSON.parse(run(writeInflateSample()).stdout);
  const r = out.worker_time_ratio.sessI;
  // union worker active = 60s + 60s = 120s (non-overlapping); execution (worker-log
  // fallback) = total(1320) - idle(1200) = 120s; ratio = 120/120 = 1
  assert.ok(Math.abs(Number(r) - 1) < 1e-9, `worker_time_ratio sessI = 120/120 = 1, got ${r}`);
});

// ── ④ concurrent_worker_time_ratio = overlap / total task time ────────────────
// Distinguishes true parallel from serial. Serial sample (no overlap) -> 0;
// parallel sample (overlap) -> nonzero.
const SERIAL_SAMPLE = INFLATE_SAMPLE; // two workers, no overlap
const PARALLEL_SAMPLE = [
  { session_id: "sessP", orchestrator_action_count: 4, orchestrator_tokens: 600, orchestrator_context_size: 1000, worker_tokens: 50, duration_ms: 100000, model: "claude-sonnet-4-6", work: "w1", result: "ok", files: ["f1.ts"], dispatch_input_tokens: 10, summary_return_tokens: null, ts: iso(INFLATE_T0 + 100000) }, // active [0,100s]
  { session_id: "sessP", orchestrator_action_count: 4, orchestrator_tokens: 900, orchestrator_context_size: 2000, worker_tokens: 70, duration_ms: 100000, model: "claude-sonnet-4-6", work: "w2", result: "ok", files: ["f2.ts"], dispatch_input_tokens: 20, summary_return_tokens: null, ts: iso(INFLATE_T0 + 140000) }, // active [40s,140s]
];
function writeParallelSample() {
  const p = join(dir, "parallel-worker-log.jsonl");
  writeFileSync(p, PARALLEL_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
test("EC-CHK (P4): concurrent_worker_time_ratio is 0 for serial dispatches (no overlap)", () => {
  const out = JSON.parse(run(writeInflateSample()).stdout);
  assert.equal(Number(out.concurrent_worker_time_ratio.sessI), 0, "serial workers -> 0 concurrent");
});
test("EC-CHK (P4): concurrent_worker_time_ratio > 0 for true parallel (overlap)", () => {
  const out = JSON.parse(run(writeParallelSample()).stdout);
  // overlap = [40s,100s] = 60s; total task time = [0,140s] = 140s; 60/140
  const r = out.concurrent_worker_time_ratio.sessP;
  assert.ok(Math.abs(Number(r) - 60 / 140) < 1e-9, `parallel concurrent = 60/140, got ${r}`);
});

// ── ⑤ dispatch_summary_cost: per-dispatch absolute values, null marks missing ─
test("EC-CHK (P4): dispatch_summary_cost lists per-dispatch input+summary tokens", () => {
  const out = JSON.parse(run(writeInflateSample()).stdout);
  const entries = out.dispatch_summary_cost.sessI;
  assert.ok(Array.isArray(entries), "dispatch_summary_cost per session is an array of dispatches");
  assert.equal(entries.length, 2, "two dispatches in sessI");
  assert.equal(entries[0].dispatch_input_tokens, 10, "dispatch 1 input = 10");
  // summary_return_tokens is ALWAYS null from record-worker.mjs (line 251) -> missing, not 0
  assert.strictEqual(entries[0].summary_return_tokens, null, "summary token null (missing, not 0)");
});

test("EC-CHK (P4): dispatch with null dispatch/summary tokens is marked missing, not 0", () => {
  const NULL_DISPATCH = [
    { session_id: "sessN", orchestrator_action_count: 2, orchestrator_tokens: 600, orchestrator_context_size: 1000, worker_tokens: 50, duration_ms: 3000, model: "claude-sonnet-4-6", work: "w", result: "ok", files: ["f1.ts"], dispatch_input_tokens: null, summary_return_tokens: null, ts: iso(INFLATE_T0 + 3000) },
  ];
  const p = join(dir, "null-dispatch-worker-log.jsonl");
  writeFileSync(p, NULL_DISPATCH.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = JSON.parse(run(p).stdout);
  const e = out.dispatch_summary_cost.sessN[0];
  assert.strictEqual(e.dispatch_input_tokens, null, "null input stays null, not 0");
  assert.strictEqual(e.summary_return_tokens, null, "null summary stays null, not 0");
});

// ── BUG FIX (FR-CHK-004): missing orchestrator_context_size -> null, NOT 0 ────
// This is the `r.orchestrator_context_size || 0` regression. Some records LACK
// context_size; the affected context metrics must be null (missing-data) while the
// OTHER metrics still compute. MUST FAIL against the current `|| 0` code.
const MISSING_CTX_SAMPLE = [
  // first record HAS no orchestrator_context_size field at all
  { session_id: "sessM", orchestrator_action_count: 4, orchestrator_tokens: 600, worker_tokens: 50, duration_ms: 60000, model: "claude-sonnet-4-6", work: "w1", result: "ok", files: ["f1.ts"], dispatch_input_tokens: 10, summary_return_tokens: null, ts: iso(INFLATE_T0 + 60000) },
  { session_id: "sessM", orchestrator_action_count: 4, orchestrator_tokens: 900, orchestrator_context_size: 4000, worker_tokens: 70, duration_ms: 60000, model: "claude-sonnet-4-6", work: "w2", result: "ok", files: ["f2.ts"], dispatch_input_tokens: 20, summary_return_tokens: null, ts: iso(INFLATE_T0 + 1320000) },
];
function writeMissingCtxSample() {
  const p = join(dir, "missing-ctx-worker-log.jsonl");
  writeFileSync(p, MISSING_CTX_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
test("EC-CHK (P4): missing context_size -> context metrics null (NOT fake 0), others still compute", () => {
  const out = JSON.parse(run(writeMissingCtxSample()).stdout);
  // affected context metrics must be null (missing data), never 0
  assert.strictEqual(out.context_net_growth.sessM, null, "net_growth null when a context_size is missing");
  assert.strictEqual(out.context_peak.sessM, null, "peak null when a context_size is missing");
  assert.strictEqual(out.context_inflation_rate.sessM, null, "inflation null when context_size missing");
  // OTHER metrics must STILL compute (no crash, no null contagion)
  assert.ok(Math.abs(Number(out.worker_token_ratio.sessM) - 120 / 1020) < 1e-9,
    "worker_token_ratio still computes despite missing context_size");
  assert.equal(out.dispatch_summary_cost.sessM.length, 2, "dispatch cost still computes");
});

// ── null-vs-0 discipline: missing worker_tokens -> worker side null, NOT fake 0 ──
// Mirrors the context_size fix: a record LACKING worker_tokens must not be silently
// summed as 0 (that fabricates a fake-low worker total and corrupts worker_token_ratio
// + orchestrator_vs_worker_tokens.worker). MUST FAIL against a `worker_tokens || 0`.
const MISSING_WORKER_TOKENS_SAMPLE = [
  // first record HAS no worker_tokens field at all
  { session_id: "sessW", orchestrator_action_count: 4, orchestrator_tokens: 600, orchestrator_context_size: 1000, duration_ms: 60000, model: "claude-sonnet-4-6", work: "w1", result: "ok", files: ["f1.ts"], dispatch_input_tokens: 10, summary_return_tokens: null, ts: iso(INFLATE_T0 + 60000) },
  { session_id: "sessW", orchestrator_action_count: 4, orchestrator_tokens: 900, orchestrator_context_size: 4000, worker_tokens: 70, duration_ms: 60000, model: "claude-sonnet-4-6", work: "w2", result: "ok", files: ["f2.ts"], dispatch_input_tokens: 20, summary_return_tokens: null, ts: iso(INFLATE_T0 + 1320000) },
];
function writeMissingWorkerTokensSample() {
  const p = join(dir, "missing-wt-worker-log.jsonl");
  writeFileSync(p, MISSING_WORKER_TOKENS_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
test("EC-CHK: missing worker_tokens -> worker token metrics null (NOT fake 0), others still compute", () => {
  const out = JSON.parse(run(writeMissingWorkerTokensSample()).stdout);
  // worker total can't be trusted with a missing field -> null, never a fake-low sum (70)
  assert.strictEqual(out.worker_token_ratio.sessW, null, "worker_token_ratio null when a worker_tokens is missing");
  assert.strictEqual(out.orchestrator_vs_worker_tokens.sessW.worker, null, "vs-tokens worker side null when missing");
  // orchestrator side and unrelated metrics must STILL compute (no null contagion)
  assert.equal(out.orchestrator_vs_worker_tokens.sessW.orchestrator, 900, "orchestrator side still computes (max)");
  assert.strictEqual(out.context_net_growth.sessW, 3000, "context metrics unaffected by missing worker_tokens");
});

// ── old-format / incomplete record sample → does not crash ───────────────────
test("EC-CHK (P4): old-format record (no P4 fields) does not crash", () => {
  // the original 11-field SAMPLE lacks dispatch/summary tokens entirely
  const r = run(writeSample());
  assert.equal(r.status, 0, `old-format must not crash; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok("dispatch_summary_cost" in out, "still emits the key for old-format input");
});

// ── FR-OBS-001/002: observation-only — pure numbers/null, NO verdict fields ───
// Falsifiable: introducing a verdict/threshold/gate field reddens. The "ok" token
// is anchored to a standalone key SEGMENT so it never matches `*_token(s)`.
function hasVerdictKey(obj) {
  // walk all keys; a key matches if any underscore/space-separated SEGMENT is a
  // verdict word, OR the whole key contains a multi-char verdict word.
  const WORDS = /^(pass|fail|verdict|threshold|gate|ok|红线|门槛)$/i;
  const MULTI = /(pass|fail|verdict|threshold|gate|红线|门槛)/i;
  function walk(o) {
    if (o === null || typeof o !== "object") return false;
    for (const k of Object.keys(o)) {
      if (MULTI.test(k)) return true;
      // anchored standalone "ok" (avoids matching "token")
      if (k.split(/[_\s]+/).some((seg) => WORDS.test(seg))) return true;
      if (walk(o[k])) return true;
    }
    return false;
  }
  return walk(obj);
}

test("EC-CHK (P4): FR-OBS-002 every metric value is a number or null (no verdict objects)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  for (const key of FIVE_METRIC_KEYS) {
    const perSession = out[key];
    for (const sid of Object.keys(perSession)) {
      const v = perSession[sid];
      if (key === "dispatch_summary_cost") {
        // ⑤ is an array of {dispatch_input_tokens, summary_return_tokens} (num|null)
        assert.ok(Array.isArray(v), `${key}.${sid} is an array`);
        for (const e of v) {
          assert.ok(e.dispatch_input_tokens === null || typeof e.dispatch_input_tokens === "number",
            "dispatch_input_tokens is number|null");
          assert.ok(e.summary_return_tokens === null || typeof e.summary_return_tokens === "number",
            "summary_return_tokens is number|null");
        }
      } else {
        assert.ok(v === null || typeof v === "number",
          `${key}.${sid} must be number|null, got ${typeof v} (${v})`);
      }
    }
  }
});

test("EC-CHK (P4): FR-OBS-001 output contains NO pass/fail/verdict/threshold/gate/红线/门槛/ok key", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  // sanity: the anchored matcher does NOT flag legitimate *_token keys
  assert.equal(hasVerdictKey({ worker_token_ratio: 1, orchestrator_vs_worker_tokens: {} }), false,
    "matcher must not false-flag *_token keys (anchored ok)");
  // the real assertion: no verdict field anywhere in the metrics output
  assert.equal(hasVerdictKey(out), false, "metrics output must contain no verdict/gate/threshold field");
});

// ════════════════════════════════════════════════════════════════════════════
// P4 BUG FIX: human-readable (non-JSON) branch must print the 5 observation
// metrics too. The documented manual usage `node check-metrics.mjs --log <x>`
// (NO --json) previously printed only the legacy 4 metrics — FR-CHK-001's
// user-facing scenario undelivered. Each of the 5 is asserted by its literal
// snake_case key so deleting any one print line reddens exactly that metric.
// ════════════════════════════════════════════════════════════════════════════
test("EC-CHK (P4): human-readable (no --json) output prints ALL 5 observation metrics", () => {
  const r = run(writeSample(), false);
  assert.equal(r.status, 0, `non-json mode exits 0; stderr=${r.stderr}`);
  const lines = r.stdout.split("\n");
  for (const key of FIVE_METRIC_KEYS) {
    // Match the key as a whole label on its OWN line, with a word boundary BEFORE
    // the key so `worker_time_ratio` is NOT satisfied by the `concurrent_worker_time_ratio`
    // line (substring collision). Deleting any single metric's print line reddens
    // exactly that metric.
    const re = new RegExp("(^|[^a-z_])" + key + "(?![a-z_])");
    assert.ok(lines.some((l) => re.test(l)),
      `human-readable output must print the ${key} metric line`);
  }
});

test("EC-CHK (P4): human-readable (no --json) shows N/A (not bare 0) for missing data", () => {
  // MISSING_CTX_SAMPLE yields context_inflation_rate = null (missing context_size)
  // and dispatch_summary_cost entries with null summary tokens — both must render
  // as N/A / null, never a bare 0 (A-002 null-vs-0 discipline).
  const r = run(writeMissingCtxSample(), false);
  assert.equal(r.status, 0, `non-json mode exits 0; stderr=${r.stderr}`);
  // the inflation line must carry the metric label AND an N/A-style marker on its line
  const inflationLine = r.stdout.split("\n").find((l) => l.includes("context_inflation_rate"));
  assert.ok(inflationLine, "must print a context_inflation_rate line");
  assert.match(inflationLine, /N\/A|null/i,
    "missing inflation must show N/A/null, not a bare 0");
});

// ── P1-B: incomplete record isolation — must not corrupt sibling complete records ──
// One complete record + one status=incomplete placeholder in the same session.
// The incomplete record has null worker_tokens and null orchestrator_context_size
// (the typical crash-path values). The complete record has real token data.
// Assertions: complete record's token/context metrics still compute; incomplete
// record is NOT counted in dispatch_summary_cost (noise) but IS counted in
// delegation_rate (the dispatch happened) and is visible via incomplete_count.
const INCOMPLETE_ISOLATION_SAMPLE = [
  // complete record — all numeric fields present
  { session_id: "sessINC", orchestrator_action_count: 5, orchestrator_tokens: 800, orchestrator_context_size: 2000, worker_tokens: 60, duration_ms: 5000, model: "claude-sonnet-4-6", work: "w1", result: "ok", files: ["f1.ts"], dispatch_input_tokens: 15, summary_return_tokens: null, ts: "2026-06-20T00:00:05.000Z", status: "ok", dispatch_id: "did-complete-1" },
  // incomplete placeholder — null numeric fields (typical subagent-crash state)
  { session_id: "sessINC", orchestrator_action_count: 5, orchestrator_tokens: null, orchestrator_context_size: null, worker_tokens: null, duration_ms: null, model: null, work: null, result: null, files: "unknown", dispatch_input_tokens: null, summary_return_tokens: null, ts: "2026-06-20T00:01:00.000Z", status: "incomplete", incomplete_reason: "subagent crashed", dispatch_id: "did-incomplete-1" },
];

function writeIncompleteSample() {
  const p = join(dir, "incomplete-worker-log.jsonl");
  writeFileSync(p, INCOMPLETE_ISOLATION_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

test("P1-B: single incomplete record does NOT pull sibling complete record's token metrics to null", () => {
  const out = JSON.parse(run(writeIncompleteSample()).stdout);
  // worker_token_ratio must be non-null: only the complete record (worker=60, orch=800)
  // should count. Ratio = 60 / (60+800) = 60/860.
  const ratio = out.worker_token_ratio.sessINC;
  assert.ok(ratio !== null, "worker_token_ratio must not be null when at least one complete record exists");
  assert.ok(Math.abs(Number(ratio) - 60 / 860) < 1e-9,
    `worker_token_ratio sessINC must be 60/860 = ${60 / 860}, got ${ratio}`);
  // context metrics: complete record's context_size is 2000, so growth=0 (single point),
  // peak=0 (single complete record). They must not be null.
  assert.strictEqual(out.context_net_growth.sessINC, 0, "context_net_growth not null (one complete record, first=last=2000)");
  // dispatch_summary_cost: only the complete record's entry should appear (1 entry, not 2)
  const dsc = out.dispatch_summary_cost.sessINC;
  assert.ok(Array.isArray(dsc), "dispatch_summary_cost is an array");
  assert.equal(dsc.length, 1, "dispatch_summary_cost has 1 entry (only complete records; incomplete excluded as noise)");
  // delegation_rate: both records count (2 dispatches / 5 actions = 0.4)
  assert.ok(Math.abs(Number(out.delegation_rate.sessINC) - 2 / 5) < 1e-9,
    "delegation_rate counts both complete and incomplete records (incomplete dispatch is real)");
  // incomplete_count must expose the 1 incomplete record
  assert.equal(out.incomplete_count.sessINC, 1, "incomplete_count must report the 1 placeholder record");
});

// ── P1-B extra: incomplete record must not pollute context_peak ──────────────
// Regression check: the maxCtx loop previously iterated over recs (all records,
// including incomplete placeholders with null context_size). Although null coerces
// to 0 and does not win > comparison against a positive value, the loop must use
// completeRecs to keep context computation consistent and correct. Explicitly assert
// context_peak for the sessINC fixture (one complete record, peak=0 relative to
// single point) to pin the fix.
test("P1-B: incomplete record with null context_size does not corrupt sibling context_peak", () => {
  const out = JSON.parse(run(writeIncompleteSample()).stdout);
  // Only one complete record (context_size=2000). First=last=max=2000. peak = max-first = 0.
  // If the incomplete record's null were included in maxCtx scan it would not overflow
  // (null coerces to 0 < 2000), but the loop must explicitly use completeRecs.
  assert.strictEqual(out.context_peak.sessINC, 0,
    "context_peak must be 0 (single complete record, null from incomplete excluded)");
  assert.strictEqual(out.context_net_growth.sessINC, 0,
    "context_net_growth must be 0 (single complete record, null from incomplete excluded)");
  // Verify the incomplete record itself is still exposed
  assert.equal(out.incomplete_count.sessINC, 1, "incomplete_count still reports the placeholder");
});

// ── P1-A: dispatch_id dedup in check-metrics — same dispatch_id counted once ──
// Two records with the same dispatch_id are an Agent Teams duplicate delivery.
// check-metrics must deduplicate by dispatch_id (keep first) before grouping,
// so the duplicated record is never double-counted in delegation_rate, tokens, etc.
const DEDUP_SAMPLE = [
  // First delivery of the same dispatch
  { session_id: "sessDED", orchestrator_action_count: 4, orchestrator_tokens: 700, orchestrator_context_size: 1500, worker_tokens: 50, duration_ms: 3000, model: "claude-sonnet-4-6", work: "same work", result: "ok", files: ["f1.ts"], dispatch_input_tokens: 10, summary_return_tokens: null, ts: "2026-06-20T00:00:03.000Z", status: "ok", dispatch_id: "did-dup-x" },
  // Second delivery — identical dispatch_id: this is the duplicate, must be skipped
  { session_id: "sessDED", orchestrator_action_count: 4, orchestrator_tokens: 700, orchestrator_context_size: 1500, worker_tokens: 50, duration_ms: 3000, model: "claude-sonnet-4-6", work: "same work", result: "ok", files: ["f1.ts"], dispatch_input_tokens: 10, summary_return_tokens: null, ts: "2026-06-20T00:00:03.001Z", status: "ok", dispatch_id: "did-dup-x" },
];

function writeDedupSample() {
  const p = join(dir, "dedup-worker-log.jsonl");
  writeFileSync(p, DEDUP_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

test("P1-A: duplicate dispatch_id records are counted only once in check-metrics", () => {
  const out = JSON.parse(run(writeDedupSample()).stdout);
  // Only 1 unique dispatch (after dedup) / 4 orchestrator actions = 0.25
  // Without dedup: 2 records / 4 actions = 0.5 (wrong)
  assert.ok(Math.abs(Number(out.delegation_rate.sessDED) - 1 / 4) < 1e-9,
    `delegation_rate must be 1/4 after dedup (not 2/4); got ${out.delegation_rate.sessDED}`);
  // dispatch_summary_cost must have exactly 1 entry (not 2)
  assert.equal(out.dispatch_summary_cost.sessDED.length, 1,
    "dispatch_summary_cost must have 1 entry after dispatch_id dedup (not 2)");
  // worker_token_ratio: only 1 record counted — 50 / (50 + 700) = 50/750
  const ratio = out.worker_token_ratio.sessDED;
  assert.ok(Math.abs(Number(ratio) - 50 / 750) < 1e-9,
    `worker_token_ratio must reflect deduped record only: 50/750 = ${50 / 750}, got ${ratio}`);
});

// ════════════════════════════════════════════════════════════════════════════
// New monitoring metrics: complete_token_ratio, cumulative_worker_time_ratio,
// backend_distribution, review_return_rate, incomplete_ratio
// ════════════════════════════════════════════════════════════════════════════

// ── Test 1: complete_token_ratio correct math ─────────────────────────────────
// Uses SAMPLE (sessA): worker=[50,70]=120, orch=[600,900] → MAX=900
// BUG FIX (阻塞6): complete_token_ratio now uses MAX(orchestrator_tokens) not SUM,
// to avoid inflating the denominator when multiple worker records all carry the same
// orchestrator snapshot. This aligns with worker_token_ratio's denominator treatment.
// complete_token_ratio = 120 / (120 + 900) = 120/1020 (same as worker_token_ratio)
// worker_token_ratio   = 120 / (120 + 900) = 120/1020 (uses MAX orch)
test("NEW: complete_token_ratio uses MAX(orchestrator_tokens) to avoid denominator inflation (阻塞6 fix)", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  assert.ok("complete_token_ratio" in out, "must output complete_token_ratio key");
  const ctr = out.complete_token_ratio.sessA;
  // Both complete_token_ratio and worker_token_ratio use max(orch)=900, denom=1020
  assert.ok(Math.abs(Number(ctr) - 120 / 1020) < 1e-9,
    `complete_token_ratio sessA = 120/1020 = ${120/1020} (max orch denom), got ${ctr}`);
  // worker_token_ratio also uses MAX orch=900, same denom → values are equal
  const wtr = out.worker_token_ratio.sessA;
  assert.ok(Math.abs(Number(wtr) - 120 / 1020) < 1e-9,
    `worker_token_ratio sessA = 120/1020 = ${120/1020}, got ${wtr}`);
  // Both use same denominator → values are equal (this is expected after the fix)
  assert.ok(Math.abs(Number(ctr) - Number(wtr)) < 1e-9,
    "complete_token_ratio and worker_token_ratio must both equal 120/1020 (same max-orch denominator)");
});

// ── Test 2: backend_distribution grouping ────────────────────────────────────
test("NEW: backend_distribution groups by backend field, missing → 'unknown'", () => {
  const BACKEND_SAMPLE = [
    { session_id: "sessB", orchestrator_action_count: 3, orchestrator_tokens: 500, orchestrator_context_size: 1000, worker_tokens: 40, duration_ms: 1000, model: "claude-sonnet-4-6", work: "w1", result: "ok", files: [], ts: "2026-06-20T00:00:01.000Z", backend: "omc" },
    { session_id: "sessB", orchestrator_action_count: 3, orchestrator_tokens: 500, orchestrator_context_size: 1000, worker_tokens: 40, duration_ms: 1000, model: "claude-sonnet-4-6", work: "w2", result: "ok", files: [], ts: "2026-06-20T00:00:02.000Z", backend: "legacy" },
    { session_id: "sessB", orchestrator_action_count: 3, orchestrator_tokens: 500, orchestrator_context_size: 1000, worker_tokens: 40, duration_ms: 1000, model: "claude-sonnet-4-6", work: "w3", result: "ok", files: [], ts: "2026-06-20T00:00:03.000Z" },
  ];
  const p = join(dir, "backend-worker-log.jsonl");
  writeFileSync(p, BACKEND_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = JSON.parse(run(p).stdout);
  assert.ok("backend_distribution" in out, "must output backend_distribution key");
  const bd = out.backend_distribution.sessB;
  assert.equal(bd.omc, 1, "omc count = 1");
  assert.equal(bd.legacy, 1, "legacy count = 1");
  assert.equal(bd.unknown, 1, "no-backend record → 'unknown' count = 1");
});

// ── Test 3: review_return_rate N/A when no --transcript ──────────────────────
test("NEW: review_return_rate is null when no --transcript passed", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  assert.ok("review_return_rate" in out, "must output review_return_rate key");
  assert.strictEqual(out.review_return_rate, null,
    "review_return_rate must be null when no --transcript arg");
});

// ── Test 4: review_return_rate with a real transcript via extract-gates ───────
// Build a minimal transcript JSONL that extract-gates.mjs can parse.
// Dispatch 1: followed by a next Agent call with "retry" → return
// Dispatch 2: followed by >30-char text, no back-ref → accept
// Expected: gate=[return, accept], review_return_rate = 1/2 = 0.5
test("NEW: review_return_rate computed correctly from extract-gates subprocess", () => {
  // Construct transcript JSONL. extract-gates reads type=assistant records with
  // message.content containing tool_use items (Agent/Task), and matches results
  // via tool_use_id in user records' tool_result items.
  const tu1Id = "tu_1111";
  const tu2Id = "tu_2222";

  // Record 0: assistant dispatches Agent (dispatch 1)
  const rec0 = {
    type: "assistant",
    timestamp: "2026-06-20T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: tu1Id, name: "Agent", input: { prompt: "do task A", subagent_type: "executor" } }
      ]
    }
  };
  // Record 1: user returns result for dispatch 1
  const rec1 = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: tu1Id, content: "done with task A" }
      ]
    }
  };
  // Record 2: assistant dispatches Agent (dispatch 2) with "retry" keyword → dispatch 1 = return
  const rec2 = {
    type: "assistant",
    timestamp: "2026-06-20T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: tu2Id, name: "Agent", input: { prompt: "retry the previous task because it was incomplete", subagent_type: "executor" } }
      ]
    }
  };
  // Record 3: user returns result for dispatch 2
  const rec3 = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: tu2Id, content: "done with retry" }
      ]
    }
  };
  // Record 4: assistant has substantial text (>30 chars) after last result → dispatch 2 = accept
  const rec4 = {
    type: "assistant",
    timestamp: "2026-06-20T00:00:03.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Great, both tasks are now complete and everything looks good here." }
      ]
    }
  };

  const transcriptPath = join(dir, "fake-transcript.jsonl");
  writeFileSync(transcriptPath, [rec0, rec1, rec2, rec3, rec4].map((r) => JSON.stringify(r)).join("\n") + "\n");

  const logPath = writeSample();
  const args = [join(pluginRoot, "tools", "check-metrics.mjs"), "--log", logPath, "--transcript", transcriptPath, "--json"];
  const r = spawnSync("node", args, { encoding: "utf8" });
  assert.equal(r.status, 0, `check-metrics must exit 0; stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  // Dispatch 1 = return (next dispatch has "retry"), dispatch 2 = accept (subsequent text)
  // review_return_rate = 1 return / (1 accept + 1 return) = 0.5
  assert.ok(out.review_return_rate !== null, "review_return_rate must not be null when transcript provided");
  assert.ok(Math.abs(Number(out.review_return_rate) - 0.5) < 1e-9,
    `review_return_rate = 1/(1+1) = 0.5, got ${out.review_return_rate}`);
});

// ── Test 5: incomplete_ratio global fraction ──────────────────────────────────
test("NEW: incomplete_ratio = count(status=incomplete) / count(all records)", () => {
  const INCOMPLETE_RATIO_SAMPLE = [
    { session_id: "sessIR", orchestrator_action_count: 3, orchestrator_tokens: 500, orchestrator_context_size: 1000, worker_tokens: 40, duration_ms: 1000, model: "claude-sonnet-4-6", work: "w1", result: "ok", files: [], ts: "2026-06-20T00:00:01.000Z", status: "ok" },
    { session_id: "sessIR", orchestrator_action_count: 3, orchestrator_tokens: 500, orchestrator_context_size: 1000, worker_tokens: 40, duration_ms: 1000, model: "claude-sonnet-4-6", work: "w2", result: "ok", files: [], ts: "2026-06-20T00:00:02.000Z", status: "ok" },
    { session_id: "sessIR", orchestrator_action_count: 3, orchestrator_tokens: null, orchestrator_context_size: null, worker_tokens: null, duration_ms: null, model: null, work: null, result: null, files: [], ts: "2026-06-20T00:00:03.000Z", status: "incomplete" },
  ];
  const p = join(dir, "incomplete-ratio-worker-log.jsonl");
  writeFileSync(p, INCOMPLETE_RATIO_SAMPLE.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = JSON.parse(run(p).stdout);
  assert.ok("incomplete_ratio" in out, "must output incomplete_ratio key");
  // 1 incomplete / 3 total = 1/3
  assert.ok(Math.abs(Number(out.incomplete_ratio) - 1 / 3) < 1e-9,
    `incomplete_ratio = 1/3 = ${1/3}, got ${out.incomplete_ratio}`);
});

// ── Test 6: cumulative_worker_time_ratio using INFLATE_SAMPLE ─────────────────
// INFLATE_SAMPLE: two workers, duration_ms=60000 each, totalTaskTime = 1320000ms
// cumulative = (60000+60000) / 1320000 = 120000/1320000 ≈ 0.09090909...
test("NEW: cumulative_worker_time_ratio = sum(duration_ms) / wall_clock (can exceed 1 when parallel)", () => {
  const out = JSON.parse(run(writeInflateSample()).stdout);
  assert.ok("cumulative_worker_time_ratio" in out, "must output cumulative_worker_time_ratio key");
  const cwtr = out.cumulative_worker_time_ratio.sessI;
  // sum(duration_ms) = 60000+60000 = 120000; totalTaskTime = 1320000
  const expected = 120000 / 1320000;
  assert.ok(Math.abs(Number(cwtr) - expected) < 1e-9,
    `cumulative_worker_time_ratio sessI = 120000/1320000 = ${expected}, got ${cwtr}`);
  // verify it differs from worker_time_ratio (which uses union/execution, not sum/wall)
  const wtr = out.worker_time_ratio.sessI;
  assert.ok(Math.abs(Number(cwtr) - Number(wtr)) > 1e-9,
    "cumulative_worker_time_ratio must differ from worker_time_ratio");
});

// ── Test 7: sanity check that all 5 new keys are present in JSON output ───────
test("NEW: all 5 new monitoring metric keys present in JSON output", () => {
  const out = JSON.parse(run(writeSample()).stdout);
  const NEW_KEYS = [
    "complete_token_ratio",
    "cumulative_worker_time_ratio",
    "backend_distribution",
    "review_return_rate",
    "incomplete_ratio",
  ];
  for (const k of NEW_KEYS) {
    assert.ok(k in out, `must output ${k} key`);
  }
});
