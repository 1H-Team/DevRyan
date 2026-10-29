import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { git, gitFailure } from './session-changes-git.js';

let base, gitDir;
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-changes-git-')));
  gitDir = path.join(base, 'store.git');
  await git(base, ['init', '--bare', '--quiet', gitDir]);
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

const failureOf = (args, options) => git(base, ['--git-dir', gitDir, ...args], options).then(() => null, (cause) => cause);

test('a failed Git step names its subcommand and a bounded failure class, never a path or stderr', async () => {
  const exit = await failureOf(['rev-parse', '--verify', '--quiet', 'refs/devryan/absent']);
  expect(exit).toMatchObject({ code: 'capture_git_failed', command: 'rev-parse', failure: 'exit_1' });
  const blob = (await git(base, ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], { input: 'x' })).toString().trim();
  await fs.writeFile(path.join(gitDir, 'refs', 'state.lock'), '');
  const lock = await failureOf(['update-ref', 'refs/state', blob]);
  expect(lock).toMatchObject({ code: 'capture_git_failed', command: 'update-ref', failure: 'lock' });
  await fs.rm(path.join(gitDir, 'refs', 'state.lock'));
  // A reachable object that cannot be read.
  await git(base, ['--git-dir', gitDir, 'update-ref', 'refs/state', blob]);
  const file = path.join(gitDir, 'objects', blob.slice(0, 2), blob.slice(2));
  await fs.chmod(file, 0o600); await fs.writeFile(file, 'corrupted');
  const corrupt = await failureOf(['repack', '-d', '-q']);
  expect(corrupt).toMatchObject({ code: 'capture_git_failed', command: 'repack', failure: 'corrupt' });
  const timeout = await failureOf(['-c', 'core.bare=true', 'hash-object', '--stdin'], { input: new Readable({ read() {} }), timeoutMs: 50 });
  expect(timeout).toMatchObject({ code: 'capture_timeout', command: 'hash-object', failure: 'timeout' });
  for (const error of [exit, lock, corrupt, timeout]) {
    expect(error.message).toBe(error.code);
    expect(gitFailure(error)).toEqual({ command: error.command, failure: error.failure });
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(base);
  }
  expect(gitFailure(new Error('other'))).toEqual({});
});
