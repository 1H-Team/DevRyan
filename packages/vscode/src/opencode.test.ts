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
  buildManagedOpenCodeServeArgs,
} = await import('./opencode');

describe('VS Code managed OpenCode launch', () => {
  it('uses pure managed serve arguments', () => {
    expect(buildManagedOpenCodeServeArgs(45678)).toEqual([
      '--pure',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '45678',
    ]);
  });

  it('disables default plugins in managed env overrides', () => {
    expect(buildManagedOpenCodeEnvOverrides({
      overlayConfigDirectory: '/tmp/runtime-overlay',
      slimConfigDirectory: null,
      slimPreset: null,
    })).toEqual({
      OPENCODE_CONFIG_DIR: '/tmp/runtime-overlay',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true',
    });
  });
});
