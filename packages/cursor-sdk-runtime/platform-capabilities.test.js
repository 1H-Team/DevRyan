import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCursorSdkRuntime } from './index.js';

test('Windows ARM64 refuses every execution entry before credentials, admission, SDK or workers', async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../.cache/v2-validation/cursor-platform-'));
  const untouched = () => { throw Error('Unsupported platform entered an owner'); };
  const runtime = createCursorSdkRuntime({ platform: 'win32', arch: 'arm64', storageDir: path.join(root, 'unused'), env: {},
    readAuth: untouched, resolveApiKey: untouched, loadSdk: untouched, ownedReadOnly: untouched, spawnImpl: untouched,
    executionAdapter: { reserveActivity: untouched }, nativeWarming: false });
  try {
    expect(runtime.getRuntimeStatus()).toMatchObject({ capabilities: { supported: false, code: 'cursor_platform_unsupported' },
      sdkAuthConfigured: false, usageAuthConfigured: false, workerReady: false, activeRuns: 0, modelCount: 0, modelsSource: 'unavailable' });
    expect(Object.isFrozen(runtime.getRuntimeStatus().capabilities)).toBe(true);
    for (const provider of [runtime.getDeclaredVirtualProvider(), runtime.getCachedVirtualProvider()]) expect(provider.models).toEqual({});
    expect(await runtime.validateModelSelection({ modelID: 'composer-2.5' })).toBe(false);
    for (const action of [
      () => runtime.verifyConnection(), () => runtime.prewarm(), () => runtime.prewarmSession({ sessionID: 'saved' }),
      () => runtime.getVirtualProvider(), () => runtime.refreshVirtualProvider(),
      () => runtime.generateTitle({ text: 'A title' }),
      () => runtime.generateText({ text: 'A helper', modelID: 'composer-2.5', directory: root }),
      () => runtime.handlePromptAsync({ sessionID: 'saved', directory: root, body: { model: { providerID: 'cursor-acp', modelID: 'composer-2.5' } } }),
    ]) await expect(action()).rejects.toMatchObject({ code: 'cursor_platform_unsupported', statusCode: 503 });
    expect(await runtime.handlePromptAsync({ body: { model: { providerID: 'openai' } } })).toEqual({ handled: false });
    expect(runtime.getSessionStatus()).toEqual({});
    expect(await runtime.abortAndWait('saved')).toEqual({ terminated: true, sessions: ['saved'] });
    expect(await fs.readdir(root)).toEqual([]);
  } finally { await runtime.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows x64 retains original offline declarations without account discovery', async () => {
  const runtime = createCursorSdkRuntime({ platform: 'win32', arch: 'x64', env: {}, ripgrepPath: '/usr/bin/true', loadSdk: async () => ({}),
    readAuth: () => { throw Error('Offline capability read entered credentials'); } });
  try { expect(runtime.getDeclaredVirtualProvider().models['composer-2.5']).toBeDefined(); }
  finally { await runtime.dispose(); }
});

test('native Windows CI uses the actual process identity when none is supplied', async () => {
  const runtime = createCursorSdkRuntime({ env: {}, loadSdk: async () => ({}), resolveApiKey: () => { throw Error('Status entered credentials'); } });
  try {
    const status = runtime.getRuntimeStatus();
    const supported = process.platform !== 'win32' || process.arch !== 'arm64';
    expect(status.capabilities).toEqual({ supported, code: supported ? null : 'cursor_platform_unsupported' });
    expect(Object.keys(runtime.getDeclaredVirtualProvider().models).length > 0).toBe(supported);
  } finally { await runtime.dispose(); }
});
