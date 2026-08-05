import fs from 'fs';
import path from 'path';
import os from 'os';
import { getRequestPrincipal } from '../multi-user/request-context.js';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const STORAGE_DIR = OPENCHAMBER_DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'github-auth.json');
const STORAGE_LOCK_DIR = path.join(STORAGE_DIR, '.github-auth.lock');
const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');

const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lizomPOC3eFYo56r';
const DEFAULT_GITHUB_SCOPES = 'repo read:org workflow read:user user:email';

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(STORAGE_DIR, 0o700); } catch { /* best-effort */ }
}

const lockSleepArray = new Int32Array(new SharedArrayBuffer(4));

function withAuthFileLock(callback) {
  ensureStorageDir();
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      fs.mkdirSync(STORAGE_LOCK_DIR, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(STORAGE_LOCK_DIR).mtimeMs;
        if (age > 30_000) {
          fs.rmSync(STORAGE_LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch { /* retry */ }
      if (Date.now() >= deadline) throw new Error('Timed out acquiring GitHub auth storage lock');
      Atomics.wait(lockSleepArray, 0, 0, 10);
    }
  }
  try {
    return callback();
  } finally {
    try { fs.rmdirSync(STORAGE_LOCK_DIR); } catch { /* stale-lock recovery handles this */ }
  }
}

function readJsonFile() {
  ensureStorageDir();
  if (!fs.existsSync(STORAGE_FILE)) {
    return null;
  }
  try {
    try { fs.chmodSync(STORAGE_FILE, 0o600); } catch { /* best-effort */ }
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('Failed to read GitHub auth file:', error);
    return null;
  }
}

function writeJsonFile(payload) {
  ensureStorageDir();

  // Atomic write so multiple OpenChamber instances can safely share the same file.
  const tmpFile = `${STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }

  fs.renameSync(tmpFile, STORAGE_FILE);
  try {
    fs.chmodSync(STORAGE_FILE, 0o600);
  } catch {
    // best-effort
  }
}

function resolveAccountId({ user, accessToken, accountId }) {
  if (typeof accountId === 'string' && accountId.trim()) {
    return accountId.trim();
  }
  if (user && typeof user.login === 'string' && user.login.trim()) {
    return user.login.trim();
  }
  if (user && typeof user.id === 'number') {
    return String(user.id);
  }
  if (typeof accessToken === 'string' && accessToken.trim()) {
    return `token:${accessToken.slice(0, 8)}`;
  }
  return '';
}

function normalizeAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const accessToken = typeof entry.accessToken === 'string' ? entry.accessToken : '';
  if (!accessToken) return null;
  const user = entry.user && typeof entry.user === 'object'
    ? {
      login: typeof entry.user.login === 'string' ? entry.user.login : null,
      avatarUrl: typeof entry.user.avatarUrl === 'string' ? entry.user.avatarUrl : null,
      id: typeof entry.user.id === 'number' ? entry.user.id : null,
      name: typeof entry.user.name === 'string' ? entry.user.name : null,
      email: typeof entry.user.email === 'string' ? entry.user.email : null,
    }
    : null;

  const accountId = resolveAccountId({
    user,
    accessToken,
    accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
  });

  return {
    accessToken,
    scope: typeof entry.scope === 'string' ? entry.scope : '',
    tokenType: typeof entry.tokenType === 'string' ? entry.tokenType : 'bearer',
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
    user,
    current: Boolean(entry.current),
    accountId,
  };
}

function normalizeAuthList(raw) {
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((entry) => normalizeAuthEntry(entry))
    .filter(Boolean);

  if (!list.length) {
    return { list: [], changed: false };
  }

  let changed = false;
  let currentFound = false;
  list.forEach((entry) => {
    if (entry.current && !currentFound) {
      currentFound = true;
    } else if (entry.current && currentFound) {
      entry.current = false;
      changed = true;
    }
  });

  if (!currentFound && list[0]) {
    list[0].current = true;
    changed = true;
  }

  list.forEach((entry) => {
    if (!entry.accountId) {
      entry.accountId = resolveAccountId(entry);
      changed = true;
    }
  });

  return { list, changed };
}

function readAuthList() {
  const data = readJsonFile();
  if (!data) {
    return [];
  }
  const { list } = normalizeAuthList(data);
  return list;
}

function writeAuthList(list) {
  writeJsonFile(list);
}

export function getGitHubAuth() {
  const principal = getRequestPrincipal();
  if (principal?.scope === 'managed') {
    const accountId = principal.githubAccountId || null;
    if (!accountId) return null;
    const entry = readAuthList().find((candidate) => candidate.accountId === accountId);
    return entry?.accessToken ? entry : null;
  }
  const list = readAuthList();
  if (!list.length) {
    return null;
  }
  const current = list.find((entry) => entry.current) || list[0];
  if (!current?.accessToken) {
    return null;
  }
  return current;
}

export function getGitHubAuthById(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) return null;
  const entry = readAuthList().find((candidate) => candidate.accountId === accountId.trim());
  return entry?.accessToken ? entry : null;
}

export function getGitHubAuthAccounts() {
  const principal = getRequestPrincipal();
  const assignedAccountId = principal?.scope === 'managed'
    ? principal.githubAccountId || null
    : null;
  const list = assignedAccountId
    ? readAuthList().filter((entry) => entry.accountId === assignedAccountId)
    : principal?.scope === 'managed' ? [] : readAuthList();
  return publicAuthAccounts(list);
}

export function getAllGitHubAuthAccounts() {
  return publicAuthAccounts(readAuthList());
}

function publicAuthAccounts(list) {
  return list
    .filter((entry) => entry?.user && entry.accountId)
    .map((entry) => ({
      id: entry.accountId,
      user: entry.user,
      scope: entry.scope || '',
      current: Boolean(entry.current),
    }));
}

export function setGitHubAuth({ accessToken, scope, tokenType, user, accountId, makeCurrent = false }) {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('accessToken is required');
  }
  const normalizedUser = user && typeof user === 'object'
    ? {
      login: typeof user.login === 'string' ? user.login : undefined,
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : undefined,
      id: typeof user.id === 'number' ? user.id : undefined,
      name: typeof user.name === 'string' ? user.name : undefined,
      email: typeof user.email === 'string' ? user.email : undefined,
    }
    : undefined;

  const resolvedAccountId = resolveAccountId({
    user: normalizedUser,
    accessToken,
    accountId,
  });

  return withAuthFileLock(() => {
    const list = readAuthList();
    const existingIndex = list.findIndex((entry) => entry.accountId === resolvedAccountId);
    const existingCurrent = list.find((entry) => entry.current)?.accountId || null;
    const shouldBecomeCurrent = makeCurrent === true || !existingCurrent;
    const nextEntry = {
      accessToken,
      scope: typeof scope === 'string' ? scope : '',
      tokenType: typeof tokenType === 'string' ? tokenType : 'bearer',
      createdAt: Date.now(),
      user: normalizedUser || null,
      current: shouldBecomeCurrent,
      accountId: resolvedAccountId,
    };
    if (existingIndex >= 0) list[existingIndex] = nextEntry;
    else list.push(nextEntry);
    list.forEach((entry) => {
      if (entry.accountId !== resolvedAccountId && shouldBecomeCurrent) entry.current = false;
      if (!shouldBecomeCurrent) entry.current = entry.accountId === existingCurrent;
    });
    writeAuthList(list);
    return nextEntry;
  });
}

export function activateGitHubAuth(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return false;
  }
  return withAuthFileLock(() => {
    const list = readAuthList();
    const index = list.findIndex((entry) => entry.accountId === accountId.trim());
    if (index === -1) return false;
    list.forEach((entry, idx) => { entry.current = idx === index; });
    writeAuthList(list);
    return true;
  });
}

export function clearGitHubAuth(accountId) {
  try {
    const principal = getRequestPrincipal();
    if (principal?.scope === 'managed') return false;
    const requestedAccountId = typeof accountId === 'string' && accountId.trim()
      ? accountId.trim()
      : readAuthList().find((entry) => entry.current)?.accountId;
    return requestedAccountId ? clearGitHubAuthById(requestedAccountId) : true;
  } catch (error) {
    console.error('Failed to clear GitHub auth file:', error);
    return false;
  }
}

export function clearGitHubAuthById(accountId) {
  const requestedAccountId = typeof accountId === 'string' ? accountId.trim() : '';
  if (!requestedAccountId) return false;
  return withAuthFileLock(() => {
    const list = readAuthList();
    const remaining = list.filter((entry) => entry.accountId !== requestedAccountId);
    if (remaining.length === list.length) return false;
    if (!remaining.length) {
      if (fs.existsSync(STORAGE_FILE)) fs.unlinkSync(STORAGE_FILE);
      return true;
    }
    const hasCurrent = remaining.some((entry) => entry.current);
    remaining.forEach((entry, index) => { entry.current = hasCurrent ? entry.current : index === 0; });
    writeAuthList(remaining);
    return true;
  });
}

export function getGitHubClientId() {
  const raw = process.env.OPENCHAMBER_GITHUB_CLIENT_ID;
  const clientId = typeof raw === 'string' ? raw.trim() : '';
  if (clientId) return clientId;

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const stored = typeof parsed?.githubClientId === 'string' ? parsed.githubClientId.trim() : '';
      if (stored) return stored;
    }
  } catch {
    // ignore
  }

  return DEFAULT_GITHUB_CLIENT_ID;
}

export function getGitHubScopes() {
  const raw = process.env.OPENCHAMBER_GITHUB_SCOPES;
  const fromEnv = typeof raw === 'string' ? raw.trim() : '';
  if (fromEnv) return fromEnv;

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const stored = typeof parsed?.githubScopes === 'string' ? parsed.githubScopes.trim() : '';
      if (stored) return stored;
    }
  } catch {
    // ignore
  }

  return DEFAULT_GITHUB_SCOPES;
}

export const GITHUB_AUTH_FILE = STORAGE_FILE;

export function isGhCliDisabled() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return Boolean(parsed?.ghCliDisabled);
    }
  } catch {
    // ignore
  }
  return false;
}

export function setGhCliDisabled(disabled) {
  ensureStorageDir();
  let settings = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
    }
  } catch {
    // ignore
  }
  settings.ghCliDisabled = Boolean(disabled);
  const tmpFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(settings, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, SETTINGS_FILE);
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch {
    // best-effort
  }
}
