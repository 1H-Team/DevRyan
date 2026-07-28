import { describe, expect, it, vi } from 'vitest';

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
} = await import('./opencode');

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
    expect(buildManagedOpenCodeEnvOverrides({
      overlayConfigDirectory: '/tmp/runtime-overlay',
      slimConfigDirectory: null,
      slimPreset: null,
    })).toEqual({
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
