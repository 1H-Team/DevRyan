import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { seedSustainedFixture, sustainedFileHashes, verifySustainedFixture } from './claude-quota-sustained.mjs';
import { fixtureGit, isolatedClaudeEnvironment } from './claude-quota-fixture.mjs';

test('the sustained fixture runs real React tests and rejects unchanged, unimplemented work', async () => {
  const root = path.resolve(import.meta.dirname, '../../.cache/qa');
  await fs.mkdir(root, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(root, 'claude-workbench-contract-'));
  try {
    await seedSustainedFixture(workspace);
    execFileSync('bun', ['test'], { cwd: workspace, timeout: 15_000, stdio: 'pipe' });
    execFileSync('bun', ['build', 'ReviewWorkbench.tsx', '--target', 'browser', '--outdir', 'build'], {
      cwd: workspace, timeout: 15_000, stdio: 'pipe' });
    assert.equal(fixtureGit(workspace, ['ls-files', '--others', '--exclude-standard']).trim(), '',
      'the exact requested build must not require changing the fixture ignore rules');
    const result = await verifySustainedFixture(workspace, { turn: 0, beforeHashes: await sustainedFileHashes(workspace) });
    assert.equal(result.checks.modelRegressionTests, true);
    assert.equal(result.checks.independentBehavior, false, 'the authored baseline has no requested filtering');
    assert.equal(result.checks.actualSourceEdits, false);
    assert.equal(result.checks.actualCssEdits, false);
    assert.equal(result.checks.actualTestEdits, false);
    assert.equal(result.passed, false);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('native CLI state is scoped outside the editable Git fixture', () => {
  const root = path.resolve(import.meta.dirname, '../../.cache/qa/claude-env-contract');
  const environment = isolatedClaudeEnvironment({ root, workspace: path.join(root, 'workspace'), config: path.join(root, 'config') }, '/fixture/claude');
  for (const key of ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    assert.ok(environment[key].startsWith(`${root}${path.sep}`));
    assert.ok(!environment[key].startsWith(`${root}/workspace/`));
  }
});
