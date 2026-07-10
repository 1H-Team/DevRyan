import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetGitHubCopilotModelDiscoveryCache,
  discoverGitHubCopilotModels,
} from './github-copilot-models.js';

describe('GitHub Copilot model discovery', () => {
  afterEach(() => {
    __resetGitHubCopilotModelDiscoveryCache();
    vi.clearAllMocks();
  });

  it('normalizes account-specific Copilot models returned by the models endpoint', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: vi.fn(async () => ({
        data: [
          { id: 'gpt-5.5' },
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
          { id: '' },
          { id: 'gpt-5.5' },
        ],
      })),
    }));

    const result = await discoverGitHubCopilotModels({
      readAuthFile: () => ({ 'github-copilot': { access: 'copilot-token' } }),
      fetchImpl,
    });

    expect(result).toEqual({
      source: 'account',
      models: {
        'gpt-5.5': {
          id: 'gpt-5.5',
          name: 'GPT 5.5',
          api: {
            id: 'gpt-5.5',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
        'claude-sonnet-5': {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          api: {
            id: 'claude-sonnet-5',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.githubcopilot.com/models', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer copilot-token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Copilot-Integration-Id': 'vscode-chat',
        'Editor-Version': 'vscode/1.96.2',
      },
    });
  });

  it('uses legacy copilot auth and caches successful account discovery briefly', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: vi.fn(async () => ({
        data: [
          { id: 'gpt-5.4-mini' },
        ],
      })),
    }));
    let now = 1_000;

    const first = await discoverGitHubCopilotModels({
      readAuthFile: () => ({ copilot: { token: 'legacy-token' } }),
      fetchImpl,
      now: () => now,
    });
    now += 1_000;
    const second = await discoverGitHubCopilotModels({
      readAuthFile: () => ({ copilot: { token: 'legacy-token' } }),
      fetchImpl,
      now: () => now,
    });

    expect(first.source).toBe('account');
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed discovery as authoritative', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: vi.fn(async () => ({})),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn(async () => ({ data: [{ id: 'gpt-5.3-codex' }] })),
      });

    const first = await discoverGitHubCopilotModels({
      readAuthFile: () => ({ 'github-copilot': { access: 'copilot-token' } }),
      fetchImpl,
    });
    const second = await discoverGitHubCopilotModels({
      readAuthFile: () => ({ 'github-copilot': { access: 'copilot-token' } }),
      fetchImpl,
    });

    expect(first).toEqual({
      source: 'fallback',
      models: {
        'gpt-5.1-codex': {
          id: 'gpt-5.1-codex',
          name: 'GPT-5.1 Codex',
          api: {
            id: 'gpt-5.1-codex',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
      },
    });
    expect(second.source).toBe('account');
    expect(second.models['gpt-5.3-codex']).toEqual({
      id: 'gpt-5.3-codex',
      name: 'GPT 5.3 Codex',
      api: {
        id: 'gpt-5.3-codex',
        url: 'https://api.githubcopilot.com',
        npm: '@ai-sdk/github-copilot',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('prefers picker-enabled models when capability metadata is present', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: vi.fn(async () => ({
        data: [
          {
            id: 'gpt-hidden',
            name: 'Hidden',
            model_picker_enabled: false,
            capabilities: {
              limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
              supports: { tool_calls: true },
            },
          },
          {
            id: 'gpt-visible',
            name: 'Visible',
            model_picker_enabled: true,
            capabilities: {
              limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
              supports: { tool_calls: true },
            },
          },
          {
            id: 'text-embedding-3-small',
            name: 'Embeddings',
            model_picker_enabled: true,
            capabilities: {
              limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
              supports: { tool_calls: true },
            },
          },
        ],
      })),
    }));

    const result = await discoverGitHubCopilotModels({
      readAuthFile: () => ({ 'github-copilot': { access: 'copilot-token' } }),
      fetchImpl,
    });

    expect(Object.keys(result.models)).toEqual(['gpt-visible']);
  });

  it('falls back to usable chat models when every picker flag is false', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: vi.fn(async () => ({
        data: [
          {
            id: 'gpt-5.3-codex',
            name: 'GPT-5.3 Codex',
            model_picker_enabled: false,
            capabilities: {
              limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
              supports: { tool_calls: true },
            },
          },
          {
            id: 'text-embedding-3-small',
            name: 'Embeddings',
            model_picker_enabled: false,
            capabilities: {
              limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
              supports: { tool_calls: true },
            },
          },
          {
            id: 'incomplete',
            name: 'Incomplete',
            model_picker_enabled: false,
            capabilities: {
              limits: { max_output_tokens: 1000 },
              supports: {},
            },
          },
        ],
      })),
    }));

    const result = await discoverGitHubCopilotModels({
      readAuthFile: () => ({ 'github-copilot': { access: 'copilot-token' } }),
      fetchImpl,
    });

    expect(Object.keys(result.models)).toEqual(['gpt-5.3-codex']);
    expect(result.models['gpt-5.3-codex'].api.npm).toBe('@ai-sdk/github-copilot');
  });

  it('reports unavailable when no Copilot token exists', async () => {
    const fetchImpl = vi.fn();

    const result = await discoverGitHubCopilotModels({
      readAuthFile: () => ({}),
      fetchImpl,
    });

    expect(result).toEqual({ source: 'unavailable', models: {} });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports unavailable instead of throwing when reading the auth file fails', async () => {
    const fetchImpl = vi.fn();

    const result = await discoverGitHubCopilotModels({
      readAuthFile: () => {
        throw new Error('Failed to read OpenCode auth configuration');
      },
      fetchImpl,
    });

    expect(result).toEqual({ source: 'unavailable', models: {} });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
