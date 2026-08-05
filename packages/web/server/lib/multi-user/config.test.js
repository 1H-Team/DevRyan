import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveMultiUserConfig } from './config.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('multi-user configuration', () => {
  it('preserves local-admin mode when Supabase is not configured', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-config-'));
    temporaryDirectories.push(directory);
    expect(resolveMultiUserConfig({ dataDirectory: directory, env: {} })).toMatchObject({ enabled: false });
  });

  it('loads a complete private fallback file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-config-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'supabase.json');
    await fs.writeFile(configPath, JSON.stringify({
      url: 'https://project.supabase.co/',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
    }), { mode: 0o600 });

    expect(resolveMultiUserConfig({ dataDirectory: directory, env: {} })).toMatchObject({
      enabled: true,
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_public',
      secretKey: 'sb_secret_private',
    });
  });

  it('rejects partial or group-readable configuration', async () => {
    const partialDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-config-'));
    const publicDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-config-'));
    temporaryDirectories.push(partialDirectory, publicDirectory);
    expect(() => resolveMultiUserConfig({
      dataDirectory: partialDirectory,
      env: { SUPABASE_URL: 'https://project.supabase.co' },
    })).toThrow('requires URL, publishable key, and secret key');
    await fs.writeFile(path.join(publicDirectory, 'supabase.json'), '{}', { mode: 0o644 });
    expect(() => resolveMultiUserConfig({ dataDirectory: publicDirectory, env: {} })).toThrow('chmod 600');
  });
});
