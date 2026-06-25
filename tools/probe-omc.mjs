#!/usr/bin/env node
/**
 * probe-omc.mjs — OMC presence probe + prefix resolver
 *
 * Outputs JSON to stdout; exit 0 if available + all 4 agents found, else exit 1.
 *
 * Output fields:
 *   available      — boolean: all 4 required agents found
 *   prefix         — string|null: the Task subagent_type prefix to use
 *                    "oh-my-claudecode:" for plugin install
 *                    ""                  for bare-name install
 *                    null                for not installed
 *   source         — string: how OMC was detected
 *                    "project-bare" | "user-bare" | "plugin" | "not-installed"
 *   namespace      — string: OMC namespace (from .claude-plugin/plugin.json when plugin install)
 *   version        — string|null: OMC version
 *   path           — string|null: install path (plugin) or agents dir (bare)
 *   agents_found   — string[]: required agents that were found
 *   missing_agents — string[]: required agents that are missing
 *   message        — string (optional): explanation when not fully available
 *
 * This tool answers: "What prefix should I use to dispatch OMC agents via Task?"
 *
 * OMC_PROBE_PATH env var overrides the plugin candidate dirs (for testing / CI).
 * OMC_PROBE_CWD env var overrides cwd for bare-agent detection (for testing).
 * OMC_PROBE_HOME env var overrides home for bare-agent detection (for testing).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveOmcPrefix } from './lib/resolve-omc-prefix.mjs';

const HOME = process.env.OMC_PROBE_HOME || process.env.HOME || homedir();
const CWD  = process.env.OMC_PROBE_CWD  || process.cwd();

const REQUIRED_AGENTS = ['executor', 'debugger', 'code-reviewer', 'document-specialist'];

// OMC_PROBE_PATH overrides candidate dirs (single path, for testing / CI).
const CANDIDATE_DIRS = process.env.OMC_PROBE_PATH
  ? [process.env.OMC_PROBE_PATH]
  : [
      join(HOME, '.claude', 'plugins', 'oh-my-claudecode'),
      join(HOME, '.claude', 'plugins', 'oh-my-claude-sisyphus'),
      join(HOME, '.npm-global', 'lib', 'node_modules', 'oh-my-claudecode'),
      join(HOME, '.npm-global', 'lib', 'node_modules', 'oh-my-claude-sisyphus'),
    ];

function probePlugin() {
  try {
    const found = CANDIDATE_DIRS.find(d => existsSync(d));
    if (!found) return null;

    // Read plugin metadata.
    // Namespace comes from .claude-plugin/plugin.json (Claude Code plugin contract),
    // NOT from package.json (npm package name may differ, e.g. oh-my-claude-sisyphus).
    let namespace = 'oh-my-claudecode';
    let version = null;
    const pluginJsonPath = join(found, '.claude-plugin', 'plugin.json');
    const packageJsonPath = join(found, 'package.json');
    if (existsSync(pluginJsonPath)) {
      try {
        const meta = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
        if (meta.name) namespace = meta.name;
        if (meta.version) version = meta.version;
      } catch { /* ignore parse errors */ }
    }
    if (version === null && existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        if (pkg.version) version = pkg.version;
      } catch { /* ignore parse errors */ }
    }

    // Check agents directory.
    const agentsDir = join(found, 'agents');
    if (!existsSync(agentsDir)) {
      return { found, namespace, version, agents_found: [], agentsDir: null };
    }

    const agentFiles = readdirSync(agentsDir).map(f => f.replace(/\.md$/, ''));
    const agents_found = REQUIRED_AGENTS.filter(a => agentFiles.includes(a));
    return { found, namespace, version, agents_found };
  } catch {
    return null;
  }
}

function probe() {
  try {
    // When OMC_PROBE_PATH is set (test/CI override), resolveOmcPrefix would read
    // the real HOME and bypass the test's fake plugin dir entirely. In that case
    // skip the canonical resolver and go directly to probePlugin() which respects
    // OMC_PROBE_PATH via CANDIDATE_DIRS. This preserves the existing test contract
    // for OMC_PROBE_PATH-based tests without introducing a new env-override mechanism.
    if (process.env.OMC_PROBE_PATH) {
      const pluginInfo = probePlugin();
      if (!pluginInfo) {
        return {
          available: false,
          prefix: null,
          source: 'not-installed',
          namespace: 'oh-my-claudecode',
          version: null,
          path: null,
          agents_found: [],
          missing_agents: REQUIRED_AGENTS,
          message: 'OMC not found. Install via: /plugin marketplace add + /plugin install oh-my-claudecode@omc',
        };
      }
      const { found, namespace, version, agents_found } = pluginInfo;
      const missing_agents = REQUIRED_AGENTS.filter(a => !agents_found.includes(a));
      if (!pluginInfo.agentsDir && pluginInfo.agentsDir !== undefined) {
        return {
          available: false,
          prefix: `${namespace}:`,
          source: 'plugin',
          namespace,
          version,
          path: found,
          agents_found: [],
          missing_agents: REQUIRED_AGENTS,
          message: `OMC found at ${found} but agents/ directory is missing`,
        };
      }
      return {
        available: agents_found.length === REQUIRED_AGENTS.length,
        prefix: `${namespace}:`,
        source: 'plugin',
        namespace,
        version,
        path: found,
        agents_found,
        missing_agents,
        ...(missing_agents.length > 0 && {
          message: `Missing agents: ${missing_agents.join(', ')}`,
        }),
      };
    }

    // Resolve prefix, source, and installPath from the single canonical source.
    // resolveOmcPrefix() now returns installPath for all install types:
    //   - bare-name: path to the .claude/agents/ directory
    //   - plugin: installPath from installed_plugins.json
    //   - not-installed: null
    const { prefix, source, installPath } = resolveOmcPrefix({ cwd: CWD, home: HOME });

    // For bare-name installs, inspect the agents directory (installPath is the agents dir).
    if (source === 'project-bare' || source === 'user-bare') {
      const agentsDir = installPath || (source === 'project-bare'
        ? join(CWD, '.claude', 'agents')
        : join(HOME, '.claude', 'agents'));

      let agentFiles = [];
      try {
        agentFiles = readdirSync(agentsDir).map(f => f.replace(/\.md$/, ''));
      } catch { /* directory unreadable */ }

      const agents_found   = REQUIRED_AGENTS.filter(a => agentFiles.includes(a));
      const missing_agents = REQUIRED_AGENTS.filter(a => !agentFiles.includes(a));
      const available = agents_found.length === REQUIRED_AGENTS.length;

      return {
        available,
        prefix,
        source,
        namespace: 'oh-my-claudecode',
        version: null,
        path: agentsDir,
        agents_found,
        missing_agents,
        ...(missing_agents.length > 0 && {
          message: `Bare-name OMC install found at ${agentsDir}. Missing agents: ${missing_agents.join(', ')}`,
        }),
      };
    }

    // For plugin installs, installPath comes from resolveOmcPrefix (installed_plugins.json).
    // probePlugin() is still used for version/namespace/agent list from the plugin directory.
    if (source === 'plugin' && installPath) {
      // We know the install path from resolveOmcPrefix; use it to find agents.
      let namespace = 'oh-my-claudecode';
      let version = null;
      const pluginJsonPath = join(installPath, '.claude-plugin', 'plugin.json');
      const packageJsonPath = join(installPath, 'package.json');
      if (existsSync(pluginJsonPath)) {
        try {
          const meta = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
          if (meta.name) namespace = meta.name;
          if (meta.version) version = meta.version;
        } catch { /* ignore parse errors */ }
      }
      if (version === null && existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
          if (pkg.version) version = pkg.version;
        } catch { /* ignore parse errors */ }
      }

      const agentsDir = join(installPath, 'agents');
      if (!existsSync(agentsDir)) {
        return {
          available: false,
          prefix,
          source,
          namespace,
          version,
          path: installPath,
          agents_found: [],
          missing_agents: REQUIRED_AGENTS,
          message: `OMC found at ${installPath} but agents/ directory is missing`,
        };
      }

      const agentFiles = readdirSync(agentsDir).map(f => f.replace(/\.md$/, ''));
      const agents_found = REQUIRED_AGENTS.filter(a => agentFiles.includes(a));
      const missing_agents = REQUIRED_AGENTS.filter(a => !agents_found.includes(a));

      return {
        available: agents_found.length === REQUIRED_AGENTS.length,
        prefix,
        source,
        namespace,
        version,
        path: installPath,
        agents_found,
        missing_agents,
        ...(missing_agents.length > 0 && {
          message: `Missing agents: ${missing_agents.join(', ')}`,
        }),
      };
    }

    // resolveOmcPrefix returned not-installed and no OMC_PROBE_PATH override.
    // There is no fallback: probe and enforce-backend share the same single
    // canonical source (resolveOmcPrefix). Using a separate probePlugin() here
    // would create two divergent detection paths and break the invariant:
    //   "same environment → same available/prefix judgment in probe AND enforce."
    return {
      available: false,
      prefix: null,
      source: 'not-installed',
      namespace: 'oh-my-claudecode',
      version: null,
      path: null,
      agents_found: [],
      missing_agents: REQUIRED_AGENTS,
      message: 'OMC not found. Install via: /plugin marketplace add + /plugin install oh-my-claudecode@omc',
    };
  } catch (err) {
    return {
      available: false,
      prefix: null,
      source: 'not-installed',
      namespace: 'oh-my-claudecode',
      version: null,
      path: null,
      agents_found: [],
      missing_agents: REQUIRED_AGENTS,
      message: `Probe failed: ${err.message}`,
    };
  }
}

const result = probe();
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.available ? 0 : 1);
