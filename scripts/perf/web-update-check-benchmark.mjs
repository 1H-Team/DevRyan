import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Importable benchmark only: no argument parser, prompts, production changes,
// package installation, artificial command delay, or persistent cache clearing.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const UPDATE_CHECK_MODULE = 'packages/web/server/lib/package-manager.js';
export const UPDATE_CHECK_SOURCE_HASHES = Object.freeze({
  before: 'f110b39381ab2975534600f4208147cf4ffdf7b7816d959e7e57a80e10b9fc3f',
  after: 'd3d72b09faa95952b8fb38fde6615efb9727de78fb9d9faa90f80d819babe8c7',
});
export const WEB_UPDATE_CHECK_PROTOCOL = Object.freeze({
  version: 1, order: Object.freeze(['before', 'after', 'after', 'before', 'before', 'after']),
  warmupMs: 5000, postCheckMs: 5000, healthIntervalMs: 100, requestTimeoutMs: 120000,
  maximumArmMs: 240000, cpuSamplingIntervalUs: 1000,
  route: '/api/openchamber/update-check?appType=web&currentVersion=unknown&reportUsage=false',
});
const CONTRACT = Object.freeze({ available: false, currentVersion: 'unknown', error: 'Unable to check DevRyan releases' });
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (root, value) => { const relative = path.relative(root, value); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function validateWebUpdateCheckOptions(options, environment = process.env) {
  requireCondition(options && typeof options === 'object' && !Array.isArray(options), 'Structured benchmark options are required');
  for (const key of Object.keys(options)) requireCondition(['beforeSource', 'afterSource', 'uiDirectory', 'outputRoot', 'label', 'signal'].includes(key), `Unknown benchmark option: ${key}`);
  for (const key of ['beforeSource', 'afterSource', 'uiDirectory']) {
    requireCondition(typeof options[key] === 'string' && path.isAbsolute(options[key]) && within(ROOT, path.resolve(options[key])), `${key} must be an absolute repository path`);
  }
  const outputRoot = options.outputRoot ?? path.join(ROOT, '.cache/perf/web-update-check');
  requireCondition(path.isAbsolute(outputRoot) && within(path.join(ROOT, '.cache'), path.resolve(outputRoot)), 'Output must be inside repository .cache');
  requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(options.label ?? 'cold-discovery'), 'Invalid benchmark label');
  requireCondition(options.signal === undefined || options.signal instanceof AbortSignal, 'signal must be an AbortSignal');
  for (const key of ['OPENCHAMBER_PACKAGE_MANAGER', 'OPENCHAMBER_UPDATE_API_URL', 'OPENCHAMBER_UI_PASSWORD']) {
    requireCondition(!environment[key]?.trim(), `${key} would invalidate the cold discovery benchmark`);
  }
  requireCondition(environment.OPENCHAMBER_RUNTIME !== 'desktop', 'Desktop bypasses package-manager discovery');
  return { ...options, outputRoot, label: options.label ?? 'cold-discovery' };
}

export function assertUpdateCheckSource(bytes, arm) {
  requireCondition(Object.hasOwn(UPDATE_CHECK_SOURCE_HASHES, arm) && digest(bytes) === UPDATE_CHECK_SOURCE_HASHES[arm], `Unexpected ${arm} package-manager source`);
}

export function createUpdateCheckModuleManifestEntry(filename, bytes) {
  requireCondition(typeof filename === 'string' && path.isAbsolute(filename) && within(ROOT, filename), 'Loaded module must be inside the repository');
  const file = path.relative(ROOT, filename).split(path.sep).join('/');
  // Compute identity before sanitization: distinct readable paths can redact to
  // the same label. The sanitizer already preserves the fingerprint field.
  return { file, fingerprint: digest(file), sha256: digest(bytes) };
}

const moduleManifestEntries = value => {
  requireCondition(Array.isArray(value), 'Module manifest is missing');
  const map = new Map();
  for (const entry of value) {
    requireCondition(entry && typeof entry.file === 'string' && typeof entry.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(entry.fingerprint)
      && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) && !map.has(entry.fingerprint), 'Invalid or duplicate module manifest entry');
    map.set(entry.fingerprint, entry.sha256);
  }
  return map;
};
const moduleManifestIdentity = value => [...moduleManifestEntries(value)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

export function assertOnlyUpdateCheckModuleDiff(before, after) {
  const left = moduleManifestEntries(before); const right = moduleManifestEntries(after);
  requireCondition(left.size === right.size && [...left.keys()].every(fingerprint => right.has(fingerprint)), 'Loaded module membership changed');
  const differences = [...left].filter(([fingerprint, hash]) => right.get(fingerprint) !== hash).map(([fingerprint]) => fingerprint);
  const targetFingerprint = digest(UPDATE_CHECK_MODULE);
  requireCondition(same(differences, [targetFingerprint]) && left.get(targetFingerprint) === UPDATE_CHECK_SOURCE_HASHES.before
    && right.get(targetFingerprint) === UPDATE_CHECK_SOURCE_HASHES.after, 'Comparison must differ only in the exact package-manager module');
}

export function isReadOnlyPackageProbe(command, args) {
  if (typeof command !== 'string' || !Array.isArray(args) || !args.every(value => typeof value === 'string')) return false;
  if (!/^(?:npm|pnpm|yarn|bun)(?:\.exe|\.cmd)?$/.test(path.basename(command))) return false;
  return [ ['--version'], ['root', '-g'], ['prefix', '-g'], ['bin', '-g'], ['global', 'dir'], ['global', 'bin'],
    ['pm', 'bin', '-g'], ['list', '-g', '--depth=0', '@openchamber/web'], ['global', 'list', '--depth=0'], ['pm', 'ls', '-g'] ]
    .some(allowed => same(args, allowed));
}

// Delegate the original call unchanged except for observing completion. Output
// stays in the production caller; evidence retains only lengths and hashes.
export function observePackageProbe(original, kind, { matchesCaller, phase, record, now = () => performance.now() }) {
  const wrapper = function (...args) {
    if (!matchesCaller()) return Reflect.apply(original, this, args);
    if (!isReadOnlyPackageProbe(args[0], args[1])) {
      record({ kind, phase: phase(), startMs: now(), endMs: null, blocked: true });
      throw new Error('Unexpected non-read-only package-manager command');
    }
    const entry = { kind, command: args[0], args: [...args[1]], phase: phase(), startMs: now(), endMs: null };
    record(entry);
    const complete = (error, stdout, stderr, status) => {
      entry.endMs = now(); entry.durationMs = entry.endMs - entry.startMs;
      entry.errorCode = error?.code ?? null; entry.status = status ?? null;
      for (const [name, value] of [['stdout', stdout], ['stderr', stderr]]) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
        entry[name] = { bytes: bytes.length, sha256: digest(bytes) };
      }
    };
    try {
      if (kind === 'spawnSync') {
        const result = Reflect.apply(original, this, args);
        complete(result.error, result.stdout, result.stderr, result.status);
        return result;
      }
      const callback = args.at(-1);
      requireCondition(typeof callback === 'function', 'Detection execFile must retain its callback');
      args[args.length - 1] = function (error, stdout, stderr) {
        complete(error, stdout, stderr, error ? error.code : 0);
        return Reflect.apply(callback, this, [error, stdout, stderr]);
      };
      return Reflect.apply(original, this, args);
    } catch (error) { if (entry.endMs === null) complete(error); throw error; }
  };
  // Preserve util.promisify.custom and other original function properties.
  for (const key of Reflect.ownKeys(original)) if (!['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) {
    Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key));
  }
  return wrapper;
}

export function assertColdUpdateCheckEvidence(evidence, response) {
  requireCondition(response?.status === 200 && same(Object.keys(response.body ?? {}).sort(), Object.keys(CONTRACT).sort())
    && Object.entries(CONTRACT).every(([key, value]) => response.body[key] === value), 'Cold update-check response contract changed');
  requireCondition(evidence && evidence.errors?.length === 0 && evidence.targetLoads === 1, 'Host instrumentation failed or target was not loaded exactly once');
  requireCondition(evidence.requests?.length === 1 && evidence.requests[0].authorized && evidence.requests[0].status === 200
    && Number.isFinite(evidence.requests[0].endMs), 'Exactly one owned cold update-check request is required');
  const probes = evidence.probes.filter(probe => probe.phase !== 'selection-proof');
  requireCondition(evidence.probes.every(probe => !probe.blocked), 'An unexpected discovery command was blocked');
  requireCondition(probes.length > 0 && probes.every(probe => probe.phase === 'cold' && Number.isFinite(probe.endMs)
    && probe.startMs >= evidence.requests[0].startMs && probe.endMs <= evidence.requests[0].endMs), 'Discovery was warm, absent, incomplete, or outside the cold request');
  requireCondition(evidence.selection?.reason === 'cached' && ['npm', 'pnpm', 'yarn', 'bun'].includes(evidence.selection.packageManager), 'Selected package manager was not proven from the completed discovery cache');
  requireCondition(evidence.profileStoppedBeforeSelection === true, 'CPU evidence must end before the extra cached selection lookup');
  requireCondition(evidence.cpu?.complete === true, 'CPU profile is incomplete or cannot be normalized');
}

export function summarizeUpdateCheckCpu(profile, targetUrl) {
  const summary = { complete: false, samples: profile?.samples?.length ?? 0, packageManagerSpawnSyncMs: null,
    scope: 'host bootstrap through cold check and post-check window; selection proof excluded',
    interpretation: 'V8 sampled attribution, not an independent wall-clock duration' };
  if (!Array.isArray(profile?.nodes) || !Array.isArray(profile.samples) || profile.samples.length < 2
    || !Array.isArray(profile.timeDeltas) || profile.samples.length !== profile.timeDeltas.length
    || !profile.timeDeltas.every(Number.isFinite)) return summary;
  const nodes = new Map(profile.nodes.map(node => [node.id, node])); const parents = new Map();
  if (nodes.size !== profile.nodes.length || !profile.samples.every(id => nodes.has(id))) return summary;
  for (const node of profile.nodes) for (const child of node.children ?? []) {
    if (!nodes.has(child) || parents.has(child)) return summary;
    parents.set(child, node.id);
  }
  // V8 can emit samples out of time order. Match DevTools: accumulate timestamps,
  // stable-sort samples with them, then assign forward intervals and an average
  // final interval. Raw deltas precede their sample; they are not its duration.
  let timestamp = 0;
  const samples = profile.samples.map((id, index) => ({ id, index, timestamp: timestamp += profile.timeDeltas[index] }));
  if (!samples.every(sample => Number.isFinite(sample.timestamp))) return summary;
  samples.sort((a, b) => a.timestamp - b.timestamp);
  const averageInterval = (samples.at(-1).timestamp - samples[0].timestamp) / (samples.length - 1);
  if (!Number.isFinite(averageInterval) || averageInterval <= 0) return summary;
  let spawnSyncUs = 0;
  for (let index = 0; index < samples.length; index++) {
    let id = samples[index].id; let hasSync = false; let hasTarget = false;
    const seen = new Set();
    while (id !== undefined) {
      if (seen.has(id)) return summary;
      seen.add(id); const frame = nodes.get(id)?.callFrame;
      hasSync ||= frame?.functionName === 'spawnSync'; hasTarget ||= frame?.url === targetUrl;
      id = parents.get(id);
    }
    const duration = index + 1 < samples.length ? samples[index + 1].timestamp - samples[index].timestamp : averageInterval;
    if (hasSync && hasTarget) spawnSyncUs += duration;
  }
  return { ...summary, complete: true, packageManagerSpawnSyncMs: spawnSyncUs / 1000,
    normalization: { method: 'stable timestamp sort; forward intervals; average terminal interval',
      rawNegativeDeltas: profile.timeDeltas.filter(value => value < 0).length,
      reorderedSamples: samples.filter((sample, index) => sample.index !== index).length,
      sampledWindowMs: averageInterval * samples.length / 1000 } };
}

// Called only by a newly generated owned-host bootstrap, before the real host
// loads. Both arms use the original module URL so install-path detection is real.
export async function installWebUpdateCheckInstrumentation(config) {
  const { registerHooks } = await import('node:module');
  requireCondition(typeof registerHooks === 'function', 'The update-check benchmark requires node:module.registerHooks');
  const { createDiagnosticSanitizer } = await import('../../packages/harness-runtime/lib/sanitizer.js');
  const { Session } = await import('node:inspector');
  const target = pathToFileURL(path.join(ROOT, UPDATE_CHECK_MODULE)).href;
  const bytes = readFileSync(config.source); assertUpdateCheckSource(bytes, config.arm);
  assertUpdateCheckSource(readFileSync(fileURLToPath(target)), 'after');
  const evidence = { targetLoads: 0, effectiveModule: { sha256: digest(bytes) }, requests: [], probes: [], eventLoop: [], errors: [],
    runtime: { node: process.version, versions: process.versions, executable: { path: process.execPath, sha256: digest(readFileSync(process.execPath)) } },
    clocks: { timeOrigin: performance.timeOrigin, description: 'host performance.now milliseconds; driver has its own monotonic clock' } };
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME,
    pathMappings: [{ path: config.runDirectory, placeholder: '<PERF_RUN>' }, { path: ROOT, placeholder: '<REPOSITORY>' }] });
  const write = async (name, value, limit = 16 * 1024 * 1024) => {
    const json = JSON.stringify(sanitizer.sanitizeExportValue(value), null, 2);
    requireCondition(Buffer.byteLength(json) <= limit, `${name} exceeded evidence bound`);
    const destination = path.join(config.runDirectory, name);
    await writeFile(`${destination}.tmp`, json, { mode: 0o600 }); await rename(`${destination}.tmp`, destination);
  };
  const loaded = new Set(); let phase = 'startup';
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith('file:')) {
      const filename = fileURLToPath(url); const relative = path.relative(ROOT, filename);
      if (relative.startsWith('packages/') || relative.startsWith('node_modules/')) {
        if (loaded.size >= 20000 && !loaded.has(filename)) throw new Error('Loaded dependency evidence exceeded its bound');
        loaded.add(filename);
      }
    }
    if (url !== target) return result;
    evidence.targetLoads += 1;
    assertUpdateCheckSource(result.source ?? readFileSync(fileURLToPath(url)), 'after');
    return { ...result, source: bytes.toString('utf8') };
  } });
  const probeObserver = { matchesCaller: () => { const stack = new Error().stack ?? ''; return stack.includes(target) || stack.includes(fileURLToPath(target)); },
    phase: () => phase, record: entry => {
      if (evidence.probes.length >= 1000) {
        if (!evidence.errors.includes('Probe evidence exceeded its bound')) evidence.errors.push('Probe evidence exceeded its bound');
        throw new Error('Probe evidence exceeded its bound');
      }
      evidence.probes.push(entry);
    } };
  childProcess.spawnSync = observePackageProbe(childProcess.spawnSync, 'spawnSync', probeObserver);
  childProcess.execFile = observePackageProbe(childProcess.execFile, 'execFile', probeObserver);
  const originalCreateServer = http.createServer;
  http.createServer = function (...args) {
    const server = Reflect.apply(originalCreateServer, this, args);
    server.prependListener('request', (request, response) => {
      if (new URL(request.url, 'http://127.0.0.1').pathname !== '/api/openchamber/update-check') return;
      const entry = { startMs: performance.now(), endMs: null, authorized: request.method === 'GET'
        && request.url === WEB_UPDATE_CHECK_PROTOCOL.route && request.headers['x-devryan-perf-nonce'] === config.nonce };
      if (evidence.requests.length >= 10) { evidence.errors.push('Update-check request evidence exceeded its bound'); return; }
      evidence.requests.push(entry); phase = 'cold';
      response.once('finish', () => { entry.endMs = performance.now(); entry.status = response.statusCode; phase = 'post-check'; });
    });
    return server;
  };
  syncBuiltinESMExports();
  let previousTick = performance.now();
  const interval = setInterval(() => {
    const now = performance.now();
    if (evidence.eventLoop.length < 5000) evidence.eventLoop.push({ atMs: now, lagMs: Math.max(0, now - previousTick - 100), phase });
    else if (!evidence.errors.includes('Event-loop evidence exceeded its bound')) evidence.errors.push('Event-loop evidence exceeded its bound');
    previousTick = now;
  }, 100);
  interval.unref();
  const session = new Session(); session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: WEB_UPDATE_CHECK_PROTOCOL.cpuSamplingIntervalUs }); await post('Profiler.start');
  let finalizing = false;
  process.on('SIGUSR2', () => {
    if (finalizing) return; finalizing = true;
    void (async () => {
      clearInterval(interval);
      try {
        const { profile } = await post('Profiler.stop'); session.disconnect();
        evidence.cpu = summarizeUpdateCheckCpu(profile, target);
        await write('host.cpuprofile', profile, 64 * 1024 * 1024);
        evidence.profileStoppedBeforeSelection = true; phase = 'selection-proof';
        const { detectPackageManagerDetails } = await import(target);
        const selection = detectPackageManagerDetails();
        evidence.selection = { packageManager: selection.packageManager, reason: selection.reason };
        evidence.loadedModules = [...loaded].sort().map(filename => createUpdateCheckModuleManifestEntry(filename,
          filename === fileURLToPath(target) ? bytes : readFileSync(filename)));
        evidence.memory = process.memoryUsage(); evidence.processCpuUsage = process.cpuUsage();
      } catch (error) { evidence.errors.push(error.message); session.disconnect(); }
      finally { await write('host-evidence.json', evidence); }
    })().catch(error => { process.stderr.write(`Benchmark evidence finalization failed: ${sanitizer.sanitizeText(error.message)}\n`); });
  });
}

const distribution = values => {
  requireCondition(values.length > 0 && values.every(Number.isFinite), 'Incomplete metric samples');
  const sorted = [...values].sort((a, b) => a - b);
  return { minimum: sorted[0], median: sorted[Math.floor(sorted.length / 2)], maximum: sorted.at(-1), count: sorted.length };
};

export function summarizeWebUpdateCheckStudy(arms) {
  requireCondition(arms.length === 6 && arms.every((arm, index) => arm.arm === WEB_UPDATE_CHECK_PROTOCOL.order[index] && arm.outcome === 'passed'), 'Every fixed-order arm must pass; failed or missing arms cannot be dropped');
  const firstBefore = arms.find(arm => arm.arm === 'before'); const firstAfter = arms.find(arm => arm.arm === 'after');
  assertOnlyUpdateCheckModuleDiff(firstBefore.host.loadedModules, firstAfter.host.loadedModules);
  const manifests = { before: moduleManifestIdentity(firstBefore.host.loadedModules), after: moduleManifestIdentity(firstAfter.host.loadedModules) };
  for (const arm of arms) {
    assertColdUpdateCheckEvidence(arm.host, arm.response);
    requireCondition(arm.cleanup.complete && arm.journal?.complete && arm.journal.gapRecords === 0 && arm.journal.errorRecords === 0, 'Unclean cleanup or journal invalidates the comparison');
    requireCondition(same(arm.host.runtime, firstBefore.host.runtime) && arm.host.selection.packageManager === firstBefore.host.selection.packageManager
      && same(arm.source, firstBefore.source) && same(arm.scripts, firstBefore.scripts) && same(arm.ui, firstBefore.ui)
      && same(arm.servedIndex, firstBefore.servedIndex), 'Runtime, source, scripts, UI, or selected package manager changed');
    requireCondition(same(moduleManifestIdentity(arm.host.loadedModules), manifests[arm.arm]), 'Loaded dependency bytes changed within an arm');
  }
  return Object.fromEntries(['before', 'after'].map(name => {
    const selected = arms.filter(arm => arm.arm === name);
    return [name, { coldRequestMs: distribution(selected.map(arm => arm.response.durationMs)),
      maximumHealthLatencyMs: distribution(selected.map(arm => Math.max(...arm.health.map(sample => sample.durationMs)))),
      maximumEventLoopLagMs: distribution(selected.map(arm => Math.max(...arm.host.eventLoop
        .filter(sample => sample.atMs >= arm.host.requests[0].startMs).map(sample => sample.lagMs)))),
      packageManagerSpawnSyncMs: distribution(selected.map(arm => arm.host.cpu.packageManagerSpawnSyncMs)) }];
  }));
}

export async function runWebUpdateCheckBenchmark(input) {
  const options = validateWebUpdateCheckOptions(input);
  const moduleApi = await import('node:module');
  requireCondition(!process.versions.bun && !process.versions.electron && typeof moduleApi.registerHooks === 'function' && process.platform !== 'win32', 'Run the benchmark under native Node with node:module.registerHooks and POSIX signals');
  for (const key of ['beforeSource', 'afterSource', 'uiDirectory']) requireCondition(within(realpathSync(ROOT), realpathSync(options[key])), `${key} escaped the repository`);
  assertUpdateCheckSource(await readFile(options.beforeSource), 'before'); assertUpdateCheckSource(await readFile(options.afterSource), 'after');
  assertUpdateCheckSource(await readFile(path.join(ROOT, UPDATE_CHECK_MODULE)), 'after');
  const [{ createQaProjectFixture, removeQaProjectFixture }, { prepareQaFixtureProfile }, { reservePort, startOwnedProcess },
    { waitForQaHostReady }, { captureQaSourceIdentity, captureQaArtifactIdentity }, { capturePerfJournal }, { createDiagnosticSanitizer }] = await Promise.all([
    import('../qa/project-fixture.mjs'), import('../qa/fixture-scenarios.mjs'), import('../qa/process.mjs'), import('../qa/host-readiness.mjs'),
    import('../qa/artifact-evidence.mjs'), import('./electron-run-evidence.mjs'), import('../../packages/harness-runtime/lib/sanitizer.js'),
  ]);
  const source = await captureQaSourceIdentity(ROOT); const scripts = await captureQaArtifactIdentity(path.join(ROOT, 'scripts'));
  const ui = await captureQaArtifactIdentity(options.uiDirectory); const indexHash = digest(await readFile(path.join(options.uiDirectory, 'index.html')));
  const study = createQaProjectFixture({ outputRoot: options.outputRoot, runId: options.label });
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME,
    pathMappings: [{ path: study.evidenceDirectory, placeholder: '<PERF_STUDY>' }, { path: ROOT, placeholder: '<REPOSITORY>' }] });
  const write = async (directory, name, value) => {
    const text = JSON.stringify(sanitizer.sanitizeExportValue(value), null, 2);
    requireCondition(Buffer.byteLength(text) <= 32 * 1024 * 1024, `${name} exceeded evidence bound`);
    await writeFile(path.join(directory, name), text, { mode: 0o600 });
  };
  const result = { version: 1, protocol: WEB_UPDATE_CHECK_PROTOCOL, startedAt: new Date().toISOString(), outcome: 'failed', arms: [],
    provenance: { source, scripts, ui, effectiveModules: Object.fromEntries(Object.entries(UPDATE_CHECK_SOURCE_HASHES).map(([arm, sha256]) => [arm, { sha256 }])) },
    limitations: ['Fresh processes, not cold OS or package-manager disk caches.', 'Real read-only local package discovery; unknown version intentionally skips release network calls.',
      'Fixture transport only; no renderer, native recovery, managed scheduler or live-provider acceptance.', 'Three alternating pairs are descriptive; V8 attribution and wall-clock metrics use separate clocks.'] };
  await write(study.evidenceDirectory, 'protocol.json', result);
  const freeze = async () => {
    requireCondition((await captureQaSourceIdentity(ROOT)).sha256 === source.sha256, 'Production source changed during the study');
    requireCondition((await captureQaArtifactIdentity(path.join(ROOT, 'scripts'))).sha256 === scripts.sha256, 'Benchmark or QA scripts changed during the study');
    requireCondition((await captureQaArtifactIdentity(options.uiDirectory)).sha256 === ui.sha256, 'UI artifact changed during the study');
    assertUpdateCheckSource(await readFile(path.join(ROOT, UPDATE_CHECK_MODULE)), 'after');
  };
  let interrupted = false; const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    for (const [index, arm] of WEB_UPDATE_CHECK_PROTOCOL.order.entries()) {
      options.signal?.throwIfAborted(); requireCondition(!interrupted, 'Benchmark interrupted'); await freeze();
      const fixture = createQaProjectFixture({ outputRoot: study.evidenceDirectory, runId: `pair-${Math.floor(index / 2) + 1}-${arm}` });
      const directory = fixture.evidenceDirectory; const runtimeRoot = path.join(directory, 'runtime');
      const entry = { arm, pair: Math.floor(index / 2) + 1, order: index + 1, outcome: 'failed', health: [], errors: [],
        directory, source: { sha256: source.sha256 }, scripts: { sha256: scripts.sha256 }, ui: { sha256: ui.sha256 },
        cleanup: { complete: false, errors: [], hostStopped: false, fixtureClosed: false, projectRemoved: false } };
      result.arms.push(entry);
      let profile, host, sampling; let sampleHealth = true; let finalized = false;
      const deadline = Date.now() + WEB_UPDATE_CHECK_PROTOCOL.maximumArmMs;
      const check = () => { options.signal?.throwIfAborted(); requireCondition(!interrupted && Date.now() < deadline, 'Benchmark interrupted or arm deadline exceeded'); host?.check(); };
      const wait = async ms => { const until = performance.now() + ms; while (performance.now() < until) { check(); await delay(Math.min(100, until - performance.now())); } };
      const finalize = async () => {
        if (!host || finalized) return; finalized = true;
        requireCondition(host.child.kill('SIGUSR2'), 'Unable to finalize owned host CPU evidence');
        const until = Date.now() + 45000; const filename = path.join(directory, 'host-evidence.json');
        while (Date.now() < until) {
          host.check();
          try { const size = (await stat(filename)).size; requireCondition(size <= 16 * 1024 * 1024, 'Host evidence exceeded bound'); entry.host = JSON.parse(await readFile(filename, 'utf8')); return; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await delay(100);
        }
        throw new Error('Timed out finalizing owned host CPU evidence');
      };
      try {
        profile = await prepareQaFixtureProfile({ runtimeRoot, workspace: fixture.fixtureRoot, cell: { runtime: 'web', transport: 'fixture', providerId: 'fixture',
          modelId: 'fixture-model', scenarioId: 'core-journey', agent: 'builder', planMode: false, variant: null } });
        const port = await reservePort(); const origin = `http://127.0.0.1:${port}`; const nonce = randomUUID();
        const config = { arm, source: options[arm === 'before' ? 'beforeSource' : 'afterSource'], nonce, runDirectory: directory };
        const bootstrap = path.join(directory, 'bootstrap.mjs');
        await writeFile(bootstrap, `import { installWebUpdateCheckInstrumentation } from ${JSON.stringify(import.meta.url)};\nawait installWebUpdateCheckInstrumentation(${JSON.stringify(config)});\nawait import(${JSON.stringify(pathToFileURL(profile.bootstrapPath).href)});\n`, { mode: 0o600 });
        host = startOwnedProcess(process.execPath, [bootstrap], { cwd: ROOT, env: { ...process.env, ...profile.env,
          OPENCHAMBER_PORT: String(port), OPENCHAMBER_DIST_DIR: options.uiDirectory, OPENCHAMBER_RUNTIME: 'web' } });
        entry.hostPid = host.child.pid; entry.profile = profile.evidence;
        entry.ready = await waitForQaHostReady({ origin, checkAlive: check });
        const indexResponse = await fetch(origin, { signal: AbortSignal.timeout(10000) });
        requireCondition(indexResponse.ok, 'Pinned UI index was not served');
        entry.servedIndex = { sha256: digest(Buffer.from(await indexResponse.arrayBuffer())) };
        requireCondition(entry.servedIndex.sha256 === indexHash, 'Served UI differs from the pinned artifact');
        sampling = (async () => {
          while (sampleHealth) {
            const startMs = performance.now(); const sample = { startMs, endMs: null };
            try {
              const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(WEB_UPDATE_CHECK_PROTOCOL.requestTimeoutMs) });
              sample.status = response.status; const body = await response.json(); sample.ready = body.isOpenCodeReady;
            } catch (error) { sample.error = error.message; }
            sample.endMs = performance.now(); sample.durationMs = sample.endMs - startMs;
            entry.health.push(sample); requireCondition(entry.health.length <= 5000, 'Health evidence exceeded its bound');
            if (sampleHealth) await delay(Math.max(0, WEB_UPDATE_CHECK_PROTOCOL.healthIntervalMs - sample.durationMs));
          }
        })();
        await wait(WEB_UPDATE_CHECK_PROTOCOL.warmupMs);
        const startMs = performance.now();
        const response = await fetch(`${origin}${WEB_UPDATE_CHECK_PROTOCOL.route}`, { headers: { 'x-devryan-perf-nonce': nonce }, signal: AbortSignal.timeout(WEB_UPDATE_CHECK_PROTOCOL.requestTimeoutMs) });
        const body = await response.json(); const endMs = performance.now();
        entry.response = { status: response.status, body, startMs, endMs, durationMs: endMs - startMs };
        await wait(WEB_UPDATE_CHECK_PROTOCOL.postCheckMs); sampleHealth = false; await sampling;
        await finalize(); assertColdUpdateCheckEvidence(entry.host, entry.response);
        requireCondition(entry.health.length >= 50 && entry.health.every(sample => sample.status === 200 && sample.ready && !sample.error), 'Health sampling was incomplete or unhealthy');
        const diagnostics = await fetch(`${origin}/api/diagnostics/status`, { signal: AbortSignal.timeout(10000) });
        requireCondition(diagnostics.ok, 'Diagnostics status unavailable'); entry.diagnostics = await diagnostics.json();
        entry.outcome = 'passed';
      } catch (error) { entry.errors.push(error.message); }
      finally {
        sampleHealth = false;
        if (sampling) try { await sampling; } catch (error) { entry.errors.push(error.message); }
        if (host) {
          try { await finalize(); } catch (error) { entry.errors.push(error.message); }
          try { await host.stop(); await host.auditStopped(); entry.cleanup.hostStopped = true; }
          catch (error) { entry.cleanup.errors.push(error.message); }
          entry.cleanup.processes = host.getCleanupEvidence();
          await writeFile(path.join(directory, 'host.log'), sanitizer.sanitizeText(host.getLog()), { mode: 0o600 });
        } else entry.cleanup.hostStopped = true;
        if (profile) {
          entry.fixture = profile.fixture.getState();
          try { await profile.close(); entry.cleanup.fixtureClosed = true; } catch (error) { entry.cleanup.errors.push(error.message); }
          if (host) {
            try { await host.auditStopped(); } catch (error) { entry.cleanup.hostStopped = false; entry.cleanup.errors.push(error.message); }
            entry.cleanup.processes = host.getCleanupEvidence();
          }
          try {
            const journal = path.join(directory, 'journal');
            await rename(path.join(profile.evidence.isolation.data, 'harness/journal'), journal);
            entry.journal = await capturePerfJournal(journal);
            requireCondition(entry.journal.complete && entry.journal.gapRecords === 0 && entry.journal.errorRecords === 0, 'Journal incomplete or contains gaps/errors');
          } catch (error) { entry.errors.push(`Journal: ${error.message}`); }
          if (entry.fixture.unknownRoutes?.length || entry.fixture.activePrompts || entry.fixture.receivedPrompts?.length) entry.errors.push('Fixture observed unknown routes or unexpected prompts');
        } else entry.cleanup.fixtureClosed = true;
        if (entry.cleanup.hostStopped && entry.cleanup.fixtureClosed) {
          try { removeQaProjectFixture(fixture); entry.cleanup.projectRemoved = true; } catch (error) { entry.cleanup.errors.push(error.message); }
        } else entry.cleanup.errors.push('Project retained because owned host or fixture cleanup is incomplete');
        entry.cleanup.complete = entry.cleanup.errors.length === 0 && entry.cleanup.hostStopped && entry.cleanup.fixtureClosed && entry.cleanup.projectRemoved;
        if (entry.errors.length || !entry.cleanup.complete) entry.outcome = 'failed';
        await write(directory, 'result.json', entry);
      }
      await freeze(); await write(study.evidenceDirectory, 'result.json', result);
      requireCondition(entry.cleanup.complete, 'Owned cleanup failed; remaining arms were not launched');
      requireCondition(entry.outcome === 'passed', 'Benchmark arm failed; remaining arms were not launched');
    }
    result.comparison = summarizeWebUpdateCheckStudy(result.arms); result.outcome = 'passed';
  } catch (error) { result.error = error.message; }
  finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    try { removeQaProjectFixture(study); } catch (error) { result.outcome = 'failed'; result.cleanupError = error.message; }
    result.finishedAt = new Date().toISOString();
    await write(study.evidenceDirectory, 'result.json', result);
  }
  return { outcome: result.outcome, resultFile: path.join(study.evidenceDirectory, 'result.json'), result };
}
