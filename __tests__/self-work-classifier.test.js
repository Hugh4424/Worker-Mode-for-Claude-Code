// self-work-classifier.test.js — unit tests for the two-layer API in
// tools/lib/self-work-classifier.mjs.
//
// Layer 1 (isBigSelfChunk): pure single-call judgment — only this tool invocation.
// Layer 2 (aggregateDelegatable): full-session aggregation with cross-turn mutatedFiles.
//
// Each test is EXACT and FALSIFIABLE — no fuzzy shape checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const classifierPath = join(pluginRoot, "tools", "lib", "self-work-classifier.mjs");

const {
  BIG_CHUNK_LINES,
  BIG_CHUNK_BYTES,
  COMPACTION_DROP_TOKENS,
  isBigSelfChunk,
  aggregateDelegatable,
} = await import(classifierPath);

// ── constant exports ──────────────────────────────────────────────────────────────

test("constants are exported with correct types and expected values", () => {
  assert.equal(typeof BIG_CHUNK_LINES, "number");
  assert.equal(typeof BIG_CHUNK_BYTES, "number");
  assert.equal(typeof COMPACTION_DROP_TOKENS, "number");
  assert.equal(BIG_CHUNK_LINES, 150);
  assert.equal(BIG_CHUNK_BYTES, 6000);
  assert.equal(COMPACTION_DROP_TOKENS, 100000);
});

// ── Layer 1: isBigSelfChunk ───────────────────────────────────────────────────────

// (a) A 200-line Read result → isBigSelfRead=true
test("(a) Read result with 200 lines → isBigSelfRead true", () => {
  const content = Array(200).fill("line").join("\n"); // 200 lines, well over 150
  assert.ok(content.split("\n").length > BIG_CHUNK_LINES, "fixture must exceed line bound");
  const result = { bytes: content.length, lines: content.split("\n").length, isError: false };
  const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({
    toolUse: { name: "Read", input: { file_path: "/x/big.ts" } },
    result,
  });
  assert.equal(isBigSelfRead, true);
  assert.equal(isBigSelfWrite, false);
});

// (b) A 5-line Read result → isBigSelfRead=false
test("(b) Read result with 5 lines (small) → isBigSelfRead false", () => {
  const content = Array(5).fill("x").join("\n");
  const result = { bytes: content.length, lines: content.split("\n").length, isError: false };
  const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({
    toolUse: { name: "Read", input: { file_path: "/x/tiny.ts" } },
    result,
  });
  assert.equal(isBigSelfRead, false);
  assert.equal(isBigSelfWrite, false);
});

// Byte-threshold variant: result under line bound but over byte bound → still big
test("Read result over byte bound (but under line bound) → isBigSelfRead true", () => {
  const content = "z".repeat(BIG_CHUNK_BYTES + 100); // single long line
  const result = { bytes: content.length, lines: 1, isError: false };
  const { isBigSelfRead } = isBigSelfChunk({
    toolUse: { name: "Read", input: { file_path: "/x/fat.ts" } },
    result,
  });
  assert.equal(isBigSelfRead, true);
});

// Grep and Bash also qualify as reads
test("Grep result over line bound → isBigSelfRead true", () => {
  const result = { bytes: 100, lines: BIG_CHUNK_LINES + 1, isError: false };
  const { isBigSelfRead } = isBigSelfChunk({
    toolUse: { name: "Grep", input: { pattern: "foo", path: "/x" } },
    result,
  });
  assert.equal(isBigSelfRead, true);
});

test("Bash result over byte bound → isBigSelfRead true", () => {
  const result = { bytes: BIG_CHUNK_BYTES + 1, lines: 5, isError: false };
  const { isBigSelfRead } = isBigSelfChunk({
    toolUse: { name: "Bash", input: { command: "ls" } },
    result,
  });
  assert.equal(isBigSelfRead, true);
});

// Write: big input → isBigSelfWrite=true
test("Edit with large new_string input → isBigSelfWrite true", () => {
  const input = { file_path: "/x/f.ts", old_string: "a", new_string: "z".repeat(BIG_CHUNK_BYTES + 1) };
  const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({
    toolUse: { name: "Edit", input },
    result: { bytes: 5, lines: 1, isError: false }, // tiny result — cost is in input
  });
  assert.equal(isBigSelfRead, false);
  assert.equal(isBigSelfWrite, true);
});

// (c) Agent/Task → both false (delegation, not self-work)
test("(c) Agent tool → isBigSelfRead false, isBigSelfWrite false", () => {
  const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({
    toolUse: { name: "Agent", input: { prompt: "z".repeat(BIG_CHUNK_BYTES + 100) } },
    result: { bytes: BIG_CHUNK_BYTES + 100, lines: 200, isError: false },
  });
  assert.equal(isBigSelfRead, false);
  assert.equal(isBigSelfWrite, false);
});

test("Task tool → both false (delegation)", () => {
  const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({
    toolUse: { name: "Task", input: { prompt: "x".repeat(BIG_CHUNK_BYTES + 100) } },
    result: { bytes: BIG_CHUNK_BYTES + 100, lines: 200, isError: false },
  });
  assert.equal(isBigSelfRead, false);
  assert.equal(isBigSelfWrite, false);
});

// null result is safe (PostToolUse hook may not have result yet)
test("null result → isBigSelfRead false (no data = not big)", () => {
  const { isBigSelfRead } = isBigSelfChunk({
    toolUse: { name: "Read", input: { file_path: "/x/f.ts" } },
    result: null,
  });
  assert.equal(isBigSelfRead, false);
});

// reason field is always a non-empty string
test("isBigSelfChunk always returns a reason string", () => {
  const { reason } = isBigSelfChunk({
    toolUse: { name: "Read", input: { file_path: "/x/f.ts" } },
    result: { bytes: 10, lines: 2, isError: false },
  });
  assert.equal(typeof reason, "string");
  assert.ok(reason.length > 0);
});

// ── Layer 2: aggregateDelegatable ─────────────────────────────────────────────────

// (d) File later mutated → excluded from both floor and ceiling
test("(d) big Read whose file is later mutated → excluded from delegatableRange", () => {
  // Two big reads: /x/keep.ts (never mutated) and /x/edit.ts (later mutated).
  // Expected: floor=1, ceiling=1 → [1,1].
  const bigResult = { bytes: BIG_CHUNK_BYTES + 100, lines: 5, isError: false };
  const toolUses = new Map([
    ["toolu_keep", { name: "Read", input: { file_path: "/x/keep.ts" }, result: bigResult }],
    ["toolu_edit", { name: "Read", input: { file_path: "/x/edit.ts" }, result: bigResult }],
  ]);
  const mutatedFiles = new Set(["/x/edit.ts"]);
  const range = aggregateDelegatable({ toolUses, mutatedFiles });
  assert.deepEqual(range, [1, 1]);
});

// Ambiguous read (Bash) lifts ceiling only
test("ambiguous Bash read lifts ceiling but not floor", () => {
  const bigResult = { bytes: BIG_CHUNK_BYTES + 100, lines: 5, isError: false };
  const toolUses = new Map([
    ["toolu_file", { name: "Read", input: { file_path: "/x/stable.ts" }, result: bigResult }],
    ["toolu_bash", { name: "Bash", input: { command: "grep foo" }, result: bigResult }],
  ]);
  const range = aggregateDelegatable({ toolUses, mutatedFiles: new Set() });
  assert.deepEqual(range, [1, 2]);
});

// Error result → excluded from both
test("error-result big Read → excluded from delegatableRange", () => {
  const bigErrorResult = { bytes: BIG_CHUNK_BYTES + 100, lines: 5, isError: true };
  const toolUses = new Map([
    ["toolu_err", { name: "Read", input: { file_path: "/x/boom.ts" }, result: bigErrorResult }],
  ]);
  const range = aggregateDelegatable({ toolUses, mutatedFiles: new Set() });
  assert.deepEqual(range, [0, 0]);
});

// Small reads don't count at all
test("small Read → not counted in delegatableRange", () => {
  const smallResult = { bytes: 50, lines: 5, isError: false };
  const toolUses = new Map([
    ["toolu_small", { name: "Read", input: { file_path: "/x/tiny.ts" }, result: smallResult }],
  ]);
  const range = aggregateDelegatable({ toolUses, mutatedFiles: new Set() });
  assert.deepEqual(range, [0, 0]);
});

// Writes are never delegatable
test("big Write is never delegatable (floor and ceiling stay 0)", () => {
  const bigInput = { file_path: "/x/f.ts", old_string: "a", new_string: "z".repeat(BIG_CHUNK_BYTES + 1) };
  const toolUses = new Map([
    ["toolu_w", { name: "Edit", input: bigInput, result: { bytes: 5, lines: 1, isError: false } }],
  ]);
  const range = aggregateDelegatable({ toolUses, mutatedFiles: new Set() });
  assert.deepEqual(range, [0, 0]);
});

// Agent/Task in toolUses map are silently ignored
test("Agent entries in toolUses are ignored by aggregateDelegatable", () => {
  const bigResult = { bytes: BIG_CHUNK_BYTES + 100, lines: 200, isError: false };
  const toolUses = new Map([
    ["toolu_ag", { name: "Agent", input: { prompt: "x".repeat(BIG_CHUNK_BYTES + 1) }, result: bigResult }],
  ]);
  const range = aggregateDelegatable({ toolUses, mutatedFiles: new Set() });
  assert.deepEqual(range, [0, 0]);
});

// Empty inputs → safe zero
test("empty toolUses → delegatableRange [0,0]", () => {
  const range = aggregateDelegatable({ toolUses: new Map(), mutatedFiles: new Set() });
  assert.deepEqual(range, [0, 0]);
});
