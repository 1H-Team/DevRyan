import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  RUNTIME_SERVICE_PROTOCOL_VERSION,
  createRuntimeServiceCoordinator,
  isRuntimeServiceProtocolSupported,
  readRuntimeServiceDescriptor,
  runtimeServiceDescriptorPath,
  runtimeServiceOwnerPath,
  unsealRuntimeServiceBootstrapToken,
  validateRuntimeServiceDescriptor,
} from '../runtime-service.mjs';

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
    });
    const firstOwner = await first.acquire({ mode: 'app_bound' });

    const competing = await createRuntimeServiceCoordinator({
      dataDirectory,
      safeStorage,
      pid: 52,
      isProcessAlive: (pid) => pid === 51,
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
