import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome;
let originalHome;

const writeJson = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const getMcpAuthPath = () => path.join(tempHome, '.local', 'share', 'opencode', 'mcp-auth.json');

const loadMcpModule = async () => {
  vi.resetModules();
  return import('./mcp.js');
};

describe('MCP config helpers', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-mcp-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('merges supported user MCP config and ignores home-folder ambient MCP config', async () => {
    const configDir = path.join(tempHome, '.config', 'opencode');
    const homeConfigDir = path.join(tempHome, '.opencode');
    writeJson(path.join(configDir, 'config.json'), {
      mcp: {
        legacy: { type: 'local', command: ['legacy-cli'] },
        shared: { type: 'local', command: ['legacy-shared'] },
      },
    });
    writeJson(path.join(configDir, 'opencode.json'), {
      mcp: {
        official: { type: 'remote', url: 'https://example.test/mcp' },
        shared: { type: 'local', command: ['official-shared'] },
      },
    });
    writeJson(path.join(homeConfigDir, 'opencode.json'), {
      mcp: {
        home: { type: 'remote', url: 'https://home.example.test/mcp' },
      },
    });

    const { listMcpConfigs } = await loadMcpModule();

    expect(listMcpConfigs().map((entry) => [entry.name, entry.type, entry.command, entry.url, entry.scope]).sort()).toEqual([
      ['legacy', 'local', ['legacy-cli'], undefined, 'user'],
      ['shared', 'local', ['official-shared'], undefined, 'user'],
      ['official', 'remote', undefined, 'https://example.test/mcp', 'user'],
    ].sort());
  });

  it('resolves only an exact, URL-bound MCP OAuth access token for server-side Bot import', async () => {
    writeJson(getMcpAuthPath(), {
      buffer: {
        serverUrl: 'https://mcp.buffer.com/mcp',
        tokens: { accessToken: 'oauth-secret', expiresAt: 2_000_000_000 },
      },
    });
    const { getMcpOAuthCredential } = await loadMcpModule();

    expect(getMcpOAuthCredential('buffer', 'https://mcp.buffer.com/mcp', 1_000)).toEqual({
      authorization: 'Bearer oauth-secret',
      expired: false,
    });
    expect(getMcpOAuthCredential('buffer', 'https://other.example/mcp', 1_000)).toBeNull();
    expect(getMcpOAuthCredential('missing', 'https://mcp.buffer.com/mcp', 1_000)).toBeNull();
  });

  it('marks an exact MCP OAuth credential expired without returning refresh material', async () => {
    writeJson(getMcpAuthPath(), {
      buffer: {
        serverUrl: 'https://mcp.buffer.com/mcp',
        tokens: {
          accessToken: 'expired-secret',
          refreshToken: 'must-not-be-returned',
          expiresAt: 1,
        },
      },
    });
    const { getMcpOAuthCredential } = await loadMcpModule();

    const credential = getMcpOAuthCredential('buffer', 'https://mcp.buffer.com/mcp', 2_000);
    expect(credential).toEqual({ authorization: 'Bearer expired-secret', expired: true });
    expect(JSON.stringify(credential)).not.toContain('must-not-be-returned');
  });

  it('uses root project opencode.json before legacy .opencode config and user config', async () => {
    const configDir = path.join(tempHome, '.config', 'opencode');
    const projectDir = path.join(tempHome, 'project');
    writeJson(path.join(configDir, 'opencode.json'), {
      mcp: {
        shared: { type: 'local', command: ['user-shared'] },
        userOnly: { type: 'local', command: ['user-only'] },
      },
    });
    writeJson(path.join(projectDir, '.opencode', 'opencode.json'), {
      mcp: {
        legacyProjectOnly: { type: 'local', command: ['legacy-project'] },
      },
    });
    writeJson(path.join(projectDir, 'opencode.json'), {
      mcp: {
        shared: { type: 'local', command: ['project-shared'] },
      },
    });

    const { listMcpConfigs } = await loadMcpModule();

    expect(listMcpConfigs(projectDir).map((entry) => [entry.name, entry.command, entry.scope]).sort()).toEqual([
      ['userOnly', ['user-only'], 'user'],
      ['shared', ['project-shared'], 'project'],
      ['legacyProjectOnly', ['legacy-project'], 'project'],
    ].sort());
  });

  it('creates project-scoped MCP configs in the project .opencode config by default', async () => {
    const projectDir = path.join(tempHome, 'project');
    const targetPath = path.join(projectDir, '.opencode', 'opencode.json');

    const { createMcpConfig, listMcpConfigs } = await loadMcpModule();

    createMcpConfig('project-local', { type: 'local', command: ['project-cli'] }, projectDir, 'project');

    expect(fs.existsSync(targetPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({
      mcp: {
        'project-local': {
          type: 'local',
          enabled: true,
          command: ['project-cli'],
        },
      },
    });
    expect(listMcpConfigs(projectDir).map((entry) => [entry.name, entry.command, entry.scope])).toEqual([
      ['project-local', ['project-cli'], 'project'],
    ]);
  });

  it('recovers missing legacy project and backup MCP entries without overwriting active entries', async () => {
    const projectDir = path.join(tempHome, 'project');
    writeJson(path.join(projectDir, 'opencode.json'), {
      mcp: {
        active: { type: 'local', command: ['active'] },
      },
    });
    writeJson(path.join(projectDir, '.opencode', 'opencode.json'), {
      mcp: {
        'legacy-local': { type: 'local', command: ['legacy-local'] },
      },
      mcpServers: {
        'legacy-claude': { command: 'npx', args: ['-y', '@example/mcp'], env: { EXAMPLE_TOKEN: 'secret' } },
      },
    });
    writeJson(path.join(projectDir, 'opencode.json.openchamber.backup'), {
      mcp: {
        active: { type: 'local', command: ['backup-active'] },
        'backup-remote': { type: 'remote', url: 'https://example.test/mcp' },
      },
    });

    const { recoverMcpConfigs, listMcpConfigs } = await loadMcpModule();

    const first = recoverMcpConfigs(projectDir);
    expect(first.migrated.map((entry) => [entry.name, entry.scope, entry.targetPath])).toEqual([
      ['backup-remote', 'project', path.join(projectDir, '.opencode', 'opencode.json')],
      ['legacy-claude', 'project', path.join(projectDir, '.opencode', 'opencode.json')],
    ]);
    expect(first.skipped).toContainEqual({ name: 'active', reason: 'already configured' });
    expect(first.skipped).toContainEqual({ name: 'legacy-local', reason: 'already configured' });
    expect(listMcpConfigs(projectDir).map((entry) => [entry.name, entry.type, entry.command, entry.url, entry.environment]).sort()).toEqual([
      ['active', 'local', ['active'], undefined, undefined],
      ['backup-remote', 'remote', undefined, 'https://example.test/mcp', undefined],
      ['legacy-local', 'local', ['legacy-local'], undefined, undefined],
      ['legacy-claude', 'local', ['npx', '-y', '@example/mcp'], undefined, { EXAMPLE_TOKEN: 'secret' }],
    ].sort());

    const second = recoverMcpConfigs(projectDir);
    expect(second.migrated).toEqual([]);
    expect(second.skipped).toEqual(
      expect.arrayContaining([
        { name: 'backup-remote', reason: 'already considered' },
        { name: 'legacy-local', reason: 'already configured' },
        { name: 'legacy-claude', reason: 'already considered' },
      ]),
    );
  });

  it('deletes matching MCP OAuth cache entry when deleting an MCP config', async () => {
    const configDir = path.join(tempHome, '.config', 'opencode');
    writeJson(path.join(configDir, 'opencode.json'), {
      mcp: {
        linear: { type: 'remote', url: 'https://mcp.linear.app/mcp' },
      },
    });
    writeJson(getMcpAuthPath(), {
      linear: { clientInfo: { client_id: 'stale-linear' }, oauthState: 'old-state' },
      supabase: { clientInfo: { client_id: 'keep-supabase' }, oauthState: 'keep-state' },
    });

    const { deleteMcpConfig } = await loadMcpModule();

    deleteMcpConfig('linear');

    expect(readJson(getMcpAuthPath())).toEqual({
      supabase: { clientInfo: { client_id: 'keep-supabase' }, oauthState: 'keep-state' },
    });
  });

  it('invalidates MCP OAuth cache when a remote identity field changes', async () => {
    const configDir = path.join(tempHome, '.config', 'opencode');
    writeJson(path.join(configDir, 'opencode.json'), {
      mcp: {
        supabase: {
          type: 'remote',
          url: 'https://mcp.supabase.com/mcp',
          oauth: { redirectUri: 'http://localhost:55676/mcp/oauth/callback' },
        },
      },
    });
    writeJson(getMcpAuthPath(), {
      supabase: { clientInfo: { client_id: 'stale-supabase' }, oauthState: 'old-state' },
    });

    const { updateMcpConfig } = await loadMcpModule();

    updateMcpConfig('supabase', {
      oauth: { redirectUri: 'http://127.0.0.1:55676/mcp/oauth/callback' },
    });

    expect(readJson(getMcpAuthPath())).toEqual({});
  });

  it('keeps MCP OAuth cache when only non-identity fields change', async () => {
    const configDir = path.join(tempHome, '.config', 'opencode');
    writeJson(path.join(configDir, 'opencode.json'), {
      mcp: {
        linear: { type: 'remote', url: 'https://mcp.linear.app/mcp', enabled: true },
      },
    });
    writeJson(getMcpAuthPath(), {
      linear: { clientInfo: { client_id: 'current-linear' }, oauthState: 'current-state' },
    });

    const { updateMcpConfig } = await loadMcpModule();

    const result = updateMcpConfig('linear', { enabled: false });

    expect(result.changed).toBe(true);
    expect(readJson(getMcpAuthPath())).toEqual({
      linear: { clientInfo: { client_id: 'current-linear' }, oauthState: 'current-state' },
    });
  });

  it('reports an unchanged effective MCP update without rewriting configuration', async () => {
    const configPath = path.join(tempHome, '.config', 'opencode', 'opencode.json');
    writeJson(configPath, {
      mcp: {
        linear: { type: 'remote', url: 'https://mcp.linear.app/mcp', enabled: true },
      },
    });
    const before = fs.readFileSync(configPath, 'utf8');
    const { updateMcpConfig } = await loadMcpModule();

    const result = updateMcpConfig('linear', { enabled: true });

    expect(result).toEqual({ changed: false, authReset: { ok: true, removed: false } });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('treats a blank oauth payload as a no-op and keeps the OAuth cache', async () => {
    const configPath = path.join(tempHome, '.config', 'opencode', 'opencode.json');
    writeJson(configPath, {
      mcp: {
        linear: {
          type: 'remote',
          url: 'https://mcp.linear.app/mcp',
          oauth: { redirectUri: 'http://127.0.0.1:57123/mcp/oauth/callback' },
        },
      },
    });
    writeJson(getMcpAuthPath(), {
      linear: { clientInfo: { client_id: 'current-linear' }, oauthState: 'current-state' },
    });
    const before = fs.readFileSync(configPath, 'utf8');
    const { updateMcpConfig } = await loadMcpModule();

    const emptyResult = updateMcpConfig('linear', { oauth: {} });
    const blankResult = updateMcpConfig('linear', {
      oauth: { clientId: '', clientSecret: ' ', scope: '', redirectUri: '' },
    });

    expect(emptyResult).toEqual({ changed: false, authReset: { ok: true, removed: false } });
    expect(blankResult).toEqual({ changed: false, authReset: { ok: true, removed: false } });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(readJson(getMcpAuthPath())).toEqual({
      linear: { clientInfo: { client_id: 'current-linear' }, oauthState: 'current-state' },
    });
  });

  it('still clears oauth and resets the cache on explicit oauth: false', async () => {
    const configPath = path.join(tempHome, '.config', 'opencode', 'opencode.json');
    writeJson(configPath, {
      mcp: {
        linear: {
          type: 'remote',
          url: 'https://mcp.linear.app/mcp',
          oauth: { redirectUri: 'http://127.0.0.1:57123/mcp/oauth/callback' },
        },
      },
    });
    writeJson(getMcpAuthPath(), {
      linear: { clientInfo: { client_id: 'current-linear' }, oauthState: 'current-state' },
    });
    const { updateMcpConfig } = await loadMcpModule();

    const result = updateMcpConfig('linear', { oauth: false });

    expect(result.changed).toBe(true);
    expect(readJson(getMcpAuthPath())).toEqual({});
  });

  it('clears stale same-name OAuth cache before creating an MCP config', async () => {
    writeJson(getMcpAuthPath(), {
      linear: { clientInfo: { client_id: 'stale-linear' }, oauthState: 'old-state' },
      supabase: { clientInfo: { client_id: 'keep-supabase' }, oauthState: 'keep-state' },
    });

    const { createMcpConfig } = await loadMcpModule();

    createMcpConfig('linear', { type: 'remote', url: 'https://mcp.linear.app/mcp' });

    expect(readJson(getMcpAuthPath())).toEqual({
      supabase: { clientInfo: { client_id: 'keep-supabase' }, oauthState: 'keep-state' },
    });
  });

  it('does not recover explicitly deleted MCP configs from legacy or backup files', async () => {
    const projectDir = path.join(tempHome, 'project');
    writeJson(path.join(projectDir, 'opencode.json'), {
      mcp: {
        linear: { type: 'remote', url: 'https://mcp.linear.app/mcp' },
      },
    });
    writeJson(path.join(projectDir, 'opencode.json.openchamber.backup'), {
      mcp: {
        linear: { type: 'remote', url: 'https://stale-linear.example.test/mcp' },
      },
    });
    writeJson(path.join(projectDir, '.opencode', 'opencode.json'), {
      mcp: {
        linear: { type: 'remote', url: 'https://legacy-linear.example.test/mcp' },
      },
    });

    const { deleteMcpConfig, recoverMcpConfigs, listMcpConfigs } = await loadMcpModule();

    deleteMcpConfig('linear', projectDir);
    const recovered = recoverMcpConfigs(projectDir);

    expect(recovered.migrated).toEqual([]);
    expect(recovered.skipped).toContainEqual({ name: 'linear', reason: 'deleted' });
    expect(listMcpConfigs(projectDir).find((entry) => entry.name === 'linear')).toBeUndefined();
  });
});
