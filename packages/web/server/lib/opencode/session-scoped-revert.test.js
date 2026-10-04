// Generation 2 (DESIGN.md E item 13c): the legacy snapshot runners are
// capability absent; the read-only change summary reads through the client.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

import {
  computeScopedSessionChanges,
  registerScopedSessionRevertRoute,
  runScopedSessionRevert,
  runScopedSessionUnrevert,
} from './session-scoped-revert.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const listen = async (app) => {
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};

const createFakeClient = (generation = 2) => ({
  generation: () => generation,
  sessions: {
    get: vi.fn(async (id) => ({ id, title: `title ${id}`, projectID: 'project', time: { created: 1, updated: 2 } })),
    children: vi.fn(async (id) => (id === 'ses_root' ? [{ id: 'ses_child', parentID: 'ses_root' }] : [])),
    status: vi.fn(async () => ({})),
  },
});

const absent = { code: 'capability_absent', status: 409, capability: 'conversation_revert', generation: 2 };

describe('scoped session revert (generation 2)', () => {
  it('refuses the legacy runners before any request', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('unexpected raw fetch'); });
    const openCodeClient = createFakeClient();
    const options = { buildOpenCodeUrl: (route) => `http://opencode.test${route}`, fetchImpl, openCodeClient,
      directory: '/repo', sessionID: 'ses_root', openchamberDataDir: '/unused' };

    await expect(runScopedSessionRevert({ ...options, messageID: 'msg_1' })).rejects.toMatchObject(absent);
    await expect(runScopedSessionUnrevert(options)).rejects.toMatchObject(absent);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openCodeClient.sessions.get).not.toHaveBeenCalled();
  });

  it('answers the legacy routes with a typed 409 and serves the change summary through the client', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('unexpected raw fetch'); });
    const openCodeClient = createFakeClient();
    const guarded = [];
    const app = express();
    registerScopedSessionRevertRoute(app, {
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      fetchImpl,
      openCodeClient,
      assertLegacyRevertAllowed: async ({ sessionID }) => { guarded.push(sessionID); },
    });
    const base = await listen(app);
    const query = `directory=${encodeURIComponent('/repo')}`;

    for (const [route, body] of [['scoped-revert', { messageID: 'msg_1' }], ['scoped-unrevert', {}]]) {
      const response = await fetch(`${base}/api/openchamber/session/ses_root/${route}?${query}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'OpenCode 2 does not provide conversation_revert yet', code: 'capability_absent' });
    }
    expect(guarded).toEqual([]);

    const changes = await fetch(`${base}/api/openchamber/session/ses_root/changes?${query}`);
    expect(changes.status).toBe(200);
    expect(await changes.json()).toMatchObject({ sessionCount: 2, rootSessionID: 'ses_root', coverage: 'partial', reasons: ['historical_capture_unavailable'] });
    expect(openCodeClient.sessions.get).toHaveBeenCalledWith('ses_root', expect.objectContaining({ directory: '/repo', allowNotFound: true }));
    expect(openCodeClient.sessions.children.mock.calls.map(([id]) => id)).toEqual(['ses_root', 'ses_child']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, createFakeClient(1), createFakeClient(3)])('refuses unsupported identity without raw change reads: %j', async openCodeClient => {
    const fetchImpl = vi.fn();
    await expect(computeScopedSessionChanges({ fetchImpl, openCodeClient, directory: '/repo', sessionID: 'ses_root' }))
      .rejects.toMatchObject({ code: 'opencode_generation_invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
