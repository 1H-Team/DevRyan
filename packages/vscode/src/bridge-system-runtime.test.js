import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agents: [],
  executeCommand: vi.fn(),
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
  uriFile: vi.fn((fsPath) => ({ fsPath })),
  readMeridianPromptMode: vi.fn(() => ({ ok: true, mode: 'combined', compatibilityMode: false })),
  setMeridianPromptCompatibilityMode: vi.fn((enabled) => ({
    ok: true,
    changed: true,
    mode: enabled ? 'claude-only' : 'combined',
    compatibilityMode: enabled,
  })),
  removeProviderConfig: vi.fn(),
  removeAntigravityProviderConfig: vi.fn(),
  getProviderSources: vi.fn(),
  getAntigravityAccountsSource: vi.fn(),
  getProviderAuth: vi.fn(),
  removeAntigravityAccounts: vi.fn(),
  removeProviderAuthForLookupIds: vi.fn(),
}));

vi.mock('vscode', () => {
  class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  }
  class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }
  return {
    commands: { executeCommand: mocks.executeCommand },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => '') })),
      openTextDocument: mocks.openTextDocument,
    },
    window: {
      showTextDocument: mocks.showTextDocument,
      showInformationMessage: vi.fn(),
    },
    Uri: { file: mocks.uriFile },
    Position,
    Range,
  };
});

vi.mock('@openchamber/cursor-sdk-runtime', () => ({
  CURSOR_PROVIDER_ID: 'cursor-acp',
  clearCursorSdkAuth: vi.fn(),
  createCursorSdkRuntime: vi.fn(() => ({})),
  saveCursorSdkAuth: vi.fn(),
}));

vi.mock('./opencodeConfig', () => ({
  removeProviderConfig: mocks.removeProviderConfig,
  removeAntigravityProviderConfig: mocks.removeAntigravityProviderConfig,
  getProviderSources: mocks.getProviderSources,
  ensureAnthropicOAuthProviderConfig: vi.fn(),
  getAgentConfig: vi.fn(),
  listConfigAgents: vi.fn(() => mocks.agents),
}));

vi.mock('./opencodeAuth', () => ({
  getAntigravityAccountsSource: mocks.getAntigravityAccountsSource,
  getProviderAuth: mocks.getProviderAuth,
  getProviderAuthLookupIds: vi.fn((providerId) => [providerId]),
  readAuthFile: vi.fn(() => ({})),
  removeAntigravityAccounts: mocks.removeAntigravityAccounts,
  removeProviderAuthForLookupIds: mocks.removeProviderAuthForLookupIds,
  writeAuthFile: vi.fn(),
}));

vi.mock('./quotaProviders', () => ({
  fetchQuotaForProvider: vi.fn(),
  listConfiguredQuotaProviders: vi.fn(() => []),
  resolveClaudeProxyBaseUrlFromProviders: vi.fn(() => null),
}));

vi.mock('./sessionActivityWatcher', () => ({
  getSessionActivitySnapshot: vi.fn(() => ({})),
}));

vi.mock('../../web/server/lib/opencode/meridian-sdk-features.js', () => ({
  readMeridianPromptMode: mocks.readMeridianPromptMode,
  setMeridianPromptCompatibilityMode: mocks.setMeridianPromptCompatibilityMode,
}));

const {
  handleSystemBridgeMessage,
  normalizeGithubReleaseUpdate,
  resolveCursorSdkAgentDefinitions,
} = await import('./bridge-system-runtime');

const systemRuntimeDeps = {
  resolveUserPath: (value) => value,
  fetchModelsMetadata: vi.fn(),
  updateCheckUrl: 'https://updates.invalid',
  updateCheckUsesCompatibilityContract: false,
  markConfigChange: vi.fn(),
};

describe('VS Code update source of truth', () => {
  it('normalizes the canonical DevRyan GitHub release contract', () => {
    expect(normalizeGithubReleaseUpdate({
      tag_name: 'v1.2.3',
      body: 'DevRyan release notes',
      published_at: '2026-07-29T12:00:00Z',
    }, '1.2.2')).toEqual({
      available: true,
      version: '1.2.3',
      currentVersion: '1.2.2',
      body: 'DevRyan release notes',
      date: '2026-07-29T12:00:00Z',
      nextSuggestedCheckInSec: 21_600,
    });
  });

  it('does not report a newer release when DevRyan is current', () => {
    expect(normalizeGithubReleaseUpdate({ tag_name: 'v1.2.3' }, '1.2.3')).toMatchObject({
      available: false,
      version: '1.2.3',
      currentVersion: '1.2.3',
    });
  });
});

describe('VS Code Cursor SDK agent definitions', () => {
  beforeEach(() => {
    mocks.agents = [];
  });

  it('uses explicit Cursor model overrides for subagent definitions and preserves inheritance otherwise', async () => {
    mocks.agents = [
      {
        name: 'fixer',
        description: 'Fast implementation specialist',
        prompt: 'Apply the requested fix.',
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
      },
      {
        name: 'explorer',
        description: 'Read-only code explorer',
        prompt: 'Inspect the repository.',
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
      },
      {
        name: 'council',
        description: 'Multi-model council',
        prompt: 'Synthesize answers.',
        model: { providerID: 'cursor-acp', modelID: 'composer-2.5' },
      },
    ];

    const definitions = await resolveCursorSdkAgentDefinitions({
      directory: '/tmp/project',
      resolveModelSelection: async ({ modelID }) => ({ id: modelID }),
    });

    expect(definitions).toEqual({
      explorer: {
        description: 'Read-only code explorer',
        prompt: 'Inspect the repository.',
        model: 'inherit',
      },
      fixer: {
        description: 'Fast implementation specialist',
        prompt: 'Apply the requested fix.',
        model: { id: 'composer-2.5' },
      },
    });
  });
});

describe('VS Code Claude prompt mode bridge', () => {
  beforeEach(() => {
    mocks.readMeridianPromptMode.mockClear();
    mocks.setMeridianPromptCompatibilityMode.mockClear();
  });

  it('returns and updates the managed prompt mode using the HTTP-shaped contract', async () => {
    const manager = { getDebugInfo: () => ({ mode: 'managed' }) };
    const read = await handleSystemBridgeMessage({
      id: 'prompt-read',
      type: 'api:provider/anthropic/prompt-mode:get',
    }, { manager }, systemRuntimeDeps);
    const update = await handleSystemBridgeMessage({
      id: 'prompt-write',
      type: 'api:provider/anthropic/prompt-mode:set',
      payload: { compatibilityMode: true },
    }, { manager }, systemRuntimeDeps);

    expect(read).toMatchObject({
      success: true,
      data: {
        status: 200,
        body: { mode: 'combined', compatibilityMode: false, editable: true },
      },
    });
    expect(update).toMatchObject({
      success: true,
      data: {
        status: 200,
        body: { mode: 'claude-only', compatibilityMode: true, editable: true },
      },
    });
    expect(mocks.setMeridianPromptCompatibilityMode).toHaveBeenCalledWith(true);
  });

  it('rejects prompt-mode mutations for external runtimes', async () => {
    const response = await handleSystemBridgeMessage({
      id: 'prompt-write',
      type: 'api:provider/anthropic/prompt-mode:set',
      payload: { compatibilityMode: true },
    }, { manager: { getDebugInfo: () => ({ mode: 'external' }) } }, systemRuntimeDeps);

    expect(response).toMatchObject({
      success: true,
      data: {
        status: 409,
        body: { code: 'external_opencode_read_only' },
      },
    });
    expect(mocks.setMeridianPromptCompatibilityMode).not.toHaveBeenCalled();
  });

  it('keeps invalid payload and write-failure statuses aligned with web routes', async () => {
    const manager = { getDebugInfo: () => ({ mode: 'managed' }) };
    const invalid = await handleSystemBridgeMessage({
      id: 'prompt-invalid',
      type: 'api:provider/anthropic/prompt-mode:set',
      payload: { compatibilityMode: 'yes' },
    }, { manager }, systemRuntimeDeps);
    mocks.setMeridianPromptCompatibilityMode.mockReturnValueOnce({
      ok: false,
      code: 'meridian_prompt_mode_write_failed',
      error: 'write failed',
    });
    const failed = await handleSystemBridgeMessage({
      id: 'prompt-failed',
      type: 'api:provider/anthropic/prompt-mode:set',
      payload: { compatibilityMode: true },
    }, { manager }, systemRuntimeDeps);

    expect(invalid).toMatchObject({
      success: true,
      data: { status: 400, body: { code: 'invalid_compatibility_mode' } },
    });
    expect(failed).toMatchObject({
      success: true,
      data: { status: 500, body: { code: 'meridian_prompt_mode_write_failed' } },
    });
  });
});

describe('VS Code provider disconnect bridge', () => {
  const emptySources = () => ({
    auth: { exists: false, path: null },
    user: { exists: false, path: null },
    project: { exists: false, path: null },
    custom: { exists: false, path: null },
  });

  beforeEach(() => {
    mocks.removeProviderConfig.mockReset().mockReturnValue(false);
    mocks.removeAntigravityProviderConfig.mockReset().mockReturnValue(false);
    mocks.getProviderSources.mockReset().mockImplementation(() => emptySources());
    mocks.getAntigravityAccountsSource.mockReset().mockReturnValue({ exists: false, path: null });
    mocks.getProviderAuth.mockReset();
    mocks.removeAntigravityAccounts.mockReset().mockReturnValue(false);
    mocks.removeProviderAuthForLookupIds.mockReset().mockReturnValue(false);
    systemRuntimeDeps.markConfigChange.mockReset().mockResolvedValue({
      requiresApply: true,
      applyRevision: 7,
      applyStatus: { revision: 7, appliedRevision: 6, pending: true },
    });
  });

  it('removes Google auth aliases plus global and active-project config', async () => {
    mocks.removeProviderAuthForLookupIds.mockReturnValue(true);
    mocks.removeProviderConfig.mockImplementation((_providerId, _directory, scope) => scope !== 'custom');

    const response = await handleSystemBridgeMessage({
      id: 'disconnect-google',
      type: 'api:provider/auth:delete',
      payload: { providerId: 'google', scope: 'all', directory: '/tmp/active-project' },
    }, undefined, systemRuntimeDeps);

    expect(mocks.removeProviderAuthForLookupIds).toHaveBeenCalledWith('google');
    expect(mocks.removeProviderConfig).toHaveBeenCalledWith('google', '/tmp/active-project', 'project');
    expect(response).toMatchObject({
      success: true,
      data: {
        removed: true,
        removedSources: { auth: true, user: true, project: true, custom: false },
        requiresApply: true,
        applyRevision: 7,
      },
    });
    expect(systemRuntimeDeps.markConfigChange).toHaveBeenCalledWith(
      'provider disconnect',
      { providerId: 'google', scope: 'all' },
      true,
    );
  });

  it('uses Antigravity-only removers and invalidates stale runtime state idempotently', async () => {
    const response = await handleSystemBridgeMessage({
      id: 'disconnect-antigravity',
      type: 'api:provider/auth:delete',
      payload: { providerId: 'antigravity', scope: 'all', directory: '/tmp/active-project' },
    }, undefined, systemRuntimeDeps);

    expect(mocks.removeAntigravityAccounts).toHaveBeenCalledOnce();
    expect(mocks.removeAntigravityProviderConfig).toHaveBeenCalledWith('/tmp/active-project', 'project');
    expect(mocks.removeProviderConfig).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      success: true,
      data: {
        removed: false,
        removedSources: { auth: false, user: false, project: false, custom: false },
        sources: emptySources(),
        applyStatus: { pending: true },
      },
    });
    expect(systemRuntimeDeps.markConfigChange).toHaveBeenCalledWith(
      'provider disconnect',
      { providerId: 'antigravity', scope: 'all' },
      true,
    );
  });
});

describe('VS Code editor file opening', () => {
  beforeEach(() => {
    mocks.executeCommand.mockReset().mockResolvedValue(undefined);
    mocks.openTextDocument.mockReset();
    mocks.showTextDocument.mockReset();
    mocks.uriFile.mockClear();
  });

  it.each(['/tmp/analysis.ipynb', '/tmp/analysis.IPyNb'])(
    'opens notebook path %s through vscode.open',
    async (filePath) => {
      const response = await handleSystemBridgeMessage({
        id: 'open-notebook',
        type: 'editor:openFile',
        payload: { path: filePath },
      }, undefined, systemRuntimeDeps);

      expect(response).toEqual({ id: 'open-notebook', type: 'editor:openFile', success: true });
      expect(mocks.executeCommand).toHaveBeenCalledWith(
        'vscode.open',
        { fsPath: filePath },
        {},
      );
      expect(mocks.openTextDocument).not.toHaveBeenCalled();
      expect(mocks.showTextDocument).not.toHaveBeenCalled();
    },
  );

  it('preserves the exact source-file selection range', async () => {
    await handleSystemBridgeMessage({
      id: 'open-source',
      type: 'editor:openFile',
      payload: { path: '/tmp/source.ts', line: 7, column: 3 },
    }, undefined, systemRuntimeDeps);

    const [, uri, options] = mocks.executeCommand.mock.calls[0];
    expect(uri).toEqual({ fsPath: '/tmp/source.ts' });
    expect(options.selection).toMatchObject({
      start: { line: 6, character: 3 },
      end: { line: 6, character: 3 },
    });
    expect(mocks.openTextDocument).not.toHaveBeenCalled();
  });

  it('returns the existing error response when vscode.open fails', async () => {
    mocks.executeCommand.mockRejectedValueOnce(new Error('Open failed'));

    const response = await handleSystemBridgeMessage({
      id: 'open-failure',
      type: 'editor:openFile',
      payload: { path: '/tmp/source.ts' },
    }, undefined, systemRuntimeDeps);

    expect(response).toEqual({
      id: 'open-failure',
      type: 'editor:openFile',
      success: false,
      error: 'Open failed',
    });
  });
});
