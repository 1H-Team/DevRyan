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

  it('resolves commit models immediately while deduplicating cold and stale catalog refreshes', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const pendingResponses = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => new Promise((resolve) => {
      pendingResponses.push({ url: String(url), resolve });
    }));
    const runtime = createRuntime();

    expect(runtime.resolveZenModelNonBlocking('deepseek-v4-flash-free')).toEqual({
      model: 'deepseek-v4-flash-free',
      fallbackModel: null,
      catalogState: 'empty',
    });
    expect(runtime.resolveZenModelNonBlocking('deepseek-v4-flash-free').catalogState).toBe('empty');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const pending of pendingResponses.splice(0)) {
      pending.resolve(pending.url.includes('models.dev')
        ? {
            ok: true,
            json: async () => ({
              opencode: {
                models: {
                  'gpt-5-nano': { cost: { input: 0, output: 0 } },
                  'big-pickle': { cost: { input: 0, output: 0 } },
                },
              },
            }),
          }
        : {
            ok: true,
            json: async () => ({ data: [
              { id: 'gpt-5-nano', owned_by: 'opencode' },
              { id: 'big-pickle', owned_by: 'opencode' },
            ] }),
          });
    }
    await runtime.fetchFreeZenModels();

    now += (5 * 60 * 1_000) + 1;
    const staleSelection = runtime.resolveZenModelNonBlocking('deepseek-v4-flash-free');
    runtime.resolveZenModelNonBlocking('deepseek-v4-flash-free');

    expect(staleSelection).toEqual({
      model: 'gpt-5-nano',
      fallbackModel: 'big-pickle',
      catalogState: 'stale',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    for (const pending of pendingResponses.splice(0)) {
      pending.resolve(pending.url.includes('models.dev')
        ? {
            ok: true,
            json: async () => ({ opencode: { models: {
              'gpt-5-nano': { cost: { input: 0, output: 0 } },
              'big-pickle': { cost: { input: 0, output: 0 } },
            } } }),
          }
        : {
            ok: true,
            json: async () => ({ data: [
              { id: 'gpt-5-nano', owned_by: 'opencode' },
              { id: 'big-pickle', owned_by: 'opencode' },
            ] }),
          });
    }
    await runtime.fetchFreeZenModels();
  });
});

describe('notification template runtime session variables', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['.ssh', 'my_API-v2', 'iOSClient', 'foo__bar'])('preserves exact project_name punctuation for %s', (name) => {
    expect(createRuntime().formatProjectLabel(name)).toBe(name);
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

  it('preserves a projected title across later placeholder session snapshots', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const runtime = createRuntime();
    const placeholder = 'New session - 2026-08-27T00:26:56.854Z';

    runtime.maybeCacheSessionInfoFromEvent({
      type: 'session.created',
      properties: { info: { id: 'ses_1', title: placeholder, parentID: null, cost: 0 } },
    });
    runtime.maybeCacheSessionInfoFromEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: 'Reorder clinic professionals section', parentID: null, cost: 1 } },
    });
    runtime.maybeCacheSessionInfoFromEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: placeholder, parentID: null, cost: 2 } },
    });

    await expect(runtime.fetchSessionInfo('ses_1')).resolves.toMatchObject({
      title: 'Reorder clinic professionals section',
      cost: 2,
    });
    const variables = await runtime.buildTemplateVariables({
      type: 'message.updated',
      properties: { sessionTitle: placeholder, info: {} },
    }, 'ses_1');

    expect(variables.session_name).toBe('Reorder clinic professionals section');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a later manual title to replace a projected title', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const runtime = createRuntime();

    runtime.maybeCacheSessionInfoFromEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: 'Generated session title', parentID: null } },
    });
    runtime.maybeCacheSessionInfoFromEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: 'My manual session name', parentID: null } },
    });

    const variables = await runtime.buildTemplateVariables({
      type: 'message.updated',
      properties: { info: { title: 'Untitled Session' } },
    }, 'ses_1');

    expect(variables.session_name).toBe('My manual session name');
    await expect(runtime.fetchSessionInfo('ses_1')).resolves.toMatchObject({
      title: 'My manual session name',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not regress a projected title when an expired cache refresh still returns a placeholder', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const placeholder = 'New session - 2026-08-27T00:26:56.854Z';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'ses_1', title: placeholder, parentID: null, cost: 3 }),
    });
    const runtime = createRuntime();

    runtime.maybeCacheSessionInfoFromEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', title: 'Reorder clinic professionals section', parentID: null, cost: 1 } },
    });
    now += 61_000;

    await expect(runtime.fetchSessionInfo('ses_1')).resolves.toMatchObject({
      title: 'Reorder clinic professionals section',
      cost: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
