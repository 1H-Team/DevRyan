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
        'gpt-5.5': { id: 'gpt-5.5', name: 'GPT 5.5' },
        'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
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
        'gpt-5.1-codex': { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
      },
    });
    expect(second.source).toBe('account');
    expect(second.models['gpt-5.3-codex']).toEqual({ id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
