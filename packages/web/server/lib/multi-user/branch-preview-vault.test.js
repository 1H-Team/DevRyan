import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBranchPreviewVault } from './branch-preview-vault.js';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('branch preview vault', () => {
  it('persists credentials encrypted and supports rotation cleanup', async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preview-vault-'));
    directories.push(dataDirectory);
    const vault = await createBranchPreviewVault({ dataDirectory });
    await vault.set('branch-preview:first', { clientId: 'client.access', clientSecret: 'super-secret' });

    const encrypted = await fs.readFile(vault.paths.vaultPath, 'utf8');
    expect(encrypted).not.toContain('client.access');
    expect(encrypted).not.toContain('super-secret');
    expect(vault.get('branch-preview:first')).toEqual({
      clientId: 'client.access',
      clientSecret: 'super-secret',
    });

    const reopened = await createBranchPreviewVault({ dataDirectory });
    expect(reopened.get('branch-preview:first')?.clientSecret).toBe('super-secret');
    await reopened.delete('branch-preview:first');
    expect(reopened.get('branch-preview:first')).toBeNull();
  });
});
