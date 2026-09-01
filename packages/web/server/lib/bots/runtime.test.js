import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PRODUCTION_BOTS_MIGRATION } from '../multi-user/auth-compat.js';
import { createBotsRuntime } from './runtime.js';

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
