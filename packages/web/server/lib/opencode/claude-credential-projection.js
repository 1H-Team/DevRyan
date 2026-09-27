import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Ships unpacked beside session-provider-worker.mjs: Node built-ins only.

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const EXPIRY_MARGIN_MS = 60_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;

export const CLAUDE_CREDENTIALS_MISSING = 'claude_credentials_missing';
export const CLAUDE_CREDENTIALS_UNREADABLE = 'claude_credentials_unreadable';
export const CLAUDE_CREDENTIALS_EXPIRED = 'claude_credentials_expired';

/** Mirrors Meridian 1.62.6 configDirToKeychainService, so the projected token
 * is the one Meridian keeps fresh on the host before every request. */
export const claudeKeychainService = (account, home = os.homedir()) => {
  const absolute = path.resolve(account);
  if (absolute === path.resolve(home, '.claude')) return KEYCHAIN_SERVICE;
  return `${KEYCHAIN_SERVICE}-${createHash('sha256').update(absolute).digest('hex').slice(0, 8)}`;
};

const parseCredentials = (raw) => {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* Claude Code may hex-encode the value. */ }
  try { return JSON.parse(Buffer.from(trimmed, 'hex').toString('utf8')); } catch { return null; }
};

const defaultExecFile = (file, args, options) => new Promise((resolve, reject) => {
  execFileCallback(file, args, options, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

const defaultUsername = () => {
  try { return os.userInfo().username; } catch { return null; }
};

const readKeychainCredentials = async ({ account, home, username, execFile }) => {
  if (!username) return null;
  try {
    const stdout = await execFile('/usr/bin/security',
      ['find-generic-password', '-s', claudeKeychainService(account, home), '-a', username, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true });
    return parseCredentials(stdout);
  } catch {
    // Absent item, locked keychain or timeout: the file fallback decides.
    return null;
  }
};

/**
 * Reads the account's current Claude OAuth access token on the host. Returns
 * `{ token }` or `{ reason }`; the token is never logged or thrown.
 */
export async function readClaudeAccessToken({
  account,
  platform = process.platform,
  now = Date.now(),
  execFile = defaultExecFile,
  readFile = fs.readFile,
  home = os.homedir(),
  username = defaultUsername(),
}) {
  let credentials = platform === 'darwin' ? await readKeychainCredentials({ account, home, username, execFile }) : null;
  if (!credentials?.claudeAiOauth) {
    try {
      credentials = parseCredentials(await readFile(path.join(account, '.credentials.json'), 'utf8'));
    } catch (cause) {
      return { reason: cause?.code === 'ENOENT' ? CLAUDE_CREDENTIALS_MISSING : CLAUDE_CREDENTIALS_UNREADABLE };
    }
    if (!credentials) return { reason: CLAUDE_CREDENTIALS_UNREADABLE };
  }
  const oauth = credentials.claudeAiOauth;
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return { reason: CLAUDE_CREDENTIALS_UNREADABLE };
  if (!Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now + EXPIRY_MARGIN_MS) return { reason: CLAUDE_CREDENTIALS_EXPIRED };
  return { token: oauth.accessToken };
}

/**
 * The confined transport denies mach lookups (so no keychain) and gets its own
 * CLAUDE_CONFIG_DIR, so Claude Code cannot find the account's login there.
 * Project only the current access token; refresh stays with Meridian on the
 * host, and the sandbox never receives a refresh token it could rotate.
 */
export async function prepareClaudeTransportEnvironment({ env, account, state, lstat = fs.lstat, unlink = fs.unlink, ...readOptions }) {
  // Earlier releases linked the account's credential file into private state.
  const legacyLink = path.join(state, '.credentials.json');
  try {
    if ((await lstat(legacyLink)).isSymbolicLink()) await unlink(legacyLink);
  } catch { /* Absent, or already removed. */ }
  if (typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN) return { env: { ...env }, unavailable: null };
  const access = await readClaudeAccessToken({ account, ...readOptions });
  if (!access.token) return { env: { ...env }, unavailable: access.reason };
  return { env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: access.token }, unavailable: null };
}
