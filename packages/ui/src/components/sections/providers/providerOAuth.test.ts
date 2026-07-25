import { describe, expect, test } from 'bun:test';
import {
  getProviderOAuthErrorMessage,
  parseProviderOAuthAuthorization,
  providerCatalogHasModels,
  requestProviderOAuthCallback,
  type ProviderOAuthFetch,
} from './providerOAuth';

describe('provider OAuth helpers', () => {
  test('parses SDK-wrapped automatic authorization details', () => {
    expect(parseProviderOAuthAuthorization({
      data: {
        method: 'auto',
        url: 'https://accounts.example/authorize',
        instructions: 'Finish in your browser.',
      },
    })).toEqual({
      method: 'auto',
      url: 'https://accounts.example/authorize',
      instructions: 'Finish in your browser.',
      userCode: undefined,
    });
  });

  test('preserves code-based and device authorization fallbacks', () => {
    expect(parseProviderOAuthAuthorization({
      method: 'code',
      verification_uri_complete: 'https://accounts.example/device?code=ABCD',
      user_code: 'ABCD',
    })).toEqual({
      method: 'code',
      url: 'https://accounts.example/device?code=ABCD',
      instructions: undefined,
      userCode: 'ABCD',
    });
    expect(parseProviderOAuthAuthorization({ message: 'Continue in the browser.' })).toEqual({
      method: 'code',
      url: undefined,
      instructions: 'Continue in the browser.',
      userCode: undefined,
    });
    expect(parseProviderOAuthAuthorization({})).toBeNull();
  });

  test('submits automatic callbacks without an authorization code', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl: ProviderOAuthFetch = async (input, init) => {
      calls.push({ input, init });
      return { ok: true, json: async () => true };
    };

    await requestProviderOAuthCallback({
      providerId: 'xai',
      methodIndex: 0,
      fallbackError: 'OAuth failed',
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/provider/xai/oauth/callback');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ method: 0 });
  });

  test('submits a trimmed code and surfaces structured callback errors', async () => {
    let submittedBody: unknown = null;
    const fetchImpl: ProviderOAuthFetch = async (_input, init) => {
      submittedBody = JSON.parse(String(init.body));
      return {
        ok: false,
        json: async () => ({ data: { message: 'Authorization expired.' } }),
      };
    };

    let callbackError: unknown = null;
    try {
      await requestProviderOAuthCallback({
        providerId: 'provider/id',
        methodIndex: 2,
        code: '  ready-code  ',
        fallbackError: 'OAuth failed',
        fetchImpl,
      });
    } catch (error) {
      callbackError = error;
    }

    expect(callbackError).toBeInstanceOf(Error);
    if (!(callbackError instanceof Error)) {
      throw new Error('Expected the provider callback to fail');
    }
    expect(callbackError.message).toBe('Authorization expired.');
    expect(submittedBody).toEqual({ method: 2, code: 'ready-code' });
    expect(getProviderOAuthErrorMessage({ error: 'Direct error' }, 'fallback')).toBe('Direct error');
  });

  test('requires the connected provider to expose at least one model', () => {
    expect(providerCatalogHasModels([
      { id: 'xai', models: [] },
      { id: 'openai', models: [{ id: 'gpt' }] },
    ], 'xai')).toBe(false);
    expect(providerCatalogHasModels([
      { id: 'xai', models: [{ id: 'grok' }] },
    ], 'xai')).toBe(true);
  });
});
