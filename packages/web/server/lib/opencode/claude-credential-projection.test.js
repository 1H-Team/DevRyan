import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CREDENTIALS_EXPIRED,
  CLAUDE_CREDENTIALS_MISSING,
  CLAUDE_CREDENTIALS_UNREADABLE,
  claudeKeychainService,
  prepareClaudeTransportEnvironment,
  readClaudeAccessToken,
} from './claude-credential-projection.js';

const NOW = 1_790_500_000_000;
const TOKEN = 'fixture-access-token';
const REFRESH = 'fixture-refresh-token';
const home = '/Users/fixture';
const account = path.join(home, '.claude');
const credentials = (expiresAt = NOW + 3_600_000) => JSON.stringify({
  claudeAiOauth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt, scopes: ['user:inference'] },
});
const missingFile = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
const keychainMiss = () => Promise.reject(Object.assign(new Error('The specified item could not be found'), { code: 44 }));
const read = (options) => readClaudeAccessToken({ account, home, username: 'fixture', now: NOW, platform: 'darwin', ...options });

const roots = [];
const stateFixture = () => {
  const cache = path.resolve(import.meta.dirname, '../../../../../.cache/qa');
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'claude-credential-projection-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude credential projection for the confined transport', () => {
  it('names the keychain item exactly as Claude Code and Meridian do', () => {
    expect(claudeKeychainService(account, home)).toBe('Claude Code-credentials');
    expect(claudeKeychainService(`${account}/`, home)).toBe('Claude Code-credentials');
    const custom = '/Users/fixture/profiles/work';
    const suffix = crypto.createHash('sha256').update(custom).digest('hex').slice(0, 8);
    expect(claudeKeychainService(custom, home)).toBe(`Claude Code-credentials-${suffix}`);
  });

  it('reads the macOS keychain login as JSON or hex-encoded JSON', async () => {
    const execFile = vi.fn(async () => `${credentials()}\n`);
    await expect(read({ execFile, readFile: missingFile })).resolves.toEqual({ token: TOKEN });
    expect(execFile).toHaveBeenCalledWith('/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'fixture', '-w'],
      expect.objectContaining({ timeout: 5000 }));

    const hex = vi.fn(async () => Buffer.from(credentials(), 'utf8').toString('hex'));
    await expect(read({ execFile: hex, readFile: missingFile })).resolves.toEqual({ token: TOKEN });
  });

  it('falls back to the credential file and never uses the keychain elsewhere', async () => {
    const readFile = vi.fn(async () => credentials());
    await expect(read({ execFile: keychainMiss, readFile })).resolves.toEqual({ token: TOKEN });
    expect(readFile).toHaveBeenCalledWith(path.join(account, '.credentials.json'), 'utf8');

    const execFile = vi.fn(keychainMiss);
    await expect(read({ platform: 'linux', execFile, readFile })).resolves.toEqual({ token: TOKEN });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports bounded reasons for missing, unreadable and expiring logins', async () => {
    await expect(read({ execFile: keychainMiss, readFile: missingFile })).resolves.toEqual({ reason: CLAUDE_CREDENTIALS_MISSING });
    await expect(read({ execFile: keychainMiss, readFile: async () => '{not json' })).resolves.toEqual({ reason: CLAUDE_CREDENTIALS_UNREADABLE });
    await expect(read({ execFile: keychainMiss, readFile: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) }))
      .resolves.toEqual({ reason: CLAUDE_CREDENTIALS_UNREADABLE });
    await expect(read({ execFile: async () => JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 3_600_000 } }), readFile: missingFile }))
      .resolves.toEqual({ reason: CLAUDE_CREDENTIALS_UNREADABLE });
    // Inside the one-minute margin the transport would outlive its token.
    await expect(read({ execFile: async () => credentials(NOW + 30_000), readFile: missingFile }))
      .resolves.toEqual({ reason: CLAUDE_CREDENTIALS_EXPIRED });
  });

  it('projects only the access token and keeps a caller-supplied one', async () => {
    const state = stateFixture();
    const input = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: state };
    const projected = await prepareClaudeTransportEnvironment({ env: input, account, state, home, username: 'fixture', now: NOW,
      platform: 'darwin', execFile: async () => credentials(), readFile: missingFile });
    expect(projected).toEqual({ env: { ...input, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, unavailable: null });
    expect(input).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: state });
    expect(JSON.stringify(projected)).not.toContain(REFRESH);

    const execFile = vi.fn(async () => credentials());
    const supplied = { CLAUDE_CODE_OAUTH_TOKEN: 'caller-token' };
    await expect(prepareClaudeTransportEnvironment({ env: supplied, account, state, execFile, readFile: missingFile }))
      .resolves.toEqual({ env: supplied, unavailable: null });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('launches without a token when no login is available, naming only the reason', async () => {
    const state = stateFixture();
    const result = await prepareClaudeTransportEnvironment({ env: { PATH: '/usr/bin' }, account, state, home, username: 'fixture', now: NOW,
      platform: 'darwin', execFile: async () => credentials(NOW - 1), readFile: missingFile });
    expect(result).toEqual({ env: { PATH: '/usr/bin' }, unavailable: CLAUDE_CREDENTIALS_EXPIRED });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('removes the legacy credential link but never a regular file', async () => {
    const state = stateFixture();
    const link = path.join(state, '.credentials.json');
    fs.symlinkSync(path.join(state, 'account-credentials.json'), link);
    await prepareClaudeTransportEnvironment({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'caller-token' }, account, state });
    expect(fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })).toBeFalsy();

    fs.writeFileSync(link, '{}');
    await prepareClaudeTransportEnvironment({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'caller-token' }, account, state });
    expect(fs.readFileSync(link, 'utf8')).toBe('{}');
  });
});
