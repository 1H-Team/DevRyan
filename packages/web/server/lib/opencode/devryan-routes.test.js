import express from 'express';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import request from '../../test-supertest.js';

const processes = vi.hoisted(() => ({
  spawn: vi.fn(), spawnSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(), fork: vi.fn(),
}));
vi.mock('child_process', async (original) => ({ ...await original(), ...processes }));
vi.mock('node:child_process', async (original) => ({ ...await original(), ...processes }));

const previousUpdateApiUrl = process.env.DEVRYAN_UPDATE_API_URL;
delete process.env.DEVRYAN_UPDATE_API_URL;
const { registerDevRyanRoutes, UPDATE_INSTALL_UNSUPPORTED } = await import('./devryan-routes.js');
if (previousUpdateApiUrl !== undefined) process.env.DEVRYAN_UPDATE_API_URL = previousUpdateApiUrl;

const RELEASE_PAGE = 'https://github.com/1H-Team/DevRyan/releases/latest';
const nativeFetch = globalThis.fetch;
let releaseFetch;

const appWithRoutes = () => {
  const app = express();
  registerDevRyanRoutes(app, {
    modelsDevApiUrl: 'https://models.invalid/api.json',
    modelsMetadataCacheTtl: 0,
    fetchFreeZenModels: async () => [],
    getCachedZenModels: () => [],
  });
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Supertest drives the loopback app through Node's HTTP client, not fetch;
  // the route's GitHub release lookup is the only fetch and it is answered here.
  releaseFetch = vi.fn(async (url) => {
    if (String(url).includes('api.github.com/repos/1H-Team/DevRyan/releases/latest')) {
      return { ok: true, json: async () => ({ tag_name: 'v9.9.9', body: 'notes', published_at: '2026-11-01T00:00:00Z' }) };
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });
  vi.stubGlobal('fetch', releaseFetch);
});
afterEach(() => { vi.unstubAllGlobals(); expect(globalThis.fetch).toBe(nativeFetch); });

test('update install refuses with a typed pointer to the DMG and starts no process', async () => {
  const response = await request(appWithRoutes()).post('/api/devryan/update-install').expect(410);
  expect(response.body).toEqual({
    error: UPDATE_INSTALL_UNSUPPORTED,
    message: expect.stringContaining('DMG'),
    releaseUrl: RELEASE_PAGE,
  });
  expect(UPDATE_INSTALL_UNSUPPORTED).toBe('update_install_unsupported');
  for (const spawned of Object.values(processes)) expect(spawned).not.toHaveBeenCalled();
  expect(releaseFetch).not.toHaveBeenCalled();
});

test('update check reports the latest GitHub release and the release page without a package manager', async () => {
  const response = await request(appWithRoutes()).get('/api/devryan/update-check?currentVersion=1.0.0').expect(200);
  expect(response.body).toMatchObject({ available: true, version: '9.9.9', currentVersion: '1.0.0', releaseUrl: RELEASE_PAGE });
  expect(response.body).not.toHaveProperty('packageManager');
  expect(response.body).not.toHaveProperty('updateCommand');
  expect(releaseFetch).toHaveBeenCalledTimes(1);
  for (const spawned of Object.values(processes)) expect(spawned).not.toHaveBeenCalled();
});
