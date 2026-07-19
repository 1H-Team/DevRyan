import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES = 16 * 1024;
export type ManagedQuotaProviderId = 'opencode-go' | 'ollama-cloud' | 'cursor-acp';
export type OpenCodeGoCredential = { workspaceId: string; authCookie: string };
export type OllamaCloudCredential = { cookie: string };
export type CursorDashboardCredential = { sessionToken: string };
export type CursorOAuthCredential = { accessToken?: string; refreshToken?: string };
export type ManagedQuotaCredential =
  | OpenCodeGoCredential
  | OllamaCloudCredential
  | CursorDashboardCredential
  | CursorOAuthCredential;

const providers = new Set<ManagedQuotaProviderId>(['opencode-go', 'ollama-cloud', 'cursor-acp']);
const secretMask = '••••••••';
const workspaceIdPattern = /^wrk_[a-zA-Z0-9]+$/;

export class QuotaCredentialError extends Error {
  readonly code: 'UNSUPPORTED_PROVIDER' | 'INVALID_CREDENTIAL' | 'IMPORT_UNAVAILABLE';

  constructor(code: QuotaCredentialError['code'], message: string) {
    super(message);
    this.name = 'QuotaCredentialError';
    this.code = code;
  }
}

export const canonicalizeManagedQuotaProviderId = (providerId: unknown): ManagedQuotaProviderId => {
  const value = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  const canonical = value === 'cursor' ? 'cursor-acp' : value;
  if (!providers.has(canonical as ManagedQuotaProviderId)) {
    throw new QuotaCredentialError('UNSUPPORTED_PROVIDER', 'Unsupported credential provider');
  }
  return canonical as ManagedQuotaProviderId;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clean = (value: unknown): string => {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) return '';
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) return '';
  return trimmed;
};

const hasOnlyKeys = (record: Record<string, unknown>, allowed: string[]) => {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
};

export const normalizeManagedQuotaCredential = (
  providerId: unknown,
  value: unknown,
): ManagedQuotaCredential | null => {
  const provider = canonicalizeManagedQuotaProviderId(providerId);
  if (!isRecord(value)) return null;
  if (provider === 'opencode-go') {
    if (!hasOnlyKeys(value, ['workspaceId', 'authCookie'])) return null;
    const workspaceId = clean(value.workspaceId);
    let authCookie = clean(value.authCookie);
    if (authCookie.startsWith('auth=')) authCookie = authCookie.slice(5).trim();
    return workspaceIdPattern.test(workspaceId) && authCookie ? { workspaceId, authCookie } : null;
  }
  if (provider === 'ollama-cloud') {
    if (!hasOnlyKeys(value, ['cookie'])) return null;
    const cookie = clean(value.cookie);
    return cookie ? { cookie } : null;
  }
  if (!hasOnlyKeys(value, ['sessionToken', 'accessToken', 'refreshToken'])) return null;
  const sessionToken = clean(value.sessionToken);
  const accessToken = clean(value.accessToken);
  const refreshToken = clean(value.refreshToken);
  if (Boolean(sessionToken) === Boolean(accessToken || refreshToken)) return null;
  return sessionToken
    ? { sessionToken }
    : {
        ...(accessToken ? { accessToken } : {}),
        ...(refreshToken ? { refreshToken } : {}),
      };
};

export const assertManagedQuotaCredential = (providerId: unknown, value: unknown) => {
  const provider = canonicalizeManagedQuotaProviderId(providerId);
  const credential = normalizeManagedQuotaCredential(provider, value);
  if (!credential) throw new QuotaCredentialError('INVALID_CREDENTIAL', 'Invalid credential');
  return { provider, credential };
};

const credentialsDirectory = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'quota',
);

export const getManagedQuotaCredentialPath = (providerId: unknown) =>
  path.join(credentialsDirectory(), `${canonicalizeManagedQuotaProviderId(providerId)}.json`);

export const readManagedQuotaCredential = (providerId: unknown): ManagedQuotaCredential | null => {
  const provider = canonicalizeManagedQuotaProviderId(providerId);
  const target = getManagedQuotaCredentialPath(provider);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
      throw new Error('Invalid stored credential');
    }
    return normalizeManagedQuotaCredential(provider, JSON.parse(fs.readFileSync(target, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[quota-credentials] Managed credential could not be read');
    }
    return null;
  }
};

export const getManagedQuotaCredentialStatus = (providerId: unknown) => {
  const provider = canonicalizeManagedQuotaProviderId(providerId);
  const credential = readManagedQuotaCredential(provider);
  if (!credential) return { configured: false };
  if (provider === 'opencode-go') {
    return {
      configured: true,
      workspaceId: (credential as OpenCodeGoCredential).workspaceId,
      credentialKind: 'dashboard',
      secretMasked: secretMask,
    };
  }
  if (provider === 'cursor-acp') {
    const cursor = credential as CursorDashboardCredential & CursorOAuthCredential;
    const credentialKind = cursor.sessionToken ? 'dashboard' : 'oauth';
    return {
      configured: true,
      credentialKind,
      ...(credentialKind === 'oauth' ? { hasRefreshToken: Boolean(cursor.refreshToken) } : {}),
      secretMasked: secretMask,
    };
  }
  return { configured: true, credentialKind: 'cookie', secretMasked: secretMask };
};

export const writeManagedQuotaCredential = (providerId: unknown, value: unknown) => {
  const { provider, credential } = assertManagedQuotaCredential(providerId, value);
  const target = getManagedQuotaCredentialPath(provider);
  const directory = path.dirname(target);
  const serialized = `${JSON.stringify(credential, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
    throw new QuotaCredentialError('INVALID_CREDENTIAL', 'Credential is too large');
  }
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[quota-credentials] Temporary credential cleanup failed');
      }
    }
  }
  return getManagedQuotaCredentialStatus(provider);
};

export const deleteManagedQuotaCredential = (providerId: unknown) => {
  try {
    fs.unlinkSync(getManagedQuotaCredentialPath(providerId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const cursorTokenQuery = [
  'SELECT key, value FROM ItemTable',
  "WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/refreshToken')",
  'ORDER BY key;',
].join(' ');

export const importCursorManagedCredential = () => {
  if (process.platform !== 'darwin') {
    throw new QuotaCredentialError('IMPORT_UNAVAILABLE', 'Cursor import is available on macOS only');
  }
  try {
    const databasePath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    );
    const output = execFileSync('sqlite3', ['-json', databasePath, cursorTokenQuery], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = JSON.parse(output || '[]') as unknown;
    if (!Array.isArray(rows)) throw new Error('Invalid Cursor response');
    const values = new Map<string, string>();
    for (const row of rows) {
      if (!isRecord(row) || typeof row.key !== 'string' || typeof row.value !== 'string') continue;
      if (row.key === 'cursorAuth/accessToken' || row.key === 'cursorAuth/refreshToken') {
        values.set(row.key, row.value);
      }
    }
    return assertManagedQuotaCredential('cursor-acp', {
      accessToken: values.get('cursorAuth/accessToken'),
      refreshToken: values.get('cursorAuth/refreshToken'),
    }).credential;
  } catch (error) {
    if (error instanceof QuotaCredentialError) throw error;
    throw new QuotaCredentialError('IMPORT_UNAVAILABLE', 'Cursor credentials could not be imported');
  }
};
