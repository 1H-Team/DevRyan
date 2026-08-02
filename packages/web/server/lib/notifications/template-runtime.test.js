import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';

const createRuntime = (settings = {}) => createNotificationTemplateRuntime({
  readSettingsFromDisk: async () => settings,
  persistSettings: vi.fn(async () => {}),
  buildOpenCodeUrl: (path) => path,
  getOpenCodeAuthHeaders: () => ({}),
  resolveGitBinaryForSpawn: () => 'git',
});

describe('notification template runtime zen models', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses zen models with zero-cost metadata as selectable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('models.dev')) {
        return {
          ok: true,
          json: async () => ({
            opencode: {
              models: {
                'big-pickle': { cost: { input: 0, output: 0 } },
                'gpt-5-nano': { cost: { input: 0, output: 0 } },
                'gpt-5.5': { cost: { input: 5, output: 30 } },
                'hy3-preview-free': { cost: { input: 0, output: 0 } },
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'big-pickle', owned_by: 'opencode' },
            { id: 'gpt-5-nano', owned_by: 'opencode' },
            { id: 'gpt-5.5', owned_by: 'opencode' },
            { id: 'hy3-preview-free', owned_by: 'opencode' },
          ],
        }),
      };
    });

    const runtime = createRuntime();
    const models = await runtime.fetchFreeZenModels();

    expect(models.map((model) => model.id)).toEqual([
      'big-pickle',
      'gpt-5-nano',
      'hy3-preview-free',
    ]);
  });

  it('falls back to a valid unauthenticated model when stored zen model is stale', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('models.dev')) {
        return {
          ok: true,
          json: async () => ({
            opencode: {
              models: {
                'big-pickle': { cost: { input: 0, output: 0 } },
                'gpt-5-nano': { cost: { input: 0, output: 0 } },
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'big-pickle', owned_by: 'opencode' },
            { id: 'gpt-5-nano', owned_by: 'opencode' },
          ],
        }),
      };
    });

    const runtime = createRuntime({ zenModel: 'trinity-large-preview-free' });

    await expect(runtime.resolveZenModel()).resolves.toBe('gpt-5-nano');
  });
});

describe('notification template runtime session variables', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves session_name from fetched session info with auth headers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'ses_1', title: 'Fix notification timing' }),
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);

    const runtime = createNotificationTemplateRuntime({
      readSettingsFromDisk: async () => ({ projects: [] }),
      persistSettings: vi.fn(async () => {}),
      buildOpenCodeUrl: (path) => `http://opencode.local${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      resolveGitBinaryForSpawn: () => 'git',
    });

    const variables = await runtime.buildTemplateVariables({ type: 'message.updated', properties: { info: {} } }, 'ses_1');

    expect(variables.session_name).toBe('Fix notification timing');
    expect(fetchMock).toHaveBeenCalledWith('http://opencode.local/session/ses_1', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }));
  });

  it('caches authoritative session metadata from lifecycle events for notification eligibility', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const runtime = createRuntime();
    const sessionInfo = {
      id: 'ses_helper',
      title: 'smartfetch-secondary',
      parentID: null,
    };

    runtime.maybeCacheSessionInfoFromEvent({
      type: 'session.created',
      properties: { info: sessionInfo },
    });

    await expect(runtime.fetchSessionInfo('ses_helper')).resolves.toEqual(sessionInfo);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
