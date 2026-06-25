import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveOmcPrefix } from '../tools/lib/resolve-omc-prefix.mjs';

const PROBE = new URL('../tools/probe-omc.mjs', import.meta.url).pathname;

function runProbe(env = {}) {
  try {
    const stdout = execFileSync('node', [PROBE], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', exitCode: err.status ?? 1 };
  }
}

test('output is always valid JSON with available field', () => {
  const { stdout } = runProbe();
  const result = JSON.parse(stdout);
  assert.ok('available' in result, 'must have available field');
  assert.ok('prefix' in result, 'must have prefix field');
  assert.ok('source' in result, 'must have source field');
  assert.ok(Array.isArray(result.agents_found), 'agents_found must be array');
  assert.ok(Array.isArray(result.missing_agents), 'missing_agents must be array');
  assert.ok(typeof result.namespace === 'string', 'namespace must be string');
});

test('OMC available in real env — exit 0, all 4 agents found', (t) => {
  // Skip when OMC is not installed in the current environment (e.g. CI).
  const probeCheck = runProbe();
  const probeResult = JSON.parse(probeCheck.stdout);
  if (!probeResult.available) {
    t.skip('OMC not installed in this environment — skipping real-env test');
    return;
  }

  const { stdout, exitCode } = runProbe();
  const result = JSON.parse(stdout);
  assert.equal(result.available, true, 'should be available');
  assert.equal(exitCode, 0, 'exit code should be 0');
  assert.ok(result.agents_found.includes('executor'), 'executor found');
  assert.ok(result.agents_found.includes('debugger'), 'debugger found');
  assert.ok(result.agents_found.includes('code-reviewer'), 'code-reviewer found');
  assert.ok(result.agents_found.includes('document-specialist'), 'document-specialist found');
  assert.equal(result.missing_agents.length, 0, 'no missing agents');
  assert.equal(result.namespace, 'oh-my-claudecode', 'namespace must be oh-my-claudecode (from .claude-plugin/plugin.json, not package.json)');
  assert.ok(result.version, 'version should be present');
  assert.ok(result.path, 'path should be present');
  // prefix must be a non-null string (either plugin or bare-name)
  assert.ok(result.prefix !== null, 'prefix must not be null when OMC is available');
  assert.ok(typeof result.prefix === 'string', 'prefix must be a string');
  assert.ok(typeof result.source === 'string', 'source must be a string');
});

test('fake HOME with no OMC → available:false, exit 1', () => {
  const { stdout, exitCode } = runProbe({ HOME: '/tmp/nonexistent-home-xyz', OMC_PROBE_HOME: '/tmp/nonexistent-home-xyz' });
  const result = JSON.parse(stdout);
  assert.equal(result.available, false, 'should not be available');
  assert.equal(exitCode, 1, 'exit code should be 1');
  assert.ok(result.message, 'should have a message explaining the failure');
  assert.equal(result.agents_found.length, 0, 'no agents found');
  assert.deepEqual(result.missing_agents, ['executor', 'debugger', 'code-reviewer', 'document-specialist']);
  // prefix must be null when OMC is not installed
  assert.equal(result.prefix, null, 'prefix must be null when OMC not installed');
  assert.equal(result.source, 'not-installed', 'source must be not-installed');
});

// ── Deterministic tests using a fake OMC structure ──────────────────────────

const REQUIRED_AGENTS = ['executor', 'debugger', 'code-reviewer', 'document-specialist'];

function buildFakeOmc(dir, agents = REQUIRED_AGENTS) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'oh-my-claudecode', version: '9.9.9' }),
  );
  mkdirSync(join(dir, 'agents'), { recursive: true });
  for (const agent of agents) {
    writeFileSync(join(dir, 'agents', `${agent}.md`), `# ${agent}`);
  }
}

describe('deterministic fake-OMC tests', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fake-omc-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('fake OMC 4 agents all present → available:true, correct namespace/version, exit 0', () => {
    const omcDir = join(tmpDir, 'full');
    mkdirSync(omcDir, { recursive: true });
    buildFakeOmc(omcDir);

    const { stdout, exitCode } = runProbe({ OMC_PROBE_PATH: omcDir });
    const result = JSON.parse(stdout);

    assert.equal(result.available, true, 'should be available');
    assert.equal(exitCode, 0, 'exit code should be 0');
    assert.equal(result.namespace, 'oh-my-claudecode', 'namespace from plugin.json');
    assert.equal(result.version, '9.9.9', 'version from plugin.json');
    assert.equal(result.missing_agents.length, 0, 'no missing agents');
    assert.deepEqual(result.agents_found.sort(), [...REQUIRED_AGENTS].sort());
    // prefix must be a non-null string (plugin path detected)
    assert.ok(result.prefix !== null, 'prefix must not be null for available OMC');
    assert.ok(typeof result.prefix === 'string', 'prefix must be a string');
    assert.ok(typeof result.source === 'string', 'source must be a string');
  });

  test('fake OMC missing one agent → available:false, missing_agents contains it, exit 1', () => {
    const omcDir = join(tmpDir, 'missing-one');
    mkdirSync(omcDir, { recursive: true });
    buildFakeOmc(omcDir, ['executor', 'debugger', 'code-reviewer']); // document-specialist missing

    const { stdout, exitCode } = runProbe({ OMC_PROBE_PATH: omcDir });
    const result = JSON.parse(stdout);

    assert.equal(result.available, false, 'should not be available');
    assert.equal(exitCode, 1, 'exit code should be 1');
    assert.ok(result.missing_agents.includes('document-specialist'), 'missing_agents contains document-specialist');
    assert.equal(result.missing_agents.length, 1, 'exactly one missing agent');
  });

  test('OMC_PROBE_PATH points to empty dir (no .claude-plugin, no agents) → available:false, exit 1', () => {
    const omcDir = join(tmpDir, 'empty');
    mkdirSync(omcDir, { recursive: true });

    const { stdout, exitCode } = runProbe({ OMC_PROBE_PATH: omcDir });
    const result = JSON.parse(stdout);

    assert.equal(result.available, false, 'should not be available');
    assert.equal(exitCode, 1, 'exit code should be 1');
  });

  test('output is always valid JSON regardless of environment', () => {
    const cases = [
      { OMC_PROBE_PATH: join(tmpDir, 'full') },
      { OMC_PROBE_PATH: join(tmpDir, 'missing-one') },
      { OMC_PROBE_PATH: join(tmpDir, 'empty') },
      { HOME: '/tmp/nonexistent-xyz' },
    ];
    for (const env of cases) {
      const { stdout } = runProbe(env);
      let result;
      assert.doesNotThrow(() => { result = JSON.parse(stdout); }, `must be valid JSON for env ${JSON.stringify(env)}`);
      assert.ok('available' in result, 'must have available field');
      assert.ok(Array.isArray(result.agents_found), 'agents_found must be array');
      assert.ok(Array.isArray(result.missing_agents), 'missing_agents must be array');
      assert.ok(typeof result.namespace === 'string', 'namespace must be string');
    }
  });
});

// ── Same-source consistency: probe-omc and enforce-backend must agree ─────────
// Both probe-omc and enforce-backend use resolveOmcPrefix() as the single source
// of truth for OMC detection. For the same fake HOME, probe-omc output (prefix/source)
// must match resolveOmcPrefix() output directly — proving no divergent detection path.
//
// Three environments: plugin-installed, bare-name-installed, not-installed.

describe('probe/enforce same-source consistency', () => {
  let consistencyTmpDir;

  before(() => {
    consistencyTmpDir = mkdtempSync(join(tmpdir(), 'probe-consistency-'));
  });

  after(() => {
    rmSync(consistencyTmpDir, { recursive: true, force: true });
  });

  test('plugin env: probe prefix/source matches resolveOmcPrefix() directly', () => {
    // Build a fake HOME with installed_plugins.json → plugin env.
    const fakeHome = join(consistencyTmpDir, 'plugin-home');
    const pluginsDir = join(fakeHome, '.claude', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'oh-my-claudecode@omc': [{ scope: 'user', installPath: '/fake/omc', version: '1.0.0' }],
        },
      })
    );

    // resolveOmcPrefix() — the same function enforce-backend calls.
    const canonical = resolveOmcPrefix({ cwd: consistencyTmpDir, home: fakeHome });
    assert.equal(canonical.source, 'plugin', 'resolveOmcPrefix must detect plugin');
    assert.equal(canonical.prefix, 'oh-my-claudecode:', 'resolveOmcPrefix prefix must be oh-my-claudecode:');

    // probe-omc — must agree on prefix and source.
    const { stdout } = runProbe({ OMC_PROBE_HOME: fakeHome, HOME: fakeHome });
    const probeResult = JSON.parse(stdout);
    assert.equal(probeResult.prefix, canonical.prefix,
      `probe prefix must match resolveOmcPrefix prefix; probe=${probeResult.prefix} canonical=${canonical.prefix}`);
    assert.equal(probeResult.source, canonical.source,
      `probe source must match resolveOmcPrefix source; probe=${probeResult.source} canonical=${canonical.source}`);
  });

  test('bare-name env: probe prefix/source matches resolveOmcPrefix() directly', () => {
    // Build a fake HOME with ≥2 OMC signal files in .claude/agents/ → bare-name env.
    const fakeHome = join(consistencyTmpDir, 'bare-home');
    const agentsDir = join(fakeHome, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'executor.md'), '# executor');
    writeFileSync(join(agentsDir, 'explore.md'), '# explore');

    // resolveOmcPrefix() — enforce-backend's source.
    const canonical = resolveOmcPrefix({ cwd: consistencyTmpDir, home: fakeHome });
    assert.equal(canonical.source, 'user-bare', 'resolveOmcPrefix must detect user-bare');
    assert.equal(canonical.prefix, '', 'resolveOmcPrefix prefix must be empty string for bare-name');

    // probe-omc — must agree.
    const { stdout } = runProbe({ OMC_PROBE_HOME: fakeHome, HOME: fakeHome });
    const probeResult = JSON.parse(stdout);
    assert.equal(probeResult.prefix, canonical.prefix,
      `probe prefix must match resolveOmcPrefix; probe="${probeResult.prefix}" canonical="${canonical.prefix}"`);
    assert.equal(probeResult.source, canonical.source,
      `probe source must match resolveOmcPrefix; probe=${probeResult.source} canonical=${canonical.source}`);
  });

  test('not-installed env: probe prefix/source matches resolveOmcPrefix() directly', () => {
    // Empty fake HOME — OMC not installed.
    const fakeHome = join(consistencyTmpDir, 'empty-home');
    mkdirSync(fakeHome, { recursive: true });

    // resolveOmcPrefix() — enforce-backend's source.
    const canonical = resolveOmcPrefix({ cwd: consistencyTmpDir, home: fakeHome });
    assert.equal(canonical.source, 'not-installed', 'resolveOmcPrefix must detect not-installed');
    assert.equal(canonical.prefix, null, 'resolveOmcPrefix prefix must be null when not installed');

    // probe-omc — must agree.
    const { stdout } = runProbe({ OMC_PROBE_HOME: fakeHome, HOME: fakeHome });
    const probeResult = JSON.parse(stdout);
    assert.equal(probeResult.prefix, canonical.prefix,
      `probe prefix must match resolveOmcPrefix; probe=${probeResult.prefix} canonical=${canonical.prefix}`);
    assert.equal(probeResult.source, canonical.source,
      `probe source must match resolveOmcPrefix; probe=${probeResult.source} canonical=${canonical.source}`);
    assert.equal(probeResult.available, false, 'probe must report available=false when not installed');
  });
});
