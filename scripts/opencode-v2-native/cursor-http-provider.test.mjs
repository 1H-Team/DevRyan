import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCursorHttpProvider } from './cursor-http-provider.mjs';
import { DEFAULT_RG, repositoryRoot } from './artifacts.mjs';

test('original Cursor SDK verifies the current loopback key using the pinned user response shape', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(repositoryRoot, '.cache/v2-validation/cursor-verify-')));
  const requests = [], key = 'owned-current-account';
  const provider = await createCursorHttpProvider({ expectedApiKey: () => key, onRequest: row => requests.push(row) });
  try {
    const source = `const {Cursor}=await import('@cursor/sdk');process.stdout.write(JSON.stringify(await Cursor.me({apiKey:${JSON.stringify(key)}})));`;
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: path.join(repositoryRoot, 'packages/cursor-sdk-runtime'),
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, CURSOR_BACKEND_URL: provider.baseURL }, timeout: 30000,
    });
    assert.equal(child.stderr, '');
    assert.deepEqual(JSON.parse(child.stdout), { apiKeyName: 'Owned loopback account', userId: 1,
      userEmail: 'owned@example.invalid', createdAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(requests.find(row => row.pathname === '/v1/me')?.selectedCredentialObserved, true);
    assert.equal((await fetch(new URL('/v1/me', provider.baseURL), { headers: { authorization: 'Bearer wrong-account' } })).status, 401);
  } finally { await provider.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('original Cursor SDK performs actual loopback model discovery and Connect inference', async () => {
  const cache = path.join(repositoryRoot, '.cache/v2-validation'); await fs.mkdir(cache, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(cache, 'cursor-http-')));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  await fs.mkdir(home); await fs.mkdir(project);
  const requests = [], provider = await createCursorHttpProvider({ onRequest: row => requests.push(row) });
  let child;
  try {
    child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/cursor-sdk-runtime/node-worker.mjs')], {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: root, CURSOR_BACKEND_URL: provider.baseURL,
        OPENCHAMBER_CURSOR_SETTING_SOURCES: 'none', CURSOR_SDK_RIPGREP_PATH: DEFAULT_RG },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const deadline = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.stdin.end(JSON.stringify({ sessionID: 'ses_owned_transport', directory: project,
      apiKey: 'owned-loopback-fixture-key', modelID: 'composer', prompt: 'Owned isolated SDK transport fixture' }));
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(deadline);
    assert.equal(code, 0); assert.equal(stderr, '');
    const events = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.some(row => row.type === 'error'), false);
    assert.equal(events.find(row => row.type === 'final-result').result.finalText, 'Owned Cursor transport reply');
    assert.equal(events.find(row => row.type === 'final-result').result.finalStatus, 'success');
    assert.equal(requests.filter(row => row.pathname === '/agent.v1.AgentService/RunSSE').length, 1);
    assert.equal(requests.filter(row => row.pathname === '/aiserver.v1.BidiService/BidiAppend').length, 1);
    assert.ok(requests.find(row => row.pathname === '/aiserver.v1.BidiService/BidiAppend').requestBytes > 100);
    assert.equal(requests.some(row => row.pathname === '/v1/models'), true);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
    await provider.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
