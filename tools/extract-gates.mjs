#!/usr/bin/env node
// extract-gates.mjs — reads an orchestrator session transcript (JSONL) and
// infers gate behavior (accept/return/unknown) for each Agent dispatch.
//
// Usage:
//   node tools/extract-gates.mjs <transcript.jsonl>
//
// Output: JSON array to stdout. Caller decides what to do with it.
// Honesty principle: only emit accept/return when the heuristic is
// clearly correct. Default to `unknown` when ambiguous. Never fabricate signals.
// escalate is intentionally removed — it was too unreliable from transcript alone
// (coordinator stopping could mean task complete). Prefer unknown over fake data.

import { readFileSync } from "node:fs";

// ── CLI arg ───────────────────────────────────────────────────────────────────────

const transcriptPath = process.argv[2];
if (!transcriptPath) {
  process.stderr.write("[extract-gates] Usage: node extract-gates.mjs <transcript.jsonl>\n");
  process.exit(1);
}

// ── parse transcript ──────────────────────────────────────────────────────────────

let raw;
try {
  raw = readFileSync(transcriptPath, "utf8");
} catch (e) {
  process.stderr.write("[extract-gates] Cannot read file: " + e.message + "\n");
  process.exit(1);
}

// Parse JSONL, skip blank lines and bad lines silently (honesty: don't fabricate)
const records = [];
for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    records.push(JSON.parse(trimmed));
  } catch (_) {
    // skip malformed lines — don't crash, don't fabricate
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────

// RETURN_KEYWORDS: strong back-reference terms that mean "go back and redo this".
// Deliberately excludes generic "fix" (too common in unrelated task prompts) to
// avoid false positives. "fix" alone is NOT enough — "fix the UI bug" in an
// unrelated next task would mis-trigger return. Only include terms that strongly
// imply repeating the *same* prior task: retry, redo, 再试, 重试.
// Note: \b doesn't work for CJK chars — CJK terms are naturally delimited.
const RETURN_KEYWORDS = /\b(retry|redo)\b|再试|重试/i;

/** Extract all tool_use items from a record's message.content */
function toolUses(rec) {
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((x) => x?.type === "tool_use");
}

/** Extract all tool_result items from a record's message.content */
function toolResults(rec) {
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((x) => x?.type === "tool_result");
}

/** Get text from a tool_result's content (handles string or [{type,text}] forms) */
function resultText(toolResult) {
  const c = toolResult?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");
  return "";
}

// ── index records ─────────────────────────────────────────────────────────────────

const sessionId = records.find((r) => r?.sessionId)?.sessionId ?? "unknown";

// Build flat list of (index, record) pairs for assistant and user type records
const indexed = records.map((rec, idx) => ({ idx, rec }));

// Find all Agent tool_use dispatches (in assistant records)
const dispatches = []; // { idx, toolUse, ts }
for (const { idx, rec } of indexed) {
  if (rec?.type !== "assistant") continue;
  for (const tu of toolUses(rec)) {
    if (tu.name === "Agent" || tu.name === "Task") {
      dispatches.push({ idx, toolUse: tu, ts: rec.timestamp ?? null });
    }
  }
}

// Build map: tool_use_id → { idx, toolResult }
const resultByToolUseId = new Map();
for (const { idx, rec } of indexed) {
  for (const tr of toolResults(rec)) {
    if (tr?.tool_use_id) {
      resultByToolUseId.set(tr.tool_use_id, { idx, toolResult: tr });
    }
  }
}

// ── gate inference ────────────────────────────────────────────────────────────────
//
// For each Agent dispatch:
//  1. Find its tool_result record index (R)
//  2. Look at records after R:
//     - If next Agent dispatch (strictly after R, not a parallel sibling in same
//       assistant message) has strong back-reference keywords → return
//     - If orchestrator continues with unrelated work (another Agent or significant
//       text) without back-reference keywords → accept
//     - Otherwise → unknown
//
// escalate is intentionally omitted — folded into unknown. Reason: "result
// contains failure words" triggers on normal completions like "error was fixed",
// and coordinator stopping could mean task complete. Unreliable → unknown.

const results = [];

for (let i = 0; i < dispatches.length; i++) {
  const { toolUse, ts } = dispatches[i];
  const id = toolUse.id;
  const input = toolUse.input ?? {};
  const subagentType = input.subagent_type ?? null;

  const resultEntry = resultByToolUseId.get(id);
  if (!resultEntry) {
    // No tool_result found — unknown (maybe session cut off)
    results.push({
      ts,
      source: "auto",
      dispatch_subagent_type: subagentType,
      gate: "unknown",
      session_id: sessionId,
      evidence: "no tool_result found for this dispatch",
    });
    continue;
  }

  const resultIdx = resultEntry.idx;

  // Collect assistant records that come AFTER the result record
  const afterAssistants = indexed
    .filter(({ idx, rec }) => idx > resultIdx && rec?.type === "assistant")
    .slice(0, 10); // only look at next 10 assistant messages to stay local

  // Check if next Agent dispatch is a strictly sequential return (not a parallel
  // sibling). Requirements:
  //   (a) nextDispatch.idx > resultIdx — must come AFTER this dispatch's tool_result,
  //       ruling out parallel siblings in the same assistant message
  //   (b) nextDispatch prompt matches RETURN_KEYWORDS (strong back-reference terms
  //       only: retry/redo/再试/重试) — generic "fix" excluded to prevent false
  //       positives when an unrelated task's prompt happens to contain "fix"
  const nextDispatch = dispatches[i + 1] ?? null;
  const nextIsStrictReturn =
    nextDispatch !== null &&
    nextDispatch.idx > resultIdx &&
    RETURN_KEYWORDS.test(nextDispatch.toolUse?.input?.prompt ?? "");

  if (nextIsStrictReturn) {
    results.push({
      ts,
      source: "auto",
      dispatch_subagent_type: subagentType,
      gate: "return",
      session_id: sessionId,
      evidence: "next Agent dispatch (strictly after tool_result, not parallel sibling) contains retry/redo back-reference keywords",
    });
    continue;
  }

  // Check accept: orchestrator continues with unrelated work (another Agent or
  // significant text) without back-reference keywords → clearly moved on
  const hasSubsequentAgentOrText = afterAssistants.some(({ rec }) => {
    for (const tu of toolUses(rec)) {
      if (tu.name === "Agent" || tu.name === "Task") return true;
    }
    const content = rec?.message?.content;
    if (Array.isArray(content)) {
      return content.some((x) => x?.type === "text" && (x.text ?? "").length > 30);
    }
    return false;
  });

  if (hasSubsequentAgentOrText && !nextIsStrictReturn) {
    results.push({
      ts,
      source: "auto",
      dispatch_subagent_type: subagentType,
      gate: "accept",
      session_id: sessionId,
      evidence: "orchestrator continues to next task/text after result with no back-reference keywords",
    });
    continue;
  }

  // Ambiguous — default to unknown
  results.push({
    ts,
    source: "auto",
    dispatch_subagent_type: subagentType,
    gate: "unknown",
    session_id: sessionId,
    evidence: "no clear signal from orchestrator actions after result",
  });
}

process.stdout.write(JSON.stringify(results, null, 2) + "\n");
