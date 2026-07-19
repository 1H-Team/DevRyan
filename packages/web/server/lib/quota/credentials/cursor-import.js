import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { assertManagedQuotaCredential } from './providers.js';
import { QuotaCredentialError } from './store.js';

const CURSOR_ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const CURSOR_REFRESH_TOKEN_KEY = 'cursorAuth/refreshToken';
const TOKEN_QUERY = [
  'SELECT key, value FROM ItemTable',
  `WHERE key IN ('${CURSOR_ACCESS_TOKEN_KEY}', '${CURSOR_REFRESH_TOKEN_KEY}')`,
  'ORDER BY key;',
].join(' ');

export const getCursorStateDatabasePath = ({ homedir = os.homedir, pathImpl = path } = {}) =>
  pathImpl.join(
    homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  );

export const importCursorManagedCredential = ({
  platform = process.platform,
  homedir = os.homedir,
  pathImpl = path,
  execFile = execFileSync,
} = {}) => {
  if (platform !== 'darwin') {
    throw new QuotaCredentialError('IMPORT_UNAVAILABLE', 'Cursor import is available on macOS only');
  }

  try {
    const databasePath = getCursorStateDatabasePath({ homedir, pathImpl });
    const output = execFile('sqlite3', ['-json', databasePath, TOKEN_QUERY], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = JSON.parse(typeof output === 'string' ? output : String(output));
    if (!Array.isArray(rows)) {
      throw new Error('Invalid Cursor credential response');
    }

    const values = new Map();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      if (row.key !== CURSOR_ACCESS_TOKEN_KEY && row.key !== CURSOR_REFRESH_TOKEN_KEY) continue;
      if (typeof row.value === 'string') values.set(row.key, row.value);
    }

    return assertManagedQuotaCredential('cursor-acp', {
      accessToken: values.get(CURSOR_ACCESS_TOKEN_KEY),
      refreshToken: values.get(CURSOR_REFRESH_TOKEN_KEY),
    }).credential;
  } catch (error) {
    if (error instanceof QuotaCredentialError) throw error;
    throw new QuotaCredentialError('IMPORT_UNAVAILABLE', 'Cursor credentials could not be imported');
  }
};
