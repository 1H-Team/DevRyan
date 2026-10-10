// Three fresh packaged app-bound starts against the actual native backend and a
// local HTTP model fixture. No launchd, installed state, or external OpenCode.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { TARGET_OPENCODE_VERSION } from '../../packages/web/server/lib/opencode/version-policy.js';
import { assertStartupMode, captureFirstDocumentStartup, observeStartupNavigation, parseStartupPhaseLogs } from '../perf/electron-lifecycle-benchmark.mjs';
import { captureQaSourceIdentity } from './artifact-evidence.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { prepareRuntimeUiProfile, runtimeUiTuple } from './native-backend-ui-diagnostic.mjs';
import { loadQaPackagedArtifact } from './packaged-artifact.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { createRunRoot } from './run-root.mjs';
import { syntheticCursorProvider, syntheticAnthropicProvider } from './startup-catalog-reproduction.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseNativeStartupArgs(argv) {
  if (![4, 6].includes(argv.length) || argv[0] !== '--package-evidence' || argv[2] !== '--artifact-root'
    || !path.isAbsolute(argv[1]) || !path.isAbsolute(argv[3])
    || argv.length === 6 && (argv[4] !== '--baseline-artifact-root' || !path.isAbsolute(argv[5]))) {
    throw new Error('Usage: bun scripts/qa/native-startup-benchmark.mjs --package-evidence <absolute> --artifact-root <absolute> [--baseline-artifact-root <absolute>]');
  }
  return { packageEvidence: argv[1], artifactRoot: argv[3], ...(argv.length === 6 ? { baselineArtifactRoot: argv[5] } : {}) };
}

export function parseStartupComparisonArgs(argv) {
  const flags = ['--baseline-package-evidence', '--candidate-package-evidence', '--artifact-root'];
  assert.ok(argv.length === 6 || argv.length === 8, 'Comparison requires explicit baseline, candidate and native artifacts');
  for (let index = 0; index < flags.length; index++) {
    assert.equal(argv[index * 2], flags[index], 'Unexpected comparison option');
    assert.ok(path.isAbsolute(argv[index * 2 + 1]), 'Comparison artifacts must be absolute');
  }
  if (argv.length === 8) assert.equal(argv[6], '--startup-mode');
  const startupMode = argv[7] ?? 'natural';
  assertStartupMode(startupMode);
  return { baselinePackageEvidence: argv[1], candidatePackageEvidence: argv[3], artifactRoot: argv[5], startupMode };
}

export function assertNativeStartupUpgrade(initial, final, candidate) {
  assertNativeUpgradeBaseline(initial.opencodeVersion, candidate.opencodeVersion, initial.artifactManifestSha256, candidate.artifactManifestSha256);
  assert.equal(final.revision, initial.revision + 1, 'Startup must commit one selection transition');
  assert.notEqual(final.bundleID, initial.bundleID, 'Startup must select a new bundle');
  assert.equal(final.previousBundleID, initial.bundleID, 'The baseline must remain the rollback target');
  assert.equal(final.opencodeVersion, candidate.opencodeVersion);
  assert.equal(final.artifactManifestSha256, candidate.artifactManifestSha256);
}

export function assertNativeUpgradeBaseline(baselineVersion, candidateVersion, baselineDigest, candidateDigest) {
  const [baseline, candidate] = [baselineVersion, candidateVersion].map(version => {
    assert.match(version, /^2\.\d+\.\d+$/, 'Upgrade versions must be exact native releases');
    return version.split('.').map(Number);
  });
  const repaired = baselineVersion === candidateVersion && /^[a-f0-9]{64}$/.test(baselineDigest ?? '')
    && /^[a-f0-9]{64}$/.test(candidateDigest ?? '') && baselineDigest !== candidateDigest;
  assert.ok(repaired || baseline[1] < candidate[1] || baseline[1] === candidate[1] && baseline[2] < candidate[2], 'An upgrade requires an older baseline or a distinct repaired artifact');
}

const readBundleStartupState = controlRoot => {
  const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot });
  const bytes = readFileSync(binding.descriptor.launch.artifactManifestPath);
  assert.equal(hash(bytes), binding.descriptor.launch.artifactManifestSha256, 'Selected artifact manifest changed');
  const manifest = JSON.parse(bytes);
  return { bundleID: binding.descriptor.bundleID, revision: binding.selection.revision,
    previousBundleID: binding.selection.previousBundleID, opencodeVersion: manifest.opencodeVersion,
    artifactManifestSha256: binding.descriptor.launch.artifactManifestSha256 };
};

/** Observe the renderer's global ready ACK over its actual transport; retain no messages. */
export function observeNativeStartupSubscription(cdp, startedAt, origin) {
  const streams = new Map();
  const sockets = new Set();
  let readyRequestId = null;
  let closed = false;
  const evidence = { readyAcknowledgedAtMs: null, transport: null, error: null };
  const markReady = (requestId, transport) => {
    readyRequestId = requestId;
    evidence.transport = transport;
    evidence.readyAcknowledgedAtMs ??= performance.now() - startedAt;
  };
  const stopped = requestId => {
    streams.delete(requestId); sockets.delete(requestId);
    if (readyRequestId === requestId) {
      readyRequestId = null; evidence.readyAcknowledgedAtMs = null; evidence.transport = null;
    }
  };
  const ownedUrl = (candidate, protocol, paths) => {
    try {
      const url = new URL(candidate);
      return url.protocol === protocol && url.hostname === '127.0.0.1' && paths.includes(url.pathname)
        && (!origin || url.host === new URL(origin).host);
    } catch { return false; }
  };
  const accept = (requestId, encoded) => {
    const stream = streams.get(requestId);
    if (!stream || typeof encoded !== 'string') return;
    stream.buffer += stream.decoder.decode(Buffer.from(encoded, 'base64'), { stream: true });
    stream.buffer = stream.buffer.replaceAll('\r\n', '\n');
    if (stream.buffer.length > 512 * 1024) { evidence.error = 'qa_startup_sse_frame_overflow'; return; }
    const frames = stream.buffer.split('\n\n');
    stream.buffer = frames.pop();
    for (const frame of frames) {
      if (!frame.split('\n').some(line => line === 'event: devryan.subscription-ready')) continue;
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      let ready;
      try { ready = JSON.parse(data); } catch { continue; }
      if (ready?.type === 'ready' && ready.scope === 'global') markReady(requestId, 'fetch-sse');
    }
  };
  const removers = [
    cdp.on('Network.responseReceived', ({ requestId, response }) => {
      if (!ownedUrl(response?.url, 'http:', ['/api/global/event', '/global/event'])
        || response.status !== 200 || response.mimeType !== 'text/event-stream') return;
      const stream = { decoder: new TextDecoder(), buffer: '', pending: [] };
      streams.set(requestId, stream);
      void cdp.send('Network.streamResourceContent', { requestId }).then(({ bufferedData }) => {
        accept(requestId, bufferedData);
        for (const data of stream.pending) accept(requestId, data);
        stream.pending = null;
      }).catch(() => { if (!closed) evidence.error = 'qa_startup_sse_capture_unavailable'; });
    }),
    cdp.on('Network.dataReceived', ({ requestId, data }) => {
      const stream = streams.get(requestId);
      if (stream?.pending && typeof data === 'string') stream.pending.push(data);
      else accept(requestId, data);
    }),
    cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
      if (ownedUrl(url, 'ws:', ['/api/global/event/ws'])) sockets.add(requestId);
    }),
    cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      if (!sockets.has(requestId) || response?.opcode !== 1 || typeof response.payloadData !== 'string') return;
      let frame;
      try { frame = JSON.parse(response.payloadData); } catch { return; }
      if (frame?.type === 'ready' && frame.scope === 'global') markReady(requestId, 'websocket');
      else if (frame?.type === 'error') stopped(requestId);
    }),
    ...['Network.loadingFailed', 'Network.loadingFinished']
      .map(event => cdp.on(event, ({ requestId }) => { if (streams.has(requestId)) stopped(requestId); })),
    ...['Network.webSocketClosed', 'Network.webSocketFrameError']
      .map(event => cdp.on(event, ({ requestId }) => { if (sockets.has(requestId)) stopped(requestId); })),
  ];
  return { evidence, isReady: () => evidence.readyAcknowledgedAtMs !== null && !evidence.error,
    check: () => { if (evidence.error) throw new Error(evidence.error); },
    close: () => { closed = true; removers.forEach(remove => remove()); streams.clear(); sockets.clear(); } };
}

/** Only fixed endpoint timings/counts are retained, never request bodies or URLs. */
export function observeStartupBackgroundWork(cdp, startedAt, origin) {
  const evidence = { agentWarmupAtMs: null, updateChecks: 0 };
  const close = cdp.on('Network.requestWillBeSent', ({ request }) => {
    let url;
    try { url = new URL(request?.url); } catch { return; }
    if (url.origin !== origin) return;
    if (url.pathname === '/api/startup/agent-runtime-warmup') evidence.agentWarmupAtMs ??= performance.now() - startedAt;
    if (url.pathname === '/api/openchamber/update-check') evidence.updateChecks++;
  });
  return { evidence, close };
}

export function readNativeStartupLogs(app, qaHome) {
  const logs = [app?.getLog() ?? ''];
  // electron-log resolves its file beneath the isolated app home on this QA
  // host. Never search the user's Library or infer it from an installed app.
  try { logs.push(readFileSync(path.join(qaHome, 'Library/Logs/DevRyan/main.log'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return logs.join('\n');
}

export function summarizeNativeStartupRuns(runs) {
  assert.equal(runs.length, 3, 'Native startup measurements require three fresh launches');
  assert.ok(runs.every(run => run.startup?.outcome === 'passed' && !run.cleanupErrors?.length), 'Every startup and cleanup must pass');
  const values = runs.map(run => run.startup.uiReadyMs).sort((a, b) => a - b);
  assert.ok(values.every(value => Number.isFinite(value) && value >= 0), 'Startup timings must use the parent clock');
  return { launches: 3, medianUiReadyMs: values[1], minimumUiReadyMs: values[0], maximumUiReadyMs: values[2] };
}

export function assertNativeStartupPackageSource(packaged, current, startupPolicy, baselineSourceSha256) {
  if (baselineSourceSha256 !== undefined) {
    assert.equal(startupPolicy, 'previous', 'Only a recorded baseline may use historical source');
    assert.match(baselineSourceSha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(packaged, baselineSourceSha256 ?? current, 'Package source differs from the reviewed cohort');
}

async function readStartupCatalogFixture() {
  let catalogProviders;
  if (process.env.DEVRYAN_QA_CATALOG_CONFIG) {
    const file = await fs.realpath(process.env.DEVRYAN_QA_CATALOG_CONFIG);
    assert.ok(file.startsWith(path.join(repository, '.cache/sessions') + path.sep));
    const provider = JSON.parse(await fs.readFile(file, 'utf8'));
    catalogProviders = { ...syntheticCursorProvider({ provider }), ...syntheticAnthropicProvider({ provider }) };
  }
  return catalogProviders;
}

export async function runNativeStartupBenchmark(options) {
  return runStartupLaunches(options);
}

async function runStartupLaunches({ packageEvidence, artifactRoot, baselineArtifactRoot, startupMode = 'natural', startupPolicy = 'optimized', baselineSourceSha256 }, comparisonSource, comparisonCatalog) {
  assertStartupMode(startupMode);
  assert.ok(['optimized','previous'].includes(startupPolicy), 'Explicit startup comparison policy required');
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !globalThis.Bun) throw new Error('Native packaged startup measurement requires pinned Bun on Darwin ARM64');
  const before = await captureQaSourceIdentity(repository);
  const legacyOpenAiBrowser = process.env.DEVRYAN_QA_LEGACY_OPENAI_BROWSER === '1';
  const catalogProviders = comparisonCatalog ?? await readStartupCatalogFixture();
  const packaged = await loadQaPackagedArtifact({ root: repository, evidencePath: packageEvidence });
  if (comparisonSource) assert.equal(packaged.evidence.source.sha256, comparisonSource, 'Comparison package source changed');
  else assertNativeStartupPackageSource(packaged.evidence.source.sha256, before.sha256, startupPolicy, baselineSourceSha256);
  let candidate;
  if (baselineArtifactRoot) {
    assert.ok(artifactRoot.startsWith(repository + path.sep) && await fs.realpath(artifactRoot) === artifactRoot, 'Candidate artifacts must be canonical repository-owned files');
    const candidateBytes = await fs.readFile(path.join(artifactRoot, 'native-bundle.json'));
    const packagedBytes = await fs.readFile(path.join(packaged.evidence.appPath, 'Contents/Resources/revert-runtime/darwin-arm64/native-bundle.json'));
    const manifest = JSON.parse(candidateBytes);
    assert.equal(hash(packagedBytes), hash(candidateBytes), 'Packaged startup upgrade must use the exact reviewed candidate');
    assert.equal(manifest.opencodeVersion, TARGET_OPENCODE_VERSION, 'Upgrade candidate must match the host pin');
    candidate = { opencodeVersion: manifest.opencodeVersion, artifactManifestSha256: hash(candidateBytes) };
  }
  const fixtures = path.join(repository, '.cache/test-fixtures');
  await fs.mkdir(fixtures, { recursive: true, mode: 0o700 });
  assert.equal(await fs.realpath(fixtures), fixtures);
  let activeStop = async () => {};
  const run = createRunRoot({ parent: path.join(repository, '.cache/qa'), prefix: 'native-startup-',
    owner: 'scripts/qa/native-startup-benchmark.mjs', onInterrupt: () => activeStop() });
  const launchScope = comparisonSource ? 'one fresh process/profile' : 'three fresh processes/profiles';
  const evidence = { schemaVersion: 1, kind: candidate ? 'packaged-native-app-bound-startup-upgrade' : 'packaged-native-app-bound-startup', outcome: 'failed',
    scope: candidate ? 'three fresh baseline profiles; production app-bound native startup upgrade; local HTTP model fixture; natural first usable renderer'
      : `${launchScope}; prepared native bundle; local HTTP model fixture; natural first usable renderer`,
    ...(candidate ? { candidate } : {}),
    launches: comparisonSource ? 1 : 3,
    startupMode, ...(startupMode === 'foreground' ? { scope: candidate ? 'three fresh baseline profiles; production startup upgrade; local HTTP model fixture; foreground-controlled admission' : `${launchScope}; prepared native bundle; local HTTP model fixture; foreground-controlled admission`, timingQualification: 'foreground-controlled admission, not natural startup latency' } : {}),
    sourceSha256: before.sha256, packageSourceSha256: packaged.evidence.source.sha256, archiveSha256: packaged.evidence.archiveSha256, startupPolicy, legacyOpenAiBrowser, runs: [],
    catalogFixtureSha256: hash(JSON.stringify(catalogProviders ?? null)),
    unavailable: ['foreground warm service', 'foreground cold service', 'foreground stale-owner recovery', 'foreground service upgrade'],
    excluded: ['launchd/SMAppService registration', 'installed state', 'paid providers', 'first native-bundle provisioning', 'cold OS caches'] };
  try {
    for (let iteration = 0; iteration < (comparisonSource ? 1 : 3); iteration++) {
      const directory = path.join(run.dir, `run-${iteration + 1}`);
      await fs.mkdir(directory, { mode: 0o700 });
      const runtimeRoot = run.own(await fs.mkdtemp(path.join(fixtures, 'native-startup-')));
      const workspace = path.join(runtimeRoot, 'workspace');
      await fs.mkdir(workspace, { mode: 0o700 });
      execFileSync('git', ['init', '--quiet', '--initial-branch=main', '--template=', workspace], { cwd: repository,
        env: { PATH: process.env.PATH, HOME: runtimeRoot, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: fixtures } });
      const sanitize = createDiagnosticSanitizer({ homeDir: process.env.HOME,
        pathMappings: [{ path: runtimeRoot, placeholder: '<QA_RUNTIME>' }, { path: repository, placeholder: '<REPOSITORY>' }] });
      const record = { iteration, startup: null, cleanupErrors: [] };
      evidence.runs.push(record);
      let prepared, app, cdp, audit, subscription, background, removeRuntimeErrors;
      let rendererExceptions = 0;
      let stopping;
      const stop = () => stopping ??= (async () => {
        for (const [owner, close] of [['app', () => app?.stop()], ['provider', () => prepared?.close()]]) {
          try { await close(); } catch { record.cleanupErrors.push(`${owner}_cleanup_failed`); }
        }
      })();
      activeStop = stop;
      try {
        prepared = await prepareRuntimeUiProfile({ cell: { transport: 'runtime-fixture' }, runtimeRoot, workspace, targetGeneration: 2,
          artifactRoot: baselineArtifactRoot ?? artifactRoot, startupUpgrade: Boolean(baselineArtifactRoot), catalogProviders, legacyOpenAiBrowser });
        record.initialBundle = readBundleStartupState(prepared.controlRoot);
        if (candidate) {
          assert.equal(record.initialBundle.revision, 1);
          assert.equal(record.initialBundle.previousBundleID, null);
          assertNativeUpgradeBaseline(record.initialBundle.opencodeVersion, candidate.opencodeVersion, record.initialBundle.artifactManifestSha256, candidate.artifactManifestSha256);
          assert.equal(prepared.env.DEVRYAN_RUNTIME_BUNDLE_ROOT, undefined);
          assert.equal(prepared.env.XDG_STATE_HOME, path.join(runtimeRoot, 'state'));
        }
        const profile = path.join(runtimeRoot, 'profile'), port = await reservePort(), debugPort = await reservePort();
        const settingsPath = path.join(prepared.env.OPENCHAMBER_DATA_DIR, 'settings.json');
        const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
        await fs.writeFile(settingsPath, JSON.stringify({ ...settings, desktopLocalPort: port,
          desktopLanAccessEnabled: false, productionBotsRuntimeMode: 'disabled' }) + '\n', { mode: 0o600 });
        const env = { ...prepared.env, DEVRYAN_QA_RUNTIME: 'electron', OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile,
          GIT_CEILING_DIRECTORIES: fixtures };
        delete env.NODE_OPTIONS;
        const startedAt = performance.now();
        app = startOwnedProcess(packaged.binary, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`], { cwd: workspace, env });
        const target = await discoverPageTarget(debugPort);
        const cdpTargetMs = performance.now() - startedAt;
        cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
        removeRuntimeErrors = cdp.on('Runtime.exceptionThrown', () => { rendererExceptions++; });
        audit = observeStartupNavigation(cdp, startedAt, target.url);
        subscription = observeNativeStartupSubscription(cdp, startedAt, `http://127.0.0.1:${port}`);
        background = observeStartupBackgroundWork(cdp, startedAt, `http://127.0.0.1:${port}`);
        await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable')]);
        const checkAlive = () => { app.check(); subscription.check(); };
        const deadline = performance.now() + 45_000;
        let origin;
        while (!origin) {
          checkAlive();
          const href = await evaluate(cdp, 'location.href').catch(() => '');
          if (/^http:\/\/127\.0\.0\.1:\d+\//.test(href)) origin = new URL(href).origin;
          if (performance.now() > deadline) throw new Error('qa_startup_renderer_origin_timeout');
          if (!origin) await pause(100);
        }
        record.startup = await captureFirstDocumentStartup({ cdp, origin, startedAt, checkAlive, navigationAudit: audit, startupMode,
          ...(startupMode === 'foreground' ? { foregroundWindow: { method: 'desktop_focus_main_window', activate: async () => {
            const result = await evaluate(cdp, 'window.__TAURI__.core.invoke("desktop_focus_main_window", {})');
            assert.equal(result?.focused, true, 'Owned Electron window must acknowledge focus');
            return result;
          } } } : {}),
          runtimeUiTuple: { providerId: runtimeUiTuple.providerID, modelId: runtimeUiTuple.modelID, agent: 'builder' },
          isEventStreamReady: subscription.isReady,
          readStartupPhases: () => parseStartupPhaseLogs(readNativeStartupLogs(app, prepared.env.DEVRYAN_QA_HOME)),
          milestones: { cdpTargetMs, loopbackOriginMs: performance.now() - startedAt } });
        record.subscription = subscription.evidence;
        assert.equal(record.startup.outcome, 'passed', record.startup.error);
        if (catalogProviders) {
          const response = await fetch(new URL('/api/provider?directory=' + encodeURIComponent(workspace), origin), { signal: AbortSignal.timeout(10000) });
          assert.equal(response.status, 200);
          const catalog = await response.json(), cursor = catalog.all.find(row => row.id === 'cursor-acp');
          const expected = Object.keys(catalogProviders['cursor-acp'].models);
          assert.ok(cursor); for (const id of expected) assert.ok(cursor.models[id], 'Packaged catalog must retain every supplied Cursor model');
          record.catalog = { status: response.status, providerID: 'cursor-acp', expected: expected.length, matched: expected.filter(id => cursor.models[id]).length };
        }
        // Include the former three-second automatic-update window in acceptance.
        await pause(4_000);
        checkAlive();
        record.background = background.evidence;
        if (startupPolicy === 'optimized') {
          assert.equal(record.background.updateChecks, 0, 'Startup must not check for updates');
          assert.ok(record.background.agentWarmupAtMs >= record.startup.uiReadyMs,
            'Optional project discovery must start after the app is usable');
        } else {
          assert.ok(record.background.agentWarmupAtMs <= record.startup.uiReadyMs,
            'Previous policy must exercise foreground project discovery');
        }
        if (catalogProviders) {
          const ui = createQaUiDriver(cdp, { checkAlive, timeoutMs: 10000 });
          const ids = Object.keys(catalogProviders['cursor-acp'].models);
          const modelID = ids.includes('composer-2.5') ? 'composer-2.5' : ids.find(id => id !== 'auto' && !id.startsWith('cursor-acp/')) ?? ids[0];
          const label = await evaluate(cdp, `window.__zustand_config_store__?.getState().providers?.find(provider => provider.id === 'cursor-acp')?.models?.find(model => model.id === ${JSON.stringify(modelID)})?.name`);
          assert.ok(typeof label === 'string' && label.length > 0, 'Supplied Cursor model must reach the UI catalog');
          await ui.click({ selector: 'button:has(.model-controls__model-label)' });
          await ui.type(label, 'input[placeholder="Search models"],input[placeholder="Search providers or models"]');
          await ui.waitVisibleText(label);
          record.catalog.pickerModelID = modelID;
          record.catalog.pickerModelVisible = true;
          const picker = await cdp.send('Page.captureScreenshot', { format: 'png' });
          await fs.writeFile(path.join(directory, 'model-picker.png'), Buffer.from(picker.data, 'base64'), { mode: 0o600 });
          await ui.key('Escape', { code: 'Escape' });
        }
        const diagnostics = await fetch(new URL('/api/diagnostics/status', origin), { signal: AbortSignal.timeout(10000) });
        assert.equal(diagnostics.status, 200, 'Journal status must be available');
        const journal = await diagnostics.json();
        record.journal = { gapRecords: journal.gapRecords, lastError: journal.lastError ? 'journal_error' : null };
        assert.equal(journal.gapRecords, 0, 'Startup journal has gaps');
        assert.ok(!journal.lastError, 'Startup journal reported an error');
        assert.equal(rendererExceptions, 0, 'Renderer threw during startup');
        record.finalBundle = readBundleStartupState(prepared.controlRoot);
        if (candidate) assertNativeStartupUpgrade(record.initialBundle, record.finalBundle, candidate);
        await prepared.verifyInputs();
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(directory, 'startup.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
      } catch (error) {
        if (cdp) {
          try {
            const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
            await fs.writeFile(path.join(directory, 'failure.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
          } catch { /* A lost renderer cannot provide visual failure evidence. */ }
        }
        record.error = sanitize.sanitizeText(String(error.message), { highEntropy: false });
        throw error;
      } finally {
        record.rendererExceptions = rendererExceptions;
        removeRuntimeErrors?.(); audit?.complete(); subscription?.close(); background?.close(); cdp?.close();
        await stop();
        activeStop = async () => {};
        if (app) record.cleanup = app.getCleanupEvidence();
        record.subscription ??= subscription?.evidence ?? null;
        let logs = app?.getLog() ?? '';
        if (prepared) {
          try { logs = readNativeStartupLogs(app, prepared.env.DEVRYAN_QA_HOME); }
          catch { record.cleanupErrors.push('main_log_unreadable'); }
        }
        if (prepared) {
          try {
            const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: prepared.controlRoot });
            const journalDirectory = path.join(binding.descriptor.launch.webDataDirectory, 'harness/journal');
            const gaps = execFileSync(process.execPath, ['scripts/journal.mjs', 'gaps', '--dir', journalDirectory, '--verify'],
              { cwd: repository, encoding: 'utf8', timeout: 10000 });
            record.journalGapCheck = gaps.trim() ? 'failed' : 'passed';
            if (gaps.trim()) record.cleanupErrors.push('journal_gaps');
          } catch { record.journalGapCheck = 'unavailable'; record.cleanupErrors.push('journal_gap_check_failed'); }
        }
        await fs.writeFile(path.join(directory, 'startup.log'), sanitize.sanitizeText(logs, { highEntropy: false }), { mode: 0o600 });
        await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      }
      assert.equal(record.cleanupErrors.length, 0, 'Native startup cleanup failed');
    }
    assert.equal((await captureQaSourceIdentity(repository)).sha256, before.sha256, 'Source changed during measurement');
    assert.equal((await loadQaPackagedArtifact({ root: repository, evidencePath: packageEvidence })).evidence.archiveSha256, packaged.evidence.archiveSha256);
    if (candidate) assert.equal(hash(await fs.readFile(path.join(packaged.evidence.appPath,
      'Contents/Resources/revert-runtime/darwin-arm64/native-bundle.json'))), candidate.artifactManifestSha256, 'Packaged native candidate changed during measurement');
    if (!comparisonSource) evidence.summary = summarizeNativeStartupRuns(evidence.runs);
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.error = typeof error.code === 'string' ? error.code : 'qa_native_startup_failed';
  } finally {
    await fs.writeFile(path.join(run.dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    run.finish(evidence.outcome);
  }
  return { ...evidence, output: run.dir };
}

export function summarizeStartupComparison(baseline, candidate) {
  const before = summarizeNativeStartupRuns(baseline), after = summarizeNativeStartupRuns(candidate);
  const improvementPercent = 100 * (before.medianUiReadyMs - after.medianUiReadyMs) / before.medianUiReadyMs;
  const pairedImprovements = baseline.map((run, index) => candidate[index].startup.uiReadyMs < run.startup.uiReadyMs);
  return { baseline: before, candidate: after, improvementPercent, pairedImprovements,
    accepted: improvementPercent >= 5 && pairedImprovements.every(Boolean) };
}

export function assertStartupComparisonSources(baseline, candidate, current) {
  assert.equal(candidate.sha256, current, 'Candidate must match current reviewed source');
  const previous = new Map(baseline.entries.map(entry => [entry.file, entry.sha256]));
  const next = new Map(candidate.entries.map(entry => [entry.file, entry.sha256]));
  const changed = [...new Set([...previous.keys(), ...next.keys()])].filter(file => previous.get(file) !== next.get(file));
  assert.ok(changed.length > 0, 'Comparison requires an actual candidate');
  const allowed = ['packages/ui/src/App.tsx', 'packages/web/server/lib/opencode/feature-routes-runtime.js'];
  assert.ok(changed.every(file => allowed.includes(file)), 'Comparison changed files outside the startup candidates');
  for (const source of [baseline, candidate]) {
    assert.equal(hash(JSON.stringify(source.entries)), source.sha256, 'Source receipt is invalid');
  }
  return changed;
}

export async function runNativeStartupComparison({ baselinePackageEvidence, candidatePackageEvidence, artifactRoot, startupMode = 'natural' }) {
  assertStartupMode(startupMode);
  assert.ok(typeof artifactRoot === 'string' && artifactRoot.startsWith(path.join(repository, '.cache') + path.sep),
    'Comparison native artifacts must stay in the repository cache');
  assert.equal(await fs.realpath(artifactRoot), artifactRoot, 'Comparison native artifacts must be canonical');
  const before = await captureQaSourceIdentity(repository);
  const baseline = await loadQaPackagedArtifact({ root: repository, evidencePath: baselinePackageEvidence });
  const candidate = await loadQaPackagedArtifact({ root: repository, evidencePath: candidatePackageEvidence });
  const catalogProviders = await readStartupCatalogFixture();
  const changed = assertStartupComparisonSources(baseline.evidence.source, candidate.evidence.source, before.sha256);
  assert.equal(baseline.evidence.electronVersion, candidate.evidence.electronVersion);
  assert.deepEqual(baseline.evidence.nativeArtifacts.map(({ relative, sha256 }) => ({ relative, sha256 })),
    candidate.evidence.nativeArtifacts.map(({ relative, sha256 }) => ({ relative, sha256 })));
  const nativeManifest = async packaged => hash(await fs.readFile(path.join(packaged.evidence.appPath, 'Contents/Resources/revert-runtime/darwin-arm64/native-bundle.json')));
  const nativeDigest = await nativeManifest(baseline);
  assert.equal(await nativeManifest(candidate), nativeDigest, 'Native runtime versions must match');
  assert.equal(hash(await fs.readFile(path.join(artifactRoot, 'native-bundle.json'))), nativeDigest, 'Fixture must match packaged native runtime');
  const run = createRunRoot({ parent: path.join(repository, '.cache/qa'), prefix: 'startup-comparison-', owner: 'scripts/qa/native-startup-benchmark.mjs' });
  const evidence = { outcome: 'failed', startupMode, changed, nativeDigest, catalogFixtureSha256: hash(JSON.stringify(catalogProviders ?? null)), order: ['B1', 'C1', 'C2', 'B2', 'B3', 'C3'],
    baselineSourceSha256: baseline.evidence.source.sha256, candidateSourceSha256: candidate.evidence.source.sha256,
    baselineArchiveSha256: baseline.evidence.archiveSha256, candidateArchiveSha256: candidate.evidence.archiveSha256,
    baseline: [], candidate: [] };
  try {
    for (const label of evidence.order) {
      const packaged = label[0] === 'B' ? baseline : candidate;
      const result = await runStartupLaunches({ packageEvidence: packaged.evidencePath, artifactRoot, startupMode }, packaged.evidence.source.sha256, catalogProviders);
      evidence[label[0] === 'B' ? 'baseline' : 'candidate'].push(...result.runs);
      assert.equal(result.outcome, 'passed', `Launch ${label} failed: ${result.output}`);
      assert.equal((await captureQaSourceIdentity(repository)).sha256, before.sha256, 'Source changed during comparison');
    }
    for (const packaged of [baseline, candidate]) {
      const final = await loadQaPackagedArtifact({ root: repository, evidencePath: packaged.evidencePath });
      assert.equal(final.evidence.archiveSha256, packaged.evidence.archiveSha256, 'Comparison archive changed');
      assert.equal(final.evidence.source.sha256, packaged.evidence.source.sha256, 'Comparison source receipt changed');
    }
    assert.equal(await nativeManifest(baseline), nativeDigest);
    assert.equal(await nativeManifest(candidate), nativeDigest);
    evidence.summary = summarizeStartupComparison(evidence.baseline, evidence.candidate);
    evidence.outcome = 'passed';
  } catch (error) { evidence.error = error.message; }
  finally {
    await fs.writeFile(path.join(run.dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    run.finish(evidence.outcome);
  }
  return { ...evidence, output: run.dir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const result = argv[0] === '--baseline-package-evidence'
    ? await runNativeStartupComparison(parseStartupComparisonArgs(argv))
    : await runNativeStartupBenchmark(parseNativeStartupArgs(argv));
  process.stdout.write(JSON.stringify({ outcome: result.outcome, output: result.output, summary: result.summary, error: result.error }) + '\n');
  process.exitCode = result.outcome === 'passed' ? 0 : 1;
}
