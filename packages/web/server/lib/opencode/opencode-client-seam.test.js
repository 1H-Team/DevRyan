// Native client seam, explicit identity refusal, and application helper projection.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeFixtureForGeneration } from '../../../../../scripts/perf/loopback-opencode-fixtures.mjs';
import { PERF_CHILD_SESSION_IDS, PERF_PARENT_SESSION_ID } from '../../../../../scripts/perf/fixture-session-seeds.mjs';
import request from '../../test-supertest.js';
import { createBrowserLeaseRuntime } from '../browser-cdp/lease-runtime.js';
import { createImageAssetsRuntime } from '../image-assets/runtime.js';
import { createNotificationTemplateRuntime } from '../notifications/template-runtime.js';

import { createOpenCodeClient } from './opencode-client/index.js';
import { openCodeClientErrorStatus, resolveGen2OpenCodeClient } from './opencode-client-seam.js';
import { registerPwaManifestRoute } from './pwa-manifest-routes.js';
import { createStandardSessionTitleRuntime } from './standard-session-title-runtime.js';
import { createMemorySessionTitleOutbox } from './session-title-outbox.js';

describe('openCodeClient seam', () => {
  const client = (generation) => ({ generation: () => generation });

  it('requires an explicitly identified native client', () => {
    const gen2 = client(2);
    expect(resolveGen2OpenCodeClient(gen2)).toBe(gen2);
    for (const value of [client(1), null, undefined, { sessions: {} }]) {
      expect(() => resolveGen2OpenCodeClient(value)).toThrow(expect.objectContaining({ code: 'opencode_generation_invalid', statusCode: 503 }));
    }
  });

  it('reads a getter on every call and refuses a subsequent legacy identity', () => {
    let generation = 2;
    const target = { generation: () => generation }, getter = vi.fn(() => target);
    expect(resolveGen2OpenCodeClient(getter)).toBe(target);
    generation = 1;
    expect(() => resolveGen2OpenCodeClient(getter)).toThrow(expect.objectContaining({ code: 'opencode_generation_invalid' }));
    expect(getter).toHaveBeenCalledTimes(2);
  });

  it('propagates an unknown generation instead of choosing a backend', () => {
    const invalid = { generation: () => { throw new Error('The OpenCode runtime generation is unknown'); } };
    expect(() => resolveGen2OpenCodeClient(invalid)).toThrow('unknown');
  });

  it('reads the HTTP status of a client error', () => {
    expect(openCodeClientErrorStatus({ statusCode: 404 })).toBe(404);
    expect(openCodeClientErrorStatus(new TypeError('fetch failed'))).toBe(0);
    expect(openCodeClientErrorStatus({ statusCode: 'x' })).toBe(0);
    expect(openCodeClientErrorStatus(null)).toBe(0);
  });
});

describe('application helpers over native fixture (real openCodeClient)', () => {
  const GENERATIONS = [2];
  let directory;
  /** @type {Record<number, { fixture: any, client: ReturnType<typeof createOpenCodeClient>, deps: Record<string, unknown> }>} */
  const h = {};

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'devryan-helper-batch-b-'));
    for (const generation of GENERATIONS) {
      const fixture = await createLoopbackOpenCodeFixtureForGeneration(generation, { directory, heartbeatMs: 50 });
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation, baseUrl: fixture.origin }),
        getAuthHeaders: () => ({ ...fixture.authHeaders }),
      });
      const deps = {
        openCodeClient: client,
        getOpenCodeAuthHeaders: () => ({ ...fixture.authHeaders }),
        // Gen 2 must never build a v1 URL.
        buildOpenCodeUrl: () => { throw new Error('native helper built a legacy OpenCode URL'); },
      };
      h[generation] = { fixture, client, deps };
    }
  });

  afterAll(async () => {
    for (const generation of GENERATIONS) {
      h[generation]?.fixture.stopScenario?.({ settle: false });
      await h[generation]?.fixture.close();
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const native = async run => await run(h[2]);

  const textOf = (record) => (record.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');

  it('notification templates read the same session info and messages', async () => {
    const one = await native(async ({ deps }) => {
      const runtime = createNotificationTemplateRuntime({
        readSettingsFromDisk: async () => ({}),
        persistSettings: async () => {},
        resolveGitBinaryForSpawn: () => 'git',
        ...deps,
      });
      const info = await runtime.fetchSessionInfo(PERF_PARENT_SESSION_ID);
      const messages = await runtime.fetchSessionMessages(PERF_PARENT_SESSION_ID, 5);
      return {
        title: info?.title,
        directory: info?.directory,
        messages: messages.map((record) => ({ role: record.info.role, text: textOf(record) })),
      };
    });
    expect(one.title).toBe('Performance parent');
    expect(one.messages.length).toBeGreaterThan(0);
  });

  it('browser lease lineage resolves the canonical root session', async () => {
    const one = await native(({ deps }) => createBrowserLeaseRuntime({ ...deps, getDiscoveryToken: () => 'token' })
      .resolveRootSessionID({ opencodeSessionID: PERF_CHILD_SESSION_IDS[0], directory }));
    expect(one).toBe(PERF_PARENT_SESSION_ID);
  });

  it('the PWA manifest lists native recent sessions', async () => {
    const one = await native(async ({ deps }) => {
      const app = express();
      registerPwaManifestRoute(app, {
        process: { platform: process.platform },
        resolveProjectDirectory: async () => ({ directory }),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback),
        normalizePwaOrientation: (_value, fallback) => fallback,
        ...deps,
      });
      const response = await request(app).get('/manifest.webmanifest');
      return JSON.parse(response.text).shortcuts.map((shortcut) => shortcut.url).filter((url) => url.startsWith('/?session='));
    });
    expect(one).toHaveLength(3);
    expect(one.every(url => url.includes('session='))).toBe(true);
  });

  // The seeded transcript holds user messages only until a scenario runs, so
  // the message read is checked through the role gate (400).
  it('assistant image preparation reads the canonical message', async () => {
    const one = await native(async ({ deps, client }) => {
      const { records } = await client.sessions.messages(PERF_PARENT_SESSION_ID, {}, { directory });
      const target = records.find((record) => record.info.role === 'user');
      expect(target).toBeDefined();
      const runtime = createImageAssetsRuntime({
        fsPromises: { realpath: async (value) => value, stat: async () => { throw new Error('unexpected'); } },
        path,
        os: { tmpdir },
        crypto: { randomUUID: () => 'grant' },
        ...deps,
      });
      const app = express();
      app.use((req, _res, next) => {
        req.principal = { id: 'user-1', scope: 'managed', role: 'developer' };
        next();
      });
      runtime.registerRoutes(app);
      const response = await request(app)
        .post(`/api/devryan/sessions/${PERF_PARENT_SESSION_ID}/image-assets/prepare`)
        .send({ messageId: target.info.id, sources: ['unreferenced.png'] });
      return { messageID: target.info.id, status: response.status, body: response.body };
    });
    expect(one).toMatchObject({ status: 400, body: { error: 'Assistant message required' } });
  });

  it('session titles find no stale helper sessions on the native runtime', async () => {
    const one = await native(async ({ deps }) => {
      const runtime = createStandardSessionTitleRuntime({
        ...deps,
        fetchImpl: (...args) => globalThis.fetch(...args),
        outbox: createMemorySessionTitleOutbox(),
        watchdogEnabled: false,
        logger: { warn: vi.fn() },
      });
      try {
        return await runtime.cleanupStaleHelpers({ directory });
      } finally {
        await runtime.dispose();
      }
    });
    expect(one).toBe(0);
  });
});
