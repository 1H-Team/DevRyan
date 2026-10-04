import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { verifyPackageBuildInputs } from './package-lanes.mjs';
import { snapshotOwnedTree } from './package-rollback-lane.mjs';
import { repositoryRoot } from './artifacts.mjs';
import { fixtureSha256 } from './migration-fixture.mjs';

const temporaryRoot = path.join(repositoryRoot, '.cache/v2-validation/tmp');
await fs.mkdir(temporaryRoot, { recursive: true });

test('qualification rejects changed source bytes even when output verification remains portable', async () => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'package-build-input-'));
  try {
    const file = path.join(root, 'linked.js'); await fs.writeFile(file, 'export const value = 1;\n');
    const manifest = { inputs: { lockSha256: fixtureSha256(await fs.readFile(path.join(repositoryRoot, 'bun.lock'))),
      buildSources: [], sourceFiles: [{ path: path.relative(repositoryRoot, file), sha256: fixtureSha256(await fs.readFile(file)) }] } };
    assert.equal((await verifyPackageBuildInputs({ manifest })).status, 'passed');
    await fs.writeFile(file, 'export const value = 2;\n');
    await assert.rejects(verifyPackageBuildInputs({ manifest }), /Compiled input changed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rollback inventory detects changed private candidate bytes without traversing symlink targets', async () => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'package-retention-'));
  try {
    const inner = path.join(root, 'candidate'); await fs.mkdir(inner);
    const target = path.join(root, 'synthetic-protected.txt'); await fs.writeFile(target, 'private sentinel');
    await fs.symlink(target, path.join(inner, 'link'));
    await fs.writeFile(path.join(inner, 'work.txt'), 'retained bytes');
    const first = await snapshotOwnedTree(inner);
    assert.deepEqual(first.find(row => row.path === 'link'), { path: 'link', link: target });
    await fs.writeFile(target, 'different external bytes');
    assert.deepEqual(await snapshotOwnedTree(inner), first);
    await fs.writeFile(path.join(inner, 'work.txt'), 'lost work');
    assert.notDeepEqual(await snapshotOwnedTree(inner), first);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
