import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agents: [],
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => '') })),
  },
}));

vi.mock('@openchamber/cursor-sdk-runtime', () => ({
  CURSOR_PROVIDER_ID: 'cursor-acp',
  clearCursorSdkAuth: vi.fn(),
  createCursorSdkRuntime: vi.fn(() => ({})),
  saveCursorSdkAuth: vi.fn(),
}));

vi.mock('./opencodeConfig', () => ({
  removeProviderConfig: vi.fn(),
  getProviderSources: vi.fn(),
  ensureAnthropicOAuthProviderConfig: vi.fn(),
  getAgentConfig: vi.fn(),
  listConfigAgents: vi.fn(() => mocks.agents),
}));

vi.mock('./opencodeAuth', () => ({
  getProviderAuth: vi.fn(),
  readAuthFile: vi.fn(() => ({})),
  removeProviderAuth: vi.fn(),
  writeAuthFile: vi.fn(),
}));

vi.mock('./quotaProviders', () => ({
  fetchQuotaForProvider: vi.fn(),
  listConfiguredQuotaProviders: vi.fn(() => []),
}));

vi.mock('./sessionActivityWatcher', () => ({
  getSessionActivitySnapshot: vi.fn(() => ({})),
}));

const { resolveCursorSdkAgentDefinitions } = await import('./bridge-system-runtime');

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
