import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('development QA selects the mock keychain before importing the production Electron host', async () => {
  const cache = fileURLToPath(new URL('../../.cache/qa/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'isolated-host-test-'));
  try {
    const home = path.join(root, 'home');
    await mkdir(home);
    await writeFile(path.join(home, '.devryan-qa-home'), '');
    await writeFile(path.join(root, 'credentials.env.json'), '{}');
    const electron = `export const app = {
      commandLine: { appendSwitch(value) { if (value !== 'use-mock-keychain') throw new Error('Unexpected switch'); globalThis.qaMockKeychain = true; } },
      setPath() { if (!globalThis.qaMockKeychain) throw new Error('Keychain isolation missing before Electron setup'); }, setAppLogsPath() {}
    };`;
    const host = `if (!globalThis.qaMockKeychain) throw new Error('Production host reached the real keychain'); console.log('qa-keychain-isolated');`;
    const dataUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
    const loader = `export async function resolve(specifier, context, next) {
      if (specifier === 'electron') return { url: ${JSON.stringify(dataUrl(electron))}, shortCircuit: true };
      if (specifier === '../../packages/electron/main.mjs') return { url: ${JSON.stringify(dataUrl(host))}, shortCircuit: true };
      return next(specifier, context);
    }`;
    const preload = dataUrl(`import { register } from 'node:module'; register(${JSON.stringify(dataUrl(loader))});`);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', preload, fileURLToPath(new URL('./isolated-host.mjs', import.meta.url))], {
      env: { ...process.env, DEVRYAN_QA_RUNTIME: 'electron', DEVRYAN_QA_RUNTIME_ROOT: root, DEVRYAN_QA_HOME: home }, timeout: 10_000,
    });
    assert.equal(stdout.trim(), 'qa-keychain-isolated');
  } finally { await rm(root, { recursive: true, force: true }); }
});
