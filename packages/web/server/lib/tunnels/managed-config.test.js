import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManagedTunnelConfigRuntime } from './managed-config.js';
import { normalizeManagedRemoteTunnelToken } from './managed-token.js';

const TOKEN = `eyJ${'a'.repeat(80)}`;

const createRuntime = (initialFiles = []) => {
  const files = new Map(initialFiles);
  const fsPromises = {
    mkdir: async () => {},
    readFile: async (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error('File not found');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    writeFile: async (filePath, contents) => {
      files.set(filePath, contents);
    },
  };
  const configPath = '/config/cloudflare-managed-remote-tunnels.json';
  const legacyConfigPath = '/config/cloudflare-named-tunnels.json';
  const runtime = createManagedTunnelConfigRuntime({
    fsPromises,
    path,
    normalizeManagedRemoteTunnelHostname: (value) => value.trim().toLowerCase(),
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelToken,
    constants: {
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: configPath,
      CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: legacyConfigPath,
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
    },
  });

  return { configPath, files, legacyConfigPath, runtime };
};

describe('createManagedTunnelConfigRuntime', () => {
  it('persists only the normalized token from a cloudflared command', async () => {
    const { configPath, files, runtime } = createRuntime();

    await runtime.upsertManagedRemoteTunnelToken({
      id: 'tunnel-id',
      name: 'Tunnel',
      hostname: 'example.com',
      token: `cloudflared tunnel run --token ${TOKEN}`,
    });

    const persisted = files.get(configPath);
    expect(JSON.parse(persisted).tunnels[0].token).toBe(TOKEN);
    expect(persisted).not.toContain('cloudflared');
  });

  it('normalizes valid legacy tokens and excludes invalid tokens during migration rewrite', async () => {
    const legacyConfigPath = '/config/cloudflare-named-tunnels.json';
    const legacyConfig = JSON.stringify({
      tunnels: [
        { id: 'valid', name: 'Valid', hostname: 'valid.example.com', token: `cloudflared tunnel run --token ${TOKEN}` },
        { id: 'invalid', name: 'Invalid', hostname: 'invalid.example.com', token: 'invalid legacy secret' },
      ],
    });
    const { configPath, files, runtime } = createRuntime([[legacyConfigPath, legacyConfig]]);

    await runtime.readManagedRemoteTunnelConfigFromDisk();

    const persisted = files.get(configPath);
    expect(JSON.parse(persisted).tunnels).toEqual([
      expect.objectContaining({ id: 'valid', token: TOKEN }),
    ]);
    expect(persisted).not.toContain('cloudflared');
    expect(persisted).not.toContain('invalid legacy secret');
  });
});
