import { describe, expect, it, vi } from 'vitest';

import { createSupabaseServerClient } from './supabase-client.js';

const jsonResponse = (payload = [], status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Supabase server client', () => {
  it('uses modern keys only as apikey values and never as bearer tokens', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createSupabaseServerClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
      fetchImpl,
    });

    await client.rest('user_profiles');
    await client.signInWithPassword({ email: 'developer@example.test', password: 'password' });

    expect(fetchImpl.mock.calls[0][1].headers.apikey).toBe('sb_secret_private');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchImpl.mock.calls[1][1].headers.apikey).toBe('sb_publishable_public');
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('retains bearer authorization for legacy JWT service keys', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const legacyKey = 'header.payload.signature';
    const client = createSupabaseServerClient({
      url: 'https://project.supabase.co',
      publishableKey: legacyKey,
      secretKey: legacyKey,
      fetchImpl,
    });

    await client.rest('user_profiles');

    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${legacyKey}`);
  });

  it('encodes PostgREST filters without exposing the secret key in the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 'user' }]));
    const client = createSupabaseServerClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
      fetchImpl,
    });

    const result = await client.rest('user_profiles', {
      query: { email: 'eq.developer+test@example.test', limit: 1 },
      maybeSingle: true,
    });

    expect(result).toEqual({ id: 'user' });
    const requestUrl = fetchImpl.mock.calls[0][0];
    expect(requestUrl).toContain('email=eq.developer%2Btest%40example.test');
    expect(requestUrl).not.toContain('sb_secret_private');
  });

  it('calls PostgREST functions with the server secret key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ moved: true }));
    const client = createSupabaseServerClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
      fetchImpl,
    });

    await expect(client.rpc('devryan_reassign_github_account', {
      p_account_id: 'account-a',
      p_target_user_id: '22222222-2222-4222-8222-222222222222',
    })).resolves.toEqual({ moved: true });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://project.supabase.co/rest/v1/rpc/devryan_reassign_github_account',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          p_account_id: 'account-a',
          p_target_user_id: '22222222-2222-4222-8222-222222222222',
        }),
      }),
    );
    expect(fetchImpl.mock.calls[0][1].headers.apikey).toBe('sb_secret_private');
  });
});
