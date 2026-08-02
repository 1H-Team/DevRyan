import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  extensions: { getExtension: vi.fn(() => undefined) },
  Uri: { file: (value: string) => ({ fsPath: value }) },
  workspace: { asRelativePath: (value: { fsPath?: string }) => value.fsPath || '' },
}));

import { checkIsGitRepository, getGitStatus } from './gitService';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('VS Code Git project directory isolation', () => {
  it('does not inherit Git status from an ancestor repository', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'devryan-vscode-git-parent-'));
    tempDirs.push(repository);
    await execFileAsync('git', ['init'], { cwd: repository });
    const nestedProject = join(repository, 'nested-project');
    await mkdir(nestedProject);

    await expect(checkIsGitRepository(repository)).resolves.toBe(true);
    await expect(checkIsGitRepository(nestedProject)).resolves.toBe(false);
    await expect(getGitStatus(nestedProject)).resolves.toEqual({
      current: '',
      tracking: null,
      ahead: 0,
      behind: 0,
      files: [],
      isClean: true,
    });
  });

  it('treats a missing project directory as non-repository state', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'devryan-vscode-git-missing-'));
    tempDirs.push(parent);
    const missing = join(parent, 'missing');

    await expect(checkIsGitRepository(missing)).resolves.toBe(false);
    await expect(getGitStatus(missing)).resolves.toMatchObject({ files: [], isClean: true });
  });
});
