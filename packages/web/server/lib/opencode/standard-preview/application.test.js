import { mkdtemp, mkdir, rm, writeFile, realpath, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { startWebUiServer } from './application.js';

const roots = [], handles = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devryan-preview-backend-')); roots.push(root);
  await mkdir(path.join(root, 'project')); const project = await realpath(path.join(root, 'project'));
  await writeFile(path.join(project, 'readme.txt'), 'fixture project');
  const handle = await startWebUiServer({ port: 0, dataDirectory: path.join(root, 'data'), runtimeBinary: path.join(root, 'unused-stock-cli'),
    runtimeWorkingDirectory: project, deferOpenCodeStartup: true, attachSignals: false }); handles.push(handle);
  const origin = `http://127.0.0.1:${handle.getPort()}`, owner = await handle.issueLocalOwnerSession();
  const headers = { Cookie: `${owner.name}=${owner.value}` };
  const call = (route, options = {}) => fetch(origin + route, { ...options, headers: { ...headers, ...options.headers } });
  return { root, project, handle, origin, call };
}
it('exports preview composition before native bootstrap and never provisions native state during import', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devryan-preview-import-')); roots.push(root);
  const index = fileURLToPath(new URL('../../../index.js', import.meta.url));
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../../../index.js', import.meta.url).href)}); console.log('preview-imported')`], {
    env: { ...process.env, DEVRYAN_RUNTIME_MODE: 'standard-preview', DEVRYAN_RUNTIME_BUNDLE_ROOT: path.join(root, 'must-not-exist') }, timeout: 10000,
    cwd: path.dirname(index), maxBuffer: 64 * 1024,
  });
  expect(result.stdout).toContain('preview-imported');
  await expect(access(path.join(root, 'must-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('advertises ordinary preview capabilities while enforcing owner cookies, direct origins and protected-feature refusals', async () => {
  const f = await fixture();
  const health = await (await f.call('/health')).json();
  expect(health.openCode).toMatchObject({ runtimeMode: 'standard-preview', ordinaryUserPermissions: true, ready: false,
    capabilities: { chat: true, providerApiKey: true, nativeExecution: false, revert: false, bots: false, terminal: false } });
  expect((await fetch(f.origin + '/api/config/settings')).status).toBe(401);
  expect((await f.call('/api/config/settings', { headers: { Origin: 'https://foreign.example' } })).status).toBe(403);
  expect((await f.call('/api/config/settings', { headers: { 'X-Forwarded-Host': '127.0.0.1' } })).status).toBe(403);
  for (const route of ['/api/session/ses_fixture/scoped-revert', '/api/session/ses_fixture/changes', '/api/provider/openai/oauth/authorize',
    '/api/bots', '/api/terminal', '/api/browser', '/api/media', '/api/opencode-v2/session']) {
    const response = await f.call(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status, route).toBe(501); expect((await response.json()).code).toBe('capability_unavailable');
  }
  expect(await (await f.call('/api/terminal/capabilities')).json()).toMatchObject({ available: false });
});
it('reuses validated project/file routes and persists settings without enabling runtime overrides', async () => {
  const f = await fixture();
  expect(await (await f.call('/api/fs/read?path=' + encodeURIComponent(path.join(f.project, 'readme.txt')))).text()).toBe('fixture project');
  const escaped = await f.call('/api/fs/read?path=' + encodeURIComponent(path.join(f.root, 'outside.txt')));
  expect([400, 403]).toContain(escaped.status);
  const update = await f.call('/api/config/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showReasoningTraces: true }) });
  expect(update.status).toBe(200); expect((await update.json()).showReasoningTraces).toBe(true);
  const unsupported = await f.call('/api/config/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opencodeBinary: '/other' }) });
  expect(unsupported.status).toBe(501);
  const changed = await f.call('/api/opencode/directory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.project }) });
  expect((await changed.json()).settings.projects[0].path).toBe(await import('node:fs/promises').then(module => module.realpath(f.project)));
});
