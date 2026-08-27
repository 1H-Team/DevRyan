import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const LEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATE_VERSION = 1;

export class ComputerProfileError extends Error {
  constructor(message, code = 'DEVRYAN_BOT_PROFILE_INVALID') {
    super(message);
    this.name = 'ComputerProfileError';
    this.code = code;
    this.statusCode = 500;
  }
}

const fail = (message, code) => {
  throw new ComputerProfileError(message, code);
};

const assertManagedDirectory = async (directory, fsPromises) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === path.parse(directory).root) {
    fail('Computer storage directory is invalid');
  }
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsPromises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Computer storage directory is unsafe');
  await fsPromises.chmod(directory, 0o700);
};

const clearDirectory = async (directory, fsPromises) => {
  await assertManagedDirectory(directory, fsPromises);
  const entries = await fsPromises.readdir(directory);
  for (const entry of entries) {
    const target = path.join(directory, entry);
    if (path.dirname(target) !== directory) fail('Computer storage entry escaped its directory');
    await fsPromises.rm(target, { recursive: true, force: true });
  }
};

const atomicWrite = async (filePath, value, fsPromises) => {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporary, filePath);
    await fsPromises.chmod(filePath, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporary).catch(() => undefined);
  }
};

export function createProfileManager({
  profileDirectory,
  scratchDirectory,
  scopeMode,
  fsPromises = fs,
} = {}) {
  if (!['team', 'personalized'].includes(scopeMode)) {
    fail('Computer scope mode is invalid');
  }
  const statePath = path.join(profileDirectory || '', '.devryan-lease.v1.json');

  const initialize = async () => {
    await assertManagedDirectory(profileDirectory, fsPromises);
    await assertManagedDirectory(scratchDirectory, fsPromises);
  };

  const readLeaseState = async () => {
    try {
      const value = JSON.parse(await fsPromises.readFile(statePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== 'leaseId\0version'
        || value.version !== STATE_VERSION || !LEASE_PATTERN.test(value.leaseId)) {
        fail('Computer lease state is invalid');
      }
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof ComputerProfileError) throw error;
      fail('Computer lease state cannot be read');
    }
  };

  const prepareLease = async ({ leaseId } = {}) => {
    if (!LEASE_PATTERN.test(leaseId)) fail('Computer lease ID is invalid');
    await initialize();
    const previous = await readLeaseState();
    const changed = previous?.leaseId !== leaseId;
    const scratchCleared = false;
    await atomicWrite(statePath, { version: STATE_VERSION, leaseId }, fsPromises);
    return Object.freeze({ leaseId, changed, scratchCleared });
  };

  const resetProfile = async ({ closeBrowser } = {}) => {
    if (typeof closeBrowser !== 'function') fail('Profile reset requires browser shutdown');
    await closeBrowser();
    await initialize();
    await clearDirectory(profileDirectory, fsPromises);
    return Object.freeze({ reset: true });
  };

  const clearScratch = async () => {
    await initialize();
    await clearDirectory(scratchDirectory, fsPromises);
    return Object.freeze({ cleared: true });
  };

  return Object.freeze({
    initialize,
    prepareLease,
    resetProfile,
    clearScratch,
    paths: Object.freeze({ profileDirectory, scratchDirectory, statePath }),
  });
}
