import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executionArtifactDirectory, executionArtifacts, executionEnvironment } from './execution-artifacts.js';

test('packaged Electron uses resources when its development flag is explicitly disabled', () => {
  const resourcesPath = path.resolve('/fixture/DevRyan.app/Contents/Resources');
  for (const developmentMode of ['0', 'false', '']) {
    expect(executionArtifactDirectory({ resourcesPath, developmentMode }))
      .toBe(path.join(resourcesPath, 'revert-runtime', `${process.platform}-${process.arch}`));
  }
  expect(executionArtifactDirectory({ resourcesPath, developmentMode: '1' }))
    .not.toContain(resourcesPath);
});

test('capture requires the exact shipped companion contract and accepted native artifacts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-artifacts-'));
  const { launcher, opencode } = executionArtifacts(directory);
  const contract = JSON.parse(await fs.readFile(new URL('./companion/manifest.json', import.meta.url)));
  const sha256 = createHash('sha256').update('fixture').digest('hex');
  const native = { version: 1, policy: 2, acceptance: true, platform: process.platform, arch: process.arch,
    binary: path.basename(launcher), sha256, spawnLibrary: path.basename(launcher) + '-spawn.dylib', spawnSha256: sha256 };
  const companion = { ...contract.capability, acceptance: true, platform: process.platform, arch: process.arch,
    binary: path.basename(opencode), baseCommit: contract.baseCommit, patchSha256: contract.patchSha256, sha256 };
  const environment = () => executionEnvironment({ directory, pluginDirectory: directory, dataDirectory: directory, runtimeMode: 'captured' });
  try {
    for (const file of [launcher, opencode, launcher + '-spawn.dylib', ...['devryan-managed-orchestration.mjs', 'council-session.js', 'devryan-browser.mjs'].map((name) => path.join(directory, name))]) {
      await fs.writeFile(file, 'fixture');
    }
    await fs.writeFile(launcher + '.json', JSON.stringify(native));
    await fs.writeFile(path.join(directory, 'companion.json'), JSON.stringify(companion));
    expect((await environment()).DEVRYAN_EXECUTION_BOUNDARY).toBe('1');
    await fs.writeFile(path.join(directory, 'companion.json'), JSON.stringify({ ...companion, patchSha256: 'older-patch' }));
    await expect(environment()).rejects.toMatchObject({ code: 'execution_artifacts_unavailable' });
    await fs.writeFile(path.join(directory, 'companion.json'), JSON.stringify({ ...companion, baseCommit: 'different-source' }));
    await expect(environment()).rejects.toMatchObject({ code: 'execution_artifacts_unavailable' });
    await fs.writeFile(path.join(directory, 'companion.json'), JSON.stringify(companion));
    await fs.writeFile(launcher + '.json', JSON.stringify({ ...native, acceptance: false }));
    await expect(environment()).rejects.toMatchObject({ code: 'execution_artifacts_unavailable' });
    expect(await executionEnvironment({ directory, runtimeMode: 'external' })).toEqual({});
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('required artifact failures preserve diagnostics and block all mutating execution routes', async () => {
  const { executionRuntimeState, executionReadinessMiddleware } = await import('./execution-artifacts.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-unavailable-'));
  try {
    const state = await executionRuntimeState({ runtimeMode: 'captured', directory });
    expect(state.state).toBe('required_unavailable'); expect(state.environment).toEqual({});
    expect(() => state.assertReady()).toThrow();
    const gate = executionReadinessMiddleware(state);
    for (const route of ['message', 'prompt_async', 'command', 'shell', 'summarize', '%70rompt_async', 'COMMAND/']) {
      let status, body, next = false;
      const res = { status: (value) => { status = value; return res; }, json: (value) => { body = value; } };
      gate({ method: 'POST', path: `/api/session/s/${route}` }, res, () => { next = true; });
      expect(next).toBe(false); expect(status).toBe(503); expect(body.code).toBe('execution_artifacts_unavailable');
    }
    let next = false; gate({ method: 'GET', path: '/api/diagnostics/execution-runtime' }, {}, () => { next = true; }); expect(next).toBe(true);
    expect((await executionRuntimeState({ runtimeMode: 'external', directory })).state).toBe('not_expected');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a managed host without a verified companion degrades to plain OpenCode instead of blocking', async () => {
  const { executionRuntimeState, executionReadinessMiddleware } = await import('./execution-artifacts.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-degraded-'));
  try {
    const state = await executionRuntimeState({ runtimeMode: 'managed', directory, pluginDirectory: directory, dataDirectory: directory });
    // Unsupported platforms never expect the companion; supported ones degrade.
    expect(['degraded', 'not_expected']).toContain(state.state);
    expect(state.environment).toEqual({});
    expect(() => state.assertReady()).not.toThrow();
    if (state.state === 'degraded') expect(state.diagnostic.code).toBe('execution_artifacts_unavailable');
    let next = false;
    executionReadinessMiddleware(state)({ method: 'POST', path: '/api/session/s/prompt_async' }, {}, () => { next = true; });
    expect(next).toBe(true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
