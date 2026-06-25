#!/usr/bin/env node
/**
 * probe-omc.mjs — minimal OMC presence probe
 * Outputs JSON to stdout; exit 0 if available + all 4 agents found, else exit 1.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.HOME || homedir();
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

function probe() {
  try {
    const found = CANDIDATE_DIRS.find(d => existsSync(d));

    if (!found) {
      return {
        available: false,
        namespace: 'oh-my-claudecode',
        version: null,
        path: null,
        agents_found: [],
        missing_agents: REQUIRED_AGENTS,
        message: 'OMC not found. Install via: npm install -g oh-my-claude-sisyphus',
      };
    }

    // Read plugin metadata
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

    // Check agents directory
    const agentsDir = join(found, 'agents');
    if (!existsSync(agentsDir)) {
      return {
        available: false,
        namespace,
        version,
        path: found,
        agents_found: [],
        missing_agents: REQUIRED_AGENTS,
        message: `OMC found at ${found} but agents/ directory is missing`,
      };
    }

    const agentFiles = readdirSync(agentsDir).map(f => f.replace(/\.md$/, ''));
    const agents_found = REQUIRED_AGENTS.filter(a => agentFiles.includes(a));
    const missing_agents = REQUIRED_AGENTS.filter(a => !agentFiles.includes(a));

    return {
      available: agents_found.length === REQUIRED_AGENTS.length,
      namespace,
      version,
      path: found,
      agents_found,
      missing_agents,
      ...(missing_agents.length > 0 && {
        message: `Missing agents: ${missing_agents.join(', ')}`,
      }),
    };
  } catch (err) {
    return {
      available: false,
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
