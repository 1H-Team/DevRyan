import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertManagedQuotaCredential,
  canonicalizeManagedQuotaProviderId,
  deleteManagedQuotaCredential,
  getManagedQuotaCredentialPath,
  getManagedQuotaCredentialStatus,
  writeManagedQuotaCredential,
} from './quotaCredentials';

const originalDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = originalDataDirectory;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('VS Code managed quota credentials', () => {
  it('uses canonical providers and exact, injection-safe payload shapes', () => {
    expect(canonicalizeManagedQuotaProviderId('cursor')).toBe('cursor-acp');
    expect(() => canonicalizeManagedQuotaProviderId('../cursor')).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_PROVIDER' }),
    );
    expect(() => assertManagedQuotaCredential('cursor-acp', {
      sessionToken: 'dashboard',
      accessToken: 'oauth',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL' }));
    expect(() => assertManagedQuotaCredential('ollama-cloud', { cookie: 'bad\r\nheader' }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL' }));
  });

  it('writes private canonical files and returns safe status only', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-quota-'));
    temporaryDirectories.push(directory);
    process.env.OPENCHAMBER_DATA_DIR = directory;

    const status = writeManagedQuotaCredential('cursor', { sessionToken: 'never-return-this' });
    const target = getManagedQuotaCredentialPath('cursor-acp');
    expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(status).toEqual({ configured: true, credentialKind: 'dashboard', secretMasked: '••••••••' });
    expect(JSON.stringify(status)).not.toContain('never-return-this');
    deleteManagedQuotaCredential('cursor-acp');
    expect(getManagedQuotaCredentialStatus('cursor-acp')).toEqual({ configured: false });
  });
});
