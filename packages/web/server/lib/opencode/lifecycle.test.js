import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');
const { readManagedOpenCodeRegistry } = await import('./managed-process-registry.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalOpenChamberDataDir = process.env.OPENCHAMBER_DATA_DIR;
const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalSlimPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
const originalFetch = globalThis.fetch;
const tempDirs = [];

beforeEach(() => {
  const opencodeConfigDir = mkdtempSync(join(tmpdir(), 'openchamber-opencode-config-'));
  tempDirs.push(opencodeConfigDir);
  process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
});

afterEach(() => {
  spawnMock.mockReset();
  globalThis.fetch = originalFetch;
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    rmSync(tempDir, { recursive: true, force: true });
  }
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }
  if (typeof originalOpenChamberDataDir === 'string') {
    process.env.OPENCHAMBER_DATA_DIR = originalOpenChamberDataDir;
  } else {
    delete process.env.OPENCHAMBER_DATA_DIR;
  }
  if (typeof originalOpencodeConfigDir === 'string') {
    process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
  } else {
    delete process.env.OPENCODE_CONFIG_DIR;
  }
  if (typeof originalSlimPreset === 'string') {
    process.env.OH_MY_OPENCODE_SLIM_PRESET = originalSlimPreset;
  } else {
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const createRuntime = (overrides = {}) => {
  const { initialState = {}, ...dependencyOverrides } = overrides;
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    ...initialState,
  };

  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    buildWslExecArgs: vi.fn((args) => args),
    resolveWslExecutablePath: vi.fn(),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    syncPackagedAgents: vi.fn(async () => ({ changed: false, conflicts: [] })),
    syncRuntimeAgentOverlays: vi.fn(async () => ({
      changed: false,
      written: [],
      updated: [],
      removed: [],
      targetConfigDirectory: '/tmp/openchamber-runtime-overlays/default',
    })),
    ...dependencyOverrides,
  });
  runtime.__testState = state;
  return runtime;
};

describe('OpenCode lifecycle', () => {
  it('exposes the port cleanup helper required by graceful shutdown', () => {
    const runtime = createRuntime();

    expect(typeof runtime.killProcessOnPort).toBe('function');
  });

  it('launches managed OpenCode with the managed PATH', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

    await server.close();
  });

  it('registers a managed OpenCode process and unregisters it on close', async () => {
    delete process.env.OPENCODE_BINARY;
    const registryRoot = mkdtempSync(join(tmpdir(), 'openchamber-managed-registry-'));
    tempDirs.push(registryRoot);
    process.env.OPENCHAMBER_DATA_DIR = registryRoot;
    const child = createMockChild();
    child.pid = 23456;
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(readManagedOpenCodeRegistry()).toEqual([
      expect.objectContaining({
        childPid: 23456,
        ownerPid: process.pid,
        port: 45678,
        binary: 'opencode',
        hostRuntime: 'web',
      }),
    ]);

    await server.close();
    expect(readManagedOpenCodeRegistry()).toEqual([]);
  });

  it('resolves the managed OpenCode working directory from persisted settings before launch', async () => {
    delete process.env.OPENCODE_BINARY;
    const persistedDirectory = mkdtempSync(join(tmpdir(), 'openchamber-cursor-workspace-'));
    tempDirs.push(persistedDirectory);
    const child = createMockChild();
    const syncRuntimeAgentOverlays = vi.fn(async () => ({
      changed: false,
      written: [],
      updated: [],
      removed: [],
      targetConfigDirectory: '/tmp/openchamber-runtime-overlays/persisted',
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      initialState: {
        openCodeWorkingDirectory: '/Users/zoubair',
      },
      readSettingsFromDisk: vi.fn(async () => ({
        lastDirectory: persistedDirectory,
      })),
      syncRuntimeAgentOverlays,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.cwd).toBe(persistedDirectory);
    expect(syncRuntimeAgentOverlays).toHaveBeenCalledWith({
      workingDirectory: persistedDirectory,
      skillPolicy: expect.any(Object),
    });
    await server.close();
  });

  it('does not set legacy Cursor ACP bridge env vars for managed OpenCode', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.CURSOR_ACP_WORKSPACE).toBeUndefined();
    expect(options.env.OPENCODE_CURSOR_PROJECT_DIR).toBeUndefined();

    await server.close();
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');

    await server.close();
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const originalPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: undefined,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/usr/bin:/bin');
    process.env.PATH = originalPath;

    await server.close();
  });

  it('reports the binary when managed OpenCode exits before becoming ready', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.emit('exit', null, 'SIGTERM');
      });
      return secondChild;
    });

    const runtime = createRuntime();

    await expect(runtime.startOpenCode()).rejects.toThrow('OpenCode process exited before serving with signal SIGTERM. Binary used: opencode. No stdout/stderr captured');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry managed startup when the configured OpenCode binary is invalid', async () => {
    delete process.env.OPENCODE_BINARY;
    const error = new Error('Configured OpenCode binary not found: /missing/opencode');
    error.code = 'OPENCODE_BINARY_INVALID';
    const applyOpencodeBinaryFromSettings = vi.fn(async () => {
      throw error;
    });

    const runtime = createRuntime({ applyOpencodeBinaryFromSettings });

    await expect(runtime.startOpenCode()).rejects.toThrow('Configured OpenCode binary not found: /missing/opencode');
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledWith({ strict: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not start managed OpenCode when skip-start is enabled without a configured port', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('starts managed OpenCode when no explicit external env is set even if default port 4096 responds', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:4096/global/health') {
        return {
          ok: true,
          json: async () => ({ healthy: true, version: '1.0.0' }),
        };
      }
      return {
        ok: true,
        json: async () => (url.includes('/agent') ? [] : {}),
      };
    });
    spawnMock.mockImplementationOnce((_binary, args) => {
      const port = args[args.indexOf('--port') + 1];
      queueMicrotask(() => {
        child.stdout.emit('data', `opencode server listening on http://127.0.0.1:${port}\n`);
      });
      return child;
    });

    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: false,
      },
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(runtime.__testState.isExternalOpenCode).toBe(false);
    expect(runtime.__testState.openCodeProcess).toBeTruthy();

    await runtime.__testState.openCodeProcess.close();
  });

  it.each([
    {
      name: 'configured OPENCODE_PORT',
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 4096,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 4096,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: false,
      },
    },
    {
      name: 'configured OPENCODE_HOST',
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://localhost:4096', port: 4096 },
        ENV_EFFECTIVE_PORT: 4096,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: false,
      },
    },
    {
      name: 'OPENCODE_SKIP_START=true',
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
    },
  ])('attaches to an external OpenCode runtime for $name', async ({ env }) => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/global/health')) {
        return {
          ok: true,
          json: async () => ({ healthy: true, version: '1.0.0' }),
        };
      }
      return {
        ok: true,
        json: async () => (url.includes('/agent') ? [] : {}),
      };
    });

    const runtime = createRuntime({ env });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(runtime.__testState.isExternalOpenCode).toBe(true);
    expect(runtime.__testState.openCodePort).toBe(4096);
  });

  it('retries managed OpenCode startup once after a pre-ready exit', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return secondChild;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it('syncs packaged agents before spawning managed OpenCode', async () => {
    delete process.env.OPENCODE_BINARY;
    const order = [];
    const child = createMockChild();
    const syncPackagedAgents = vi.fn(async () => {
      order.push('sync');
      return { changed: false, conflicts: [] };
    });
    spawnMock.mockImplementationOnce(() => {
      order.push('spawn');
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({ syncPackagedAgents });
    const server = await runtime.startOpenCode();

    expect(order).toEqual(['sync', 'spawn']);
    expect(syncPackagedAgents).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it('syncs runtime agent overlays before spawning managed OpenCode and passes the overlay config directory', async () => {
    delete process.env.OPENCODE_BINARY;
    const order = [];
    const child = createMockChild();
    const syncRuntimeAgentOverlays = vi.fn(async () => {
      order.push('overlay');
      return {
        changed: true,
        written: ['builder'],
        updated: [],
        removed: [],
        targetConfigDirectory: '/tmp/openchamber-runtime-overlays/project-hash',
      };
    });
    spawnMock.mockImplementationOnce(() => {
      order.push('spawn');
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({ syncRuntimeAgentOverlays });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(order).toEqual(['overlay', 'spawn']);
    expect(syncRuntimeAgentOverlays).toHaveBeenCalledWith({
      workingDirectory: '/tmp/project',
      skillPolicy: expect.any(Object),
    });
    expect(options.env.OPENCODE_CONFIG_DIR).toBe('/tmp/openchamber-runtime-overlays/project-hash');
    await server.close();
  });

  it('passes the active Slim preset and background subagent flag to managed OpenCode', async () => {
    delete process.env.OPENCODE_BINARY;
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
    mkdirSync(opencodeConfigDir, { recursive: true });
    writeFileSync(
      join(opencodeConfigDir, 'opencode.json'),
      `${JSON.stringify({ plugin: ['oh-my-opencode-slim'] }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(opencodeConfigDir, 'oh-my-opencode-slim.json'),
      `${JSON.stringify({
        preset: 'openai',
        presets: {
          openai: {
            designer: { model: 'openai/gpt-5.4-mini', variant: 'medium' },
            fixer: { model: 'openai/gpt-5.5', variant: 'low' },
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const syncPackagedAgents = vi.fn(async () => ({ changed: false, conflicts: [] }));

    const runtime = createRuntime({ syncPackagedAgents });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(syncPackagedAgents).toHaveBeenCalledWith({
      agentOverrides: {},
      excludedAgentNames: expect.arrayContaining([
        'councillor',
        'designer',
        'fixer',
        'observer',
        'orchestrator',
        'plan',
      ]),
      skillPolicy: expect.any(Object),
    });
    expect(options.env.OH_MY_OPENCODE_SLIM_PRESET).toBe('openai');
    expect(options.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR).toBe(opencodeConfigDir);
    expect(options.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe('true');

    await server.close();
  });

  it('does not exclude packaged DevRyan agents for the DevRyan Slim wrapper mode', async () => {
    delete process.env.OPENCODE_BINARY;
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
    mkdirSync(opencodeConfigDir, { recursive: true });
    writeFileSync(
      join(opencodeConfigDir, 'opencode.json'),
      `${JSON.stringify({ plugin: ['./plugins/devryan-oh-my-opencode-slim.mjs'] }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(opencodeConfigDir, 'oh-my-opencode-slim.json'),
      `${JSON.stringify({
        preset: 'openai',
        presets: {
          openai: {
            orchestrator: { model: 'openai/gpt-5.5', variant: 'medium' },
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const syncPackagedAgents = vi.fn(async () => ({ changed: false, conflicts: [] }));

    const runtime = createRuntime({ syncPackagedAgents });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(syncPackagedAgents).toHaveBeenCalledWith({
      agentOverrides: {},
      excludedAgentNames: [],
      skillPolicy: expect.any(Object),
    });
    expect(options.env.OH_MY_OPENCODE_SLIM_PRESET).toBe('openai');
    expect(options.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR).toBe(opencodeConfigDir);
    expect(options.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe('true');

    await server.close();
  });

  it('keeps packaged agent sync stable and passes visible skill policy into runtime overlays', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    const syncPackagedAgents = vi.fn(async () => ({ changed: false, conflicts: [] }));
    const syncRuntimeAgentOverlays = vi.fn(async () => ({
      changed: false,
      written: [],
      updated: [],
      removed: [],
      targetConfigDirectory: '/tmp/openchamber-runtime-overlays/project-hash',
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      syncPackagedAgents,
      syncRuntimeAgentOverlays,
      readSettingsFromDisk: vi.fn(async () => ({
        hiddenSkills: [{ name: 'debugging', path: '/tmp/project/.opencode/skills/debugging/SKILL.md' }],
      })),
      sanitizeHiddenSkills: (value) => value,
      discoverSkills: vi.fn(() => [
        { name: 'frontend-design', path: '/tmp/project/.opencode/skills/frontend-design/SKILL.md' },
        { name: 'debugging', path: '/tmp/project/.opencode/skills/debugging/SKILL.md' },
      ]),
    });
    const server = await runtime.startOpenCode();

    expect(syncPackagedAgents).toHaveBeenCalledWith({
      agentOverrides: {},
      excludedAgentNames: [],
      skillPolicy: expect.objectContaining({
        skillNames: ['frontend-design'],
        skillDirectories: ['/tmp/project/.opencode/skills/frontend-design'],
      }),
    });
    expect(syncRuntimeAgentOverlays).toHaveBeenCalledWith({
      workingDirectory: '/tmp/project',
      skillPolicy: expect.objectContaining({
        skillNames: ['frontend-design'],
        skillDirectories: ['/tmp/project/.opencode/skills/frontend-design'],
      }),
    });
    await server.close();
  });

  it('starts managed OpenCode when packaged agent sync has conflicts', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    const syncPackagedAgents = vi.fn(async () => ({
      changed: false,
      conflicts: [{ name: 'builder', path: '/tmp/agents/builder.md', reason: 'user-modified' }],
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({ syncPackagedAgents });

    const server = await runtime.startOpenCode();

    expect(syncPackagedAgents).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it('restarts a reused managed OpenCode server when packaged agent sync changes files', async () => {
    delete process.env.OPENCODE_BINARY;
    const reusedProcess = { close: vi.fn(async () => {}) };
    const child = createMockChild();
    const syncPackagedAgents = vi.fn()
      .mockResolvedValueOnce({ changed: true, conflicts: [] })
      .mockResolvedValueOnce({ changed: false, conflicts: [] });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      initialState: {
        openCodeProcess: reusedProcess,
        openCodePort: 45678,
        isOpenCodeReady: true,
      },
      syncPackagedAgents,
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(reusedProcess.close).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(syncPackagedAgents).toHaveBeenCalledTimes(2);
  });
});
