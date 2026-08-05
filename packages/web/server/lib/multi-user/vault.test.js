import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionVault } from './vault.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('encrypted Supabase session vault', () => {
  it('stores tokens encrypted at rest with private file permissions', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-vault-'));
    temporaryDirectories.push(directory);
    const vault = await createSessionVault({ dataDirectory: directory });
    await vault.set('app-session', {
      accessToken: 'access-token-plaintext',
      refreshToken: 'refresh-token-plaintext',
      expiresAt: 1234,
      sessionTokenHash: 'hashed-app-session-token',
    });

    const encrypted = await fs.readFile(vault.paths.vaultPath, 'utf8');
    expect(encrypted).not.toContain('access-token-plaintext');
    expect(encrypted).not.toContain('refresh-token-plaintext');
    expect(encrypted).not.toContain('hashed-app-session-token');
    expect((await fs.stat(vault.paths.keyPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(vault.paths.vaultPath)).mode & 0o777).toBe(0o600);

    const reloaded = await createSessionVault({ dataDirectory: directory });
    expect(reloaded.get('app-session')).toEqual({
      accessToken: 'access-token-plaintext',
      refreshToken: 'refresh-token-plaintext',
      expiresAt: 1234,
      sessionTokenHash: 'hashed-app-session-token',
    });
    expect(reloaded.findByTokenHash('hashed-app-session-token')).toMatchObject({ sessionId: 'app-session' });
    expect(reloaded.findByTokenHash('unknown')).toBeNull();
  });
});
