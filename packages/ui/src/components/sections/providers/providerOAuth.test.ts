import { describe, expect, test } from 'bun:test';
import {
  getProviderOAuthErrorMessage,
  parseProviderOAuthAuthorization,
  providerCatalogHasModels,
  requestPostAuthConfigReload,
  requestProviderOAuthCallback,
  resolveProviderOAuthPhase,
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
    expect(providerCatalogHasModels(null, 'openai')).toBe(false);
    expect(providerCatalogHasModels([], 'openai')).toBe(false);
  });
});

describe('OAuth attempt phase resolution', () => {
  test('clears the attempt when the callback succeeded and models are ready', () => {
    expect(resolveProviderOAuthPhase({ providerReady: true })).toEqual({ phase: null });
  });

  // Regression: a saved credential used to surface as "Failed to complete OAuth flow" whenever
  // the model catalog had not caught up within the retry budget.
  test('reports a lagging model catalog as pending, never as an error', () => {
    expect(resolveProviderOAuthPhase({ providerReady: false })).toEqual({ phase: 'models-pending' });
    expect(resolveProviderOAuthPhase({})).toEqual({ phase: 'models-pending' });
    expect(resolveProviderOAuthPhase({ callbackError: null, providerReady: false }).phase)
      .not.toBe('error');
  });

  test('only a failed callback resolves to an error, carrying its message', () => {
    expect(resolveProviderOAuthPhase({ callbackError: 'Authorization expired.' })).toEqual({
      phase: 'error',
      error: 'Authorization expired.',
    });
  });
});

describe('post-auth config reload', () => {
  test('reports a deferred apply when the server waits for idle', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl: ProviderOAuthFetch = async (input, init) => {
      calls.push({ input, init });
      return {
        ok: true,
        json: async () => ({ success: true, applyStatus: { state: 'waiting_for_idle' } }),
      };
    };

    expect(await requestPostAuthConfigReload({ fetchImpl })).toEqual({ ok: true, deferred: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/config/reload');
    expect(calls[0]?.init.method).toBe('POST');
  });

  test('reports an immediate apply as not deferred', async () => {
    const fetchImpl: ProviderOAuthFetch = async () => ({
      ok: true,
      json: async () => ({ success: true, applyStatus: { state: 'applied' } }),
    });

    expect(await requestPostAuthConfigReload({ fetchImpl })).toEqual({ ok: true, deferred: false });
  });

  // The credential is already saved by this point, so a reload failure must never throw.
  test('swallows non-ok responses and network errors', async () => {
    const rejecting: ProviderOAuthFetch = async () => ({ ok: false, json: async () => ({}) });
    expect(await requestPostAuthConfigReload({ fetchImpl: rejecting }))
      .toEqual({ ok: false, deferred: false });

    const throwing: ProviderOAuthFetch = async () => {
      throw new Error('offline');
    };
    expect(await requestPostAuthConfigReload({ fetchImpl: throwing }))
      .toEqual({ ok: false, deferred: false });
  });
});
