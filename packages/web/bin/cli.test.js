import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import { pathToFileURL } from 'url';

import { isModuleCliExecution, normalizeCliEntryPath } from './cli-entry.js';
import {
  assertAuthenticatedNetworkExposure,
  DEFAULT_DAEMON_READY_TIMEOUT_MS,
  isDevRyanPidFileCommand,
  normalizeDaemonReadyTimeoutMs,
  parseArgs,
  buildTunnelStartReplayCommand,
  sanitizeTunnelProfilesData,
  terminateDaemonChild,
  validatePidFileIdentity,
  waitForDaemonReadyMessage,
} from './cli.js';

describe('network-exposed auth validation', () => {
  it('allows loopback without a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '127.0.0.1' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: 'localhost' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: '::1' })).not.toThrow();
  });

  it('requires a UI password for LAN and wildcard bind hosts', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).toThrow(/refuses to bind/);
    expect(() => assertAuthenticatedNetworkExposure({ host: '192.168.1.10' })).toThrow(/refuses to bind/);
  });

  it('allows network-exposed bind hosts with a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0', uiPassword: 'secret' })).not.toThrow();
  });

  it('allows explicit unsafe LAN override from process env only', () => {
    const previous = process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
    process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = 'true';
    try {
      expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).not.toThrow();
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = previous;
      } else {
        delete process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
      }
    }
  });
});

describe('cli args', () => {
  it('accepts legacy daemon flags as no-ops', () => {
    expect(parseArgs(['serve', '--daemon']).removedFlagErrors).toEqual([]);
    expect(parseArgs(['serve', '-d']).removedFlagErrors).toEqual([]);
  });

  it('parses and validates managed remote origin ports in every output mode', () => {
    for (const outputFlag of [[], ['--json'], ['--quiet']]) {
      const parsed = parseArgs([
        'tunnel', 'start', '--mode', 'managed-remote', '--origin-port', '3000', ...outputFlag,
      ]);
      expect(parsed.options).toMatchObject({ originPort: 3000, explicitOriginPort: true });
    }

    expect(() => parseArgs(['tunnel', 'start', '--origin-port', '1023'])).toThrow(/between 1024 and 65535/);
    expect(() => parseArgs(['tunnel', 'start', '--origin-port', '65536'])).toThrow(/between 1024 and 65535/);
  });

  it('migrates v1 profile data to schema v2 defaults and includes the port in replay commands', () => {
    const token = `eyJ${'x'.repeat(80)}`;
    const migrated = sanitizeTunnelProfilesData({
      version: 1,
      profiles: [{
        id: 'legacy',
        name: 'Legacy',
        provider: 'cloudflare',
        mode: 'managed-remote',
        hostname: 'app.example.com',
        token,
      }],
    });

    expect(migrated).toMatchObject({
      version: 2,
      profiles: [{ id: 'legacy', originPort: 3000 }],
    });
    expect(buildTunnelStartReplayCommand({
      port: 57123,
      provider: 'cloudflare',
      mode: 'managed-remote',
      hostname: 'app.example.com',
      originPort: 3000,
    })).toContain('--origin-port 3000');
  });
});

describe('cli entry detection', () => {
  const modulePath = '/tmp/openchamber/bin/cli.js';
  const moduleUrl = pathToFileURL(modulePath).href;

  it('resolves symlinked entry paths before comparing', () => {
    const symlinkPath = '/usr/local/bin/openchamber';
    const realpath = (filePath) => {
      if (filePath === path.resolve(symlinkPath)) {
        return modulePath;
      }
      return filePath;
    };

    expect(isModuleCliExecution(symlinkPath, moduleUrl, realpath)).toBe(true);
  });

  it('falls back to resolved paths when realpath fails', () => {
    const realpath = () => {
      throw new Error('realpath unavailable');
    };

    expect(isModuleCliExecution(modulePath, moduleUrl, realpath)).toBe(true);
  });

  it('returns false for non-matching entry path', () => {
    expect(isModuleCliExecution('/tmp/other-cli.js', moduleUrl)).toBe(false);
  });

  it('returns false for empty entry path', () => {
    expect(isModuleCliExecution('', moduleUrl)).toBe(false);
  });

  it('returns false when module url is not provided', () => {
    expect(isModuleCliExecution(modulePath)).toBe(false);
  });

  it('accepts wrapper binary name fallback when requested', () => {
    const wrapperPath = '/home/user/.local/bin/openchamber';
    expect(isModuleCliExecution(wrapperPath, moduleUrl, undefined, 'openchamber')).toBe(true);
  });

  it('normalizes direct paths when realpath fails', () => {
    const unresolvedPath = './packages/web/bin/cli.js';
    const realpath = () => {
      throw new Error('no symlink resolution');
    };

    expect(normalizeCliEntryPath(unresolvedPath, realpath)).toBe(path.resolve(unresolvedPath));
  });
});

describe('daemon ready handoff', () => {
  it('uses a 60s default ready timeout', () => {
    expect(DEFAULT_DAEMON_READY_TIMEOUT_MS).toBe(60000);
    expect(normalizeDaemonReadyTimeoutMs(undefined)).toBe(60000);
    expect(normalizeDaemonReadyTimeoutMs('45000')).toBe(45000);
    expect(normalizeDaemonReadyTimeoutMs('-1')).toBe(60000);
  });

  it('resolves with the IPC ready port', async () => {
    const child = new EventEmitter();
    const pending = waitForDaemonReadyMessage(child, {
      requestedPort: 0,
      timeoutMs: 60000,
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });

    child.emit('message', { type: 'openchamber:ready', port: 3219 });

    await expect(pending).resolves.toEqual({ ok: true, port: 3219 });
  });

  it('returns timeout when no ready message arrives', async () => {
    const child = new EventEmitter();
    let timeoutCallback;
    const pending = waitForDaemonReadyMessage(child, {
      requestedPort: 0,
      timeoutMs: 60000,
      setTimeoutFn: (callback) => {
        timeoutCallback = callback;
        return 1;
      },
      clearTimeoutFn: () => {},
    });

    timeoutCallback();

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      requestedPort: 0,
      timeoutMs: 60000,
    });
  });

  it('returns exit when the daemon exits before ready', async () => {
    const child = new EventEmitter();
    const pending = waitForDaemonReadyMessage(child, {
      requestedPort: 3000,
      timeoutMs: 60000,
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });

    child.emit('exit', 1, null);

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'exit',
      requestedPort: 3000,
      code: 1,
      signal: null,
    });
  });

  it('asks timed-out daemon children to terminate', async () => {
    const signals = [];
    const child = {
      pid: 12345,
      kill(signal) {
        signals.push(['child', signal]);
        return true;
      },
    };

    const stopped = await terminateDaemonChild(child, {
      waitTimeoutMs: 1,
      waitForExit: async () => true,
      processKill: (pid, signal) => {
        signals.push([pid, signal]);
      },
      platform: 'darwin',
    });

    expect(stopped).toBe(true);
    expect(signals).toEqual([[-12345, 'SIGTERM']]);
  });
});

describe('CLI PID lifecycle validation', () => {
  it('accepts daemon PID files whose process command is the DevRyan server entry', async () => {
    const result = await validatePidFileIdentity({
      port: 3000,
      pid: 123,
      launchMode: 'daemon',
    }, {
      isProcessRunning: () => true,
      readProcessCommand: () => '/opt/homebrew/bin/bun /Users/me/DevRyan/packages/web/server/index.js --port 3000',
      fetchSystemInfoFromPort: async () => null,
    });

    expect(result.valid).toBe(true);
    expect(result.source).toBe('command');
  });

  it('rejects recycled PID files whose live process is unrelated', async () => {
    const result = await validatePidFileIdentity({
      port: 3000,
      pid: 123,
      launchMode: 'daemon',
    }, {
      isProcessRunning: () => true,
      readProcessCommand: () => '/usr/bin/python3 /tmp/unrelated.py',
      fetchSystemInfoFromPort: async () => null,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('command-mismatch');
  });

  it('rejects stale PID files when the process is gone', async () => {
    const result = await validatePidFileIdentity({
      port: 3000,
      pid: 123,
      launchMode: 'daemon',
    }, {
      isProcessRunning: () => false,
      readProcessCommand: () => {
        throw new Error('should not read command for dead pid');
      },
      fetchSystemInfoFromPort: async () => null,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('process-not-running');
  });

  it('rejects PID files when the live port reports a different DevRyan process', async () => {
    const result = await validatePidFileIdentity({
      port: 3000,
      pid: 123,
      launchMode: 'daemon',
    }, {
      isProcessRunning: () => true,
      readProcessCommand: () => '/opt/homebrew/bin/bun /Users/me/DevRyan/packages/web/server/index.js --port 4000',
      fetchSystemInfoFromPort: async () => ({ runtime: 'web', pid: 456 }),
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('port-pid-mismatch');
  });

  it('preserves a DevRyan PID file when the port probe is transiently unavailable', async () => {
    const result = await validatePidFileIdentity({
      port: 3000,
      pid: 123,
      launchMode: 'daemon',
    }, {
      isProcessRunning: () => true,
      readProcessCommand: () => '/opt/homebrew/bin/bun /Users/me/DevRyan/packages/web/server/index.js --port 3000',
      fetchSystemInfoFromPort: async () => null,
    });

    expect(result.valid).toBe(true);
    expect(result.source).toBe('command');
  });

  it('recognizes foreground CLI commands separately from daemon server commands', () => {
    expect(isDevRyanPidFileCommand(
      '/usr/local/bin/openchamber serve --foreground --port 3000',
      { launchMode: 'foreground' },
    )).toBe(true);
    expect(isDevRyanPidFileCommand(
      '/usr/local/bin/openchamber tunnel status',
      { launchMode: 'foreground' },
    )).toBe(false);
  });
});
