#!/usr/bin/env node
// check-context-health.mjs — read-only, post-hoc retrospective analysis of a FOREMAN
// (main-session) Claude Code transcript (.jsonl). It reports two numbers and exits:
//   1. how many big self-read/self-write chunks the foreman did itself (+ how many of
//      those were likely DELEGATABLE, as a heuristic RANGE), and
//   2. how much the foreman's context grew, compaction-aware.
//
// It is NOT a hook, NOT a daemon, NOT an interceptor. It does not enforce or block
// anything. The research conclusion is already settled: the foreman's own self-reading
// bloats its context and that cost is invisible at decision time. This makes it visible
// AFTER the fact. Node ESM, zero external dependencies.
//
// Usage:
//   node check-context-health.mjs <transcript.jsonl> [--json]

import { readFileSync } from "node:fs";
import {
  BIG_CHUNK_LINES,
  BIG_CHUNK_BYTES,
  COMPACTION_DROP_TOKENS,
  isBigSelfChunk,
  aggregateDelegatable,
} from "./lib/self-work-classifier.mjs";

// Re-export constants so existing importers (tests, other tools) keep working unchanged.
export { BIG_CHUNK_LINES, BIG_CHUNK_BYTES, COMPACTION_DROP_TOKENS };

// Tools the FOREMAN runs that consume context by reading/writing big chunks itself.
// Agent/Task are delegation (the opposite of self-work) and are excluded by name.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]); // big cost = INPUT size

// ── jsonl parse (let-it-crash on corruption, skip only blank padding) ────────────

function parseLines(transcriptPath) {
  // Missing/unreadable transcript is a HARD error (let-it-crash): never fabricate
  // zero metrics for a file we could not read.
  const raw = readFileSync(transcriptPath, "utf8");
  const out = [];
  let n = 0;
  for (const line of raw.split("\n")) {
    n++; // 1-based line number, counts EVERY line incl. blanks for an accurate report.
    if (!line.trim()) continue; // blank / whitespace-only = JSONL padding, not corruption.
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      // A non-blank line that won't parse is genuine corruption: silently dropping it
      // could drop a tool_use and yield a silently-WRONG count. Fail LOUD instead.
      throw new Error(`malformed JSONL at line ${n}: ${e.message}`);
    }
  }
  return out;
}

function isForeman(line) {
  // Foreman lines are the main session; subagent (sidechain) turns must never pollute
  // either metric. Default-undefined is treated as foreman (older transcripts).
  return line && line.isSidechain !== true;
}

// Size helpers (countLines, resultBytes, resultLines, inputBytes, inputLines) and
// resolveTargetFile live in ./lib/self-work-classifier.mjs. They are not re-exported
// here because callers who need them should import from the classifier directly.

// ── internal size helpers for tool_result indexing ───────────────────────────────
// These two are local because they are only used by analyzeContextHealth's step 2 to
// pre-index result sizes — the classifier's isBigSelfChunk receives pre-computed
// { bytes, lines } rather than raw content blocks, keeping the hot path simple.

function _resultBytes(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + (b && typeof b.text === "string" ? b.text.length : 0), 0);
  }
  return 0;
}

function _countLines(s) {
  return typeof s === "string" && s.length > 0 ? s.split("\n").length : 0;
}

function _resultLines(content) {
  if (typeof content === "string") return _countLines(content);
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + (b && typeof b.text === "string" ? _countLines(b.text) : 0), 0);
  }
  return 0;
}

// ── core analysis ────────────────────────────────────────────────────────────────

export function analyzeContextHealth(transcriptPath) {
  const lines = parseLines(transcriptPath);

  // 1) Collect foreman tool_use blocks, deduped by their OWN toolu_ id.
  //    DEDUP TRAP: one assistant turn can split across multiple lines sharing
  //    message.id; counting by message.id would drop a tool_use sibling. We key on the
  //    tool_use's own id so each call is counted exactly once.
  const toolUses = new Map(); // toolu_id -> { name, input }
  // Track which files the foreman later WROTE/EDITED (for delegatable heuristic).
  const mutatedFiles = new Set();
  for (const line of lines) {
    if (!isForeman(line) || line.type !== "assistant") continue;
    const content = line.message && Array.isArray(line.message.content) ? line.message.content : [];
    for (const block of content) {
      if (block && block.type === "tool_use" && typeof block.id === "string") {
        if (!toolUses.has(block.id)) toolUses.set(block.id, { name: block.name, input: block.input });
        if (WRITE_TOOLS.has(block.name)) {
          const fp = block.input && block.input.file_path;
          if (typeof fp === "string") mutatedFiles.add(fp);
        }
      }
    }
  }

  // 2) Index tool_result by tool_use_id: { bytes, lines, isError } (foreman side only).
  //    Pre-compute sizes here so step 3 can pass a plain { bytes, lines, isError } object
  //    to isBigSelfChunk without feeding it raw content blocks.
  const resultsById = new Map();
  for (const line of lines) {
    if (!isForeman(line) || line.type !== "user") continue;
    const content = line.message && Array.isArray(line.message.content) ? line.message.content : [];
    for (const block of content) {
      if (block && (block.type === "tool_result") && typeof block.tool_use_id === "string") {
        resultsById.set(block.tool_use_id, {
          bytes: _resultBytes(block.content),
          lines: _resultLines(block.content),
          isError: block.is_error === true,
        });
      }
    }
  }

  // 3) Classify each foreman tool_use into big self-read/self-write + delegatability.
  //    Attach the pre-indexed result to each toolUse entry so aggregateDelegatable can
  //    use isBigSelfChunk internally with the same { bytes, lines } data.
  let bigSelfReads = 0;
  const toolUsesWithResults = new Map();
  for (const [id, { name, input }] of toolUses.entries()) {
    const result = resultsById.get(id) || null;
    toolUsesWithResults.set(id, { name, input, result });
    const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({ toolUse: { name, input }, result });
    if (isBigSelfRead || isBigSelfWrite) bigSelfReads++;
  }
  const delegatableRange = aggregateDelegatable({ toolUses: toolUsesWithResults, mutatedFiles });

  // 4) Context series: one value per assistant message.id, in file order.
  //    Context size at a turn ≈ input_tokens + cache_read_input_tokens.
  const series = [];
  const seenMsg = new Set();
  for (const line of lines) {
    if (!isForeman(line) || line.type !== "assistant") continue;
    const msg = line.message;
    if (!msg || !msg.usage) continue;
    const id = msg.id;
    if (typeof id === "string") {
      if (seenMsg.has(id)) continue; // dedup by message.id (first wins)
      seenMsg.add(id);
    }
    const u = msg.usage;
    series.push((u.input_tokens || 0) + (u.cache_read_input_tokens || 0));
  }

  // 5) Compaction-aware growth.
  //    A naive last-first is a LYING metric: a compaction resets context mid-session,
  //    so last-first would credit none of the pre-compact work. Instead segment at each
  //    compaction (drop > threshold) and sum each segment's (end - start).
  let compactionsDetected = 0;
  let contextNetGrowth = 0;
  let contextPeak = 0;
  if (series.length > 0) {
    const first = series[0];
    contextPeak = Math.max(...series) - first;
    let segStart = series[0];
    let segEnd = series[0];
    for (let i = 1; i < series.length; i++) {
      const drop = series[i - 1] - series[i];
      if (drop > COMPACTION_DROP_TOKENS) {
        // close the current segment, start a fresh one at the post-compact value
        contextNetGrowth += segEnd - segStart;
        compactionsDetected++;
        segStart = series[i];
        segEnd = series[i];
      } else {
        segEnd = series[i];
      }
    }
    contextNetGrowth += segEnd - segStart;
  }

  return { bigSelfReads, delegatableRange, contextNetGrowth, contextPeak, compactionsDetected };
}

// Resolve the single file a read targets, or null if unresolvable (→ ambiguous).
//   Read → input.file_path (a single file)
//   Grep → input.path only if it looks like a file (has an extension); a dir → null
//   Bash → unresolvable (arbitrary command) → null
function resolveTargetFile(name, input) {
  if (name === "Read") {
    return input && typeof input.file_path === "string" ? input.file_path : null;
  }
  if (name === "Grep") {
    const p = input && typeof input.path === "string" ? input.path : null;
    // a path with a file extension on its basename → treat as a file; otherwise dir.
    if (p && /\.[A-Za-z0-9]+$/.test(p.split("/").pop() || "")) return p;
    return null;
  }
  // Bash and anything else: unresolvable.
  return null;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────

function renderReport(transcriptPath, r) {
  const [lo, hi] = r.delegatableRange;
  return [
    `Context health-check — ${transcriptPath}`,
    ``,
    `Foreman self-read/self-write big chunks: ${r.bigSelfReads}`,
    `  of those, likely delegatable (heuristic range): ${lo}–${hi}`,
    `Context net growth (compaction-aware): ${r.contextNetGrowth.toLocaleString()} tokens`,
    `Context peak above start: ${r.contextPeak.toLocaleString()} tokens`,
    `Compactions detected: ${r.compactionsDetected}`,
    ``,
    `What this does NOT tell you (blind spots):`,
    `  - It measures the foreman's OWN context cost, not whether that work should have been delegated.`,
    `    A big self-read can be perfectly correct.`,
    `  - "Delegatable" is a heuristic RANGE, not an exact count: it estimates self-`,
    `    contained reads of files the foreman did not later mutate. Treat it as a hint.`,
    `  - It does NOT score or rate your delegation. There is no good/bad number here —`,
    `    it is observation only, never enforcement.`,
    ``,
  ].join("\n");
}

function main(argv) {
  const args = argv.filter((a) => a !== "--json");
  const json = argv.includes("--json");
  const path = args[0];
  if (!path) {
    process.stderr.write(
      "[check-context-health] No transcript path.\n" +
        "Usage: node check-context-health.mjs <transcript.jsonl> [--json]\n"
    );
    process.exit(1);
  }
  let r;
  try {
    r = analyzeContextHealth(path);
  } catch (e) {
    process.stderr.write(
      "[check-context-health] Cannot analyze transcript: " + path + " (" + e.message + ")\n" +
        "Refusing to report fabricated metrics for an unreadable transcript.\n"
    );
    process.exit(1);
  }
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  else process.stdout.write(renderReport(path, r) + "\n");
}

// Run as CLI only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
