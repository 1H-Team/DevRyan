import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createSupabaseConnection, isDirectLocalRequest } from './supabase-connection.js';
import { readSupabaseConnectionPreference, writeSupabaseConnectionPreference } from './connection-preference.js';
import { createSupabaseServerClient } from './supabase-client.js';
import { createPrincipalCache } from './principal-cache.js';
import { createDisconnectedAuth } from './disconnected-auth.js';
import { attachSupabaseConnectionBoundary, registerSupabaseConnectionRoutes } from './connection-routes.js';
import { supabaseTrafficOperation } from './supabase-traffic.js';
import { createMultiUserRuntime } from './runtime.js';
import { PRODUCTION_BOTS_MIGRATION } from './auth-compat.js';

const roots = []; const connections = []; const servers = [];
afterEach(async () => {
  for (const item of connections.splice(0)) await item.dispose();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});
const fixture = async (enabled = true, fetchImpl = vi.fn()) => {
  const base = path.resolve('../../.cache/supabase-test');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'fixture-')); roots.push(root);
  const config = { configured: true, enabled, dataDirectory: root, url: 'https://supabase.invalid', publishableKey: 'fixture-public', secretKey: 'fixture-secret' };
  const connection = await createSupabaseConnection({ config, fetchImpl }); connections.push(connection);
  return { connection, config, root, fetchImpl };
};
const principal = { id: 'owner', role: 'admin', scope: 'managed', assignments: [{ projectId: 'p', repositoryPath: '/fixture/project' }], policy: {} };
const enroll = async (connection) => {
  const res = { getHeader: () => undefined, setHeader: vi.fn() };
  await connection.rememberOwner(principal, res);
  return res.setHeader.mock.calls.at(-1)[1][0].split(';')[0];
};
const request = (cookie = '') => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', cookie } });

describe('persistent Supabase connection', () => {
  it('initializes the entire disconnected runtime without cloud clients, timers or schema probes', async () => {
    const { connection, root, config, fetchImpl } = await fixture(false);
    const cookie = await enroll(connection);
    await fs.writeFile(path.join(root, 'supabase.json'), JSON.stringify(config), { mode: 0o600 });
    await writeSupabaseConnectionPreference(root, false);
    const runtime = await createMultiUserRuntime({ dataDirectory: root, fetchImpl });
    connections.push(runtime.connection);
    const auth = runtime.wrapLegacyAuthController({ enabled: false });
    try {
      expect(runtime.enabled).toBe(false);
      expect(await auth.resolvePrincipal(request(cookie))).toMatchObject({ id: 'owner', scope: 'local-admin' });
      await runtime.botsRuntime.start();
      expect(await runtime.resolveScheduledTaskAccess({ ownerUserId: 'owner' })).toMatchObject({ state: 'dormant' });
      expect(await runtime.resolveScheduledTaskAccess({})).toMatchObject({ state: 'runnable' });
      await runtime.recordOpenCodeActivity({ type: 'session.created', properties: { info: { id: 'ses_local_fixture', directory: '/fixture/project' } } });
      expect(runtime.connection.localSessionOwner('ses_local_fixture')).toEqual({ userId: 'owner', directory: '/fixture/project' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { await runtime.botsRuntime.shutdown(); await auth.dispose(); }
  });

  it('persists Off before restart, waits for blockers and does not retry a failed restart automatically', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { connection, root } = await fixture();
    const getBlockers = vi.fn().mockResolvedValue(['active_chats']);
    const restart = vi.fn().mockRejectedValue(new Error('fixture restart failure'));
    const pauseAdmissions = vi.fn(); const resumeAdmissions = vi.fn();
    connection.configureDriver({ getBlockers, restart, prepare: vi.fn(), pauseAdmissions, resumeAdmissions });
    await enroll(connection);
    await connection.change(false);
    expect(readSupabaseConnectionPreference(root).enabled).toBe(false);
    expect(connection.status()).toMatchObject({ effectiveEnabled: true, desiredEnabled: false, state: 'disconnecting' });
    await connection.applyWhenIdle(); expect(restart).not.toHaveBeenCalled();
    getBlockers.mockResolvedValue([]);
    await connection.applyWhenIdle();
    expect(connection.status().errorCode).toBe('supabase_restart_failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restart).toHaveBeenCalledTimes(1);
    await connection.change(true); expect(resumeAdmissions).toHaveBeenCalledOnce();
  });

  it('requires owner proof and rejects forwarded or foreign-origin requests', async () => {
    const { connection } = await fixture(false);
    const cookie = await enroll(connection);
    expect(connection.authenticateLocalOwner(request())).toBeNull();
    expect(connection.authenticateLocalOwner(request(cookie))).toMatchObject({ id: 'owner', scope: 'local-admin' });
    await connection.issueLocalOwnerSession();
    expect(connection.authenticateLocalOwner(request(cookie))).toMatchObject({ id: 'owner' });
    for (const headers of [{ 'x-forwarded-for': '127.0.0.1' }, { origin: 'https://attacker.invalid' }, { host: 'tunnel.invalid' }]) {
      const req = request(cookie); Object.assign(req.headers, headers);
      expect(isDirectLocalRequest(req)).toBe(false);
      expect(connection.authenticateLocalOwner(req)).toBeNull();
    }
    const auth = createDisconnectedAuth(connection);
    expect(await auth.resolvePrincipal(request(cookie))).toMatchObject({ id: 'owner' });
    await connection.logoutLocalOwner({ getHeader: () => undefined, setHeader: vi.fn() });
    expect(await auth.resolvePrincipal(request(cookie))).toBeNull();
  });

  it('makes zero calls on disconnected restart and failed REST, RPC, Auth and Storage access', async () => {
    const { connection, config, fetchImpl, root } = await fixture(false);
    const cookie = await enroll(connection);
    await writeSupabaseConnectionPreference(root, false);
    const restarted = await createSupabaseConnection({ config, fetchImpl }); connections.push(restarted);
    expect(restarted.authenticateLocalOwner(request(cookie))).toMatchObject({ id: 'owner' });
    const client = createSupabaseServerClient({ ...config, fetchImpl, isConnectionEnabled: () => restarted.enabled });
    const operations = [() => client.rest('user_profiles'), () => client.rpc('fixture'),
      () => client.refreshSession('fixture'), () => client.storageDownload('fixture', 'object'),
      () => client.storageUpload('fixture', 'object', Buffer.from('fixture')), () => client.storageDelete('fixture', ['object'])];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: 'supabase_disconnected' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.traffic.snapshot()).toMatchObject({ requests: 0, blockedRequests: operations.length });
  });

  it('keeps failed reconnect closed and requires explicit retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 402 }));
    const { connection, root } = await fixture(false, fetchImpl);
    await enroll(connection);
    await connection.change(true);
    expect(connection.status()).toMatchObject({ effectiveEnabled: false, desiredEnabled: false, state: 'connection_failed', errorCode: 'supabase_quota_exceeded' });
    expect(readSupabaseConnectionPreference(root).enabled).toBe(false);
    fetchImpl.mockImplementation(async (url) => new Response(JSON.stringify(url.includes('/rpc/') ? PRODUCTION_BOTS_MIGRATION : [{ id: 'owner', role: 'admin', status: 'active' }])));
    await connection.change(true);
    expect(connection.status()).toMatchObject({ effectiveEnabled: false, desiredEnabled: true, state: 'connecting' });
  });

  it('blocks remote HTTP and cloud routes before private routes and requires CSRF', async () => {
    const { connection, fetchImpl } = await fixture(false);
    const cookie = await enroll(connection);
    const app = express(); const server = http.createServer(app); servers.push(server);
    // No app-level JSON parser: production routes /api/system past the shared allowlist, so the route must parse itself.
    attachSupabaseConnectionBoundary(app, server, connection);
    registerSupabaseConnectionRoutes(app, { runtime: { connection } });
    app.get('/private', (_req, res) => res.send('private'));
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}`;
    expect((await fetch(`${url}/private`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status).toBe(503);
    expect((await fetch(`${url}/api/bots`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${url}/api/system/supabase-connection`)).status).toBe(403);
    const status = await fetch(`${url}/api/system/supabase-connection`, { headers: { cookie } });
    expect(status.status).toBe(200); expect((await status.json()).effectiveEnabled).toBe(false);
    expect((await fetch(`${url}/api/system/supabase-connection`, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).status).toBe(403);
    // A well-formed body must reach authorization (403), never fail body validation (400).
    const unauthenticated = await fetch(`${url}/api/system/supabase-connection`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-devryan-csrf': '1' }, body: '{"enabled":true}' });
    expect(unauthenticated.status).toBe(403);
    expect((await unauthenticated.json()).error).toBe('Local administrator authentication required');
    fetchImpl.mockImplementation(async (url) => new Response(JSON.stringify(url.includes('/rpc/') ? PRODUCTION_BOTS_MIGRATION : [{ id: 'owner', role: 'admin', status: 'active' }])));
    const accepted = await fetch(`${url}/api/system/supabase-connection`, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json', 'x-devryan-csrf': '1' }, body: '{"enabled":true}' });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ desiredEnabled: true, effectiveEnabled: false, state: 'connecting' });
  });
});

describe('principal request coalescing', () => {
  it('coalesces concurrent refreshes and preserves the freshness window', async () => {
    let now = 0; const cache = createPrincipalCache({ ttlMs: 5_000, now: () => now });
    const load = vi.fn(async () => principal);
    await Promise.all(Array.from({ length: 30 }, () => cache.resolve('session', 'remote', load)));
    expect(load).toHaveBeenCalledTimes(1);
    now = 5_001; await cache.resolve('session', 'remote', load); expect(load).toHaveBeenCalledTimes(2);
  });
  it('fences refreshes after revocation and never shares offline grace remotely', async () => {
    const cache = createPrincipalCache({ ttlMs: 5_000 });
    let resolve; const pending = cache.resolve('session', 'local', () => new Promise((done) => { resolve = done; }));
    await Promise.resolve(); cache.delete('session'); resolve(principal);
    await expect(pending).rejects.toMatchObject({ code: 'identity_changed' });
    await cache.resolve('session', 'local', async () => ({ ...principal, offlineGrace: true }));
    const remote = vi.fn(async () => null);
    expect(await cache.resolve('session', 'remote', remote)).toBeNull(); expect(remote).toHaveBeenCalledOnce();
  });
  it('sanitizes telemetry operation names', () => {
    expect(supabaseTrafficOperation('/rest/v1/user_profiles?id=eq.secret', 'GET')).toBe('GET rest/user_profiles');
    expect(supabaseTrafficOperation('/auth/v1/admin/users/private-id', 'GET')).toBe('GET auth/admin/users');
    expect(supabaseTrafficOperation('/storage/v1/object/bucket/private-id', 'GET')).toBe('GET storage/object');
  });
});
