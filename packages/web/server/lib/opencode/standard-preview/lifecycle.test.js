import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createStandardPreviewLifecycle } from './lifecycle.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture({ platform = 'linux', version = 'opencode v2.0.20\n', authenticated = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devryan-preview-lifecycle-')); roots.push(root);
  const children = [], calls = [];
  const spawnProcess = vi.fn((binary, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 4000 + children.length, exitCode: null, signalCode: null });
    child.kill = vi.fn(signal => { child.signalCode = signal; child.emit('close'); return true; });
    children.push(child); calls.push({ binary, args, options }); return child;
  });
  let refuseKill = false;
  const runFile = vi.fn(async (_binary, args) => {
    if (args[0] === '--version') return { stdout: version };
    if (refuseKill) throw new Error('kill failed');
    children.at(-1).signalCode = 'SIGKILL'; children.at(-1).emit('close'); return { stdout: '' };
  });
  const fetchImpl = vi.fn(async (_url, options) => options.headers?.Authorization || !authenticated
    ? Response.json({ version: '2.0.20' }) : new Response(null, { status: 401 }));
  const lifecycle = createStandardPreviewLifecycle({ binary: path.join(root, 'opencode'), dataDirectory: root,
    workingDirectory: path.join(root, 'project'), platform, spawnProcess, runFile, fetchImpl, reservePort: async () => 54321,
    environment: { PATH: '/system/bin', HOME: '/installed/home', GROQ_API_KEY: 'fixture-never-inherit', DEEPSEEK_API_KEY: 'fixture-never-inherit', DEVRYAN_EXECUTION_BOUNDARY: '1' } });
  return { lifecycle, calls, children, runFile, fetchImpl, root, refuseKill: value => { refuseKill = value; } };
}
it('starts only the pinned stock version with isolated roots and authenticated loopback readiness', async () => {
  const f = await fixture(); await f.lifecycle.start();
  expect(f.calls[0].args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '54321']);
  expect(f.calls[0].options.env).toMatchObject({ PATH: '/system/bin', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' });
  expect(f.calls[0].options.env).not.toHaveProperty('GROQ_API_KEY'); expect(f.calls[0].options.env).not.toHaveProperty('DEEPSEEK_API_KEY');
  expect(f.calls[0].options.env).not.toHaveProperty('DEVRYAN_EXECUTION_BOUNDARY');
  expect(f.calls[0].options.env.HOME).toBe(path.join(f.root, 'runtime/home'));
  expect(f.calls[0].options.env.TMPDIR).toBe(path.join(f.root, 'runtime/tmp'));
  expect(f.lifecycle.snapshot().ready).toBe(true);
  expect(f.fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/info', '/api/info']);
  await f.lifecycle.close(); expect(f.lifecycle.snapshot().ready).toBe(false);
});
it('refuses a mismatched CLI before launching and refuses unauthenticated server configuration', async () => {
  const bad = await fixture({ version: 'opencode v2.0.21\n' });
  await expect(bad.lifecycle.start()).rejects.toMatchObject({ code: 'standard_preview_version_mismatch' }); expect(bad.calls).toHaveLength(0);
  const noAuth = await fixture({ authenticated: false });
  await expect(noAuth.lifecycle.start()).rejects.toMatchObject({ code: 'standard_preview_authentication_required' });
  expect(noAuth.children[0].kill).toHaveBeenCalled(); expect(noAuth.lifecycle.snapshot().ready).toBe(false);
});
it('fences restart identity and never reuses inherited processes', async () => {
  const f = await fixture(); await f.lifecycle.start(); const first = f.lifecycle.getRuntime();
  await f.lifecycle.restart();
  expect(f.calls).toHaveLength(2); expect(f.lifecycle.getRuntime().epoch).toBeGreaterThan(first.epoch);
  await f.lifecycle.close(); await expect(f.lifecycle.start()).rejects.toMatchObject({ code: 'standard_preview_shutting_down' });
});
it('retains Windows child ownership when termination fails so a retry can stop it', async () => {
  const f = await fixture({ platform: 'win32' }); await f.lifecycle.start(); f.refuseKill(true);
  await expect(f.lifecycle.stop()).rejects.toThrow('kill failed'); expect(f.lifecycle.snapshot()).toMatchObject({ ready: false, running: true });
  f.refuseKill(false); await f.lifecycle.stop(); expect(f.lifecycle.snapshot().running).toBe(false);
  expect(f.runFile.mock.calls.at(-1).slice(0, 2)).toEqual(['taskkill.exe', ['/PID', '4000', '/T', '/F']]);
});
