import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

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
  getSessionTitleRuntime: () => null,
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
  it('keeps store owners alive after refused native settlement and permits a shutdown retry', async () => {
    let shuttingDown = false, settled = false;
    const order = [];
    const runtime = createRuntime(null, {
      getIsShuttingDown: () => shuttingDown, setIsShuttingDown: value => { shuttingDown = value; },
      getHarnessRuntime: () => ({ beginDrain: () => order.push('admission'), drain: async () => order.push('stores') }),
      closeNativeRuntime: async () => { order.push('native'); if (!settled) throw new Error('settlement pending'); },
      openCodeWatcherRuntime: { stop: () => order.push('watcher') },
      globalMessageStreamHub: { stop: () => order.push('shared-hub') },
    });
    await expect(runtime.gracefulShutdown({ exitProcess: false })).rejects.toThrow('settlement pending');
    expect(order).toEqual(['admission', 'native']); expect(shuttingDown).toBe(false);
    settled = true;
    await runtime.gracefulShutdown({ exitProcess: false });
    expect(order).toEqual(['admission', 'native', 'admission', 'native', 'watcher', 'shared-hub', 'stores']);
  });

  it('naturally exits after stopping the real shared hub reconnect timer', async () => {
    const moduleUrl = relative => JSON.stringify(new URL(relative, import.meta.url).href);
    const script = `
      import {createGlobalMessageStreamHub} from ${moduleUrl('../event-stream/global-hub.js')};
      import {createProjectedStreamClient} from ${moduleUrl('../event-stream/test-projected-stream.js')};
      import {createGracefulShutdownRuntime} from ${moduleUrl('./shutdown-runtime.js')};
      let unavailable;
      const firstUnavailable = new Promise(resolve => { unavailable = resolve; });
      const hub = createGlobalMessageStreamHub({openCodeClient:createProjectedStreamClient(),
        fetchImpl:async () => new Response(null,{status:503})});
      hub.subscribeStatus(status => { if(status.type==='initial-error') unavailable(); });
      hub.start();
      await firstUnavailable;
      await new Promise(resolve => setImmediate(resolve));
      let shuttingDown = false;
      const runtime = createGracefulShutdownRuntime({process,shutdownTimeoutMs:1000,getExitOnShutdown:()=>false,
        getIsShuttingDown:()=>shuttingDown,setIsShuttingDown:value=>{shuttingDown=value;},syncToHmrState:()=>{},
        openCodeWatcherRuntime:{stop(){}},globalMessageStreamHub:hub,sessionRuntime:{dispose(){}},scheduledTasksRuntime:{stop(){}},
        getHealthCheckInterval:()=>null,getTerminalRuntime:()=>null,getMessageStreamRuntime:()=>null,getBotsRuntime:()=>null,
        getCursorSdkRuntime:()=>null,getSessionTitleRuntime:()=>null,shouldSkipOpenCodeStop:()=>true,getServer:()=>null,
        getUiAuthController:()=>null,getActiveTunnelController:()=>null,tunnelAuthController:{clearActiveTunnel(){}},
      });
      await runtime.gracefulShutdown({exitProcess:false});
      console.log('shared-hub-shutdown-returned');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 3000);
    let code, signal;
    try { [code, signal] = await closed; } finally { clearTimeout(timer); }
    expect(stdout).toContain('shared-hub-shutdown-returned');
    expect(stderr).toBe('');
    expect(timedOut).toBe(false);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  });

  it('settles native ownership before store teardown and never kills a later occupant of its released port', async () => {
    const order = [], killProcessOnPort = vi.fn(), close = vi.fn();
    const runtime = createRuntime(null, {
      getHarnessRuntime: () => ({ beginDrain: () => order.push('admission'), drain: async () => order.push('stores') }),
      closeNativeRuntime: async () => { order.push('native-exit-and-recovery'); },
      getManagedOrchestrationRuntime: () => ({ shutdown: async () => order.push('scheduler') }),
      shouldSkipOpenCodeStop: () => false, getOpenCodePort: () => 12345, getOpenCodeProcess: () => ({ close }), killProcessOnPort,
    });
    await runtime.gracefulShutdown({ exitProcess: false });
    expect(order).toEqual(['admission','native-exit-and-recovery','stores','scheduler']);
    expect(close).not.toHaveBeenCalled(); expect(killProcessOnPort).not.toHaveBeenCalled();
  });

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

  it('drains preparation after Cursor and continues other shutdown paths if it rejects', async () => {
    const order = [];
    const runtime = createRuntime({ close: (done) => { order.push('http'); done(); } }, {
      getCursorSdkRuntime: () => ({ dispose: async () => { order.push('cursor'); } }),
      getSessionExecutionHost: () => ({ drain: async () => { order.push('preparation'); throw new Error('failed keeper'); } }),
      getSessionTitleRuntime: () => ({ dispose: async () => { order.push('titles'); } }),
    });
    await runtime.gracefulShutdown({ exitProcess: false });
    expect(order).toEqual(['cursor', 'preparation', 'titles', 'http']);
  });

  it('flushes the durable session title outbox during graceful shutdown', async () => {
    const sessionTitleRuntime = { dispose: vi.fn(async () => {}) };
    const runtime = createRuntime(null, {
      getSessionTitleRuntime: () => sessionTitleRuntime,
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(sessionTitleRuntime.dispose).toHaveBeenCalledTimes(1);
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
