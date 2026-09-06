import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { withCrossProcessFileLock } from '../harness-runtime/lib/atomic-file.js';

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
    return error?.code !== 'ESRCH';
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

// Readers never confuse unreadable or malformed state with an absent owner.
export const readRuntimeServiceOwner = async ({ dataDirectory, fsPromises = fs } = {}) => {
  validateAbsoluteDirectory(dataDirectory);
  const filePath = runtimeServiceOwnerPath(dataDirectory);
  try {
    const stat = await fsPromises.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_DESCRIPTOR_BYTES) {
      return { state: 'malformed', stat };
    }
    const bytes = await fsPromises.readFile(filePath);
    try {
      return { state: 'valid', owner: validateOwner(parseBoundedJson(bytes, 'runtime_service_owner_invalid')), stat };
    } catch (error) {
      if (error?.code !== 'runtime_service_owner_invalid') throw error;
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      return { state: 'malformed', stat, fingerprint: [
        stat.dev, stat.ino, stat.size, stat.ctimeMs, stat.mtimeMs,
        sha256,
      ].join(':'), identity: {
        ino: stat.ino, birthtimeMs: stat.birthtimeMs, size: stat.size,
        ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, sha256,
      } };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', code: 'runtime_service_owner_unreadable' };
  }
};

const RECOVERY_MESSAGES = Object.freeze({
  reboot_required: 'Runtime owner state is damaged. The unchanged file must be observed across a computer restart before automatic repair. Restart the computer, then reopen DevRyan.',
  file_changed: 'The damaged runtime owner file changed since it was recorded. A new recovery record has been saved. Restart the computer, then reopen DevRyan. If this repeats, inspect runtime-service/owner.v1.lock before changing it.',
  boot_identity_unavailable: 'Runtime owner state is damaged, but the operating system boot identity could not be verified. Inspect runtime-service/owner.v1.lock and the startup diagnostics before changing it.',
  unsafe_file_state: 'Runtime owner state cannot be repaired automatically because its file state is unsafe or unsupported. Inspect runtime-service/owner.v1.lock and the recovery files before changing them.',
});
const ownerStateError = (state, reason = 'unsafe_file_state') => {
  const error = new RuntimeServiceError(
    state === 'unreadable'
      ? 'Runtime owner state cannot be read. Check data-directory permissions and retry.'
      : RECOVERY_MESSAGES[reason],
    state === 'unreadable' ? 'runtime_service_owner_unreadable' : 'runtime_service_owner_invalid',
  );
  if (state !== 'unreadable') error.recoveryReason = reason;
  return error;
};
const reportBlockedRecovery = (reason, onDiagnostic) => {
  onDiagnostic({ phase: 'owner_recovery', code: 'runtime_service_owner_invalid', reason });
  return ownerStateError('malformed', reason);
};

// Both observation/proof writes and lifetime-owner mutations share this guard.
// Callers must not nest it; the stopped-owner polling delay stays outside it.
const withOwnerMutation = (dataDirectory, fsPromises, callback) => withCrossProcessFileLock(
  `${runtimeServiceOwnerPath(dataDirectory)}.mutation`, callback, { fs: fsPromises },
).catch((error) => {
  if (error?.code === 'LOCK_TIMEOUT') {
    fail('Runtime ownership is busy. Wait briefly and retry.', 'runtime_service_owner_busy');
  }
  throw error;
});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// Boot-session IDs, unlike wall-clock/mtime comparisons, prove that processes
// from the recorded observation cannot still be running. Unsupported hosts fail
// closed; this is not a TTL-based stale-lock heuristic.
const readBootSessionId = async () => {
  try {
    let value;
    if (process.platform === 'darwin') {
      value = await new Promise((resolve, reject) => {
        execFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
          encoding: 'utf8', timeout: 2_000, maxBuffer: 256,
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
    } else if (process.platform === 'linux') {
      value = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
    }
    const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return isUuid(id) ? id : null;
  } catch {
    return null;
  }
};

const IDENTITY_KEYS = ['ino', 'birthtimeMs', 'size', 'ctimeMs', 'mtimeMs', 'sha256'];
const validOwnerIdentity = (identity) => exactObject(identity, IDENTITY_KEYS)
  && Number.isSafeInteger(identity.ino) && identity.ino >= 0
  && Number.isSafeInteger(identity.size) && identity.size >= 0 && identity.size <= MAX_DESCRIPTOR_BYTES
  && Number.isFinite(identity.birthtimeMs) && identity.birthtimeMs >= 0
  && Number.isFinite(identity.ctimeMs) && Number.isFinite(identity.mtimeMs)
  && typeof identity.sha256 === 'string' && /^[a-f0-9]{64}$/.test(identity.sha256);

const parseLegacyIdentity = (fingerprint) => {
  if (typeof fingerprint !== 'string') return null;
  const fields = fingerprint.split(':');
  if (fields.length !== 6 || !/^[a-f0-9]{64}$/.test(fields[5])) return null;
  const numbers = fields.slice(0, 5).map(Number);
  if (numbers.some((value, index) => !Number.isFinite(value) || String(value) !== fields[index])
    || numbers.slice(0, 3).some((value) => !Number.isSafeInteger(value) || value < 0)
    || numbers[2] > MAX_DESCRIPTOR_BYTES) return null;
  const [, ino, size, ctimeMs, mtimeMs] = numbers;
  return { ino, size, ctimeMs, mtimeMs, sha256: fields[5] };
};

const readRecoveryProof = async (proofPath, fsPromises) => {
  try {
    const stat = await fsPromises.lstat(proofPath);
    if (!stat.isFile()) throw ownerStateError('malformed', 'unsafe_file_state');
    if (stat.size > MAX_DESCRIPTOR_BYTES) return null;
    return parseBoundedJson(await fsPromises.readFile(proofPath), 'runtime_service_recovery_proof_invalid');
  } catch (error) {
    if (['ENOENT', 'runtime_service_recovery_proof_invalid'].includes(error?.code)) return null;
    if (error?.code === 'runtime_service_owner_invalid') throw error;
    throw ownerStateError('unreadable');
  }
};

// The OS device number identifies the current mount, not persistent file
// identity across boots. Keep it in the immediate fingerprint above, but never
// include it in the reboot proof. This function requires the mutation guard.
const inspectCorruptOwnerRecovery = async ({
  dataDirectory, result, fsPromises, getBootSessionId,
}) => {
  if (!result.fingerprint || !result.stat.isFile() || !validOwnerIdentity(result.identity)) {
    return { canRecover: false, reason: 'unsafe_file_state' };
  }
  const observedBoot = await Promise.resolve().then(getBootSessionId).catch(() => null);
  if (!isUuid(observedBoot)) return { canRecover: false, reason: 'boot_identity_unavailable' };
  const bootSessionId = observedBoot.toLowerCase();
  const proofPath = path.join(serviceDirectory(dataDirectory), 'owner-recovery.v2.json');
  const proof = await readRecoveryProof(proofPath, fsPromises);
  let previousBoot = null;
  let identityChanged = false;
  const validProof = exactObject(proof, ['version', 'bootSessionId', 'identity']) && proof.version === 2
    && isUuid(proof.bootSessionId) && validOwnerIdentity(proof.identity);
  if (validProof) {
    identityChanged = IDENTITY_KEYS.some((key) => proof.identity[key] !== result.identity[key]);
    if (!identityChanged) previousBoot = proof.bootSessionId.toLowerCase();
  } else {
    // A valid v2 observation takes precedence. Never let an older v1 proof
    // override a changed file. Migration preserves the original v1 file.
    const legacy = await readRecoveryProof(path.join(serviceDirectory(dataDirectory), 'owner-recovery.v1.json'), fsPromises);
    if (exactObject(legacy, ['version', 'bootSessionId', 'fingerprint']) && legacy.version === 1
      && isUuid(legacy.bootSessionId)) {
      const identity = parseLegacyIdentity(legacy.fingerprint);
      if (identity) {
        identityChanged = Object.keys(identity).some((key) => identity[key] !== result.identity[key]);
        if (!identityChanged) previousBoot = legacy.bootSessionId.toLowerCase();
      }
    }
  }
  if (previousBoot && validProof) {
    return { canRecover: previousBoot !== bootSessionId, reason: 'reboot_required' };
  }
  // Retain the original boot when migrating a matching v1 proof. Repeated
  // retries of a matching v2 proof above never overwrite its evidence.
  await atomicWritePrivateJson(proofPath, {
    version: 2, bootSessionId: previousBoot || bootSessionId, identity: result.identity,
  }, fsPromises);
  return {
    canRecover: previousBoot !== null && previousBoot !== bootSessionId,
    reason: identityChanged ? 'file_changed' : 'reboot_required',
  };
};

export const waitForRuntimeServiceOwnerStopped = async ({
  dataDirectory, fsPromises = fs, timeoutMs = 15_000,
  isProcessAlive = isProcessAliveDefault, wait = delay, clock = Date.now,
  getBootSessionId = readBootSessionId,
  onDiagnostic = () => undefined,
} = {}) => {
  validateAbsoluteDirectory(dataDirectory);
  const deadline = clock() + timeoutMs;
  let bootSessionIdPromise;
  let fileChanged = false;
  const getObservedBootSessionId = () => bootSessionIdPromise ??= getBootSessionId();
  while (true) {
    let result = await readRuntimeServiceOwner({ dataDirectory, fsPromises });
    let recovery;
    if (result.state === 'malformed') {
      ({ result, recovery } = await withOwnerMutation(dataDirectory, fsPromises, async () => {
        const current = await readRuntimeServiceOwner({ dataDirectory, fsPromises });
        return {
          result: current,
          recovery: current.state === 'malformed' ? await inspectCorruptOwnerRecovery({
            dataDirectory, result: current, fsPromises, getBootSessionId: getObservedBootSessionId,
          }) : null,
        };
      }));
    }
    if (result.state === 'missing') return true;
    if (result.state === 'unreadable') throw ownerStateError(result.state);
    if (result.state === 'valid' && !isProcessAlive(result.owner.pid)) return true;
    if (recovery?.canRecover) return true;
    if (recovery?.reason === 'file_changed') fileChanged = true;
    if (clock() >= deadline) {
      if (result.state === 'malformed') {
        const reason = fileChanged && recovery.reason === 'reboot_required' ? 'file_changed' : recovery.reason;
        throw reportBlockedRecovery(reason, onDiagnostic);
      }
      return false;
    }
    await wait(Math.min(100, Math.max(1, deadline - clock())));
  }
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
  wait = delay,
  getBootSessionId = readBootSessionId,
  onDiagnostic = () => undefined,
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

  // Use the shared cross-process mutation guard, separately from the lifetime
  // owner. It serializes reclamation and release as well as acquisition.
  const mutateOwner = (callback) => withOwnerMutation(dataDirectory, fsPromises, callback);
  const acquire = async ({ mode = 'service' } = {}) => mutateOwner(async () => {
    if (owner) return owner;
    if (!['app_bound', 'service'].includes(mode)) {
      fail('Runtime service owner mode is invalid', 'runtime_service_config_invalid');
    }
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(directory, 0o700);
    let result;
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      result = await readRuntimeServiceOwner({ dataDirectory, fsPromises });
      if (result.state !== 'malformed') break;
      if (attempt < 10) await wait(100);
    }
    if (result.state === 'unreadable') throw ownerStateError(result.state);
    if (result.state === 'malformed') {
      const recovery = await inspectCorruptOwnerRecovery({ dataDirectory, result, fsPromises, getBootSessionId });
      if (!recovery.canRecover) {
        throw reportBlockedRecovery(recovery.reason, onDiagnostic);
      }
      const quarantine = path.join(directory, 'quarantine');
      await fsPromises.mkdir(quarantine, { recursive: true, mode: 0o700 });
      await fsPromises.chmod(quarantine, 0o700);
      // Recheck after awaiting filesystem work, before moving the observed inode.
      const latest = await readRuntimeServiceOwner({ dataDirectory, fsPromises });
      if (latest.state !== 'malformed' || latest.fingerprint !== result.fingerprint
        || latest.identity?.birthtimeMs !== result.identity.birthtimeMs) {
        throw reportBlockedRecovery('unsafe_file_state', onDiagnostic);
      }
      const target = path.join(quarantine, `owner-${randomUUID()}.corrupt`);
      await fsPromises.rename(ownerPath, target);
      await fsPromises.chmod(target, 0o600);
      await fsyncDirectory(quarantine, fsPromises);
      await fsyncDirectory(directory, fsPromises);
      onDiagnostic({ phase: 'owner_recovery', code: 'runtime_service_owner_quarantined' });
    }
    const existing = result.state === 'valid' ? result.owner : null;
    if (existing) {
      if (isProcessAlive(existing.pid)) {
        fail('Another runtime already owns this data directory', 'runtime_service_owner_exists');
      }
      await fsPromises.unlink(ownerPath);
    }
    const candidate = {
      version: 1, instanceId, pid, generation: (existing?.generation || 0) + 1,
      mode, createdAt: now().toISOString(),
    };
    // link() publishes a complete, durable inode and fails if any owner won
    // first. rename() would silently replace the winner and is not safe here.
    const temporary = `${ownerPath}.${pid}.${randomUUID()}.tmp`;
    let handle;
    let published = false;
    try {
      handle = await fsPromises.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(candidate)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsPromises.link(temporary, ownerPath);
      published = true;
      await fsyncDirectory(directory, fsPromises);
      owner = Object.freeze(candidate);
      return owner;
    } catch (error) {
      if (published) await fsPromises.unlink(ownerPath);
      if (error?.code === 'EEXIST') {
        fail('Another runtime already owns this data directory', 'runtime_service_owner_exists');
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await fsPromises.unlink(temporary).catch(() => undefined);
    }
  });

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

  const release = async () => mutateOwner(async () => {
    sessionToken = null;
    bootstrapToken = null;
    if (owner) {
      const current = await readRuntimeServiceOwner({ dataDirectory, fsPromises });
      if (current.state === 'unreadable' || current.state === 'malformed') {
        throw ownerStateError(current.state);
      }
      if (current.state === 'valid' && current.owner.instanceId === owner.instanceId
        && current.owner.generation === owner.generation) {
        await fsPromises.unlink(ownerPath);
        await fsyncDirectory(directory, fsPromises);
      }
    }
    owner = null;
  });

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
