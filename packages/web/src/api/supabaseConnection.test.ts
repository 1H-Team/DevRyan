import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebSupabaseConnectionAPI } from './supabaseConnection';

const status = { configured: true, desiredEnabled: false, effectiveEnabled: false, state: 'disconnected',
  errorCode: null, restartRequired: false, restartAvailable: true, blockers: [] };
afterEach(() => vi.unstubAllGlobals());

describe('Supabase connection adapter', () => {
  it('preserves configured Off and redacted unconfigured status without writing a preference', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(status))
      .mockResolvedValueOnce(Response.json({ ...status, configured: false }));
    vi.stubGlobal('fetch', fetcher);
    const api = createWebSupabaseConnectionAPI();
    expect(await api.getStatus()).toEqual(status);
    expect(await api.getStatus()).toMatchObject({ configured: false, effectiveEnabled: false });
    expect(fetcher.mock.calls).toEqual(Array(2).fill(['/api/system/supabase-connection', { cache: 'no-store' }]));
  });
  it.each([[401, 'unauthenticated'], [403, 'forbidden'], [404, 'unsupported'], [503, 'temporary']])(
    'retains %s as a typed %s failure', async (code, kind) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: Number(code) })));
      await expect(createWebSupabaseConnectionAPI().getStatus()).rejects.toMatchObject({ kind, status: code });
    });
  it('normalizes network and invalid payload failures and can recover', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(Response.json({ configured: true }))
      .mockResolvedValueOnce(Response.json(status)));
    const api = createWebSupabaseConnectionAPI();
    await expect(api.getStatus()).rejects.toMatchObject({ kind: 'temporary', status: null });
    await expect(api.getStatus()).rejects.toMatchObject({ kind: 'temporary', status: 200 });
    expect(await api.getStatus()).toEqual(status);
  });
  it('preserves the owner PATCH body and CSRF contract', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(status, { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await createWebSupabaseConnectionAPI().setEnabled(false)).toEqual(status);
    expect(fetcher).toHaveBeenCalledWith('/api/system/supabase-connection', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' }, body: '{"enabled":false}',
    });
  });
});
