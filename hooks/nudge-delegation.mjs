#!/usr/bin/env node
// nudge-delegation.mjs — PostToolUse hook: injects a sparse "step-out decision frame"
// when the foreman's narrative drifts toward self-evidence-gathering.
//
// HARD INVARIANT (P1#10 — do NOT weaken, ever):
//   This hook ONLY outputs additionalContext. It ALWAYS exits 0.
//   It MUST NEVER output permissionDecision:"deny" or decision:"block".
//   Reason: hard interception has been proven to double waste and is a dead end.
//   If you are tempted to "upgrade" this to an interceptor — don't. Fix Layer B
//   (coordinator.md prompting) instead.
//
// Design: see docs/delegation-improvement-implementation-plan-v3.md § 块1 Layer A.
// Node ESM, zero external dependencies.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── constants ─────────────────────────────────────────────────────────────────

// Window: scan at most this many recent foreman turns from the transcript tail.
const WINDOW_TURNS = 30;

// Density threshold: if (bigSelfChunkCount / windowTurns) >= this, fire strong nudge.
const STRONG_DENSITY = 0.25; // 25% — e.g. 3 big self-reads in last 12 turns

// Minimum absolute count for strong nudge (density alone can fire on 1/4 turns).
const STRONG_MIN_COUNT = 2;

// Cooldown: after firing, suppress the SAME tier for this many turns.
// Values are conservative (design §1.1 step 5: "先保守，宁可漏触发也别撑爆上下文").
// In a worst-case all-big-reads session with agents every 8 steps:
//   LIGHT=10 → ~5 light fires / 50 steps; STRONG=20 → ~3 strong fires / 50 steps → ≤9 total.
// Bump if real sessions feel spammy; lower only if nudges feel consistently too sparse.
const LIGHT_COOLDOWN_TURNS = 10;
const STRONG_COOLDOWN_TURNS = 20;

// ── import shared classifier ──────────────────────────────────────────────────

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const classifierPath = join(pluginRoot, "tools", "lib", "self-work-classifier.mjs");

let isBigSelfChunk;
try {
  ({ isBigSelfChunk } = await import(classifierPath));
} catch {
  // If classifier not available, fail safe: exit 0 silently.
  process.exit(0);
}

// ── authority-file allowlist (red-line carve-out) ─────────────────────────────
// Only these SPECIFIC files are exempt from nudge — files the foreman MUST
// read directly per coordinator red-lines. Generic .md files are NOT exempt.
//
// All matches are anchored to the basename or a full path segment so that
// coincidental substring matches (e.g. "specialist.ts" matching /spec/i,
// "contractor.ts" matching /contract/i) do NOT produce false exemptions.
//
// Anchoring strategy per pattern:
//   basename-exact : match the normalized basename exactly (case-insensitive)
//   basename-prefix: match basename that starts with the keyword followed by
//                    a separator ([-_.]) or end-of-string
//   path-segment   : match an exact path segment (surrounded by "/" or string end)

function isAuthorityFile(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  // Normalize to forward slashes (Windows-safe).
  const p = filePath.replace(/\\/g, "/");
  const base = p.split("/").pop() || "";
  const baseLower = base.toLowerCase();

  // Exact basename matches.
  if (baseLower === "claude.md") return true;
  if (baseLower === "agents.md") return true;
  if (baseLower === "state.json") return true;
  if (baseLower === "progress.json") return true;

  // Basename starts with a keyword followed by separator or end-of-string.
  // e.g. "coordinator.md", "coordinator-v2.md", "spec.md", "spec-v2.md"
  // but NOT "specialist.ts", "speculative.js".
  const startsWithKeyword = (kw) => {
    if (!baseLower.startsWith(kw)) return false;
    const rest = baseLower.slice(kw.length);
    return rest === "" || /^[-_.]/.test(rest);
  };

  if (startsWithKeyword("coordinator")) return true;
  if (startsWithKeyword("skill")) return true;
  if (startsWithKeyword("spec")) return true;
  if (startsWithKeyword("contract")) return true;
  if (startsWithKeyword("stage-def") || startsWithKeyword("stage_def")) return true;
  if (startsWithKeyword("decision-log") || startsWithKeyword("decision_log")) return true;
  if (startsWithKeyword("roadmap")) return true;
  if (startsWithKeyword("project-state") || startsWithKeyword("project_state")) return true;

  // Path-segment match: a directory segment (not basename) exactly equals the keyword.
  // e.g. /agents/coordinator.md already caught above; this handles
  // paths like /state/whatever.json (if ever used as a dir).
  // No additional patterns currently needed here.

  return false;
}

// ── stdin parsing ─────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {
    return {};
  }
}

// ── transcript JSONL reader ───────────────────────────────────────────────────

function readJsonlLines(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return lines;
  } catch {
    return null; // unreadable — caller handles
  }
}

// ── compute result size from a tool_result content block ─────────────────────

function sizeFromContent(content) {
  if (content === null || content === undefined) {
    return { bytes: 0, lines: 0, isError: false };
  }
  let text = "";
  let isError = false;
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
    isError,
  };
}

// ── bounded transcript scan ───────────────────────────────────────────────────
// Returns { bigSelfChunks, totalWindowTurns } or null on parse failure.
//
// Pairs tool_use (assistant turn) with tool_result (user turn) by tool_use_id.
// Only scans the last WINDOW_TURNS foreman assistant turns (truly bounded):
//
// Step A: Single reverse pass over all lines to collect foreman assistant turns,
//         merging tool_use blocks from split-line turns that share a message.id.
//         Dedup by each tool_use's own block.id (toolu_...) — NOT by message.id
//         first-wins — so sibling lines carrying the tool_use block are never lost.
//         Collect turns in reverse order, stop once WINDOW_TURNS unique turns seen.
//
// Step B: Extract the set of tool_use_ids referenced in the window turns.
//
// Step C: Reverse pass over lines again to collect ONLY the tool_result entries
//         whose tool_use_id is in that set. Stop once all IDs are resolved.
//
// Both passes terminate early: for long transcripts this avoids full-file indexing
// and keeps execution within the 5 s PostToolUse timeout even on huge transcripts.

function scanTranscript(lines) {
  if (!lines || !Array.isArray(lines)) return null;

  // Step A: Reverse pass — collect last WINDOW_TURNS foreman turns.
  // A "turn" is keyed by message.id. Across split lines sharing the same message.id
  // we MERGE tool_use blocks. Each tool_use.id (toolu_...) is deduplicated so an
  // echoed block across multiple lines is only counted once.
  //
  // Result: foremanTurns[] in REVERSE order (newest first) — we slice WINDOW_TURNS
  // from this, then reverse again for chronological walk in the classifier loop.
  const foremanTurns = []; // { msgId, toolUses: Map<block.id, block> }
  const msgIdToTurnIndex = new Map(); // msgId → index in foremanTurns

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.type !== "assistant") continue;
    if (line.isSidechain === true) continue;
    const msg = line.message;
    if (!msg) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const msgId = msg.id || null;

    // Collect tool_use blocks from this line.
    const blockList = [];
    for (const block of content) {
      if (!block || block.type !== "tool_use") continue;
      blockList.push(block);
    }
    if (blockList.length === 0) continue;

    if (msgId && msgIdToTurnIndex.has(msgId)) {
      // Merge into existing turn (sibling line of a split turn).
      const idx = msgIdToTurnIndex.get(msgId);
      const turn = foremanTurns[idx];
      for (const block of blockList) {
        // Dedup by block.id (toolu_...); if no id, always include.
        if (block.id && turn.toolUseIds.has(block.id)) continue;
        if (block.id) turn.toolUseIds.add(block.id);
        turn.toolUses.push(block);
      }
    } else {
      // New turn.
      const toolUseIds = new Set();
      const toolUses = [];
      for (const block of blockList) {
        if (block.id && toolUseIds.has(block.id)) continue;
        if (block.id) toolUseIds.add(block.id);
        toolUses.push(block);
      }
      const idx = foremanTurns.length;
      foremanTurns.push({ msgId, toolUseIds, toolUses });
      if (msgId) msgIdToTurnIndex.set(msgId, idx);

      // Early-exit once we have enough turns in the window.
      // (foremanTurns is newest-first; WINDOW_TURNS covers the tail we need.)
      if (foremanTurns.length >= WINDOW_TURNS) break;
    }
  }

  // Reverse to restore chronological order for the classifier loop.
  foremanTurns.reverse();
  const windowTurns = foremanTurns; // already bounded to WINDOW_TURNS

  // Step B: Collect all tool_use_ids referenced in the window.
  const neededIds = new Set();
  for (const { toolUses } of windowTurns) {
    for (const tu of toolUses) {
      if (tu.id) neededIds.add(tu.id);
    }
  }

  // Step C: Reverse pass to collect matching tool_result entries only.
  // Stop early once all needed IDs are resolved.
  const resultsByToolUseId = new Map();
  if (neededIds.size > 0) {
    let remaining = neededIds.size;
    for (let i = lines.length - 1; i >= 0 && remaining > 0; i--) {
      const line = lines[i];
      if (!line || line.type !== "user") continue;
      if (line.isSidechain === true) continue;
      const content = line.message && line.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || block.type !== "tool_result") continue;
        const id = block.tool_use_id;
        if (!id || !neededIds.has(id) || resultsByToolUseId.has(id)) continue;
        const size = sizeFromContent(block.content);
        if (block.is_error) size.isError = true;
        resultsByToolUseId.set(id, size);
        remaining--;
      }
    }
  }

  // Walk the window: classify each tool_use, track delegation resets.
  // On Agent/Task dispatch: reset both bigSelfChunks and the effective epoch size so the
  // density denominator reflects only the post-delegation epoch (not the full window).
  // This implements "派 Agent → 计数清零" (design §1.1 step 2).
  let bigSelfChunks = 0;
  let epochTurns = 0; // turns in the current epoch (since last delegation)

  for (const { toolUses } of windowTurns) {
    let hasBigChunkInTurn = false;
    let hasAgentInTurn = false;

    for (const toolUse of toolUses) {
      const name = toolUse.name;

      // Agent/Task dispatch = delegation event → start a fresh epoch.
      if (name === "Agent" || name === "Task") {
        hasAgentInTurn = true;
        continue;
      }

      // Authority file carve-out: read of a file the foreman MUST read directly.
      const filePath =
        toolUse.input &&
        (toolUse.input.file_path || toolUse.input.path || null);
      if (filePath && isAuthorityFile(filePath)) continue;

      // Get paired result from the user-side tool_result blocks.
      const paired = resultsByToolUseId.get(toolUse.id) || null;

      const { isBigSelfRead, isBigSelfWrite } = isBigSelfChunk({
        toolUse: { name, input: toolUse.input || {} },
        result: paired,
      });

      if (isBigSelfRead || isBigSelfWrite) {
        hasBigChunkInTurn = true;
      }
    }

    // If Agent/Task appeared in this turn, reset epoch before counting this turn.
    if (hasAgentInTurn) {
      bigSelfChunks = 0;
      epochTurns = 0;
      // The Agent turn itself doesn't count as an epoch turn.
      continue;
    }

    epochTurns++;
    if (hasBigChunkInTurn) bigSelfChunks++;
  }

  return {
    bigSelfChunks,
    totalWindowTurns: epochTurns > 0 ? epochTurns : windowTurns.length,
  };
}

// ── cooldown sidecar file (per-session, keyed by transcript path) ─────────────
// ponytail: global lock, per-account if throughput matters.
// Each PostToolUse invocation is a fresh process spawn, so in-memory state is lost.
// We persist a tiny JSON sidecar next to the transcript. If unreadable → start fresh.

function cooldownPath(transcriptPath) {
  if (!transcriptPath) return null;
  // Place alongside transcript (same dir) with a distinct suffix.
  return transcriptPath.replace(/\.jsonl$/, "") + ".nudge-state.json";
}

function readCooldown(transcriptPath) {
  const p = cooldownPath(transcriptPath);
  if (!p) return { lightFiredAt: -1, strongFiredAt: -1, totalTurns: 0 };
  try {
    const obj = JSON.parse(readFileSync(p, "utf8"));
    return {
      lightFiredAt: typeof obj.lightFiredAt === "number" ? obj.lightFiredAt : -1,
      strongFiredAt: typeof obj.strongFiredAt === "number" ? obj.strongFiredAt : -1,
      totalTurns: typeof obj.totalTurns === "number" ? obj.totalTurns : 0,
    };
  } catch {
    return { lightFiredAt: -1, strongFiredAt: -1, totalTurns: 0 };
  }
}

function persistCooldown(transcriptPath, state) {
  const p = cooldownPath(transcriptPath);
  if (!p) return;
  try {
    writeFileSync(p, JSON.stringify(state), "utf8");
  } catch {
    // fail safe: cooldown not persisted, we may over-nudge once — acceptable
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

// Wrap everything in try/catch: any unhandled error → silent exit 0 (P1#10).
try {
  const hookData = readStdin();
  const transcriptPath = hookData.transcript_path || "";

  if (!transcriptPath) {
    process.exit(0);
  }

  const lines = readJsonlLines(transcriptPath);
  if (!lines) {
    process.exit(0);
  }

  const scan = scanTranscript(lines);
  if (!scan) {
    process.exit(0);
  }

  const { bigSelfChunks, totalWindowTurns } = scan;

  const cooldown = readCooldown(transcriptPath);
  const currentTurns = cooldown.totalTurns + 1;

  // Density-based tier determination
  const density = totalWindowTurns > 0 ? bigSelfChunks / totalWindowTurns : 0;
  const isStrong = bigSelfChunks >= STRONG_MIN_COUNT && density >= STRONG_DENSITY;
  const isLight = bigSelfChunks >= 1;

  // Independent cooldown per tier (light cooldown must not suppress strong)
  const lightSuppressed =
    cooldown.lightFiredAt >= 0 &&
    currentTurns - cooldown.lightFiredAt < LIGHT_COOLDOWN_TURNS;
  const strongSuppressed =
    cooldown.strongFiredAt >= 0 &&
    currentTurns - cooldown.strongFiredAt < STRONG_COOLDOWN_TURNS;

  let nudge = null;
  let newLightFiredAt = cooldown.lightFiredAt;
  let newStrongFiredAt = cooldown.strongFiredAt;

  if (isStrong && !strongSuppressed) {
    // Strong nudge: ≤3 lines, force binary choice
    nudge = [
      "[委派检查] 最近多次大块自采集，上下文在变重。你必须二选一：",
      "(A) 现在派子代理接手；(B) 继续自己查 —— 但必须先写一行：范围为何小到不值得派。",
      "写不出具体理由 = 选 (A)。",
    ].join("\n");
    newStrongFiredAt = currentTurns;
  } else if (isLight && !lightSuppressed) {
    // Light nudge: ≤2 lines
    nudge =
      "[委派检查] 刚做了一次大块自读。先判断：派 file-reader/researcher 接手，还是自己继续查？";
    newLightFiredAt = currentTurns;
  }

  // Persist cooldown (best-effort)
  persistCooldown(transcriptPath, {
    lightFiredAt: newLightFiredAt,
    strongFiredAt: newStrongFiredAt,
    totalTurns: currentTurns,
  });

  if (nudge) {
    // P1#10: ONLY additionalContext, NEVER permissionDecision:"deny" or decision:"block".
    process.stdout.write(JSON.stringify({ additionalContext: nudge }) + "\n");
  }
} catch {
  // Any unhandled exception → silent exit 0. Never block. (P1#10)
}

process.exit(0);
