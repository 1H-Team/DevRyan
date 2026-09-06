#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { CdpConnection, discoverPageTarget, evaluate } from '../qa/cdp.mjs';
import { createQaUiDriver } from '../qa/ui-driver.mjs';
import { reservePort, startOwnedProcess } from '../qa/process.mjs';
import { loadQaPackagedArtifact } from '../qa/packaged-artifact.mjs';
import { prepareQaFixtureProfile } from '../qa/fixture-scenarios.mjs';
import { assertPerfCleanupComplete, capturePerfJournal, observePerfBrowserErrors } from './electron-run-evidence.mjs';
import {
  assertStartupMode,
  captureFirstDocumentStartup,
  observeStartupNavigation,
  prepareMemorySessions,
  runSessionMemoryScenario,
} from './electron-lifecycle-benchmark.mjs';
import {
  aggregateInteractiveRuns,
  assertInteractiveScope,
  compareInteractiveSummaries,
  getInteractivePrimaryMetrics,
  getInteractiveProtocol,
  prepareInteractiveSessions,
  runInteractiveScenario,
} from './electron-interactive-benchmark.mjs';

import {
  createLoopbackOpenCodeFixture,
  PERF_PARENT_SESSION_ID,
} from './loopback-opencode-fixture.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const DEFAULT_SCENARIOS = ['idle', 'one-stream', 'four-stream', 'plan-skeleton'];
const VALID_SCENARIOS = new Set([...DEFAULT_SCENARIOS, 'session-memory', 'interactive']);
const SAMPLE_INTERVAL_MS = 500;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

const parsePositiveInteger = (value, flag) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
};

export const parseBenchmarkArguments = (argv) => {
  const options = {
    label: 'current',
    scenarios: DEFAULT_SCENARIOS,
    runs: 3,
    warmupMs: 5_000,
    measureMs: 30_000,
    outputRoot: path.join(repositoryRoot, '.cache/perf'),
    electronBinary: null,
    packageEvidence: null,
    baseline: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --flag value, received ${flag ?? '(empty)'}`);
    }
    index += 1;
    if (flag === '--label') options.label = value.trim();
    else if (flag === '--scenarios') options.scenarios = value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (flag === '--runs') options.runs = parsePositiveInteger(value, flag);
    else if (flag === '--warmup-ms') options.warmupMs = parsePositiveInteger(value, flag);
    else if (flag === '--measure-ms') options.measureMs = parsePositiveInteger(value, flag);
    else if (flag === '--output') options.outputRoot = path.resolve(repositoryRoot, value);
    else if (flag === '--electron-binary') options.electronBinary = path.resolve(repositoryRoot, value);
    else if (flag === '--package-evidence') options.packageEvidence = path.resolve(repositoryRoot, value);
    else if (flag === '--baseline') options.baseline = path.resolve(repositoryRoot, value);
    else throw new Error(`Unknown benchmark flag: ${flag}`);
  }

  if (!options.label) throw new Error('--label cannot be empty');
  if (options.packageEvidence && options.electronBinary) throw new Error('Use --package-evidence or --electron-binary, not both');
  if (options.scenarios.length === 0) throw new Error('--scenarios cannot be empty');
  if (options.scenarios.includes('session-memory') && !options.packageEvidence) throw new Error('Session-memory requires --package-evidence and its isolated fixture profile');
  if (options.scenarios.includes('interactive') && !options.packageEvidence) throw new Error('Interactive requires --package-evidence and its isolated fixture profile');
  for (const scenario of options.scenarios) {
    if (!VALID_SCENARIOS.has(scenario)) {
      throw new Error(`Unknown scenario ${JSON.stringify(scenario)}; expected ${[...VALID_SCENARIOS].join(', ')}`);
    }
  }
  return options;
};

const resolvePackagedElectronBinary = (override) => {
  if (override) {
    if (!existsSync(override)) throw new Error(`Electron binary does not exist: ${override}`);
    return override;
  }

  const candidates = process.platform === 'darwin'
    ? [
        path.join(repositoryRoot, 'packages/electron/dist/mac-arm64/DevRyan.app/Contents/MacOS/DevRyan'),
        path.join(repositoryRoot, 'packages/electron/dist/mac/DevRyan.app/Contents/MacOS/DevRyan'),
      ]
    : process.platform === 'win32'
      ? [path.join(repositoryRoot, 'packages/electron/dist/win-unpacked/DevRyan.exe')]
      : [
          path.join(repositoryRoot, 'packages/electron/dist/linux-unpacked/devryan'),
          path.join(repositoryRoot, 'packages/electron/dist/linux-unpacked/DevRyan'),
        ];
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) {
    throw new Error(
      'No packaged DevRyan Electron binary was found. Run `bun run electron:build` first '
      + 'or pass --electron-binary <path>.',
    );
  }
  return binary;
};

const appendBoundedLog = (current, chunk) => {
  const next = `${current}${chunk.toString('utf8')}`;
  return next.length > MAX_LOG_BYTES ? next.slice(-MAX_LOG_BYTES) : next;
};

export async function stopPerfOwnedResources(ownedProcess, fixture) {
  const cleanup = { errors: [], app: { stopped: false }, fixture: { closed: false } };
  try { await ownedProcess.stop(); cleanup.app.stopped = true; }
  catch (error) { cleanup.errors.push(error.message); }
  try { await fixture.close(); cleanup.fixture = { closed: true, finalState: fixture.getState() }; }
  catch (error) { cleanup.errors.push(error.message); }
  // The shared stop already audits before closing tracking. Re-observe after
  // the fixture closes so detached descendants cannot be hidden by a dead PGID.
  try { await ownedProcess.auditStopped(); }
  catch (error) { cleanup.app.stopped = false; cleanup.errors.push(error.message); }
  const ownership = ownedProcess.getCleanupEvidence();
  Object.assign(cleanup.app, { pid: ownedProcess.child.pid ?? null, scope: ownership.source,
    exitCode: ownedProcess.child.exitCode, signalCode: ownedProcess.child.signalCode,
    escalated: ownership.signals.some(entry => ['SIGTERM', 'SIGKILL'].includes(entry.signal)), ownership });
  cleanup.complete = cleanup.errors.length === 0 && cleanup.app.stopped && cleanup.fixture.closed;
  return cleanup;
}

const waitForRendererOrigin = async (cdp) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const href = await evaluate(cdp, 'location.href').catch(() => '');
    if (typeof href === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(href)) {
      return new URL(href).origin;
    }
    await wait(100);
  }
  throw new Error('DevRyan renderer did not navigate to its loopback origin');
};

const waitForFixtureReady = async (fixture, deadline = Date.now() + 45_000) => {
  while (Date.now() < deadline) {
    const state = fixture.getState();
    if (
      state.sseClientCount > 0
      && (state.messageRequestCounts[PERF_PARENT_SESSION_ID] ?? 0) > 0
    ) {
      return state;
    }
    await wait(100);
  }
  throw new Error('Renderer did not subscribe and materialize the selected fixture session');
};

export async function waitForPlanSkeletonDocument(cdp, { navigation, previousDocument, url, deadline, checkAlive = () => {} }) {
  if (navigation.errorText || navigation.isDownload || !navigation.loaderId || !navigation.frameId
    || navigation.frameId !== previousDocument.frameId || navigation.loaderId === previousDocument.loaderId
    || !previousDocument.loaderId || !Number.isFinite(previousDocument.timeOrigin)) {
    throw new Error('Plan skeleton requires a successful navigation to a new document loader');
  }
  const checkDeadline = () => {
    checkAlive();
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the requested plan skeleton document and body');
  };
  const matchesFrame = frame => frame && !frame.parentId && frame.id === navigation.frameId
    && frame.loaderId === navigation.loaderId && frame.url === url;
  const ui = createQaUiDriver(cdp, { checkAlive: checkDeadline });
  return ui.waitFor('requested plan skeleton document and body', async () => {
    const before = await cdp.send('Page.getFrameTree');
    if (!matchesFrame(before.frameTree?.frame)) return false;
    const document = await evaluate(cdp, `({ href: location.href, timeOrigin: performance.timeOrigin,
      readyState: document.readyState, body: Boolean(document.body?.isConnected) })`);
    const after = await cdp.send('Page.getFrameTree');
    checkDeadline();
    if (!matchesFrame(after.frameTree?.frame) || document.href !== url || !Number.isFinite(document.timeOrigin)
      || document.timeOrigin === previousDocument.timeOrigin || document.readyState !== 'complete' || !document.body) return false;
    return { ...document, frameId: navigation.frameId, loaderId: navigation.loaderId, previousLoaderId: previousDocument.loaderId };
  }, Math.max(0, deadline - Date.now()));
}

export const injectPlanSkeleton = (cdp, expectedDocument) => evaluate(cdp, `(() => {
  if (location.href !== ${JSON.stringify(expectedDocument.href)} || performance.timeOrigin !== ${JSON.stringify(expectedDocument.timeOrigin)}
    || document.readyState !== 'complete' || !document.body?.isConnected) {
    throw new Error('Requested fixture document changed before plan skeleton insertion');
  }
  document.getElementById('devryan-perf-plan-skeleton')?.remove();
  const host = document.createElement('div');
  host.id = 'devryan-perf-plan-skeleton';
  host.className = 'oc-plan-skeleton-lines';
  host.dataset.animationState = 'running';
  Object.assign(host.style, {
    position: 'fixed', left: '160px', top: '120px', width: '720px',
    display: 'flex', flexDirection: 'column', gap: '12px', zIndex: '2147483647',
    padding: '24px', background: 'var(--background)', pointerEvents: 'none'
  });
  for (let index = 0; index < 48; index += 1) {
    const line = document.createElement('span');
    line.className = 'oc-plan-skeleton-line';
    host.appendChild(line);
  }
  document.body.appendChild(host);
  return { lineCount: host.children.length, runningAnimations: host.getAnimations({ subtree: true }).filter((item) => item.playState === 'running').length };
})()`);

const collectDisplayConditions = (cdp) => evaluate(cdp, `({
  href: location.href,
  visibilityState: document.visibilityState,
  innerWidth,
  innerHeight,
  outerWidth,
  outerHeight,
  devicePixelRatio,
  screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight }
})`);

const displaySignature = ({ visibilityState, innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio, screen }) => ({
  visibilityState, innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio, screen,
});

export const lifecycleProtocolIdentity = async (readProtocolFile = file => readFile(path.join(scriptDirectory, file)), startupMode = 'natural') => {
  assertStartupMode(startupMode);
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ startupMode }));
  for (const file of ['electron-resource-benchmark.mjs', 'electron-lifecycle-benchmark.mjs', 'electron-run-evidence.mjs', 'loopback-opencode-fixture.mjs',
    '../journal.mjs', '../qa/cdp.mjs', '../qa/ui-driver.mjs', '../qa/host-readiness.mjs', '../qa/fixture-scenarios.mjs',
    '../qa/packaged-artifact.mjs', '../qa/artifact-evidence.mjs', '../qa/project-fixture.mjs', '../qa/isolated-home.mjs',
    '../qa/process.mjs', '../qa/process-ownership.mjs', '../dev-child-utils.mjs']) {
    hash.update(file).update(await readProtocolFile(file));
  }
  return hash.digest('hex');
};

export const interactiveProtocolIdentity = async (startupMode = 'natural', interactiveScope = 'full',
  readProtocolFile = file => readFile(path.join(scriptDirectory, file))) => {
  assertStartupMode(startupMode);
  assertInteractiveScope(interactiveScope);
  return createHash('sha256').update(JSON.stringify({ startupMode, interactiveScope }))
    .update(await lifecycleProtocolIdentity(readProtocolFile, startupMode))
    .update(await readProtocolFile('electron-interactive-benchmark.mjs'))
    .update(await readProtocolFile('loopback-opencode-fixture.mjs'))
    .digest('hex');
};

const recordedFilesIdentity = (entries, key = 'file') => createHash('sha256')
  .update(JSON.stringify(entries.map(entry => ({ file: entry[key], sha256: entry.sha256 }))
    .sort((left, right) => left.file.localeCompare(right.file))))
  .digest('hex');

export function assertPerfPackageEvidenceUnchanged(expectedSha256, bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw new Error('Pinned package evidence changed during measurement');
  }
}

const fetchMemorySample = async (origin) => {
  const response = await fetch(`${origin}/api/debug/memory`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`/api/debug/memory returned ${response.status}`);
  const sample = await response.json();
  if (!Array.isArray(sample.appMetrics)) {
    throw new Error('/api/debug/memory did not include Electron appMetrics');
  }
  return sample;
};

export const median = (values) => {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
};

const metricForType = (sample, type, field, nestedField) => {
  const processMetric = sample.appMetrics.find((entry) => entry.type === type);
  const branch = processMetric?.[field];
  const value = nestedField ? branch?.[nestedField] : branch;
  return typeof value === 'number' ? value : null;
};

export const summarizeMemorySamples = (rawSamples) => {
  const samples = rawSamples.slice(1);
  return {
    sampleCount: samples.length,
    medianTabCpu: median(samples.map((sample) => metricForType(sample, 'Tab', 'cpu', 'percentCPUUsage'))),
    medianGpuCpu: median(samples.map((sample) => metricForType(sample, 'GPU', 'cpu', 'percentCPUUsage'))),
    medianTabWorkingSet: median(samples.map((sample) => metricForType(sample, 'Tab', 'memory', 'workingSetSize'))),
    medianTotalAppWorkingSet: median(samples.map((sample) => (
      sample.appMetrics.reduce((total, entry) => total + (entry.memory?.workingSetSize ?? 0), 0)
    ))),
    medianMainRss: median(samples.map((sample) => sample.process?.rss ?? null)),
  };
};

const aggregateRunSummaries = (runs) => ({
  runCount: runs.length,
  medianTabCpu: median(runs.map((run) => run.summary.medianTabCpu)),
  medianGpuCpu: median(runs.map((run) => run.summary.medianGpuCpu)),
  medianTabWorkingSet: median(runs.map((run) => run.summary.medianTabWorkingSet)),
  medianTotalAppWorkingSet: median(runs.map((run) => run.summary.medianTotalAppWorkingSet)),
  medianMainRss: median(runs.map((run) => run.summary.medianMainRss)),
});

export const summarizeStartupRuns = (runs) => {
  const values = runs.filter(run => run.outcome === 'passed').map(run => run.uiReadyMs).filter(Number.isFinite);
  return { successfulRuns: values.length, totalRuns: runs.length,
    medianUiReadyMs: median(values), minimumUiReadyMs: values.length ? Math.min(...values) : null,
    maximumUiReadyMs: values.length ? Math.max(...values) : null };
};

const aggregateMemoryRuns = (runs) => Object.fromEntries(['initial', 'loaded', 'inactive', 'deleted'].map(name => [name,
  Object.fromEntries(Object.keys(runs[0].sessionMemory.summary[name]).map(metric => [metric,
    median(runs.map(run => run.sessionMemory.summary[name][metric])),
  ])),
]));

const assertMatchingStartupModes = (baseline, current) => {
  const before = baseline.startupMode === undefined ? 'natural' : baseline.startupMode;
  const after = current.startupMode === undefined ? 'natural' : current.startupMode;
  assertStartupMode(before);
  assertStartupMode(after);
  if (before !== after) throw new Error('Benchmark comparison requires matching startupMode');
};

export const compareLifecycleSummaries = (baseline, current) => {
  assertMatchingStartupModes(baseline, current);
  for (const key of ['fixtureSha256', 'lifecycleProtocolSha256', 'runsPerScenario', 'warmupMs', 'measureMs', 'sampleIntervalMs']) {
    if (baseline[key] === undefined || baseline[key] !== current[key]) throw new Error(`Lifecycle comparison requires matching ${key}`);
  }
  const changes = {};
  for (const [name, scenario] of Object.entries(current.scenarios)) {
    const previous = baseline.scenarios?.[name];
    if (!previous) continue;
    if (!previous.chromium?.product || JSON.stringify(previous.chromium) !== JSON.stringify(scenario.chromium)) throw new Error('Lifecycle comparison requires the same recorded Chromium runtime');
    if (!previous.display?.innerWidth || previous.display.visibilityState !== 'visible'
      || JSON.stringify(previous.display) !== JSON.stringify(scenario.display)) {
      throw new Error('Lifecycle comparison requires matching visible display/window conditions');
    }
    for (const value of [previous.startup, scenario.startup]) {
      if (!value || value.totalRuns < 1 || value.successfulRuns !== value.totalRuns || !Number.isFinite(value.medianUiReadyMs)) {
        throw new Error('Lifecycle comparison requires successful first-document startup evidence for every run');
      }
    }
    changes[name] = { startupMs: scenario.startup.medianUiReadyMs - previous.startup.medianUiReadyMs };
    if (name === 'session-memory') changes[name].memory = Object.fromEntries(Object.keys(scenario.memory).map(checkpoint => [checkpoint,
      Object.fromEntries(Object.keys(scenario.memory[checkpoint]).map(metric => [metric,
        scenario.memory[checkpoint][metric] - previous.memory[checkpoint][metric],
      ])),
    ]));
  }
  return { scope: 'descriptive deltas only; no startup or memory-retention acceptance thresholds', changes };
};

const percentChange = (baseline, current) => {
  if (!Number.isFinite(baseline) || baseline === 0 || !Number.isFinite(current)) return null;
  return ((current - baseline) / baseline) * 100;
};

export const compareBenchmarkSummaries = (baseline, current) => {
  assertMatchingStartupModes(baseline, current);
  const scenario = (summary, name) => summary.scenarios?.[name]?.aggregate ?? null;
  const beforeFour = scenario(baseline, 'four-stream');
  const afterFour = scenario(current, 'four-stream');
  const beforeSkeleton = scenario(baseline, 'plan-skeleton');
  const afterSkeleton = scenario(current, 'plan-skeleton');
  const checks = [
    { name: 'four-stream Tab CPU', change: percentChange(beforeFour?.medianTabCpu, afterFour?.medianTabCpu), maximum: -25 },
    { name: 'plan-skeleton GPU CPU', change: percentChange(beforeSkeleton?.medianGpuCpu, afterSkeleton?.medianGpuCpu), maximum: -50 },
    { name: 'idle Tab CPU', change: percentChange(scenario(baseline, 'idle')?.medianTabCpu, scenario(current, 'idle')?.medianTabCpu), maximum: 5 },
    { name: 'one-stream Tab CPU', change: percentChange(scenario(baseline, 'one-stream')?.medianTabCpu, scenario(current, 'one-stream')?.medianTabCpu), maximum: 5 },
    { name: 'four-stream Tab working set', change: percentChange(beforeFour?.medianTabWorkingSet, afterFour?.medianTabWorkingSet), maximum: 5 },
    { name: 'four-stream total working set', change: percentChange(beforeFour?.medianTotalAppWorkingSet, afterFour?.medianTotalAppWorkingSet), maximum: 5 },
  ].map((check) => ({
    ...check,
    passed: Number.isFinite(check.change) && check.change <= check.maximum,
  }));
  return { passed: checks.every((check) => check.passed), checks };
};

const runOnce = async ({ scenario, runIndex, scenarioDirectory, electronBinary, packageEvidence, warmupMs, measureMs, startupMode, interactiveScope }) => {
  const runDirectory = path.join(scenarioDirectory, `run-${runIndex}`);
  const fixtureDirectory = path.join(runDirectory, 'workspace');
  await mkdir(fixtureDirectory, { recursive: true });
  execFileSync('git', ['init', '--quiet', fixtureDirectory], { stdio: 'pipe' });
  const profile = packageEvidence ? await prepareQaFixtureProfile({ runtimeRoot: path.join(runDirectory, 'runtime'), workspace: fixtureDirectory,
    cell: { transport: 'fixture', runtime: 'electron', providerId: 'fixture', modelId: 'fixture-model', agent: 'builder', planMode: false, variant: null, scenarioId: 'core-journey' } }) : null;
  const dataDirectory = profile?.env.OPENCHAMBER_DATA_DIR ?? path.join(runDirectory, 'data');
  const userDataDirectory = profile?.env.OPENCHAMBER_ELECTRON_USER_DATA_DIR ?? path.join(runDirectory, 'chromium-profile');
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(userDataDirectory, { recursive: true });
  const settings = profile ? JSON.parse(await readFile(path.join(dataDirectory, 'settings.json'), 'utf8')) : {
    messageStreamTransport: 'sse', lastDirectory: fixtureDirectory,
    projects: [{ id: 'perf-project', path: fixtureDirectory, label: 'Performance workspace' }], activeProjectId: 'perf-project',
    desktopWindowState: { width: 1280, height: 800, maximized: false },
  };
  // Pin only this fresh benchmark profile before launch. Host-managed agent
  // defaults otherwise may select a production model outside the fixture catalog.
  await writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({ ...settings,
    defaultModel: 'fixture/fixture-model', defaultAgent: 'build',
    agentModelSelections: Object.fromEntries(['build', 'builder', 'orchestrator'].map(agent => [agent,
      { providerId: 'fixture', modelId: 'fixture-model' }])),
  }, null, 2), { mode: 0o600 });

  const fixture = profile?.fixture ?? await createLoopbackOpenCodeFixture({ directory: fixtureDirectory });
  const memorySessions = scenario === 'session-memory'
    ? await prepareMemorySessions(fixture).catch(async error => { await fixture.close(); throw error; })
    : [];
  const interactiveSessions = scenario === 'interactive'
    ? await prepareInteractiveSessions(fixture).catch(async error => { await fixture.close(); throw error; })
    : null;
  const debugPort = await reservePort();
  let logs = '';
  const spawnedAt = performance.now();
  const ownedProcess = startOwnedProcess(electronBinary, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDirectory}`,
    '--force-device-scale-factor=1',
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...profile?.env,
      OPENCHAMBER_DATA_DIR: dataDirectory,
      OPENCODE_HOST: fixture.origin,
      OPENCODE_SKIP_START: 'true',
      OPENCHAMBER_SKIP_OPENCODE_START: 'true',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    },
  });
  const child = ownedProcess.child;
  child.stdout?.on('data', (chunk) => { logs = appendBoundedLog(logs, chunk); });
  child.stderr?.on('data', (chunk) => { logs = appendBoundedLog(logs, chunk); });

  let cdp = null;
  let startup = null;
  let startupNavigationAudit = null;
  let browserErrors = null;
  let runError = null;
  const runEvidence = { schemaVersion: 1, scenario, runIndex, startupMode,
    ...(scenario === 'interactive' ? { interactiveScope } : {}), diagnostics: null, browserErrors: null,
    fixture: null, journal: null, cleanup: { errors: [] }, review: 'required' };
  const screenshot = async name => {
    const capture = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(runDirectory, `${name}.png`), Buffer.from(capture.data, 'base64'));
  };
  const checkAlive = () => ownedProcess.check();
  try {
    const target = await discoverPageTarget(debugPort);
    const cdpTargetMs = performance.now() - spawnedAt;
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    startupNavigationAudit = observeStartupNavigation(cdp, spawnedAt, target.url);
    browserErrors = observePerfBrowserErrors(cdp, { runDirectory, repositoryRoot });
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]);
    const origin = await waitForRendererOrigin(cdp);
    const loopbackOriginMs = performance.now() - spawnedAt;
    startup = await captureFirstDocumentStartup({ cdp, fixture, origin, startedAt: spawnedAt, checkAlive, startupMode,
      milestones: { cdpTargetMs, loopbackOriginMs }, navigationAudit: startupNavigationAudit });
    await writeFile(path.join(runDirectory, 'startup.json'), JSON.stringify(startup, null, 2));
    if (startup.outcome !== 'passed') throw new Error(`Native startup failed: ${startup.error}`);
    const chromium = await cdp.send('Browser.getVersion');
    if (profile) {
      const host = JSON.parse(await readFile(path.join(runDirectory, 'runtime/packaged-host.json'), 'utf8'));
      if (host.isPackaged !== true) throw new Error('Resource measurement requires the actual packaged host');
      await writeFile(path.join(runDirectory, 'packaged-host.json'), JSON.stringify(host, null, 2));
    }
    const display = await collectDisplayConditions(cdp);
    if (scenario === 'interactive') {
      const interactive = await runInteractiveScenario({ cdp, fixture, sessions: interactiveSessions, origin,
        readHostMemory: () => fetchMemorySample(origin), measureMs, warmupMs, screenshot, interactiveScope,
        record: evidence => writeFile(path.join(runDirectory, 'interactive.json'), JSON.stringify(evidence, null, 2)),
        traceFilename: path.join(runDirectory, 'trace.json.gz') });
      const finalDisplay = await collectDisplayConditions(cdp);
      if (JSON.stringify(displaySignature(finalDisplay)) !== JSON.stringify(displaySignature(display))) {
        throw new Error('Interactive display/window conditions changed during measurement');
      }
      const metrics = { scenario, runIndex, startupMode, interactiveScope, warmupMs,
        ...(interactiveScope === 'typing' ? { measurement: getInteractiveProtocol(interactiveScope).measurement }
          : { measureMs, sampleIntervalMs: SAMPLE_INTERVAL_MS }),
        display, finalDisplay, chromium, startup, forcedNavigation: null, fixture: fixture.getState(), interactive };
      await writeFile(path.join(runDirectory, 'metrics.json'), JSON.stringify(metrics, null, 2));
      return metrics;
    }
    if (scenario === 'session-memory') {
      const sessionMemory = await runSessionMemoryScenario({ cdp, fixture, sessions: memorySessions,
        readHostMemory: () => fetchMemorySample(origin), measureMs, warmupMs, screenshot,
        record: evidence => writeFile(path.join(runDirectory, 'session-memory.json'), JSON.stringify(evidence, null, 2)) });
      const metrics = { scenario, runIndex, startupMode, warmupMs, measureMs, sampleIntervalMs: SAMPLE_INTERVAL_MS,
        display, chromium, startup, forcedNavigation: null, fixture: fixture.getState(), sessionMemory };
      await writeFile(path.join(runDirectory, 'metrics.json'), JSON.stringify(metrics, null, 2));
      return metrics;
    }
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      if(location.protocol==='http:'&&location.hostname==='127.0.0.1')for (const principal of ['anonymous', 'local-admin']) {
        localStorage.setItem('devryan.user.' + principal + ':lastDirectory', ${JSON.stringify(fixtureDirectory)});
      }
    ` });
    const fixtureUrl = `${origin}/?session=${PERF_PARENT_SESSION_ID}`;
    let previousDocument = null;
    if (scenario === 'plan-skeleton') {
      const { frameTree } = await cdp.send('Page.getFrameTree');
      previousDocument = { frameId: frameTree.frame.id, loaderId: frameTree.frame.loaderId,
        timeOrigin: await evaluate(cdp, 'performance.timeOrigin') };
    }
    const navigationStartedAt = performance.now();
    const navigationDeadline = Date.now() + 45_000;
    const navigation = await cdp.send('Page.navigate', { url: fixtureUrl });
    await waitForFixtureReady(fixture, scenario === 'plan-skeleton' ? navigationDeadline : undefined);
    const forcedNavigation = { reason: 'select resource fixture after completed startup measurement',
      elapsedMs: performance.now() - navigationStartedAt, includedInStartup: false };

    let skeleton = null;
    if (scenario === 'plan-skeleton') {
      forcedNavigation.documentReadiness = await waitForPlanSkeletonDocument(cdp, {
        navigation, previousDocument, url: fixtureUrl, deadline: navigationDeadline, checkAlive,
      });
      forcedNavigation.elapsedMs = performance.now() - navigationStartedAt;
      skeleton = await injectPlanSkeleton(cdp, forcedNavigation.documentReadiness);
    } else {
      fixture.startScenario(scenario);
    }

    await wait(warmupMs);

    const traceEvents = [];
    const removeTraceListener = cdp.on('Tracing.dataCollected', ({ value }) => {
      if (!Array.isArray(value)) return;
      for (const event of value) traceEvents.push(event);
    });
    await cdp.send('Tracing.start', {
      categories: [
        'devtools.timeline',
        'blink',
        'cc',
        'gpu',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
      ].join(','),
      options: 'record-continuously',
      transferMode: 'ReportEvents',
    });

    const samples = [];
    const sampleCount = Math.ceil(measureMs / SAMPLE_INTERVAL_MS);
    const measuredAt = Date.now();
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      samples.push(await fetchMemorySample(origin));
      const nextSampleAt = measuredAt + ((sampleIndex + 1) * SAMPLE_INTERVAL_MS);
      await wait(Math.max(0, nextSampleAt - Date.now()));
    }

    const traceComplete = cdp.waitFor('Tracing.tracingComplete', 60_000);
    await cdp.send('Tracing.end');
    await traceComplete;
    removeTraceListener();
    fixture.stopScenario();

    const summary = summarizeMemorySamples(samples);
    const metrics = {
      scenario,
      startupMode,
      runIndex,
      warmupMs,
      measureMs,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      discardedCpuSamples: 1,
      display,
      chromium,
      startup,
      forcedNavigation,
      skeleton,
      fixture: fixture.getState(),
      summary,
      samples,
    };
    await writeFile(path.join(runDirectory, 'metrics.json'), JSON.stringify(metrics, null, 2));
    await writeFile(
      path.join(runDirectory, 'trace.json.gz'),
      gzipSync(JSON.stringify({ traceEvents })),
    );
    return metrics;
  } catch (error) {
    runError = error;
    await writeFile(path.join(runDirectory, 'failure.json'), JSON.stringify({ scenario, runIndex, error: error.message, startup }, null, 2));
    if (cdp) await screenshot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) {
      runEvidence.diagnostics = await evaluate(cdp, `fetch('/api/diagnostics/status',{signal:AbortSignal.timeout(5000)})
        .then(async r=>({httpStatus:r.status,...(r.ok?await r.json():{unavailable:true})}))`)
        .catch(error => ({ unavailable: true, error: error.message }));
    } else runEvidence.diagnostics = { unavailable: true, reason: 'CDP attachment did not complete' };
    runEvidence.browserErrors = browserErrors?.complete() ?? { unavailable: true, reason: 'CDP attachment did not complete' };
    runEvidence.fixture = fixture.getState();
    startupNavigationAudit?.complete();
    cdp?.close();
    runEvidence.cleanup = await stopPerfOwnedResources(ownedProcess, fixture);
    runEvidence.journal = await capturePerfJournal(path.join(dataDirectory, 'harness/journal'))
      .catch(error => ({ available: false, complete: false, error: error.message }));
    runEvidence.workloadOutcome = runError ? 'failed' : 'passed';
    runEvidence.workloadError = runError?.message ?? null;
    runEvidence.cleanup.complete = runEvidence.cleanup.errors.length === 0;
    await writeFile(path.join(runDirectory, 'electron.log'), logs);
    await writeFile(path.join(runDirectory, 'run-evidence.json'), JSON.stringify(runEvidence, null, 2));
    assertPerfCleanupComplete(runEvidence.cleanup, runError);
  }
};

export const runElectronResourceBenchmark = async ({ argv = [], startupMode = 'natural', interactiveScope = 'full' } = {}) => {
  assertStartupMode(startupMode);
  assertInteractiveScope(interactiveScope);
  const options = parseBenchmarkArguments(argv);
  if (interactiveScope === 'typing' && (options.scenarios.length !== 1 || options.scenarios[0] !== 'interactive')) {
    throw new Error('Typing scope requires only the interactive scenario');
  }
  if (startupMode === 'foreground' && interactiveScope !== 'typing' && options.scenarios.some(scenario => !DEFAULT_SCENARIOS.includes(scenario))) {
    throw new Error('Foreground startup is only supported for resource scenarios');
  }
  const packaged = options.packageEvidence ? await loadQaPackagedArtifact({ root: repositoryRoot, evidencePath: options.packageEvidence }) : null;
  let packageEvidenceSha256 = null;
  if (packaged) {
    const bytes = await readFile(packaged.evidencePath);
    if (JSON.stringify(JSON.parse(bytes.toString('utf8'))) !== JSON.stringify(packaged.evidence)) {
      throw new Error('Package evidence changed while loading the initial artifact');
    }
    packageEvidenceSha256 = createHash('sha256').update(bytes).digest('hex');
  }
  const electronBinary = packaged?.binary ?? resolvePackagedElectronBinary(options.electronBinary);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDirectory = path.join(options.outputRoot, `${timestamp}-${options.label}`);
  await mkdir(outputDirectory, { recursive: true });

  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  const result = {
    schemaVersion: 1,
    label: options.label,
    gitCommit,
    createdAt: new Date().toISOString(),
    startupMode,
    electronBinary,
    packageEvidence: packaged ? { path: packaged.evidencePath, evidenceFileSha256: packageEvidenceSha256, sourceSha256: packaged.evidence.source.sha256,
      archiveSha256: packaged.evidence.archiveSha256, uiArtifactSha256: packaged.evidence.packagedWebArtifact.sha256,
      backendSha256: recordedFilesIdentity(packaged.evidence.verifiedWorkspaceFiles),
      shellSha256: recordedFilesIdentity([...packaged.evidence.verifiedShellFiles, { file: 'dist-bundle/main.mjs', sha256: packaged.evidence.mainSha256 }]),
      nativeSha256: recordedFilesIdentity(packaged.evidence.nativeArtifacts, 'relative'),
      isolatedFixture: true } : null,
    runsPerScenario: options.runs,
    warmupMs: options.warmupMs,
    ...(interactiveScope === 'typing' ? { measurement: getInteractiveProtocol(interactiveScope).measurement }
      : { measureMs: options.measureMs, sampleIntervalMs: SAMPLE_INTERVAL_MS }),
    fixtureSha256: createHash('sha256').update(await readFile(path.join(scriptDirectory, 'loopback-opencode-fixture.mjs'))).digest('hex'),
    lifecycleProtocolSha256: await lifecycleProtocolIdentity(undefined, startupMode),
    ...(options.scenarios.includes('interactive') ? { interactiveScope,
      interactiveProtocolSha256: await interactiveProtocolIdentity(startupMode, interactiveScope),
      interactiveProtocol: getInteractiveProtocol(interactiveScope), interactivePrimaryMetrics: getInteractivePrimaryMetrics(interactiveScope) } : {}),
    scenarios: {},
  };
  await writeFile(path.join(outputDirectory, 'summary.json'), JSON.stringify(result, null, 2));

  let measurementError = null;
  try {
    for (const scenario of options.scenarios) {
      const scenarioDirectory = path.join(outputDirectory, scenario);
      await mkdir(scenarioDirectory, { recursive: true });
      const runs = [];
      for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
        process.stdout.write(`[perf] ${scenario} run ${runIndex}/${options.runs}\n`);
        runs.push(await runOnce({
          scenario,
          runIndex,
          scenarioDirectory,
          electronBinary,
          packageEvidence: packaged,
          warmupMs: options.warmupMs,
          measureMs: options.measureMs,
          startupMode,
          interactiveScope,
        }));
      }
      const display = displaySignature(runs[0].display);
      if (runs.some(run => JSON.stringify(displaySignature(run.display)) !== JSON.stringify(display)
        || JSON.stringify(run.chromium) !== JSON.stringify(runs[0].chromium))) {
        throw new Error('Repeated lifecycle runs require the same display/window conditions and Chromium runtime');
      }
      let measurements;
      if (scenario === 'interactive') measurements = { interactive: aggregateInteractiveRuns(runs.map(run => run.interactive)) };
      else if (scenario === 'session-memory') measurements = { memory: aggregateMemoryRuns(runs) };
      else measurements = { aggregate: aggregateRunSummaries(runs) };
      result.scenarios[scenario] = {
        ...measurements,
        startup: summarizeStartupRuns(runs.map(run => run.startup)),
        chromium: runs[0].chromium,
        display,
        runs: runs.map((run) => ({ runIndex: run.runIndex, summary: run.summary,
          startup: run.startup, ...(run.sessionMemory ? { memory: run.sessionMemory.summary } : {}),
          ...(run.interactive ? { interactive: { outcome: run.interactive.outcome,
            interactiveScope, actions: run.interactive.actionsSummary,
            ...(interactiveScope === 'typing' ? { correctness: run.interactive.correctness } : { navigationGrowth: run.interactive.navigationGrowth }) } } : {}) })),
      };
      await writeFile(path.join(outputDirectory, 'summary.json'), JSON.stringify(result, null, 2));
    }

    if (options.baseline) {
      const baseline = JSON.parse(await readFile(options.baseline, 'utf8'));
      if (options.scenarios.some(scenario => DEFAULT_SCENARIOS.includes(scenario))) result.comparison = compareBenchmarkSummaries(baseline, result);
      if (options.scenarios.includes('interactive')) result.interactiveComparison = compareInteractiveSummaries(baseline, result);
      if (interactiveScope !== 'typing') {
        if (baseline.lifecycleProtocolSha256) result.lifecycleComparison = compareLifecycleSummaries(baseline, result);
        else result.lifecycleComparison = { scope: 'not comparable: baseline has no startup/lifecycle protocol evidence' };
      }
    }
  } catch (error) { measurementError = error; }
  // Run every after-run guard even when a workload/comparison failed. Loading
  // a new internally valid artifact cannot replace the originally pinned one.
  const integrityErrors = [];
  if (packaged) {
    try { assertPerfPackageEvidenceUnchanged(packageEvidenceSha256, await readFile(packaged.evidencePath)); }
    catch (error) { integrityErrors.push(error); }
    try { await loadQaPackagedArtifact({ root: repositoryRoot, evidencePath: packaged.evidencePath }); }
    catch (error) { integrityErrors.push(error); }
  }
  try {
    if (result.lifecycleProtocolSha256 !== await lifecycleProtocolIdentity(undefined, startupMode)) throw new Error('Lifecycle runner, fixture or shared QA helpers changed during measurement');
  } catch (error) { integrityErrors.push(error); }
  try {
    if (result.interactiveProtocolSha256 && result.interactiveProtocolSha256 !== await interactiveProtocolIdentity(startupMode, interactiveScope)) throw new Error('Interactive protocol or fixture changed during measurement');
  } catch (error) { integrityErrors.push(error); }
  result.integrity = { passed: integrityErrors.length === 0, errors: integrityErrors.map(error => error.message) };
  if (measurementError) result.workloadError = measurementError.message;
  await writeFile(path.join(outputDirectory, 'summary.json'), JSON.stringify(result, null, 2));
  if (measurementError || integrityErrors.length) {
    throw new AggregateError([...(measurementError ? [measurementError] : []), ...integrityErrors], 'Performance workload or integrity validation failed; see summary.json');
  }
  process.stdout.write(`[perf] wrote ${path.relative(repositoryRoot, outputDirectory)}/summary.json\n`);

  if (result.comparison && !result.comparison.passed) {
    process.exitCode = 2;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runElectronResourceBenchmark({ argv: process.argv.slice(2) }).catch((error) => {
    console.error('[perf] benchmark failed:', error);
    process.exitCode = 1;
  });
}
