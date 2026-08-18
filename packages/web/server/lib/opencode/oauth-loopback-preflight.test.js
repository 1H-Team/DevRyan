import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OPENAI_OAUTH_LOOPBACK_PORT,
  describeOAuthLoopbackConflict,
  ensureOAuthLoopbackPortAvailable,
  inspectOAuthLoopbackPort,
  listPortListenerPids,
} from './oauth-loopback-preflight.js';

let dataDir;

const writeRegistry = (processes) => {
  fs.writeFileSync(
    path.join(dataDir, 'managed-opencode-processes.json'),
    JSON.stringify({ version: 1, processes }, null, 2),
  );
};

const baseOptions = (overrides = {}) => ({
  env: { OPENCHAMBER_DATA_DIR: dataDir },
  registryPath: path.join(dataDir, 'managed-opencode-processes.json'),
  ownerPid: 1000,
  selfPid: 999,
  ...overrides,
});

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-loopback-'));
  writeRegistry([]);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('listPortListenerPids', () => {
  it('parses lsof output, de-duplicates, and drops our own pid', () => {
    const pids = listPortListenerPids(OPENAI_OAUTH_LOOPBACK_PORT, {
      platform: 'darwin',
      selfPid: 999,
      spawnSync: () => ({ stdout: '4242\n4242\n999\n5555\n' }),
    });
    expect(pids).toEqual([4242, 5555]);
  });

  it('returns nothing on win32 and when lsof throws', () => {
    expect(listPortListenerPids(1455, { platform: 'win32' })).toEqual([]);
    expect(listPortListenerPids(1455, {
      platform: 'darwin',
      spawnSync: () => { throw new Error('lsof missing'); },
    })).toEqual([]);
  });
});

describe('inspectOAuthLoopbackPort', () => {
  it('reports a free port as not busy', () => {
    const result = inspectOAuthLoopbackPort(baseOptions({ listPortListenerPids: () => [] }));
    expect(result).toEqual({ port: OPENAI_OAUTH_LOOPBACK_PORT, busy: false, holders: [] });
  });

  it('does not treat our own managed child as a blocker', () => {
    writeRegistry([{ childPid: 4242, ownerPid: 1000, port: 50000, binary: 'opencode' }]);
    const result = inspectOAuthLoopbackPort(baseOptions({
      listPortListenerPids: () => [4242],
      isProcessRunning: () => true,
      readProcessCommand: () => '/bin/opencode serve --port 50000',
    }));

    expect(result.busy).toBe(true);
    expect(result.holders[0]).toMatchObject({ pid: 4242, ownedByThisHost: true, reapable: false });
  });

  it('marks a tracked OpenCode server with a dead owner as reapable', () => {
    writeRegistry([{ childPid: 4242, ownerPid: 777, port: 50000, binary: 'opencode' }]);
    const result = inspectOAuthLoopbackPort(baseOptions({
      listPortListenerPids: () => [4242],
      isProcessRunning: (pid) => pid !== 777,
      readProcessCommand: () => '/bin/opencode serve --port 50000',
    }));

    expect(result.holders[0]).toMatchObject({
      tracked: true,
      ownedByThisHost: false,
      ownerAlive: false,
      looksLikeOpenCode: true,
      reapable: true,
    });
  });

  it('never marks an untracked or foreign process reapable', () => {
    const result = inspectOAuthLoopbackPort(baseOptions({
      listPortListenerPids: () => [8888],
      isProcessRunning: () => false,
      readProcessCommand: () => '/usr/bin/some-other-server --port 1455',
    }));

    expect(result.holders[0]).toMatchObject({ tracked: false, reapable: false });
  });

  it('does not reap a tracked server whose owner is still alive', () => {
    writeRegistry([{ childPid: 4242, ownerPid: 777, port: 50000, binary: 'opencode' }]);
    const result = inspectOAuthLoopbackPort(baseOptions({
      listPortListenerPids: () => [4242],
      isProcessRunning: () => true,
      readProcessCommand: () => '/bin/opencode serve --port 50000',
    }));

    expect(result.holders[0]).toMatchObject({ ownerAlive: true, reapable: false });
  });
});

describe('ensureOAuthLoopbackPortAvailable', () => {
  it('passes when the port is free', async () => {
    const result = await ensureOAuthLoopbackPortAvailable(baseOptions({ listPortListenerPids: () => [] }));
    expect(result.ok).toBe(true);
    expect(result.reaped).toEqual([]);
  });

  it('reaps a provable orphan and proceeds once the port clears', async () => {
    writeRegistry([{ childPid: 4242, ownerPid: 777, port: 50000, binary: 'opencode' }]);
    const terminated = [];
    let cleared = false;

    const result = await ensureOAuthLoopbackPortAvailable(baseOptions({
      listPortListenerPids: () => (cleared ? [] : [4242]),
      isProcessRunning: (pid) => pid !== 777,
      readProcessCommand: () => '/bin/opencode serve --port 50000',
      terminateManagedOpenCodePid: (pid) => { terminated.push(pid); cleared = true; return true; },
    }));

    expect(terminated).toEqual([4242]);
    expect(result.ok).toBe(true);
    expect(result.reaped).toEqual([4242]);
  });

  it('blocks with an actionable message when an unknown process squats the port', async () => {
    const terminated = [];
    const result = await ensureOAuthLoopbackPortAvailable(baseOptions({
      listPortListenerPids: () => [8888],
      isProcessRunning: () => true,
      readProcessCommand: () => '/usr/bin/rogue --serve',
      terminateManagedOpenCodePid: (pid) => { terminated.push(pid); return true; },
    }));

    expect(terminated).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('1455');
    expect(result.message).toContain('8888');
  });

  it('still blocks when the orphan refuses to die', async () => {
    writeRegistry([{ childPid: 4242, ownerPid: 777, port: 50000, binary: 'opencode' }]);
    const result = await ensureOAuthLoopbackPortAvailable(baseOptions({
      listPortListenerPids: () => [4242],
      isProcessRunning: (pid) => pid !== 777,
      readProcessCommand: () => '/bin/opencode serve --port 50000',
      terminateManagedOpenCodePid: () => false,
    }));

    expect(result.ok).toBe(false);
    expect(result.reaped).toEqual([]);
  });
});

describe('describeOAuthLoopbackConflict', () => {
  it('names the port and every blocking process', () => {
    const message = describeOAuthLoopbackConflict({
      port: 1455,
      holders: [
        { pid: 11, command: '/bin/opencode serve --port 1', ownedByThisHost: false },
        { pid: 22, command: null, ownedByThisHost: false },
      ],
    });

    expect(message).toContain('port 1455');
    expect(message).toContain('PID 11');
    expect(message).toContain('PID 22 (unknown process)');
    expect(message).toContain('2 other processes are');
  });

  it('flattens ps octal escapes and marks truncation', () => {
    const message = describeOAuthLoopbackConflict({
      port: 1455,
      holders: [{ pid: 11, command: `node -e \\012require('net')\\012${'x'.repeat(200)}`, ownedByThisHost: false }],
    });

    expect(message).not.toContain('\\012');
    expect(message).toContain('…');
  });

  it('excludes our own child from the blocker list', () => {
    const message = describeOAuthLoopbackConflict({
      port: 1455,
      holders: [
        { pid: 11, command: 'opencode serve', ownedByThisHost: true },
        { pid: 22, command: 'rogue', ownedByThisHost: false },
      ],
    });

    expect(message).toContain('another process is');
    expect(message).not.toContain('PID 11');
  });
});
