import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { observeStartupBackgroundWork, assertNativeStartupPackageSource, assertNativeStartupUpgrade, assertNativeUpgradeBaseline, observeNativeStartupSubscription, parseNativeStartupArgs, readNativeStartupLogs,
  summarizeNativeStartupRuns } from './native-startup-benchmark.mjs';
import { parseStartupPhaseLogs } from '../perf/electron-lifecycle-benchmark.mjs';
import { runtimeUiBundleLayout } from './native-backend-ui-diagnostic.mjs';
import { resolveRuntimeBundleRoot } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-root.js';

const encode = value => Buffer.from(value).toString('base64');
const ready = 'event: devryan.subscription-ready\ndata: {"type":"ready","scope":"global"}\n\n';
const response = requestId => ({ requestId, response: { url: 'http://127.0.0.1:4567/api/global/event', status: 200, mimeType: 'text/event-stream' } });
const flush = () => new Promise(resolve => setImmediate(resolve));
test('historical startup source is pinned only for the previous-policy baseline', () => {
  const previous='a'.repeat(64),current='b'.repeat(64);
  assert.doesNotThrow(()=>assertNativeStartupPackageSource(current,current,'optimized'));
  assert.doesNotThrow(()=>assertNativeStartupPackageSource(previous,current,'previous',previous));
  assert.throws(()=>assertNativeStartupPackageSource(previous,current,'optimized',previous));
  assert.throws(()=>assertNativeStartupPackageSource(previous,current,'previous',current));
  assert.throws(()=>assertNativeStartupPackageSource(previous,current,'previous','unrecorded'));
  assert.throws(()=>assertNativeStartupPackageSource(previous,current,'previous'));
});
function fakeCdp(bufferedData = '') {
  const listeners = new Map();
  const calls = [];
  return { calls, listeners,
    on(event, callback) {
      const entries = listeners.get(event) ?? new Set();
      entries.add(callback); listeners.set(event, entries);
      return () => entries.delete(callback);
    },
    async send(method, params) { calls.push({ method, params }); return { bufferedData }; },
    emit(event, data) { for (const callback of listeners.get(event) ?? []) callback(data); },
  };
}

test('native startup CLI requires explicit absolute package and bundle inputs', () => {
  assert.deepEqual(parseNativeStartupArgs(['--package-evidence', '/repo/package.json', '--artifact-root', '/repo/native']),
    { packageEvidence: '/repo/package.json', artifactRoot: '/repo/native' });
  assert.deepEqual(parseNativeStartupArgs(['--package-evidence', '/repo/package.json', '--artifact-root', '/repo/native', '--baseline-artifact-root', '/repo/baseline']),
    { packageEvidence: '/repo/package.json', artifactRoot: '/repo/native', baselineArtifactRoot: '/repo/baseline' });
  for (const args of [[], ['--artifact-root', '/native', '--package-evidence', '/package'],
    ['--package-evidence', 'relative', '--artifact-root', '/native'],
    ['--package-evidence', '/package', '--artifact-root', '/native', '--reload'],
    ['--package-evidence', '/package', '--artifact-root', '/native', '--baseline-artifact-root', 'relative']]) assert.throws(() => parseNativeStartupArgs(args), /Usage/);
});

test('upgrade preparation uses the normal canonical root and lets production provisioning run', () => {
  const runtimeRoot = '/repository/.cache/test-fixtures/native-startup-example';
  const launch = { global: Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'tmp'].map(key => [key, `${runtimeRoot}/baseline/${key}`])),
    webDataDirectory: `${runtimeRoot}/baseline/web-data` };
  const regular = runtimeUiBundleLayout(runtimeRoot), upgrade = runtimeUiBundleLayout(runtimeRoot, true);
  assert.equal(regular.controlRoot, `${runtimeRoot}/bundles`);
  assert.equal(upgrade.controlRoot, `${runtimeRoot}/state/devryan/runtime-bundles`);
  const ordinaryEnv = regular.createLaunchEnvironment({ controlRoot: regular.controlRoot, descriptor: { launch } });
  const upgradeEnv = upgrade.createLaunchEnvironment({ controlRoot: upgrade.controlRoot, descriptor: { launch } });
  assert.equal(ordinaryEnv.DEVRYAN_RUNTIME_BUNDLE_ROOT, regular.controlRoot);
  assert.equal(upgradeEnv.DEVRYAN_RUNTIME_BUNDLE_ROOT, undefined);
  assert.equal(upgradeEnv.XDG_STATE_HOME, `${runtimeRoot}/state`);
  assert.equal(resolveRuntimeBundleRoot(upgradeEnv, launch.global.home), upgrade.controlRoot);
  assert.equal(upgradeEnv.HOME, launch.global.home);
  assert.equal(upgradeEnv.OPENCHAMBER_DATA_DIR, launch.webDataDirectory);
  assert.throws(() => upgrade.createLaunchEnvironment({ controlRoot: regular.controlRoot, descriptor: { launch } }));
  assert.throws(() => runtimeUiBundleLayout(runtimeRoot, 'true'));
  assert.throws(() => runtimeUiBundleLayout('relative', true));
});

test('upgrade evidence requires exactly one committed transition to the reviewed candidate', () => {
  const initial = { bundleID: 'candidate', revision: 1, previousBundleID: null, opencodeVersion: '2.0.20', artifactManifestSha256: 'a'.repeat(64) };
  const candidate = { opencodeVersion: '2.0.26', artifactManifestSha256: 'b'.repeat(64) };
  const final = { ...candidate, bundleID: 'native-upgrade', revision: 2, previousBundleID: initial.bundleID };
  assert.doesNotThrow(() => assertNativeStartupUpgrade(initial, final, candidate));
  assert.doesNotThrow(() => assertNativeStartupUpgrade({...initial,opencodeVersion:candidate.opencodeVersion}, final, candidate));
  assert.throws(() => assertNativeUpgradeBaseline(candidate.opencodeVersion,candidate.opencodeVersion,candidate.artifactManifestSha256,candidate.artifactManifestSha256));
  for (const change of [{ revision: 1 }, { revision: 3 }, { bundleID: initial.bundleID }, { previousBundleID: null },
    { opencodeVersion: '2.0.20' }, { artifactManifestSha256: initial.artifactManifestSha256 }]) {
    assert.throws(() => assertNativeStartupUpgrade(initial, { ...final, ...change }, candidate));
  }
  for (const version of ['2.0.26', '2.0.27', '2.0.20-dev', '1.0.20']) assert.throws(() => assertNativeUpgradeBaseline(version, candidate.opencodeVersion));
});

test('native startup observes buffered fetch-SSE acknowledgement without navigation', async () => {
  const cdp = fakeCdp(encode(ready)), observer = observeNativeStartupSubscription(cdp, performance.now());
  cdp.emit('Network.responseReceived', response('global'));
  await flush();
  assert.equal(observer.isReady(), true);
  assert.ok(observer.evidence.readyAcknowledgedAtMs >= 0);
  assert.deepEqual(cdp.calls, [{ method: 'Network.streamResourceContent', params: { requestId: 'global' } }]);
  observer.close();
  assert.equal([...cdp.listeners.values()].every(entries => entries.size === 0), true);
});

test('native startup observes the real renderer global WebSocket ready frame and rejects other scopes', () => {
  const cdp = fakeCdp(), observer = observeNativeStartupSubscription(cdp, performance.now(), 'http://127.0.0.1:4567');
  const socket = (requestId, url) => cdp.emit('Network.webSocketCreated', { requestId, url });
  const frame = (requestId, payloadData, opcode = 1) => cdp.emit('Network.webSocketFrameReceived', { requestId, response: { opcode, payloadData } });
  const ack = JSON.stringify({ type: 'ready', scope: 'global' });
  socket('directory', 'ws://127.0.0.1:4567/api/event/ws'); frame('directory', ack);
  socket('other-port', 'ws://127.0.0.1:4568/api/global/event/ws'); frame('other-port', ack);
  socket('external', 'ws://example.com/api/global/event/ws'); frame('external', ack);
  assert.equal(observer.isReady(), false);
  socket('owned', 'ws://127.0.0.1:4567/api/global/event/ws?clientID=owned');
  for (const payload of ['not-json', '{"type":"ready"}', '{"type":"ready","scope":"directory"}', '{"type":"event","payload":{"type":"ready","scope":"global"}}']) frame('owned', payload);
  frame('owned', encode(ack), 2);
  assert.equal(observer.isReady(), false);
  frame('owned', ack);
  assert.equal(observer.isReady(), true);
  assert.equal(observer.evidence.transport, 'websocket');
  assert.ok(observer.evidence.readyAcknowledgedAtMs >= 0);
  assert.deepEqual(cdp.calls, []);
  cdp.emit('Network.loadingFinished', { requestId: 'owned' });
  assert.equal(observer.isReady(), true, 'HTTP request completion does not close a WebSocket');
  socket('replacement', 'ws://127.0.0.1:4567/api/global/event/ws'); frame('replacement', ack);
  cdp.emit('Network.webSocketClosed', { requestId: 'owned' });
  assert.equal(observer.isReady(), true);
  cdp.emit('Network.webSocketFrameError', { requestId: 'replacement' });
  assert.equal(observer.isReady(), false);
  socket('reconnect', 'ws://127.0.0.1:4567/api/global/event/ws'); frame('reconnect', ack);
  assert.equal(observer.isReady(), true);
  frame('reconnect', '{"type":"error","message":"upstream unavailable"}');
  assert.equal(observer.isReady(), false);
  observer.close();
  assert.equal([...cdp.listeners.values()].every(entries => entries.size === 0), true);
});

test('native phase observation uses owned private-home main.log and captured child output', async t => {
  const fixtures = path.resolve('.cache/test-fixtures'); await fs.mkdir(fixtures, { recursive: true });
  const home = await fs.mkdtemp(path.join(fixtures, 'native-phase-log-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = { getLog: () => '[electron] startup phase { phase: "server_import", outcome: "completed", elapsedMs: 125 }' };
  assert.deepEqual(parseStartupPhaseLogs(readNativeStartupLogs(app, home)), [{ phase: 'server_import', outcome: 'completed', elapsedMs: 125, code: undefined }]);
  const directory = path.join(home, 'Library/Logs/DevRyan'); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'main.log'), '[electron] startup phase { phase: "server_listen", outcome: "completed", elapsedMs: 40 }\n');
  const phases = parseStartupPhaseLogs(readNativeStartupLogs(app, home));
  assert.deepEqual(phases.map(record => [record.phase, record.elapsedMs]), [['server_import', 125], ['server_listen', 40]]);
});

test('native startup preserves buffered-before-live order and split CRLF frames', async () => {
  const cdp = fakeCdp();
  let resolveStream;
  cdp.send = () => new Promise(resolve => { resolveStream = resolve; });
  const observer = observeNativeStartupSubscription(cdp, performance.now());
  cdp.emit('Network.responseReceived', response('global'));
  const frame = ready.replaceAll('\n', '\r\n'), split = frame.indexOf('\r') + 1;
  cdp.emit('Network.dataReceived', { requestId: 'global', data: encode(frame.slice(split)) });
  assert.equal(observer.isReady(), false);
  resolveStream({ bufferedData: encode(frame.slice(0, split)) });
  await flush();
  assert.equal(observer.isReady(), true);
  observer.close();
});

test('native startup rejects health, unrelated streams and non-global acknowledgement', async () => {
  const cdp = fakeCdp(), observer = observeNativeStartupSubscription(cdp, performance.now());
  cdp.emit('Network.responseReceived', { ...response('health'), response: { ...response('').response, url: 'http://127.0.0.1:4567/health' } });
  cdp.emit('Network.dataReceived', { requestId: 'health', data: encode(ready) });
  assert.equal(cdp.calls.length, 0);
  cdp.emit('Network.responseReceived', response('global'));
  await flush();
  cdp.emit('Network.dataReceived', { requestId: 'global', data: encode(ready.replace('"global"', '"directory"')) });
  cdp.emit('Network.dataReceived', { requestId: 'global', data: encode('data: {"healthy":true}\n\n') });
  assert.equal(observer.isReady(), false);
  observer.close();
});

test('an obsolete stream stopping does not invalidate the current ready stream', async () => {
  const cdp = fakeCdp(encode(ready)), observer = observeNativeStartupSubscription(cdp, performance.now());
  cdp.emit('Network.responseReceived', response('old')); await flush();
  cdp.emit('Network.responseReceived', response('current')); await flush();
  cdp.emit('Network.loadingFailed', { requestId: 'old' });
  assert.equal(observer.isReady(), true);
  cdp.emit('Network.loadingFinished', { requestId: 'current' });
  assert.equal(observer.isReady(), false);
  observer.close();
});

test('unsupported streaming capture fails explicitly without inventing readiness', async () => {
  const cdp = fakeCdp(); cdp.send = async () => { throw new Error('Unsupported protocol'); };
  const observer = observeNativeStartupSubscription(cdp, performance.now());
  cdp.emit('Network.responseReceived', response('global')); await flush();
  assert.equal(observer.isReady(), false);
  assert.throws(observer.check, /qa_startup_sse_capture_unavailable/);
  observer.close();
});

test('native startup summaries require all three usable starts and successful cleanup', () => {
  const runs = [30, 10, 20].map(uiReadyMs => ({ startup: { outcome: 'passed', uiReadyMs }, cleanupErrors: [] }));
  assert.deepEqual(summarizeNativeStartupRuns(runs), { launches: 3, medianUiReadyMs: 20, minimumUiReadyMs: 10, maximumUiReadyMs: 30 });
  assert.throws(() => summarizeNativeStartupRuns(runs.slice(1)), /three fresh launches/);
  assert.throws(() => summarizeNativeStartupRuns([{ ...runs[0], cleanupErrors: ['cleanup_failed'] }, ...runs.slice(1)]), /cleanup must pass/);
  assert.throws(() => summarizeNativeStartupRuns([{ startup: { outcome: 'passed', uiReadyMs: NaN } }, ...runs.slice(1)]), /parent clock/);
});

test('direct service smoke uses candidate version and labels the limits of three host starts', async () => {
  const source = await fs.readFile(new URL('./packaged-service-smoke.mjs', import.meta.url), 'utf8');
  assert.match(source, /version: appVersion/);
  assert.match(source, /assert\.equal\(descriptor\.appVersion, appVersion\)/);
  assert.match(source, /iteration < 3/);
  assert.match(source, /usable-UI/);
  assert.match(source, /native-model-readiness/);
  assert.doesNotMatch(source, /descriptor\.appVersion, ['"]2\.0\.2/);
});


test('background startup evidence counts only owned fixed endpoints and cleans up', () => {
  const cdp = fakeCdp(), observer = observeStartupBackgroundWork(cdp, performance.now(), 'http://127.0.0.1:4567');
  const request = url => cdp.emit('Network.requestWillBeSent', { request: { url, postData: 'must never be retained' } });
  request('http://127.0.0.1:9999/api/startup/agent-runtime-warmup');
  request('https://example.com/api/openchamber/update-check');
  request('not a URL');
  assert.deepEqual(observer.evidence, { agentWarmupAtMs: null, updateChecks: 0 });
  request('http://127.0.0.1:4567/api/startup/agent-runtime-warmup?directory=private');
  request('http://127.0.0.1:4567/api/openchamber/update-check?private=value');
  assert.ok(observer.evidence.agentWarmupAtMs >= 0);
  assert.equal(observer.evidence.updateChecks, 1);
  assert.equal(JSON.stringify(observer.evidence).includes('private'), false);
  observer.close();
  assert.equal([...cdp.listeners.values()].every(entries => entries.size === 0), true);
});
