import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticJournal, createDiagnosticSanitizer } from '@openchamber/harness-runtime';
import { compareAndSwapOpenAiAuth, createOpenAiOAuthCoordinator } from './openai-oauth-coordinator.js';
import { createOpenAiOAuthBridge } from './openai-oauth-bridge.js';
import plugin from '../../default-config/plugins/devryan-openai-oauth.mjs';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const clock = Date.now();
const originalAuth = () => ({
  type: 'oauth',
  accountId: 'account-a',
  access: 'old-access',
  refresh: 'old-refresh',
  expires: clock - 1,
  methodID: 'chatgpt-siwc',
  clientId: 'oaiapp_fixture_client',
  scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
  metadata: {
    accountID: 'account-a',
    clientId: 'oaiapp_fixture_client',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
    subject: 'account-a',
    extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    planUsage: true,
  },
});
const refreshed = () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
function fixture(options = {}) {
  let record = originalAuth();
  const fetchImpl = vi.fn(async () => refreshed());
  const write = vi.fn((expected, next) => {
    if (JSON.stringify(record) !== JSON.stringify(expected)) return false;
    record = structuredClone(next);
    return true;
  });
  const diagnostic = vi.fn();
  const coordinator = createOpenAiOAuthCoordinator({ readAuth: () => structuredClone(record),
    compareAndSwap: write, fetchImpl, now: () => clock, recordDiagnostic: diagnostic, ...options });
  coordinator.markReady();
  return { coordinator, fetchImpl, write, diagnostic, get: () => record, set: (next) => { record = next; } };
}

describe('SIWC refreshed grant and registration binding', () => {
  it('does not release a different issued registration for the same subject', async () => {
    const f = fixture(); f.set({ ...originalAuth(), expires: clock + 3600000 });
    const expectedRegistrationKey = f.coordinator.getBinding().registrationKey;
    f.set({ ...f.get(), clientId: 'other-issued-client', metadata: { ...f.get().metadata, clientId: 'other-issued-client' } });
    await expect(f.coordinator.access({ expectedAccountId: 'account-a', expectedRegistrationKey }))
      .rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('persists an explicitly narrowed refresh grant and stops plan usage', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'openid' }));
    const f = fixture({ fetchImpl });
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(f.get().metadata).toMatchObject({ scopes: ['openid'], planUsage: false });
    expect(f.write).toHaveBeenCalledOnce();
  });
  it.each(['valid', 'issuer', 'audience', 'subject', 'signature'])('verifies returned refresh ID token %s before writing credentials', async (kind) => {
    const keys = await generateKeyPair('RS256'), jwk = await exportJWK(keys.publicKey);
    const privateKey = kind === 'signature' ? (await generateKeyPair('RS256')).privateKey : keys.privateKey;
    const idToken = await new SignJWT({ email: 'fixture@example.test' }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(kind === 'issuer' ? 'https://fixture.invalid' : 'https://auth.openai.com')
      .setAudience(kind === 'audience' ? 'foreign-client' : 'oaiapp_fixture_client')
      .setSubject(kind === 'subject' ? 'foreign-subject' : 'account-a').setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600).sign(privateKey);
    const f = fixture({ jwksImpl: createLocalJWKSet({ keys: [jwk] }),
      fetchImpl: async () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, id_token: idToken }) });
    if (kind === 'valid') {
      expect(await f.coordinator.access()).toMatchObject({ accessToken: 'new-access' });
      expect(f.get().metadata.idToken).toBe(idToken);
    } else {
      await expect(f.coordinator.access()).rejects.toBeInstanceOf(Error);
      expect(f.write).not.toHaveBeenCalled(); expect(f.get().refresh).toBe('old-refresh');
    }
  });
});

describe('explicit native async storage', () => {
  it('persists crash ambiguity by token hash while allowing a genuinely new login token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-oauth-crash-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stateFile = path.join(dir, 'state.json');
    let record = { ...originalAuth(), credentialID: 'native-a', methodID: 'chatgpt-siwc' };
    let startedResolve, finish;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const storage = { readAuth: async () => structuredClone(record), compareAndSwap: async () => false };
    const first = createOpenAiOAuthCoordinator({ now: () => clock, stateFile, readAuth: () => null, asyncStorage: storage,
      fetchImpl: async () => { startedResolve(); await pending; throw new Error('fixture controller ended'); } });
    first.markReady();
    const request = first.access().catch(() => {});
    await started;
    const bytes = fs.readFileSync(stateFile, 'utf8');
    expect(bytes).not.toContain(record.refresh);
    expect(JSON.parse(bytes)).toMatchObject({ refreshing: true, refreshFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    record = { ...record, credentialID: 'native-alias' };
    const fetchImpl = vi.fn(async () => refreshed());
    const restarted = createOpenAiOAuthCoordinator({ now: () => clock, stateFile, readAuth: () => null, asyncStorage: storage, fetchImpl });
    restarted.markReady();
    await expect(restarted.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(fetchImpl).not.toHaveBeenCalled();
    record = { ...record, refresh: 'genuinely-new-login-token', access: 'new-login-access', expires: clock + 3600000 };
    expect((await restarted.access()).accessToken).toBe('new-login-access');
    first.markStopped(); finish(); await request;
  });
  it('uses the existing owner queue without changing legacy storage or inspectors', async () => {
    const legacy = fixture();
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const owned = legacy.coordinator.withAuthMutation(async () => { entered(); await waiting; });
    await started;
    let record = { ...originalAuth(), credentialID: 'native-a', methodID: 'chatgpt-siwc' };
    const fetchImpl = vi.fn(async () => refreshed());
    const native = createOpenAiOAuthCoordinator({ now: () => clock, readAuth: () => null, fetchImpl,
      withMutationQueue: legacy.coordinator.withAuthMutation, asyncStorage: {
        readAuth: async () => structuredClone(record), compareAndSwap: async (_expected, next) => { record = next; return true; },
      } });
    native.markReady();
    const access = native.access({ expectedAccountId: 'account-a' });
    await Promise.resolve(); await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(legacy.coordinator.usesOAuth()).toBe(true);
    expect(legacy.coordinator.getBinding()).toMatchObject({ accountId: 'account-a' });
    expect(legacy.fetchImpl).not.toHaveBeenCalled();
    release(); await owned;
    expect((await access).accessToken).toBe('new-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(legacy.get().access).toBe('old-access');
  });
  it('never falls back to legacy credentials after native controller loss', async () => {
    const readAuth = vi.fn(() => ({ ...originalAuth(), expires: clock + 3600000 }));
    const nativeRead = vi.fn(async () => originalAuth());
    const coordinator = createOpenAiOAuthCoordinator({ readAuth, asyncStorage: {
      isActive: () => false, readAuth: nativeRead, compareAndSwap: async () => false,
    } });
    coordinator.markReady();
    expect(coordinator.usesOAuth()).toBe(false);
    await expect(coordinator.access()).rejects.toMatchObject({ code: 'bot_oauth_coordinator_unavailable' });
    await expect(coordinator.usesOAuthAsync()).rejects.toMatchObject({ code: 'bot_oauth_coordinator_unavailable' });
    expect(readAuth).not.toHaveBeenCalled(); expect(nativeRead).not.toHaveBeenCalled();
  });
  it('does not unblock ambiguous refresh by changing credential ID with the same token', async () => {
    let record = { ...originalAuth(), credentialID: 'native-a', methodID: 'chatgpt-siwc' };
    const fetchImpl = vi.fn(async () => { throw new Error('fixture connection lost after rotation'); });
    const coordinator = createOpenAiOAuthCoordinator({ now: () => clock, fetchImpl,
      readAuth: () => ({ type: 'api', key: 'legacy-fixture' }),
      asyncStorage: { readAuth: async () => structuredClone(record), compareAndSwap: async () => false } });
    coordinator.markReady();
    await expect(coordinator.access()).rejects.toMatchObject({ code: 'bot_oauth_refresh_unavailable' });
    record = { ...record, credentialID: 'native-b' };
    await expect(coordinator.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(coordinator.usesOAuth()).toBe(false);
    expect(await coordinator.getAuthStateAsync()).toBe('reauth_required');
  });
  it('does not replace a concurrently switched selected credential on refresh completion', async () => {
    let record = { ...originalAuth(), credentialID: 'native-a', methodID: 'chatgpt-siwc' };
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const cas = vi.fn(async (expected, next) => {
      if (JSON.stringify(record) !== JSON.stringify(expected)) return false;
      record = next; return true;
    });
    const coordinator = createOpenAiOAuthCoordinator({ now: () => clock, fetchImpl: async () => { startedResolve(); await pending; return refreshed(); },
      readAuth: () => null, asyncStorage: { readAuth: async () => structuredClone(record), compareAndSwap: cas } });
    coordinator.markReady();
    const access = coordinator.access({ expectedAccountId: 'account-a' });
    await started;
    record = { ...originalAuth(), accountId: 'account-b', credentialID: 'native-b', methodID: 'chatgpt-siwc', refresh: 'different-refresh' };
    release();
    await expect(access).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(cas).not.toHaveBeenCalled();
    expect(record.accountId).toBe('account-b');
  });
});

describe('managed OpenAI OAuth owner', () => {
  it('persists ten-day rotated credentials and reloads the unblocked generation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-oauth-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const authFile = path.join(dir, 'auth.json');
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(authFile, JSON.stringify({ openai: originalAuth() }));
    const fetchImpl = vi.fn(async () => Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 864000 }));
    const options = { stateFile, now: () => clock, fetchImpl,
      readAuth: () => JSON.parse(fs.readFileSync(authFile, 'utf8')).openai,
      compareAndSwap: (expected, next) => compareAndSwapOpenAiAuth(expected, next, { authFile }) };
    const coordinator = createOpenAiOAuthCoordinator(options);
    coordinator.markReady();
    const access = await coordinator.access({ expectedAccountId: 'account-a' });
    expect(access).toMatchObject({ accessToken: 'rotated-access', expiresAt: clock + 864000000 });
    expect(options.readAuth()).toEqual({ ...originalAuth(), access: 'rotated-access', refresh: 'rotated-refresh', expires: clock + 864000000 });
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ blocked: false });
    const reloaded = createOpenAiOAuthCoordinator(options);
    reloaded.markReady();
    expect(reloaded.getAuthState('account-a')).toBe('ready');
    expect(await reloaded.access({ expectedAccountId: 'account-a' })).toEqual(access);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, '864000', 119, -1, Number.MAX_SAFE_INTEGER, 120.000001])(
    'blocks invalid expiry %s without saving or retrying rotated credentials', async (expires_in) => {
      const fetchImpl = vi.fn(async () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in }));
      const f = fixture({ fetchImpl });
      await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_oauth_response_invalid' });
      expect(f.write).not.toHaveBeenCalled();
      expect(f.coordinator.getAuthState()).toBe('reauth_required');
      await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { access_token: '', refresh_token: 'new-refresh', expires_in: 864000 },
    { access_token: 'new-access', refresh_token: null, expires_in: 864000 },
    { access_token: 'new-access', refresh_token: '', expires_in: 864000 },
  ])('still blocks invalid rotated token fields with a ten-day expiry', async (tokens) => {
    const f = fixture({ fetchImpl: async () => Response.json(tokens) });
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_oauth_response_invalid' });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.coordinator.getAuthState()).toBe('reauth_required');
  });

  it('still blocks a rotated token bound to a different account with a ten-day expiry', async () => {
    const access_token = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-b' } })).toString('base64url')}.fixture`;
    const f = fixture({ fetchImpl: async () => Response.json({ access_token, refresh_token: 'new-refresh', expires_in: 864000 }) });
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.coordinator.getAuthState()).toBe('reauth_required');
  });

  it('journals a bounded failure reason without provider response contents', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-oauth-'));
    const journal = createDiagnosticJournal({ directory: path.join(dir, 'journal'), sanitizer: createDiagnosticSanitizer(), runtime: 'test' });
    cleanups.push(async () => { await journal.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const f = fixture({ recordDiagnostic: record => journal.enqueue(record),
      fetchImpl: async () => Response.json({ access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', expires_in: 1 }) });
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_oauth_response_invalid' });
    await journal.flush();
    const records = await journal.readRecords();
    expect(records.find(record => record.payload.outcome === 'failed')).toMatchObject({
      event: 'provider.oauth.refresh', payload: { reason: 'bot_oauth_response_invalid', statusCode: 200 },
    });
    expect(JSON.stringify(records)).not.toMatch(/synthetic-private|old-access|old-refresh|account-a/);
  });

  it('guides host reconnection to Providers and Bot reconnection to its settings', async () => {
    for (const bot of [false, true]) {
      const environment = bot
        ? { DEVRYAN_BOT_GATEWAY_URL: 'http://egress:43121', DEVRYAN_BOT_RUNTIME_TOKEN: 'a'.repeat(43) }
        : { DEVRYAN_OPENAI_OAUTH_URL: 'http://127.0.0.1:12345', DEVRYAN_OPENAI_OAUTH_TOKEN: 'a'.repeat(43) };
      const access = plugin.testing.createAccessClient(environment, async () => Response.json({ code: 'bot_opencode_provider_authentication' }, { status: 401 }));
      await expect(access('access')).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication', message:
        `bot_opencode_provider_authentication: Reconnect the selected host OpenAI account in Providers${bot ? ' and Bot Settings' : ''}.` });
    }
  });

  it('coalesces normal chat, concurrent bots, structured work and images into one refresh', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => f.coordinator.access({ expectedAccountId: 'account-a' })));
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.accessToken === 'new-access')).toBe(true);
    expect(new Set(results.map((r) => r.generation)).size).toBe(1);
    expect(JSON.stringify(results)).not.toContain('refresh');
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toMatch(/old-access|new-access|old-refresh|new-refresh|account-a/);
  });

  it('rechecks host login and rejects a different account without a provider call', async () => {
    const f = fixture();
    await f.coordinator.access();
    const oldGeneration = (await f.coordinator.access()).generation;
    f.set({ ...originalAuth(), access: 'reconnected', refresh: 'reconnected-refresh', expires: clock + 3600000 });
    expect(await f.coordinator.access()).toMatchObject({ accessToken: 'reconnected' });
    expect((await f.coordinator.access()).generation).not.toBe(oldGeneration);
    f.set({ ...f.get(), accountId: 'account-b' });
    await expect(f.coordinator.access({ expectedAccountId: 'account-a' })).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403])('blocks rejected refresh generation (%s) until host login changes', async (status) => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () => new Response('sensitive rejection detail', { status }));
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getAuthState()).toBe('reauth_required');
    f.set({ ...originalAuth(), access: 'fresh-login', refresh: 'fresh-login-refresh', expires: clock + 3600000 });
    expect((await f.coordinator.access()).accessToken).toBe('fresh-login');
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain('sensitive');
  });

  it('does not overwrite a login that completes during refresh', async () => {
    const f = fixture();
    let finish;
    f.fetchImpl.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.coordinator.access({ expectedAccountId: 'account-a' });
    await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalled());
    f.set({ ...originalAuth(), access: 'new-login', refresh: 'login-refresh', expires: clock + 3600000 });
    finish(refreshed());
    expect((await pending).accessToken).toBe('new-login');
    expect(f.write).not.toHaveBeenCalled();
  });

  it('does not clear a rejected generation when another writer only reorders auth keys', async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () => new Response('', { status: 401 }));
    await expect(f.coordinator.access()).rejects.toBeDefined();
    f.set(Object.fromEntries(Object.entries(f.get()).reverse()));
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never releases refreshed access when persistence fails or retries its consumed refresh', async () => {
    const f = fixture({ compareAndSwap: () => { throw new Error('disk full'); } });
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_oauth_persistence_failed' });
    await expect(f.coordinator.access()).rejects.toBeDefined();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serializes managed login persistence with refresh but never serializes valid provider requests', async () => {
    const f = fixture();
    let release;
    const login = f.coordinator.withAuthMutation(() => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    const access = f.coordinator.access();
    await Promise.resolve();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    f.set({ ...originalAuth(), access: 'login-wins', expires: clock + 3600000 });
    release();
    await login;
    expect((await access).accessToken).toBe('login-wins');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed for corrupt state without crashing the web runtime', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-oauth-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(stateFile, 'broken state');
    const f = fixture({ stateFile });
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_oauth_persistence_failed' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks ambiguous successful exchanges rather than retrying consumed tokens', async () => {
    const f = fixture({ fetchImpl: vi.fn(async () => new Response('malformed success')) });
    await expect(f.coordinator.access()).rejects.toBeDefined();
    expect(f.coordinator.getAuthState()).toBe('reauth_required');
    await expect(f.coordinator.access()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
  });

  it('refuses SIWC image generation before access or scoped credential mutation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-oauth-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const scopedAuthFile = path.join(dir, 'auth.json');
    fs.writeFileSync(scopedAuthFile, '{}', { mode: 0o600 });
    const inode = fs.statSync(scopedAuthFile).ino;
    const fetchImpl = vi.fn(async () => Response.json({ protocol: 1, oauth: true }));
    const hooks = await plugin({}, { environment: { DEVRYAN_BOT_GATEWAY_URL: 'http://egress:43121', DEVRYAN_BOT_RUNTIME_TOKEN: 'a'.repeat(43) }, scopedAuthFile, fetchImpl });
    for (const tool of ['gpt_imagegen', 'devryan_image'])
      await expect(hooks['tool.execute.before']({ tool })).rejects.toMatchObject({ code: 'chatgpt_siwc_tool_unsupported' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // Readiness only.
    expect(fs.statSync(scopedAuthFile).ino).toBe(inode);
    expect(fs.readFileSync(scopedAuthFile, 'utf8')).toBe('{}');
  });

  it('persists rejected generation across a service restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-oauth-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stateFile = path.join(dir, 'state.json');
    const f = fixture({ stateFile });
    f.fetchImpl.mockImplementation(async () => new Response('', { status: 401 }));
    await expect(f.coordinator.access()).rejects.toBeDefined();
    const next = fixture({ stateFile });
    await expect(next.coordinator.access()).rejects.toBeDefined();
    expect(next.fetchImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(stateFile, 'utf8')).not.toContain('old-refresh');
  });

  it('merges only OpenAI and rejects stale compare-and-swap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-oauth-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const authFile = path.join(dir, 'auth.json');
    const other = { type: 'api', key: 'other-provider' };
    fs.writeFileSync(authFile, JSON.stringify({ openai: originalAuth(), anthropic: other }));
    const next = { ...originalAuth(), refresh: 'latest' };
    expect(compareAndSwapOpenAiAuth(originalAuth(), next, { authFile })).toBe(true);
    expect(compareAndSwapOpenAiAuth(originalAuth(), originalAuth(), { authFile })).toBe(false);
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8'))).toEqual({ openai: next, anthropic: other });
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
  });

  it('requires managed readiness; external runtime does not opt in', async () => {
    const c = createOpenAiOAuthCoordinator({ readAuth: originalAuth });
    await expect(c.access()).rejects.toMatchObject({ code: 'bot_oauth_coordinator_unavailable' });
    expect(await plugin({}, { environment: {} })).toEqual({});
  });

  it('keeps a failing transport when handshake fails, while a confirmed API-key connection stays unchanged', async () => {
    const environment = { DEVRYAN_OPENAI_OAUTH_URL: 'http://127.0.0.1:12345', DEVRYAN_OPENAI_OAUTH_TOKEN: 'a'.repeat(43) };
    const failed = await plugin({}, { environment, fetchImpl: async () => { throw new Error('offline'); } });
    const config = {};
    await failed.config(config);
    await expect(config.provider.openai.options.fetch('https://api.openai.com/v1/responses', {method:'POST', body:'{"input":[]}'})).rejects.toBeDefined();
    const api = await plugin({}, { environment, fetchImpl: async () => Response.json({ protocol: 1, oauth: false }) });
    const apiConfig = { provider: { openai: { options: { apiKey: 'fixture-key' } } } };
    await api.config(apiConfig);
    expect(apiConfig.provider.openai.options).toEqual({ apiKey: 'fixture-key' });
  });

  it('registers without waiting for a stalled handshake and bounds the wait inside hooks', async () => {
    const environment = { DEVRYAN_BOT_GATEWAY_URL: 'http://egress:43121', DEVRYAN_BOT_RUNTIME_TOKEN: 'a'.repeat(43) };
    let handshakeSettled = false;
    // The gateway never answers the handshake; every later call fails fast.
    const fetchImpl = (_url, init) => (JSON.parse(init.body).operation === 'ready'
      ? new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { handshakeSettled = true; reject(init.signal.reason); }, { once: true });
      })
      : Promise.reject(new Error('offline')));
    const hooks = await plugin({}, { environment, fetchImpl, readyTimeoutMs: 200 });
    expect(handshakeSettled).toBe(false); // registration returned while the gateway was still silent
    const config = {};
    await hooks.config(config);
    expect(handshakeSettled).toBe(true); // the hook waited only for the bounded handshake
    await expect(config.provider.openai.options.fetch('https://api.openai.com/v1/responses', {method:'POST', body:'{"input":[]}'})).rejects.toBeDefined();
  });

  it('does not dispatch or replay after cancellation while waiting for access', async () => {
    const providerFetch = vi.fn();
    const controller = new AbortController();
    const transport = plugin.testing.createTransport(async () => {
      controller.abort();
      return { accessToken: 'cancelled-access', accountId: 'account-a' };
    }, providerFetch);
    await expect(transport('https://api.openai.com/v1/responses', { method:'POST',body:'{"input":[]}', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('protects the private bridge and preserves login hooks and applies the SIWC physical policy to SSE', async () => {
    const f = fixture();
    const bridge = createOpenAiOAuthBridge({ coordinator: f.coordinator });
    cleanups.push(() => bridge.close());
    const environment = await bridge.environment();
    const denied = await fetch(environment.DEVRYAN_OPENAI_OAUTH_URL + '/access', { method: 'POST' });
    expect(denied.status).toBe(403);
    const hooks = await plugin({}, { environment });
    expect(hooks.auth).toBeUndefined(); // Built-in browser/device login stays registered.
    const config = { provider: { openai: { options: { timeout: 123 } } } };
    await hooks.config(config);
    expect(config.provider.openai.options.timeout).toBe(123);
    const access = plugin.testing.createAccessClient(environment);
    const providerFetch = vi.fn(async () => new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const transport = plugin.testing.createTransport(access, providerFetch);
    const signal = new AbortController().signal;
    const response = await transport('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"gpt-5.6-luna","input":[]}', signal, headers: { 'session-id': 'ses-fixture' } });
    expect(await response.text()).toBe('data: {"type":"response.completed"}\n\n');
    expect(providerFetch.mock.calls[0][0].href).toBe('https://api.openai.com/v1/responses');
    const request = providerFetch.mock.calls[0][1];
    expect(request.headers.get('authorization')).toBe('Bearer new-access');
    expect(request.headers.get('chatgpt-account-id')).toBeNull();
    expect(request.headers.get('session-id')).toBe('ses-fixture');
    expect(JSON.parse(request.body)).toEqual({model:'gpt-5.6-luna',input:[],store:false,stream:true});
    expect(request.signal).toBe(signal);
    expect(request.redirect).toBe('error');
    await expect(transport('https://attacker.example/')).rejects.toBeDefined();
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});
