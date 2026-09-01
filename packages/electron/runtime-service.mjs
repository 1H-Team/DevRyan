import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_SERVICE_PROTOCOL_VERSION = 2;
export const RUNTIME_SERVICE_SUPPORTED_PROTOCOLS = Object.freeze([1, 2]);
export const RUNTIME_SERVICE_COOKIE = 'devryan_runtime_service';
export const RUNTIME_SERVICE_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
export const DESKTOP_HOST_LEASE_TTL_MS = 30_000;

const DESCRIPTOR_VERSION = 1;
const TOKEN_BYTES = 32;
const MAX_DESCRIPTOR_BYTES = 32 * 1_024;
const HEALTH_STATES = new Set(['starting', 'healthy', 'degraded', 'updating', 'disabled']);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class RuntimeServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RuntimeServiceError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new RuntimeServiceError(message, code);
};

const serviceDirectory = (dataDirectory) => path.join(dataDirectory, 'runtime-service');
export const runtimeServiceDescriptorPath = (dataDirectory) => (
  path.join(serviceDirectory(dataDirectory), 'handshake.v1.json')
);
export const runtimeServiceOwnerPath = (dataDirectory) => (
  path.join(serviceDirectory(dataDirectory), 'owner.v1.lock')
);

const exactObject = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isUuid = (value) => (
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
);

const validateAbsoluteDirectory = (value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail('Runtime service requires an absolute data directory', 'runtime_service_config_invalid');
  }
};

const validateSafeStorage = (safeStorage) => {
  if (!safeStorage
    || safeStorage.isEncryptionAvailable?.() !== true
    || typeof safeStorage.encryptString !== 'function'
    || typeof safeStorage.decryptString !== 'function') {
    fail('Runtime service OS-sealed storage is unavailable', 'runtime_service_sealing_unavailable');
  }
};

const isProcessAliveDefault = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const parseBoundedJson = (bytes, code) => {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_DESCRIPTOR_BYTES) {
    fail('Runtime service state is invalid', code);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('Runtime service state is invalid', code);
  }
};

const validateOwner = (value) => {
  if (!exactObject(value, ['version', 'instanceId', 'pid', 'generation', 'mode', 'createdAt'])
    || value.version !== 1
    || !isUuid(value.instanceId)
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || !Number.isSafeInteger(value.generation)
    || value.generation <= 0
    || !['app_bound', 'service'].includes(value.mode)
    || typeof value.createdAt !== 'string') {
    fail('Runtime service owner state is invalid', 'runtime_service_owner_invalid');
  }
  return Object.freeze({ ...value });
};

const validateDesktopHost = (value) => {
  if (!exactObject(value, ['state', 'leaseId', 'expiresAt', 'capabilities'])
    || !['unavailable', 'connected'].includes(value.state)
    || (value.leaseId !== null && !isUuid(value.leaseId))
    || (value.expiresAt !== null && typeof value.expiresAt !== 'string')
    || !Array.isArray(value.capabilities)
    || value.capabilities.some((item) => ![
      'focus',
      'notifications',
      'browser_cdp',
      'browser_observation',
    ].includes(item))) {
    fail('Runtime service descriptor is invalid', 'runtime_service_descriptor_invalid');
  }
  return Object.freeze({
    state: value.state,
    leaseId: value.leaseId,
    expiresAt: value.expiresAt,
    capabilities: Object.freeze([...value.capabilities]),
  });
};

export const validateRuntimeServiceDescriptor = (value) => {
  if (!exactObject(value, [
    'version',
    'instanceId',
    'pid',
    'port',
    'protocolVersion',
    'health',
    'ownerGeneration',
    'desktopHost',
    'sealedBootstrapToken',
    'updatedAt',
  ])
    || value.version !== DESCRIPTOR_VERSION
    || !isUuid(value.instanceId)
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || !Number.isSafeInteger(value.port)
    || value.port < 1
    || value.port > 65_535
    || !RUNTIME_SERVICE_SUPPORTED_PROTOCOLS.includes(value.protocolVersion)
    || !HEALTH_STATES.has(value.health)
    || !Number.isSafeInteger(value.ownerGeneration)
    || value.ownerGeneration <= 0
    || typeof value.sealedBootstrapToken !== 'string'
    || value.sealedBootstrapToken.length < 16
    || value.sealedBootstrapToken.length > 8_192
    || typeof value.updatedAt !== 'string') {
    fail('Runtime service descriptor is invalid', 'runtime_service_descriptor_invalid');
  }
  return Object.freeze({
    ...value,
    desktopHost: validateDesktopHost(value.desktopHost),
  });
};

const fsyncDirectory = async (directory, fsPromises) => {
  const handle = await fsPromises.open(directory, 'r').catch(() => null);
  try {
    await handle?.sync();
  } catch {
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const atomicWritePrivateJson = async (filePath, value, fsPromises) => {
  const directory = path.dirname(filePath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporary, filePath);
    await fsPromises.chmod(filePath, 0o600);
    await fsyncDirectory(directory, fsPromises);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporary).catch(() => undefined);
  }
};

export const readRuntimeServiceDescriptor = async ({ dataDirectory, fsPromises = fs } = {}) => {
  validateAbsoluteDirectory(dataDirectory);
  const bytes = await fsPromises.readFile(runtimeServiceDescriptorPath(dataDirectory));
  return validateRuntimeServiceDescriptor(parseBoundedJson(bytes, 'runtime_service_descriptor_invalid'));
};

export const unsealRuntimeServiceBootstrapToken = ({ descriptor, safeStorage }) => {
  validateSafeStorage(safeStorage);
  const validated = validateRuntimeServiceDescriptor(descriptor);
  let token;
  try {
    token = safeStorage.decryptString(Buffer.from(validated.sealedBootstrapToken, 'base64'));
  } catch {
    fail('Runtime service bootstrap token cannot be unsealed', 'runtime_service_bootstrap_unseal_failed');
  }
  if (!BASE64URL_PATTERN.test(token)) {
    fail('Runtime service bootstrap token is invalid', 'runtime_service_bootstrap_invalid');
  }
  return token;
};

export const isRuntimeServiceProtocolSupported = (protocolVersion) => (
  RUNTIME_SERVICE_SUPPORTED_PROTOCOLS.includes(protocolVersion)
);

export async function createRuntimeServiceCoordinator({
  dataDirectory,
  safeStorage,
  fsPromises = fs,
  pid = process.pid,
  isProcessAlive = isProcessAliveDefault,
  randomBytes = crypto.randomBytes,
  randomUUID = crypto.randomUUID,
  now = () => new Date(),
} = {}) {
  validateAbsoluteDirectory(dataDirectory);
  validateSafeStorage(safeStorage);
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof isProcessAlive !== 'function') {
    fail('Runtime service process identity is invalid', 'runtime_service_config_invalid');
  }

  const directory = serviceDirectory(dataDirectory);
  const ownerPath = runtimeServiceOwnerPath(dataDirectory);
  const descriptorPath = runtimeServiceDescriptorPath(dataDirectory);
  const instanceId = randomUUID();
  let owner = null;
  let descriptor = null;
  let bootstrapToken = null;
  let sessionToken = null;
  let sessionExpiresAt = 0;

  const nextToken = () => {
    const token = Buffer.from(randomBytes(TOKEN_BYTES)).toString('base64url');
    if (!BASE64URL_PATTERN.test(token)) {
      fail('Runtime service token generator failed', 'runtime_service_token_invalid');
    }
    return token;
  };

  const sealToken = (token) => {
    try {
      return Buffer.from(safeStorage.encryptString(token)).toString('base64');
    } catch {
      fail('Runtime service bootstrap token cannot be sealed', 'runtime_service_bootstrap_seal_failed');
    }
  };

  const persistDescriptor = async () => {
    if (!descriptor) fail('Runtime service has not started', 'runtime_service_not_started');
    await atomicWritePrivateJson(descriptorPath, descriptor, fsPromises);
  };

  const acquire = async ({ mode = 'service' } = {}) => {
    if (owner) return owner;
    if (!['app_bound', 'service'].includes(mode)) {
      fail('Runtime service owner mode is invalid', 'runtime_service_config_invalid');
    }
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(directory, 0o700);

    let previousGeneration = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let existing = null;
      try {
        existing = validateOwner(parseBoundedJson(
          await fsPromises.readFile(ownerPath),
          'runtime_service_owner_invalid',
        ));
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'runtime_service_owner_invalid') throw error;
        if (error?.code === 'runtime_service_owner_invalid') {
          fail('Runtime service owner state is invalid', 'runtime_service_owner_invalid');
        }
      }
      if (existing) {
        previousGeneration = existing.generation;
        if (isProcessAlive(existing.pid)) {
          fail('Another runtime already owns this data directory', 'runtime_service_owner_exists');
        }
        await fsPromises.unlink(ownerPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }

      const candidate = {
        version: 1,
        instanceId,
        pid,
        generation: Math.max(previousGeneration + 1, 1),
        mode,
        createdAt: now().toISOString(),
      };
      let handle;
      try {
        handle = await fsPromises.open(ownerPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(candidate)}\n`);
        await handle.sync();
        await handle.close();
        handle = null;
        await fsPromises.chmod(ownerPath, 0o600);
        await fsyncDirectory(directory, fsPromises);
        owner = Object.freeze(candidate);
        return owner;
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === 1) {
          if (error?.code === 'EEXIST') {
            fail('Another runtime already owns this data directory', 'runtime_service_owner_exists');
          }
          throw error;
        }
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    fail('Another runtime already owns this data directory', 'runtime_service_owner_exists');
  };

  const start = async ({ port, health = 'starting' } = {}) => {
    if (!owner) fail('Runtime service owner must be acquired first', 'runtime_service_owner_required');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !HEALTH_STATES.has(health)) {
      fail('Runtime service descriptor input is invalid', 'runtime_service_config_invalid');
    }
    bootstrapToken = nextToken();
    sessionToken = null;
    sessionExpiresAt = 0;
    descriptor = validateRuntimeServiceDescriptor({
      version: DESCRIPTOR_VERSION,
      instanceId,
      pid,
      port,
      protocolVersion: RUNTIME_SERVICE_PROTOCOL_VERSION,
      health,
      ownerGeneration: owner.generation,
      desktopHost: {
        state: 'unavailable',
        leaseId: null,
        expiresAt: null,
        capabilities: [],
      },
      sealedBootstrapToken: sealToken(bootstrapToken),
      updatedAt: now().toISOString(),
    });
    await persistDescriptor();
    return descriptor;
  };

  const update = async ({ health, desktopHost } = {}) => {
    if (!descriptor) fail('Runtime service has not started', 'runtime_service_not_started');
    const nextHealth = health ?? descriptor.health;
    const nextDesktopHost = desktopHost ?? descriptor.desktopHost;
    descriptor = validateRuntimeServiceDescriptor({
      ...descriptor,
      health: nextHealth,
      desktopHost: nextDesktopHost,
      updatedAt: now().toISOString(),
    });
    await persistDescriptor();
    return descriptor;
  };

  const consumeBootstrap = async (candidate) => {
    if (typeof candidate !== 'string'
      || !bootstrapToken
      || candidate.length !== bootstrapToken.length
      || !crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(bootstrapToken))) {
      fail('Runtime service bootstrap token is invalid or already used', 'runtime_service_bootstrap_rejected');
    }
    sessionToken = nextToken();
    sessionExpiresAt = now().getTime() + RUNTIME_SERVICE_SESSION_TTL_MS;
    bootstrapToken = nextToken();
    descriptor = validateRuntimeServiceDescriptor({
      ...descriptor,
      sealedBootstrapToken: sealToken(bootstrapToken),
      updatedAt: now().toISOString(),
    });
    await persistDescriptor();
    return Object.freeze({ token: sessionToken, expiresAt: new Date(sessionExpiresAt).toISOString() });
  };

  const authorizeSession = (candidate) => {
    if (typeof candidate !== 'string'
      || !sessionToken
      || now().getTime() >= sessionExpiresAt
      || candidate.length !== sessionToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(sessionToken));
  };

  const publicStatus = () => {
    if (!descriptor) return null;
    const desktopHost = descriptor.desktopHost.expiresAt
      && Date.parse(descriptor.desktopHost.expiresAt) <= now().getTime()
      ? { state: 'unavailable', leaseId: null, expiresAt: null, capabilities: [] }
      : descriptor.desktopHost;
    return Object.freeze({
      instanceId: descriptor.instanceId,
      port: descriptor.port,
      protocolVersion: descriptor.protocolVersion,
      health: descriptor.health,
      ownerGeneration: descriptor.ownerGeneration,
      desktopHost,
      updatedAt: descriptor.updatedAt,
    });
  };

  const release = async () => {
    sessionToken = null;
    bootstrapToken = null;
    if (owner) {
      const current = await fsPromises.readFile(ownerPath).then(
        (bytes) => validateOwner(parseBoundedJson(bytes, 'runtime_service_owner_invalid')),
        () => null,
      );
      if (current?.instanceId === owner.instanceId && current?.generation === owner.generation) {
        await fsPromises.unlink(ownerPath).catch(() => undefined);
      }
    }
    owner = null;
  };

  return Object.freeze({
    acquire,
    start,
    update,
    consumeBootstrap,
    authorizeSession,
    publicStatus,
    release,
    getOwner: () => owner,
    getDescriptor: () => descriptor,
  });
}
