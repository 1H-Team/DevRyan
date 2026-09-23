import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertManagedQuotaCredential,
  deleteManagedQuotaCredential,
  getManagedQuotaCredentialStatus,
  hasLegacyOpenCodeZenCredential,
  readManagedQuotaCredential,
  writeManagedQuotaCredential,
} from './providers.js';
import {
  QuotaCredentialError,
  canonicalizeManagedQuotaProviderId,
  getQuotaCredentialPath,
} from './store.js';

const tempDirectories = [];
const zenCredential = {
  orgId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y',
  accessToken: 'sess_do-not-return-me',
  refreshToken: 'rt_do-not-return-me',
  accessTokenExpiresAt: 1_789_000_000_000,
};
const makeOptions = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-quota-'));
  tempDirectories.push(directory);
  return { env: { OPENCHAMBER_DATA_DIR: directory } };
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed quota credentials', () => {
  it('canonicalizes the Cursor API alias and rejects traversal or unknown providers', () => {
    expect(canonicalizeManagedQuotaProviderId('cursor')).toBe('cursor-acp');
    expect(() => canonicalizeManagedQuotaProviderId('../cursor-acp')).toThrowError(QuotaCredentialError);
    expect(() => canonicalizeManagedQuotaProviderId('claude')).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_PROVIDER' }),
    );
  });

  it('normalizes exact active provider shapes and rejects the retired OpenCode Go manual form', () => {
    expect(() => assertManagedQuotaCredential('opencode-go', {
      workspaceId: 'wrk_example1',
      authCookie: 'auth=secret',
    })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PROVIDER' }));
    expect(assertManagedQuotaCredential('opencode', zenCredential).credential).toEqual(zenCredential);
    for (const invalid of [
      { workspaceId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y', authCookie: 'retired-dashboard-cookie' },
      { ...zenCredential, accessToken: 'first second' },
      { ...zenCredential, refreshToken: '' },
      { ...zenCredential, orgId: 'workspace' },
      { ...zenCredential, accessTokenExpiresAt: '1789000000000' },
      { ...zenCredential, extra: true },
    ]) {
      expect(() => assertManagedQuotaCredential('opencode', invalid))
        .toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL' }));
    }
    expect(assertManagedQuotaCredential('cursor', { accessToken: 'access', refreshToken: 'refresh' }).credential)
      .toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    expect(() => assertManagedQuotaCredential('cursor-acp', {
      sessionToken: 'dashboard',
      accessToken: 'oauth',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL' }));
    expect(() => assertManagedQuotaCredential('ollama-cloud', { cookie: 'bad\r\nInjected: yes' }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL' }));
    expect(() => assertManagedQuotaCredential('ollama-cloud', { cookie: 'ok', ambiguous: true }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL' }));
  });

  it('writes atomically with private directory and file permissions and safe status only', () => {
    const options = makeOptions();
    const status = writeManagedQuotaCredential('cursor', { sessionToken: 'do-not-return-me' }, options);
    const credentialPath = getQuotaCredentialPath('cursor-acp', options);

    expect(fs.statSync(path.dirname(credentialPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(readManagedQuotaCredential('cursor-acp', options)).toEqual({ sessionToken: 'do-not-return-me' });
    expect(status).toEqual({
      configured: true,
      credentialKind: 'dashboard',
      secretMasked: '••••••••',
    });
    expect(JSON.stringify(status)).not.toContain('do-not-return-me');
    expect(fs.readdirSync(path.dirname(credentialPath))).toEqual(['cursor-acp.json']);

    deleteManagedQuotaCredential('cursor', options);
    expect(getManagedQuotaCredentialStatus('cursor-acp', options)).toEqual({ configured: false });
  });

  it('stores OpenCode Console tokens and returns only the workspace ID', () => {
    const options = makeOptions();
    const status = writeManagedQuotaCredential('opencode', zenCredential, options);
    expect(status).toEqual({
      configured: true,
      credentialKind: 'oauth',
      workspaceId: zenCredential.orgId,
      secretMasked: '••••••••',
    });
    expect(JSON.stringify(status)).not.toContain(zenCredential.accessToken);
    expect(JSON.stringify(status)).not.toContain(zenCredential.refreshToken);
  });

  it('asks retired OpenCode Zen dashboard credentials to reconnect without reading them as usable', () => {
    const options = makeOptions();
    const credentialPath = getQuotaCredentialPath('opencode', options);
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(credentialPath, JSON.stringify({
      workspaceId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y',
      authCookie: 'retired-dashboard-cookie',
    }), { mode: 0o600 });

    expect(readManagedQuotaCredential('opencode', options)).toBeNull();
    expect(hasLegacyOpenCodeZenCredential(options)).toBe(true);
    expect(getManagedQuotaCredentialStatus('opencode', options)).toEqual({ configured: false, reconnectRequired: true });

    deleteManagedQuotaCredential('opencode', options);
    expect(getManagedQuotaCredentialStatus('opencode', options)).toEqual({ configured: false });
  });

  it('cleans the exact temporary file after an atomic rename failure', () => {
    const options = makeOptions();
    const fsImpl = {
      ...fs,
      renameSync: () => {
        const error = new Error('rename failed');
        error.code = 'EACCES';
        throw error;
      },
    };

    expect(() => writeManagedQuotaCredential(
      'ollama-cloud',
      { cookie: 'secret' },
      { ...options, fsImpl, randomUUID: () => 'fixed' },
    )).toThrow('rename failed');
    expect(fs.readdirSync(path.join(options.env.OPENCHAMBER_DATA_DIR, 'quota'))).toEqual([]);
  });
});
