import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';
import { createFeedMirror, createUpdaterFixture, feedMirrorScript, feedUrl, updaterFixtureScript, updaterObservationScript } from './release-updater-fixture.mjs';
import { installedUpgradeBaselines, runInstalledUpgrades } from './release-installed-upgrades.mjs';
import { closeInspectorSessions, prepareFixtureInspector, gradeVisualQa } from './release-visual-qa.mjs';
import { releaseManifest } from '../release-candidate.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';

const releases = ['1.2.21', '1.2.22', '2.0.0', '2.0.1', '2.0.2', '2.0.3', '2.0.4'].map(version => ({ tag_name: `v${version}`, draft: false, prerelease: false }));

test('installed upgrades cover floor, representative intermediate and previous published app without duplicates', () => {
  assert.deepEqual(installedUpgradeBaselines([...releases, { tag_name: 'v99.0.0', draft: true, prerelease: false }], '2.0.5'), ['2.0.0', '2.0.4'], 'the floor and the previous app; releases below the floor are never baselines');
  assert.deepEqual(installedUpgradeBaselines(releases, '2.0.5', { previousOnly: true }), ['2.0.4'], 'after publication only the previous app');
  assert.deepEqual(installedUpgradeBaselines(releases, '2.0.1'), ['2.0.0']);
  assert.throws(() => installedUpgradeBaselines(releases.filter(row => row.tag_name !== 'v2.0.0'), '2.0.5'), /floor/);
});

test('qualification runs serially, records skipped upgrades as failures and retains a partial matrix report', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-installed-upgrades-'));
  const report = path.join(root, 'report.json'), calls = [];
  try {
    const result = await runInstalledUpgrades({ version: '2.0.5', dmg: '/candidate.dmg', manifest: '/manifest.json', report, candidateUpgrade: true }, { releases,
      qualify: async options => {
        calls.push(options.upgradeFrom);
        assert.equal(options.requireUpgrade, true); assert.equal(options.upgradeOnly, true);
        return { passed: true, upgrade: { status: calls.length === 1 ? 'passed' : 'skipped' } };
      } });
    assert.equal(result.passed, false);
    assert.deepEqual(calls, ['v2.0.0', 'v2.0.4']);
    assert.equal(JSON.parse(await fs.readFile(report, 'utf8')).passed, false);
    assert.ok(gradeVisualQa({ steps: {}, upgradeRequired: true, upgrade: { status: 'skipped' } }).failures.includes('upgrade'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-updater-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dmg = path.join(root, 'candidate.dmg'), manifestPath = path.join(root, 'release-manifest.json');
  const bytes = Buffer.from('exact candidate bytes');
  const manifest = releaseManifest({ candidate: { version: '2.1.14', revision: 'a'.repeat(40), runID: '1', attempt: '1', name: 'DevRyan-2.1.14-arm64.dmg',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, bundle: { bundleId: 'dev.devryan.desktop', shortVersion: '2.1.14', executable: 'DevRyan' },
    arch: 'arm64', signingMode: 'adhoc', runtimeManifestSha256: 'b'.repeat(64) });
  await fs.writeFile(dmg, bytes); await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const feed = await createUpdaterFixture({ dmg, manifestPath });
  t.after(() => feed.close());
  return { feed, dmg, manifestPath, bytes };
}

test('fixture pins exact bytes, serves canonical discovery and supports resumed downloads', async t => {
  const { feed, dmg, manifestPath, bytes } = await fixture(t);
  const payload = await (await fetch(`${feed.origin}/latest`)).json();
  assert.equal(payload.assets.length, 1);
  assert.equal(payload.assets[0].browser_download_url, 'https://github.com/1H-Team/DevRyan/releases/download/v2.1.14/DevRyan-2.1.14-arm64.dmg');
  const resumed = await fetch(`${feed.origin}/candidate`, { headers: { Range: 'bytes=6-' } });
  assert.equal(resumed.status, 206);
  assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), bytes.subarray(6));
  assert.equal((await fetch(`${feed.origin}/candidate`, { headers: { Range: 'bytes=999-' } })).status, 416);
  await fs.writeFile(dmg, 'changed');
  await assert.rejects(createUpdaterFixture({ dmg, manifestPath }), /does not match/);
});

test('test-process hook redirects only exact canonical URLs and rejects nonloopback fixtures', () => {
  const calls = [];
  const context = { URL, fetch: (url, options) => { calls.push([url, options]); } };
  vm.runInNewContext(updaterFixtureScript({ origin: 'http://127.0.0.1:12345', version: '2.1.14' }), context);
  context.fetch(feedUrl, { signal: 'signal' }); context.fetch('https://unrelated.example/');
  assert.deepEqual(calls, [['http://127.0.0.1:12345/latest', { signal: 'signal' }], ['https://unrelated.example/', undefined]]);
  assert.throws(() => updaterFixtureScript({ origin: 'https://external.example', version: '2.1.14' }), /loopback/);
});

test('main observation survives renderer replacement, preserves IPC results and failures, and restores native progress forwarding', async () => {
  const handlers = new Map(), sent = [];
  const send = (...args) => sent.push(args);
  const contents = { send };
  const electron = { ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    BrowserWindow: { getAllWindows: () => [{ webContents: contents }] } };
  const context = { process: { versions: { electron: '44' }, execPath: '/fixture/electron',
    getBuiltinModule: name => { assert.equal(name, 'module'); return { createRequire: executable => {
      assert.equal(executable, '/fixture/electron'); return name => { assert.equal(name, 'electron'); return electron; };
    } }; } } };
  assert.equal(vm.runInNewContext(updaterObservationScript(), context), true);
  let complete;
  const originalError = new Error('native download refused');
  electron.ipcMain.handle('devryan:invoke', async (_event, command) => {
    if (command === 'check') return 'unchanged';
    if (command === 'desktop_download_and_install_update') return new Promise(resolve => { complete = resolve; });
    throw originalError;
  });
  const invoke = handlers.get('devryan:invoke');
  assert.equal(await invoke({}, 'check'), 'unchanged');
  const pending = invoke({}, 'desktop_download_and_install_update');
  const payload = { event: 'devryan:update-progress', detail: { event: 'Progress', data: { downloaded: 1024 } } };
  contents.send('devryan:emit', payload);
  assert.deepEqual(sent, [['devryan:emit', payload]]);
  assert.equal(context.__devryanUpgradeQa.downloaded, 1024);
  context.window = {}; // A new renderer does not replace main's operation receipt.
  complete('verified');
  assert.equal(await pending, 'verified');
  assert.equal(context.__devryanUpgradeQa.state, 'complete');
  assert.equal(contents.send, send);
  electron.ipcMain.handle('devryan:invoke', async () => { throw originalError; });
  await assert.rejects(handlers.get('devryan:invoke')({}, 'desktop_download_and_install_update'), error => error === originalError);
  assert.equal(context.__devryanUpgradeQa.state, 'failed');
  assert.equal(contents.send, send);
  const refusal = Object.assign(new Error('native_runtime_artifacts_unverified'), { code: 'native_runtime_artifacts_unverified',
    diagnostic: { stage: 'manifest', reason: 'manifest_invalid', purpose: 'current' } });
  electron.ipcMain.handle('devryan:invoke', async (_event, command) => { if (command === 'desktop_restart') throw refusal; return null; });
  await assert.rejects(handlers.get('devryan:invoke')({}, 'desktop_restart'), error => error === refusal);
  assert.deepEqual({ ...context.__devryanUpgradeQa.restart }, { state: 'failed', code: 'native_runtime_artifacts_unverified',
    message: 'native_runtime_artifacts_unverified', diagnostic: '{"stage":"manifest","reason":"manifest_invalid","purpose":"current"}' });
  electron.ipcMain.handle('devryan:invoke', async () => null);
  assert.equal(await handlers.get('devryan:invoke')({}, 'desktop_restart'), null);
  assert.equal(context.__devryanUpgradeQa.restart.state, 'returned');
});

test('main-process inspector installs fixture before updater captures fetch', { timeout: 20_000 }, async t => {
  const { feed } = await fixture(t);
  const inspectorPort = await reservePort();
  const child = startOwnedProcess(process.execPath, [`--inspect-brk=127.0.0.1:${inspectorPort}`, '-e',
    `const fetchImpl = fetch; fetchImpl(${JSON.stringify(feedUrl)}).then(r=>r.json()).then(p=>console.log('fixture-version='+p.tag_name));`], { cwd: process.cwd(), env: { PATH: process.env.PATH } });
  t.after(async () => { closeInspectorSessions(owned); await child.stop(); });
  const owned = { inspectorPort, inspectorTargets: new Set() };
  const deadline = Date.now() + 10_000;
  while (!await prepareFixtureInspector(owned, feed)) {
    child.check(); assert.ok(Date.now() < deadline, 'inspector startup deadline');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  while (!child.getLog().includes('fixture-version=v2.1.14')) {
    assert.ok(Date.now() < deadline, child.getLog()); await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(feed.requests.discovery, 1);
});

test('the feed mirror serves the exact /releases/latest bytes and redirects only the canonical feed URL', async t => {
  const body = '{"tag_name":"v2.1.17","assets":[]}';
  const mirror = await createFeedMirror({ status: 200, body });
  t.after(() => mirror.close());
  const response = await fetch(`${mirror.origin}/latest`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
  assert.equal((await fetch(`${mirror.origin}/candidate`)).status, 404);
  assert.equal(mirror.requests.discovery, 1);
  const calls = [];
  const context = { URL, fetch: (url, options) => { calls.push([url, options]); } };
  vm.runInNewContext(mirror.script, context);
  context.fetch(feedUrl, { signal: 's' }); context.fetch('https://github.com/1H-Team/DevRyan/releases/download/v2.1.17/DevRyan-2.1.17-arm64.dmg');
  assert.deepEqual(calls.map(([url]) => url), [`${mirror.origin}/latest`, 'https://github.com/1H-Team/DevRyan/releases/download/v2.1.17/DevRyan-2.1.17-arm64.dmg']);
  const missing = await createFeedMirror({ status: 404, body: '{"message":"Not Found"}' });
  t.after(() => missing.close());
  assert.equal((await fetch(`${missing.origin}/latest`)).status, 404);
  await assert.rejects(createFeedMirror({ status: 403, body: '' }), /real feed status/);
  assert.throws(() => feedMirrorScript({ origin: 'https://external.example' }), /loopback/);
});

test('a process started with --inspect-brk still starts its worker threads once the fixture is installed', { timeout: 20_000 }, async t => {
  // An inspected main holds every new Worker until a debugger releases it; the
  // session-mutation host is one, so 2.1.14+ never became ready under QA.
  const inspectorPort = await reservePort();
  const child = startOwnedProcess(process.execPath, [`--inspect-brk=127.0.0.1:${inspectorPort}`, '-e',
    `const { Worker } = require('node:worker_threads');
     const start = () => new Worker('require("node:worker_threads").parentPort.postMessage("ran")', { eval: true }).on('message', m => console.log('worker=' + m));
     start(); setTimeout(start, 300); setTimeout(() => {}, 10_000);`], { cwd: process.cwd(), env: { PATH: process.env.PATH } });
  const owned = { inspectorPort, inspectorTargets: new Set() };
  t.after(async () => { closeInspectorSessions(owned); await child.stop(); });
  const deadline = Date.now() + 10_000;
  while (!await prepareFixtureInspector(owned, { script: 'true' })) {
    child.check(); assert.ok(Date.now() < deadline, 'inspector startup deadline');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  while ((child.getLog().match(/worker=ran/g) ?? []).length < 2) {
    assert.ok(Date.now() < deadline, `workers stayed paused: ${child.getLog()}`); await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(owned.inspectorSessions.length, 1);
  closeInspectorSessions(owned);
  assert.deepEqual(owned.inspectorSessions, []);
});

test('an inspected owner can exit only after QA closes its inspector session', { timeout: 20_000 }, async t => {
  // The installer waits for the owner to exit; an attached debugger holds it open.
  const inspectorPort = await reservePort();
  const child = startOwnedProcess(process.execPath, [`--inspect-brk=127.0.0.1:${inspectorPort}`, '-e', `console.log('finished')`],
    { cwd: process.cwd(), env: { PATH: process.env.PATH } });
  const owned = { inspectorPort, inspectorTargets: new Set() };
  t.after(async () => { closeInspectorSessions(owned); await child.stop(); });
  const deadline = Date.now() + 10_000;
  while (!await prepareFixtureInspector(owned, { script: 'true' })) {
    child.check(); assert.ok(Date.now() < deadline, 'inspector startup deadline');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const exited = () => child.child.exitCode !== null || child.child.signalCode !== null;
  while (!child.getLog().includes('finished')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 50)); }
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.equal(exited(), false, 'the attached session holds the finished process');
  closeInspectorSessions(owned);
  while (!exited()) { assert.ok(Date.now() < deadline, 'the process exits once the session closes'); await new Promise(resolve => setTimeout(resolve, 50)); }
});
