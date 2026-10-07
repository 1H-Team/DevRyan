import { expect, it } from 'vitest';
import { createStandardPreviewProviders } from './providers.js';

function fixture() {
  const calls = []; let epoch = 1, connection = false;
  const adapter = createStandardPreviewProviders({ getRuntime: () => ({ generation: 2, version: '2.0.20', epoch, baseUrl: 'http://127.0.0.1:4444' }),
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname; calls.push({ pathname, method: options.method, body: options.body });
      if (pathname === '/api/provider') return Response.json({ data: [{ id: 'anthropic' }] });
      const info = { id: 'anthropic', methods: [{ type: 'key', label: 'API key' }, { type: 'oauth', id: 'login' }],
        connections: connection ? [{ type: 'credential', id: 'cred_fixture', method: 'key' }] : [] };
      if (pathname === '/api/integration') return Response.json({ data: [info] });
      if (pathname === '/api/integration/anthropic') return Response.json({ data: info });
      if (pathname.endsWith('/connect/key')) { connection = true; return new Response(null, { status: 204 }); }
      if (pathname === '/api/credential/cred_fixture') { connection = false; return new Response(null, { status: 204 }); }
      throw new Error('Unexpected route');
    } });
  return { adapter, calls, replace: () => { epoch += 1; } };
}
it('offers only API-key methods, delegates setup to stock integration, and never reads secret credentials', async () => {
  const f = fixture(), options = { directory: '/fixture/project' };
  expect(await f.adapter.providerMethods(options)).toEqual({ anthropic: [{ type: 'api', label: 'API key' }] });
  expect(await f.adapter.saveKey('anthropic', { type: 'api', key: 'fixture-key' }, options)).toEqual({ success: true, configured: true });
  expect(f.calls.find(call => call.pathname.endsWith('/connect/key'))).toMatchObject({ method: 'POST', body: JSON.stringify({ key: 'fixture-key' }) });
  expect((await f.adapter.source('anthropic', options)).sources.auth.exists).toBe(true);
  await f.adapter.providerDisconnect('anthropic', 'auth', options);
  expect((await f.adapter.source('anthropic', options)).sources.auth.exists).toBe(false);
  expect(f.calls.some(call => call.pathname === '/api/credential')).toBe(false);
});
it('refuses OAuth payloads, arbitrary integration IDs and project config removal before mutation', async () => {
  const f = fixture(), options = { directory: '/fixture/project' };
  await expect(f.adapter.saveKey('anthropic', { type: 'oauth', key: 'fixture' }, options)).rejects.toMatchObject({ statusCode: 400 });
  await expect(f.adapter.saveKey('../other', { type: 'api', key: 'fixture' }, options)).rejects.toMatchObject({ statusCode: 400 });
  await expect(f.adapter.providerDisconnect('anthropic', 'all', options)).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(f.calls.some(call => call.method !== 'GET')).toBe(false);
});
