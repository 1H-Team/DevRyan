import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWorkspaceBundle } from './pack-web-release.mjs';

test('published package closes private workspace dependencies without changing external ranges', () => {
  const workspaces = new Map([
    ['@local/a', { name: '@local/a', version: '1.2.3', dependencies: { '@local/b': 'workspace:*', external: '^4.0.0' } }],
    ['@local/b', { name: '@local/b', version: '1.2.3' }],
  ]);
  const source = { dependencies: { '@local/a': 'workspace:*' }, devDependencies: { tooling: 'workspace:*' } };
  const { manifest, bundled } = planWorkspaceBundle(source, workspaces);
  assert.deepEqual(manifest.dependencies, { '@local/a': '1.2.3', '@local/b': '1.2.3', external: '^4.0.0' });
  assert.deepEqual(manifest.bundledDependencies, ['@local/a', '@local/b']);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(bundled.size, 2);
  assert.equal(source.dependencies['@local/a'], 'workspace:*');
  assert.throws(() => planWorkspaceBundle({ dependencies: { '@local/missing': 'workspace:*' } }, workspaces), /Unsupported/);
  assert.throws(() => planWorkspaceBundle({ dependencies: { '@local/a': 'workspace:*', external: '^5.0.0' } }, workspaces), /Conflicting/);
});
