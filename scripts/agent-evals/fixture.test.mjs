import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

import {
  allocateRunFiles,
  assertFixtureReady,
  captureFixtureManifest,
  cleanupRunFiles,
  compareFixtureManifests,
  writeRunOwnedFile,
} from './fixture.mjs';

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const makeFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-agent-eval-fixture-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'eval@example.test']);
  git(root, ['config', 'user.name', 'DevRyan Eval']);
  writeFileSync(path.join(root, 'README.md'), 'tracked\n');
  writeFileSync(path.join(root, 'src', 'existing.ts'), 'export const existing = true;\n');
  git(root, ['add', 'README.md', 'src/existing.ts']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  writeFileSync(path.join(root, 'notes.txt'), 'keep this untracked\n');
  return root;
};

describe('evaluation fixture safety', () => {
  test('captures exact tracked and untracked file manifests without file contents', () => {
    const root = makeFixture();
    const manifest = captureFixtureManifest(root);

    assert.deepEqual(manifest.tracked.map((entry) => entry.path), ['README.md', 'src/existing.ts']);
    assert.deepEqual(manifest.untracked.map((entry) => entry.path), ['notes.txt']);
    assert.match(manifest.tracked[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(manifest).includes('keep this untracked'), false);
    assert.equal(manifest.trackedDirty.length, 0);
  });

  test('aborts before allocation when any tracked state is dirty but permits captured untracked files', () => {
    const root = makeFixture();
    assert.doesNotThrow(() => assertFixtureReady(root));

    writeFileSync(path.join(root, 'README.md'), 'dirty\n');
    assert.throws(() => assertFixtureReady(root), /tracked state is dirty/i);
    assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), 'dirty\n');
  });

  test('allocates only unique src run files and refuses collisions', () => {
    const root = makeFixture();
    const files = allocateRunFiles(root, 'run-001');
    assert.equal(files.sourceRelativePath, 'src/devryan-eval-run-001.ts');
    assert.equal(files.testRelativePath, 'src/devryan-eval-run-001.test.mjs');

    writeFileSync(files.sourcePath, 'occupied\n');
    assert.throws(() => allocateRunFiles(root, 'run-001'), /already exists/i);
    assert.equal(readFileSync(files.sourcePath, 'utf8'), 'occupied\n');
  });

  test('treats a broken symlink as an existing run-file collision', () => {
    const root = makeFixture();
    const sourcePath = path.join(root, 'src', 'devryan-eval-run-broken.ts');
    symlinkSync('missing-target.ts', sourcePath);
    assert.throws(() => allocateRunFiles(root, 'run-broken'), /already exists/i);
  });

  test('rejects a literal src symlink before allocating or seeding run files', () => {
    const root = makeFixture();
    const realSrc = path.join(root, 'real-src');
    renameSync(path.join(root, 'src'), realSrc);
    symlinkSync('real-src', path.join(root, 'src'), 'dir');

    assert.throws(
      () => allocateRunFiles(root, 'run-src-link'),
      /ordinary directory|symbolic link|identity/i,
    );
    assert.equal(existsSync(path.join(realSrc, 'devryan-eval-run-src-link.ts')), false);
    assert.equal(existsSync(path.join(realSrc, 'devryan-eval-run-src-link.test.mjs')), false);
  });

  test('rejects a literal fixture-root symlink before canonicalization', () => {
    const root = makeFixture();
    const rootLink = `${root}-link`;
    symlinkSync(root, rootLink, 'dir');

    assert.throws(
      () => allocateRunFiles(rootLink, 'run-root-link'),
      /ordinary directory|symbolic link|identity/i,
    );
    assert.equal(existsSync(path.join(root, 'src', 'devryan-eval-run-root-link.ts')), false);
  });

  test('surgically deletes only registered run files and restores the exact starting manifest', () => {
    const root = makeFixture();
    const starting = assertFixtureReady(root);
    const files = allocateRunFiles(root, 'run-002');
    writeRunOwnedFile(files.sourcePath, 'export const value = 1;\n', files);
    writeRunOwnedFile(files.testPath, 'test artifact\n', files);
    writeFileSync(path.join(root, 'notes.txt'), 'keep this untracked\n');

    const cleanup = cleanupRunFiles({ fixtureRoot: root, runFiles: files, startingManifest: starting });
    assert.equal(cleanup.restored, true);
    assert.equal(cleanup.deletedOwnedFileCount, 2);
    assert.equal(existsSync(files.sourcePath), false);
    assert.equal(existsSync(files.testPath), false);
    assert.equal(readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'keep this untracked\n');
    assert.deepEqual(compareFixtureManifests(starting, captureFixtureManifest(root)), { matches: true, differences: [] });
  });

  test('never resets tracked drift or cleans unrelated untracked additions during cleanup', () => {
    const root = makeFixture();
    const starting = assertFixtureReady(root);
    const files = allocateRunFiles(root, 'run-003');
    writeRunOwnedFile(files.sourcePath, 'owned\n', files);
    writeFileSync(path.join(root, 'README.md'), 'agent changed tracked data\n');
    writeFileSync(path.join(root, 'unrelated.txt'), 'agent-created unrelated data\n');

    assert.throws(
      () => cleanupRunFiles({ fixtureRoot: root, runFiles: files, startingManifest: starting }),
      /exact starting manifest was not restored/i,
    );
    assert.equal(existsSync(files.sourcePath), false);
    assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), 'agent changed tracked data\n');
    assert.equal(readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'agent-created unrelated data\n');
  });

  test('never follows a replaced src directory when deleting run-owned paths', () => {
    const root = makeFixture();
    const starting = assertFixtureReady(root);
    const files = allocateRunFiles(root, 'run-swapped-src');
    const outside = mkdtempSync(path.join(os.tmpdir(), 'devryan-agent-eval-outside-'));
    renameSync(path.join(root, 'src'), path.join(root, 'original-src'));
    symlinkSync(outside, path.join(root, 'src'), 'dir');
    writeFileSync(files.sourcePath, 'must remain outside the fixture\n');

    assert.throws(
      () => cleanupRunFiles({ fixtureRoot: root, runFiles: files, startingManifest: starting }),
      /exact starting manifest was not restored/i,
    );
    assert.equal(
      readFileSync(path.join(outside, path.basename(files.sourcePath)), 'utf8'),
      'must remain outside the fixture\n',
    );
  });

  test('preserves foreign reserved files after an ordinary same-path src replacement', () => {
    const root = makeFixture();
    const starting = assertFixtureReady(root);
    const files = allocateRunFiles(root, 'run-replaced-src');
    writeRunOwnedFile(files.sourcePath, 'owned source\n', files);
    writeRunOwnedFile(files.testPath, 'owned test\n', files);
    renameSync(path.join(root, 'src'), path.join(root, 'original-src'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(files.sourcePath, 'foreign source\n');
    writeFileSync(files.testPath, 'foreign test\n');

    assert.throws(
      () => cleanupRunFiles({ fixtureRoot: root, runFiles: files, startingManifest: starting }),
      /exact starting manifest was not restored/i,
    );
    assert.equal(readFileSync(files.sourcePath, 'utf8'), 'foreign source\n');
    assert.equal(readFileSync(files.testPath, 'utf8'), 'foreign test\n');
  });

  test('refuses to write paths that were not allocated to the run', () => {
    const root = makeFixture();
    const files = allocateRunFiles(root, 'run-004');
    assert.throws(
      () => writeRunOwnedFile(path.join(root, 'src', 'existing.ts'), 'overwrite\n', files),
      /not owned by this evaluation run/i,
    );
    assert.equal(readFileSync(path.join(root, 'src', 'existing.ts'), 'utf8'), 'export const existing = true;\n');
  });
});
