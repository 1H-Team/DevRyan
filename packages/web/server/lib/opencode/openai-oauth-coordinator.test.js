import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareAndSwapOpenAiAuth, createOpenAiOAuthCoordinator } from './openai-oauth-coordinator.js';
import { createOpenAiOAuthBridge } from './openai-oauth-bridge.js';
import plugin from '../../default-config/plugins/devryan-openai-oauth.mjs';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const clock = Date.now();
const originalAuth = () => ({ type: 'oauth', accountId: 'account-a', access: 'old-access', refresh: 'old-refresh', expires: clock - 1 });
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

describe('managed OpenAI OAuth owner', () => {
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

  it('updates access-only image credentials in place and rechecks each invocation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-oauth-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const scopedAuthFile = path.join(dir, 'auth.json');
    fs.writeFileSync(scopedAuthFile, '{}', { mode: 0o600 });
    const inode = fs.statSync(scopedAuthFile).ino;
    let accessToken = 'image-access-1';
    const hooks = await plugin({}, { environment: { DEVRYAN_BOT_GATEWAY_URL: 'http://egress:43121', DEVRYAN_BOT_RUNTIME_TOKEN: 'a'.repeat(43) },
      scopedAuthFile, fetchImpl: async (_url, init) => JSON.parse(init.body).operation === 'ready'
        ? Response.json({ protocol: 1, oauth: true })
        : Response.json({ accessToken, expiresAt: Date.now() + 3600000, accountId: 'account-a', generation: 'safe-generation' }) });
    await hooks['tool.execute.before']({ tool: 'devryan_image' });
    accessToken = 'image-access-2';
    await hooks['tool.execute.before']({ tool: 'devryan_image' });
    expect(fs.statSync(scopedAuthFile).ino).toBe(inode);
    expect(JSON.parse(fs.readFileSync(scopedAuthFile, 'utf8')).openai).toMatchObject({ access: accessToken, refresh: '' });
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
    await expect(config.provider.openai.options.fetch('https://api.openai.com/v1/responses')).rejects.toBeDefined();
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
    await expect(config.provider.openai.options.fetch('https://api.openai.com/v1/responses')).rejects.toBeDefined();
  });

  it('does not dispatch or replay after cancellation while waiting for access', async () => {
    const providerFetch = vi.fn();
    const controller = new AbortController();
    const transport = plugin.testing.createTransport(async () => {
      controller.abort();
      return { accessToken: 'cancelled-access', accountId: 'account-a' };
    }, providerFetch);
    await expect(transport('https://api.openai.com/v1/responses', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('protects the private bridge and preserves login hooks, request body and SSE', async () => {
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
    const providerFetch = vi.fn(async () => new Response('data: fixture\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const transport = plugin.testing.createTransport(access, providerFetch);
    const signal = new AbortController().signal;
    const response = await transport('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"gpt-5.6-luna"}', signal, headers: { 'session-id': 'ses-fixture' } });
    expect(await response.text()).toBe('data: fixture\n\n');
    expect(providerFetch.mock.calls[0][0].href).toBe('https://chatgpt.com/backend-api/codex/responses');
    const request = providerFetch.mock.calls[0][1];
    expect(request.headers.get('authorization')).toBe('Bearer new-access');
    expect(request.headers.get('session-id')).toBe('ses-fixture');
    expect(request.body).toBe('{"model":"gpt-5.6-luna"}');
    expect(request.signal).toBe(signal);
    expect(request.redirect).toBe('error');
    await expect(transport('https://attacker.example/')).rejects.toBeDefined();
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});
