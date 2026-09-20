import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { createSupabaseConnection } from './supabase-connection.js';
import { createSessionVault } from './vault.js';
import { prepareLocalOwnerEnrollment, registerLocalOwnerBootstrap } from './local-owner-bootstrap.js';
import { createOwnerAuthenticatedTunnelFetch } from '../../../bin/tunnel-owner-auth.js';

const roots = []; const connections = [];
afterEach(async () => { for (const connection of connections.splice(0)) await connection.dispose(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const base = path.resolve('../../.cache/owner-bootstrap-tests'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'fixture-')); roots.push(root);
  const connection = await createSupabaseConnection({ config: { dataDirectory: root, configured: false, enabled: false } }); connections.push(connection);
  const app = express(); app.set('trust proxy', true);
  registerLocalOwnerBootstrap(app, { dataDirectory: root, connection });
  return { root, connection, app };
};

it('does not enroll through a localhost visit; filesystem proof is one-use and loopback-only', async () => {
  const { root, connection, app } = await fixture();
  expect((await request(app).get('/auth/local-owner-bootstrap')).status).toBe(200);
  expect(connection.ownerPrincipal()).toBeNull();
  const { url } = await prepareLocalOwnerEnrollment({ dataDirectory: root, origin: 'http://localhost:3000' });
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('t');
  const post = (headers = {}) => request(app).post('/auth/local-owner-bootstrap').set({ Host: 'localhost:3000', Origin: 'http://localhost:3000', 'X-DevRyan-CSRF': '1', ...headers }).send({ token });
  expect((await post({ 'X-Forwarded-Host': 'localhost' })).status).toBe(403);
  expect((await post({ Origin: 'https://attacker.test' })).status).toBe(403);
  const result = await post(); expect(result.status).toBe(204);
  const principal = connection.authenticateLocalOwner({ headers: { host: 'localhost:3000', cookie: result.headers['set-cookie'][0].split(';')[0] }, socket: { remoteAddress: '127.0.0.1' } });
  expect(principal).toMatchObject({ scope: 'local-admin', localOwner: true });
  expect((await post()).status).toBe(403);
  const oldId = principal.id;
  await connection.bootstrapLocalOwner(); expect(connection.ownerPrincipal().id).toBe(oldId);
  expect((await fs.readFile(path.join(root, 'multi-user-vault.json'), 'utf8'))).not.toContain(token);
});

it('rejects expired proofs and fails closed if either half of durable authorization is lost', async () => {
  const { root, app } = await fixture();
  const { url } = await prepareLocalOwnerEnrollment({ dataDirectory: root, origin: 'http://localhost:3000', now: () => Date.now() - 121_000 });
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('t');
  expect((await request(app).post('/auth/local-owner-bootstrap').set({ Host: 'localhost:3000', Origin: 'http://localhost:3000', 'X-DevRyan-CSRF': '1' }).send({ token })).status).toBe(403);
  const vaultPath = path.join(root, 'multi-user-vault.json'); const saved = await fs.readFile(vaultPath);
  await fs.rm(vaultPath); await expect(createSessionVault({ dataDirectory: root })).rejects.toThrow('incomplete');
  await fs.writeFile(vaultPath, saved); await fs.rm(path.join(root, 'multi-user-vault.key'));
  await expect(createSessionVault({ dataDirectory: root })).rejects.toThrow('incomplete');
});

it('keeps CLI tunnel operations usable with filesystem proof without enrolling an owner implicitly', async () => {
  const { root, connection, app } = await fixture();
  app.post('/api/openchamber/tunnel/start', (req, res) => {
    if (!connection.authenticateLocalOwner(req)) return res.status(403).json({ code: 'local_owner_required' });
    if (req.headers['x-devryan-csrf'] !== '1') return res.sendStatus(403);
    return res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const fetchTunnel = createOwnerAuthenticatedTunnelFetch({ getDataDirectory: () => root });
    const url = `http://127.0.0.1:${server.address().port}/api/openchamber/tunnel/start`;
    await expect(fetchTunnel(url, { method: 'POST' })).rejects.toMatchObject({ code: 'local_owner_required' });
    expect(connection.ownerPrincipal()).toBeNull();
    await connection.bootstrapLocalOwner();
    expect((await fetchTunnel(url, { method: 'POST' })).status).toBe(200);
    expect((await fetchTunnel(url, { method: 'POST' })).status).toBe(200);
    expect(await fs.readdir(root)).not.toContain('local-owner-bootstrap.json');
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
