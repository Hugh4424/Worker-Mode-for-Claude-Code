// EC-LOG test — record-worker.mjs appends an 11-field delegation record per worker,
// sourced from SubagentStop stdin + orchestrator/subagent transcripts. Concurrency-safe.
//
// The record script is invoked exactly as the SubagentStop hook would invoke it:
// hook JSON on stdin, WORKER_LOG_PATH env points at the unified data file.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn, execFileSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const recordScript = join(pluginRoot, "hooks", "record-worker.mjs");

// The 11 required fields (7 worker + 4 session-level). Asserted by literal list so a
// missing field cannot pass (membership pinned, not loop-over-record).
const WORKER_FIELDS = ["duration_ms", "worker_tokens", "model", "work", "result", "files", "ts"];
const SESSION_FIELDS = ["session_id", "orchestrator_context_size", "orchestrator_action_count", "orchestrator_tokens"];

let dir;

// Build a minimal-but-realistic orchestrator transcript + subagent transcript + the
// SubagentStop stdin payload that points at them. Mirrors the real captured shape.
function makeFixture(idx = 0) {
  const orchPath = join(dir, `orch-${idx}.jsonl`);
  const subPath = join(dir, `sub-${idx}.jsonl`);
  // Orchestrator transcript. o1 reproduces a REAL Claude Code split turn: ONE turn
  // emitted as two JSONL lines sharing message.id "o1" — a text block in the first
  // line, the tool_use sibling in the second. Dedup-by-id keeps only the first
  // (text) line, so an action-count loop over the deduped set would drop o1's
  // tool_use and yield 1, not 3. o2 carries two tool_use blocks in one line.
  const orch = [
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Let me run that." }] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id: "toolu_o1a", name: "Bash" }] } },
    { type: "assistant", timestamp: "2026-06-19T10:01:00.000Z", message: { id: "o2", model: "claude-opus-4-8", usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 5 }, content: [{ type: "tool_use", id: "toolu_o2a", name: "Read" }, { type: "tool_use", id: "toolu_o2b", name: "Edit" }] } },
  ];
  const sub = [
    { type: "assistant", timestamp: "2026-06-19T10:00:30.000Z", message: { id: "s1", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 63, cache_read_input_tokens: 0, cache_creation_input_tokens: 23745 } } },
    { type: "assistant", timestamp: "2026-06-19T10:00:34.000Z", message: { id: "s1", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 63, cache_read_input_tokens: 0, cache_creation_input_tokens: 23745 } } },
    { type: "assistant", timestamp: "2026-06-19T10:00:35.000Z", message: { id: "s2", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 17, cache_read_input_tokens: 23745, cache_creation_input_tokens: 0 } } },
  ];
  writeFileSync(orchPath, orch.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(subPath, sub.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return JSON.stringify({
    session_id: `sess-${idx}`,
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: "implementer",
    last_assistant_message: "did the work\nresult: ok\nfiles: a.ts, b.ts",
    hook_event_name: "SubagentStop",
  });
}

function runRecord(stdinJson, logPath, extraEnv = {}) {
  return spawnSync("node", [recordScript], {
    input: stdinJson,
    env: { ...process.env, WORKER_LOG_PATH: logPath, ...extraEnv },
    encoding: "utf8",
  });
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "log-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("EC-LOG: appends one record with all 11 fields", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const r = runRecord(makeFixture(), logPath);
  assert.equal(r.status, 0, `record script must exit 0; stderr=${r.stderr}`);
  assert.ok(existsSync(logPath), "worker-log file must be created");
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "exactly one record appended");
  const rec = JSON.parse(lines[0]);
  for (const f of WORKER_FIELDS) assert.ok(f in rec, `record must contain worker field '${f}'`);
  for (const f of SESSION_FIELDS) assert.ok(f in rec, `record must contain session field '${f}'`);
});

test("EC-LOG: session-level fields computed from orchestrator transcript", () => {
  const logPath = join(dir, "worker-log.jsonl");
  runRecord(makeFixture(), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.session_id, "sess-0", "session_id from stdin");
  // action count = tool_use blocks across ALL pre-dedup assistant msgs:
  // o1-text(0) + o1-tooluse(1) + o2(2) = 3. (dedup-by-id would drop o1's
  // tool_use sibling and wrongly yield 1 — this fixture guards that bug.)
  assert.equal(rec.orchestrator_action_count, 3, "action count = all pre-dedup tool_use blocks");
  // orchestrator tokens deduped by message.id: o1(input100+output10) + o2(input200+output20) = 330
  assert.equal(rec.orchestrator_tokens, 330, "orchestrator tokens deduped by message.id");
  // context size = latest assistant input_tokens + cache_read = 200 + 300 = 500
  assert.equal(rec.orchestrator_context_size, 500, "context size = latest input+cache_read");
});

test("EC-LOG: action_count dedupes a tool_use id repeated across sibling lines (no overcount)", () => {
  // Pre-dedup line scanning would overcount if the SAME tool_use block ever
  // appeared on two lines sharing a message.id. Each tool_use carries its own
  // id (toolu_...), so action_count must dedupe by that id. Here "toolu_dup"
  // appears on two lines under message id "m1" and must be counted ONCE;
  // "toolu_uniq" on m2 adds one more → 2, not 3.
  const logPath = join(dir, "worker-log.jsonl");
  const orchPath = join(dir, "orch-dup.jsonl");
  const subPath = join(dir, "sub-dup.jsonl");
  const orch = [
    { type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id: "toolu_dup", name: "Bash" }] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:01.000Z", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id: "toolu_dup", name: "Bash" }] } },
    { type: "assistant", timestamp: "2026-06-19T10:00:02.000Z", message: { id: "m2", model: "claude-opus-4-8", usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 5 }, content: [{ type: "tool_use", id: "toolu_uniq", name: "Read" }] } },
  ];
  const sub = [
    { type: "assistant", timestamp: "2026-06-19T10:00:30.000Z", message: { id: "s1", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 63, cache_read_input_tokens: 0, cache_creation_input_tokens: 23745 } } },
    { type: "assistant", timestamp: "2026-06-19T10:00:34.000Z", message: { id: "s2", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 17, cache_read_input_tokens: 23745, cache_creation_input_tokens: 0 } } },
  ];
  writeFileSync(orchPath, orch.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(subPath, sub.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const stdin = JSON.stringify({ session_id: "sess-dup", transcript_path: orchPath, agent_transcript_path: subPath, agent_type: "implementer", last_assistant_message: "x", hook_event_name: "SubagentStop" });
  const r = runRecord(stdin, logPath);
  assert.equal(r.status, 0, `record script must exit 0; stderr=${r.stderr}`);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  // toolu_dup counted once + toolu_uniq = 2 (raw line scan without id-dedup → 3).
  assert.equal(rec.orchestrator_action_count, 2, "action_count dedupes repeated tool_use ids");
});

test("EC-LOG: worker fields computed from subagent transcript", () => {
  const logPath = join(dir, "worker-log.jsonl");
  runRecord(makeFixture(), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.model, "claude-sonnet-4-6", "model from subagent transcript");
  // worker tokens deduped by id: s1(3+63) + s2(1+17) = 84
  assert.equal(rec.worker_tokens, 84, "worker tokens deduped by message.id");
  // duration = last - first timestamp = 10:00:35 - 10:00:30 = 5000ms
  assert.equal(rec.duration_ms, 5000, "duration from first/last subagent timestamp");
});

test("EC-LOG: concurrent N records all appended, no loss (FR-LOG-005)", async () => {
  const logPath = join(dir, "worker-log.jsonl");
  const N = 12;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    new Promise((resolve, reject) => {
      const p = spawn("node", [recordScript], { env: { ...process.env, WORKER_LOG_PATH: logPath } });
      p.stdin.end(makeFixture(i));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    })
  ));
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, N, `all ${N} concurrent records must be present (got ${lines.length})`);
  for (const l of lines) JSON.parse(l); // every line must be valid JSON (no torn writes)
});

test("EC-PKG/SIG-002: missing WORKER_LOG_PATH fails loud with guidance, no silent run (FR-PKG-002)", () => {
  const r = spawnSync("node", [recordScript], { input: makeFixture(), env: { ...process.env, WORKER_LOG_PATH: "" }, encoding: "utf8" });
  assert.notEqual(r.status, 0, "must exit non-zero when WORKER_LOG_PATH unset");
  assert.match((r.stderr || "") + (r.stdout || ""), /WORKER_LOG_PATH|worker-log|未配置|configure/i, "must print configuration guidance");
});

test("EC-LOG: missing/unreadable orchestrator transcript fails hard, writes nothing (let-it-crash)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const stdin = JSON.stringify({
    session_id: "sess-x",
    transcript_path: join(dir, "does-not-exist-orch.jsonl"),
    agent_transcript_path: join(dir, "does-not-exist-sub.jsonl"),
    agent_type: "implementer",
    last_assistant_message: "work\nresult: ok\nfiles: a.ts",
    hook_event_name: "SubagentStop",
  });
  const r = runRecord(stdin, logPath);
  assert.notEqual(r.status, 0, "must exit non-zero when transcripts are unreadable");
  assert.ok(!existsSync(logPath) || readFileSync(logPath, "utf8").trim() === "",
    "must NOT write any worker-log record on hard-dependency failure");
});

test("EC-LOG: readable-but-empty subagent transcript fails hard (no fake-zero record)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // valid orchestrator, but subagent transcript has no assistant usage at all
  const orchPath = join(dir, "orch-empty.jsonl");
  const subPath = join(dir, "sub-empty.jsonl");
  writeFileSync(orchPath, JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "tool_use", name: "Bash" }] } }) + "\n");
  writeFileSync(subPath, JSON.stringify({ type: "user", message: { content: "nothing useful" } }) + "\n");
  const stdin = JSON.stringify({ session_id: "s", transcript_path: orchPath, agent_transcript_path: subPath, last_assistant_message: "x", hook_event_name: "SubagentStop" });
  const r = runRecord(stdin, logPath);
  assert.notEqual(r.status, 0, "must exit non-zero when subagent transcript has no usable metrics");
  assert.ok(!existsSync(logPath) || readFileSync(logPath, "utf8").trim() === "", "must write nothing");
});

test("EC-LOG: assistant messages present but no usage → fails hard, writes nothing (round-3 fix)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const orchPath = join(dir, "orch-nousage.jsonl");
  const subPath = join(dir, "sub-nousage.jsonl");
  // assistant messages with id/model/timestamp but NO usage object at all
  writeFileSync(orchPath, JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", content: [{ type: "tool_use", name: "Bash" }] } }) + "\n");
  writeFileSync(subPath,
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:30.000Z", message: { id: "s1", model: "claude-sonnet-4-6" } }) + "\n" +
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:35.000Z", message: { id: "s2", model: "claude-sonnet-4-6" } }) + "\n");
  const stdin = JSON.stringify({ session_id: "s", transcript_path: orchPath, agent_transcript_path: subPath, last_assistant_message: "x", hook_event_name: "SubagentStop" });
  const r = runRecord(stdin, logPath);
  assert.notEqual(r.status, 0, "must exit non-zero when assistant messages carry no usage");
  assert.ok(!existsSync(logPath) || readFileSync(logPath, "utf8").trim() === "", "must write nothing (no fake-zero record)");
});

// ── Phase 3 (T014/T016): 3 new fields + per-clause FR-REC-003/004 ────────────
// New fields (SIG-002): subagent_type, dispatch_input_tokens, summary_return_tokens.
// Membership pinned by STRING LITERALS below (not loop-over-list) so a dropped
// field reddens. Sources are GROUNDED in real SubagentStop stdin / transcript shape
// (agent_type, tool_use(name:"Agent") usage, git diff in cwd) — not invented echo
// fields — so the asserts are falsifiable, not tautological.

// Helper: initialize a real git repo with a committed baseline file, then modify
// it so `git diff --name-only` reports a real change. Returns the repo cwd.
function makeGitRepoWithDiff(label, fileName = "changed.ts") {
  const repo = join(dir, `repo-${label}`);
  mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, fileName), "baseline\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "baseline"]);
  // Now make an uncommitted modification → version-diff source has content.
  writeFileSync(join(repo, fileName), "baseline\nmodified\n");
  return repo;
}

// Build a fixture that carries Agent-call token usage on the orchestrator side and
// an explicit subagent output token, so the present-branch of token collection is
// exercised (not just the null branch). cwd lets the impl run git diff there.
//
// Grounded in the REAL Claude Code transcript shape (verified against a captured
// session, T013a): the orchestrator main transcript holds assistant messages whose
// content carries tool_use(name:"Agent") blocks, each with its own toolu_ id. The
// SubagentStop hook's agent_transcript_path points at subagents/agent-XXX.jsonl,
// which has a SIBLING agent-XXX.meta.json carrying {toolUseId} — the exact id of the
// Agent tool_use block that created THIS worker. That sibling meta is the reliable
// join key correlating a worker to its specific dispatch (F1).
//
// To make the F1 falsification real (and catch the original last-dispatch bug), this
// fixture emits TWO Agent dispatches with DIFFERENT input_tokens and points the
// meta.toolUseId at the FIRST (non-last) one. A correctly-correlated impl records the
// first dispatch's input_tokens; the buggy last-dispatch impl records the second's.
function makeFixtureWithTokens(idx, { withAgentUsage, withSubOutput, cwd, metaToolUseId } = {}) {
  const orchPath = join(dir, `orchT-${idx}.jsonl`);
  // subPath MUST follow the real subagents/agent-XXX.jsonl layout so its sibling
  // .meta.json (the join key) resolves via subPath.replace(/\.jsonl$/,".meta.json").
  const subDir = join(dir, `subagents-${idx}`);
  mkdirSync(subDir, { recursive: true });
  const subPath = join(subDir, `agent-T${idx}.jsonl`);
  const metaPath = join(subDir, `agent-T${idx}.meta.json`);
  // Orchestrator: TWO assistant turns that each dispatch via tool_use name "Agent",
  // with DIFFERENT usage. THIS worker's dispatch is the FIRST (toolu_agent1, bare
  // input_tokens 777 + cache_read 12000 + cache_creation 80 → full context 12857);
  // the LATER dispatch (toolu_agent2, 555 + cache_read 6000 → 6555) is some OTHER
  // worker's. Correlation must pick toolu_agent1's full context (12857), never agent2's.
  // dispatch_input_tokens records FULL input context, not the bare input_tokens crumb.
  const firstAgentInput = withAgentUsage ? 777 : 100;
  const agentMsg1 = {
    type: "assistant", timestamp: "2026-06-19T10:00:00.000Z",
    message: {
      id: "oa1", model: "claude-opus-4-8",
      // cache_read 12000 + cache_creation 80 are non-zero so dispatch_input_tokens
      // must reflect the FULL input context (777 + 12000 + 80 = 12857), not the bare
      // input_tokens crumb (777). If the impl ever drops cache_read, this reddens.
      usage: { input_tokens: firstAgentInput, output_tokens: 10, cache_read_input_tokens: 12000, cache_creation_input_tokens: 80 },
      content: [{ type: "tool_use", id: "toolu_agent1", name: "Agent", input: { subagent_type: "implementer" } }],
    },
  };
  const agentMsg2 = {
    type: "assistant", timestamp: "2026-06-19T10:00:50.000Z",
    message: {
      id: "oaX", model: "claude-opus-4-8",
      usage: { input_tokens: 555, output_tokens: 11, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 },
      content: [{ type: "tool_use", id: "toolu_agent2", name: "Agent", input: { subagent_type: "researcher" } }],
    },
  };
  const orch = [
    agentMsg1,
    { type: "assistant", timestamp: "2026-06-19T10:01:00.000Z", message: { id: "oa2", model: "claude-opus-4-8", usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 5 }, content: [{ type: "tool_use", id: "toolu_oa2", name: "Read" }] } },
    agentMsg2,
  ];
  // Subagent: final assistant message output_tokens is the subagent's own output —
  // explicitly NOT the orchestrator-side tool_result token (plan L92), so it must NOT
  // be used as summary_return_tokens. Kept non-null (999) so the F2 falsification can
  // redden if the impl ever falls back to it.
  const sub = [
    { type: "assistant", timestamp: "2026-06-19T10:00:30.000Z", message: { id: "s1", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 63, cache_read_input_tokens: 0, cache_creation_input_tokens: 23745 } } },
    { type: "assistant", timestamp: "2026-06-19T10:00:35.000Z", message: { id: "s2", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: withSubOutput ? 999 : 17, cache_read_input_tokens: 23745, cache_creation_input_tokens: 0 } } },
  ];
  writeFileSync(orchPath, orch.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(subPath, sub.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // Sibling meta: the reliable join key. Defaults to THIS worker's first dispatch.
  writeFileSync(metaPath, JSON.stringify({
    agentType: "implementer",
    description: "test worker",
    toolUseId: metaToolUseId || "toolu_agent1",
  }) + "\n");
  return JSON.stringify({
    session_id: `sessT-${idx}`,
    transcript_path: orchPath,
    agent_transcript_path: subPath,
    agent_type: "implementer",
    cwd: cwd || dir,
    last_assistant_message: "did the work\nresult: ok\nfiles: a.ts, b.ts",
    hook_event_name: "SubagentStop",
  });
}

// T014 — new field MEMBERSHIP pinned by literal name (each asserted independently).
test("T014: appended record contains subagent_type (literal membership)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const r = runRecord(makeFixture(), logPath);
  assert.equal(r.status, 0, `record script must exit 0; stderr=${r.stderr}`);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.ok("subagent_type" in rec, "record must contain field 'subagent_type'");
});

test("T014: appended record contains dispatch_input_tokens (literal membership)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  runRecord(makeFixture(), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.ok("dispatch_input_tokens" in rec, "record must contain field 'dispatch_input_tokens'");
});

test("T014: appended record contains summary_return_tokens (literal membership)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  runRecord(makeFixture(), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.ok("summary_return_tokens" in rec, "record must contain field 'summary_return_tokens'");
});

test("T014: subagent_type derived from stdin agent_type", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // makeFixture sets agent_type:"implementer"
  runRecord(makeFixture(), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.subagent_type, "implementer", "subagent_type must come from stdin agent_type");
});

test("T014: subagent_type missing → sentinel 'unknown' (not empty/missing)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const orchPath = join(dir, "orch-noat.jsonl");
  const subPath = join(dir, "sub-noat.jsonl");
  writeFileSync(orchPath, JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "tool_use", id: "toolu_a", name: "Bash" }] } }) + "\n");
  writeFileSync(subPath,
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:30.000Z", message: { id: "s1", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 63 } } }) + "\n" +
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:35.000Z", message: { id: "s2", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 17 } } }) + "\n");
  // stdin WITHOUT agent_type
  const stdin = JSON.stringify({ session_id: "s", transcript_path: orchPath, agent_transcript_path: subPath, cwd: dir, last_assistant_message: "x", hook_event_name: "SubagentStop" });
  const r = runRecord(stdin, logPath);
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.subagent_type, "unknown", "subagent_type must be sentinel 'unknown' when agent_type absent");
});

test("T014: token sources absent → null (NOT 0 — missing-data vs real-zero)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // makeFixture has NO tool_use(name:"Agent") on the orchestrator side and writes no
  // sibling .meta.json, so dispatch_input_tokens cannot be correlated → null.
  // summary_return_tokens is always null (orchestrator-side tool_result token is not a
  // recorded field — see F2 test). Both must be null (not 0), distinguishing
  // missing-data from real-zero.
  runRecord(makeFixture(), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.dispatch_input_tokens, null, "dispatch_input_tokens must be null when no Agent tool_use usage (not 0)");
  assert.notEqual(rec.dispatch_input_tokens, 0, "must distinguish missing-data from real-zero");
  assert.equal(rec.summary_return_tokens, null, "summary_return_tokens must be null (orchestrator-side tool_result token unrecorded)");
});

// F1 (codex blocking) — dispatch_input_tokens must correlate to THIS worker's
// SPECIFIC Agent dispatch via the sibling meta.json toolUseId join key, NOT simply
// take the last Agent dispatch in the transcript. The fixture has TWO dispatches with
// DIFFERENT input_tokens (777 for this worker = first; 555 for another = last) and the
// meta.toolUseId points at the FIRST. Correctly correlated → 777. The original bug
// (take last Agent message's input_tokens) → 555. We assert BOTH: == correlated AND
// != last-dispatch, so the misattribution bug reddens this test.
test("F1/T014: dispatch_input_tokens correlates to THIS worker's dispatch (not the last dispatch)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // meta.toolUseId defaults to toolu_agent1 (this worker's first dispatch, input 777).
  runRecord(makeFixtureWithTokens("disp", { withAgentUsage: true, withSubOutput: true }), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.dispatch_input_tokens, 12857, "dispatch_input_tokens must come from THIS worker's correlated Agent dispatch (toolu_agent1), summing input+cache_read+cache_creation = 777+12000+80");
  assert.notEqual(rec.dispatch_input_tokens, 777, "must NOT be the bare input_tokens crumb (777) — full input context includes cache_read/cache_creation");
  assert.notEqual(rec.dispatch_input_tokens, 555, "must NOT be the last Agent dispatch's value (toolu_agent2) — that is another worker's");
});

// F1 — when the join key is present and points at the SECOND dispatch instead, the
// recorded value follows the join key (555), proving correlation is genuinely keyed
// by toolUseId, not positional. (If impl just took the last dispatch it would coincide
// here; the test above pins the non-positional case, this one pins keyed-ness.)
test("F1/T014: dispatch_input_tokens follows the meta.toolUseId join key (keyed, not positional)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  runRecord(makeFixtureWithTokens("disp2", { withAgentUsage: true, withSubOutput: true, metaToolUseId: "toolu_agent2" }), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.dispatch_input_tokens, 6555, "dispatch_input_tokens must follow the meta.toolUseId join key to toolu_agent2, summing input+cache_read = 555+6000");
});

// F1 — no reliable join key (meta.json missing / no matching dispatch) → null.
// NEVER fall back to the last dispatch's value. Here the meta points at an id that
// has NO matching Agent tool_use in the orchestrator transcript → cannot correlate.
test("F1/T014: dispatch_input_tokens is null when the join key resolves no dispatch (not last-dispatch fallback)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  runRecord(makeFixtureWithTokens("disp3", { withAgentUsage: true, withSubOutput: true, metaToolUseId: "toolu_nomatch" }), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.dispatch_input_tokens, null, "must be null when no Agent dispatch matches the join key");
  assert.notEqual(rec.dispatch_input_tokens, 12857, "must NOT fall back to any dispatch's full value (toolu_agent1 = 12857)");
  assert.notEqual(rec.dispatch_input_tokens, 6555, "must NOT fall back to the last dispatch's value (toolu_agent2 = 6555)");
});

// F2 (codex blocking) — summary_return_tokens must be the ORCHESTRATOR-SIDE tool_result
// token cost (plan L92), which is NOT present in the real transcript: the orchestrator
// tool_result content-block carries only {content,is_error,tool_use_id,type} — no token
// field (verified against a captured session, T013a). The only token-bearing field on
// the Agent result is the subagent's OWN aggregate self-usage, which is explicitly the
// forbidden fallback. So when the orchestrator-side tool_result token cannot be
// extracted, summary_return_tokens MUST be null — never the subagent output_tokens.
// The fixture's subagent final output is 999; if the impl wrongly used it, this reddens.
test("F2/T014: summary_return_tokens is null (orchestrator tool_result token unextractable; NOT subagent output)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  runRecord(makeFixtureWithTokens("summ", { withAgentUsage: true, withSubOutput: true }), logPath);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.summary_return_tokens, null, "summary_return_tokens must be null when the orchestrator-side tool_result token is unavailable");
  assert.notEqual(rec.summary_return_tokens, 999, "must NOT fall back to the subagent's final output_tokens");
});

test("T014 (regression): old-format / incomplete-usage log line does not crash the parser", () => {
  // A pre-existing log file may contain old-format lines (missing the new fields).
  // The record script appends; it must not choke on what is already on disk.
  const logPath = join(dir, "worker-log.jsonl");
  writeFileSync(logPath,
    JSON.stringify({ session_id: "old", worker_tokens: 5, model: "x", work: "w", result: "r", files: ["z.ts"], ts: "2026-01-01T00:00:00.000Z" }) + "\n");
  const r = runRecord(makeFixture(), logPath);
  assert.equal(r.status, 0, `must exit 0 appending after an old-format line; stderr=${r.stderr}`);
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "old line preserved + new record appended");
  for (const l of lines) JSON.parse(l); // every line still valid JSON
});

// T016 — per-clause falsifiable assertions (FR-REC-003 ①②③ + FR-REC-004 ①②③).

// FR-REC-003-①: files prefers version-diff source; falls back to session-record.
// BOTH branches exercised across two subtests so deleting either branch reddens.
test("FR-REC-003-①a: files prefers the version-diff (git) source over session-record", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const repo = makeGitRepoWithDiff("pref", "from_git.ts");
  // last_assistant_message also reports files (session-record source) — must be
  // OVERRIDDEN by the git-diff source when present.
  const orchPath = join(dir, "orch-pref.jsonl");
  const subPath = join(dir, "sub-pref.jsonl");
  writeFileSync(orchPath, JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "tool_use", id: "toolu_a", name: "Bash" }] } }) + "\n");
  writeFileSync(subPath,
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:30.000Z", message: { id: "s1", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 63 } } }) + "\n" +
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:35.000Z", message: { id: "s2", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 17 } } }) + "\n");
  const stdin = JSON.stringify({ session_id: "s", transcript_path: orchPath, agent_transcript_path: subPath, agent_type: "implementer", cwd: repo, last_assistant_message: "work\nresult: ok\nfiles: from_session.ts", hook_event_name: "SubagentStop" });
  const r = runRecord(stdin, logPath);
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.ok(rec.files.includes("from_git.ts"), "files must include the git-diff source file");
  assert.ok(!rec.files.includes("from_session.ts"), "git-diff source preferred → session-record file not used");
});

test("FR-REC-003-①b: files falls back to session-record when version-diff source is empty", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // cwd is a NON-git dir (the temp test dir) → git diff yields nothing → fallback.
  const r = runRecord(makeFixture(), logPath); // last_assistant_message has files: a.ts, b.ts
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.deepEqual(rec.files, ["a.ts", "b.ts"], "files must fall back to session-record parse when git diff empty");
});

test("FR-REC-003-②: both files sources absent → files === 'unknown' (not empty, not crash)", () => {
  const logPath = join(dir, "worker-log.jsonl");
  const orchPath = join(dir, "orch-nofiles.jsonl");
  const subPath = join(dir, "sub-nofiles.jsonl");
  writeFileSync(orchPath, JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "tool_use", id: "toolu_a", name: "Bash" }] } }) + "\n");
  writeFileSync(subPath,
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:30.000Z", message: { id: "s1", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 63 } } }) + "\n" +
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:35.000Z", message: { id: "s2", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 17 } } }) + "\n");
  // cwd = non-git temp dir → no git diff; last_assistant_message has NO files: line.
  const stdin = JSON.stringify({ session_id: "s", transcript_path: orchPath, agent_transcript_path: subPath, agent_type: "researcher", cwd: dir, last_assistant_message: "read-only, no files changed\nresult: ok", hook_event_name: "SubagentStop" });
  const r = runRecord(stdin, logPath);
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.files, "unknown", "files must be sentinel 'unknown' when both sources absent");
});

test("FR-REC-003-③: parallel write conflict (git-diff set != self-reported set) → conflict_marker preserved", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // git diff reports from_git.ts, but the worker self-reports OTHER files — this is
  // exactly the parallel-contamination case (D6/codex M4): the two sources disagree,
  // so a conflict_marker must be set rather than silently picking one.
  const repo = makeGitRepoWithDiff("conflict", "from_git.ts");
  const orchPath = join(dir, "orch-conf.jsonl");
  const subPath = join(dir, "sub-conf.jsonl");
  writeFileSync(orchPath, JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:00.000Z", message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "tool_use", id: "toolu_a", name: "Bash" }] } }) + "\n");
  writeFileSync(subPath,
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:30.000Z", message: { id: "s1", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 63 } } }) + "\n" +
    JSON.stringify({ type: "assistant", timestamp: "2026-06-19T10:00:35.000Z", message: { id: "s2", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 17 } } }) + "\n");
  const stdin = JSON.stringify({ session_id: "s", transcript_path: orchPath, agent_transcript_path: subPath, agent_type: "implementer", cwd: repo, last_assistant_message: "work\nresult: ok\nfiles: only_mine.ts", hook_event_name: "SubagentStop" });
  const r = runRecord(stdin, logPath);
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(rec.conflict_marker, true, "conflict_marker must be set when version-diff and self-reported file sets disagree");
});

test("FR-REC-003-③ (no false positive): agreeing sources → conflict_marker not set", () => {
  const logPath = join(dir, "worker-log.jsonl");
  // git diff empty + session-record present → no disagreement → no conflict marker.
  const r = runRecord(makeFixture(), logPath);
  assert.equal(r.status, 0, `must exit 0; stderr=${r.stderr}`);
  const rec = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.notEqual(rec.conflict_marker, true, "conflict_marker must NOT be set when sources do not conflict");
});

test("FR-REC-004-①: record-worker.mjs source contains NO network/model call (static reverse-grep)", () => {
  const src = readFileSync(recordScript, "utf8");
  assert.ok(!/fetch\(/.test(src), "no fetch( call");
  assert.ok(!/anthropic/i.test(src), "no anthropic reference");
  assert.ok(!/openai/i.test(src), "no openai reference");
  assert.ok(!/@ai-sdk/.test(src), "no @ai-sdk import");
  assert.ok(!/https?:\/\/api/.test(src), "no https?://api network endpoint");
});

test("FR-REC-004-②: script has a wall-clock single-run time bound and over-limit path", () => {
  const src = readFileSync(recordScript, "utf8");
  // The guard must exist in source: a wall-clock start + an elapsed check.
  assert.ok(/Date\.now\(\)/.test(src), "must capture wall-clock start via Date.now()");
  assert.ok(/WORKER_RECORD_TIMEOUT_MS/.test(src), "must expose env-overridable time limit WORKER_RECORD_TIMEOUT_MS");
  // Over-limit path is genuinely exercised: limit=0 → exceeded before append → failHard, no record.
  const logPath = join(dir, "worker-log.jsonl");
  const r = runRecord(makeFixture(), logPath, { WORKER_RECORD_TIMEOUT_MS: "0" });
  assert.notEqual(r.status, 0, "must exit non-zero when single-run time limit exceeded");
  assert.ok(!existsSync(logPath) || readFileSync(logPath, "utf8").trim() === "", "must write nothing when over time limit");
});

test("FR-REC-004-③: write failure → non-zero exit, no all-empty fake record", () => {
  // Unwritable target directory → openSync/mkdirSync throws → exit non-zero, no record.
  const logPath = "/nonexistent-dir-xyz/worker-log.jsonl";
  const r = runRecord(makeFixture(), logPath);
  assert.notEqual(r.status, 0, "must exit non-zero on write failure");
  assert.ok(!existsSync(logPath), "must not create a fake record at an unwritable path");
});
