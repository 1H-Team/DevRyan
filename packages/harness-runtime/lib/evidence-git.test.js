import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createEvidenceGitRuntime } from './evidence-git.js';
import { parseEvidenceNumstat } from './evidence-runtime.js';

const exec = promisify(execFile);
const temporaryDirectories = [];

const git = async (directory, args) => (
  (await exec('git', args, { cwd: directory, encoding: 'utf8' })).stdout.trim()
);

const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-evidence-'));
  temporaryDirectories.push(directory);
  await git(directory, ['init']);
  await git(directory, ['config', 'user.name', 'Fixture']);
  await git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(directory, 'tracked.txt'), 'before\n');
  await fs.writeFile(path.join(directory, '.gitignore'), 'ignored.txt\n.harness/\n');
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'initial']);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('Git turn evidence', () => {
  test('captures tracked and non-ignored untracked changes without touching index, HEAD, or status', async () => {
    const directory = await fixture();
    const harness = path.join(directory, '.harness');
    const runtime = createEvidenceGitRuntime({ directory: harness });
    await fs.writeFile(path.join(directory, 'tracked.txt'), 'dirty before\n');
    await fs.writeFile(path.join(directory, 'untracked.txt'), 'new\n');
    await fs.writeFile(path.join(directory, 'ignored.txt'), 'ignored\n');
    const statusBefore = await git(directory, ['status', '--porcelain=v1', '--untracked-files=all']);
    const headBefore = await git(directory, ['rev-parse', 'HEAD']);

    const before = await runtime.captureBefore({
      directory,
      sessionID: 'ses_1',
      turnID: 'turn_1',
    });
    await fs.writeFile(path.join(directory, 'tracked.txt'), 'after\n');
    const after = await runtime.captureAfter({
      directory,
      sessionID: 'ses_1',
      turnID: 'turn_1',
      beforeCommit: before.commit,
    });

    expect(await git(directory, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(statusBefore);
    expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await runtime.diffFile({
      directory,
      beforeCommit: before.commit,
      afterCommit: after.commit,
      file: 'tracked.txt',
    })).toContain('+after');
    expect(await git(directory, ['ls-tree', '-r', '--name-only', before.commit])).not.toContain('ignored.txt');
  }, 15_000);

  test('reports renames, binary files, symlinks, and staged plus unstaged state', async () => {
    const directory = await fixture();
    const runtime = createEvidenceGitRuntime({ directory: path.join(directory, '.harness') });
    await fs.writeFile(path.join(directory, 'tracked.txt'), 'staged\n');
    await git(directory, ['add', 'tracked.txt']);
    await fs.writeFile(path.join(directory, 'tracked.txt'), 'staged and unstaged\n');
    const beforeStatus = await git(directory, ['status', '--porcelain=v1', '--untracked-files=all']);
    const before = await runtime.captureBefore({
      directory,
      sessionID: 'ses_matrix',
      turnID: 'turn_matrix',
    });
    expect(await git(directory, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(beforeStatus);

    await fs.rename(path.join(directory, 'tracked.txt'), path.join(directory, 'renamed.txt'));
    await fs.writeFile(path.join(directory, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]));
    await fs.symlink('renamed.txt', path.join(directory, 'linked.txt'));
    await fs.writeFile(path.join(directory, 'ignored.txt'), 'still ignored\n');
    const afterStatus = await git(directory, ['status', '--porcelain=v1', '--untracked-files=all']);
    const after = await runtime.captureAfter({
      directory,
      sessionID: 'ses_matrix',
      turnID: 'turn_matrix',
      beforeCommit: before.commit,
    });
    expect(await git(directory, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(afterStatus);

    const files = parseEvidenceNumstat(await runtime.diffSummary({
      directory,
      beforeCommit: before.commit,
      afterCommit: after.commit,
    }));
    expect(files).toContainEqual(expect.objectContaining({
      path: 'renamed.txt',
      oldPath: 'tracked.txt',
      changeType: 'renamed',
    }));
    expect(files).toContainEqual(expect.objectContaining({
      path: 'binary.bin',
      binary: true,
    }));
    expect(files).toContainEqual(expect.objectContaining({ path: 'linked.txt' }));
    expect(files.some((file) => file.path === 'ignored.txt')).toBe(false);
    expect(await runtime.diffFile({
      directory,
      beforeCommit: before.commit,
      afterCommit: after.commit,
      file: 'renamed.txt',
      beforeFile: 'tracked.txt',
    })).toContain('rename from tracked.txt');
    expect(await runtime.fileMetadata({
      directory,
      beforeCommit: before.commit,
      afterCommit: after.commit,
      file: 'renamed.txt',
      beforeFile: 'tracked.txt',
    })).toMatchObject({
      beforeSize: Buffer.byteLength('staged and unstaged\n'),
      afterSize: Buffer.byteLength('staged and unstaged\n'),
    });
  }, 15_000);

  test('supports unborn repositories and a user commit during the captured interval', async () => {
    const unbornDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-evidence-unborn-'));
    temporaryDirectories.push(unbornDirectory);
    await git(unbornDirectory, ['init']);
    await git(unbornDirectory, ['config', 'user.name', 'Fixture']);
    await git(unbornDirectory, ['config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(path.join(unbornDirectory, 'new.txt'), 'before\n');
    const unbornRuntime = createEvidenceGitRuntime({
      directory: path.join(unbornDirectory, '.harness'),
    });
    const unbornBefore = await unbornRuntime.captureBefore({
      directory: unbornDirectory,
      sessionID: 'ses_unborn',
      turnID: 'turn_unborn',
    });
    expect(unbornBefore.head).toBeNull();
    await fs.writeFile(path.join(unbornDirectory, 'new.txt'), 'after\n');
    const unbornAfter = await unbornRuntime.captureAfter({
      directory: unbornDirectory,
      sessionID: 'ses_unborn',
      turnID: 'turn_unborn',
      beforeCommit: unbornBefore.commit,
    });
    expect(await unbornRuntime.diffFile({
      directory: unbornDirectory,
      beforeCommit: unbornBefore.commit,
      afterCommit: unbornAfter.commit,
      file: 'new.txt',
    })).toContain('+after');

    const directory = await fixture();
    const runtime = createEvidenceGitRuntime({ directory: path.join(directory, '.harness') });
    const before = await runtime.captureBefore({
      directory,
      sessionID: 'ses_commit',
      turnID: 'turn_commit',
    });
    await fs.writeFile(path.join(directory, 'tracked.txt'), 'committed mid-turn\n');
    await git(directory, ['add', 'tracked.txt']);
    await git(directory, ['commit', '-m', 'mid-turn']);
    await fs.writeFile(path.join(directory, 'tracked.txt'), 'final dirty state\n');
    const headBeforeAfterCapture = await git(directory, ['rev-parse', 'HEAD']);
    const statusBeforeAfterCapture = await git(directory, ['status', '--porcelain=v1', '--untracked-files=all']);
    const after = await runtime.captureAfter({
      directory,
      sessionID: 'ses_commit',
      turnID: 'turn_commit',
      beforeCommit: before.commit,
    });
    expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(headBeforeAfterCapture);
    expect(await git(directory, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(statusBeforeAfterCapture);
    expect(await runtime.diffFile({
      directory,
      beforeCommit: before.commit,
      afterCommit: after.commit,
      file: 'tracked.txt',
    })).toContain('+final dirty state');
  }, 15_000);

  test('reuses a clean unchanged tree for the after checkpoint', async () => {
    const directory = await fixture();
    const runtime = createEvidenceGitRuntime({ directory: path.join(directory, '.harness') });
    const statusBefore = await git(directory, ['status', '--porcelain=v1', '--untracked-files=all']);
    const before = await runtime.captureBefore({
      directory,
      sessionID: 'ses_clean',
      turnID: 'turn_clean',
    });
    const after = await runtime.captureAfter({
      directory,
      sessionID: 'ses_clean',
      turnID: 'turn_clean',
      beforeCommit: before.commit,
      beforeTree: before.tree,
      beforeHead: before.head,
    });

    expect(after.reusedTree).toBe(true);
    expect(after.tree).toBe(before.tree);
    expect(after.parent).toBe(before.commit);
    expect(await runtime.diffSummary({
      directory,
      beforeCommit: before.commit,
      afterCommit: after.commit,
    })).toBe('');
    expect(await git(directory, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(statusBefore);
  }, 15_000);
});
