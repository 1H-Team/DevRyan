import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { computeIntegratePlan, integrateCommits, isIntegrateTempPath } from './integrate.js';

const execFileAsync = promisify(execFile);
const tempDirectories = [];

const git = async (cwd, ...args) => {
  const result = await execFileAsync('git', args, { cwd });
  return String(result.stdout || '').trim();
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('server-owned commit integration', () => {
  it('plans and moves the source-only commits into the target branch', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-integrate-test-'));
    tempDirectories.push(repoRoot);
    await git(repoRoot, 'init', '-b', 'main');
    await git(repoRoot, 'config', 'user.name', 'DevRyan Test');
    await git(repoRoot, 'config', 'user.email', 'devryan@example.test');
    await fs.writeFile(path.join(repoRoot, 'base.txt'), 'base\n');
    await git(repoRoot, 'add', 'base.txt');
    await git(repoRoot, 'commit', '-m', 'test: base');
    await git(repoRoot, 'checkout', '-b', 'Dev');
    await fs.writeFile(path.join(repoRoot, 'developer.txt'), 'developer\n');
    await git(repoRoot, 'add', 'developer.txt');
    await git(repoRoot, 'commit', '-m', 'test: developer change');

    const plan = await computeIntegratePlan(repoRoot, {
      sourceBranch: 'Dev',
      targetBranch: 'main',
    });
    expect(plan.commits).toHaveLength(1);

    const result = await integrateCommits(repoRoot, plan);
    expect(result).toEqual({ kind: 'success', moved: 1 });
    expect(await git(repoRoot, 'show', 'main:developer.txt')).toBe('developer');
    expect(await git(repoRoot, 'branch', '--show-current')).toBe('Dev');
  });

  it('recognizes git-integrate temp worktree paths', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-integrate-'));
    tempDirectories.push(tempDir);
    expect(isIntegrateTempPath(tempDir)).toBe(true);
    expect(isIntegrateTempPath(await fs.realpath(tempDir))).toBe(true);
    expect(isIntegrateTempPath(path.join(os.tmpdir(), 'unrelated-project'))).toBe(false);
    expect(isIntegrateTempPath('')).toBe(false);
  });
});
