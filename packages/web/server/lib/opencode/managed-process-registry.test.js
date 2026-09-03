import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContextModeStorageEnv,
  getOpenChamberDataDir,
  isManagedOpenCodeProcessCommand,
  readManagedOpenCodeRegistry,
  reapOrphanedManagedOpenCodeProcesses,
  registerManagedOpenCodeProcess,
  terminateManagedOpenCodePid,
  unregisterManagedOpenCodeProcess,
} from './managed-process-registry.js';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const createRegistryPath = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'devryan-managed-opencode-'));
  tempDirs.push(dir);
  return path.join(dir, 'registry.json');
};

describe('managed OpenCode process registry', () => {
  it('registers and unregisters a managed child process record', () => {
    const registryPath = createRegistryPath();

    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'web',
      startedAt: 1234,
    }, { registryPath });

    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([
      expect.objectContaining({
        childPid: 200,
        ownerPid: 100,
        port: 45678,
        binary: 'opencode',
        hostRuntime: 'web',
      }),
    ]);

    expect(unregisterManagedOpenCodeProcess(200, { registryPath })).toBe(true);
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([]);
  });

  it('keeps a record when the owner process is still alive', async () => {
    const registryPath = createRegistryPath();
    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'web',
    }, { registryPath });

    const terminate = vi.fn();
    const result = await reapOrphanedManagedOpenCodeProcesses({
      registryPath,
      isProcessRunning: (pid) => pid === 100 || pid === 200,
      readProcessCommand: () => 'opencode serve --hostname 127.0.0.1 --port 45678',
      terminateManagedOpenCodePid: terminate,
    });

    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'owner-alive' })]);
    expect(result.reaped).toEqual([]);
    expect(terminate).not.toHaveBeenCalled();
    expect(readManagedOpenCodeRegistry({ registryPath })).toHaveLength(1);
  });

  it('reaps an orphaned managed child whose command matches the registry', async () => {
    const registryPath = createRegistryPath();
    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'web',
    }, { registryPath });

    const terminate = vi.fn(async () => true);
    const result = await reapOrphanedManagedOpenCodeProcesses({
      registryPath,
      isProcessRunning: (pid) => pid === 200,
      readProcessCommand: () => 'opencode serve --hostname 127.0.0.1 --port 45678',
      terminateManagedOpenCodePid: terminate,
    });

    expect(result.reaped).toEqual([expect.objectContaining({ childPid: 200, terminated: true })]);
    expect(terminate).toHaveBeenCalledWith(200, expect.objectContaining({ port: 45678 }));
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([]);
  });

  it('drops dead-child records without trying to kill anything', async () => {
    const registryPath = createRegistryPath();
    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'web',
    }, { registryPath });

    const terminate = vi.fn();
    const result = await reapOrphanedManagedOpenCodeProcesses({
      registryPath,
      isProcessRunning: () => false,
      readProcessCommand: () => 'opencode serve --hostname 127.0.0.1 --port 45678',
      terminateManagedOpenCodePid: terminate,
    });

    expect(result.removed).toEqual([expect.objectContaining({ reason: 'child-not-running' })]);
    expect(terminate).not.toHaveBeenCalled();
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([]);
  });

  it('takes over a stale registry lock instead of blocking writers', () => {
    const registryPath = createRegistryPath();
    const lockPath = `${registryPath}.lock`;
    mkdirSync(lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTime, staleTime);

    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'web',
    }, { registryPath });

    expect(readManagedOpenCodeRegistry({ registryPath })).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('keeps records registered by another process during a slow sweep', async () => {
    const registryPath = createRegistryPath();
    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'web',
    }, { registryPath });

    const result = await reapOrphanedManagedOpenCodeProcesses({
      registryPath,
      isProcessRunning: (pid) => pid === 200,
      readProcessCommand: () => 'opencode serve --hostname 127.0.0.1 --port 45678',
      terminateManagedOpenCodePid: async () => {
        // Simulates a concurrent process registering its child mid-sweep.
        registerManagedOpenCodeProcess({
          childPid: 300,
          ownerPid: 101,
          port: 45679,
          binary: 'opencode',
          hostRuntime: 'web',
        }, { registryPath });
        return true;
      },
    });

    expect(result.reaped).toEqual([expect.objectContaining({ childPid: 200 })]);
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([
      expect.objectContaining({ childPid: 300 }),
    ]);
  });

  it('does not reap a reused PID whose command is no longer OpenCode', async () => {
    const registryPath = createRegistryPath();
    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'web',
    }, { registryPath });

    const terminate = vi.fn();
    const result = await reapOrphanedManagedOpenCodeProcesses({
      registryPath,
      isProcessRunning: (pid) => pid === 200,
      readProcessCommand: () => '/usr/bin/python3 /tmp/server.py',
      terminateManagedOpenCodePid: terminate,
    });

    expect(result.removed).toEqual([expect.objectContaining({ reason: 'command-mismatch' })]);
    expect(result.reaped).toEqual([]);
    expect(terminate).not.toHaveBeenCalled();
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([]);
  });

  it('requires the registered port when matching OpenCode commands', () => {
    expect(isManagedOpenCodeProcessCommand(
      'opencode serve --hostname 127.0.0.1 --port 45678',
      { binary: 'opencode', port: 45678 },
    )).toBe(true);
    expect(isManagedOpenCodeProcessCommand(
      'opencode serve --hostname 127.0.0.1 --port 4096',
      { binary: 'opencode', port: 45678 },
    )).toBe(false);
  });

  it('persists the working directory (registry v2) and reads v1 files without one', () => {
    const registryPath = createRegistryPath();
    registerManagedOpenCodeProcess({
      childPid: 300,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'web',
      workingDirectory: '/tmp/project ',
    }, { registryPath });

    const written = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(written.version).toBe(2);
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([
      expect.objectContaining({ childPid: 300, workingDirectory: '/tmp/project' }),
    ]);

    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      processes: [{ childPid: 301, ownerPid: 100, port: 45679, binary: 'opencode', hostRuntime: 'web', startedAt: 5 }],
    }));
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([
      expect.objectContaining({ childPid: 301, port: 45679, workingDirectory: null }),
    ]);
  });

  it('signals listed descendants alongside the target group when terminating', async () => {
    let alive = true;
    // Signal 0 is the liveness probe; the target dies on the first TERM round.
    // `-200` (group kill) fails so the fallback signals the pid directly.
    const processKill = vi.fn((pid, signal) => {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        return true;
      }
      if (pid === -200) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      alive = false;
      return true;
    });

    await expect(terminateManagedOpenCodePid(200, {
      platform: 'darwin',
      processKill,
      descendantPids: [201, 202, 200, 0, 'x'],
    })).resolves.toBe(true);

    const termCalls = processKill.mock.calls.filter(([, signal]) => signal === 'SIGTERM').map(([pid]) => pid);
    expect(termCalls).toEqual([-200, 200, 201, 202]);
  });

  it('aligns context-mode storage under the OpenChamber data dir', () => {
    const dataDir = path.join(tmpdir(), 'openchamber-verify-data');
    expect(buildContextModeStorageEnv({ OPENCHAMBER_DATA_DIR: dataDir })).toEqual({
      CONTEXT_MODE_DATA_DIR: path.resolve(dataDir),
      CONTEXT_MODE_DIR: path.join(path.resolve(dataDir), 'context-mode'),
    });
    expect(getOpenChamberDataDir({ OPENCHAMBER_DATA_DIR: dataDir })).toBe(path.resolve(dataDir));
  });
});
