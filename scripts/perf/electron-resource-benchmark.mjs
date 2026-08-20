#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  createLoopbackOpenCodeFixture,
  PERF_PARENT_SESSION_ID,
} from './loopback-opencode-fixture.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const requireElectronDependency = createRequire(path.join(repositoryRoot, 'packages/electron/package.json'));
const WebSocket = requireElectronDependency('ws');
const DEFAULT_SCENARIOS = ['idle', 'one-stream', 'four-stream', 'plan-skeleton'];
const VALID_SCENARIOS = new Set(DEFAULT_SCENARIOS);
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
    else if (flag === '--baseline') options.baseline = path.resolve(repositoryRoot, value);
    else throw new Error(`Unknown benchmark flag: ${flag}`);
  }

  if (!options.label) throw new Error('--label cannot be empty');
  if (options.scenarios.length === 0) throw new Error('--scenarios cannot be empty');
  for (const scenario of options.scenarios) {
    if (!VALID_SCENARIOS.has(scenario)) {
      throw new Error(`Unknown scenario ${JSON.stringify(scenario)}; expected ${DEFAULT_SCENARIOS.join(', ')}`);
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

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to reserve a local port');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const appendBoundedLog = (current, chunk) => {
  const next = `${current}${chunk.toString('utf8')}`;
  return next.length > MAX_LOG_BYTES ? next.slice(-MAX_LOG_BYTES) : next;
};

const waitForChildExit = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => {
    child.off('exit', onExit);
    resolve(false);
  }, timeoutMs);
  const onExit = () => {
    clearTimeout(timer);
    resolve(true);
  };
  child.once('exit', onExit);
});

const signalProcessTree = (child, signal) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {}
  try {
    child.kill(signal);
  } catch {}
};

const stopProcessTree = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForChildExit(child, 5_000)) return;
  signalProcessTree(child, 'SIGKILL');
  await waitForChildExit(child, 2_000);
};

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextID = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (typeof message.method !== 'string') return;
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new CdpConnection(socket);
  }

  send(method, params = {}) {
    const id = this.nextID;
    this.nextID += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const current = this.listeners.get(method) ?? new Set();
    current.add(listener);
    this.listeners.set(method, current);
    return () => current.delete(listener);
  }

  waitFor(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const unsubscribe = this.on(method, (params) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(params);
      });
    });
  }

  close() {
    this.socket.close();
  }
}

const discoverPageTarget = async (debugPort, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`Electron CDP target did not appear${lastError ? `: ${lastError.message}` : ''}`);
};

const evaluate = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed');
  }
  return result.result?.value;
};

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

const waitForFixtureReady = async (fixture) => {
  const deadline = Date.now() + 45_000;
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

const injectPlanSkeleton = (cdp) => evaluate(cdp, `(() => {
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

const percentChange = (baseline, current) => {
  if (!Number.isFinite(baseline) || baseline === 0 || !Number.isFinite(current)) return null;
  return ((current - baseline) / baseline) * 100;
};

export const compareBenchmarkSummaries = (baseline, current) => {
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

const runOnce = async ({ scenario, runIndex, scenarioDirectory, electronBinary, warmupMs, measureMs }) => {
  const runDirectory = path.join(scenarioDirectory, `run-${runIndex}`);
  const dataDirectory = path.join(runDirectory, 'data');
  const userDataDirectory = path.join(runDirectory, 'chromium-profile');
  const fixtureDirectory = path.join(runDirectory, 'workspace');
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(userDataDirectory, { recursive: true });
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({
    messageStreamTransport: 'sse',
    desktopWindowState: { width: 1280, height: 800, maximized: false },
  }, null, 2));

  const fixture = await createLoopbackOpenCodeFixture({ directory: fixtureDirectory });
  const debugPort = await reservePort();
  let logs = '';
  const child = spawn(electronBinary, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDirectory}`,
    '--force-device-scale-factor=1',
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OPENCHAMBER_DATA_DIR: dataDirectory,
      OPENCODE_HOST: fixture.origin,
      OPENCODE_SKIP_START: 'true',
      OPENCHAMBER_SKIP_OPENCODE_START: 'true',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => { logs = appendBoundedLog(logs, chunk); });
  child.stderr?.on('data', (chunk) => { logs = appendBoundedLog(logs, chunk); });

  let cdp = null;
  try {
    const target = await discoverPageTarget(debugPort);
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
    const origin = await waitForRendererOrigin(cdp);
    await cdp.send('Page.navigate', { url: `${origin}/?session=${PERF_PARENT_SESSION_ID}` });
    await waitForFixtureReady(fixture);

    let skeleton = null;
    if (scenario === 'plan-skeleton') {
      skeleton = await injectPlanSkeleton(cdp);
    } else {
      fixture.startScenario(scenario);
    }

    const display = await collectDisplayConditions(cdp);
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
      runIndex,
      warmupMs,
      measureMs,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      discardedCpuSamples: 1,
      display,
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
  } finally {
    cdp?.close();
    await stopProcessTree(child);
    await fixture.close();
    await writeFile(path.join(runDirectory, 'electron.log'), logs);
  }
};

const main = async () => {
  const options = parseBenchmarkArguments(process.argv.slice(2));
  const electronBinary = resolvePackagedElectronBinary(options.electronBinary);
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
    electronBinary,
    runsPerScenario: options.runs,
    warmupMs: options.warmupMs,
    measureMs: options.measureMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    scenarios: {},
  };

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
        warmupMs: options.warmupMs,
        measureMs: options.measureMs,
      }));
    }
    result.scenarios[scenario] = {
      aggregate: aggregateRunSummaries(runs),
      runs: runs.map((run) => ({ runIndex: run.runIndex, summary: run.summary })),
    };
    await writeFile(path.join(outputDirectory, 'summary.json'), JSON.stringify(result, null, 2));
  }

  if (options.baseline) {
    const baseline = JSON.parse(await readFile(options.baseline, 'utf8'));
    result.comparison = compareBenchmarkSummaries(baseline, result);
  }
  await writeFile(path.join(outputDirectory, 'summary.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`[perf] wrote ${path.relative(repositoryRoot, outputDirectory)}/summary.json\n`);

  if (result.comparison && !result.comparison.passed) {
    process.exitCode = 2;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[perf] benchmark failed:', error);
    process.exitCode = 1;
  });
}
