import { describe, expect, it, vi } from 'vitest';

import {
  createBotModelCatalogLoader,
  sanitizeBotModelOptions,
} from './model-catalog.js';

const createLoader = (fetchImpl, overrides = {}) => createBotModelCatalogLoader({
  fetchImpl,
  buildUrl: () => 'http://127.0.0.1:4096/config/providers',
  getAuthHeaders: () => ({ authorization: 'Basic sealed' }),
  createTimeoutSignal: vi.fn(() => AbortSignal.abort()),
  ...overrides,
});

describe('Bot model catalog loader', () => {
  it('projects providers, models, thinking variants, and reviewed egress without auth material', () => {
    const options = sanitizeBotModelOptions({
      providers: [{
        id: 'openai',
        name: 'OpenAI',
        authType: 'oauth',
        apiKey: 'secret-provider-key',
        models: [{
          id: 'gpt-5',
          name: 'GPT-5',
          variants: { medium: { name: 'Medium' }, legacy: { enabled: false } },
          limit: { context: 128_000 },
          egressHosts: ['api.openai.com:443'],
          authorization: { token: 'secret-model-token' },
        }],
      }],
    });

    expect(options).toEqual({
      available: true,
      providers: [{
        id: 'openai', name: 'OpenAI', available: true, authType: 'oauth',
        connections: [{
          id: 'host:openai', label: 'OpenAI account', kind: 'oauth', status: 'active',
        }],
        models: [{
          id: 'gpt-5', name: 'GPT-5', providerId: 'openai', available: true,
          variants: [
            { id: 'medium', name: 'Medium', available: true },
            { id: 'legacy', name: 'legacy', available: false },
          ],
          contextLimit: 128_000,
          reviewedEgressHosts: ['api.openai.com:443'],
          egressReviewed: true,
        }],
      }],
    });
    expect(JSON.stringify(options)).not.toContain('secret-');
    expect(() => sanitizeBotModelOptions({ providers: {} })).toThrowError(
      expect.objectContaining({ code: 'bot_model_catalog_invalid' }),
    );
  });

  it('uses the server auth resolver as authority for selectable OAuth connections', () => {
    const oauth = sanitizeBotModelOptions({
      providers: [{ id: 'openai', authType: 'api', models: [{ id: 'gpt-5.6-sol' }] }],
    }, {
      resolveAuthType: () => 'oauth',
    });
    const api = sanitizeBotModelOptions({
      providers: [{ id: 'openai', authType: 'oauth', models: [{ id: 'gpt-5.6-sol' }] }],
    }, {
      resolveAuthType: () => 'api',
    });

    expect(oauth.providers[0]).toMatchObject({
      authType: 'oauth',
      connections: [{ id: 'host:openai', kind: 'oauth', status: 'active' }],
      models: [{
        id: 'gpt-5.6-sol',
        reviewedEgressHosts: ['auth.openai.com:443', 'chatgpt.com:443'],
        egressReviewed: true,
      }],
    });
    expect(api.providers[0]).toMatchObject({
      authType: 'api',
      connections: [],
      models: [{
        id: 'gpt-5.6-sol',
        reviewedEgressHosts: ['api.openai.com:443'],
        egressReviewed: true,
      }],
    });
  });

  it('loads the authenticated live catalog through a bounded request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ providers: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const loader = createLoader(fetchImpl);

    await expect(loader()).resolves.toEqual({ providers: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/config/providers',
      expect.objectContaining({
        headers: { accept: 'application/json', authorization: 'Basic sealed' },
        redirect: 'error',
      }),
    );
  });

  it('maps transport and HTTP failures to the stable preflight 503', async () => {
    const transport = createLoader(vi.fn(async () => { throw new Error('connect failed'); }));
    const http = createLoader(vi.fn(async () => new Response('', { status: 502 })));

    await expect(transport()).rejects.toMatchObject({
      code: 'bot_model_catalog_unavailable', statusCode: 503,
    });
    await expect(http()).rejects.toMatchObject({
      code: 'bot_model_catalog_unavailable', statusCode: 503,
    });
  });

  it('rejects malformed and oversized responses without returning partial data', async () => {
    const malformed = createLoader(vi.fn(async () => new Response('{', { status: 200 })));
    const oversized = createLoader(
      vi.fn(async () => new Response('x'.repeat(1_025), { status: 200 })),
      { maximumBytes: 1_024 },
    );

    await expect(malformed()).rejects.toMatchObject({ code: 'bot_model_catalog_invalid' });
    await expect(oversized()).rejects.toMatchObject({ code: 'bot_model_catalog_invalid' });
  });
});
