import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import {
  createCursorSdkRuntime,
  defaultGetWorkspaceDiff,
  filterWorkspaceDiffFilesAgainstBaseline,
  MAX_UNTRACKED_FILE_BYTES,
  resetUntrackedDiffCacheForTests,
  getUntrackedDiffCacheSizeForTests,
} from './index.js';

const execGit = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve(undefined);
    else reject(new Error(stderr || `git ${args.join(' ')} failed with code ${code}`));
  });
});

const initGitRepo = async (dir) => {
  await execGit(['init'], dir);
  await execGit(['config', 'user.email', 'test@example.com'], dir);
  await execGit(['config', 'user.name', 'Test User'], dir);
};

const diffFor = (name, line) => [
  `diff --git a/${name} b/${name}`,
  'index 0000000..1111111 100644',
  `--- a/${name}`,
  `+++ b/${name}`,
  '@@ -1,1 +1,2 @@',
  ' context',
  `+${line}`,
  '',
].join('\n');

describe('filterWorkspaceDiffFilesAgainstBaseline', () => {
  test('excludes files whose diff already existed before the run', () => {
    const baseline = diffFor('math.js', 'pre-existing change');
    const current = diffFor('math.js', 'pre-existing change') + diffFor('README.md', 'new change');
    const files = filterWorkspaceDiffFilesAgainstBaseline(baseline, current);
    expect(files.map((file) => file.relativePath)).toEqual(['README.md']);
  });

  test('keeps a file edited both before and during the run', () => {
    const baseline = diffFor('math.js', 'pre-existing change');
    const current = diffFor('math.js', 'pre-existing change\n+second change');
    const files = filterWorkspaceDiffFilesAgainstBaseline(baseline, current);
    expect(files.map((file) => file.relativePath)).toEqual(['math.js']);
  });

  test('returns empty when the workspace reverts to the baseline', () => {
    const baseline = diffFor('math.js', 'pre-existing change');
    const files = filterWorkspaceDiffFilesAgainstBaseline(baseline, baseline);
    expect(files).toEqual([]);
  });

  test('returns all files when the baseline was clean', () => {
    const current = diffFor('a.js', 'one') + diffFor('b.js', 'two');
    const files = filterWorkspaceDiffFilesAgainstBaseline('', current);
    expect(files.map((file) => file.relativePath)).toEqual(['a.js', 'b.js']);
  });

  test('returns empty for an empty current diff', () => {
    expect(filterWorkspaceDiffFilesAgainstBaseline(diffFor('a.js', 'one'), '')).toEqual([]);
  });
});


describe('deleteSessionState', () => {
  test('removes the stored session state file and reports success', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-sdk-test-'));
    const runtime = createCursorSdkRuntime({ storageDir: dir, emitEvent: () => {} });
    const sessionFile = path.join(dir, `${encodeURIComponent('ses_delete_me')}.json`);
    await fs.writeFile(sessionFile, JSON.stringify({ sessionID: 'ses_delete_me', agentID: 'agent_1', records: [] }));

    expect(await runtime.deleteSessionState('ses_delete_me')).toBe(true);
    await expect(fs.stat(sessionFile)).rejects.toThrow();
    expect(await runtime.getSessionMessages('ses_delete_me')).toEqual([]);
  });

  test('returns false for blank or already-deleted sessions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-sdk-test-'));
    const runtime = createCursorSdkRuntime({ storageDir: dir, emitEvent: () => {} });
    expect(await runtime.deleteSessionState('')).toBe(false);
    expect(await runtime.deleteSessionState('ses_gone')).toBe(true);
    expect(await runtime.deleteSessionState('ses_gone')).toBe(false);
  });
});

describe('defaultGetWorkspaceDiff', () => {
  test('skips untracked files over the size cap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-sdk-diff-'));
    await initGitRepo(dir);
    await fs.writeFile(path.join(dir, 'small.txt'), 'hello');
    await fs.writeFile(path.join(dir, 'big.bin'), Buffer.alloc(MAX_UNTRACKED_FILE_BYTES + 1));
    resetUntrackedDiffCacheForTests();

    const diff = await defaultGetWorkspaceDiff(dir);

    expect(diff).toContain('small.txt');
    expect(diff).not.toContain('big.bin');
  });

  test('reuses cached untracked diffs when file metadata is unchanged', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-sdk-diff-'));
    await initGitRepo(dir);
    await fs.writeFile(path.join(dir, 'cached.txt'), 'cached content');
    resetUntrackedDiffCacheForTests();

    await defaultGetWorkspaceDiff(dir);
    expect(getUntrackedDiffCacheSizeForTests()).toBe(1);

    await defaultGetWorkspaceDiff(dir);
    expect(getUntrackedDiffCacheSizeForTests()).toBe(1);

    await fs.writeFile(path.join(dir, 'cached.txt'), 'updated content');
    await defaultGetWorkspaceDiff(dir);
    expect(getUntrackedDiffCacheSizeForTests()).toBe(2);
  });
});
