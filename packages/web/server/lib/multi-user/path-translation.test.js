import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  publicizeValue,
  resolveAdminPassThroughPath,
  resolveAssignmentForValue,
  translateDirectoryHeaderValue,
  translateDirectoryValue,
} from './path-translation.js';

let repoRoot;
let outsideDir;
let worktreeContainer;

const makePrincipal = (role, assignments) => ({
  id: 'user-1',
  role,
  scope: 'managed',
  assignments,
});

const makeAssignment = () => ({
  projectId: 'project-1',
  label: 'Repo',
  branchName: 'main',
  publicDirectory: repoRoot,
  repositoryPath: repoRoot,
  worktreeContainerPath: worktreeContainer,
  isDefault: true,
});

beforeAll(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pt-repo-'));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt-outside-'));
  worktreeContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'pt-worktrees-'));
  await fs.mkdir(path.join(repoRoot, 'src'));
  await fs.mkdir(path.join(worktreeContainer, 'feature'));
});

afterAll(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
  await fs.rm(worktreeContainer, { recursive: true, force: true });
});

describe('translateDirectoryValue', () => {
  it('accepts the real assignment repository path', async () => {
    const principal = makePrincipal('developer', [makeAssignment()]);
    const translated = await translateDirectoryValue(principal, repoRoot);
    expect(translated).toBe(await fs.realpath(repoRoot));
  });

  it('accepts repository subpaths', async () => {
    const principal = makePrincipal('developer', [makeAssignment()]);
    const translated = await translateDirectoryValue(principal, path.join(repoRoot, 'src'));
    expect(translated).toBe(path.join(await fs.realpath(repoRoot), 'src'));
  });

  it('accepts real worktrees inside the project worktree container', async () => {
    const principal = makePrincipal('developer', [makeAssignment()]);
    const translated = await translateDirectoryValue(principal, path.join(worktreeContainer, 'feature'));
    expect(translated).toBe(path.join(await fs.realpath(worktreeContainer), 'feature'));
  });

  it('rejects a symlink that escapes a non-admin assignment root', async () => {
    const escapePath = path.join(repoRoot, 'escape');
    await fs.symlink(outsideDir, escapePath, 'dir');
    const principal = makePrincipal('developer', [makeAssignment()]);

    expect(await translateDirectoryValue(principal, escapePath)).toBeNull();
  });

  it('rejects a symlink that escapes the shared worktree container', async () => {
    const escapePath = path.join(worktreeContainer, 'escape');
    await fs.symlink(outsideDir, escapePath, 'dir');
    const principal = makePrincipal('developer', [makeAssignment()]);

    expect(await translateDirectoryValue(principal, escapePath)).toBeNull();
  });

  it('returns null for a non-admin outside every assignment', async () => {
    const principal = makePrincipal('developer', [makeAssignment()]);
    expect(await translateDirectoryValue(principal, outsideDir)).toBeNull();
  });

  it('passes through absolute host paths for admins with no matching assignment', async () => {
    const principal = makePrincipal('admin', [makeAssignment()]);
    const translated = await translateDirectoryValue(principal, outsideDir);
    expect(translated).toBe(await fs.realpath(outsideDir));
  });

  it('passes through not-yet-existing absolute paths for admins', async () => {
    const principal = makePrincipal('admin', []);
    const candidate = path.join(outsideDir, 'brand', 'new');
    const translated = await translateDirectoryValue(principal, candidate);
    expect(translated).toBe(path.join(await fs.realpath(outsideDir), 'brand', 'new'));
  });

  it('resolves assigned repository paths for admins before falling back', async () => {
    const principal = makePrincipal('admin', [makeAssignment()]);
    const translated = await translateDirectoryValue(principal, repoRoot);
    expect(translated).toBe(await fs.realpath(repoRoot));
  });

  it('falls back to admin pass-through when managed canonicalization has a non-ENOENT failure', async () => {
    const actualRealpath = fs.realpath.bind(fs);
    const realpathSpy = vi.spyOn(fs, 'realpath')
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
      .mockImplementation(actualRealpath);
    const principal = makePrincipal('admin', [makeAssignment()]);

    try {
      const translated = await translateDirectoryValue(principal, repoRoot);
      expect(translated).toBe(await actualRealpath(repoRoot));
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it('rejects relative paths even for admins', async () => {
    const principal = makePrincipal('admin', []);
    expect(await translateDirectoryValue(principal, 'relative/path')).toBeNull();
  });
});

describe('resolveAdminPassThroughPath', () => {
  it('returns null for empty or relative inputs', async () => {
    expect(await resolveAdminPassThroughPath('')).toBeNull();
    expect(await resolveAdminPassThroughPath('   ')).toBeNull();
    expect(await resolveAdminPassThroughPath('not/absolute')).toBeNull();
  });
});

describe('translateDirectoryHeaderValue', () => {
  it('accepts the OpenCode SDK encoded repository and worktree headers', async () => {
    const principal = makePrincipal('developer', [makeAssignment()]);

    await expect(translateDirectoryHeaderValue(principal, encodeURIComponent(repoRoot)))
      .resolves.toBe(await fs.realpath(repoRoot));
    await expect(translateDirectoryHeaderValue(
      principal,
      encodeURIComponent(path.join(worktreeContainer, 'feature')),
    )).resolves.toBe(path.join(await fs.realpath(worktreeContainer), 'feature'));
  });

  it('preserves raw paths containing literal percent sequences', async () => {
    const literalPercentDirectory = path.join(repoRoot, '%2Fliteral');
    await fs.mkdir(literalPercentDirectory, { recursive: true });
    const principal = makePrincipal('developer', [makeAssignment()]);

    await expect(translateDirectoryHeaderValue(principal, literalPercentDirectory))
      .resolves.toBe(await fs.realpath(literalPercentDirectory));
  });

  it('rejects malformed, outside-workspace, and encoded symlink-escape headers', async () => {
    const escapePath = path.join(repoRoot, 'encoded-escape');
    await fs.symlink(outsideDir, escapePath, 'dir');
    const principal = makePrincipal('developer', [makeAssignment()]);

    await expect(translateDirectoryHeaderValue(principal, '%E0%A4%A')).resolves.toBeNull();
    await expect(translateDirectoryHeaderValue(principal, encodeURIComponent(outsideDir))).resolves.toBeNull();
    await expect(translateDirectoryHeaderValue(principal, encodeURIComponent(escapePath))).resolves.toBeNull();
  });
});

describe('resolveAssignmentForValue', () => {
  it('matches repository and worktree-container paths', () => {
    const principal = makePrincipal('developer', [makeAssignment()]);
    expect(resolveAssignmentForValue(principal, repoRoot)).not.toBeNull();
    expect(resolveAssignmentForValue(principal, path.join(worktreeContainer, 'feature'))).not.toBeNull();
    expect(resolveAssignmentForValue(principal, outsideDir)).toBeNull();
  });

  it('ignores the worktree container when internal paths are disabled', () => {
    const principal = makePrincipal('developer', [makeAssignment()]);
    expect(resolveAssignmentForValue(principal, path.join(worktreeContainer, 'feature'), { allowInternal: false })).toBeNull();
  });
});

describe('publicizeValue', () => {
  it('keeps real repository and worktree paths unchanged', () => {
    const principal = makePrincipal('developer', [makeAssignment()]);
    expect(publicizeValue(principal, repoRoot)).toBe(repoRoot);
    expect(publicizeValue(principal, path.join(repoRoot, 'src'))).toBe(path.join(repoRoot, 'src'));
    expect(publicizeValue(principal, path.join(worktreeContainer, 'feature')))
      .toBe(path.join(worktreeContainer, 'feature'));
  });

  it('strips private containment roots from objects', () => {
    const principal = makePrincipal('developer', [makeAssignment()]);
    const result = publicizeValue(principal, {
      repositoryPath: repoRoot,
      worktreeContainerPath: worktreeContainer,
      directory: repoRoot,
    });
    expect(result).toEqual({ directory: repoRoot });
  });
});
