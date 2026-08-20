import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');
const GOOGLE_PROVIDER_ID = 'google';
const GOOGLE_AUTH_ALIASES = [GOOGLE_PROVIDER_ID, 'google.oauth'] as const;

const getOpenCodeConfigDirectory = (): string => (
  typeof process.env.OPENCODE_CONFIG_DIR === 'string' && process.env.OPENCODE_CONFIG_DIR.trim()
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(os.homedir(), '.config', 'opencode')
);

const getAntigravityAccountsPaths = (): string[] => Array.from(new Set([
  path.join(getOpenCodeConfigDirectory(), 'antigravity-accounts.json'),
  path.join(os.homedir(), '.config', 'opencode', 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json'),
]));

export type AuthEntry = Record<string, unknown>;
export type AuthFile = Record<string, AuthEntry>;

export const readAuthFile = (): AuthFile => {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed) as AuthFile;
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
};

export const writeAuthFile = (auth: Record<string, AuthEntry | string>): void => {
  try {
    if (!fs.existsSync(OPENCODE_DATA_DIR)) {
      fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(AUTH_FILE)) {
      const backupFile = `${AUTH_FILE}.openchamber.backup`;
      fs.copyFileSync(AUTH_FILE, backupFile);
    }

    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write auth file:', error);
    throw new Error('Failed to write OpenCode auth configuration');
  }
};

export const removeProviderAuth = (providerId: string): boolean => {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const auth = readAuthFile();

  if (!auth[providerId]) {
    return false;
  }

  delete auth[providerId];
  writeAuthFile(auth);
  return true;
};

export const getProviderAuthLookupIds = (providerId: string): string[] => (
  providerId.trim().toLowerCase() === GOOGLE_PROVIDER_ID
    ? [...GOOGLE_AUTH_ALIASES]
    : [providerId]
);

export const removeProviderAuthForLookupIds = (providerId: string): boolean => {
  let removed = false;
  for (const lookupId of getProviderAuthLookupIds(providerId)) {
    removed = removeProviderAuth(lookupId) || removed;
  }
  return removed;
};

export const getAntigravityAccountsSource = (): { exists: boolean; path: string | null } => {
  for (const filePath of getAntigravityAccountsPaths()) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { accounts?: unknown };
      if (Array.isArray(data.accounts) && data.accounts.length > 0) {
        return { exists: true, path: filePath };
      }
    } catch {
      // Missing and malformed files are not active credential sources.
    }
  }
  return { exists: false, path: null };
};

export const removeAntigravityAccounts = (): boolean => {
  let removed = false;
  for (const filePath of getAntigravityAccountsPaths()) {
    if (!fs.existsSync(filePath)) continue;
    fs.unlinkSync(filePath);
    removed = true;
  }
  return removed;
};

export const getProviderAuth = (providerId: string): AuthEntry | null => {
  const auth = readAuthFile();
  return auth[providerId] || null;
};

export const listProviderAuths = (): string[] => {
  const auth = readAuthFile();
  return Object.keys(auth);
};

export { AUTH_FILE, OPENCODE_DATA_DIR };
