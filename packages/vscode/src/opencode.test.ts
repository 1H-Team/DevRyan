import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getOpenChamberDataDir, readManagedOpenCodeRegistry } from './managedOpenCodeRegistry';

const spawnMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => '') })),
  },
  Disposable: class {
    dispose() {}
  },
}));

const {
  buildManagedOpenCodeEnvOverrides,
  buildManagedOpenCodeProcessEnv,
  buildManagedOpenCodeServeArgs,
  spawnManagedOpenCodeServer,
} = await import('./opencode');

// A pid far above any real pid range: `process.kill(-pid)` fails with ESRCH so
// the close path falls back to the fake child's own kill().
const FAKE_CHILD_PID = 4_000_000;

const createFakeChild = () => {
  const child = Object.assign(new EventEmitter(), {
    pid: FAKE_CHILD_PID,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  child.kill.mockImplementation(() => {
    child.exitCode = 0;
    child.emit('exit', 0);
    child.emit('close', 0);
    return true;
  });
  return child;
};

const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  spawnMock.mockReset();
  if (originalDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('VS Code managed OpenCode launch', () => {
  it('keeps configured bundled plugins enabled for managed serve', () => {
    expect(buildManagedOpenCodeServeArgs(45678)).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '45678',
    ]);
  });

  it('builds managed overlays without suppressing plugin origins', () => {
    const dataDir = getOpenChamberDataDir();
    expect(buildManagedOpenCodeEnvOverrides({
      overlayConfigDirectory: '/tmp/runtime-overlay',
      slimConfigDirectory: null,
      slimPreset: null,
    })).toEqual({
      CONTEXT_MODE_DATA_DIR: dataDir,
      CONTEXT_MODE_DIR: path.join(dataDir, 'context-mode'),
      OPENCODE_CONFIG_DIR: '/tmp/runtime-overlay',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true',
    });
  });

  it('injects only a complete private loopback bridge pair', () => {
    const overrides = buildManagedOpenCodeEnvOverrides({
      orchestrationEnvironment: {
        DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:43210/rpc',
        DEVRYAN_ORCHESTRATION_TOKEN: 'private-token',
      },
    });

    expect(buildManagedOpenCodeProcessEnv({
      PATH: '/bin',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'false',
      DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:9999/rpc',
      DEVRYAN_ORCHESTRATION_TOKEN: 'untrusted-token',
    }, overrides)).toMatchObject({
      PATH: '/bin',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:43210/rpc',
      DEVRYAN_ORCHESTRATION_TOKEN: 'private-token',
    });
    expect(buildManagedOpenCodeProcessEnv({
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    }, {}).OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined();
    const skillEnvironment = buildManagedOpenCodeProcessEnv({
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'false',
    }, {
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    });
    expect(skillEnvironment.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBeUndefined();
    expect(skillEnvironment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe('1');

    const withoutBridge = buildManagedOpenCodeProcessEnv({
      DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:9999/rpc',
      DEVRYAN_ORCHESTRATION_TOKEN: 'untrusted-token',
    }, {});
    expect(withoutBridge.DEVRYAN_ORCHESTRATION_URL).toBeUndefined();
    expect(withoutBridge.DEVRYAN_ORCHESTRATION_TOKEN).toBeUndefined();

    expect(() => buildManagedOpenCodeEnvOverrides({
      orchestrationEnvironment: {
        DEVRYAN_ORCHESTRATION_URL: 'http://127.0.0.1:43210/rpc',
      },
    })).toThrow('must be provided together');
    expect(() => buildManagedOpenCodeEnvOverrides({
      orchestrationEnvironment: {
        DEVRYAN_ORCHESTRATION_URL: 'http://localhost:43210/rpc',
        DEVRYAN_ORCHESTRATION_TOKEN: 'private-token',
      },
    })).toThrow('private IPv4 loopback');
    for (const invalidUrl of [
      'http://127.0.0.1/rpc',
      'http://user@127.0.0.1:43210/rpc',
      'http://127.0.0.1:43210/rpc?extra=true',
      'http://127.0.0.1:43210/rpc#fragment',
    ]) {
      expect(() => buildManagedOpenCodeEnvOverrides({
        orchestrationEnvironment: {
          DEVRYAN_ORCHESTRATION_URL: invalidUrl,
          DEVRYAN_ORCHESTRATION_TOKEN: 'private-token',
        },
      })).toThrow('private IPv4 loopback');
    }
  });
});

describe('VS Code managed OpenCode registration order', () => {
  it('registers the child (with its working directory) before readiness and unregisters on a failed start', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-registry-'));
    tempDirs.push(dataDir);
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    const child = createFakeChild();
    spawnMock.mockImplementation(() => child);

    const pending = spawnManagedOpenCodeServer('/tmp/workspace', 45678, 50);
    // Spawn is synchronous inside the call; the record must exist while the
    // readiness wait is still pending (no listening line has been emitted).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readManagedOpenCodeRegistry()).toEqual([
      expect.objectContaining({
        childPid: FAKE_CHILD_PID,
        ownerPid: process.pid,
        port: 45678,
        hostRuntime: 'vscode',
        workingDirectory: '/tmp/workspace',
      }),
    ]);

    await expect(pending).rejects.toThrow('Timeout waiting for server to start');
    expect(child.kill).toHaveBeenCalled();
    expect(readManagedOpenCodeRegistry()).toEqual([]);
  });
});
