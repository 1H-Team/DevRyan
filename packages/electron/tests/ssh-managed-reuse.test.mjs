import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ElectronSshManager } from '../ssh-manager.mjs';
import { managedSshOperationScript } from '../ssh-managed-probe.mjs';
import { sshManagedIdentity, authorizeSshManagedShutdown } from '../../web/server/lib/opencode/ssh-managed-identity.js';

test('reuses an owned matching server before any installation or credential access', async () => {
  const manager = Object.create(ElectronSshManager.prototype);
  manager.appVersion = '1.0.0'; manager.setStatus = () => {};
  manager.managedRemoteOperation = async () => ({ state: 'ready' });
  manager.configuredOpenChamberPassword = () => { throw new Error('Credentials were accessed'); };
  manager.currentRemoteOpenChamberVersion = () => { throw new Error('Installation was probed'); };
  assert.deepEqual(await manager.ensureRemoteServer({ id: 'fixture', remoteOpenchamber: { mode: 'managed', preferredPort: 12345 } }, {}, ''), {
    remotePort: 12345, startedByUs: false,
  });
  for (const state of ['unverified']) {
    manager.managedRemoteOperation = async () => ({ state });
    await assert.rejects(manager.ensureRemoteServer({ id: 'fixture', remoteOpenchamber: { mode: 'managed', preferredPort: 12345 } }, {}, ''));
  }
});

test('the remote probe verifies a real challenge without transmitting the ownership key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devryan-ssh-probe-'));
  const id = 'fixture', key = '12'.repeat(32), version = '1.0.0';
  const keyDirectory = join(directory, '.config', 'openchamber', 'ssh-managed');
  await mkdir(keyDirectory, { recursive: true });
  await writeFile(join(keyDirectory, createHash('sha256').update(id).digest('hex') + '.key'), key, { mode: 0o600 });
  let forged = false;
  const server = createServer(async (req, res) => {
    assert.ok(!req.url.includes(key));
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk; req.body = JSON.parse(raw);
      const allowed = authorizeSshManagedShutdown(req, { env: { DEVRYAN_SSH_OWNER_TOKEN: key, DEVRYAN_SSH_INSTANCE_ID: id }, runtimeInstanceId: 'boot' });
      res.statusCode = allowed ? 200 : 403; res.end('{}'); return;
    }
    req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const identity = sshManagedIdentity(req, { env: { DEVRYAN_SSH_OWNER_TOKEN: key, DEVRYAN_SSH_INSTANCE_ID: id }, version, runtimeInstanceId: 'boot' });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sshManaged: forged ? { ...identity, proof: 'ff'.repeat(32) } : identity }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const probe = async (expectedVersion = version, action = 'probe') => {
    const output = await promisify(execFile)('node', ['-e', managedSshOperationScript({ action, id, port, version: expectedVersion })], {
      env: { ...process.env, HOME: directory }, timeout: 10_000,
    });
    assert.ok(!output.stdout.includes(key)); return JSON.parse(output.stdout);
  };
  try {
    assert.equal((await probe()).state, 'ready');
    assert.equal((await probe('2.0.0')).state, 'version_mismatch');
    forged = true; assert.equal((await probe()).state, 'unverified');
    forged = false; assert.equal((await probe('2.0.0', 'stop')).state, 'stopped');
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('shutdown requires the owned listener, a fresh signature and a never-used nonce', async () => {
  const { createHmac, randomBytes } = await import('node:crypto');
  const { authorizeSshManagedShutdown } = await import('../../web/server/lib/opencode/ssh-managed-identity.js');
  const key = '34'.repeat(32), id = 'fixture', runtimeInstanceId = 'boot', port = 42991, now = Date.now();
  const env = { DEVRYAN_SSH_OWNER_TOKEN: key, DEVRYAN_SSH_INSTANCE_ID: id };
  const request = () => {
    const claim = { action: 'shutdown', id, runtimeInstanceId, port, at: now, nonce: randomBytes(32).toString('hex') };
    return { body: { ...claim, proof: createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(claim)).digest('hex') },
      socket: { remoteAddress: '127.0.0.1', server: { address: () => ({ address: '127.0.0.1', port }) } } };
  };
  const authorize = (req, options = {}) => authorizeSshManagedShutdown(req, { env, runtimeInstanceId, now, ...options });
  const valid = request(); assert.equal(authorize(valid), true); assert.equal(authorize(valid), false);
  assert.equal(authorize(request(), { runtimeInstanceId: 'another-boot' }), false);
  assert.equal(authorize(request(), { now: now + 31_000 }), false);
  const remote = request(); remote.socket.remoteAddress = '192.0.2.1'; assert.equal(authorize(remote), false);
  const portMismatch = request(); portMismatch.body.port++; assert.equal(authorize(portMismatch), false);
  const forged = request(); forged.body.proof = 'ff'.repeat(32); assert.equal(authorize(forged), false);
});

test('owned older version shuts down and proves absence before installation or restart', async () => {
  const manager = Object.create(ElectronSshManager.prototype), order = [];
  manager.appVersion = '2.0.0'; manager.setStatus = () => {};
  let probes = 0;
  manager.managedRemoteOperation = async (_parsed, _path, input) => {
    order.push(input.action);
    if (input.action === 'stop') return { state: 'stopped' };
    return { state: ['version_mismatch', 'absent', 'ready'][probes++] };
  };
  manager.currentRemoteOpenChamberVersion = async () => { order.push('version'); return '1.0.0'; };
  manager.installOpenChamberManaged = async () => { order.push('install'); };
  manager.startRemoteServerManaged = async () => { order.push('start'); };
  assert.deepEqual(await manager.ensureRemoteServer({ id: 'fixture', remoteOpenchamber: { mode: 'managed', preferredPort: 12345 } }, {}, ''), { remotePort: 12345, startedByUs: true });
  assert.deepEqual(order, ['probe', 'stop', 'probe', 'version', 'install', 'start', 'probe']);
  probes = 0; order.length = 0;
  manager.managedRemoteOperation = async (_parsed, _path, input) => ({ state: input.action === 'stop' ? 'unverified' : 'version_mismatch' });
  await assert.rejects(manager.ensureRemoteServer({ id: 'fixture', remoteOpenchamber: { mode: 'managed', preferredPort: 12345 } }, {}, ''));
  assert.deepEqual(order, []);
});
