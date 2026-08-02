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
  resolveClaudeProxyBaseUrlFromProviders: vi.fn(() => null),
}));

vi.mock('./sessionActivityWatcher', () => ({
  getSessionActivitySnapshot: vi.fn(() => ({})),
}));

const {
  normalizeGithubReleaseUpdate,
  resolveCursorSdkAgentDefinitions,
} = await import('./bridge-system-runtime');

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
