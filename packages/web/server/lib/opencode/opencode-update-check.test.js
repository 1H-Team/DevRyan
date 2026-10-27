import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';
import {
  OPENCODE_UPDATE_CHECK_CODES,
  OPENCODE_UPDATE_MAX_BODY_BYTES,
  OPENCODE_UPDATE_REGISTRY_URL,
  checkLatestOpenCodeRelease,
  createOpenCodeUpdateCheckHandler,
} from './opencode-update-check.js';
import { registerOpenCodeRoutes } from './routes.js';

const json = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
  ...init,
});

const abortableHang = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});

const appWith = (fetchImpl, options = {}) => {
  const app = express();
  app.get('/api/config/opencode-update-check', createOpenCodeUpdateCheckHandler({ fetchImpl, ...options }));
  return app;
};

const expectFailure = async (fetchImpl, code, options) => {
  const response = await request(appWith(fetchImpl, options)).get('/api/config/opencode-update-check').expect(503);
  expect(response.body).toEqual({ error: 'opencode_update_check_failed', code });
  expect(response.headers['cache-control']).toBe('no-store');
};

describe('OpenCode upstream update check', () => {
  it('returns the latest stable 2.x version from the fixed registry URL without credentials', async () => {
    const fetchImpl = vi.fn(async () => json({ name: '@opencode/cli', version: '2.0.26' }));
    const response = await request(appWith(fetchImpl))
      .get('/api/config/opencode-update-check')
      .set('Cookie', 'devryan_session=secret')
      .set('Authorization', 'Bearer secret')
      .expect(200);
    expect(response.body).toEqual({ latestVersion: '2.0.26' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://registry.npmjs.org/@opencode%2Fcli/latest');
    expect(url).toBe(OPENCODE_UPDATE_REGISTRY_URL);
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(init)).not.toMatch(/secret|cookie|authorization/i);
  });

  it('reports a timeout when the registry does not answer in time', async () => {
    await expectFailure(vi.fn(abortableHang), OPENCODE_UPDATE_CHECK_CODES.registryTimeout, { timeoutMs: 20 });
  });

  it('reports network failures without leaking upstream text', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND internal-detail'); });
    const response = await request(appWith(fetchImpl)).get('/api/config/opencode-update-check').expect(503);
    expect(response.body).toEqual({ error: 'opencode_update_check_failed', code: OPENCODE_UPDATE_CHECK_CODES.registryUnavailable });
    expect(JSON.stringify(response.body)).not.toContain('internal-detail');
  });

  it('reports non-2xx registry responses as unavailable', async () => {
    for (const status of [404, 500]) {
      await expectFailure(vi.fn(async () => json({ error: 'upstream detail' }, { status })), OPENCODE_UPDATE_CHECK_CODES.registryUnavailable);
    }
  });

  it('rejects malformed JSON and missing or non-string versions as invalid metadata', async () => {
    for (const body of ['{not json', '[]', 'null', JSON.stringify({}), JSON.stringify({ version: 2 }), JSON.stringify({ version: null })]) {
      await expectFailure(vi.fn(async () => json(body)), OPENCODE_UPDATE_CHECK_CODES.metadataInvalid);
    }
  });

  it('rejects versions that are not stable 2.x releases', async () => {
    for (const version of ['1.18.0', '3.0.0', '2.0.26-beta.1', '2.0', ' 2.0.26', '02.0.1', '2.00.1', '2.0.26 ', 'v2.0.26', '']) {
      await expectFailure(vi.fn(async () => json({ version })), OPENCODE_UPDATE_CHECK_CODES.versionUnsupported);
    }
  });

  it('rejects oversize registry bodies', async () => {
    const big = JSON.stringify({ version: '2.0.26', padding: 'x'.repeat(OPENCODE_UPDATE_MAX_BODY_BYTES) });
    await expectFailure(vi.fn(async () => json(big)), OPENCODE_UPDATE_CHECK_CODES.metadataInvalid);
    const declared = vi.fn(async () => json('{}', { headers: { 'content-length': String(OPENCODE_UPDATE_MAX_BODY_BYTES + 1) } }));
    await expectFailure(declared, OPENCODE_UPDATE_CHECK_CODES.metadataInvalid);
  });

  it('aborts the registry request when the caller aborts', async () => {
    const caller = new AbortController();
    let seen;
    const pending = checkLatestOpenCodeRelease({
      fetchImpl: (url, init) => { seen = init.signal; return abortableHang(url, init); },
      signal: caller.signal,
    });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: OPENCODE_UPDATE_CHECK_CODES.registryUnavailable });
    expect(seen.aborted).toBe(true);
  });

  it('is registered with the OpenCode config routes and accepts accepted versions', async () => {
    const app = express();
    const fetchImpl = vi.fn(async () => json({ version: '2.1.0' }));
    registerOpenCodeRoutes(app, {
      cursorSessionTitleRuntime: {}, standardSessionTitleRuntime: {}, globalAgentsMdRuntime: {}, openCodeClient: { generation: () => 2 },
      readSettingsFromDiskMigrated: async () => ({}), getOpenCodeResolutionSnapshot: async () => ({}), openCodeUpdateCheckFetch: fetchImpl,
    });
    await request(app).get('/api/config/opencode-update-check').expect(200).expect({ latestVersion: '2.1.0' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
