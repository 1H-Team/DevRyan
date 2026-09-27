import { describe, expect, it } from 'vitest';

import {
  BOT_OWNER_COOKIE,
  BOT_OWNER_RECORD_KEY,
  createLocalBotOwner,
  isBotApiPath,
} from './local-owner.js';

const memoryVault = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => (values.has(key) ? structuredClone(values.get(key)) : null),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    values,
  };
};

const request = ({ url = '/api/bots', cookie = '', host = '127.0.0.1:3000', address = '127.0.0.1', headers = {}, method = 'GET' } = {}) => ({
  method,
  originalUrl: url,
  url,
  socket: { remoteAddress: address },
  headers: { host, ...(cookie ? { cookie } : {}), ...headers },
});

describe('local Bot owner identity', () => {
  it('creates the identity once and never replaces it', async () => {
    const vault = memoryVault();
    const first = await createLocalBotOwner({ vault });
    const second = await createLocalBotOwner({ vault });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.id).toBe(first.id);
    await second.issueSession();
    await second.revokeSessions();
    expect(vault.get(BOT_OWNER_RECORD_KEY).id).toBe(first.id);
    expect(first.principal).toMatchObject({ id: first.id, scope: 'bot-owner', botOwner: true, role: 'admin' });
  });

  it('fails closed on an unreadable record instead of minting a new identity', async () => {
    const vault = memoryVault({ [BOT_OWNER_RECORD_KEY]: { version: 1, id: 'not-a-uuid', createdAt: 'x', sessions: [] } });
    await expect(createLocalBotOwner({ vault })).rejects.toMatchObject({ code: 'bot_local_owner_invalid' });
    expect(vault.get(BOT_OWNER_RECORD_KEY).id).toBe('not-a-uuid');
  });

  it('authenticates only direct-local Bot routes with a native-issued session', async () => {
    let now = 1_000_000;
    const owner = await createLocalBotOwner({ vault: memoryVault(), now: () => now });
    const cookie = await owner.issueSession();
    expect(cookie).toMatchObject({ name: BOT_OWNER_COOKIE, maxAge: 30 * 24 * 60 * 60 });
    const valid = `${BOT_OWNER_COOKIE}=${cookie.value}`;

    expect(owner.authenticate(request({ cookie: valid }))).toBe(owner.principal);
    expect(owner.authenticate(request({ cookie: valid, url: '/api/bot-channels/x/messages' }))).toBe(owner.principal);
    // Never outside Bot routes, never remotely, never through a forwarder.
    for (const denied of [
      request({ cookie: valid, url: '/api/admin/users' }),
      request({ cookie: valid, url: '/api/fs/read' }),
      request({ cookie: valid, url: '/api/botsx' }),
      request({ cookie: valid, address: '203.0.113.9' }),
      request({ cookie: valid, host: 'devryan.example.com' }),
      request({ cookie: valid, headers: { 'x-forwarded-host': 'evil.example' } }),
      request({ cookie: valid, headers: { origin: 'https://evil.example' } }),
      request({ cookie: `${BOT_OWNER_COOKIE}=forged` }),
      request({}),
    ]) {
      expect(owner.authenticate(denied)).toBeNull();
    }
    now += 31 * 24 * 60 * 60 * 1000;
    expect(owner.authenticate(request({ cookie: valid }))).toBeNull();
  });

  it('requires the CSRF header for state-changing owner requests', async () => {
    const owner = await createLocalBotOwner({ vault: memoryVault() });
    expect(owner.requiresCsrf(request({ method: 'POST' }))).toBe(true);
    expect(owner.requiresCsrf(request({ method: 'GET' }))).toBe(false);
    expect(owner.hasCsrf(request({ method: 'POST', headers: { 'x-devryan-csrf': '1' } }))).toBe(true);
    expect(owner.hasCsrf(request({ method: 'POST' }))).toBe(false);
  });

  it('recognizes only Bot API paths', () => {
    expect(isBotApiPath({ originalUrl: '/api/bots/capabilities' })).toBe(true);
    expect(isBotApiPath({ originalUrl: '/api/bot-audit?limit=5' })).toBe(true);
    expect(isBotApiPath({ originalUrl: '/api/bots' })).toBe(true);
    expect(isBotApiPath({ originalUrl: '/api/botsecrets' })).toBe(false);
    expect(isBotApiPath({ originalUrl: '/api/session' })).toBe(false);
  });
});
