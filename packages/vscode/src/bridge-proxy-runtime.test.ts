import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('./opencodeAuth', () => ({
  readAuthFile: vi.fn(() => mocks.auth),
}));

const { handleProxyBridgeMessage } = await import('./bridge-proxy-runtime');

const deps = {
  tryHandleLocalFsProxy: vi.fn(async () => null),
  buildUnavailableApiResponse: vi.fn(() => ({ status: 503, headers: {}, bodyBase64: '' })),
  sanitizeForwardHeaders: vi.fn(() => ({})),
  collectHeaders: vi.fn(() => ({ 'content-type': 'application/json' })),
  base64EncodeUtf8: (text: string) => Buffer.from(text).toString('base64'),
};

const context = {
  manager: {
    getApiUrl: () => 'http://opencode.test',
    getOpenCodeAuthHeaders: () => ({}),
  },
};

afterEach(() => {
  mocks.auth = {};
  vi.restoreAllMocks();
});

describe('VS Code provider catalog proxy', () => {
  it('keeps only real GPT-5.6 family rows selectable for OAuth', async () => {
    mocks.auth = { openai: { type: 'oauth', access: 'secret-token' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      providers: [{
        id: 'openai',
        models: {
          'gpt-5.6': { id: 'gpt-5.6' },
          'gpt-5.6-pro': { id: 'gpt-5.6-pro' },
          'gpt-5.6-sol': { id: 'gpt-5.6-sol' },
          'gpt-5.6-terra': { id: 'gpt-5.6-terra' },
          'gpt-5.6-luna': { id: 'gpt-5.6-luna' },
        },
      }],
      default: { openai: 'gpt-5.6' },
    }));

    const response = await handleProxyBridgeMessage({
      id: 'providers',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/config/providers?directory=%2Frepo' },
    }, context as never, deps);

    const encoded = (response?.data as { bodyBase64: string }).bodyBase64;
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(body.providers[0]).toMatchObject({
      authType: 'oauth',
      models: {
        'gpt-5.6': {
          id: 'gpt-5.6',
          available: false,
          unavailableReason: 'auth_type_unsupported',
          requiredAuthType: 'api',
        },
        'gpt-5.6-luna': {
          id: 'gpt-5.6-luna',
        },
        'gpt-5.6-sol': {
          id: 'gpt-5.6-sol',
        },
        'gpt-5.6-terra': {
          id: 'gpt-5.6-terra',
        },
        'gpt-5.6-pro': {
          available: false,
          unavailableReason: 'auth_type_unsupported',
          requiredAuthType: 'api',
        },
      },
    });
    expect(body.providers[0].models['gpt-5.6-luna'].available).not.toBe(false);
    expect(body.providers[0].models['gpt-5.6-sol'].available).not.toBe(false);
    expect(body.providers[0].models['gpt-5.6-terra'].available).not.toBe(false);
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });

  it('leaves external OpenCode provider catalogs unchanged', async () => {
    mocks.auth = { openai: { type: 'oauth', access: 'secret-token' } };
    const upstream = {
      providers: [{
        id: 'openai',
        models: {
          'gpt-5.6': { id: 'gpt-5.6' },
          'gpt-5.6-sol': { id: 'gpt-5.6-sol' },
        },
      }],
      default: { openai: 'gpt-5.6' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(upstream));

    const response = await handleProxyBridgeMessage({
      id: 'providers-external',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/config/providers?directory=%2Frepo' },
    }, {
      manager: {
        ...context.manager,
        getDebugInfo: () => ({ mode: 'external' }),
      },
    } as never, deps);

    const encoded = (response?.data as { bodyBase64: string }).bodyBase64;
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(body).toEqual(upstream);
  });

  it('leaves API-key OpenAI catalogs provider-driven', async () => {
    mocks.auth = { openai: { type: 'api', key: 'secret-api-key' } };
    const upstream = {
      providers: [{
        id: 'openai',
        models: {
          'gpt-5.6': { id: 'gpt-5.6' },
          'gpt-5.6-sol-pro': { id: 'gpt-5.6-sol-pro' },
        },
      }],
      default: { openai: 'gpt-5.6' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(upstream));

    const response = await handleProxyBridgeMessage({
      id: 'providers-api-key',
      type: 'api:proxy',
      payload: { method: 'GET', path: '/config/providers?directory=%2Frepo' },
    }, context as never, deps);

    const encoded = (response?.data as { bodyBase64: string }).bodyBase64;
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(body.providers[0]).toMatchObject({
      id: 'openai',
      authType: 'api',
      models: upstream.providers[0].models,
    });
    expect(JSON.stringify(body)).not.toContain('secret-api-key');
  });
});
