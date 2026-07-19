import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { runClaudeCodeAuthStatus } from './claude-auth-status.js';

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
};

describe('Claude Code auth status', () => {
  it('uses the non-billable auth status command and exposes only safe account details', async () => {
    const child = createChild();
    const spawnImpl = vi.fn(() => child);
    const pending = runClaudeCodeAuthStatus({
      executable: '/tmp/claude',
      pathValue: '/tmp',
      spawnImpl,
    });

    child.stdout.write(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'pro',
      email: 'private@example.com',
    }));
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({
      ok: true,
      auth: {
        loggedIn: true,
        authMethod: 'claude.ai',
        subscriptionType: 'pro',
      },
    });
    expect(spawnImpl).toHaveBeenCalledWith('/tmp/claude', ['auth', 'status', '--json'], {
      env: expect.objectContaining({ PATH: '/tmp' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('distinguishes a signed-out CLI from an auth-status execution failure', async () => {
    const child = createChild();
    const pending = runClaudeCodeAuthStatus({ spawnImpl: () => child });
    child.stdout.write('{"loggedIn":false}');
    child.emit('close', 1, null);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'claude_not_authenticated',
      auth: { loggedIn: false },
    });
  });

  it('keeps stderr from a failed auth-status command', async () => {
    const child = createChild();
    const pending = runClaudeCodeAuthStatus({ spawnImpl: () => child });
    child.stderr.write('credential store unavailable');
    child.emit('close', 1, null);

    await expect(pending).resolves.toEqual({
      ok: false,
      code: 'claude_auth_status_failed',
      error: 'credential store unavailable',
    });
  });

  it('never returns malformed stdout that may contain private account fields', async () => {
    const child = createChild();
    const pending = runClaudeCodeAuthStatus({ spawnImpl: () => child });
    child.stdout.write('{"email":"private@example.com"}');
    child.emit('close', 1, null);

    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: 'claude_auth_status_failed' });
    expect(result.error).not.toContain('private@example.com');
  });

  it('returns a deterministic missing-CLI error', async () => {
    const child = createChild();
    const pending = runClaudeCodeAuthStatus({ spawnImpl: () => child });
    const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    child.emit('error', error);

    await expect(pending).resolves.toEqual({
      ok: false,
      code: 'claude_cli_unavailable',
      error: 'Claude Code was not found on PATH.',
    });
  });

  it('terminates a hung auth-status command', async () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      const pending = runClaudeCodeAuthStatus({ spawnImpl: () => child, timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: 'claude_auth_status_timeout',
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });
});
