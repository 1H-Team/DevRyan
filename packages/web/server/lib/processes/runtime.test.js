import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  classifyProcessCommand,
  createProcessesRuntime,
  extractSessionMarker,
  parseLsofListeners,
  parseProcessStartTime,
  parsePsEnvironmentTable,
  parsePsTable,
} from './runtime.js';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const createDataDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'devryan-processes-'));
  tempDirs.push(dir);
  return dir;
};

const PS_TABLE = [
  '  100     1   100 Thu Sep  3 20:00:00 2026 /usr/local/bin/opencode serve --hostname 127.0.0.1 --port 45678',
  '  200   100   100 Thu Sep  3 20:01:00 2026 /bin/sh -c export DEVRYAN_SESSION_ID=ses_a; npm run dev &',
  '  201   200   100 Thu Sep  3 20:01:01 2026 node /repo/node_modules/.bin/vite --port 5173',
  '  202   201   100 Thu Sep  3 20:01:02 2026 /usr/bin/esbuild --service=0.21.0 --ping',
  '  210   100   100 Thu Sep  3 20:02:00 2026 node /repo/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot',
  '  220   100   100 Thu Sep  3 20:03:00 2026 claude -p hello',
  '  230   100   100 Thu Sep  3 20:03:30 2026 npx -y @modelcontextprotocol/server-filesystem /repo',
  '  240   100   100 Thu Sep  3 20:04:00 2026 sleep 1000',
  '  300     1   300 Thu Sep  3 19:00:00 2026 opencode serve --hostname 127.0.0.1 --port 4096',
  '  400     1   400 Thu Sep  3 19:30:00 2026 /usr/bin/other-daemon',
  '  500   400   500 Thu Sep  3 19:31:00 2026 node other.js',
  '',
].join('\n');

const PS_ENV_TABLE = [
  '200 /bin/sh -c export DEVRYAN_SESSION_ID=ses_a; npm run dev &',
  '201 node /repo/node_modules/.bin/vite --port 5173 PATH=/usr/bin DEVRYAN_SESSION_ID=ses_a HOME=/Users/x',
  '202 /usr/bin/esbuild --service=0.21.0 --ping',
  '210 node /repo/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot PATH=/usr/bin',
  '220 claude -p hello PATH=/usr/bin DEVRYAN_SESSION_ID=ses_b',
  '230 npx -y @modelcontextprotocol/server-filesystem /repo',
  '240 sleep 1000',
  '',
].join('\n');

const LSOF_OUTPUT = 'p201\nf20\nn*:5173\nf21\nn127.0.0.1:5173\np300\nf9\nn127.0.0.1:4096\n';

const REGISTRY = [{
  childPid: 100,
  ownerPid: 1000,
  port: 45678,
  binary: 'opencode',
  hostRuntime: 'web',
  hostname: '127.0.0.1',
  startedAt: 1,
  workingDirectory: '/repo',
}];

const createExec = (overrides = {}) => vi.fn(async (command, args) => {
  if (command === 'ps' && args.includes('-axo')) return overrides.ps ?? PS_TABLE;
  if (command === 'ps' && args.includes('-E')) return overrides.env ?? PS_ENV_TABLE;
  if (command === 'lsof') return overrides.lsof ?? LSOF_OUTPUT;
  throw new Error(`unexpected exec ${command} ${args.join(' ')}`);
});

const createRuntime = (options = {}) => {
  const dataDir = options.dataDir ?? createDataDir();
  const terminate = options.terminate ?? vi.fn(async () => true);
  const exec = options.exec ?? createExec(options.execOverrides);
  const runtime = createProcessesRuntime({
    platform: options.platform ?? 'darwin',
    dataDir,
    exec,
    terminate,
    readRegistry: () => options.registry ?? REGISTRY,
    readFile: options.readFile,
    now: () => Date.parse('2026-09-03T20:10:00'),
    log: () => {},
  });
  return { runtime, terminate, exec, dataDir };
};

describe('process command classification', () => {
  it.each([
    ['npm run dev', 'dev_server'],
    ['bun run --shell=bun dev', 'dev_server'],
    ['pnpm dev:web', 'dev_server'],
    ['yarn start', 'dev_server'],
    ['npm run preview', 'dev_server'],
    ['bun run serve', 'dev_server'],
    ['npm run develop', 'dev_server'],
    ['node /repo/node_modules/.bin/vite --port 5173', 'dev_server'],
    ['node /repo/node_modules/vite/bin/vite.js', 'dev_server'],
    ['next dev -p 3000', 'dev_server'],
    ['python3 -m http.server 8000', 'dev_server'],
    ['webpack-dev-server --hot', 'dev_server'],
    ['vite build', 'other'],
    ['npm run build', 'other'],
    ['claude -p "fix it"', 'agent_cli'],
    ['/usr/local/bin/claude --dangerously-skip-permissions', 'agent_cli'],
    ['node tsserver.js', 'lsp'],
    ['typescript-language-server --stdio', 'lsp'],
    ['pyright-langserver --stdio', 'lsp'],
    ['npx -y @modelcontextprotocol/server-filesystem /repo', 'mcp'],
    ['node /x/mcp-server-git/index.js', 'mcp'],
    ['sleep 1000', 'other'],
    ['', 'other'],
  ])('classifies %s as %s', (command, category) => {
    expect(classifyProcessCommand(command)).toBe(category);
  });
});

describe('ps / lsof / environment parsers', () => {
  it('parses lstart timestamps in local time', () => {
    expect(parseProcessStartTime('Thu Sep  3 20:40:50 2026')).toBe(new Date(2026, 8, 3, 20, 40, 50).getTime());
    expect(parseProcessStartTime('garbage')).toBeNull();
  });

  it('parses the ps table into rows and keeps the full command text', () => {
    const rows = parsePsTable(PS_TABLE);
    expect(rows).toHaveLength(11);
    expect(rows[1]).toEqual({
      pid: 200,
      ppid: 100,
      pgid: 100,
      startedAt: new Date(2026, 8, 3, 20, 1, 0).getTime(),
      command: '/bin/sh -c export DEVRYAN_SESSION_ID=ses_a; npm run dev &',
    });
  });

  it('parses lsof field output into listening ports per pid', () => {
    const ports = parseLsofListeners(LSOF_OUTPUT);
    expect([...ports.get(201)]).toEqual([5173]);
    expect([...ports.get(300)]).toEqual([4096]);
  });

  it('extracts the last session marker and ignores shell punctuation', () => {
    expect(extractSessionMarker('sh -c export DEVRYAN_SESSION_ID=ses_a; npm run dev')).toBe('ses_a');
    expect(extractSessionMarker('node x PATH=/bin DEVRYAN_SESSION_ID=ses_b HOME=/h')).toBe('ses_b');
    expect(extractSessionMarker('node x PATH=/bin')).toBeNull();
    expect(parsePsEnvironmentTable(PS_ENV_TABLE).get(220)).toBe('ses_b');
    expect(parsePsEnvironmentTable(PS_ENV_TABLE).get(240)).toBeNull();
  });
});

describe('processes runtime snapshot', () => {
  it('lists descendants of managed servers with categories, ports, and session attribution', async () => {
    const { runtime } = createRuntime();
    const snapshot = await runtime.snapshot();

    expect(snapshot.supported).toBe(true);
    expect(snapshot.processes.map((entry) => entry.pid)).toEqual([200, 210, 220, 230, 240, 201, 202]);
    const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));

    expect(byPid.get(200)).toMatchObject({ category: 'dev_server', sessionId: 'ses_a', ports: [], workingDirectory: '/repo' });
    expect(byPid.get(201)).toMatchObject({ category: 'dev_server', sessionId: 'ses_a', ports: [5173], ppid: 200, pgid: 100 });
    // Environment hidden (platform binary) -> inherits the attributed ancestor.
    expect(byPid.get(202)).toMatchObject({ category: 'other', sessionId: 'ses_a' });
    expect(byPid.get(210)).toMatchObject({ category: 'lsp', sessionId: null });
    expect(byPid.get(220)).toMatchObject({ category: 'agent_cli', sessionId: 'ses_b' });
    expect(byPid.get(230)).toMatchObject({ category: 'mcp' });
    expect(byPid.get(240)).toMatchObject({ category: 'other', sessionId: null });
    expect(byPid.get(201).ageMs).toBe(Date.parse('2026-09-03T20:10:00') - new Date(2026, 8, 3, 20, 1, 1).getTime());
  });

  it('lists orphaned opencode servers (ppid 1, not in the registry) without touching them', async () => {
    const { runtime, terminate } = createRuntime();
    const snapshot = await runtime.snapshot();

    expect(snapshot.orphanServers).toEqual([
      expect.objectContaining({ pid: 300, port: 4096, command: 'opencode serve --hostname 127.0.0.1 --port 4096' }),
    ]);
    expect(snapshot.processes.some((entry) => entry.pid === 100 || entry.pid === 300 || entry.pid === 500)).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('filters managed servers by working directory while keeping v1 records without one', async () => {
    const { runtime } = createRuntime();
    expect((await runtime.snapshot({ directory: '/repo' })).processes).toHaveLength(7);
    expect((await runtime.snapshot({ directory: '/elsewhere' })).processes).toHaveLength(0);

    const legacy = createRuntime({ registry: [{ ...REGISTRY[0], workingDirectory: null }] });
    expect((await legacy.runtime.snapshot({ directory: '/elsewhere' })).processes).toHaveLength(7);
  });

  it('reads /proc environ on linux', async () => {
    const readFile = vi.fn((filePath) => {
      if (filePath === '/proc/240/environ') return 'PATH=/bin\0DEVRYAN_SESSION_ID=ses_linux\0HOME=/h\0';
      throw new Error('EACCES');
    });
    const { runtime, exec } = createRuntime({ platform: 'linux', readFile });
    const snapshot = await runtime.snapshot();

    expect(snapshot.processes.find((entry) => entry.pid === 240).sessionId).toBe('ses_linux');
    expect(exec.mock.calls.some(([command, args]) => command === 'ps' && args.includes('-E'))).toBe(false);
  });

  it('reports unsupported platforms without spawning anything', async () => {
    const { runtime, exec } = createRuntime({ platform: 'win32' });
    expect(await runtime.snapshot()).toMatchObject({ supported: false, processes: [], orphanServers: [] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('survives lsof and ps -E failures', async () => {
    const exec = vi.fn(async (command, args) => {
      if (command === 'ps' && args.includes('-axo')) return PS_TABLE;
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    });
    const { runtime } = createRuntime({ exec });
    const snapshot = await runtime.snapshot();
    expect(snapshot.processes).toHaveLength(7);
    expect(snapshot.processes.find((entry) => entry.pid === 201)).toMatchObject({ ports: [], sessionId: 'ses_a' });
  });
});

describe('processes runtime stop', () => {
  it('refuses unknown pids', async () => {
    const { runtime, terminate } = createRuntime();
    await expect(runtime.stopProcess({ pid: 999, startedAt: 1 })).rejects.toMatchObject({ statusCode: 404, code: 'process_not_found' });
    await expect(runtime.stopProcess({ pid: 100, startedAt: 1 })).rejects.toMatchObject({ statusCode: 404 });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('refuses a pid whose start time no longer matches (pid reuse)', async () => {
    const { runtime, terminate } = createRuntime();
    await expect(runtime.stopProcess({ pid: 201, startedAt: 12345 })).rejects.toMatchObject({ statusCode: 409, code: 'process_restarted' });
    await expect(runtime.stopProcess({ pid: 201 })).rejects.toMatchObject({ statusCode: 409 });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('terminates a matching pid together with its descendants', async () => {
    const { runtime, terminate } = createRuntime();
    const startedAt = new Date(2026, 8, 3, 20, 1, 1).getTime();
    const result = await runtime.stopProcess({ pid: 201, startedAt });

    expect(terminate).toHaveBeenCalledWith(201, { descendantPids: [202] });
    expect(result).toEqual({ pid: 201, terminated: true, stoppedDescendants: [202] });
  });

  it('can stop an orphaned server when its start time matches', async () => {
    const { runtime, terminate } = createRuntime();
    const startedAt = new Date(2026, 8, 3, 19, 0, 0).getTime();
    await expect(runtime.stopProcess({ pid: 300, startedAt: startedAt + 400 })).resolves.toMatchObject({ pid: 300, terminated: true });
    expect(terminate).toHaveBeenCalledWith(300, { descendantPids: [] });
  });
});

describe('project tracking setting', () => {
  it('defaults to off and round-trips through the tracking file', async () => {
    const { runtime, dataDir } = createRuntime();
    expect(await runtime.getProjectSetting('/repo')).toEqual({ directory: '/repo', trackAgentProcesses: false, heavyCheckSlots: 2 });

    await runtime.setProjectSetting('/repo/', { trackAgentProcesses: true });
    expect(await runtime.getProjectSetting('/repo')).toMatchObject({ trackAgentProcesses: true, heavyCheckSlots: 2 });
    expect(runtime.trackingFilePath).toBe(path.join(dataDir, 'processes', 'tracking.json'));

    await runtime.setProjectSetting('/repo', { heavyCheckSlots: 0 });
    expect(await runtime.getProjectSetting('/repo')).toMatchObject({ trackAgentProcesses: true, heavyCheckSlots: 0 });

    const reread = createProcessesRuntime({ dataDir, platform: 'darwin', exec: createExec(), readRegistry: () => [] });
    expect(reread.isTrackingEnabled('/repo')).toBe(true);
    expect(reread.isTrackingEnabled('/repo/packages/ui')).toBe(true);
    expect(reread.isTrackingEnabled('/repository')).toBe(false);
    await expect(runtime.getProjectSetting('')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('tolerates a corrupt tracking file', async () => {
    const dataDir = createDataDir();
    mkdirSync(path.join(dataDir, 'processes'), { recursive: true });
    writeFileSync(path.join(dataDir, 'processes', 'tracking.json'), '{not json');
    const { runtime } = createRuntime({ dataDir });
    expect(await runtime.getProjectSetting('/repo')).toMatchObject({ trackAgentProcesses: false });
  });
});

describe('session delete auto-stop', () => {
  it('does nothing while tracking is off', async () => {
    const { runtime, terminate } = createRuntime();
    const result = await runtime.stopSessionDevServers('ses_a', { directory: '/repo' });
    expect(result.stopped).toEqual([]);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('stops only dev servers attributed to the deleted session, once per tree', async () => {
    const { runtime, terminate } = createRuntime();
    await runtime.setProjectSetting('/repo', { trackAgentProcesses: true });

    const result = await runtime.stopSessionDevServers('ses_a', { directory: '/repo' });

    expect(result.stopped).toEqual([{ pid: 200, terminated: true, stoppedDescendants: [201, 202] }]);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(200, { descendantPids: [201, 202] });
  });

  it('falls back to the managed server working directory when the request has none', async () => {
    const { runtime, terminate } = createRuntime();
    await runtime.setProjectSetting('/repo', { trackAgentProcesses: true });
    await runtime.stopSessionDevServers('ses_a');
    expect(terminate).toHaveBeenCalledTimes(1);

    // The agent CLI attributed to ses_b is not a dev server: never touched.
    terminate.mockClear();
    const result = await runtime.stopSessionDevServers('ses_b');
    expect(result.stopped).toEqual([]);
    expect(terminate).not.toHaveBeenCalled();
  });
});
