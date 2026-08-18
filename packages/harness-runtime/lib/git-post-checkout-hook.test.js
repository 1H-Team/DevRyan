import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  POST_CHECKOUT_ZERO_COMMIT,
  createPostCheckoutHookRunner,
  runBoundedChildProcess,
} from './git-post-checkout-hook.js';

const makeSpawnHarness = (responses) => {
  const queue = [...responses];
  const calls = [];
  let nextPID = 4_000;
  const children = [];
  const spawnImpl = (binary, args, options) => {
    const response = queue.shift() ?? {};
    const child = new EventEmitter();
    child.pid = nextPID;
    nextPID += 1;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.unref = () => undefined;
    children.push(child);
    calls.push({ binary, args, options, child });
    queueMicrotask(() => {
      if (response.error) {
        child.emit('error', response.error);
        return;
      }
      if (response.stdout) child.stdout.write(response.stdout);
      if (response.stderr) child.stderr.write(response.stderr);
      child.stdout.end();
      child.stderr.end();
      if (!response.hang) child.emit('close', response.exitCode ?? 0, response.signal ?? null);
    });
    return child;
  };
  return { calls, children, spawnImpl };
};

describe('shared post-checkout hook runner', () => {
  test('skips a missing hook without requiring git hook run support', async () => {
    const cwd = '/tmp/worktree without hook';
    const harness = makeSpawnHarness([
      { exitCode: 1 },
      { stdout: '.git/hooks/post-checkout\n' },
    ]);
    const runner = createPostCheckoutHookRunner({
      spawnImpl: harness.spawnImpl,
      stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      now: () => 100,
    });

    await expect(runner.run(cwd)).resolves.toEqual({
      presence: false,
      exitStatus: 0,
      durationMs: 0,
    });
    expect(harness.calls.map((call) => call.args)).toEqual([
      ['config', '--path', '--get', 'core.hooksPath'],
      ['rev-parse', '--git-path', 'hooks/post-checkout'],
    ]);
  });

  test('runs a standard hook with exact checkout arguments, cwd, and one capability check', async () => {
    const cwd = '/tmp/worktree with spaces';
    const head = '1234567890abcdef1234567890abcdef12345678';
    const harness = makeSpawnHarness([
      { exitCode: 1 },
      { stdout: '.git/hooks/post-checkout\n' },
      { stdout: 'git version 2.36.0\n' },
      { stdout: `${head}\n` },
      { stdout: 'successful output is not retained\n' },
      { exitCode: 1 },
      { stdout: '.git/hooks/post-checkout\n' },
      { stdout: `${head}\n` },
      { exitCode: 0 },
    ]);
    let clock = 0;
    const runner = createPostCheckoutHookRunner({
      gitBinary: '/opt/git/bin/git',
      spawnImpl: harness.spawnImpl,
      stat: async () => ({ isFile: () => true }),
      getEnv: async () => ({ SAFE_VALUE: '1' }),
      now: () => { clock += 5; return clock; },
    });

    const first = await runner.run(cwd);
    const second = await runner.run(cwd);

    expect(first).toEqual({ presence: true, exitStatus: 0, durationMs: 5 });
    expect(second).toEqual({ presence: true, exitStatus: 0, durationMs: 5 });
    expect(harness.calls.filter((call) => call.args[0] === '--version')).toHaveLength(1);
    const hookCalls = harness.calls.filter((call) => call.args[0] === 'hook');
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[0]).toMatchObject({
      binary: '/opt/git/bin/git',
      args: [
        'hook',
        'run',
        '--ignore-missing',
        'post-checkout',
        '--',
        POST_CHECKOUT_ZERO_COMMIT,
        head,
        '1',
      ],
      options: {
        cwd,
        detached: true,
        env: { SAFE_VALUE: '1', GIT_TERMINAL_PROMPT: '0' },
      },
    });
    expect(first).not.toHaveProperty('output');
  });

  test('honors an effective global hooksPath that shadows the repository hook', async () => {
    const cwd = '/tmp/repository';
    const globalHooks = '/Users/example/.config/git/devryan-hooks';
    const harness = makeSpawnHarness([{ stdout: `${globalHooks}\n` }]);
    const seenPaths = [];
    const runner = createPostCheckoutHookRunner({
      spawnImpl: harness.spawnImpl,
      stat: async (candidate) => {
        seenPaths.push(candidate);
        throw Object.assign(new Error('only commit-msg is installed'), { code: 'ENOENT' });
      },
      now: () => 10,
    });

    await expect(runner.run(cwd)).resolves.toMatchObject({ presence: false, exitStatus: 0 });
    expect(seenPaths).toEqual([path.join(globalHooks, 'post-checkout')]);
    expect(harness.calls.map((call) => call.args)).toEqual([
      ['config', '--path', '--get', 'core.hooksPath'],
    ]);
  });

  test('fails an existing hook with an actionable minimum-version error', async () => {
    const harness = makeSpawnHarness([
      { stdout: '/hooks\n' },
      { stdout: 'git version 2.35.9\n' },
    ]);
    const runner = createPostCheckoutHookRunner({
      spawnImpl: harness.spawnImpl,
      stat: async () => ({ isFile: () => true }),
      now: () => 20,
    });

    await expect(runner.run('/tmp/repo')).rejects.toMatchObject({
      code: 'GIT_HOOK_RUN_UNSUPPORTED',
      message: expect.stringContaining('Git 2.36 or newer'),
      stageOutput: {
        presence: true,
        exitStatus: null,
      },
    });
  });

  test('hard-fails nonzero hooks with capped, sanitized receipt output', async () => {
    const cwd = '/tmp/private-worktree';
    const head = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const noisyFailure = `${cwd}\napi_key=super-secret-provider-token\n${'x'.repeat(2 * 1024 * 1024)}`;
    const harness = makeSpawnHarness([
      { stdout: '/hooks\n' },
      { stdout: 'git version 2.44.0\n' },
      { stdout: `${head}\n` },
      { stderr: noisyFailure, exitCode: 17 },
    ]);
    const runner = createPostCheckoutHookRunner({
      spawnImpl: harness.spawnImpl,
      stat: async () => ({ isFile: () => true }),
      maxOutputBytes: 1024 * 1024,
      maxFailureExcerptBytes: 512,
      now: () => 30,
    });

    let failure;
    try {
      await runner.run(cwd);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'GIT_HOOK_FAILED',
      stageOutput: {
        presence: true,
        exitStatus: 17,
      },
    });
    expect(failure.stageOutput.failureExcerpt).toContain('<WORKTREE_1>');
    expect(failure.stageOutput.failureExcerpt).toContain('[REDACTED]');
    expect(failure.stageOutput.failureExcerpt).not.toContain('super-secret-provider-token');
    expect(Buffer.byteLength(failure.stageOutput.failureExcerpt)).toBeLessThan(550);
  });

  test('terminates the process group when a hook times out', async () => {
    const head = 'fedcbafedcbafedcbafedcbafedcbafedcbafedc';
    const harness = makeSpawnHarness([
      { stdout: '/hooks\n' },
      { stdout: 'git version 2.44.0\n' },
      { stdout: `${head}\n` },
      { stderr: 'still running', hang: true },
    ]);
    const killed = [];
    const runner = createPostCheckoutHookRunner({
      spawnImpl: harness.spawnImpl,
      stat: async () => ({ isFile: () => true }),
      hookTimeoutMs: 5,
      killGraceMs: 5,
      processKill: (pid, signal) => {
        killed.push({ pid, signal });
        const child = harness.children.find((entry) => entry.pid === Math.abs(pid));
        queueMicrotask(() => child?.emit('close', null, signal));
      },
      now: () => 50,
    });

    await expect(runner.run('/tmp/repo')).rejects.toMatchObject({
      code: 'GIT_HOOK_TIMEOUT',
      stageOutput: { presence: true, exitStatus: null },
    });
    expect(killed).toContainEqual({ pid: -4003, signal: 'SIGTERM' });
  });
});

describe('bounded child capture', () => {
  test('caps combined stdout and stderr at the shared byte limit', async () => {
    const harness = makeSpawnHarness([{
      stdout: 'a'.repeat(700),
      stderr: 'b'.repeat(700),
    }]);
    const result = await runBoundedChildProcess({
      binary: 'git',
      args: ['status'],
      cwd: '/tmp',
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      spawnImpl: harness.spawnImpl,
    });
    expect(result.capturedBytes).toBe(1_024);
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBe(1_024);
  });
});
