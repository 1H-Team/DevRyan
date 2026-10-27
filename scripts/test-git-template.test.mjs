import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { initGitRepository } from './test-git-template.mjs';

test('template copies are independent, working repositories', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-git-template-test-'));
  try {
    const [first, second] = await Promise.all(['one', 'two'].map((name) => initGitRepository(path.join(root, name))));
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
    assert.equal(git(first, 'rev-parse', '--show-toplevel'), execFileSync('realpath', [first], { encoding: 'utf8' }).trim());
    writeFileSync(path.join(first, 'a.txt'), 'a\n');
    git(first, 'add', 'a.txt');
    git(first, 'commit', '--quiet', '-m', 'a');
    assert.equal(git(first, 'rev-list', '--count', 'HEAD'), '1');
    assert.throws(() => git(second, 'rev-parse', 'HEAD'));
    assert.equal(git(second, 'status', '--porcelain'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
