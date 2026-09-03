import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PRODUCTION_BOTS_MIGRATION } from '../multi-user/auth-compat.js';
import {
  BOT_SWEEP_IDLE_WINDOW_MS,
  createBotRunSweepGate,
  createBotsRuntime,
  trackBotDispatcherActivity,
} from './runtime.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const makeDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bots-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
};

describe('Production Bots runtime composition', () => {
  it('passes the Electron workspace-list callback through the server composition root', async () => {
    const serverSource = await fs.readFile(new URL('../../index.js', import.meta.url), 'utf8');
    const runtimeSource = await fs.readFile(new URL('./runtime.js', import.meta.url), 'utf8');

    expect(serverSource).toContain('listWorkspace: botRuntimeControlProvider?.listWorkspace');
    expect(runtimeSource).toContain('connectors: [createBotWorkspaceConnector({ dockerProvider })]');
    expect(runtimeSource).not.toContain('connectors: [mcpHost.connector');
  });

  it('starts the private gateway only after the control plane is healthy and shuts down idempotently', async () => {
    const dataDirectory = await makeDirectory();
    const supabase = {
      rest: vi.fn(),
      rpc: vi.fn(async (name) => (
        name === 'devryan_bot_schema_version' ? PRODUCTION_BOTS_MIGRATION : 0
      )),
      storageUpload: vi.fn(),
      storageDownload: vi.fn(),
      storageDelete: vi.fn(),
    };
    const botHost = {
      owner: 'electron',
      ensureReasoning: vi.fn(),
      ensureComputer: vi.fn(),
      inspect: vi.fn(),
      stop: vi.fn(),
      indexerRequest: vi.fn(async ({ operation }) => (
        operation === 'status' ? { state: 'ready' } : { changed: true }
      )),
      getModelCatalog: vi.fn(async () => []),
    };
    const runtime = createBotsRuntime({
      supabase,
      dataDirectory,
      botHost,
      encryption: { getKey: async () => Buffer.alloc(32, 7) },
    });

    expect(runtime.opencodeProvider).toBeNull();
    expect(runtime.gatewayHost.getAddress()).toBeNull();
    await runtime.start();

    expect(supabase.rpc).toHaveBeenCalledWith('devryan_bot_schema_version', {});
    expect(supabase.rpc).toHaveBeenCalledWith('devryan_prune_bot_audit', expect.any(Object));
    expect(supabase.rpc).toHaveBeenCalledWith('devryan_expire_bot_approvals', {
      p_computer_scope: null,
      p_now: expect.any(String),
    });
    expect(runtime.credentialVault).not.toBeNull();
    expect(runtime.modelCredentialBroker).not.toBeNull();
    expect(runtime.opencodeProvider).not.toBeNull();
    expect(runtime.memoryRuntime).not.toBeNull();
    expect(runtime.libraryRuntime).not.toBeNull();
    expect(runtime.artifactService).not.toBeNull();
    expect(botHost.indexerRequest).toHaveBeenCalledWith({ operation: 'status' });
    expect(runtime.gatewayHost.getAddress()).toMatchObject({ host: '127.0.0.1' });
    expect(() => runtime.setGatewayOperationHandler('unsafe')).toThrow(TypeError);

    await runtime.shutdown();
    await runtime.shutdown();
    expect(runtime.gatewayHost.getAddress()).toBeNull();
  });

  it('exposes an explicit starting state until the schema preflight settles', async () => {
    const dataDirectory = await makeDirectory();
    let releaseSchema;
    const schemaGate = new Promise((resolve) => { releaseSchema = resolve; });
    const supabase = {
      rest: vi.fn(),
      rpc: vi.fn(async (name) => {
        if (name === 'devryan_bot_schema_version') {
          await schemaGate;
          return PRODUCTION_BOTS_MIGRATION;
        }
        return 0;
      }),
      storageUpload: vi.fn(),
      storageDownload: vi.fn(),
      storageDelete: vi.fn(),
    };
    const runtime = createBotsRuntime({ supabase, dataDirectory });

    const startup = runtime.start();
    expect(runtime.getStartupState()).toBe('starting');
    releaseSchema();
    await startup;
    expect(runtime.getStartupState()).toBe('ready');
    await runtime.shutdown();
  });

  it('keeps every Bot subsystem unavailable when the schema marker is stale', async () => {
    const dataDirectory = await makeDirectory();
    const supabase = {
      rest: vi.fn(),
      rpc: vi.fn(async (name) => (
        name === 'devryan_bot_schema_version' ? '20260822120000' : 0
      )),
      storageUpload: vi.fn(),
      storageDownload: vi.fn(),
      storageDelete: vi.fn(),
    };
    const runtime = createBotsRuntime({
      supabase,
      dataDirectory,
      botHost: {
        owner: 'electron',
        ensureReasoning: vi.fn(),
        ensureComputer: vi.fn(),
        inspect: vi.fn(),
        stop: vi.fn(),
        indexerRequest: vi.fn(),
        getModelCatalog: vi.fn(async () => []),
      },
      encryption: { getKey: async () => Buffer.alloc(32, 7) },
    });

    await runtime.start();

    expect(runtime.getSchemaFailure()).toMatchObject({
      code: 'bot_schema_migration_required',
      requiredMigration: PRODUCTION_BOTS_MIGRATION,
    });
    expect(runtime.credentialVault).toBeNull();
    expect(runtime.gatewayHost.getAddress()).toBeNull();
    await runtime.shutdown();
  });

  it('prepares shared Bot services after Electron repairs Docker without creating per-Bot containers', async () => {
    const dataDirectory = await makeDirectory();
    const supabase = {
      rest: vi.fn(),
      rpc: vi.fn(async (name) => (
        name === 'devryan_bot_schema_version' ? PRODUCTION_BOTS_MIGRATION : 0
      )),
      storageUpload: vi.fn(),
      storageDownload: vi.fn(),
      storageDelete: vi.fn(),
    };
    let statusAttempts = 0;
    const botHost = {
      owner: 'electron',
      getStatus: vi.fn(async () => ({
        state: 'healthy',
        code: null,
        issues: [],
        canSetup: false,
        canRepair: false,
        canUpdate: false,
        canRollback: false,
      })),
      ensureReasoning: vi.fn(),
      ensureComputer: vi.fn(),
      inspect: vi.fn(),
      stop: vi.fn(),
      indexerRequest: vi.fn(async ({ operation }) => {
        if (operation === 'status') {
          statusAttempts += 1;
          if (statusAttempts === 1) {
            throw Object.assign(new Error('Docker was still starting'), {
              code: 'bot_runtime_docker_unavailable',
            });
          }
          return { state: 'ready' };
        }
        return { changed: true };
      }),
      getModelCatalog: vi.fn(async () => []),
    };
    const runtime = createBotsRuntime({
      supabase,
      dataDirectory,
      botHost,
      encryption: { getKey: async () => Buffer.alloc(32, 7) },
    });

    await runtime.start();
    expect(runtime.getExecutionFailure()).toMatchObject({
      code: 'bot_runtime_docker_unavailable',
    });
    expect(runtime.dispatcher).toBeNull();

    const ensureRuntime = vi.fn(async () => ({ state: 'healthy' }));
    const startupStatus = vi.fn();
    const prepared = await runtime.prepareStartup({
      ensureRuntime,
      onStatus: startupStatus,
    });

    expect(prepared).toMatchObject({
      state: 'ready',
      capabilities: { available: true, state: 'healthy' },
    });
    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(startupStatus.mock.calls.map(([message]) => message)).toEqual([
      'Warming Bot services…',
      'Loading the Bot model catalog…',
    ]);
    expect(runtime.getExecutionFailure()).toBeNull();
    expect(runtime.dispatcher).not.toBeNull();
    expect(statusAttempts).toBeGreaterThanOrEqual(2);
    expect(botHost.getModelCatalog).toHaveBeenCalledTimes(1);
    expect(botHost.ensureReasoning).not.toHaveBeenCalled();
    expect(botHost.ensureComputer).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('skips Electron runtime preparation when Production Bots are not configured', async () => {
    const dataDirectory = await makeDirectory();
    const ensureRuntime = vi.fn();
    const runtime = createBotsRuntime({ dataDirectory });

    await expect(runtime.prepareStartup({ ensureRuntime })).resolves.toEqual({
      state: 'skipped',
      reason: 'bots_unavailable',
    });
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it('returns a typed sanitized startup failure', async () => {
    const dataDirectory = await makeDirectory();
    const runtime = createBotsRuntime({
      dataDirectory,
      supabase: { rest: vi.fn(), rpc: vi.fn() },
    });

    await expect(runtime.prepareStartup({
      ensureRuntime: vi.fn(async () => {
        throw Object.assign(new Error('credential=/private/secret'), {
          code: 'bot_runtime_docker_unavailable',
        });
      }),
    })).resolves.toEqual({
      state: 'failed',
      code: 'bot_runtime_docker_unavailable',
      message: 'Docker is installed but is not running or cannot be reached.',
    });
  });

  it('preserves the installation-state startup failure classification', async () => {
    const dataDirectory = await makeDirectory();
    const runtime = createBotsRuntime({
      dataDirectory,
      supabase: { rest: vi.fn(), rpc: vi.fn() },
    });

    await expect(runtime.prepareStartup({
      ensureRuntime: vi.fn(async () => {
        throw Object.assign(new Error('outdated local state'), {
          code: 'bot_runtime_state_invalid',
        });
      }),
    })).resolves.toEqual({
      state: 'failed',
      code: 'bot_runtime_state_invalid',
      message: 'The private Bot runtime installation state is outdated or invalid. Run Setup to reinstall it.',
    });
  });
});

describe('Production Bots run sweep idle gate', () => {
  const HOUR = 60 * 60 * 1000;
  const createClock = (start = Date.UTC(2026, 8, 3, 12)) => {
    let at = start;
    return {
      now: () => at,
      advance(ms) { at += ms; },
    };
  };
  const createSweep = () => vi.fn(async () => ({ queuedScopeKeys: ['scope-a'] }));

  it('rejects invalid configuration and non-function sweeps', async () => {
    expect(() => createBotRunSweepGate({ idleWindowMs: -1 })).toThrow(TypeError);
    expect(() => createBotRunSweepGate({ isExecuting: null })).toThrow(TypeError);
    await expect(createBotRunSweepGate().sweep(null)).rejects.toThrow(TypeError);
  });

  it('always runs the first sweep after start, even when already idle', async () => {
    const clock = createClock();
    const gate = createBotRunSweepGate({ now: clock.now });
    clock.advance(BOT_SWEEP_IDLE_WINDOW_MS * 2);
    const sweep = createSweep();

    await expect(gate.sweep(sweep)).resolves.toEqual({ queuedScopeKeys: ['scope-a'] });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(gate.diagnostics()).toEqual({
      idle: false,
      liveRunCount: 0,
      lastActivityAt: new Date(clock.now() - BOT_SWEEP_IDLE_WINDOW_MS * 2).toISOString(),
      lastSweepAt: new Date(clock.now()).toISOString(),
      lastSweepSkipped: false,
      idleWindowMs: BOT_SWEEP_IDLE_WINDOW_MS,
    });
  });

  it('skips the sweep after six idle hours, logs the transition once, and resumes on activity', async () => {
    const clock = createClock();
    const logger = { debug: vi.fn() };
    const gate = createBotRunSweepGate({ now: clock.now, logger });
    const sweep = createSweep();

    await gate.sweep(sweep);
    clock.advance(5 * HOUR);
    await gate.sweep(sweep);
    expect(sweep).toHaveBeenCalledTimes(2);

    clock.advance(HOUR);
    await expect(gate.sweep(sweep)).resolves.toBeNull();
    await expect(gate.sweep(sweep)).resolves.toBeNull();
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(gate.diagnostics()).toMatchObject({ idle: true, lastSweepSkipped: true, liveRunCount: 0 });
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith('[Bots] run sweep paused while idle', expect.objectContaining({
      job: 'run_sweep',
      idleWindowMs: BOT_SWEEP_IDLE_WINDOW_MS,
    }));

    gate.noteActivity();
    await expect(gate.sweep(sweep)).resolves.toEqual({ queuedScopeKeys: ['scope-a'] });
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(gate.diagnostics()).toMatchObject({ idle: false, lastSweepSkipped: false });
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenLastCalledWith('[Bots] run sweep resumed', expect.any(Object));
  });

  it('keeps sweeping while a run this process started is still executing', async () => {
    const clock = createClock();
    const executing = new Set(['run-1']);
    const gate = createBotRunSweepGate({ now: clock.now, isExecuting: (runId) => executing.has(runId) });
    const sweep = createSweep();

    await gate.sweep(sweep);
    gate.noteRunStarted('run-1');
    clock.advance(7 * HOUR);
    await expect(gate.sweep(sweep)).resolves.not.toBeNull();
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(gate.diagnostics().liveRunCount).toBe(1);

    executing.clear();
    await expect(gate.sweep(sweep)).resolves.toBeNull();
    expect(gate.diagnostics().liveRunCount).toBe(0);
  });

  it('forgets a settled run and treats start/settle as activity', async () => {
    const clock = createClock();
    const gate = createBotRunSweepGate({ now: clock.now });
    const sweep = createSweep();

    await gate.sweep(sweep);
    clock.advance(7 * HOUR);
    gate.noteRunStarted('run-2');
    expect(gate.diagnostics().liveRunCount).toBe(1);
    gate.noteRunSettled('run-2');
    expect(gate.diagnostics().liveRunCount).toBe(0);
    await expect(gate.sweep(sweep)).resolves.not.toBeNull();

    clock.advance(BOT_SWEEP_IDLE_WINDOW_MS);
    await expect(gate.sweep(sweep)).resolves.toBeNull();
  });

  it('counts dispatcher enqueue/drain calls as activity and forwards accessors', async () => {
    const noteActivity = vi.fn();
    let pending = 3;
    const dispatcher = Object.freeze({
      enqueueMessage: vi.fn(async (input) => ({ run: { id: 'run-1', input } })),
      drainScope: vi.fn((key) => `drained:${key}`),
      isExecuting: vi.fn(() => true),
      async shutdown() { return 'closed'; },
      get pendingTerminalSettlementCount() { return pending; },
    });

    const tracked = trackBotDispatcherActivity(dispatcher, noteActivity);
    expect(Object.isFrozen(tracked)).toBe(true);
    expect(tracked.drainScope('scope-a')).toBe('drained:scope-a');
    expect(noteActivity).toHaveBeenCalledTimes(1);
    expect(tracked.isExecuting('run-1')).toBe(true);
    expect(noteActivity).toHaveBeenCalledTimes(1);
    expect(tracked.pendingTerminalSettlementCount).toBe(3);
    pending = 0;
    expect(tracked.pendingTerminalSettlementCount).toBe(0);
    expect(tracked.shutdown).toBe(dispatcher.shutdown);
    await expect(tracked.enqueueMessage({ channelId: 'c' })).resolves.toMatchObject({ run: { id: 'run-1' } });
    expect(dispatcher.enqueueMessage).toHaveBeenCalledWith({ channelId: 'c' });
    expect(noteActivity).toHaveBeenCalledTimes(2);
    expect(() => trackBotDispatcherActivity(null, noteActivity)).toThrow(TypeError);
  });

  it('exposes sweep diagnostics and shares one Docker status probe across capability reads', async () => {
    const dataDirectory = await makeDirectory();
    const supabase = {
      rest: vi.fn(),
      rpc: vi.fn(async (name) => (
        name === 'devryan_bot_schema_version' ? PRODUCTION_BOTS_MIGRATION : 0
      )),
      storageUpload: vi.fn(),
      storageDownload: vi.fn(),
      storageDelete: vi.fn(),
    };
    const botHost = {
      owner: 'electron',
      ensureReasoning: vi.fn(),
      ensureComputer: vi.fn(),
      inspect: vi.fn(),
      stop: vi.fn(),
      indexerRequest: vi.fn(async ({ operation }) => (
        operation === 'status' ? { state: 'ready' } : { changed: true }
      )),
      getModelCatalog: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ state: 'healthy', code: null, issues: [], warnings: [] })),
    };
    const runtime = createBotsRuntime({
      supabase,
      dataDirectory,
      botHost,
      encryption: { getKey: async () => Buffer.alloc(32, 7) },
    });

    expect(runtime.getSweepDiagnostics()).toEqual({
      idle: false,
      liveRunCount: 0,
      lastActivityAt: null,
      lastSweepAt: null,
      lastSweepSkipped: false,
      idleWindowMs: BOT_SWEEP_IDLE_WINDOW_MS,
    });
    await runtime.start();
    try {
      expect(runtime.getSweepDiagnostics()).toMatchObject({
        idle: false,
        liveRunCount: 0,
        lastSweepAt: null,
        lastSweepSkipped: false,
      });
      expect(typeof runtime.getSweepDiagnostics().lastActivityAt).toBe('string');
      expect(typeof runtime.dispatcher?.enqueueMessage).toBe('function');
      expect(typeof runtime.dispatcher?.drainScope).toBe('function');
      expect(typeof runtime.dispatcher?.isExecuting).toBe('function');
      expect(typeof runtime.dispatcher?.pendingTerminalSettlementCount).toBe('number');

      const handlers = new Map();
      const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [
        method,
        (route, ...routeHandlers) => {
          handlers.set(`${method.toUpperCase()} ${route}`, routeHandlers.at(-1));
        },
      ]));
      app.use = () => {};
      runtime.registerRoutes(app);
      const read = async (query = {}) => {
        const response = {
          statusCode: 200,
          payload: null,
          status(code) { this.statusCode = code; return this; },
          json(payload) { this.payload = payload; return this; },
        };
        await handlers.get('GET /api/bots/capabilities')({
          body: {},
          params: {},
          headers: {},
          query,
          principal: { id: 'a0000000-0000-4000-8000-000000000001', role: 'admin', scope: 'managed' },
        }, response);
        return response.payload;
      };

      expect(await read({ refresh: '1' })).toMatchObject({ state: 'healthy', available: true });
      const probes = botHost.getStatus.mock.calls.length;
      expect(await read()).toMatchObject({ state: 'healthy', available: true });
      expect(await read()).toMatchObject({ state: 'healthy', available: true });
      expect(botHost.getStatus.mock.calls.length).toBe(probes);
      await read({ refresh: '1' });
      expect(botHost.getStatus.mock.calls.length).toBe(probes + 1);
      await runtime.reconcileExecution();
      expect(botHost.getStatus.mock.calls.length).toBe(probes + 2);
    } finally {
      await runtime.shutdown();
    }
    expect(runtime.getSweepDiagnostics().lastActivityAt).toBeNull();
  });
});
