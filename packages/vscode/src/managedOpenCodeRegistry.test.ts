import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildContextModeStorageEnv,
  getOpenChamberDataDir,
  isManagedOpenCodeProcessCommand,
  readManagedOpenCodeRegistry,
  reapOrphanedManagedOpenCodeProcesses,
  registerManagedOpenCodeProcess,
  unregisterManagedOpenCodeProcess,
} from './managedOpenCodeRegistry';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const createRegistryPath = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-managed-opencode-'));
  tempDirs.push(dir);
  return path.join(dir, 'registry.json');
};

describe('VS Code managed OpenCode process registry', () => {
  it('registers and unregisters a managed child process record', () => {
    const registryPath = createRegistryPath();

    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'vscode',
      hostname: '127.0.0.1',
      startedAt: 1234,
    }, { registryPath });

    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([
      expect.objectContaining({
        childPid: 200,
        ownerPid: 100,
        port: 45678,
        hostRuntime: 'vscode',
      }),
    ]);

    expect(unregisterManagedOpenCodeProcess(200, { registryPath })).toBe(true);
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([]);
  });

  it('skips owner-alive records and reaps verified orphan children only', async () => {
    const registryPath = createRegistryPath();
    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'vscode',
    }, { registryPath });
    registerManagedOpenCodeProcess({
      childPid: 201,
      ownerPid: 101,
      port: 45679,
      binary: 'opencode',
      hostRuntime: 'web',
    }, { registryPath });

    const terminate = vi.fn(async () => true);
    const result = await reapOrphanedManagedOpenCodeProcesses({
      registryPath,
      isProcessRunning: (pid) => pid === 100 || pid === 200 || pid === 201,
      readProcessCommand: (pid) => pid === 201
        ? 'opencode serve --hostname 127.0.0.1 --port 45679'
        : 'opencode serve --hostname 127.0.0.1 --port 45678',
      terminateManagedOpenCodePid: terminate,
    });

    expect(result.skipped).toEqual([expect.objectContaining({ childPid: 200, reason: 'owner-alive' })]);
    expect(result.reaped).toEqual([expect.objectContaining({ childPid: 201, terminated: true })]);
    expect(terminate).toHaveBeenCalledWith(201, expect.objectContaining({ port: 45679 }));
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([
      expect.objectContaining({ childPid: 200 }),
    ]);
  });

  it('does not reap a reused PID whose command no longer matches OpenCode serve', async () => {
    const registryPath = createRegistryPath();
    registerManagedOpenCodeProcess({
      childPid: 200,
      ownerPid: 100,
      port: 45678,
      binary: 'opencode',
      hostRuntime: 'vscode',
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
      hostRuntime: 'vscode',
      workingDirectory: '/tmp/workspace',
    }, { registryPath });

    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8')).version).toBe(2);
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([
      expect.objectContaining({ childPid: 300, workingDirectory: '/tmp/workspace' }),
    ]);

    fs.writeFileSync(registryPath, JSON.stringify({
      version: 1,
      processes: [{ childPid: 301, ownerPid: 100, port: 45679, binary: 'opencode', hostRuntime: 'vscode', startedAt: 5 }],
    }));
    expect(readManagedOpenCodeRegistry({ registryPath })).toEqual([
      expect.objectContaining({ childPid: 301, port: 45679, workingDirectory: null }),
    ]);
  });

  it('aligns context-mode storage under the OpenChamber data dir', () => {
    const dataDir = path.join(os.tmpdir(), 'openchamber-verify-data');
    expect(buildContextModeStorageEnv({ OPENCHAMBER_DATA_DIR: dataDir })).toEqual({
      CONTEXT_MODE_DATA_DIR: path.resolve(dataDir),
      CONTEXT_MODE_DIR: path.join(path.resolve(dataDir), 'context-mode'),
    });
    expect(getOpenChamberDataDir({ OPENCHAMBER_DATA_DIR: dataDir })).toBe(path.resolve(dataDir));
  });
});
