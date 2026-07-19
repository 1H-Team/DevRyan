import { describe, expect, it, vi } from 'vitest';

import { createProjectPrewarmRuntime } from './project-prewarm-runtime.js';

describe('project prewarm runtime', () => {
  it('waits for readiness and warms project directories sequentially', async () => {
    const order = [];
    const runtime = createProjectPrewarmRuntime({
      waitForOpenCodeReady: vi.fn(async () => {
        order.push('ready');
      }),
      listProjectDirectories: vi.fn(async () => ['/a', '/b', '/c']),
      warm: vi.fn(async ({ directory }) => {
        order.push(`${directory}:start`);
        await Promise.resolve();
        order.push(`${directory}:end`);
      }),
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    await runtime.run('startup');

    expect(order).toEqual([
      'ready',
      '/a:start',
      '/a:end',
      '/b:start',
      '/b:end',
      '/c:start',
      '/c:end',
    ]);
  });

  it('continues after one directory fails', async () => {
    const warmed = [];
    const logger = { log: vi.fn(), warn: vi.fn() };
    const runtime = createProjectPrewarmRuntime({
      waitForOpenCodeReady: vi.fn(async () => {}),
      listProjectDirectories: vi.fn(async () => ['/a', '/b', '/c']),
      warm: vi.fn(async ({ directory }) => {
        warmed.push(directory);
        if (directory === '/b') throw new Error('cold init failed');
      }),
      logger,
    });

    await expect(runtime.run('startup')).resolves.toBeUndefined();

    expect(warmed).toEqual(['/a', '/b', '/c']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[Prewarm] failed /b'));
  });

  it('stops before the next directory when shutdown begins', async () => {
    let abort = false;
    const warm = vi.fn(async () => {
      abort = true;
    });
    const runtime = createProjectPrewarmRuntime({
      waitForOpenCodeReady: vi.fn(async () => {}),
      listProjectDirectories: vi.fn(async () => ['/a', '/b']),
      warm,
      shouldAbort: () => abort,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    await runtime.run('startup');

    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith({ directory: '/a' });
  });

  it('supersedes an older directory loop with the newest run', async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let listed = 0;
    const started = [];
    const runtime = createProjectPrewarmRuntime({
      waitForOpenCodeReady: vi.fn(async () => {}),
      listProjectDirectories: vi.fn(async () => {
        listed += 1;
        return listed === 1 ? ['/old-a', '/old-b'] : ['/new'];
      }),
      warm: vi.fn(async ({ directory }) => {
        started.push(directory);
        if (directory === '/old-a') await firstGate;
      }),
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const first = runtime.run('startup');
    await vi.waitFor(() => expect(started).toContain('/old-a'));
    const second = runtime.run('opencode-restart');
    await vi.waitFor(() => expect(started).toContain('/new'));
    releaseFirst();
    await Promise.all([first, second]);

    expect(started).toEqual(['/old-a', '/new']);
  });

  it('bails out when OpenCode readiness fails', async () => {
    const listProjectDirectories = vi.fn(async () => ['/a']);
    const warm = vi.fn(async () => {});
    const logger = { log: vi.fn(), warn: vi.fn() };
    const runtime = createProjectPrewarmRuntime({
      waitForOpenCodeReady: vi.fn(async () => {
        throw new Error('not ready');
      }),
      listProjectDirectories,
      warm,
      logger,
    });

    await expect(runtime.run('startup')).resolves.toBeUndefined();

    expect(listProjectDirectories).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('readiness failed'));
  });
});
