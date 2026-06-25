/**
 * resolve-omc-prefix.mjs — shared OMC installation detection + agent classification
 *
 * Exports:
 *   resolveOmcPrefix({ cwd, home }) → { prefix, source, installPath }
 *   classifyAgentBackend(subagentType, omcPrefix) → "omc" | "legacy" | "unknown"
 *
 * Detection priority (project-level beats global):
 * 1. cwd/.claude/agents/  — ≥2 distinct OMC signal files → { prefix: "", source: "project-bare" }
 * 2. home/.claude/agents/ — ≥2 distinct OMC signal files → { prefix: "", source: "user-bare" }
 * 3. home/.claude/plugins/installed_plugins.json key /^oh-my-claudecode@/
 *    → { prefix: "oh-my-claudecode:", source: "plugin", installPath: <from plugins json> }
 * 4. None → { prefix: null, source: "not-installed", installPath: null }
 *
 * Bare-name detection: requires ≥2 of the OMC_BARE_SIGNALS files to co-exist.
 * A single matching file (e.g. user's own executor.md) does NOT trigger bare-name mode.
 * This prevents a lone user-created executor.md from causing a false positive.
 * Threshold = 2: one file is coincidence; two distinct OMC-specific agents are structural.
 *
 * OMC agent base-name roster (known OMC agents, coordinator excluded — coordinator
 * belongs to Worker-Mode, not OMC):
 *   analyst, architect, code-reviewer, code-simplifier, critic, debugger, designer,
 *   document-specialist, executor, explore, git-master, planner, qa-tester, scientist,
 *   security-reviewer, test-engineer, tracer, verifier, writer
 *
 * Legacy (Worker-Mode self-built) agent base-names:
 *   implementer, fixer, qa, reviewer, researcher, file-reader
 *
 * classifyAgentBackend rules:
 *   - Bare name (no ":"): look up directly in OMC_AGENT_NAMES / LEGACY_AGENT_NAMES.
 *   - Starts with omcPrefix (non-empty): strip prefix, look up base name in rosters.
 *   - Contains ":" but does NOT start with known omcPrefix: return "unknown" immediately.
 *     The base name after the last ":" is NOT extracted — that would allow namespace bypass.
 *   - Base name in OMC_AGENT_NAMES  → "omc"
 *   - Base name in LEGACY_AGENT_NAMES → "legacy"
 *   - Neither → "unknown"   (fail-open: unknown agents are never denied)
 *
 * Parameters cwd / home injectable for testing; production defaults
 * process.cwd() and os.homedir() respectively.
 *
 * Pure logic: no side-effects, no process.exit, no console output.
 * All file I/O try-caught; failures degrade to next priority level.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── OMC signal files used for bare-name detection ────────────────────────────
// These are agent files that only OMC would install (coordinator.md excluded).
// Detection requires ≥ BARE_SIGNAL_THRESHOLD of these to co-exist.
const OMC_BARE_SIGNALS = [
  "executor.md",
  "explore.md",
  "debugger.md",
  "document-specialist.md",
  "architect.md",
  "code-reviewer.md",
  "planner.md",
  "writer.md",
  "verifier.md",
];

/** Minimum number of signal files that must co-exist to confirm bare-name OMC install. */
const BARE_SIGNAL_THRESHOLD = 2;

// ── Known agent rosters ───────────────────────────────────────────────────────

/**
 * Known OMC agent base-names (coordinator excluded — belongs to Worker-Mode).
 * Source: OMC agent list as of integration.
 */
const OMC_AGENT_NAMES = new Set([
  "analyst",
  "architect",
  "code-reviewer",
  "code-simplifier",
  "critic",
  "debugger",
  "designer",
  "document-specialist",
  "executor",
  "explore",
  "git-master",
  "planner",
  "qa-tester",
  "scientist",
  "security-reviewer",
  "test-engineer",
  "tracer",
  "verifier",
  "writer",
]);

/**
 * Worker-Mode self-built (legacy) agent base-names.
 */
const LEGACY_AGENT_NAMES = new Set([
  "implementer",
  "fixer",
  "qa",
  "reviewer",
  "researcher",
  "file-reader",
]);

// ── Bare-name detection ──────────────────────────────────────────────────────

/**
 * Returns true when agentsDir contains at least BARE_SIGNAL_THRESHOLD OMC signal files.
 * A single matching file is insufficient to avoid false positives from user-created files.
 * @param {string} agentsDir
 * @returns {boolean}
 */
function hasBareOmcAgents(agentsDir) {
  try {
    if (!existsSync(agentsDir)) return false;
    let count = 0;
    for (const f of OMC_BARE_SIGNALS) {
      if (existsSync(join(agentsDir, f))) {
        count++;
        if (count >= BARE_SIGNAL_THRESHOLD) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ── Plugin detection ─────────────────────────────────────────────────────────

/**
 * Reads installed_plugins.json and returns { key, installPath } for the first
 * key matching /^oh-my-claudecode@/, or null if not found / unreadable.
 * installPath comes from plugins[key][0].installPath (Claude Code plugin contract).
 * @param {string} pluginsDir  — path to ~/.claude/plugins/
 * @returns {{ key: string, installPath: string|null }|null}
 */
function readPluginInfo(pluginsDir) {
  try {
    const jsonPath = join(pluginsDir, "installed_plugins.json");
    if (!existsSync(jsonPath)) return null;
    const raw = readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const plugins = parsed?.plugins;
    if (!plugins || typeof plugins !== "object") return null;
    const key = Object.keys(plugins).find((k) => /^oh-my-claudecode@/.test(k));
    if (!key) return null;
    // installPath is stored in the first entry of the array value for the key.
    const entries = plugins[key];
    const installPath =
      Array.isArray(entries) && entries[0]?.installPath
        ? entries[0].installPath
        : null;
    return { key, installPath };
  } catch {
    return null;
  }
}

// ── resolveOmcPrefix ─────────────────────────────────────────────────────────

/**
 * Resolves OMC Task subagent_type prefix for current environment.
 *
 * @param {{ cwd?: string, home?: string }} [opts]
 * @returns {{ prefix: string|null, source: string, installPath: string|null }}
 *   prefix:
 *     ""    — bare-name install (no prefix needed)
 *     "oh-my-claudecode:" — standard plugin install
 *     null  — OMC not detected
 *   source:
 *     "project-bare" | "user-bare" | "plugin" | "not-installed"
 *   installPath:
 *     For plugin installs: absolute path from installed_plugins.json.
 *     For bare-name installs: path to the .claude/agents/ directory used.
 *     null when OMC not detected.
 */
export function resolveOmcPrefix({ cwd = process.cwd(), home = homedir() } = {}) {
  // 1. Project-level bare agents
  const projectAgentsDir = join(cwd, ".claude", "agents");
  if (hasBareOmcAgents(projectAgentsDir)) {
    return { prefix: "", source: "project-bare", installPath: projectAgentsDir };
  }

  // 2. User-level bare agents
  const userAgentsDir = join(home, ".claude", "agents");
  if (hasBareOmcAgents(userAgentsDir)) {
    return { prefix: "", source: "user-bare", installPath: userAgentsDir };
  }

  // 3. Plugin install via installed_plugins.json
  const pluginsDir = join(home, ".claude", "plugins");
  const pluginInfo = readPluginInfo(pluginsDir);
  if (pluginInfo) {
    const pluginName = pluginInfo.key.split("@")[0];
    return {
      prefix: pluginName + ":",
      source: "plugin",
      installPath: pluginInfo.installPath,
    };
  }

  // 4. Not found
  return { prefix: null, source: "not-installed", installPath: null };
}

// ── classifyAgentBackend ─────────────────────────────────────────────────────

/**
 * Classifies a subagent_type string as "omc", "legacy", or "unknown".
 *
 * Logic:
 *   1. Extract base name:
 *      - If omcPrefix is non-empty and subagentType starts with omcPrefix,
 *        strip the prefix → base name.
 *      - Else if subagentType contains ":", take the part after the last ":".
 *      - Otherwise subagentType itself is the base name (bare dispatch).
 *   2. Look up base name in OMC_AGENT_NAMES → "omc"
 *   3. Look up base name in LEGACY_AGENT_NAMES → "legacy"
 *   4. Neither → "unknown"  (fail-open, unknown agents are never denied)
 *
 * This works correctly in ALL environments:
 *   - Plugin env ("oh-my-claudecode:"): "oh-my-claudecode:executor" → base="executor" → omc
 *   - Bare env (""): "executor" → base="executor" → omc; "implementer" → base="implementer" → legacy
 *   - Unknown namespaced: "custom:something" → base="something" → depends on roster
 *
 * @param {string} subagentType
 * @param {string|null} omcPrefix  — resolved prefix from resolveOmcPrefix()
 * @returns {"omc" | "legacy" | "unknown"}
 */
export function classifyAgentBackend(subagentType, omcPrefix) {
  if (!subagentType || typeof subagentType !== "string") return "unknown";

  let baseName;

  // Strip known OMC namespace prefix when prefix is non-empty.
  if (omcPrefix && subagentType.startsWith(omcPrefix)) {
    baseName = subagentType.slice(omcPrefix.length);
  } else if (subagentType.includes(":")) {
    // Contains ":" but does NOT start with the known OMC prefix.
    // Unknown namespace (e.g. "other:executor", "evil:oh-my-claudecode:executor").
    // Do NOT extract base name via lastIndexOf — that enables namespace bypass.
    // Unrecognised namespaces are never classified as omc or legacy.
    return "unknown";
  } else {
    // Bare name (no namespace).
    baseName = subagentType;
  }

  if (OMC_AGENT_NAMES.has(baseName)) return "omc";
  if (LEGACY_AGENT_NAMES.has(baseName)) return "legacy";
  return "unknown";
}
