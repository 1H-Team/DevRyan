import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getOpenCodeDataDirectory,
  resolveActiveProjectWorktreeContainer,
} from './worktree-permissions.js';

const roots = [];

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-worktree-permissions-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('active-project OpenCode worktree permissions', () => {
  it('resolves a main checkout from its Git OpenCode project metadata', () => {
    const root = makeRoot();
    const repository = path.join(root, 'repository');
    const workingDirectory = path.join(repository, 'packages', 'app');
    const openCodeDataDirectory = path.join(root, 'xdg', 'opencode');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(workingDirectory, { recursive: true });
    fs.writeFileSync(path.join(repository, '.git', 'opencode'), 'project-one\n', 'utf8');

    expect(resolveActiveProjectWorktreeContainer(workingDirectory, { openCodeDataDirectory }))
      .toBe(path.join(openCodeDataDirectory, 'worktree', 'project-one'));
  });

  it('resolves a linked checkout through its common Git directory', () => {
    const root = makeRoot();
    const repository = path.join(root, 'repository');
    const linkedCheckout = path.join(root, 'linked-checkout');
    const linkedGitDirectory = path.join(repository, '.git', 'worktrees', 'linked-checkout');
    const openCodeDataDirectory = path.join(root, 'xdg', 'opencode');
    fs.mkdirSync(linkedGitDirectory, { recursive: true });
    fs.mkdirSync(linkedCheckout, { recursive: true });
    fs.writeFileSync(path.join(linkedCheckout, '.git'), `gitdir: ${linkedGitDirectory}\n`, 'utf8');
    fs.writeFileSync(path.join(linkedGitDirectory, 'commondir'), '../..\n', 'utf8');
    fs.writeFileSync(path.join(repository, '.git', 'opencode'), 'project-one\n', 'utf8');

    expect(resolveActiveProjectWorktreeContainer(linkedCheckout, { openCodeDataDirectory }))
      .toBe(path.join(openCodeDataDirectory, 'worktree', 'project-one'));
  });

  it('derives the project container directly from an active OpenCode worktree path', () => {
    const root = makeRoot();
    const openCodeDataDirectory = path.join(root, 'xdg', 'opencode');
    const activeWorktree = path.join(openCodeDataDirectory, 'worktree', 'project-one', 'feature', 'src');
    fs.mkdirSync(activeWorktree, { recursive: true });

    expect(resolveActiveProjectWorktreeContainer(activeWorktree, { openCodeDataDirectory }))
      .toBe(path.join(openCodeDataDirectory, 'worktree', 'project-one'));
  });

  it('uses XDG_DATA_HOME with a home fallback and rejects unsafe or missing identities', () => {
    const root = makeRoot();
    const repository = path.join(root, 'repository');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });

    expect(getOpenCodeDataDirectory({ env: { XDG_DATA_HOME: path.join(root, 'xdg') }, homeDirectory: root }))
      .toBe(path.join(root, 'xdg', 'opencode'));
    expect(getOpenCodeDataDirectory({ env: {}, homeDirectory: root }))
      .toBe(path.join(root, '.local', 'share', 'opencode'));
    expect(resolveActiveProjectWorktreeContainer(repository, { openCodeDataDirectory: path.join(root, 'opencode') }))
      .toBeNull();

    fs.writeFileSync(path.join(repository, '.git', 'opencode'), '../other-project\n', 'utf8');
    expect(resolveActiveProjectWorktreeContainer(repository, { openCodeDataDirectory: path.join(root, 'opencode') }))
      .toBeNull();
  });
});
