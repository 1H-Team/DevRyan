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

  it('allows individual PostgREST calls to shorten the default request timeout', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const client = createSupabaseServerClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
      fetchImpl,
    });

    await client.rest('opencode_session_ownership', {
      method: 'POST',
      body: { session_id: 'session-a' },
      timeoutMs: 5_000,
    });
    await client.rest('user_profiles');

    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 5_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 15_000);
  });

  it('uploads, downloads, and deletes private Storage objects without signed URLs', async () => {
    const ciphertext = Buffer.from('ciphertext-only');
    const fetchImpl = vi.fn(async (_input, init = {}) => {
      if (init.method === 'POST') return jsonResponse({ Key: 'private/object.bin' });
      if (init.method === 'DELETE') return jsonResponse({ message: 'ok' });
      return new Response(ciphertext, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    });
    const client = createSupabaseServerClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
      fetchImpl,
    });

    await client.storageUpload('devryan-bot-objects', 'private/object.bin', ciphertext);
    await expect(client.storageDownload(
      'devryan-bot-objects',
      'private/object.bin',
    )).resolves.toEqual(ciphertext);
    await client.storageDelete('devryan-bot-objects', ['private/object.bin']);

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://project.supabase.co/storage/v1/object/devryan-bot-objects/private/object.bin',
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: ciphertext,
      headers: {
        apikey: 'sb_secret_private',
        'Content-Type': 'application/octet-stream',
      },
    });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchImpl.mock.calls[2][1]).toMatchObject({
      method: 'DELETE',
      body: JSON.stringify({ prefixes: ['private/object.bin'] }),
    });
    expect(fetchImpl.mock.calls.flatMap(([input]) => String(input))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('sign')]),
    );
    expect(client).not.toHaveProperty('createSignedUrl');
    expect(client).not.toHaveProperty('getPublicUrl');
  });

  it('bounds Storage responses and request duration', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => new Response(Buffer.alloc(9), {
      status: 200,
      headers: { 'Content-Length': '9' },
    }));
    const client = createSupabaseServerClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
      fetchImpl,
    });

    await expect(client.storageDownload('devryan-bot-objects', 'object.bin', {
      maximumBytes: 8,
      timeoutMs: 1_234,
    })).rejects.toMatchObject({
      status: 502,
      message: 'Supabase Storage response is too large',
    });
    expect(timeoutSpy).toHaveBeenCalledWith(1_234);
    await expect(client.storageUpload(
      'devryan-bot-objects',
      'object.bin',
      Buffer.alloc(9),
      { maximumBytes: 8 },
    )).rejects.toMatchObject({ status: 413 });
    await expect(client.storageDownload('devryan-bot-objects', 'object.bin', {
      timeoutMs: 60_001,
    })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects traversal and unbounded Storage delete requests before fetch', async () => {
    const fetchImpl = vi.fn();
    const client = createSupabaseServerClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
      fetchImpl,
    });

    await expect(client.storageDownload('devryan-bot-objects', '../secret'))
      .rejects.toMatchObject({ status: 400 });
    await expect(client.storageDelete('devryan-bot-objects', []))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
