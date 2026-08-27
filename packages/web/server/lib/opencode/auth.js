import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_PROVIDER_AUTH_BYTES = 256 * 1024;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const validateProviderId = (providerId) => {
  const normalized = typeof providerId === 'string' ? providerId.trim() : '';
  if (!PROVIDER_ID_PATTERN.test(normalized)) throw new Error('Provider ID is invalid');
  return normalized;
};

const cloneJson = (value) => {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_PROVIDER_AUTH_BYTES) {
      throw new Error('Provider auth record is invalid');
    }
    return JSON.parse(encoded);
  } catch {
    throw new Error('Provider auth record is invalid');
  }
};

const parseAuthContents = (content) => {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_AUTH_FILE_BYTES) {
    throw new Error('OpenCode auth configuration is invalid');
  }
  const trimmed = content.trim();
  if (!trimmed) return {};
  const auth = JSON.parse(trimmed);
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('OpenCode auth configuration is invalid');
  }
  return auth;
};

function readAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    return parseAuthContents(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
}

function writeAuthFile(auth) {
  let temporaryFile = null;
  try {
    if (!fs.existsSync(OPENCODE_DATA_DIR)) {
      fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(AUTH_FILE)) {
      const backupFile = `${AUTH_FILE}.openchamber.backup`;
      fs.copyFileSync(AUTH_FILE, backupFile);
      console.log(`Created auth backup: ${backupFile}`);
    }

    temporaryFile = `${AUTH_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(auth, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryFile, AUTH_FILE);
    temporaryFile = null;
    console.log('Successfully wrote auth file');
  } catch (error) {
    console.error('Failed to write auth file:', error);
    throw new Error('Failed to write OpenCode auth configuration');
  } finally {
    if (temporaryFile) {
      try { fs.unlinkSync(temporaryFile); } catch {}
    }
  }
}

function mutateAuthFile(mutator) {
  if (typeof mutator !== 'function') throw new Error('Auth mutator is required');
  const latest = readAuthFile();
  const result = mutator(latest);
  if (result === false) return false;
  writeAuthFile(result && typeof result === 'object' ? result : latest);
  return true;
}

function removeProviderAuth(providerId) {
  const normalizedProviderId = validateProviderId(providerId);

  const auth = readAuthFile();
  
  if (!auth[normalizedProviderId]) {
    console.log(`Provider ${normalizedProviderId} not found in auth file, nothing to remove`);
    return false;
  }

  delete auth[normalizedProviderId];
  writeAuthFile(auth);
  console.log(`Removed provider auth: ${normalizedProviderId}`);
  return true;
}

function getProviderAuth(providerId) {
  const normalizedProviderId = validateProviderId(providerId);
  const auth = readAuthFile();
  return Object.hasOwn(auth, normalizedProviderId) ? cloneJson(auth[normalizedProviderId]) : null;
}

function listProviderAuths() {
  const auth = readAuthFile();
  return Object.keys(auth);
}

function readProviderAuthRecord(providerId, {
  authFile = AUTH_FILE,
  fsModule = fs,
} = {}) {
  const normalizedProviderId = validateProviderId(providerId);
  if (typeof authFile !== 'string' || !path.isAbsolute(authFile)
    || !fsModule || typeof fsModule.readFileSync !== 'function') {
    throw new Error('Provider auth reader is invalid');
  }
  let content;
  try {
    content = fsModule.readFileSync(authFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Failed to read OpenCode auth configuration');
  }
  let auth;
  try {
    auth = parseAuthContents(content);
  } catch {
    throw new Error('Failed to read OpenCode auth configuration');
  }
  if (!Object.hasOwn(auth, normalizedProviderId)) return null;
  return cloneJson(auth[normalizedProviderId]);
}

async function writeScopedProviderAuthRecord({
  directory,
  providerId,
  record,
  fsPromises = fs.promises,
} = {}) {
  const normalizedProviderId = validateProviderId(providerId);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
    || !fsPromises || typeof fsPromises.open !== 'function') {
    throw new Error('Scoped provider auth writer is invalid');
  }
  const clonedRecord = cloneJson(record);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fsPromises.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Scoped provider auth directory is invalid');
  }
  await fsPromises.chmod(directory, 0o700);
  const authFile = path.join(directory, 'auth.json');
  const temporaryFile = path.join(
    directory,
    `.auth-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await fsPromises.open(temporaryFile, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ [normalizedProviderId]: clonedRecord })}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryFile, authFile);
    await fsPromises.chmod(authFile, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporaryFile).catch(() => undefined);
  }
  return Object.freeze({ directory, authFile, providerId: normalizedProviderId });
}

async function readScopedProviderAuthRecord({
  directory,
  providerId,
  fsPromises = fs.promises,
} = {}) {
  const normalizedProviderId = validateProviderId(providerId);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
    || !fsPromises || typeof fsPromises.readFile !== 'function') {
    throw new Error('Scoped provider auth reader is invalid');
  }
  let content;
  try {
    content = await fsPromises.readFile(path.join(directory, 'auth.json'), 'utf8');
  } catch {
    throw new Error('Failed to read scoped OpenCode auth configuration');
  }
  let auth;
  try {
    auth = parseAuthContents(content);
  } catch {
    throw new Error('Failed to read scoped OpenCode auth configuration');
  }
  if (Object.keys(auth).length !== 1 || !Object.hasOwn(auth, normalizedProviderId)) {
    throw new Error('Scoped OpenCode auth configuration contains another provider');
  }
  return cloneJson(auth[normalizedProviderId]);
}

export {
  readAuthFile,
  writeAuthFile,
  mutateAuthFile,
  removeProviderAuth,
  getProviderAuth,
  listProviderAuths,
  readProviderAuthRecord,
  writeScopedProviderAuthRecord,
  readScopedProviderAuthRecord,
  AUTH_FILE,
  OPENCODE_DATA_DIR
};
