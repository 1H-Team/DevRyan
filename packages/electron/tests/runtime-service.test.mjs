import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  RUNTIME_SERVICE_PROTOCOL_VERSION,
  createRuntimeServiceCoordinator,
  assertRuntimeServiceDescriptorOwner,
  readRuntimeProcessStartIdentity,
  isRuntimeServiceProtocolSupported,
  readRuntimeServiceDescriptor,
  readRuntimeServiceOwner,
  waitForRuntimeServiceOwnerStopped,
  runtimeServiceDescriptorPath,
  runtimeServiceOwnerPath,
  unsealRuntimeServiceBootstrapToken,
  validateRuntimeServiceDescriptor,
} from '../runtime-service.mjs';
import { createRuntimeOwnerAcquirer, recoverAppBoundRuntime } from '../runtime-service-startup.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-runtime-service-'));
  directories.push(directory);
  return directory;
};

const safeStorageFixture = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (value) => {
    const text = Buffer.from(value).toString('utf8');
    if (!text.startsWith('sealed:')) throw new Error('invalid seal');
    return text.slice('sealed:'.length);
  },
});

describe('launchd runtime-service ownership and handshake', () => {
  test('persists a private versioned descriptor and rotates a one-time OS-sealed bootstrap', async () => {
    const dataDirectory = await temporaryDirectory();
    let currentTime = new Date('2026-08-27T10:00:00.000Z');
    const safeStorage = safeStorageFixture();
    const coordinator = await createRuntimeServiceCoordinator({
      dataDirectory,
      safeStorage,
      pid: 41,
      isProcessAlive: () => false,
      now: () => currentTime,
    });

    const owner = await coordinator.acquire({ mode: 'service' });
    await coordinator.start({ port: 57123, health: 'starting' });
    const first = await readRuntimeServiceDescriptor({ dataDirectory });
    const bootstrap = unsealRuntimeServiceBootstrapToken({ descriptor: first, safeStorage });
    assert.equal(first.protocolVersion, RUNTIME_SERVICE_PROTOCOL_VERSION);
    assert.equal(first.ownerGeneration, owner.generation);
    assert.equal(first.desktopHost.state, 'unavailable');

    const session = await coordinator.consumeBootstrap(bootstrap);
    assert.equal(coordinator.authorizeSession(session.token), true);
    await assert.rejects(
      coordinator.consumeBootstrap(bootstrap),
      (error) => error.code === 'runtime_service_bootstrap_rejected',
    );
    const second = await readRuntimeServiceDescriptor({ dataDirectory });
    assert.notEqual(second.sealedBootstrapToken, first.sealedBootstrapToken);
    assert.notEqual(
      unsealRuntimeServiceBootstrapToken({ descriptor: second, safeStorage }),
      bootstrap,
    );

    const descriptorMode = (await fs.stat(runtimeServiceDescriptorPath(dataDirectory))).mode & 0o777;
    const ownerMode = (await fs.stat(runtimeServiceOwnerPath(dataDirectory))).mode & 0o777;
    assert.equal(descriptorMode, 0o600);
    assert.equal(ownerMode, 0o600);

    currentTime = new Date('2026-08-27T22:00:01.000Z');
    assert.equal(coordinator.authorizeSession(session.token), false);
    await coordinator.release();
  });

  test('fences a live owner and increments generation only after a stale owner is reclaimed', async () => {
    const dataDirectory = await temporaryDirectory();
    const safeStorage = safeStorageFixture();
    const first = await createRuntimeServiceCoordinator({
      dataDirectory,
      safeStorage,
      pid: 51,
      isProcessAlive: (pid) => pid === 51,
      getProcessStartIdentity: async () => 'linux:100',
    });
    const firstOwner = await first.acquire({ mode: 'app_bound' });

    const competing = await createRuntimeServiceCoordinator({
      dataDirectory,
      safeStorage,
      pid: 52,
      isProcessAlive: (pid) => pid === 51,
      getProcessStartIdentity: async () => 'linux:100',
    });
    await assert.rejects(
      competing.acquire({ mode: 'service' }),
      (error) => error.code === 'runtime_service_owner_exists',
    );

    const replacement = await createRuntimeServiceCoordinator({
      dataDirectory,
      safeStorage,
      pid: 53,
      isProcessAlive: () => false,
    });
    const replacementOwner = await replacement.acquire({ mode: 'service' });
    assert.equal(replacementOwner.generation, firstOwner.generation + 1);
    await replacement.release();
  });

  test('reports a bounded public lease and rejects stale or malformed protocol state', async () => {
    const dataDirectory = await temporaryDirectory();
    let currentTime = new Date('2026-08-27T10:00:00.000Z');
    const coordinator = await createRuntimeServiceCoordinator({
      dataDirectory,
      safeStorage: safeStorageFixture(),
      pid: 61,
      isProcessAlive: () => false,
      now: () => currentTime,
    });
    await coordinator.acquire();
    await coordinator.start({ port: 44001, health: 'healthy' });
    await coordinator.update({
      desktopHost: {
        state: 'connected',
        leaseId: '123e4567-e89b-42d3-a456-426614174000',
        expiresAt: '2026-08-27T10:00:30.000Z',
        capabilities: ['browser_cdp', 'browser_observation', 'focus'],
      },
    });
    assert.equal(coordinator.publicStatus().desktopHost.state, 'connected');
    assert.equal(Object.hasOwn(coordinator.publicStatus(), 'sealedBootstrapToken'), false);

    currentTime = new Date('2026-08-27T10:00:31.000Z');
    assert.equal(coordinator.publicStatus().desktopHost.state, 'unavailable');
    assert.equal(isRuntimeServiceProtocolSupported(RUNTIME_SERVICE_PROTOCOL_VERSION - 1), true);
    assert.equal(isRuntimeServiceProtocolSupported(RUNTIME_SERVICE_PROTOCOL_VERSION + 1), false);
    assert.throws(
      () => validateRuntimeServiceDescriptor({}),
      (error) => error.code === 'runtime_service_descriptor_invalid',
    );
    await coordinator.release();
  });
});

const writeOwnerFixture = async (dataDirectory, raw) => {
  const file = runtimeServiceOwnerPath(dataDirectory);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, raw);
  return file;
};
const coordinatorFor = (dataDirectory, options = {}) => createRuntimeServiceCoordinator({
  dataDirectory, safeStorage: safeStorageFixture(), wait: async () => {}, ...options,
});

describe('startup owner-state regression coverage', () => {
  for (const raw of ['', '{"version":', '{}', 'null']) {
    test(`malformed owner ${JSON.stringify(raw)} blocks acquire and shutdown without a SyntaxError`, async () => {
      const dataDirectory = await temporaryDirectory();
      await writeOwnerFixture(dataDirectory, raw);
      const coordinator = await coordinatorFor(dataDirectory);
      assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'malformed');
      for (let retry = 0; retry < 2; retry += 1) {
        await assert.rejects(coordinator.acquire(), { code: 'runtime_service_owner_invalid' });
        assert.equal(coordinator.getOwner(), null);
      }
      await assert.rejects(waitForRuntimeServiceOwnerStopped({ dataDirectory, timeoutMs: 0 }), {
        code: 'runtime_service_owner_invalid',
      });
      assert.equal(await fs.readFile(runtimeServiceOwnerPath(dataDirectory), 'utf8'), raw);
    });
  }

  test('permission and I/O failures never prove owner release', async () => {
    const dataDirectory = await temporaryDirectory();
    for (const code of ['EACCES', 'EIO']) {
      const fsPromises = { ...fs, lstat: async () => { throw Object.assign(new Error('fixture'), { code }); } };
      assert.equal((await readRuntimeServiceOwner({ dataDirectory, fsPromises })).state, 'unreadable');
      await assert.rejects(waitForRuntimeServiceOwnerStopped({ dataDirectory, fsPromises }), {
        code: 'runtime_service_owner_unreadable',
      });
      await assert.rejects((await coordinatorFor(dataDirectory, { fsPromises })).acquire(), {
        code: 'runtime_service_owner_unreadable',
      });
    }
  });

  test('a late legacy write is retried and its live owner is protected', async () => {
    const dataDirectory = await temporaryDirectory();
    const file = await writeOwnerFixture(dataDirectory, '');
    let waits = 0;
    const coordinator = await coordinatorFor(dataDirectory, {
      platform: 'linux',
      getBootSessionId: async () => '123e4567-e89b-42d3-a456-426614174000',
      wait: async () => {
        waits += 1;
        await fs.writeFile(file, JSON.stringify({
          version: 1, instanceId: '123e4567-e89b-42d3-a456-426614174000',
          pid: process.pid, generation: 7, mode: 'service', createdAt: new Date().toISOString(),
        }));
      },
    });
    await assert.rejects(coordinator.acquire(), { code: 'runtime_service_owner_unverified' });
    assert.equal(waits, 1);
    assert.equal((await readRuntimeServiceOwner({ dataDirectory })).owner.generation, 7);
  });

  test('owner remains absent until a complete record is published', async () => {
    const dataDirectory = await temporaryDirectory();
    let inspected = false;
    const fsPromises = { ...fs, link: async (source, target) => {
      assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'missing');
      assert.equal(JSON.parse(await fs.readFile(source, 'utf8')).pid, process.pid);
      inspected = true;
      await fs.link(source, target);
    } };
    const coordinator = await coordinatorFor(dataDirectory, { fsPromises });
    await coordinator.acquire();
    assert.equal(inspected, true);
    assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'valid');
    await coordinator.release();
  });

  test('failed writes leave no empty owner or temporary and a later retry succeeds', async () => {
    const dataDirectory = await temporaryDirectory();
    let failWrite = true;
    const fsPromises = { ...fs, open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      if (file.endsWith('.tmp') && failWrite) {
        handle.writeFile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
      }
      return handle;
    } };
    const coordinator = await coordinatorFor(dataDirectory, { fsPromises });
    await assert.rejects(coordinator.acquire(), { code: 'ENOSPC' });
    assert.equal(coordinator.getOwner(), null);
    assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'missing');
    assert.deepEqual(await fs.readdir(path.dirname(runtimeServiceOwnerPath(dataDirectory))), []);
    failWrite = false;
    await coordinator.acquire();
    await coordinator.release();
  });

  test('simultaneous claims elect exactly one owner', async () => {
    const dataDirectory = await temporaryDirectory();
    const coordinators = await Promise.all(Array.from({ length: 8 }, () => coordinatorFor(dataDirectory)));
    const results = await Promise.allSettled(coordinators.map((coordinator) => coordinator.acquire()));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of results.filter((item) => item.status === 'rejected')) {
      assert.equal(result.reason.code, 'runtime_service_owner_exists');
    }
    await Promise.all(coordinators.map((coordinator) => coordinator.release()));
  });

  test('stale reclamation is serialized and an old release preserves the replacement', async () => {
    const dataDirectory = await temporaryDirectory();
    const first = await coordinatorFor(dataDirectory, { pid: 12345 });
    const old = await first.acquire();
    const options = { isProcessAlive: (pid) => pid !== 12345 };
    const candidates = await Promise.all([coordinatorFor(dataDirectory, options), coordinatorFor(dataDirectory, options)]);
    const results = await Promise.allSettled(candidates.map((candidate) => candidate.acquire()));
    const winner = results.find((result) => result.status === 'fulfilled').value;
    assert.equal(winner.generation, old.generation + 1);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    await first.release();
    assert.equal((await readRuntimeServiceOwner({ dataDirectory })).owner.instanceId, winner.instanceId);
    await Promise.all(candidates.map((candidate) => candidate.release()));
  });

  test('exclusive publication cannot overwrite a competing legacy owner', async () => {
    const dataDirectory = await temporaryDirectory();
    const raw = JSON.stringify({ version: 1, instanceId: '123e4567-e89b-42d3-a456-426614174000',
      pid: process.pid, generation: 22, mode: 'service', createdAt: new Date().toISOString() });
    const coordinator = await coordinatorFor(dataDirectory, { fsPromises: { ...fs, link: async (source, target) => {
      await fs.writeFile(target, raw, { flag: 'wx' });
      return fs.link(source, target);
    } } });
    await assert.rejects(coordinator.acquire(), { code: 'runtime_service_owner_exists' });
    assert.equal(await fs.readFile(runtimeServiceOwnerPath(dataDirectory), 'utf8'), raw);
  });

  test('corruption observed in a previous boot is quarantined privately', async () => {
    const dataDirectory = await temporaryDirectory();
    await writeOwnerFixture(dataDirectory, '{');
    let boot = '123e4567-e89b-42d3-a456-426614174000';
    const getBootSessionId = async () => boot;
    const events = [];
    await assert.rejects(waitForRuntimeServiceOwnerStopped({ dataDirectory, getBootSessionId, timeoutMs: 0 }), {
      code: 'runtime_service_owner_invalid',
    });
    const coordinator = await coordinatorFor(dataDirectory, { getBootSessionId, onDiagnostic: (event) => events.push(event) });
    await assert.rejects(coordinator.acquire(), { code: 'runtime_service_owner_invalid' });
    // A distinct OS boot session is explicit evidence that the observed writer died.
    boot = '123e4567-e89b-42d3-a456-426614174001';
    assert.equal(await waitForRuntimeServiceOwnerStopped({ dataDirectory, getBootSessionId, timeoutMs: 0 }), true);
    await coordinator.acquire();
    const quarantine = path.join(path.dirname(runtimeServiceOwnerPath(dataDirectory)), 'quarantine');
    const files = await fs.readdir(quarantine);
    assert.equal(files.length, 1);
    assert.equal(await fs.readFile(path.join(quarantine, files[0]), 'utf8'), '{');
    assert.equal((await fs.stat(path.join(quarantine, files[0]))).mode & 0o777, 0o600);
    assert.deepEqual(events.map((event) => event.code), [
      'runtime_service_owner_invalid', 'runtime_service_owner_quarantined',
    ]);
    await coordinator.release();
  });

  test('a changed corrupt file after reboot and an unavailable boot identity remain blocked', async () => {
    const dataDirectory = await temporaryDirectory();
    const file = await writeOwnerFixture(dataDirectory, '{');
    let boot = '123e4567-e89b-42d3-a456-426614174000';
    const coordinator = await coordinatorFor(dataDirectory, { getBootSessionId: async () => boot });
    await assert.rejects(coordinator.acquire(), { code: 'runtime_service_owner_invalid' });
    boot = '123e4567-e89b-42d3-a456-426614174001';
    await fs.writeFile(file, '{"version":');
    await assert.rejects(coordinator.acquire(), { code: 'runtime_service_owner_invalid' });
    boot = null;
    await assert.rejects(coordinator.acquire(), { code: 'runtime_service_owner_invalid' });
  });

  test('an old mtime alone and a symlink never authorize quarantine', async () => {
    const dataDirectory = await temporaryDirectory();
    const file = await writeOwnerFixture(dataDirectory, '{');
    await fs.utimes(file, new Date(0), new Date(0));
    await assert.rejects((await coordinatorFor(dataDirectory)).acquire(), { code: 'runtime_service_owner_invalid' });
    await fs.rename(file, `${file}.original`);
    await fs.symlink(`${file}.original`, file);
    await assert.rejects((await coordinatorFor(dataDirectory, { getBootSessionId: async () => '123e4567-e89b-42d3-a456-426614174001' })).acquire(), {
      code: 'runtime_service_owner_invalid',
    });
    assert.equal(await fs.readFile(`${file}.original`, 'utf8'), '{');
  });

  test('live owner times out, dead and absent owners resolve, and malformed release stays explicit', async () => {
    const dataDirectory = await temporaryDirectory();
    assert.equal(await waitForRuntimeServiceOwnerStopped({ dataDirectory }), true);
    const coordinator = await coordinatorFor(dataDirectory);
    await coordinator.acquire();
    assert.equal(await waitForRuntimeServiceOwnerStopped({ dataDirectory, timeoutMs: 0 }), false);
    assert.equal(await waitForRuntimeServiceOwnerStopped({ dataDirectory, isProcessAlive: () => false }), true);
    await fs.writeFile(runtimeServiceOwnerPath(dataDirectory), '');
    await assert.rejects(coordinator.release(), { code: 'runtime_service_owner_invalid' });
    assert.notEqual(coordinator.getOwner(), null);
  });
});

describe('reboot-stable owner recovery', () => {
  const firstBoot = '123e4567-e89b-42d3-a456-426614174000';
  const secondBoot = '123e4567-e89b-42d3-a456-426614174001';
  const proofPath = (directory, version = 2) => path.join(directory, 'runtime-service', `owner-recovery.v${version}.json`);
  const invalid = (recoveryReason) => ({ code: 'runtime_service_owner_invalid', recoveryReason });
  const observe = (dataDirectory, options = {}) => waitForRuntimeServiceOwnerStopped({
    dataDirectory, timeoutMs: 0, getBootSessionId: async () => firstBoot, ...options,
  });

  for (const version of [1, 2]) {
    test(`v${version} proof survives a mount-device change and preserves its original boot`, async () => {
      const dataDirectory = await temporaryDirectory();
      const file = await writeOwnerFixture(dataDirectory, '');
      let deviceOffset = 0;
      const fsPromises = { ...fs, lstat: async (target) => {
        const stat = await fs.lstat(target);
        if (target === file) stat.dev += deviceOffset;
        return stat;
      } };
      if (version === 1) {
        const result = await readRuntimeServiceOwner({ dataDirectory, fsPromises });
        await fs.writeFile(proofPath(dataDirectory, 1), JSON.stringify({
          version: 1, bootSessionId: firstBoot.toUpperCase(), fingerprint: result.fingerprint,
        }));
      } else {
        await assert.rejects(observe(dataDirectory, { fsPromises }), invalid('reboot_required'));
      }
      const originalProof = await fs.readFile(proofPath(dataDirectory, version), 'utf8');
      deviceOffset = 9;
      // Mount changes alone never authorize recovery within the same boot.
      await assert.rejects(observe(dataDirectory, { fsPromises }), invalid('reboot_required'));
      const migrated = await fs.readFile(proofPath(dataDirectory), 'utf8');
      assert.equal(JSON.parse(migrated).bootSessionId, firstBoot);
      for (let retry = 0; retry < 2; retry += 1) {
        assert.equal(await observe(dataDirectory, { fsPromises, getBootSessionId: async () => secondBoot }), true);
        assert.equal(await fs.readFile(proofPath(dataDirectory), 'utf8'), migrated);
      }
      assert.equal(await fs.readFile(proofPath(dataDirectory, version), 'utf8'), originalProof);
      const coordinator = await coordinatorFor(dataDirectory, { fsPromises, getBootSessionId: async () => secondBoot });
      await coordinator.acquire();
      const quarantine = path.join(dataDirectory, 'runtime-service/quarantine');
      const records = await fs.readdir(quarantine);
      assert.equal(records.length, 1);
      assert.equal(await fs.readFile(path.join(quarantine, records[0]), 'utf8'), '');
      assert.equal((await fs.stat(path.join(quarantine, records[0]))).mode & 0o777, 0o600);
      assert.equal((await fs.stat(proofPath(dataDirectory))).mode & 0o777, 0o600);
      await coordinator.release();
    });
  }

  test('matching legacy proof permits recovery on its first post-reboot read', async () => {
    const dataDirectory = await temporaryDirectory();
    await writeOwnerFixture(dataDirectory, '{');
    const owner = await readRuntimeServiceOwner({ dataDirectory });
    const legacy = JSON.stringify({ version: 1, bootSessionId: firstBoot, fingerprint: owner.fingerprint });
    await fs.writeFile(proofPath(dataDirectory, 1), legacy);
    const coordinator = await coordinatorFor(dataDirectory, { getBootSessionId: async () => secondBoot });
    await coordinator.acquire();
    assert.equal(await fs.readFile(proofPath(dataDirectory, 1), 'utf8'), legacy);
    assert.equal(JSON.parse(await fs.readFile(proofPath(dataDirectory), 'utf8')).bootSessionId, firstBoot);
    await coordinator.release();
  });

  for (const field of ['ino', 'birthtimeMs', 'size', 'ctimeMs', 'mtimeMs']) {
    test(`changed ${field} across boots remains blocked`, async () => {
      const dataDirectory = await temporaryDirectory();
      const file = await writeOwnerFixture(dataDirectory, '');
      await assert.rejects(observe(dataDirectory), invalid('reboot_required'));
      const fsPromises = { ...fs, lstat: async (target) => {
        const stat = await fs.lstat(target);
        if (target === file) stat[field] += 1;
        return stat;
      } };
      await assert.rejects(observe(dataDirectory, { fsPromises, getBootSessionId: async () => secondBoot }), invalid('file_changed'));
      assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'malformed');
      assert.equal(JSON.parse(await fs.readFile(proofPath(dataDirectory), 'utf8')).bootSessionId, secondBoot);
    });
  }

  test('changed bytes block recovery even when metadata is unchanged', async () => {
    const dataDirectory = await temporaryDirectory();
    const file = await writeOwnerFixture(dataDirectory, '{');
    await assert.rejects(observe(dataDirectory), invalid('reboot_required'));
    const fsPromises = { ...fs, readFile: async (target, ...args) => (
      target === file ? Buffer.from('}') : fs.readFile(target, ...args)
    ) };
    await assert.rejects(observe(dataDirectory, { fsPromises, getBootSessionId: async () => secondBoot }), invalid('file_changed'));
  });

  test('a changed v2 proof cannot fall back to a matching older v1 proof', async () => {
    const dataDirectory = await temporaryDirectory();
    await writeOwnerFixture(dataDirectory, '');
    const owner = await readRuntimeServiceOwner({ dataDirectory });
    await fs.writeFile(proofPath(dataDirectory, 1), JSON.stringify({
      version: 1, bootSessionId: firstBoot, fingerprint: owner.fingerprint,
    }));
    await fs.writeFile(proofPath(dataDirectory), JSON.stringify({
      version: 2, bootSessionId: firstBoot, identity: { ...owner.identity, ino: owner.identity.ino + 1 },
    }));
    await assert.rejects(observe(dataDirectory, { getBootSessionId: async () => secondBoot }), invalid('file_changed'));
  });

  for (const corrupt of ['missing-field', 'noncanonical-number', 'invalid-hash', 'extra-field']) {
    test(`invalid legacy fingerprint ${corrupt} cannot authorize recovery`, async () => {
      const dataDirectory = await temporaryDirectory();
      await writeOwnerFixture(dataDirectory, '');
      const owner = await readRuntimeServiceOwner({ dataDirectory });
      const parts = owner.fingerprint.split(':');
      if (corrupt === 'missing-field') parts.shift();
      if (corrupt === 'noncanonical-number') parts[0] = '';
      if (corrupt === 'invalid-hash') parts[5] = 'bad';
      const legacy = { version: 1, bootSessionId: firstBoot, fingerprint: parts.join(':') };
      if (corrupt === 'extra-field') legacy.extra = true;
      const raw = JSON.stringify(legacy);
      await fs.writeFile(proofPath(dataDirectory, 1), raw);
      await assert.rejects(observe(dataDirectory, { getBootSessionId: async () => secondBoot }), invalid('reboot_required'));
      assert.equal(await fs.readFile(proofPath(dataDirectory, 1), 'utf8'), raw);
    });
  }

  test('unavailable and failed boot identity reads preserve the existing proof', async () => {
    const dataDirectory = await temporaryDirectory();
    await writeOwnerFixture(dataDirectory, '');
    await assert.rejects(observe(dataDirectory), invalid('reboot_required'));
    const original = await fs.readFile(proofPath(dataDirectory), 'utf8');
    for (const getBootSessionId of [async () => null, async () => { throw new Error('OS failure'); }]) {
      await assert.rejects(observe(dataDirectory, { getBootSessionId }), invalid('boot_identity_unavailable'));
      assert.equal(await fs.readFile(proofPath(dataDirectory), 'utf8'), original);
    }
  });

  for (const target of ['owner', 'proof']) {
    test(`${target} symlink cannot authorize recovery or modify its target`, async () => {
      const dataDirectory = await temporaryDirectory();
      const file = await writeOwnerFixture(dataDirectory, '');
      await assert.rejects(observe(dataDirectory), invalid('reboot_required'));
      const linked = target === 'owner' ? file : proofPath(dataDirectory);
      await fs.rename(linked, `${linked}.original`);
      await fs.symlink(`${linked}.original`, linked);
      const original = await fs.readFile(`${linked}.original`, 'utf8');
      await assert.rejects(observe(dataDirectory, { getBootSessionId: async () => secondBoot }), invalid('unsafe_file_state'));
      assert.equal(await fs.readFile(`${linked}.original`, 'utf8'), original);
    });
  }

  test('a current mount change at quarantine revalidation blocks the move', async () => {
    const dataDirectory = await temporaryDirectory();
    const file = await writeOwnerFixture(dataDirectory, '');
    await assert.rejects(observe(dataDirectory), invalid('reboot_required'));
    let changed = false;
    const fsPromises = { ...fs, mkdir: async (target, ...args) => {
      if (target.endsWith('/quarantine')) changed = true;
      return fs.mkdir(target, ...args);
    }, lstat: async (target) => {
      const stat = await fs.lstat(target);
      if (target === file && changed) stat.dev += 1;
      return stat;
    } };
    const coordinator = await coordinatorFor(dataDirectory, { fsPromises, getBootSessionId: async () => secondBoot });
    await assert.rejects(coordinator.acquire(), invalid('unsafe_file_state'));
    assert.equal(await fs.readFile(file, 'utf8'), '');
    assert.equal(coordinator.getOwner(), null);
  });

  test('concurrent stopped-owner observations and acquisitions elect one owner', async () => {
    const dataDirectory = await temporaryDirectory();
    await writeOwnerFixture(dataDirectory, '');
    await assert.rejects(observe(dataDirectory), invalid('reboot_required'));
    const options = { getBootSessionId: async () => secondBoot };
    const coordinators = await Promise.all([coordinatorFor(dataDirectory, options), coordinatorFor(dataDirectory, options)]);
    const results = await Promise.allSettled([
      ...coordinators.map((coordinator) => coordinator.acquire()), observe(dataDirectory, options),
    ]);
    const claims = results.slice(0, 2);
    assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(claims.find((result) => result.status === 'rejected').reason.code, 'runtime_service_owner_exists');
    assert.equal(results[2].status, 'fulfilled');
    assert.equal((await fs.readdir(path.join(dataDirectory, 'runtime-service/quarantine'))).length, 1);
    assert.equal(JSON.parse(await fs.readFile(proofPath(dataDirectory), 'utf8')).bootSessionId, firstBoot);
    await Promise.all(coordinators.map((coordinator) => coordinator.release()));
  });

  for (const stage of ['quarantine', 'publication']) {
    test(`${stage} failure preserves damaged evidence and allows a later retry`, async () => {
      const dataDirectory = await temporaryDirectory();
      const file = await writeOwnerFixture(dataDirectory, '{');
      await assert.rejects(observe(dataDirectory), invalid('reboot_required'));
      let failOnce = true;
      const fsPromises = { ...fs, rename: async (source, target) => {
        if (stage === 'quarantine' && source === file && failOnce) {
          failOnce = false;
          throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' });
        }
        return fs.rename(source, target);
      }, link: async (source, target) => {
        if (stage === 'publication' && target === file && failOnce) {
          failOnce = false;
          throw Object.assign(new Error('fixture publication failure'), { code: 'EIO' });
        }
        return fs.link(source, target);
      } };
      const coordinator = await coordinatorFor(dataDirectory, { fsPromises, getBootSessionId: async () => secondBoot });
      await assert.rejects(coordinator.acquire(), { code: 'EIO' });
      assert.equal(coordinator.getOwner(), null);
      if (stage === 'quarantine') assert.equal(await fs.readFile(file, 'utf8'), '{');
      else assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'missing');
      await coordinator.acquire();
      const quarantine = path.join(dataDirectory, 'runtime-service/quarantine');
      const records = await fs.readdir(quarantine);
      assert.equal(records.length, 1);
      assert.equal(await fs.readFile(path.join(quarantine, records[0]), 'utf8'), '{');
      assert.equal((await fs.readdir(path.dirname(file))).some((name) => name.endsWith('.tmp')), false);
      await coordinator.release();
    });
  }

  test('polling retains the file-changed reason without emitting sensitive proof data', async () => {
    const dataDirectory = await temporaryDirectory();
    const file = await writeOwnerFixture(dataDirectory, '');
    await assert.rejects(observe(dataDirectory), invalid('reboot_required'));
    await fs.writeFile(file, '{');
    let time = 0;
    const events = [];
    await assert.rejects(observe(dataDirectory, {
      getBootSessionId: async () => secondBoot, timeoutMs: 200,
      clock: () => time, wait: async (milliseconds) => { time += milliseconds; },
      onDiagnostic: (event) => events.push(event),
    }), invalid('file_changed'));
    assert.deepEqual(events, [{ phase: 'owner_recovery', code: 'runtime_service_owner_invalid', reason: 'file_changed' }]);
  });
});

test('separate Node processes hold a single lifetime owner and reclaim after a crash', async () => {
  const dataDirectory = await temporaryDirectory();
  const source = `
    import { createRuntimeServiceCoordinator } from ${JSON.stringify(new URL('../runtime-service.mjs', import.meta.url).href)};
    const coordinator = await createRuntimeServiceCoordinator({
      dataDirectory: process.argv[1], safeStorage: {
        isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
      },
    });
    try {
      const owner = await coordinator.acquire();
      process.stdout.write(JSON.stringify({ state: 'acquired', generation: owner.generation }) + '\\n');
      process.stdin.resume();
      process.stdin.once('data', async () => { await coordinator.release(); process.exit(0); });
    } catch (error) { process.stdout.write(JSON.stringify({ state: error.code }) + '\\n'); }
  `;
  const children = [];
  const start = async () => {
    const child = spawn('node', ['--input-type=module', '-e', source, dataDirectory], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const result = await Promise.race([
      once(child.stdout, 'data').then(([bytes]) => JSON.parse(bytes.toString())),
      once(child, 'error').then(([error]) => { throw error; }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('owner child timed out')), 10_000); timer.unref(); }),
    ]);
    return { child, result };
  };
  try {
    const claims = await Promise.all(Array.from({ length: 5 }, start));
    const winners = claims.filter(({ result }) => result.state === 'acquired');
    assert.equal(winners.length, 1);
    for (const { result } of claims.filter(({ result }) => result.state !== 'acquired')) {
      assert.equal(result.state, 'runtime_service_owner_exists');
    }
    const winner = winners[0];
    if (['darwin', 'linux'].includes(process.platform)) {
      // Native smoke: only this disposable child and its temporary data are read.
      const started = await readRuntimeProcessStartIdentity(winner.child.pid);
      assert.ok(started?.startsWith(`${process.platform}:`));
      assert.equal(await readRuntimeProcessStartIdentity(winner.child.pid), started);
      const saved = JSON.parse(await fs.readFile(path.join(dataDirectory, 'runtime-service/owner-process.v1.json'), 'utf8'));
      assert.equal(saved.pid, winner.child.pid);
      assert.equal(saved.processStartIdentity, started);
      assert.match(saved.bootSessionId, /^[a-f0-9-]{36}$/);
    }
    const exited = once(winner.child, 'exit');
    winner.child.kill('SIGKILL');
    await exited;
    const replacement = await start();
    assert.equal(replacement.result.state, 'acquired');
    assert.equal(replacement.result.generation, winner.result.generation + 1);
    const released = once(replacement.child, 'exit');
    replacement.child.stdin.write('release');
    await released;
    assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'missing');
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
  }
});

describe('process identity ownership', () => {
  const firstBoot = '123e4567-e89b-42d3-a456-426614174000';
  const secondBoot = '123e4567-e89b-42d3-a456-426614174001';
  const identityPath = (directory) => path.join(directory, 'runtime-service/owner-process.v1.json');
  const proofPath = (directory) => path.join(directory, 'runtime-service/owner-recovery.v2.json');
  const fixture = async () => {
    const dataDirectory = await temporaryDirectory();
    const live = { boot: firstBoot, started: 'linux:100' };
    const options = {
      platform: 'linux', isProcessAlive: () => true,
      getBootSessionId: async () => live.boot,
      getProcessStartIdentity: async () => live.started,
    };
    const original = await coordinatorFor(dataDirectory, { ...options, pid: 792 });
    await original.acquire({ mode: 'app_bound' });
    const replacement = await coordinatorFor(dataDirectory, { ...options, pid: 793 });
    const stopped = (overrides = {}) => waitForRuntimeServiceOwnerStopped({ dataDirectory, ...options, timeoutMs: 0, ...overrides });
    return { dataDirectory, live, options, original, replacement, stopped };
  };

  for (const transition of ['reboot', 'pid_reuse']) {
    test(`${transition} recovers while the recorded PID is alive and preserves replacement fencing`, async () => {
      const { dataDirectory, live, options, original, replacement, stopped } = await fixture();
      const saved = JSON.parse(await fs.readFile(identityPath(dataDirectory), 'utf8'));
      assert.equal(saved.instanceId, original.getOwner().instanceId);
      assert.equal(saved.bootSessionId, firstBoot);
      assert.equal((await fs.stat(identityPath(dataDirectory))).mode & 0o777, 0o600);
      assert.equal(await stopped(), false);
      await assert.rejects(replacement.acquire(), { code: 'runtime_service_owner_exists' });
      if (transition === 'reboot') live.boot = secondBoot;
      else live.started = 'linux:101';
      assert.equal(await stopped(), true);
      const competitor = await coordinatorFor(dataDirectory, options);
      const claims = await Promise.allSettled([replacement.acquire(), competitor.acquire()]);
      const winner = claims.find((claim) => claim.status === 'fulfilled').value;
      assert.equal(claims.filter((claim) => claim.status === 'fulfilled').length, 1);
      assert.equal(winner.generation, original.getOwner().generation + 1);
      assert.equal(claims.find((claim) => claim.status === 'rejected').reason.code, 'runtime_service_owner_exists');
      await original.release();
      assert.equal((await readRuntimeServiceOwner({ dataDirectory })).owner.instanceId, winner.instanceId);
      await replacement.release();
      await competitor.release();
    });
  }

  test('legacy evidence survives retries and permits startup fallback only after a verified reboot', async () => {
    const { dataDirectory, live, original, replacement, stopped } = await fixture();
    await fs.unlink(identityPath(dataDirectory));
    let acquired = null;
    let persisted = 0;
    const acquire = createRuntimeOwnerAcquirer({
      getCoordinator: () => acquired, setCoordinator: (value) => { acquired = value; },
      createCoordinator: async () => replacement,
    });
    const recover = () => recoverAppBoundRuntime({
      connectionError: Object.assign(new Error('old descriptor'), { code: 'runtime_service_owner_stale' }),
      unregister: async () => ({ ok: true, state: 'not_registered' }),
      waitForStopped: () => stopped(), acquire: () => acquire('app_bound'),
      setMode: async () => { persisted += 1; }, release: () => replacement.release(),
    });
    await assert.rejects(recover(), { code: 'runtime_service_owner_unverified' });
    assert.equal(acquired, null);
    assert.equal(persisted, 0);
    const proof = await fs.readFile(proofPath(dataDirectory), 'utf8');
    await assert.rejects(recover(), { code: 'runtime_service_owner_unverified' });
    assert.equal(await fs.readFile(proofPath(dataDirectory), 'utf8'), proof);
    live.boot = secondBoot;
    await recover();
    assert.equal(persisted, 1);
    assert.equal(acquired, replacement);
    assert.equal(acquired.getOwner().mode, 'app_bound');
    await original.release();
    assert.equal((await readRuntimeServiceOwner({ dataDirectory })).owner.instanceId, replacement.getOwner().instanceId);
    await replacement.release();
  });

  test('legacy file changes invalidate reboot evidence', async () => {
    const { dataDirectory, live, stopped, replacement } = await fixture();
    await fs.unlink(identityPath(dataDirectory));
    await assert.rejects(stopped(), { recoveryReason: 'reboot_required' });
    live.boot = secondBoot;
    const owner = (await readRuntimeServiceOwner({ dataDirectory })).owner;
    await fs.writeFile(runtimeServiceOwnerPath(dataDirectory), JSON.stringify({ ...owner, generation: owner.generation + 1 }));
    await assert.rejects(stopped(), { recoveryReason: 'file_changed' });
    await assert.rejects(replacement.acquire(), { code: 'runtime_service_owner_unverified' });
    assert.equal(JSON.parse(await fs.readFile(proofPath(dataDirectory), 'utf8')).bootSessionId, secondBoot);
  });

  test('unavailable process or boot evidence never permits reclamation', async () => {
    const { live, stopped, replacement } = await fixture();
    live.started = null;
    await assert.rejects(stopped(), { recoveryReason: 'process_identity_unavailable' });
    await assert.rejects(replacement.acquire(), { code: 'runtime_service_owner_unverified' });
    live.boot = null;
    await assert.rejects(stopped(), { recoveryReason: 'boot_identity_unavailable' });
    await assert.rejects(stopped({ getBootSessionId: async () => { throw new Error('OS unavailable'); } }), {
      recoveryReason: 'boot_identity_unavailable',
    });
  });

  for (const damaged of ['missing', 'malformed', 'another_generation', 'another_instance', 'another_pid', 'invalid_start', 'old_version_write']) {
    test(`${damaged} companion cannot authorize same-boot reclamation`, async () => {
      const { dataDirectory, live, stopped, replacement } = await fixture();
      const file = identityPath(dataDirectory);
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (damaged === 'missing') await fs.unlink(file);
      else if (damaged === 'malformed') await fs.writeFile(file, '{');
      else if (damaged === 'old_version_write') {
        const owner = (await readRuntimeServiceOwner({ dataDirectory })).owner;
        await fs.writeFile(runtimeServiceOwnerPath(dataDirectory), JSON.stringify({ ...owner, generation: owner.generation + 1 }));
      } else {
        if (damaged === 'another_generation') saved.generation += 1;
        if (damaged === 'another_instance') saved.instanceId = '123e4567-e89b-42d3-a456-426614174002';
        if (damaged === 'another_pid') saved.pid += 1;
        if (damaged === 'invalid_start') saved.processStartIdentity = 'garbage';
        await fs.writeFile(file, JSON.stringify(saved));
      }
      live.started = 'linux:102';
      await assert.rejects(stopped(), { code: 'runtime_service_owner_unverified' });
      await assert.rejects(replacement.acquire(), { code: 'runtime_service_owner_unverified' });
    });
  }

  for (const problem of ['permission', 'symlink']) {
    test(`${problem} in identity evidence fails closed`, async () => {
      const { dataDirectory, options, stopped } = await fixture();
      const file = identityPath(dataDirectory);
      let fsPromises = fs;
      if (problem === 'permission') {
        fsPromises = { ...fs, readFile: async (target, ...args) => {
          if (target === file) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
          return fs.readFile(target, ...args);
        } };
      } else {
        await fs.rename(file, `${file}.original`);
        await fs.symlink(`${file}.original`, file);
      }
      const code = problem === 'permission' ? 'runtime_service_owner_unreadable' : 'runtime_service_owner_invalid';
      await assert.rejects(stopped({ fsPromises }), { code });
      const coordinator = await coordinatorFor(dataDirectory, { ...options, fsPromises });
      await assert.rejects(coordinator.acquire(), { code });
    });
  }

  test('reclamation rechecks the owner after OS probes before removing it', async () => {
    const { dataDirectory, options } = await fixture();
    const file = runtimeServiceOwnerPath(dataDirectory);
    const original = await fs.readFile(file, 'utf8');
    const successor = JSON.stringify({ ...JSON.parse(original), generation: 10 });
    const coordinator = await coordinatorFor(dataDirectory, { ...options, getProcessStartIdentity: async () => {
      await fs.writeFile(file, successor);
      return 'linux:200';
    } });
    await assert.rejects(coordinator.acquire(), { code: 'runtime_service_owner_busy' });
    assert.equal(await fs.readFile(file, 'utf8'), successor);
  });

  test('identity is durable before owner publication and an interrupted publication is safe to retry', async () => {
    const dataDirectory = await temporaryDirectory();
    let failOnce = true;
    const options = { platform: 'linux', getBootSessionId: async () => firstBoot, getProcessStartIdentity: async () => 'linux:100' };
    const coordinator = await coordinatorFor(dataDirectory, { ...options, fsPromises: { ...fs, link: async (source, target) => {
      const candidate = JSON.parse(await fs.readFile(source, 'utf8'));
      const saved = JSON.parse(await fs.readFile(identityPath(dataDirectory), 'utf8'));
      assert.equal(saved.instanceId, candidate.instanceId);
      assert.equal(saved.generation, candidate.generation);
      assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'missing');
      if (failOnce) { failOnce = false; throw Object.assign(new Error('fixture'), { code: 'EIO' }); }
      return fs.link(source, target);
    } } });
    await assert.rejects(coordinator.acquire(), { code: 'EIO' });
    assert.equal(coordinator.getOwner(), null);
    assert.equal((await readRuntimeServiceOwner({ dataDirectory })).state, 'missing');
    await coordinator.acquire();
    await coordinator.release();
  });

  test('stale descriptors are rejected for app-bound owners and every service identity mismatch', async () => {
    const { dataDirectory, original, replacement, options, live } = await fixture();
    await original.start({ port: 44001, health: 'healthy' });
    const oldDescriptor = original.getDescriptor();
    await assert.rejects(assertRuntimeServiceDescriptorOwner({ dataDirectory, ...options, descriptor: oldDescriptor }), { code: 'runtime_service_owner_stale' });
    await original.release();
    await replacement.acquire();
    await replacement.start({ port: 44001, health: 'healthy' });
    const descriptor = replacement.getDescriptor();
    await assertRuntimeServiceDescriptorOwner({ dataDirectory, ...options, descriptor });
    live.started = 'linux:999';
    await assert.rejects(assertRuntimeServiceDescriptorOwner({ dataDirectory, ...options, descriptor }), { code: 'runtime_service_owner_stale' });
    live.started = 'linux:100';
    await fs.unlink(identityPath(dataDirectory));
    // A previous release without the companion can still perform authentication.
    await assertRuntimeServiceDescriptorOwner({ dataDirectory, ...options, descriptor });
    for (const mismatch of [oldDescriptor, { ...descriptor, pid: 999 }, { ...descriptor, ownerGeneration: 99 },
      { ...descriptor, instanceId: '123e4567-e89b-42d3-a456-426614174002' }]) {
      await assert.rejects(assertRuntimeServiceDescriptorOwner({ dataDirectory, ...options, descriptor: mismatch }), { code: 'runtime_service_owner_stale' });
    }
    await replacement.release();
    await assert.rejects(assertRuntimeServiceDescriptorOwner({ dataDirectory, ...options, descriptor }), { code: 'runtime_service_owner_stale' });
    assert.equal(await waitForRuntimeServiceOwnerStopped({ dataDirectory, ...options }), true);
  });

  test('unsupported platforms retain conservative PID fencing', async () => {
    const { dataDirectory, options } = await fixture();
    const unsupported = { ...options, platform: 'win32', getBootSessionId: async () => null };
    assert.equal(await waitForRuntimeServiceOwnerStopped({ dataDirectory, ...unsupported, timeoutMs: 0 }), false);
    await assert.rejects((await coordinatorFor(dataDirectory, unsupported)).acquire(), { code: 'runtime_service_owner_exists' });
  });
});

test('OS identity readers use bounded metadata probes and handle unavailable or malformed output', async () => {
  let calls = 0;
  const execute = (file, args, options, callback) => {
    calls += 1;
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-p', '792', '-o', 'lstart=']);
    assert.equal(options.env.LC_ALL, 'C');
    assert.equal(options.env.TZ, 'UTC');
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxBuffer, 256);
    callback(null, 'Mon Sep 28  10:01:26 2026\n');
  };
  assert.equal(await readRuntimeProcessStartIdentity(792, { platform: 'darwin', execute }), 'darwin:Mon Sep 28 10:01:26 2026');
  assert.equal(await readRuntimeProcessStartIdentity(-1, { platform: 'darwin', execute }), null);
  assert.equal(calls, 1);
  for (const output of ['', 'not a start identity']) {
    assert.equal(await readRuntimeProcessStartIdentity(792, { platform: 'darwin', execute: (_file, _args, _options, callback) => callback(null, output) }), null);
  }
  assert.equal(await readRuntimeProcessStartIdentity(792, { platform: 'darwin', execute: (_file, _args, _options, callback) => callback(new Error('timeout')) }), null);
  const fields = ['S', ...Array(18).fill('0'), '123456', '0'];
  assert.equal(await readRuntimeProcessStartIdentity(792, { platform: 'linux', fsPromises: {
    readFile: async (file) => { assert.equal(file, '/proc/792/stat'); return `792 (a name ) with parens) ${fields.join(' ')}`; },
  } }), 'linux:123456');
  assert.equal(await readRuntimeProcessStartIdentity(792, { platform: 'linux', fsPromises: { readFile: async () => 'bad' } }), null);
  assert.equal(await readRuntimeProcessStartIdentity(792, { platform: 'linux', fsPromises: { readFile: async () => { throw new Error('denied'); } } }), null);
});
