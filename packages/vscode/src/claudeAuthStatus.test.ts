import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { runClaudeCodeAuthStatus } from './claudeAuthStatus';

const createChild = () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
};

describe('VS Code Claude Code auth status', () => {
  it('uses auth status JSON and strips private account metadata', async () => {
    const child = createChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
    const pending = runClaudeCodeAuthStatus({ spawnImpl, pathValue: '/tmp' });
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
    expect(spawnImpl).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], {
      env: expect.objectContaining({ PATH: '/tmp' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('returns a signed-out result without treating it as a generic exit failure', async () => {
    const child = createChild();
    const spawnImpl = (() => child) as unknown as typeof spawn;
    const pending = runClaudeCodeAuthStatus({ spawnImpl });
    child.stdout.write('{"loggedIn":false}');
    child.emit('close', 1, null);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'claude_not_authenticated',
      auth: { loggedIn: false },
    });
  });
});
