import express from 'express';
import { createDiagnosticSanitizer } from '@openchamber/harness-runtime';
import { describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';
import { registerAuthAndAccessRoutes } from '../opencode/core-routes.js';
import { createLocalBotOwner } from './local-owner.js';
import { registerBotRoutes } from './routes.js';

// Exercise the real native-cookie/auth middleware and Bot routes. The shared
// account boundary refuses requests in every disconnected Supabase mode.
const fixture = async (mode) => {
  const records = new Map();
  const owner = await createLocalBotOwner({ vault: { get: (key) => records.get(key), set: async (key, value) => records.set(key, value) } });
  const cookie = await owner.issueSession();
  const requireAuth = vi.fn((_req, res) => res.status(mode === 'absent' ? 401 : 503).json({ code: 'supabase_unavailable' }));
  const app = express();
  registerAuthAndAccessRoutes(app, {
    getBotOwner: () => owner,
    tunnelAuthController: { classifyRequestScope: () => 'local', getActiveTunnelMode: () => null },
    uiAuthController: { multiUser: mode === 'unreachable', requireAuth },
    readSettingsFromDiskMigrated: async () => ({}),
    normalizeTunnelSessionTtlMs: (value) => value,
  });
  let catalogState = { state: 'ready', code: null };
  let startup = 'ready';
  let failed = false;
  const recordsSeen = [];
  registerBotRoutes(app, {
    management: { listCatalog: async (principal) => {
      expect(principal).toBe(owner.principal);
      if (failed) throw Object.assign(new Error('private content must not reach the journal'), { code: 'bot_catalog_read_failed', statusCode: 503 });
      return { bots: [{ id: 'seeded-local-bot' }], canCreateBot: true };
    } },
    getCatalogState: () => catalogState,
    getStartupState: () => startup,
    recordDiagnostic: (event) => {
      const record = createDiagnosticSanitizer().sanitizeRecord(event);
      recordsSeen.push({ type: record.type, event: record.event, payload: record.payload });
    },
  });
  return { app, requireAuth, cookie: `${cookie.name}=${cookie.value}`, recordsSeen,
    setState: (value) => { catalogState = value; }, start: () => { startup = 'starting'; }, fail: () => { failed = true; } };
};

describe('local Bot access without a Supabase connection', () => {
  it.each(['absent', 'off', 'unreachable'])('reads seeded local Bots with native owner authority when Supabase is %s', async (mode) => {
    const harness = await fixture(mode);
    const response = await request(harness.app).get('/api/bots').set('Cookie', harness.cookie).expect(200);
    expect(response.body.bots).toEqual([{ id: 'seeded-local-bot' }]);
    expect(harness.requireAuth).not.toHaveBeenCalled();
    await request(harness.app).get('/api/bots').expect(mode === 'absent' ? 401 : 503);
    await request(harness.app).get('/api/bots').set('Cookie', harness.cookie).set('X-Forwarded-For', '203.0.113.10').expect(mode === 'absent' ? 401 : 503);
    await request(harness.app).get('/api/unrelated').set('Cookie', harness.cookie).expect(mode === 'absent' ? 401 : 503);
  });

  it('journals only bounded metadata for startup, recovery and read failures', async () => {
    for (const kind of ['startup', 'recovery', 'read']) {
      const harness = await fixture('off');
      if (kind === 'startup') harness.start();
      if (kind === 'recovery') harness.setState({ state: 'recovery_required', code: 'bot_database_identity_changed' });
      if (kind === 'read') harness.fail();
      const response = await request(harness.app).get('/api/bots?private=do-not-log').set('Cookie', harness.cookie).expect(503);
      expect(harness.recordsSeen).toEqual([{
        type: 'connection', event: 'bot.catalog.read_failed', payload: {
          path: '/api/bots', statusCode: 503, code: response.body.code,
          state: kind === 'recovery' ? 'recovery_required' : 'ready',
        },
      }]);
      expect(JSON.stringify(harness.recordsSeen)).not.toContain('private');
      expect(JSON.stringify(harness.recordsSeen)).not.toContain(harness.cookie);
    }
  });
});
