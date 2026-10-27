import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';

import {
  parsePushResult,
  PUSH_HOOK_DETAILS_LINES,
  PUSH_HOOK_SUMMARY_MAX,
  pushHookFailureDetails,
  pushHookFailureSummary,
  scrubGitOutput,
} from './push-result.js';
import { registerGitRoutes } from './routes.js';
import { deleteRemoteBranch, push } from './service.js';

const tempDirs = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A bare remote, a working clone with `main` and `other` pushed, and a second
// clone that has already advanced `main`, so the first clone's main is behind.
const createRemoteFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'devryan-push-'));
  tempDirs.push(root);
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const other = join(root, 'other');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'branch', 'other');
  git(work, 'push', '-q', 'origin', 'other');
  git(root, 'clone', '-q', remote, other);
  git(other, 'commit', '-q', '--allow-empty', '-m', 'remote advance');
  git(other, 'push', '-q', 'origin', 'main');
  return { remote, work };
};

const installPrePushHook = async (work, body) => {
  const hooks = join(work, '.githooks');
  await mkdir(hooks);
  await writeFile(join(hooks, 'pre-push'), `#!/bin/sh\n${body}\n`);
  await chmod(join(hooks, 'pre-push'), 0o755);
  git(work, 'config', 'core.hooksPath', '.githooks');
};

beforeEach(() => {
  // Never read the user's global hooks path, signing or push settings.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'DevRyan Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.invalid');
  vi.stubEnv('GIT_COMMITTER_NAME', 'DevRyan Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.invalid');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('push results', () => {
  it('collects porcelain rejected rows instead of reporting success', () => {
    const output = [
      'To /remote.git',
      ' \trefs/heads/other:refs/heads/other\t9934e39..f51236a',
      '!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)',
      'Done',
    ].join('\n');
    expect(parsePushResult(output, '/repo')).toEqual({
      success: false,
      pushed: [{ local: 'refs/heads/other', remote: 'refs/heads/other', status: ' ', summary: '9934e39..f51236a' }],
      rejected: [{ local: 'refs/heads/main', remote: 'refs/heads/main', status: '!', summary: '[rejected] (fetch first)' }],
      repo: '/repo',
      ref: 'refs/heads/other',
    });
  });

  it('scrubs credentials and ANSI from hook output', () => {
    expect(scrubGitOutput('remote: To https://user:ghp_abcdefghijklmnop@github.com/o/r.git')).toBe('To https://***@github.com/o/r.git');
    expect(scrubGitOutput('token=abc123 password: hunter2 Authorization: Bearer abcdefghijkl')).not.toMatch(/abc123|hunter2|abcdefghijkl/);
    expect(scrubGitOutput('\u001b[32mRunning pre-push hook\u001b[0m')).toBe('Running pre-push hook');
    expect(scrubGitOutput('   ')).toBe('');
  });

  it('summarizes hook failure from the first marker and bounds details', () => {
    const log = [
      'ok',
      '✔ accepts a regression instead of failing on it (0.030625ms)',
      '✓ Error: failing is a valid test name',
      'ok 1 - FAIL is handled',
      '\u001b[31m✖ some test failed\u001b[0m',
      'checking https://bot:s3cretpass@example.invalid/repo.git',
      'error: failed to push some refs to origin',
    ].join('\n');
    expect(pushHookFailureSummary(log)).toBe('✖ some test failed');
    expect(pushHookFailureSummary('error: failed to push some refs to origin')).toBeNull();
    const long = `✖ ${'x'.repeat(400)}`;
    expect(pushHookFailureSummary(long)).toHaveLength(PUSH_HOOK_SUMMARY_MAX);
    const many = Array.from({ length: 80 }, (_, i) => `noise ${i}`).concat(['✖ boom']).join('\n');
    const details = pushHookFailureDetails(many);
    expect(details.split('\n')).toHaveLength(PUSH_HOOK_DETAILS_LINES);
    expect(details.startsWith('noise 21')).toBe(true);
    expect(details).toContain('✖ boom');
    expect(pushHookFailureDetails(log)).not.toContain('s3cretpass');
  });
});

describe('push against a real bare remote', () => {
  it('rejects a non-fast-forward push with GIT_PUSH_REJECTED', async () => {
    const { remote, work } = await createRemoteFixture();
    git(work, 'commit', '-q', '--allow-empty', '-m', 'local change');
    const before = git(remote, 'rev-parse', 'refs/heads/main');

    const failure = await push(work, {}).catch((error) => error);

    expect(failure).toMatchObject({ code: 'GIT_PUSH_REJECTED', statusCode: 409 });
    expect(failure.message).toContain('main: rejected (fetch first)');
    expect(failure.message).toContain('Use Sync');
    expect(failure.rejected).toEqual([expect.objectContaining({ remote: 'refs/heads/main', status: '!' })]);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(before);
  });

  it('reports the rejected ref of a multi-ref push while the accepted ref lands', async () => {
    const { remote, work } = await createRemoteFixture();
    git(work, 'commit', '-q', '--allow-empty', '-m', 'local change');
    git(work, 'checkout', '-q', 'other');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'other change');
    git(work, 'config', '--add', 'remote.origin.push', 'refs/heads/main:refs/heads/main');
    git(work, 'config', '--add', 'remote.origin.push', 'refs/heads/other:refs/heads/other');

    const failure = await push(work, { remote: 'origin' }).catch((error) => error);

    expect(failure).toMatchObject({ code: 'GIT_PUSH_REJECTED' });
    expect(failure.rejected.map((row) => row.remote)).toEqual(['refs/heads/main']);
    expect(failure.pushed.map((row) => row.remote)).toEqual(['refs/heads/other']);
    expect(git(remote, 'rev-parse', 'refs/heads/other')).toBe(git(work, 'rev-parse', 'refs/heads/other'));
  });

  it.each([false, true])('skips a failing pre-push hook (first publication: %s)', async (firstPublication) => {
    const { remote, work } = await createRemoteFixture();
    git(work, 'pull', '-q', '--ff-only');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'ready');
    if (firstPublication) git(work, 'checkout', '-q', '-b', 'published');
    await installPrePushHook(work, 'touch hook-ran; echo "✖ must not run"; exit 1');

    const result = await push(work, {});

    const branch = firstPublication ? 'published' : 'main';
    expect(result).toMatchObject({ success: true, rejected: [], ref: `refs/heads/${branch}` });
    expect(git(remote, 'rev-parse', `refs/heads/${branch}`)).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(`origin/${branch}`);
    await expect(access(join(work, 'hook-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Command-scoped bypass must not change terminal Git's hook behavior.
    expect(() => git(work, 'push')).toThrow();
    await expect(access(join(work, 'hook-ran'))).resolves.toBeUndefined();
  });

  it('skips the local hook when deleting a remote branch', async () => {
    const { remote, work } = await createRemoteFixture();
    await installPrePushHook(work, 'touch hook-ran; exit 1');

    await expect(deleteRemoteBranch(work, { branch: 'other' })).resolves.toEqual({ success: true });

    expect(() => git(remote, 'rev-parse', '--verify', 'refs/heads/other')).toThrow();
    await expect(access(join(work, 'hook-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a server-side hook rejection and leaves the remote unchanged', async () => {
    const { remote, work } = await createRemoteFixture();
    git(work, 'pull', '-q', '--ff-only');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'ready');
    const before = git(remote, 'rev-parse', 'refs/heads/main');
    const hook = join(remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\necho "server policy refused" >&2\nexit 1\n');
    await chmod(hook, 0o755);

    await expect(push(work)).rejects.toMatchObject({ code: 'GIT_PUSH_REJECTED',
      rejected: [expect.objectContaining({ summary: '[remote rejected] (pre-receive hook declined)' })] });
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(before);
  });

  it('reports transport errors with scrubbed details instead of claiming a pre-push hook failed', async () => {
    const { work } = await createRemoteFixture();
    const receiver = join(work, 'failed-receiver');
    await writeFile(receiver, '#!/bin/sh\necho "fatal: Authentication failed token=abcdefgh1234" >&2\necho "error: failed to push some refs" >&2\nexit 1\n');
    await chmod(receiver, 0o755);
    git(work, 'config', 'remote.origin.receivepack', receiver);

    const failure = await push(work).catch((error) => error);

    expect(failure).toMatchObject({ code: 'GIT_PUSH_FAILED', statusCode: 500 });
    expect(failure.message).toContain('Authentication failed');
    expect(failure.message).not.toContain('Pre-push hook');
    expect(failure.message).not.toContain('abcdefgh1234');
    expect(failure.details).toContain('Authentication failed token=***');
    expect(failure.details).not.toContain('abcdefgh1234');
  });

  it('pushes successfully when a pre-push hook writes noise and exits 0', async () => {
    const { remote, work } = await createRemoteFixture();
    git(work, 'pull', '-q', '--ff-only');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'ready');
    await installPrePushHook(work, 'echo "Running pre-push hook"; echo "hook done"');

    const result = await push(work, {});

    expect(result).toMatchObject({ success: true, rejected: [], ref: 'refs/heads/main' });
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(work, 'rev-parse', 'HEAD'));
  });
});

describe('push route', () => {
  const makeApp = (pushImpl, broadcastEvent) => {
    const app = express();
    app.use(express.json());
    registerGitRoutes(app, { broadcastEvent, loadGitLibraries: async () => ({ push: pushImpl }) });
    return app;
  };

  it('strips progressID from push options and emits no progress events', async () => {
    const events = [];
    const pushImpl = vi.fn(async (_directory, options) => {
      expect(options).toEqual({ remote: 'origin' });
      return { success: true, pushed: [], rejected: [], repo: '/repo', ref: null };
    });

    await request(makeApp(pushImpl, (payload) => events.push(payload))).post('/api/git/push')
      .query({ directory: '/repo' }).send({ remote: 'origin', progressID: 'push_0123456789' }).expect(200);

    expect(pushImpl.mock.calls[0][1]).toEqual({ remote: 'origin' });
    expect(pushImpl.mock.calls[0][2]).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('returns 409 with the rejected refs', async () => {
    const rejected = [{ local: 'refs/heads/main', remote: 'refs/heads/main', status: '!', summary: '[rejected] (fetch first)' }];
    const pushImpl = vi.fn(async () => { throw Object.assign(new Error('Push rejected for main'), { statusCode: 409, code: 'GIT_PUSH_REJECTED', rejected }); });
    const response = await request(makeApp(pushImpl, null)).post('/api/git/push').query({ directory: '/repo' }).send({}).expect(409);
    expect(response.body).toEqual({ error: 'Push rejected for main', code: 'GIT_PUSH_REJECTED', rejected });
  });

  it('returns 409 GIT_PUSH_HOOK_FAILED with a short message and details', async () => {
    const pushImpl = vi.fn(async () => {
      throw Object.assign(new Error('Pre-push hook failed: ✖ some test failed'), {
        statusCode: 409,
        code: 'GIT_PUSH_HOOK_FAILED',
        details: '✖ some test failed\nerror: failed to push some refs',
      });
    });
    const response = await request(makeApp(pushImpl, null)).post('/api/git/push').query({ directory: '/repo' }).send({}).expect(409);
    expect(response.body).toEqual({
      error: 'Pre-push hook failed: ✖ some test failed',
      code: 'GIT_PUSH_HOOK_FAILED',
      details: '✖ some test failed\nerror: failed to push some refs',
    });
  });
});
