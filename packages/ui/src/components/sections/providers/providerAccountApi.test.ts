import { describe, expect, test } from 'bun:test';

import {
  fetchProviderAccounts,
  mutateProviderAccount,
  parseProviderAccounts,
  ProviderAccountRequestError,
  supportsProviderAccounts,
} from './providerAccountApi';

describe('provider account API', () => {
  test('parses only typed metadata and keeps nothing else a payload carries', () => {
    const parsed = parseProviderAccounts({ providerID: 'xai', accounts: [
      { id: 'cred_a', label: 'Personal', method: 'oauth', active: true, needsAuth: true, access: 'leaked', key: 'leaked' },
      { id: 'cred_b', label: 7, method: 'key', active: 'yes' },
      { id: 'bad id', label: 'x', method: 'key', active: true },
      { id: 'cred_c', label: 'x', method: 'password', active: true },
    ] }, 'xai');
    expect(parsed).toEqual([
      { id: 'cred_a', label: 'Personal', method: 'oauth', active: true, needsAuth: true },
      { id: 'cred_b', label: '', method: 'key', active: false, needsAuth: false },
    ]);
    expect(parseProviderAccounts({ providerID: 'openai', accounts: [] }, 'xai')).toBeNull();
    expect(supportsProviderAccounts('openai')).toBe(true);
    expect(supportsProviderAccounts('anthropic')).toBe(false);
  });

  test('treats an unavailable list as unsupported and other failures as errors', async () => {
    const respond = (response: Response) => (async () => response) as unknown as typeof fetch;
    expect(await fetchProviderAccounts('openai', null, { fetchImpl: respond(Response.json({}, { status: 501 })) })).toBeNull();
    expect(await fetchProviderAccounts('openai', null, { fetchImpl: respond(Response.json({}, { status: 404 })) })).toBeNull();
    await expect(fetchProviderAccounts('openai', null, {
      fetchImpl: respond(Response.json({ error: 'Host configuration is restricted to administrators' }, { status: 403 })),
    })).rejects.toThrow('Host configuration is restricted to administrators');
  });

  test('sends account mutations to the admitted credential routes with the CSRF header', async () => {
    const seen: Array<{ url: string; method: string; body: string | null; csrf: string | null }> = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      seen.push({ url: input, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : null, csrf: new Headers(init?.headers).get('X-DevRyan-CSRF') });
      return Response.json(true);
    }) as unknown as typeof fetch;
    await mutateProviderAccount('cred_a', { operation: 'activate' }, '/work', { fetchImpl });
    await mutateProviderAccount('cred_a', { operation: 'rename', label: '  Work  ' }, null, { fetchImpl });
    await mutateProviderAccount('cred_a', { operation: 'remove' }, null, { fetchImpl });
    expect(seen).toEqual([
      { url: '/api/credential/cred_a/activate?directory=%2Fwork', method: 'POST', body: '{}', csrf: '1' },
      { url: '/api/credential/cred_a', method: 'PATCH', body: '{"label":"Work"}', csrf: '1' },
      { url: '/api/credential/cred_a', method: 'DELETE', body: null, csrf: '1' },
    ]);
    await expect(mutateProviderAccount('../x', { operation: 'remove' }, null, { fetchImpl })).rejects.toThrow('Invalid account');
  });

  test('carries the server refusal code', async () => {
    const fetchImpl = (async () => Response.json({ error: 'native_credential_changed', code: 'native_credential_changed' }, { status: 409 })) as unknown as typeof fetch;
    const error = await mutateProviderAccount('cred_a', { operation: 'activate' }, null, { fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderAccountRequestError);
    expect(error instanceof ProviderAccountRequestError ? [error.code, error.status] : null).toEqual(['native_credential_changed', 409]);
  });
});
