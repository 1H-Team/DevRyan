import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
  BOT_RUNTIME_IMAGE_KEYS,
  loadBotRuntimeManifest,
  validateBotRuntimeManifest,
} from '../bot-runtime-manifest.mjs';
import {
  BOT_RUNTIME_ENGINE_MEMORY_POLICY,
  createBotRuntimeManager,
  createFileBotRuntimeStateStore,
  deriveBotRuntimeServiceEnvironment,
  evaluateBotRuntimeEngineMemory,
  resolveDockerSocketSupplementalGid,
  resolveDockerExecutable,
} from '../bot-runtime-manager.mjs';
import { BOT_RESOURCE_LIMITS } from '../../bot-supervisor/src/docker.js';

const DOCKER = '/opt/homebrew/bin/docker';
const COMPOSE = '/Applications/DevRyan.app/Contents/Resources/bot-runtime/compose.yml';
const temporaryDirectories = [];

const makeTreeWritable = async (directory) => {
  let entries;
  try {
    await fs.chmod(directory, 0o700);
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map((entry) => (
    entry.isDirectory()
      ? makeTreeWritable(path.join(directory, entry.name))
      : fs.chmod(path.join(directory, entry.name), 0o600).catch(() => undefined)
  )));
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await makeTreeWritable(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }));
});

const createTemporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
};

const releaseSourceManifest = ({ releaseId = '1.2.3', digestCharacter = 'a' } = {}) => ({
  version: 2,
  channel: 'release',
  releaseId,
  sourceRevision: '1'.repeat(40),
  openCodeVersion: '1.18.26',
  schemaVersion: '20260823150227',
  pluginHash: `sha256:${'f'.repeat(64)}`,
  images: Object.fromEntries(BOT_RUNTIME_IMAGE_KEYS.map((key) => [key, {
    name: `devryan-bot-${key}`,
    repository: `ghcr.io/1h-team/devryan-bot-${key}`,
    indexDigest: `sha256:${'9'.repeat(64)}`,
    platforms: {
      'linux/amd64': {
        digest: `sha256:${'8'.repeat(64)}`,
        sbomDigest: `sha256:${'7'.repeat(64)}`,
        provenanceDigest: `sha256:${'6'.repeat(64)}`,
      },
      'linux/arm64': {
        digest: `sha256:${digestCharacter.repeat(64)}`,
        sbomDigest: `sha256:${'5'.repeat(64)}`,
        provenanceDigest: `sha256:${'4'.repeat(64)}`,
      },
    },
  }])),
});

const releaseManifest = (options = {}) => (
  validateBotRuntimeManifest(
    releaseSourceManifest(options),
    { isPackaged: true, architecture: 'arm64' },
  )
);

const healthyServices = () => ([
  { Service: 'supervisor', State: 'running', Health: 'healthy' },
  { Service: 'engine-proxy', State: 'running', Health: 'healthy' },
  { Service: 'egress', State: 'running', Health: 'healthy' },
  { Service: 'indexer', State: 'running', Health: 'healthy' },
]);

const createMemoryStateStore = (initial = null) => {
  let value = initial;
  const writes = [];
  return {
    reads: () => value,
    writes,
    store: {
      read: async () => structuredClone(value),
      write: async (next) => {
        value = structuredClone(next);
        writes.push(structuredClone(next));
      },
    },
  };
};

const parseServiceLabel = (labels) => String(labels || '')
  .split(',')
  .map((entry) => entry.split('='))
  .find(([key]) => key === 'com.docker.compose.service')?.[1];

const createFakeRunner = ({
  dockerRunning = true,
  serviceRows = healthyServices(),
  inspectOverride = null,
  pullOverride = null,
  failComposeUp = false,
  supervisorPort = 55120,
  egressPort = 55121,
  indexerPort = 55122,
  runscDeclared = false,
  runscSmokeExitCode = 0,
  memTotalBytes = 16 * 1024 * 1024 * 1024,
  hostControlNetwork = { stale: false },
  attachedContainers = [],
} = {}) => {
  const calls = [];
  let staleNetwork = hostControlNetwork?.stale === true;
  // `docker ps --filter network=...` stops listing what has been removed, so
  // the repair can be observed converging instead of repeating.
  let attached = typeof attachedContainers === 'function' ? attachedContainers : [...attachedContainers];
  const runProcess = async (file, args, options = {}) => {
    calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
    if (args[0] === 'network' && args[1] === 'inspect') {
      if (!hostControlNetwork) {
        return { exitCode: 1, stdout: '', stderr: `Error response from daemon: network ${args[2]} not found` };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          Name: args[2],
          Options: staleNetwork ? { 'com.docker.network.bridge.enable_ip_masquerade': 'false' } : {},
        }),
        stderr: '',
      };
    }
    if (args[0] === 'network' && args[1] === 'rm') {
      staleNetwork = false;
      if (Array.isArray(attached)) attached = [];
      return { exitCode: 0, stdout: `${args[2]}\n`, stderr: '' };
    }
    if (args[0] === 'stop' || args[0] === 'rm') {
      const ids = args.filter((value) => !value.startsWith('-')).slice(1);
      if (args[0] === 'rm' && Array.isArray(attached)) {
        attached = attached.filter((row) => !ids.includes(row.ID));
      }
      return { exitCode: 0, stdout: ids.join('\n'), stderr: '' };
    }
    if (args[0] === 'ps') {
      const rows = typeof attached === 'function' ? attached() : attached;
      return { exitCode: 0, stdout: rows.map((row) => JSON.stringify(row)).join('\n'), stderr: '' };
    }
    if (args[0] === 'compose' && args.includes('rm')) {
      const services = args.slice(args.indexOf('rm') + 1).filter((value) => !value.startsWith('-'));
      if (Array.isArray(attached)) {
        attached = attached.filter((row) => !services.includes(parseServiceLabel(row.Labels)));
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'version') {
      return dockerRunning
        ? { exitCode: 0, stdout: '{"Server":{"Version":"28.0.0"}}', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    }
    if (args[0] === 'info' && args[1] === '--format' && args[2] === '{{.MemTotal}}') {
      return memTotalBytes === null
        ? { exitCode: 1, stdout: '', stderr: 'template parsing error' }
        : { exitCode: 0, stdout: `${memTotalBytes}\n`, stderr: '' };
    }
    if (args[0] === 'info' && args[1] === '--format') {
      return {
        exitCode: 0,
        stdout: JSON.stringify(runscDeclared ? { runc: {}, runsc: {} } : { runc: {} }),
        stderr: '',
      };
    }
    if (args[0] === 'run' && args.includes('--runtime') && args.includes('runsc')) {
      return {
        exitCode: runscSmokeExitCode,
        stdout: '',
        stderr: runscSmokeExitCode === 0 ? '' : 'runsc smoke failed',
      };
    }
    if (args[0] === 'pull') {
      return pullOverride
        ? pullOverride(args.at(-1))
        : { exitCode: 0, stdout: 'pulled', stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (inspectOverride) return inspectOverride(args.at(-1));
      const reference = args.at(-1);
      const digests = reference.includes('@sha256:') ? [reference] : [];
      return { exitCode: 0, stdout: JSON.stringify(digests), stderr: '' };
    }
    if (args[0] === 'compose' && args.includes('up')) {
      return failComposeUp
        ? { exitCode: 1, stdout: '', stderr: 'compose failed' }
        : { exitCode: 0, stdout: 'started', stderr: '' };
    }
    if (args[0] === 'compose' && args.includes('ps')) {
      const rows = typeof serviceRows === 'function' ? serviceRows() : serviceRows;
      return { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' };
    }
    if (args[0] === 'compose' && args.includes('port')) {
      const publishedPort = args.includes('egress')
        ? egressPort
        : args.includes('indexer')
          ? indexerPort
          : supervisorPort;
      return { exitCode: 0, stdout: `127.0.0.1:${publishedPort}\n`, stderr: '' };
    }
    throw new Error(`Unexpected Docker argv: ${args.join(' ')}`);
  };
  return { calls, runProcess };
};

const createManager = ({
  manifest = releaseManifest(),
  resolveDocker = async () => DOCKER,
  runner = createFakeRunner(),
  stateStore = createMemoryStateStore(),
  dataDirectory,
  fetchImpl,
  wait,
  now,
} = {}) => ({
  manager: createBotRuntimeManager({
    composePath: COMPOSE,
    loadManifest: async () => manifest,
    resolveDocker,
    runProcess: runner.runProcess,
    stateStore: stateStore.store,
    dataDirectory,
    baseEnvironment: { PATH: '/opt/homebrew/bin:/usr/bin' },
    loadRuntimeEnvironment: async () => deriveBotRuntimeServiceEnvironment(Buffer.alloc(32, 7), {
      dockerSocketGid: 20,
      ...(dataDirectory ? { hostRuntimeRoot: path.join(dataDirectory, 'bots', 'runtime') } : {}),
    }),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(wait ? { wait } : {}),
    ...(now ? { now } : {}),
  }),
  runner,
  stateStore,
});

const composePrefix = [
  'compose',
  '--project-name',
  'devryan-bots',
  '--file',
  COMPOSE,
];

describe('Bot runtime manifest', () => {
  test('requires an immutable architecture-matched production manifest', async () => {
    const directory = await createTemporaryDirectory();
    await expect(loadBotRuntimeManifest({
      manifestPath: path.join(directory, 'missing.json'),
      isPackaged: true,
      architecture: 'arm64',
    })).rejects.toMatchObject({ code: 'bot_runtime_manifest_required' });

    expect(() => validateBotRuntimeManifest({
      version: 2,
      channel: 'release',
      releaseId: '1.2.3',
      sourceRevision: '1'.repeat(40),
      openCodeVersion: '1.18.26',
      schemaVersion: '20260823150227',
      pluginHash: `sha256:${'f'.repeat(64)}`,
      images: {},
    }, { isPackaged: true, architecture: 's390x' })).toThrow(expect.objectContaining({
      code: 'bot_runtime_architecture_unsupported',
    }));

    const amd64Manifest = validateBotRuntimeManifest(releaseSourceManifest(), {
      isPackaged: true,
      architecture: 'x64',
    });
    expect(amd64Manifest.architecture).toBe('amd64');
    expect(amd64Manifest.images.supervisor.reference).toBe(
      `ghcr.io/1h-team/devryan-bot-supervisor@sha256:${'8'.repeat(64)}`,
    );
  });

  test('accepts only fixed local DevRyan development tags', () => {
    const manifest = validateBotRuntimeManifest({
      version: 1,
      channel: 'development',
      images: Object.fromEntries(BOT_RUNTIME_IMAGE_KEYS.map((key) => [
        key,
        { reference: `devryan/bot-${key}:dev` },
      ])),
    }, { isPackaged: false, architecture: 'x64' });

    expect(manifest.architecture).toBe('amd64');
    expect(manifest.images.supervisor.reference).toBe('devryan/bot-supervisor:dev');
    expect(manifest.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('Docker executable resolution', () => {
  test('uses Docker Desktop VM group 0 on macOS and the socket group on Linux', async () => {
    const stat = mock(async () => ({ gid: 20 }));

    await expect(resolveDockerSocketSupplementalGid({ platform: 'darwin', stat }))
      .resolves.toBe(0);
    expect(stat).not.toHaveBeenCalled();
    await expect(resolveDockerSocketSupplementalGid({ platform: 'linux', stat }))
      .resolves.toBe(20);
    await expect(resolveDockerSocketSupplementalGid({
      platform: 'linux',
      stat: mock(async () => { throw new Error('missing'); }),
    })).resolves.toBe(0);
  });

  test('uses only an executable resolved from fixed candidates or absolute PATH entries', async () => {
    const directory = await createTemporaryDirectory();
    const dockerPath = path.join(directory, 'docker');
    await fs.writeFile(dockerPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(await resolveDockerExecutable({
      platform: 'darwin',
      env: { PATH: `relative-bin:${directory}` },
      fixedCandidates: ['/missing/docker'],
    })).toBe(await fs.realpath(dockerPath));
    expect(await resolveDockerExecutable({
      platform: 'darwin',
      env: { PATH: 'relative-bin' },
      fixedCandidates: [],
    })).toBeNull();
  });

  test('derives stable purpose-separated service credentials without returning the deployment key', () => {
    const key = Buffer.alloc(32, 9);
    const environment = deriveBotRuntimeServiceEnvironment(key, { dockerSocketGid: 20 });
    expect(environment).toMatchObject({
      DEVRYAN_DOCKER_SOCKET_GID: '20',
      DEVRYAN_BOT_HOST_RUNTIME_ROOT: '/var/lib/devryan-bots/host-runtime',
    });
    expect(environment.DEVRYAN_BOT_DEPLOYMENT_ID).toMatch(/^deployment-[0-9a-f]{24}$/);
    expect(environment.DEVRYAN_BOT_SUPERVISOR_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(environment.DEVRYAN_BOT_ENGINE_PROXY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(environment.DEVRYAN_BOT_EGRESS_SIGNING_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(environment.DEVRYAN_BOT_EGRESS_CONTROL_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(environment.DEVRYAN_BOT_INDEXER_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(environment.DEVRYAN_BOT_SUPERVISOR_TOKEN)
      .not.toBe(environment.DEVRYAN_BOT_EGRESS_SIGNING_KEY);
    expect(new Set([
      environment.DEVRYAN_BOT_SUPERVISOR_TOKEN,
      environment.DEVRYAN_BOT_ENGINE_PROXY_TOKEN,
      environment.DEVRYAN_BOT_EGRESS_SIGNING_KEY,
      environment.DEVRYAN_BOT_EGRESS_CONTROL_TOKEN,
      environment.DEVRYAN_BOT_INDEXER_TOKEN,
    ]).size).toBe(5);
    expect(Object.values(environment)).not.toContain(key.toString('base64'));
  });
});

describe('Electron-owned Docker Bot runtime manager', () => {
  test('requires both a declared runsc runtime and an owned disposable smoke container', async () => {
    const manifest = releaseManifest();
    const installed = () => createMemoryStateStore({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });

    await expect(createManager({
      manifest,
      stateStore: installed(),
      runner: createFakeRunner({ runscDeclared: false }),
    }).manager.probeComputerIsolation({ isolationTier: 'runsc' })).resolves.toMatchObject({
      available: false,
      runtimeDeclared: false,
      smokePassed: false,
      code: 'bot_runtime_runsc_unavailable',
    });

    const failedSmoke = createManager({
      manifest,
      stateStore: installed(),
      runner: createFakeRunner({ runscDeclared: true, runscSmokeExitCode: 1 }),
    });
    await expect(failedSmoke.manager.probeComputerIsolation({ isolationTier: 'runsc' }))
      .resolves.toMatchObject({
        available: false,
        runtimeDeclared: true,
        smokePassed: false,
        code: 'bot_runtime_runsc_smoke_failed',
      });

    const healthy = createManager({
      manifest,
      stateStore: installed(),
      runner: createFakeRunner({ runscDeclared: true }),
    });
    await expect(healthy.manager.probeComputerIsolation({ isolationTier: 'runsc' }))
      .resolves.toMatchObject({
        available: true,
        runtimeDeclared: true,
        smokePassed: true,
      });
    const smokeArgs = healthy.runner.calls.find(({ args }) => args[0] === 'run').args;
    for (const value of [
      '--rm', '--runtime', 'runsc', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--entrypoint', '/bin/true',
    ]) expect(smokeArgs).toContain(value);
    expect(smokeArgs.some((value) => value.startsWith('devryan-bot-runsc-probe-'))).toBe(true);
    expect(smokeArgs.at(-1)).toBe(manifest.images.computer.reference);
    await expect(healthy.manager.probeComputerIsolation({ isolationTier: 'standard' }))
      .resolves.toMatchObject({ available: true, smokePassed: true });
  });

  test('forwards only bounded typed requests to the loopback indexer', async () => {
    const manifest = releaseManifest();
    const stateStore = createMemoryStateStore({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });
    const requests = [];
    const { manager, runner } = createManager({
      manifest,
      stateStore,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({
          ok: true,
          result: { changed: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    await expect(manager.requestIndexer({
      operation: 'upsert',
      body: { document: { namespace: 'bot:test' } },
    })).resolves.toEqual({ changed: true });

    expect(runner.calls.at(-1).args).toEqual([
      ...composePrefix,
      'port',
      'indexer',
      '43123',
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://127.0.0.1:55122/v1/upsert');
    expect(requests[0].options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ document: { namespace: 'bot:test' } }),
    });
    expect(requests[0].options.headers.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    await expect(manager.requestIndexer({ operation: 'arbitrary', body: {} }))
      .rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });
  });

  test.each([
    ['ECONNREFUSED', 'ECONNREFUSED'], ['ECONNRESET', 'ECONNRESET'],
    ['unexpected-private-value', 'transport_error'],
  ])('bounds supervisor transport diagnostics for %s', async (code, reason) => {
    const manifest = releaseManifest();
    const dataDirectory = await createTemporaryDirectory();
    const { manager } = createManager({
      manifest, dataDirectory,
      stateStore: createMemoryStateStore({ version: 1, current: manifest, previous: null, staged: null }),
      fetchImpl: async () => { throw Object.assign(new Error('private endpoint and payload'), { cause: { code } }); },
    });
    const error = await manager.stop({ kind: 'computer',
      botId: 'b0000000-0000-4000-8000-000000000001',
      scopeKey: 'bot:b0000000-0000-4000-8000-000000000001',
    }).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'bot_runtime_supervisor_unavailable',
      diagnostics: { stage: 'supervisor_request', reason } });
    expect(JSON.stringify(error)).not.toContain('private');
  });

  test('distinguishes Docker not installed from Docker installed but stopped', async () => {
    const missing = createManager({ resolveDocker: async () => null });
    expect(await missing.manager.status()).toMatchObject({
      state: 'docker_not_installed',
      code: 'bot_runtime_docker_not_installed',
    });
    expect(missing.runner.calls).toEqual([]);

    const stoppedRunner = createFakeRunner({ dockerRunning: false });
    const stopped = createManager({ runner: stoppedRunner });
    expect(await stopped.manager.status()).toMatchObject({
      state: 'docker_unavailable',
      code: 'bot_runtime_docker_unavailable',
    });
    expect(stoppedRunner.calls.map(({ file, args, shell }) => ({ file, args, shell }))).toEqual([{
      file: DOCKER,
      args: ['version', '--format', '{{json .}}'],
      shell: undefined,
    }]);
  });

  test('reports setup required before any fixed runtime manifest is installed', async () => {
    const { manager, runner } = createManager();
    expect(await manager.status()).toMatchObject({
      state: 'setup_required',
      code: 'bot_runtime_setup_required',
      canSetup: true,
    });
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ['version', '--format', '{{json .}}'],
    ]);
  });

  test('treats a legacy five-image installation as setup required', async () => {
    const manifest = releaseManifest();
    const legacy = structuredClone(manifest);
    delete legacy.images['engine-proxy'];
    const stateStore = createMemoryStateStore({
      version: 1,
      current: legacy,
      previous: null,
      staged: null,
    });
    const { manager, runner } = createManager({ manifest, stateStore });

    await expect(manager.status()).resolves.toMatchObject({
      state: 'setup_required',
      code: 'bot_runtime_setup_required',
      canSetup: true,
      issues: [{
        code: 'installation_state_outdated',
        message: 'Bot runtime installation state is outdated or invalid',
      }],
    });
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ['version', '--format', '{{json .}}'],
    ]);
  });

  test('setup replaces a legacy installation with an exact current state record', async () => {
    const manifest = releaseManifest();
    const legacy = structuredClone(manifest);
    delete legacy.images['engine-proxy'];
    const stateStore = createMemoryStateStore({
      version: 1,
      current: legacy,
      previous: null,
      staged: null,
    });
    const { manager, runner } = createManager({ manifest, stateStore });

    await expect(manager.setup()).resolves.toMatchObject({ state: 'healthy', changed: true });

    expect(runner.calls.filter(({ args }) => args[0] === 'pull'))
      .toHaveLength(BOT_RUNTIME_IMAGE_KEYS.length);
    expect(runner.calls.filter(({ args }) => args.includes('up'))).toHaveLength(1);
    expect(stateStore.reads()).toEqual({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });
    expect(Object.hasOwn(stateStore.reads(), 'invalid')).toBe(false);
  });

  test('ensureReady self-heals a legacy installation without persisting recovery metadata', async () => {
    const manifest = releaseManifest();
    const legacy = structuredClone(manifest);
    delete legacy.images['engine-proxy'];
    const stateStore = createMemoryStateStore({
      version: 1,
      current: legacy,
      previous: null,
      staged: null,
    });
    const { manager } = createManager({ manifest, stateStore });

    await expect(manager.ensureReady()).resolves.toMatchObject({ state: 'healthy', changed: true });
    expect(stateStore.reads()).toEqual({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });
    expect(stateStore.writes.every((value) => !Object.hasOwn(value, 'invalid'))).toBe(true);
  });

  test('treats malformed installation records as recoverable setup requirements', async () => {
    const manifest = releaseManifest();
    const malformedRecords = [
      'garbage',
      { version: 2, current: manifest, previous: null, staged: null },
      { version: 1, current: 'junk', previous: null, staged: null },
    ];

    for (const record of malformedRecords) {
      const { manager } = createManager({
        manifest,
        stateStore: createMemoryStateStore(record),
      });
      await expect(manager.status()).resolves.toMatchObject({
        state: 'setup_required',
        canSetup: true,
        issues: [{ code: 'installation_state_outdated' }],
      });
    }
  });

  test('drops invalid rollback and staged manifests while retaining a valid current install', async () => {
    const manifest = releaseManifest();
    const incompatible = structuredClone(manifest);
    delete incompatible.images['engine-proxy'];

    const invalidPrevious = createManager({
      manifest,
      stateStore: createMemoryStateStore({
        version: 1,
        current: manifest,
        previous: incompatible,
        staged: null,
      }),
    });
    await expect(invalidPrevious.manager.status()).resolves.toMatchObject({
      state: 'healthy',
      canRollback: false,
      updateStaged: false,
    });

    const invalidStaged = createManager({
      manifest,
      stateStore: createMemoryStateStore({
        version: 1,
        current: manifest,
        previous: null,
        staged: incompatible,
      }),
    });
    await expect(invalidStaged.manager.status()).resolves.toMatchObject({
      state: 'healthy',
      canRollback: false,
      updateStaged: false,
    });
  });

  test('performs setup with exact argv arrays and no shell', async () => {
    const manifest = releaseManifest();
    const { manager, runner, stateStore } = createManager({ manifest });

    const result = await manager.setup();

    expect(result).toMatchObject({ state: 'healthy', changed: true });
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ['version', '--format', '{{json .}}'],
      ...BOT_RUNTIME_IMAGE_KEYS.map((key) => ['pull', manifest.images[key].reference]),
      ...BOT_RUNTIME_IMAGE_KEYS.map((key) => [
        'image', 'inspect', '--format', '{{json .RepoDigests}}', manifest.images[key].reference,
      ]),
      ['network', 'inspect', 'devryan-bots-host-control', '--format', '{{json .}}'],
      ['ps', '--all', '--no-trunc', '--filter', 'network=devryan-bots-host-control', '--format', '{{json .}}'],
      [...composePrefix, 'up', '--detach', '--remove-orphans'],
      [...composePrefix, 'ps', '--format', 'json'],
    ]);
    expect(runner.calls.every(({ file, shell }) => file === DOCKER && shell === undefined)).toBe(true);
    const composeCalls = runner.calls.filter(({ args }) => args[0] === 'compose');
    expect(composeCalls.every(({ env }) => (
      env.DEVRYAN_BOT_DEPLOYMENT_ID.startsWith('deployment-')
      && env.DEVRYAN_BOT_SUPERVISOR_TOKEN.length === 43
      && env.DEVRYAN_BOT_ENGINE_PROXY_TOKEN.length === 43
      && env.DEVRYAN_BOT_EGRESS_SIGNING_KEY.length === 43
      && env.DEVRYAN_BOT_EGRESS_CONTROL_TOKEN.length === 43
      && env.DEVRYAN_BOT_INDEXER_TOKEN.length === 43
      && env.DEVRYAN_BOT_HOST_RUNTIME_ROOT === '/var/lib/devryan-bots/host-runtime'
      && env.DEVRYAN_BOT_ACTIVE_REVISIONS === ''
    ))).toBe(true);
    expect(stateStore.reads()?.current?.fingerprint).toBe(manifest.fingerprint);
  });

  test.each([
    {
      stderr: 'unauthorized: authentication required',
      message: 'Bot runtime image supervisor is not publicly accessible.',
    },
    {
      stderr: 'manifest unknown: manifest unknown',
      message: 'Bot runtime image supervisor is missing from this DevRyan release.',
    },
    {
      stderr: 'net/http: TLS handshake timeout',
      message: 'Bot runtime image supervisor could not be downloaded because the registry is unreachable.',
    },
  ])('sanitizes and classifies failed release pulls without committing setup', async ({ stderr, message }) => {
    const manifest = releaseManifest();
    const stateStore = createMemoryStateStore();
    const runner = createFakeRunner({
      pullOverride: () => ({
        exitCode: 1,
        stdout: 'registry response\nwith extra detail',
        stderr: `${stderr}\ncredential-helper=/private/path`,
      }),
    });
    const manager = createManager({ manifest, stateStore, runner }).manager;

    const error = await manager.setup().catch((caught) => caught);

    expect(error).toMatchObject({ code: 'bot_runtime_setup_failed' });
    expect(error.message).toStartWith(message);
    expect(error.message).not.toContain('credential-helper');
    expect(stateStore.reads()).toBeNull();
    expect(stateStore.writes).toEqual([]);
    expect(runner.calls.some(({ args }) => args[0] === 'compose')).toBe(false);
  });

  test('uses prebuilt local development images without pulling mutable tags', async () => {
    const manifest = validateBotRuntimeManifest({
      version: 1,
      channel: 'development',
      images: Object.fromEntries(BOT_RUNTIME_IMAGE_KEYS.map((key) => [
        key,
        { reference: `devryan/bot-${key}:dev` },
      ])),
    }, { isPackaged: false, architecture: 'arm64' });
    const { manager, runner } = createManager({ manifest });

    await expect(manager.setup()).resolves.toMatchObject({ state: 'healthy', changed: true });
    expect(runner.calls.some(({ args }) => args[0] === 'pull')).toBe(false);
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ['version', '--format', '{{json .}}'],
      ...BOT_RUNTIME_IMAGE_KEYS.map((key) => [
        'image', 'inspect', '--format', '{{json .RepoDigests}}', manifest.images[key].reference,
      ]),
      ['network', 'inspect', 'devryan-bots-host-control', '--format', '{{json .}}'],
      ['ps', '--all', '--no-trunc', '--filter', 'network=devryan-bots-host-control', '--format', '{{json .}}'],
      [...composePrefix, 'up', '--detach', '--remove-orphans'],
      [...composePrefix, 'ps', '--format', 'json'],
    ]);
  });

  test('fails development setup before Compose when a required local image is missing', async () => {
    const manifest = validateBotRuntimeManifest({
      version: 1,
      channel: 'development',
      images: Object.fromEntries(BOT_RUNTIME_IMAGE_KEYS.map((key) => [
        key,
        { reference: `devryan/bot-${key}:dev` },
      ])),
    }, { isPackaged: false, architecture: 'arm64' });
    const runner = createFakeRunner({
      inspectOverride: (reference) => reference === manifest.images.indexer.reference
        ? { exitCode: 1, stdout: '', stderr: 'missing' }
        : { exitCode: 0, stdout: '[]', stderr: '' },
    });
    const { manager } = createManager({ manifest, runner });

    await expect(manager.setup()).rejects.toMatchObject({ code: 'bot_runtime_setup_failed' });
    expect(runner.calls.some(({ args }) => args[0] === 'pull')).toBe(false);
    expect(runner.calls.some(({ args }) => args[0] === 'compose')).toBe(false);
  });

  test('reports immutable digest mismatch as an update requirement', async () => {
    const manifest = releaseManifest();
    const stateStore = createMemoryStateStore({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });
    const runner = createFakeRunner({
      inspectOverride: () => ({
        exitCode: 0,
        stdout: JSON.stringify(['ghcr.io/1h-team/unrelated@sha256:' + 'b'.repeat(64)]),
        stderr: '',
      }),
    });
    const { manager } = createManager({ manifest, runner, stateStore });

    const status = await manager.status();
    expect(status).toMatchObject({
      state: 'runtime_update_required',
      code: 'bot_runtime_update_required',
    });
    expect(status.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'image_digest_mismatch' }),
    ]));
  });

  test('distinguishes a degraded service set from a healthy runtime', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const degradedRunner = createFakeRunner({
      serviceRows: [
        { Service: 'supervisor', State: 'running', Health: 'unhealthy' },
        { Service: 'egress', State: 'running', Health: 'healthy' },
      ],
    });
    const degraded = createManager({
      manifest,
      runner: degradedRunner,
      stateStore: createMemoryStateStore(initial),
    });
    expect(await degraded.manager.status()).toMatchObject({
      state: 'degraded',
      code: 'bot_runtime_degraded',
    });

    const healthy = createManager({ stateStore: createMemoryStateStore(initial) });
    expect(await healthy.manager.status()).toMatchObject({ state: 'healthy', code: null });
  });

  const hostControlContainer = (id, name, state, labels) => ({
    ID: id,
    Names: name,
    State: state,
    Labels: `devryan.runtime=production-bots,${labels}`,
  });

  test('recreates a host-control network Docker Desktop cannot route and the Bot containers attached to it', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const runner = createFakeRunner({
      hostControlNetwork: { stale: true },
      attachedContainers: [
        hostControlContainer('sup1', 'devryan-bots-supervisor-1', 'running', 'com.docker.compose.project=devryan-bots,com.docker.compose.service=supervisor'),
        hostControlContainer('idx1', 'devryan-bots-indexer-1', 'running', 'com.docker.compose.project=devryan-bots,com.docker.compose.service=indexer'),
        hostControlContainer('comp1', 'devryan-bot-computer-1', 'running', 'devryan.kind=computer'),
        hostControlContainer('comp2', 'devryan-bot-computer-2', 'exited', 'devryan.kind=computer'),
        hostControlContainer('reas1', 'devryan-bot-reasoning-1', 'running', 'devryan.kind=reasoning'),
      ],
    });
    const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });
    expect(await manager.status()).toMatchObject({
      state: 'degraded',
      code: 'bot_runtime_degraded',
      issues: [{ code: 'host_control_network_stale' }],
    });

    await expect(manager.ensureReady()).resolves.toMatchObject({ state: 'healthy', changed: true });
    const argv = runner.calls.map(({ args }) => args);
    const indexOf = (predicate) => argv.findIndex(predicate);
    const composeRm = indexOf((args) => args[0] === 'compose' && args.includes('rm'));
    const stop = indexOf((args) => args[0] === 'stop');
    const rm = indexOf((args) => args[0] === 'rm');
    const networkRm = indexOf((args) => args[0] === 'network' && args[1] === 'rm');
    const composeUp = indexOf((args) => args[0] === 'compose' && args.includes('up'));
    expect(argv[composeRm]).toEqual([...composePrefix, 'rm', '--force', '--stop', 'supervisor', 'indexer']);
    expect(argv[stop]).toEqual(['stop', 'comp1', 'comp2', 'reas1']);
    expect(argv[rm]).toEqual(['rm', '--force', 'comp1', 'comp2', 'reas1']);
    expect(argv[networkRm]).toEqual(['network', 'rm', 'devryan-bots-host-control']);
    expect(composeRm).toBeLessThan(stop);
    expect(stop).toBeLessThan(rm);
    expect(rm).toBeLessThan(networkRm);
    expect(networkRm).toBeLessThan(composeUp);
    expect(argv.some((args) => args[0] === 'network' && ['disconnect', 'connect'].includes(args[1]))).toBe(false);
    expect(argv.filter((args) => args[0] === 'compose' && args.includes('up'))).toHaveLength(1);
    expect(await manager.status()).toMatchObject({ state: 'healthy', code: null });
  });

  const ownDeploymentId = () => deriveBotRuntimeServiceEnvironment(Buffer.alloc(32, 7), { dockerSocketGid: 20 })
    .DEVRYAN_BOT_DEPLOYMENT_ID;
  const FOREIGN_DEPLOYMENT_ID = 'deployment-ffffffffffffffffffffffff';
  const foreignServices = () => [
    hostControlContainer('fsup', 'devryan-bots-supervisor-1', 'running', `com.docker.compose.project=devryan-bots,com.docker.compose.service=supervisor,devryan.deployment=${FOREIGN_DEPLOYMENT_ID}`),
    hostControlContainer('fidx', 'devryan-bots-indexer-1', 'running', `com.docker.compose.project=devryan-bots,com.docker.compose.service=indexer,devryan.deployment=${FOREIGN_DEPLOYMENT_ID}`),
    hostControlContainer('fcomp', 'devryan-bot-computer-1', 'running', `devryan.kind=computer,devryan.deployment=${FOREIGN_DEPLOYMENT_ID}`),
  ];

  test('reports a runtime owned by another installation instead of trusting its healthy services', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const runner = createFakeRunner({ attachedContainers: foreignServices() });
    const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });

    expect(await manager.status()).toMatchObject({
      state: 'degraded',
      code: 'bot_runtime_foreign_deployment',
      issues: [{ code: 'foreign_deployment', deployment: FOREIGN_DEPLOYMENT_ID }],
    });
    expect(runner.calls.some(({ args }) => ['stop', 'rm'].includes(args[0]))).toBe(false);
  });

  test('refuses to repair, set up or update over another installation without touching its containers', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    for (const operation of ['repair', 'ensureReady']) {
      const runner = createFakeRunner({ attachedContainers: foreignServices() });
      const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });
      const error = await manager[operation]().catch((caught) => caught);
      expect(error).toMatchObject({
        code: 'bot_runtime_foreign_deployment',
        diagnostics: { foreignDeployment: FOREIGN_DEPLOYMENT_ID },
      });
      expect(error.message).toContain(FOREIGN_DEPLOYMENT_ID);
      const argv = runner.calls.map(({ args }) => args);
      expect(argv.some((args) => ['stop', 'rm'].includes(args[0]))).toBe(false);
      expect(argv.some((args) => args[0] === 'compose' && (args.includes('up') || args.includes('rm')))).toBe(false);
      expect(argv.some((args) => args[0] === 'network' && args[1] === 'rm')).toBe(false);
    }
    const setupRunner = createFakeRunner({ attachedContainers: foreignServices() });
    const setupStore = createMemoryStateStore();
    const { manager: fresh } = createManager({ manifest, runner: setupRunner, stateStore: setupStore });
    await expect(fresh.setup()).rejects.toMatchObject({ code: 'bot_runtime_foreign_deployment' });
    expect(setupRunner.calls.some(({ args }) => args[0] === 'compose' && args.includes('up'))).toBe(false);
    expect(setupStore.writes).toEqual([]);
  });

  test('refuses to rebuild a stale host-control network while another installation is attached', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const runner = createFakeRunner({ hostControlNetwork: { stale: true }, attachedContainers: foreignServices() });
    const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });

    await expect(manager.ensureReady()).rejects.toMatchObject({ code: 'bot_runtime_foreign_deployment' });
    const argv = runner.calls.map(({ args }) => args);
    expect(argv.some((args) => ['stop', 'rm'].includes(args[0]))).toBe(false);
    expect(argv.some((args) => args[0] === 'compose' && args.includes('rm'))).toBe(false);
    expect(argv.some((args) => args[0] === 'network' && args[1] === 'rm')).toBe(false);
  });

  test('treats containers carrying its own deployment id as its own', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const own = ownDeploymentId();
    const runner = createFakeRunner({
      attachedContainers: [
        hostControlContainer('sup1', 'devryan-bots-supervisor-1', 'running', `com.docker.compose.project=devryan-bots,com.docker.compose.service=supervisor,devryan.deployment=${own}`),
        hostControlContainer('comp1', 'devryan-bot-computer-1', 'running', `devryan.kind=computer,devryan.deployment=${own}`),
      ],
    });
    const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });

    expect(await manager.status()).toMatchObject({
      state: 'degraded',
      code: 'bot_runtime_degraded',
      issues: [{ code: 'host_control_attachment_retired' }],
    });
    await expect(manager.ensureReady()).resolves.toMatchObject({ state: 'healthy' });
    expect(runner.calls.map(({ args }) => args)).toContainEqual(['stop', 'comp1']);
  });

  test('detaches Bot containers still holding the retired host-control attachment', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const runner = createFakeRunner({
      attachedContainers: [
        hostControlContainer('sup1', 'devryan-bots-supervisor-1', 'running', 'com.docker.compose.project=devryan-bots,com.docker.compose.service=supervisor'),
        hostControlContainer('idx1', 'devryan-bots-indexer-1', 'running', 'com.docker.compose.project=devryan-bots,com.docker.compose.service=indexer'),
        hostControlContainer('comp1', 'devryan-bot-computer-1', 'running', 'devryan.kind=computer'),
        hostControlContainer('reas1', 'devryan-bot-reasoning-1', 'exited', 'devryan.kind=reasoning'),
      ],
    });
    const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });

    // The bridge itself is current, so it and the services that still publish
    // loopback ports through it are left alone; only the containers running
    // Bot-authored work lose their route off the internal networks.
    await expect(manager.ensureReady()).resolves.toMatchObject({ state: 'healthy' });
    const argv = runner.calls.map(({ args }) => args);
    expect(argv).toContainEqual(['stop', 'comp1', 'reas1']);
    expect(argv).toContainEqual(['rm', '--force', 'comp1', 'reas1']);
    expect(argv.some((args) => args[0] === 'network' && args[1] === 'rm')).toBe(false);
    expect(argv.some((args) => args[0] === 'compose' && args.includes('rm'))).toBe(false);
    expect(argv.some((args) => args[0] === 'network' && ['connect', 'disconnect'].includes(args[1]))).toBe(false);
  });

  test('leaves the fixed services alone when nothing holds a retired attachment', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const runner = createFakeRunner({
      attachedContainers: [
        hostControlContainer('sup1', 'devryan-bots-supervisor-1', 'running', 'com.docker.compose.project=devryan-bots,com.docker.compose.service=supervisor'),
      ],
    });
    const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });

    await expect(manager.ensureReady()).resolves.toMatchObject({ state: 'healthy' });
    const argv = runner.calls.map(({ args }) => args);
    expect(argv.some((args) => ['stop', 'rm'].includes(args[0]))).toBe(false);
  });

  test('refuses the host-control network repair while an unmanaged container is attached', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const runner = createFakeRunner({
      hostControlNetwork: { stale: true },
      attachedContainers: [
        hostControlContainer('sup1', 'devryan-bots-supervisor-1', 'running', 'com.docker.compose.project=devryan-bots,com.docker.compose.service=supervisor'),
        { ID: 'other', Names: 'someone-elses-container', State: 'running', Labels: 'com.docker.compose.project=other' },
      ],
    });
    const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });
    await expect(manager.ensureReady()).rejects.toMatchObject({ code: 'bot_runtime_repair_failed' });
    const argv = runner.calls.map(({ args }) => args);
    expect(argv.some((args) => ['stop', 'rm'].includes(args[0]) || (args[0] === 'network' && args[1] === 'rm'))).toBe(false);
    expect(argv.some((args) => args[0] === 'compose' && (args.includes('rm') || args.includes('up')))).toBe(false);
  });

  test('leaves a masqueraded or absent host-control network alone', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    for (const hostControlNetwork of [{ stale: false }, null]) {
      const runner = createFakeRunner({ hostControlNetwork });
      const { manager } = createManager({ manifest, runner, stateStore: createMemoryStateStore(initial) });
      expect(await manager.status()).toMatchObject({ state: 'healthy', code: null });
      await expect(manager.repair()).resolves.toMatchObject({ state: 'healthy' });
      const argv = runner.calls.map(({ args }) => args);
      // Attachments are probed, but nothing is stopped, removed, or rebuilt.
      expect(argv.some((args) => ['stop', 'rm'].includes(args[0]) || (args[0] === 'network' && args[1] !== 'inspect'))).toBe(false);
      expect(argv.some((args) => args[0] === 'compose' && args.includes('up'))).toBe(false);
    }
  });

  test('warns about a small Docker Desktop VM without blocking a healthy runtime', async () => {
    const manifest = releaseManifest();
    const initial = { version: 1, current: manifest, previous: null, staged: null };
    const smallRunner = createFakeRunner({ memTotalBytes: 3_054_247_936 });
    const small = createManager({
      manifest,
      runner: smallRunner,
      stateStore: createMemoryStateStore(initial),
    });
    const status = await small.manager.status();
    expect(status).toMatchObject({ ok: true, state: 'healthy', code: null, issues: [] });
    expect(status.warnings.map((warning) => warning.code)).toEqual([
      'docker_memory_low',
      'docker_memory_below_limits',
    ]);
    expect(status.warnings[0].message).toContain('2.8 GiB');
    expect(status.warnings[0].message).toContain('at least 6 GiB (8 GiB recommended)');
    expect(status.warnings[1].message).toContain('computer (3 GiB)');
    expect(JSON.stringify(status.warnings)).not.toMatch(/\/Users\/|token|credential/i);

    await small.manager.status();
    expect(smallRunner.calls.filter(({ args }) => args[2] === '{{.MemTotal}}')).toHaveLength(1);

    const largeRunner = createFakeRunner({ memTotalBytes: 16 * 1024 * 1024 * 1024 });
    const large = createManager({ manifest, runner: largeRunner, stateStore: createMemoryStateStore(initial) });
    expect((await large.manager.status()).warnings).toEqual([]);

    const unknownRunner = createFakeRunner({ memTotalBytes: null });
    const unknown = createManager({ manifest, runner: unknownRunner, stateStore: createMemoryStateStore(initial) });
    expect(await unknown.manager.status()).toMatchObject({ state: 'healthy', warnings: [] });

    const missing = createManager({ resolveDocker: async () => null });
    expect((await missing.manager.status()).warnings).toEqual([]);
  });

  test('keeps the engine memory policy aligned with the supervisor container limits', () => {
    const GIB = 1024 * 1024 * 1024;
    expect(BOT_RUNTIME_ENGINE_MEMORY_POLICY.containerLimitBytes.reasoning)
      .toBe(BOT_RESOURCE_LIMITS.reasoning.memoryBytes);
    expect(BOT_RUNTIME_ENGINE_MEMORY_POLICY.containerLimitBytes.computer)
      .toBe(BOT_RESOURCE_LIMITS.computer.memoryBytes);
    expect(BOT_RUNTIME_ENGINE_MEMORY_POLICY.minimumBytes).toBe(6 * GIB);
    expect(BOT_RUNTIME_ENGINE_MEMORY_POLICY.recommendedBytes).toBe(8 * GIB);
    expect(evaluateBotRuntimeEngineMemory(Number.NaN)).toEqual([]);
    expect(evaluateBotRuntimeEngineMemory(0)).toEqual([]);
    expect(evaluateBotRuntimeEngineMemory(8 * GIB)).toEqual([]);
    expect(evaluateBotRuntimeEngineMemory(6 * GIB)).toEqual([]);
    expect(evaluateBotRuntimeEngineMemory(5 * GIB).map((warning) => warning.code)).toEqual(['docker_memory_low']);
    expect(evaluateBotRuntimeEngineMemory(2 * GIB).map((warning) => warning.code))
      .toEqual(['docker_memory_low', 'docker_memory_below_limits']);
  });

  test('stages an update and retains the prior manifest for rollback', async () => {
    const previous = releaseManifest({ releaseId: '1.2.2', digestCharacter: 'b' });
    const desired = releaseManifest({ releaseId: '1.2.3', digestCharacter: 'c' });
    const stateStore = createMemoryStateStore({
      version: 1,
      current: previous,
      previous: null,
      staged: null,
    });
    const { manager } = createManager({ manifest: desired, stateStore });

    expect(await manager.update()).toMatchObject({ state: 'healthy', changed: true });
    expect(stateStore.writes).toHaveLength(2);
    expect(stateStore.writes[0]).toMatchObject({
      current: { fingerprint: previous.fingerprint },
      staged: { fingerprint: desired.fingerprint },
    });
    expect(stateStore.reads()).toMatchObject({
      current: { fingerprint: desired.fingerprint },
      previous: { fingerprint: previous.fingerprint },
      staged: null,
    });

    expect(await manager.rollback()).toMatchObject({ state: 'healthy', changed: true });
    expect(stateStore.reads()).toMatchObject({
      current: { fingerprint: previous.fingerprint },
      previous: { fingerprint: desired.fingerprint },
      staged: null,
    });
  });

  test('waits for fixed services to converge before committing an update', async () => {
    const previous = releaseManifest({ releaseId: '1.2.2', digestCharacter: 'b' });
    const desired = releaseManifest({ releaseId: '1.2.3', digestCharacter: 'c' });
    const stateStore = createMemoryStateStore({
      version: 1,
      current: previous,
      previous: null,
      staged: null,
    });
    let serviceInspection = 0;
    const startingServices = healthyServices().map((row) => ({ ...row, Health: 'starting' }));
    const runner = createFakeRunner({
      serviceRows: () => (++serviceInspection === 1 ? startingServices : healthyServices()),
    });
    const waits = [];
    const { manager } = createManager({
      manifest: desired,
      stateStore,
      runner,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    const progress = [];

    await expect(manager.update({ onProgress: (event) => progress.push(event) }))
      .resolves.toMatchObject({ state: 'healthy', changed: true });

    expect(waits).toEqual([1_000]);
    expect(runner.calls.filter(({ args }) => args.includes('up'))).toHaveLength(1);
    expect(stateStore.writes).toHaveLength(2);
    expect(stateStore.writes[0]).toMatchObject({
      current: { fingerprint: previous.fingerprint },
      staged: { fingerprint: desired.fingerprint },
    });
    expect(stateStore.writes[1]).toMatchObject({
      current: { fingerprint: desired.fingerprint },
      previous: { fingerprint: previous.fingerprint },
      staged: null,
    });
    expect(progress.at(-1)).toMatchObject({ phase: 'ready' });
  });

  test('fails unhealthy activation terminally and retains the staged update', async () => {
    const previous = releaseManifest({ releaseId: '1.2.2', digestCharacter: 'd' });
    const desired = releaseManifest({ releaseId: '1.2.3', digestCharacter: 'e' });
    const stateStore = createMemoryStateStore({
      version: 1,
      current: previous,
      previous: null,
      staged: null,
    });
    const unhealthyServices = healthyServices().map((row, index) => (
      index === 0 ? { ...row, Health: 'unhealthy' } : row
    ));
    let clock = 0;
    const progress = [];
    const { manager } = createManager({
      manifest: desired,
      stateStore,
      runner: createFakeRunner({ serviceRows: unhealthyServices }),
      now: () => clock,
      wait: async (milliseconds) => { clock += milliseconds; },
    });

    await expect(manager.update({
      deadlineMs: 100_000,
      onProgress: (event) => progress.push(event),
    })).rejects.toMatchObject({ code: 'bot_runtime_update_failed' });

    expect(stateStore.writes).toHaveLength(1);
    expect(stateStore.reads()).toMatchObject({
      current: { fingerprint: previous.fingerprint },
      staged: { fingerprint: desired.fingerprint },
    });
    expect(progress.at(-1)).toMatchObject({
      phase: 'failed',
      code: 'bot_runtime_update_failed',
    });
  });

  test('does not commit setup when a fixed service exits during activation', async () => {
    const stateStore = createMemoryStateStore();
    const stoppedServices = healthyServices().map((row, index) => (
      index === 0 ? { ...row, State: 'exited', Health: 'unhealthy' } : row
    ));
    const progress = [];
    const { manager } = createManager({
      stateStore,
      runner: createFakeRunner({ serviceRows: stoppedServices }),
    });

    await expect(manager.setup({ onProgress: (event) => progress.push(event) }))
      .rejects.toMatchObject({ code: 'bot_runtime_setup_failed' });

    expect(stateStore.writes).toEqual([]);
    expect(progress.at(-1)).toMatchObject({ phase: 'failed', code: 'bot_runtime_setup_failed' });
  });

  test('leaves a failed staged update recoverable and makes healthy repair idempotent', async () => {
    const previous = releaseManifest({ releaseId: '1.2.2', digestCharacter: 'd' });
    const desired = releaseManifest({ releaseId: '1.2.3', digestCharacter: 'e' });
    const initial = { version: 1, current: previous, previous: null, staged: null };
    const failedStore = createMemoryStateStore(initial);
    const failed = createManager({
      manifest: desired,
      stateStore: failedStore,
      runner: createFakeRunner({ failComposeUp: true }),
    });
    await expect(failed.manager.update()).rejects.toMatchObject({
      code: 'bot_runtime_update_failed',
    });
    expect(failedStore.reads()).toMatchObject({
      current: { fingerprint: previous.fingerprint },
      staged: { fingerprint: desired.fingerprint },
    });

    const recovery = createManager({
      manifest: desired,
      stateStore: failedStore,
      runner: createFakeRunner(),
    });
    expect(await recovery.manager.rollback()).toMatchObject({ state: 'healthy', changed: true });
    expect(failedStore.reads()).toMatchObject({
      current: { fingerprint: previous.fingerprint },
      staged: null,
    });

    const healthyStore = createMemoryStateStore(initial);
    const healthyRunner = createFakeRunner();
    const healthy = createManager({
      manifest: previous,
      stateStore: healthyStore,
      runner: healthyRunner,
    });
    expect(await healthy.manager.repair('$(malicious user input)')).toMatchObject({
      state: 'healthy',
      changed: false,
    });
    expect(healthyRunner.calls.some(({ args }) => args.includes('$(malicious user input)'))).toBe(false);
    expect(healthyRunner.calls.some(({ args }) => args.includes('pull') || args.includes('up'))).toBe(false);
    expect(healthyStore.writes).toHaveLength(0);
  });

  test('ensures a healthy runtime is ready without mutating Docker or installation state', async () => {
    const manifest = releaseManifest();
    const stateStore = createMemoryStateStore({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });
    const { manager, runner } = createManager({ manifest, stateStore });
    const progress = [];

    await expect(manager.ensureReady({ onProgress: (event) => progress.push(event) }))
      .resolves.toMatchObject({ state: 'healthy', changed: false });

    expect(runner.calls.some(({ args }) => args[0] === 'pull')).toBe(false);
    expect(runner.calls.some(({ args }) => args.includes('up'))).toBe(false);
    expect(stateStore.writes).toEqual([]);
    expect(progress.at(-1)).toMatchObject({ phase: 'ready' });
  });

  test('ensures a missing runtime by performing setup', async () => {
    const manifest = releaseManifest();
    const { manager, runner, stateStore } = createManager({ manifest });

    await expect(manager.ensureReady()).resolves.toMatchObject({
      state: 'healthy',
      changed: true,
    });

    expect(runner.calls.filter(({ args }) => args[0] === 'pull'))
      .toHaveLength(BOT_RUNTIME_IMAGE_KEYS.length);
    expect(runner.calls.filter(({ args }) => args.includes('up'))).toHaveLength(1);
    expect(stateStore.reads()).toMatchObject({
      current: { fingerprint: manifest.fingerprint },
      staged: null,
    });
  });

  test('repairs an incomplete staged release before updating to the desired manifest', async () => {
    const previous = releaseManifest({ releaseId: '1.2.2', digestCharacter: 'd' });
    const desired = releaseManifest({ releaseId: '1.2.3', digestCharacter: 'e' });
    const stateStore = createMemoryStateStore({
      version: 1,
      current: previous,
      previous: null,
      staged: desired,
    });
    const { manager, runner } = createManager({ manifest: desired, stateStore });

    await expect(manager.ensureReady()).resolves.toMatchObject({ state: 'healthy', changed: true });

    expect(runner.calls.filter(({ args }) => args[0] === 'pull'))
      .toHaveLength(BOT_RUNTIME_IMAGE_KEYS.length * 2);
    expect(runner.calls.filter(({ args }) => args.includes('up'))).toHaveLength(2);
    expect(stateStore.writes[0]).toMatchObject({
      current: { fingerprint: previous.fingerprint },
      staged: null,
    });
    expect(stateStore.reads()).toMatchObject({
      current: { fingerprint: desired.fingerprint },
      previous: { fingerprint: previous.fingerprint },
      staged: null,
    });
  });

  test('shares concurrent readiness work and emits only sanitized progress fields', async () => {
    const manifest = releaseManifest();
    let releaseFirstPull;
    const firstPullGate = new Promise((resolve) => { releaseFirstPull = resolve; });
    let pullCount = 0;
    const runner = createFakeRunner({
      pullOverride: async () => {
        pullCount += 1;
        if (pullCount === 1) await firstPullGate;
        return { exitCode: 0, stdout: 'sensitive Docker output', stderr: '/private/runtime/path' };
      },
    });
    const { manager } = createManager({ manifest, runner });
    const progress = [];

    const first = manager.ensureReady({ onProgress: (event) => progress.push(event) });
    while (pullCount === 0) await Promise.resolve();
    const second = manager.ensureReady({ onProgress: (event) => progress.push(event) });
    expect(second).toBe(first);
    releaseFirstPull();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(pullCount).toBe(BOT_RUNTIME_IMAGE_KEYS.length);
    for (const event of progress) {
      expect(Object.keys(event).sort()).toEqual([
        'action', 'code', 'completed', 'id', 'phase', 'startedAt', 'total',
      ]);
      expect(JSON.stringify(event)).not.toMatch(/ghcr\.io|private\/runtime|sensitive|token|credential/i);
    }
  });

  test('returns a deterministic readiness deadline code', async () => {
    const runner = createFakeRunner();
    const originalRunProcess = runner.runProcess;
    runner.runProcess = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return originalRunProcess(...args);
    };
    const { manager } = createManager({ runner });

    await expect(manager.ensureReady({ deadlineMs: 1 })).rejects.toMatchObject({
      code: 'bot_runtime_startup_timeout',
    });
  });

  test('persists installation state atomically with private permissions', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const manifest = releaseManifest();
    const runner = createFakeRunner();
    const manager = createBotRuntimeManager({
      composePath: COMPOSE,
      dataDirectory,
      loadManifest: async () => manifest,
      resolveDocker: async () => DOCKER,
      runProcess: runner.runProcess,
      baseEnvironment: { PATH: '/opt/homebrew/bin:/usr/bin' },
      loadRuntimeEnvironment: async () => deriveBotRuntimeServiceEnvironment(Buffer.alloc(32, 7)),
    });

    await manager.setup();

    expect((await fs.stat(manager.paths.statePath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.dirname(manager.paths.statePath))).toEqual(['installation.v1.json']);
  });

  test('distinguishes unreadable, invalid, and missing installation state files', async () => {
    const dataDirectory = '/tmp/devryan-bot-runtime-state-store-test';
    const unreadable = createFileBotRuntimeStateStore({
      dataDirectory,
      fsPromises: {
        readFile: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
      },
    });
    const invalid = createFileBotRuntimeStateStore({
      dataDirectory,
      fsPromises: { readFile: async () => '{not-json' },
    });
    const missing = createFileBotRuntimeStateStore({
      dataDirectory,
      fsPromises: {
        readFile: async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      },
    });

    await expect(unreadable.read()).rejects.toMatchObject({ code: 'bot_runtime_state_unreadable' });
    await expect(invalid.read()).rejects.toMatchObject({ code: 'bot_runtime_state_invalid' });
    await expect(missing.read()).resolves.toBeNull();
  });

  test('recovers edited installation image references before they reach Docker argv', async () => {
    const manifest = releaseManifest();
    const edited = structuredClone(manifest);
    edited.images.supervisor.reference = 'malicious.invalid/image:tag;touch-owned-file';
    const stateStore = createMemoryStateStore({
      version: 1,
      current: edited,
      previous: null,
      staged: null,
    });
    const runner = createFakeRunner();
    const { manager } = createManager({ manifest, stateStore, runner });

    await expect(manager.status()).resolves.toMatchObject({
      state: 'setup_required',
      canSetup: true,
      issues: [{ code: 'installation_state_outdated' }],
    });
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ['version', '--format', '{{json .}}'],
    ]);
  });

  test('calls only fixed supervisor routes after validating scoped config and auth paths', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const manifest = releaseManifest();
    const stateStore = createMemoryStateStore({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });
    const runner = createFakeRunner({ supervisorPort: 55120 });
    const requests = [];
    let rejectEgressActivation = false;
    let rejectBrowserRotation = false;
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      const pathname = new URL(url).pathname;
      if (rejectEgressActivation && pathname === '/v1/revisions/activate') {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: 'bot_egress_control_unavailable' },
        }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === '/v1/workspace/write') {
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          result: {
            written: true,
            path: body.path,
            bytes: Buffer.byteLength(body.content, 'utf8'),
            sha256: 'a'.repeat(64),
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === '/v1/shared/import') {
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          result: {
            written: true,
            path: `/workspace/Shared/${body.channelId}/${body.messageId}/${body.filename}`,
            bytes: body.expectedSize,
            sha256: body.sha256,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === '/v1/ensure/computer') {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            kind: 'computer',
            name: 'devryan-bot-computer-abc123',
            state: 'running',
            endpoint: { proxyToken: 'q'.repeat(43) },
            image: `sha256:${'b'.repeat(64)}`,
            replaced: false,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === '/v1/gateway/origin') {
        return new Response(JSON.stringify({
          ok: true,
          result: { origin: JSON.parse(options.body).origin },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === `/v1/runtime/${'q'.repeat(43)}/v1/egress/rotate`) {
        if (rejectBrowserRotation) {
          return new Response(JSON.stringify({
            ok: false,
            error: { code: 'DEVRYAN_BOT_BROWSER_EGRESS_TOKEN_INVALID' },
          }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true, result: { rotated: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const result = {
        kind: 'reasoning',
        name: 'devryan-bot-reasoning-abc123',
        state: 'running',
        endpoint: { proxyToken: 'p'.repeat(43) },
        image: `sha256:${'a'.repeat(64)}`,
        replaced: false,
      };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { manager } = createManager({
      manifest,
      stateStore,
      runner,
      dataDirectory,
      fetchImpl,
    });
    const runId = 'a0000000-0000-4000-8000-000000000001';
    const botId = 'b0000000-0000-4000-8000-000000000001';
    const channelId = 'c0000000-0000-4000-8000-000000000001';
    const revisionId = 'd0000000-0000-4000-8000-000000000001';
    const compiledHash = 'e'.repeat(64);
    const runtimeRoot = path.join(dataDirectory, 'bots', 'runtime');
    const configDirectory = path.join(runtimeRoot, 'channels', channelId, revisionId, compiledHash);
    const skillsDirectory = path.join(configDirectory, 'skills');
    const authDirectory = path.join(runtimeRoot, 'auth', runId);
    const artifactsDirectory = path.join(runtimeRoot, 'artifacts', runId);
    const environmentDirectory = path.join(runtimeRoot, 'environment', runId);
    await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const skillDirectory = path.join(skillsDirectory, 'review-queue');
    const skillContent = '# Review queue\n';
    const skillDigest = crypto.createHash('sha256').update(skillContent).digest('hex');
    await fs.mkdir(skillDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), skillContent, { mode: 0o400 });
    await fs.chmod(skillDirectory, 0o500);
    await fs.chmod(skillsDirectory, 0o500);
    await fs.mkdir(authDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(environmentDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(configDirectory, 'revision.json'), JSON.stringify({
      compiledHash,
      revisionId,
      skills: [{
        id: 'f0000000-0000-4000-8000-000000000001',
        name: 'review-queue',
        digest: 'a'.repeat(64),
        files: [{ path: 'SKILL.md', sha256: skillDigest }],
      }],
    }), { mode: 0o400 });
    await fs.writeFile(path.join(configDirectory, 'opencode.json'), '{"default_agent":"bot"}\n', { mode: 0o400 });
    await fs.writeFile(path.join(authDirectory, 'auth.json'), '{"openai":{"type":"oauth"}}\n', { mode: 0o600 });
    await fs.writeFile(
      path.join(artifactsDirectory, 'manifest.json'),
      `${JSON.stringify({ version: 1, files: [] })}\n`,
      { mode: 0o400 },
    );
    await fs.writeFile(
      path.join(environmentDirectory, 'environment.json'),
      `${JSON.stringify({ version: 1, variables: {} })}\n`,
      { mode: 0o400 },
    );

    const input = {
      botId,
      scopeKey: `channel:${channelId}`,
      runId,
      channelId,
      revisionId,
      runtimeToken: 't'.repeat(43),
      compiledHash,
      gatewayUrl: 'http://host.docker.internal:55100',
      egressHosts: ['api.openai.com:443'],
      environmentSecretCount: 0,
      chatgptImageGeneration: false,
    };
    await expect(manager.ensureReasoning(input)).resolves.toMatchObject({
      state: 'running',
      endpoint: {
        host: '127.0.0.1',
        port: 55120,
        path: `/v1/runtime/${'p'.repeat(43)}`,
      },
    });
    expect(runner.calls.slice(-2).map(({ args }) => args)).toEqual([
      [...composePrefix, 'port', 'supervisor', '43120'],
      [...composePrefix, 'port', 'egress', '43121'],
    ]);
    expect(requests).toHaveLength(3);
    // The host gateway address is published on the egress control channel
    // before the container that will use it starts, and never travels to the
    // supervisor or into a container.
    expect(requests[0].url).toBe('http://127.0.0.1:55121/v1/gateway/origin');
    expect(JSON.parse(requests[0].options.body))
      .toEqual({ origin: 'http://host.docker.internal:55100' });
    expect(requests[1].url).toBe('http://127.0.0.1:55120/v1/ensure/reasoning');
    expect(requests[1].options.method).toBe('POST');
    expect(requests[1].options.headers.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(requests[1].options.body)).toMatchObject({
      botId,
      runId,
      channelId,
      revisionId,
      egressToken: expect.stringMatching(/^drb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    });
    expect(JSON.parse(requests[1].options.body)).not.toHaveProperty('egressHosts');
    expect(JSON.parse(requests[1].options.body)).not.toHaveProperty('gatewayUrl');
    expect(requests[2].url).toBe('http://127.0.0.1:55121/v1/revisions/activate');
    expect(JSON.parse(requests[2].options.body)).toEqual({ botId, revisionId });
    expect(requests[1].options).not.toHaveProperty('shell');

    const escapedArtifact = path.join(artifactsDirectory, 'escaped.md');
    await fs.symlink(path.join(configDirectory, 'revision.json'), escapedArtifact);
    await expect(manager.ensureReasoning(input))
      .rejects.toMatchObject({ code: 'bot_runtime_scoped_file_invalid' });
    await fs.unlink(escapedArtifact);

    const unlistedArtifact = path.join(artifactsDirectory, 'unlisted.md');
    await fs.writeFile(unlistedArtifact, 'not declared by the manifest\n', { mode: 0o400 });
    await expect(manager.ensureReasoning(input))
      .rejects.toMatchObject({ code: 'bot_runtime_scoped_file_invalid' });
    await fs.unlink(unlistedArtifact);

    await expect(manager.ensureReasoning({
      ...input,
      dockerArgs: ['run', '--privileged'],
    })).rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });

    await expect(manager.ensureComputer({
      botId,
      scopeKey: `bot:${botId}`,
      runId,
      channelId,
      revisionId,
      runtimeToken: 'u'.repeat(43),
      scopeMode: 'team',
      gatewayUrl: 'http://host.docker.internal:55100',
      browserNetworkMode: 'public_only',
      browserEgressHosts: [],
      isolationTier: 'standard',
    })).resolves.toBeDefined();
    await expect(manager.inspect({
      kind: 'reasoning',
      botId,
      scopeKey: `channel:${channelId}`,
    })).resolves.toBeDefined();
    await expect(manager.stop({
      kind: 'computer',
      botId,
      scopeKey: `bot:${botId}`,
    })).resolves.toBeDefined();
    await expect(manager.writeWorkspace({
      botId,
      scopeKey: `channel:${channelId}`,
      path: 'approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    })).resolves.toEqual({
      written: true,
      path: 'approval-check.txt',
      bytes: 15,
      sha256: 'a'.repeat(64),
    });
    const sharedMessageId = '90000000-0000-4000-8000-000000000001';
    const sharedBytes = Buffer.from([0, 1, 2, 3, 255]);
    const sharedSha256 = crypto.createHash('sha256').update(sharedBytes).digest('hex');
    await expect(manager.importSharedFile({
      botId,
      scopeKey: `bot:${botId}`,
      channelId,
      messageId: sharedMessageId,
      filename: 'fixture.bin',
      contentBase64: sharedBytes.toString('base64'),
      expectedSize: sharedBytes.byteLength,
      sha256: sharedSha256,
    })).resolves.toEqual({
      written: true,
      path: `/workspace/Shared/${channelId}/${sharedMessageId}/fixture.bin`,
      bytes: sharedBytes.byteLength,
      sha256: sharedSha256,
    });

    const proxyPath = `/v1/runtime/${'q'.repeat(43)}`;
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/v1/gateway/origin',
      '/v1/ensure/reasoning',
      '/v1/revisions/activate',
      '/v1/gateway/origin',
      '/v1/ensure/computer',
      `${proxyPath}/v1/egress/rotate`,
      '/v1/status',
      '/v1/stop',
      '/v1/workspace/write',
      '/v1/shared/import',
    ]);
    const browserRotation = requests.find(({ url }) => (
      new URL(url).pathname === `${proxyPath}/v1/egress/rotate`
    ));
    expect(browserRotation.options.headers.authorization).toBe(`Bearer ${'u'.repeat(43)}`);
    expect(JSON.parse(browserRotation.options.body).token)
      .toMatch(/^drb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await expect(manager.importSharedFile({
      botId,
      scopeKey: `bot:${botId}`,
      channelId,
      messageId: sharedMessageId,
      filename: '../escape.bin',
      contentBase64: sharedBytes.toString('base64'),
      expectedSize: sharedBytes.byteLength,
      sha256: sharedSha256,
    })).rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });
    await expect(manager.ensureComputer({
      botId,
      scopeKey: 'bot:f0000000-0000-4000-8000-000000000001:user:e0000000-0000-4000-8000-000000000001',
      runId,
      channelId,
      revisionId,
      runtimeToken: 'u'.repeat(43),
      scopeMode: 'personalized',
      gatewayUrl: 'http://host.docker.internal:55100',
    })).rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });
    expect(requests).toHaveLength(10);

    rejectBrowserRotation = true;
    await expect(manager.ensureComputer({
      botId,
      scopeKey: `bot:${botId}`,
      runId,
      channelId,
      revisionId,
      runtimeToken: 'u'.repeat(43),
      scopeMode: 'team',
      gatewayUrl: 'http://host.docker.internal:55100',
      browserNetworkMode: 'public_only',
      browserEgressHosts: [],
      isolationTier: 'standard',
    })).rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_EGRESS_TOKEN_INVALID' });
    expect(requests.slice(-4).map(({ url }) => new URL(url).pathname)).toEqual([
      '/v1/gateway/origin',
      '/v1/ensure/computer',
      `${proxyPath}/v1/egress/rotate`,
      '/v1/stop',
    ]);
    rejectBrowserRotation = false;

    rejectEgressActivation = true;
    await expect(manager.ensureReasoning(input))
      .rejects.toMatchObject({ code: 'bot_runtime_egress_unavailable' });
    expect(requests.slice(-3).map(({ url }) => new URL(url).pathname)).toEqual([
      '/v1/ensure/reasoning',
      '/v1/revisions/activate',
      '/v1/stop',
    ]);
  });

  test('rejects malformed profile scopes and does not hide Docker inventory failures', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const manifest = releaseManifest();
    const stateStore = createMemoryStateStore({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });
    const runner = createFakeRunner();
    const originalRunProcess = runner.runProcess;
    runner.runProcess = async (file, args, options) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        runner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        return { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
      }
      return originalRunProcess(file, args, options);
    };
    const { manager } = createManager({ manifest, stateStore, runner, dataDirectory });
    const botId = 'b0000000-0000-4000-8000-000000000001';

    await expect(manager.exportBrowserProfiles(botId, [
      `bot:${botId}:user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
    ])).rejects.toMatchObject({ code: 'bot_runtime_request_invalid' });
    expect(runner.calls).toHaveLength(0);

    await expect(manager.exportBrowserProfiles(botId, [`bot:${botId}`]))
      .rejects.toMatchObject({ code: 'bot_runtime_profile_archive_failed' });
  });

  test('round-trips bounded owned browser profiles without exposing Docker-wide cleanup', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const manifest = releaseManifest();
    const initialState = {
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    };
    const botId = 'b0000000-0000-4000-8000-000000000001';
    const scopeKey = `bot:${botId}`;
    const deploymentId = deriveBotRuntimeServiceEnvironment(Buffer.alloc(32, 7), {
      dockerSocketGid: 20,
      hostRuntimeRoot: path.join(dataDirectory, 'bots', 'runtime'),
    }).DEVRYAN_BOT_DEPLOYMENT_ID;
    const digest = crypto.createHash('sha256')
      .update(`${deploymentId}\0${botId}\0computer\0${scopeKey}`, 'utf8')
      .digest('hex');
    const volumeName = `devryan-bot-computer-${digest.slice(0, 24)}-profile`;
    const labels = {
      'devryan.runtime': 'production-bots',
      'devryan.deployment': deploymentId,
      'devryan.bot': botId,
      'devryan.scope': `sha256:${digest}`,
      'devryan.kind': 'computer',
      'devryan.volume-role': 'profile',
    };
    const supervisorFetch = async () => new Response(JSON.stringify({
      ok: true,
      result: { stopped: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const exportRunner = createFakeRunner();
    const originalExportRun = exportRunner.runProcess;
    exportRunner.runProcess = async (file, args, options) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        exportRunner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        return { exitCode: 0, stdout: JSON.stringify(labels), stderr: '' };
      }
      if (args[0] === 'run') {
        exportRunner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        const archiveMount = args.find((argument) => argument.endsWith(':/archive:rw'));
        const directory = archiveMount.slice(0, -':/archive:rw'.length);
        await fs.writeFile(path.join(directory, 'profile.tgz'), 'bounded-profile-archive');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return originalExportRun(file, args, options);
    };
    const exported = createManager({
      manifest,
      stateStore: createMemoryStateStore(initialState),
      runner: exportRunner,
      dataDirectory,
      fetchImpl: supervisorFetch,
    });
    const archive = await exported.manager.exportBrowserProfiles(botId, [scopeKey]);
    expect(JSON.parse(archive.toString('utf8'))).toMatchObject({
      format: 'DevRyan.BotBrowserProfiles',
      botId,
      profiles: [{ scopeKey, size: 23 }],
    });

    const unsafeRunner = createFakeRunner();
    const originalUnsafeRun = unsafeRunner.runProcess;
    unsafeRunner.runProcess = async (file, args, options) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        unsafeRunner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        return { exitCode: 1, stdout: '', stderr: `Error: No such volume: ${volumeName}` };
      }
      if (args[0] === 'run') {
        unsafeRunner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        return args.includes('--verbose')
          ? {
              exitCode: 0,
              stdout: 'lrwxrwxrwx 10001/10001 0 2026-08-23 00:00 ./escape -> /host\n',
              stderr: '',
            }
          : { exitCode: 0, stdout: './escape\n', stderr: '' };
      }
      return originalUnsafeRun(file, args, options);
    };
    const unsafe = createManager({
      manifest,
      stateStore: createMemoryStateStore(initialState),
      runner: unsafeRunner,
      dataDirectory,
      fetchImpl: supervisorFetch,
    });
    await expect(unsafe.manager.restoreBrowserProfiles(botId, archive))
      .rejects.toMatchObject({ code: 'bot_runtime_profile_archive_invalid' });
    expect(unsafeRunner.calls.some(({ args }) => args[0] === 'volume' && args[1] === 'create'))
      .toBe(false);

    let created = false;
    const restoreRunner = createFakeRunner();
    const originalRestoreRun = restoreRunner.runProcess;
    restoreRunner.runProcess = async (file, args, options) => {
      if (args[0] === 'volume' && args[1] === 'inspect') {
        restoreRunner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        return created
          ? { exitCode: 0, stdout: JSON.stringify(labels), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: `Error: No such volume: ${volumeName}` };
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        restoreRunner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        created = true;
        return { exitCode: 0, stdout: `${volumeName}\n`, stderr: '' };
      }
      if (args[0] === 'run') {
        restoreRunner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        if (args.includes('--verbose')) {
          return {
            exitCode: 0,
            stdout: 'drwx------ 10001/10001 0 2026-08-23 00:00 ./\n-rw------- 10001/10001 15 2026-08-23 00:00 ./Cookies\n',
            stderr: '',
          };
        }
        if (args.includes('--list')) {
          return { exitCode: 0, stdout: './\n./Cookies\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return originalRestoreRun(file, args, options);
    };
    const restored = createManager({
      manifest,
      stateStore: createMemoryStateStore(initialState),
      runner: restoreRunner,
      dataDirectory,
      fetchImpl: supervisorFetch,
    });
    await expect(restored.manager.restoreBrowserProfiles(botId, archive))
      .resolves.toEqual({ restoredCount: 1 });
    const extractCall = restoreRunner.calls.find(({ args }) => (
      args[0] === 'run' && args.includes('-xzf')
    ));
    expect(extractCall.args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only', '--memory', '512m', '--cpus', '1',
      '--pids-limit', '64', '--cap-drop', 'ALL', '--user', '10001:10001',
      '--no-same-owner', '--no-overwrite-dir', '-C', '/data/chromium',
    ]));
    expect(extractCall.args).not.toContain('--same-owner');
  });

  test('rechecks profile-volume ownership immediately before purge', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const manifest = releaseManifest();
    const stateStore = createMemoryStateStore({
      version: 1,
      current: manifest,
      previous: null,
      staged: null,
    });
    const botId = 'b0000000-0000-4000-8000-000000000001';
    const volumeName = `devryan-bot-computer-${'a'.repeat(24)}-profile`;
    const runner = createFakeRunner();
    const originalRunProcess = runner.runProcess;
    runner.runProcess = async (file, args, options) => {
      if (args[0] === 'volume' && args[1] === 'ls') {
        runner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        return { exitCode: 0, stdout: `${volumeName}\n`, stderr: '' };
      }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        runner.calls.push({ file, args: [...args], env: { ...options.env }, shell: options.shell });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            'devryan.runtime': 'production-bots',
            'devryan.deployment': 'foreign-deployment',
            'devryan.bot': botId,
            'devryan.scope': `sha256:${'a'.repeat(64)}`,
            'devryan.kind': 'computer',
            'devryan.volume-role': 'profile',
          }),
          stderr: '',
        };
      }
      return originalRunProcess(file, args, options);
    };
    const { manager } = createManager({ manifest, stateStore, runner, dataDirectory });

    await expect(manager.deleteBrowserProfiles(botId))
      .rejects.toMatchObject({ code: 'bot_runtime_profile_archive_invalid' });
    expect(runner.calls.some(({ args }) => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
  });

  test('wires six local-only IPC verbs and a packaging-time release gate', async () => {
    const mainSource = await fs.readFile(new URL('../main.mjs', import.meta.url), 'utf8');
    const preloadSource = await fs.readFile(new URL('../preload.mjs', import.meta.url), 'utf8');
    const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const remoteCommandsBlock = mainSource.slice(
      mainSource.indexOf('const COMMANDS_SAFE_FOR_REMOTE'),
      mainSource.indexOf('const NATIVE_BROWSER_COMMANDS'),
    );
    const commands = [
      'desktop_bot_runtime_status',
      'desktop_bot_runtime_operation_status',
      'desktop_bot_runtime_setup',
      'desktop_bot_runtime_repair',
      'desktop_bot_runtime_update',
      'desktop_bot_runtime_rollback',
    ];

    for (const command of commands) {
      expect(mainSource).toContain(`case '${command}'`);
      expect(preloadSource).toContain(`'${command}'`);
      expect(remoteCommandsBlock).not.toContain(command);
    }
    expect(preloadSource).toContain(
      'if (localOrigin && !isLocalPage && LOCAL_ONLY_BOT_RUNTIME_COMMANDS.has(command))',
    );
    expect(mainSource).toContain(
      'if (!isLocalSender(event.sender) && !COMMANDS_SAFE_FOR_REMOTE.has(command))',
    );
    expect(packageJson.scripts.package).toStartWith(
      'DEVRYAN_BOT_RUNTIME_REQUIRE_RELEASE_MANIFEST=1 bun run build:web-assets',
    );
    expect(packageJson.scripts.package).toContain(
      'node ../../scripts/verify-bot-runtime-images.mjs --manifest ./resources/bot-runtime/images.release.json',
    );
    expect(packageJson.scripts.package).toContain(
      'DEVRYAN_BOT_RUNTIME_REQUIRE_RELEASE_MANIFEST=1 bun run bundle:main',
    );
    const compose = await fs.readFile(
      new URL('../../../docker/bots/compose.yml', import.meta.url),
      'utf8',
    );
    expect(compose).toContain('name: devryan-bot-runtime-state');
    expect(compose).toContain('name: devryan-bot-index');
    expect(compose).not.toMatch(/\bdown\b|--volumes|-v\b/);
  });
});
