import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { afterEach, expect, test, vi } from 'vitest';
import request from '../../test-supertest.js';
import { CLAUDE_UPDATE_REGISTRY_URL, createClaudeUpdateCheckHandler, readBundledClaudeVersion } from './claude-runtime-update.js';
import { REVIEWED_CLAUDE_ASSETS } from './runtime-host/reviewed-claude-transform.js';
import { REVIEWED_PREVIOUS_CLAUDE_ASSET } from './runtime-host/native-artifacts.js';
import { REVIEWED_WINDOWS_EXECUTABLES } from './runtime-host/reviewed-windows-assets.js';
import { registerOpenCodeRoutes } from './routes.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const appWith = fetchImpl => {
  const app = express();
  app.get('/check', createClaudeUpdateCheckHandler({ fetchImpl, timeoutMs: 20 }));
  return app;
};
test('Claude update lookup uses fixed metadata without credentials or installation', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ version: '2.1.280' }));
  const response = await request(appWith(fetchImpl)).get('/check').set('Authorization', 'Bearer fixture').expect(200);
  expect(response.body).toEqual({ latestVersion: '2.1.280' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(fetchImpl.mock.calls[0][0]).toBe(CLAUDE_UPDATE_REGISTRY_URL);
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } });
});
test('invalid, prerelease and oversized metadata never become update targets', async () => {
  for (const payload of [{ version: '2.1.281-beta.1' }, { version: '02.1.280' }, { version: 2 }, { version: '2.1.280', padding: 'x'.repeat(256 * 1024) }]) {
    const response = await request(appWith(async () => Response.json(payload))).get('/check').expect(503);
    expect(response.body.error).toBe('claude_update_check_failed');
    expect(response.body.code).toMatch(/^claude_update_/);
  }
});
test('timeouts and upstream failures return finite Claude codes', async () => {
  const hung = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private')), { once: true }));
  const timeout = await request(appWith(hung)).get('/check').expect(503);
  expect(timeout.body.code).toBe('claude_update_registry_timeout');
  const failure = await request(appWith(async () => { throw new Error('private'); })).get('/check').expect(503);
  expect(failure.body).toEqual({ error: 'claude_update_check_failed', code: 'claude_update_registry_unavailable' });
});
async function bindingFor(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-claude-version-')); roots.push(root);
  const bytes = JSON.stringify({ files });
  const artifactManifestPath = path.join(root, 'manifest.json'); await fs.writeFile(artifactManifestPath, bytes);
  return { descriptor: { launch: { artifactManifestPath, artifactManifestSha256: createHash('sha256').update(bytes).digest('hex') } } };
}
test('version identifies current, rollback and Windows binaries by reviewed identity, not claimed version', async () => {
  for (const asset of [REVIEWED_CLAUDE_ASSETS.claude, REVIEWED_PREVIOUS_CLAUDE_ASSET, REVIEWED_WINDOWS_EXECUTABLES.x64.claude, REVIEWED_WINDOWS_EXECUTABLES.arm64.claude]) {
    const binding = await bindingFor([{ role: 'asset', sha256: asset.sha256, version: '99.0.0' }]);
    expect(await readBundledClaudeVersion({ binding })).toBe(asset.version);
  }
  expect(await readBundledClaudeVersion({ binding: null })).toBeNull();
  expect(await readBundledClaudeVersion({ binding: await bindingFor([{ role: 'asset', sha256: 'a'.repeat(64), version: '2.1.280' }]) })).toBeNull();
});
test('changed manifest cannot report a trusted version', async () => {
  const binding = await bindingFor([{ role: 'asset', sha256: REVIEWED_CLAUDE_ASSETS.claude.sha256 }]);
  await fs.writeFile(binding.descriptor.launch.artifactManifestPath, '{"files":[]}');
  await expect(readBundledClaudeVersion({ binding })).rejects.toThrow('manifest');
});
test('About routes report bundled metadata and refuse to identify external runtimes', async () => {
  for (const external of [false, true]) {
    const read = vi.fn(async () => '2.1.280');
    const app = express();
    registerOpenCodeRoutes(app, { cursorSessionTitleRuntime: {}, standardSessionTitleRuntime: {}, globalAgentsMdRuntime: {}, openCodeClient: { generation: () => 2 },
      isExternalOpenCode: () => external, readBundledClaudeVersion: read, claudeUpdateCheckFetch: async () => Response.json({ version: '2.1.281' }) });
    const result = await request(app).get('/api/config/claude-resolution').expect(200);
    expect(result.body).toEqual(external ? { source: 'unavailable', version: null } : { source: 'verified-native-bundle', version: '2.1.280' });
    expect(read).toHaveBeenCalledTimes(external ? 0 : 1);
    await request(app).get('/api/config/claude-update-check').expect(200).expect({ latestVersion: '2.1.281' });
  }
});
