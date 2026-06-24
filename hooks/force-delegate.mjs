#!/usr/bin/env node
// force-delegate.mjs — PreToolUse hook: intercepts "write/execute" tool calls
// made by the orchestrator (main session) and denies them with delegation guidance.
// Sub-agent calls (payload has non-empty string agent_id) are always allowed through.
//
// 拦截定位：这是改变工头「默认念头」的兜底，不是防蓄意越狱的沙箱。
// Bash 写文件方式图灵完备、黑名单堵不完——这里只堵工头自然工作流会用到的常见写法
// （Write/Edit、echo>/heredoc/tee、dd of=、python/node/perl -e/-c、cp/mv 源码、curl -o）。
// 刻意用冷门命令（如 install/rsync/awk 写文件）越狱不在防御范围内——那是蓄意绕过，
// 不是「默认就想自己干活」的念头，用 WORKER_FORCE_DELEGATE=off 才是正道，不靠这里堵死。
//
// FAIL-OPEN: any exception → silent allow (exit 0). Hook bugs must never stall the orchestrator.
//
// Toggle: set WORKER_FORCE_DELEGATE=off|0|false to disable entirely.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

// ── helpers ───────────────────────────────────────────────────────────────────

function readStdin() {
  return JSON.parse(readFileSync("/dev/stdin", "utf8"));
}

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
  process.exit(0);
}

// ── escape valve: allowed write-path detector ─────────────────────────────────
// (A) Dispatch-output files: document extension + bounded semantic keyword segment.
//     "Bounded" = keyword surrounded by separator chars on both sides (or path
//     start/end), so "statement.ts" does NOT match "state", and "status.ts" does
//     NOT match "status" (the extension .ts is not in DOC_EXTS).
const DELEGATION_OUTPUT_KEYWORDS = [
  "state",
  "status",
  "progress",
  "journal",
  "handoff",
  "decision",
];

// Keyword must be bounded by a separator (/ . _ -) or path start/end.
const DISPATCH_OUTPUT_KEYWORD_RE = new RegExp(
  "(^|[/._-])(" + DELEGATION_OUTPUT_KEYWORDS.join("|") + ")([/._-]|$)",
  "i"
);

// Only document-like extensions count for dispatch output.
const DOC_EXTS = new Set([".md", ".json", ".jsonl", ".txt", ".yaml", ".yml"]);

function hasDocExt(filePath) {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return DOC_EXTS.has(filePath.slice(dot).toLowerCase());
}

// (B) Red-line orchestrator outputs: CLAUDE.md, AGENTS.md, .claude/ tree, memory/ tree.
const RED_LINE_BASENAME = new Set(["CLAUDE.md", "AGENTS.md"]);

function isAllowedWritePath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;

  // (B) Red-line memory / protocol files — always allow.
  const base = basename(filePath);
  if (RED_LINE_BASENAME.has(base)) return true;
  if (/(?:^|\/)\.claude\//.test(filePath)) return true;
  if (/(?:^|\/)memory\//.test(filePath)) return true;

  // (A) Dispatch output: document extension AND bounded keyword segment.
  return hasDocExt(filePath) && DISPATCH_OUTPUT_KEYWORD_RE.test(filePath);
}

// ── Stderr-redirect stripping ─────────────────────────────────────────────────
// Strip from a command string all redirect tokens that do NOT write a real file:
//   - N>&M   fd duplication: 2>&1, 1>&2, etc.          → remove entirely
//   - N>/dev/...  fd to device: 2>/dev/null             → remove entirely
//   - &>/dev/...  combined redirect to device: &>/dev/null → remove entirely
//   - N>>/dev/... append to device                      → remove entirely
// After stripping, any remaining > or >> represents a genuine file write.
// This is done with string replacement before further analysis.
function stripNonWritingRedirects(cmd) {
  // Order matters: handle longer/more-specific patterns first.
  return cmd
    // N>&M  (fd dup, e.g. 2>&1, 1>&2) — remove the token
    .replace(/\d+>&\d+/g, "")
    // &>/dev/...  (bash combined redirect to device)
    .replace(/&>>\s*\/dev\/\S*/g, "")
    .replace(/&>\s*\/dev\/\S*/g, "")
    // N>>/dev/...  or N>/dev/...  (fd redirect to device)
    .replace(/\d*>>\s*\/dev\/\S*/g, "")
    .replace(/\d*>\s*\/dev\/\S*/g, "");
}

// ── Bash: dangerous-structure detection (must come BEFORE light-allowlist) ────
// Any of these structures means the command can write/execute and must NOT be
// short-circuited by the light allowlist.
//
// Structures that indicate potential writes or execution side-effects:
//   - any redirect:  >  >>  >|  N>  N>>
//   - heredoc:       <<
//   - pipe:          |  (could pipe into tee, sponge, etc.)
//   - command chaining: ; && ||
//   - subshell / command substitution: $() ``
const DANGEROUS_STRUCTURE_RE =
  />>|>|<<|[|]|&&|;|\|\||`|\$\(/;

// Strict light-allowlist: only if the command has NO dangerous structures AND
// starts with one of these known-safe verbs.
// mkdir / cd / echo removed (they can have side effects or be misleading).
const LIGHT_VERB_RE =
  /^\s*(ls|git\s+(status|log|diff|branch|show|stash)\b|pwd|wc|which|cat|grep|find|head|tail|less|more|file|stat|du|df|type|env|printenv|uname|hostname|date|whoami|id)\b/;

function bashHasDangerousStructure(cmd) {
  return DANGEROUS_STRUCTURE_RE.test(cmd);
}

function bashIsLightSafe(cmd) {
  return !bashHasDangerousStructure(cmd) && LIGHT_VERB_RE.test(cmd);
}

// ── Bash write-pattern detection (used when dangerous structure is present) ───
// If a dangerous structure is found, check whether the command is actually
// writing a file (vs. just piping to a reader like less/grep).
const BASH_WRITE_PATTERNS = [
  // Redirects (single, append, fd-prefixed)
  /\d*>>?(?!\()/,        // N>> N> >> > (but not process substitution >()  )
  />\|/,                 // >| (clobber)
  // Heredoc
  /<<\s*['"`]?[A-Z_]/,
  // Pipe into writing tools
  /\|\s*(tee|sponge|dd\b|install\b|cp\b|mv\b|rsync\b)/,
  // In-place editors
  /\bsed\s+(-[a-z]*i|--in-place)/,
  /\bperl\s+.*-[a-z]*i/,
  /\bawk\b.*-i\b/,
  // dd direct write (blocking)
  /\bdd\b[^|]*\bof=/,
  // Inline script writers: single-line scripts that can open/write files (blocking)
  /\b(python3?|node|perl|ruby)\s+-[ce]\b/,
  // cp/mv to source/config file extensions (note: pure data file moves not blocked)
  /\b(cp|mv)\b.*\.(ts|js|jsx|tsx|py|go|rs|java|rb|c|cpp|h|json|yaml|yml)\b/,
  // curl/wget downloading to a file
  /\bcurl\b.*\s-o\s/,
  /\bwget\b.*\s-O\s/,
];

function bashWritesToFile(cmd) {
  // Strip stderr/fd/device redirects before checking — they are not real writes.
  const stripped = stripNonWritingRedirects(cmd);
  return BASH_WRITE_PATTERNS.some((re) => re.test(stripped));
}

// ── Bash test-runner detection ─────────────────────────────────────────────────
const BASH_TEST_PATTERNS = [
  /\bnpm\s+(run\s+)?t(est)?\b/,          // npm test, npm t, npm run test
  /\bpnpm\s+(run\s+)?test\b/,
  /\byarn\s+(run\s+)?test\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bjest\b/,
  /\bvitest\b/,
  /\bbun\s+test\b/,
  /\bcargo\s+test\b/,
  /\bdeno\s+test\b/,
  /\bnode\s+--test\b/,
  // node path/to/foo.test.js or foo.spec.mjs — only match when the file being
  // run has a .test. or .spec. segment in its filename (not in a directory name).
  /\bnode\b[^|;&\n]*\/[^/|;&\n]*\.(test|spec)\.(m?[jt]s|cjs)\b/,
];

function bashIsTest(cmd) {
  return BASH_TEST_PATTERNS.some((re) => re.test(cmd));
}

// ── Try to extract write-target path from a bash command ──────────────────────
// Best-effort; used to check escape valve for Bash writes.
// Returns the write target path, or null if none found.
// Device files (/dev/*) are returned as-is so the caller can allow them.
function extractWriteTarget(cmd) {
  // Strip non-writing redirects first so they don't produce false targets.
  const stripped = stripNonWritingRedirects(cmd);
  // tee target: ... | tee <path>
  const teeM = stripped.match(/\|\s*tee\s+(\S+)/);
  if (teeM) return teeM[1];
  // >| (clobber redirect): ... >| <path>
  const clobberM = stripped.match(/>\|\s*(\S+)/);
  if (clobberM) return clobberM[1];
  // redirect: ... > path or ... >> path (take the last one found)
  const redirMatches = [...stripped.matchAll(/\d*>>?\s*(\S+)/g)];
  if (redirMatches.length > 0) return redirMatches[redirMatches.length - 1][1];
  return null;
}

// ── deny messages ─────────────────────────────────────────────────────────────

const DENY_WRITE =
  "这是写文件的活，别在主会话自己写。用 Task 把它连同明确的 done-condition 派给 implementer 子代理，让它在自己上下文里写完回报结果。（如果这是 state/进度/handoff 等调度产出，本该放行——若被误拦，说明路径白名单需补。）";

const DENY_TEST =
  "跑测试/验证的活派给 qa 或 implementer 子代理，让它在自己上下文里跑完 RED/GREEN 回报结果，别在主会话自己跑。";

// ── tools always allowed for the orchestrator ─────────────────────────────────
const ALLOWED_TOOLS = new Set(["Task", "Agent", "Read", "Grep", "Glob", "TodoWrite"]);

// ── main ──────────────────────────────────────────────────────────────────────

try {
  // Kill-switch: WORKER_FORCE_DELEGATE=off|0|false → allow everything.
  const toggle = (process.env.WORKER_FORCE_DELEGATE || "").trim().toLowerCase();
  if (toggle === "off" || toggle === "0" || toggle === "false") {
    allow();
  }

  const payload = readStdin();

  // Step 1: sub-agent calls — agent_id must be a non-empty string.
  const agentId = payload.agent_id;
  if (typeof agentId === "string" && agentId.length > 0) {
    allow();
  }
  // (non-string / empty agent_id falls through → treated as main session)

  const toolName = (payload.tool_name || payload.toolName || "").trim();
  const toolInput = payload.tool_input || payload.toolInput || {};

  // Step 2: always-allowed orchestrator tools.
  if (ALLOWED_TOOLS.has(toolName)) {
    allow();
  }

  // Step 3: Write / Edit / MultiEdit.
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const filePath = toolInput.file_path || toolInput.path || "";
    if (isAllowedWritePath(filePath)) allow();
    // Note: Edit deny has a known CC bug (#37210) — hook outputs correct deny regardless.
    deny(DENY_WRITE);
  }

  // Step 4: Bash — dangerous-structure-first logic.
  if (toolName === "Bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";

    // 4a: Check test runners first — applies regardless of dangerous structures.
    if (bashIsTest(cmd)) deny(DENY_TEST);

    // 4b: Check write patterns — applies regardless of dangerous structures.
    // Some write tools (dd, python -c, cp, curl -o) have no shell metacharacters
    // but are still writes. Others (echo >, tee, heredoc) do have metacharacters.
    // We check both cases uniformly here.
    if (bashWritesToFile(cmd)) {
      // Escape valve: if we can extract the write target, check whitelist.
      const target = extractWriteTarget(cmd);
      // Writing to a device file (/dev/null, /dev/stdout, etc.) is a no-op write.
      if (target && target.startsWith("/dev/")) allow();
      if (target && isAllowedWritePath(target)) allow();
      deny(DENY_WRITE);
    }

    // No dangerous write structure or test runner detected → allow.
    // (Dangerous structures that don't write, like `ls | grep foo` or
    //  `cmd1 && cmd2` pure readers, fall through here too.)
    allow();
  }

  // Unknown/other tools → allow (fail-open).
  allow();
} catch {
  // Fail-open: hook errors must never block the orchestrator.
  process.exit(0);
}
