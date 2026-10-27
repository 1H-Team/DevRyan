import { createNativeConsumerFixture } from './test-native-consumer-client.js';
const registerPwaManifestRoute = (app, options) => registerPwaManifestRouteNative(app, {
  ...options, openCodeClient: options.openCodeClient ?? createNativeConsumerFixture({
    readFixture: (...args) => globalThis.fetch(...args), headers: options.getOpenCodeAuthHeaders,
  }),
});
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';

import { registerPwaManifestRoute as registerPwaManifestRouteNative } from './pwa-manifest-routes.js';

const SESSIONS = [
  { id: 'ses_old', title: 'Old session', directory: '/workspace', time: { created: 1, updated: 10 } },
  { id: 'ses_new', title: 'Newest session', directory: '/workspace', time: { created: 2, updated: 40 } },
  { id: 'ses_mid', title: 'Middle session', directory: '/workspace/sub', time: { created: 3, updated: 30 } },
  { id: 'ses_other', title: 'Other project', directory: '/elsewhere', time: { created: 4, updated: 50 } },
];

const createApp = ({ directory = '/workspace', openCodeClient } = {}) => {
  const app = express();
  registerPwaManifestRoute(app, {
    process: { platform: 'darwin' },
    resolveProjectDirectory: async () => ({ directory }),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic internal' }),
    readSettingsFromDiskMigrated: async () => ({}),
    normalizePwaAppName: (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback),
    normalizePwaOrientation: (value, fallback) => (value === 'portrait' || value === 'landscape' ? value : fallback),
    ...(openCodeClient ? { openCodeClient } : {}),
  });
  return app;
};

const sessionShortcutUrls = (manifest) => manifest.shortcuts
  .filter((shortcut) => shortcut.url.startsWith('/?session='))
  .map((shortcut) => shortcut.url);

const readManifest = async (app) => {
  const response = await request(app).get('/manifest.webmanifest');
  expect(response.status).toBe(200);
  return JSON.parse(response.text);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PWA manifest recent-session shortcuts', () => {
  it('lists the three most recently updated sessions of the project (gen 1 request)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => SESSIONS });

    const manifest = await readManifest(createApp());

    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://opencode.test/session?directory=%2Fworkspace');
    expect(sessionShortcutUrls(manifest)).toEqual(['/?session=ses_new', '/?session=ses_mid', '/?session=ses_old']);
  });
});

// Gen 2 (DESIGN C.1, E item 13b): the session list goes through openCodeClient.
describe('PWA manifest recent-session shortcuts on OpenCode 2 (openCodeClient)', () => {
  const createClient = ({ generation = 2, list } = {}) => ({
    generation: typeof generation === 'function' ? generation : () => generation,
    sessions: { list: vi.fn(list ?? (async () => SESSIONS)) },
  });

  it('lists sessions through the client with the project directory', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const openCodeClient = createClient();

    const manifest = await readManifest(createApp({ openCodeClient }));

    expect(openCodeClient.sessions.list).toHaveBeenCalledWith({ directory: '/workspace' }, { timeoutMs: 2500 });
    expect(sessionShortcutUrls(manifest)).toEqual(['/?session=ses_new', '/?session=ses_mid', '/?session=ses_old']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the unscoped list when the project has no sessions', async () => {
    const openCodeClient = createClient({
      list: async (query) => (query.directory ? [] : SESSIONS.filter((session) => session.id === 'ses_other')),
    });

    const manifest = await readManifest(createApp({ directory: '/empty-project', openCodeClient }));

    expect(openCodeClient.sessions.list.mock.calls.map(([query]) => query)).toEqual([{ directory: '/empty-project' }, {}]);
    expect(sessionShortcutUrls(manifest)).toEqual(['/?session=ses_other']);
  });

  it('serves the manifest without session shortcuts when the client refuses the list', async () => {
    const openCodeClient = createClient({
      list: async () => { throw Object.assign(new Error('unavailable'), { statusCode: 503 }); },
    });

    const manifest = await readManifest(createApp({ openCodeClient }));

    expect(sessionShortcutUrls(manifest)).toEqual([]);
    expect(manifest.shortcuts[0]).toMatchObject({ url: '/?settings=appearance' });
  });

  it('omits runtime shortcuts for unsupported generation 1', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => SESSIONS });
    const openCodeClient = createClient({ generation: 1 });

    const manifest = await readManifest(createApp({ openCodeClient }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openCodeClient.sessions.list).not.toHaveBeenCalled();
    expect(sessionShortcutUrls(manifest)).toHaveLength(0);
  });

  it('sends no request when the client generation is unknown (fail closed)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const openCodeClient = createClient({
      generation: () => { throw Object.assign(new Error('unknown generation'), { statusCode: 503 }); },
    });

    const manifest = await readManifest(createApp({ openCodeClient }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openCodeClient.sessions.list).not.toHaveBeenCalled();
    expect(sessionShortcutUrls(manifest)).toEqual([]);
  });
});
