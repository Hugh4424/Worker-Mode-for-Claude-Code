import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  assert.ok(Array.isArray(result.agents_found), 'agents_found must be array');
  assert.ok(Array.isArray(result.missing_agents), 'missing_agents must be array');
  assert.ok(typeof result.namespace === 'string', 'namespace must be string');
});

test('OMC available in real env — exit 0, all 4 agents found', () => {
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
});

test('fake HOME with no OMC → available:false, exit 1', () => {
  const { stdout, exitCode } = runProbe({ HOME: '/tmp/nonexistent-home-xyz' });
  const result = JSON.parse(stdout);
  assert.equal(result.available, false, 'should not be available');
  assert.equal(exitCode, 1, 'exit code should be 1');
  assert.ok(result.message, 'should have a message explaining the failure');
  assert.equal(result.agents_found.length, 0, 'no agents found');
  assert.deepEqual(result.missing_agents, ['executor', 'debugger', 'code-reviewer', 'document-specialist']);
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
