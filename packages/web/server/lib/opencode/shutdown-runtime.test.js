import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const createRuntime = (server, overrides = {}) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs: 1000,
  getExitOnShutdown: () => false,
  getIsShuttingDown: () => false,
  setIsShuttingDown: vi.fn(),
  syncToHmrState: vi.fn(),
  openCodeWatcherRuntime: { stop: vi.fn() },
  sessionRuntime: { dispose: vi.fn() },
  scheduledTasksRuntime: { stop: vi.fn() },
  getHealthCheckInterval: () => null,
  clearHealthCheckInterval: vi.fn(),
  getTerminalRuntime: () => null,
  setTerminalRuntime: vi.fn(),
  getMessageStreamRuntime: () => null,
  setMessageStreamRuntime: vi.fn(),
  getBotsRuntime: () => null,
  getCursorSdkRuntime: () => null,
  shouldSkipOpenCodeStop: () => true,
  getOpenCodePort: () => null,
  getOpenCodeProcess: () => null,
  setOpenCodeProcess: vi.fn(),
  killProcessOnPort: vi.fn(),
  waitForPortRelease: vi.fn(async () => true),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  getActiveTunnelController: () => null,
  setActiveTunnelController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
  ...overrides,
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the server close timeout when the server closes first', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    vi.advanceTimersByTime(1000);

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes the Cursor SDK runtime during graceful shutdown', async () => {
    const cursorSdkRuntime = { dispose: vi.fn(async () => {}) };
    const runtime = createRuntime(null, {
      getCursorSdkRuntime: () => cursorSdkRuntime,
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(cursorSdkRuntime.dispose).toHaveBeenCalledTimes(1);
  });

  it('stops the managed orchestration owner before provider runtime teardown', async () => {
    const order = [];
    const managedOrchestrationRuntime = {
      shutdown: vi.fn(async () => { order.push('managed'); }),
    };
    const cursorSdkRuntime = {
      dispose: vi.fn(async () => { order.push('cursor'); }),
    };
    const runtime = createRuntime(null, {
      getManagedOrchestrationRuntime: () => managedOrchestrationRuntime,
      getCursorSdkRuntime: () => cursorSdkRuntime,
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(managedOrchestrationRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['managed', 'cursor']);
  });

  it('stops Production Bots before browser, provider, OpenCode, and HTTP teardown', async () => {
    const order = [];
    const server = {
      close: vi.fn((callback) => {
        order.push('server');
        callback();
      }),
    };
    const runtime = createRuntime(server, {
      getBotsRuntime: () => ({ shutdown: vi.fn(async () => { order.push('bots'); }) }),
      getBrowserLeaseRuntime: () => ({ closeAll: vi.fn(async () => { order.push('browser'); }) }),
      getManagedOrchestrationRuntime: () => ({ shutdown: vi.fn(async () => { order.push('managed'); }) }),
      getCursorSdkRuntime: () => ({ dispose: vi.fn(async () => { order.push('cursor'); }) }),
      shouldSkipOpenCodeStop: () => false,
      getOpenCodePort: () => 64251,
      getOpenCodeProcess: () => ({ close: vi.fn(async () => { order.push('opencode'); }) }),
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(order).toEqual(['bots', 'browser', 'managed', 'cursor', 'opencode', 'server']);
  });

  it('closes browser leases before managed runtime teardown', async () => {
    const order = [];
    const browserLeaseRuntime = {
      closeAll: vi.fn(async () => { order.push('browser'); }),
    };
    const managedOrchestrationRuntime = {
      shutdown: vi.fn(async () => { order.push('managed'); }),
    };
    const runtime = createRuntime(null, {
      getBrowserLeaseRuntime: () => browserLeaseRuntime,
      getManagedOrchestrationRuntime: () => managedOrchestrationRuntime,
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(browserLeaseRuntime.closeAll).toHaveBeenCalledWith('shutdown');
    expect(order).toEqual(['browser', 'managed']);
  });

  it('does not let a hung OpenCode close block server cleanup or process exit', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    const close = vi.fn(() => new Promise(() => {}));
    const server = {
      close: vi.fn((callback) => callback()),
    };
    const runtime = createRuntime(server, {
      process: { exit },
      shouldSkipOpenCodeStop: () => false,
      getOpenCodePort: () => 64251,
      getOpenCodeProcess: () => ({ close }),
    });
    let settled = false;

    void runtime.gracefulShutdown({ exitProcess: true }).then(() => {
      settled = true;
    });
    vi.advanceTimersByTime(1000);
    for (let index = 0; index < 8 && !settled; index += 1) await Promise.resolve();

    expect(settled).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(warnSpy).toHaveBeenCalledWith('OpenCode close timeout reached, continuing shutdown');
  });
});
