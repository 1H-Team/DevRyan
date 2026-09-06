import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { preparePackagedQaHost } from './packaged-host-policy.mjs';

const cache = fileURLToPath(new URL('../../.cache/qa/', import.meta.url));
const createFixture = async () => {
  await mkdir(cache, { recursive: true });
  const runtimeRoot = await mkdtemp(path.join(cache, 'packaged-policy-test-'));
  const home = path.join(runtimeRoot, 'home');
  const data = path.join(home, '.config/openchamber');
  await mkdir(data, { recursive: true });
  await writeFile(path.join(home, '.devryan-qa-home'), 'owned QA home\n');
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({ showReasoningTraces: true, productionBotsRuntimeMode: 'service' }));
  await writeFile(path.join(runtimeRoot, 'credentials.env.json'), '{}');
  const env = { HOME: '/unchanged-parent-home', DEVRYAN_QA_RUNTIME: 'electron', DEVRYAN_QA_RUNTIME_ROOT: runtimeRoot,
    DEVRYAN_QA_HOME: home, OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_ELECTRON_USER_DATA_DIR: path.join(runtimeRoot, 'browser-profile'),
    OPENCHAMBER_ELECTRON_DEV: '1', OPENCODE_CONFIG_CONTENT: '{"plugin":["observer"]}' };
  const paths = {};
  const app = { isPackaged: true, setPath: (key, value) => { paths[key] = value; }, setAppLogsPath: value => { paths.logs = value; },
    commandLine: { appendSwitch: value => { paths.switch = value; } },
    isDefaultProtocolClient: () => false, setAsDefaultProtocolClient: () => { throw new Error('Personal OS protocol mutation'); } };
  return { runtimeRoot, env, app, paths };
};

test('packaged QA uses its real resources and private profile before production imports', async () => {
  const fixture = await createFixture();
  try {
    const result = await preparePackagedQaHost({ ...fixture, resourcesPath: '/owned/DevRyan.app/Contents/Resources' });
    assert.equal(result.isPackaged, true);
    assert.equal(fixture.paths.home, fixture.env.DEVRYAN_QA_HOME);
    assert.equal(fixture.paths.userData, fixture.env.OPENCHAMBER_ELECTRON_USER_DATA_DIR);
    assert.equal(fixture.env.HOME, '/unchanged-parent-home');
    assert.equal(fixture.env.OPENCHAMBER_ELECTRON_DEV, '0');
    assert.equal(fixture.env.OPENCHAMBER_DIST_DIR, '/owned/DevRyan.app/Contents/Resources/web-dist');
    assert.equal(fixture.env.OPENCODE_CONFIG_CONTENT, '{"plugin":["observer"]}');
    assert.equal(fixture.env.ZDOTDIR, path.join(fixture.env.DEVRYAN_QA_HOME, '.config/qa-zsh'));
    assert.equal(fixture.paths.switch, 'use-mock-keychain');
    assert.equal(fixture.app.isDefaultProtocolClient('openchamber'), true);
    assert.equal(fixture.app.setAsDefaultProtocolClient('openchamber'), false);
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.env.OPENCHAMBER_DATA_DIR, 'settings.json'), 'utf8')),
      { showReasoningTraces: true, productionBotsRuntimeMode: 'disabled', desktopLanAccessEnabled: false });
  } finally { await rm(fixture.runtimeRoot, { recursive: true, force: true }); }
});

test('packaged QA rejects a development shell and profile symlink before personal Electron paths change', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(preparePackagedQaHost({ ...fixture, app: { ...fixture.app, isPackaged: false } }), /actual packaged/);
    await symlink(cache, fixture.env.OPENCHAMBER_ELECTRON_USER_DATA_DIR);
    await assert.rejects(preparePackagedQaHost(fixture), /escaped/);
    assert.deepEqual(fixture.paths, {});
    assert.equal(JSON.parse(await readFile(path.join(fixture.env.OPENCHAMBER_DATA_DIR, 'settings.json'), 'utf8')).productionBotsRuntimeMode, 'service');
  } finally { await rm(fixture.runtimeRoot, { recursive: true, force: true }); }
});

test('packaged QA rejects unexpected private environment fields without persisting or exposing them', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(path.join(fixture.runtimeRoot, 'credentials.env.json'), JSON.stringify({ HOME: 'synthetic-rejected-value' }));
    await assert.rejects(preparePackagedQaHost(fixture), { message: 'Unexpected private QA credential environment field' });
    assert.equal(fixture.env.HOME, '/unchanged-parent-home');
    assert.deepEqual(fixture.paths, {});
  } finally { await rm(fixture.runtimeRoot, { recursive: true, force: true }); }
});
