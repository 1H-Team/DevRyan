import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, conflictedFiles, summarize } from './companion-upstream-check.mjs';

test('compares plain upstream versions only', () => {
  assert.equal(compareVersions('1.18.32', '1.18.31') > 0, true);
  assert.equal(compareVersions('v1.18.31', '1.18.31'), 0);
  assert.equal(compareVersions('1.18.31-devryan.13', '1.18.31'), null);
});

test('extracts conflicted files from git apply --check output', () => {
  const stderr = [
    'error: patch failed: packages/opencode/src/tool/registry.ts:120',
    'error: packages/opencode/src/tool/registry.ts: patch does not apply',
    'error: packages/opencode/src/session/prompt.ts: does not exist in index',
    'error: patch failed: packages/opencode/src/tool/registry.ts:240',
  ].join('\n');
  assert.deepEqual(conflictedFiles(stderr), ['packages/opencode/src/session/prompt.ts', 'packages/opencode/src/tool/registry.ts']);
});

test('summarizes when a rebuild is needed', () => {
  assert.equal(summarize({ pinned: '1.18.31', release: '1.18.31' }).status, 'current');
  assert.equal(summarize({ pinned: '1.18.31', release: '1.18.32', applies: true, conflicts: [] }).status, 'rebase-clean');
  const conflicts = summarize({ pinned: '1.18.31', release: '1.18.32', applies: false, conflicts: ['a.ts'] });
  assert.equal(conflicts.status, 'rebase-conflicts');
  assert.match(conflicts.message, /a\.ts/);
});
