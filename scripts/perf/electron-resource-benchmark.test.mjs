import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  compareBenchmarkSummaries,
  compareLifecycleSummaries,
  assertPerfPackageEvidenceUnchanged,
  lifecycleProtocolIdentity,
  interactiveProtocolIdentity,
  injectPlanSkeleton,
  median,
  parseBenchmarkArguments,
  runElectronResourceBenchmark,
  summarizeMemorySamples,
  summarizeStartupRuns,
  stopPerfOwnedResources,
  waitForPlanSkeletonDocument,
} from './electron-resource-benchmark.mjs';

const sample = (tabCpu, gpuCpu, tabMemory, browserMemory = 200) => ({
  process: { rss: browserMemory },
  appMetrics: [
    { type: 'Browser', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: browserMemory } },
    { type: 'Tab', cpu: { percentCPUUsage: tabCpu }, memory: { workingSetSize: tabMemory } },
    { type: 'GPU', cpu: { percentCPUUsage: gpuCpu }, memory: { workingSetSize: 50 } },
  ],
});

describe('Electron resource benchmark metrics', () => {
  it('waits for the requested new loader and document body even when the old document is ready', async () => {
    const url = 'http://127.0.0.1:3100/?session=ses_perfparent';
    const frame = { id: 'main', loaderId: 'new-loader', url };
    const oldDocument = { href: url, timeOrigin: 1, readyState: 'complete', body: true };
    const newDocument = { ...oldDocument, timeOrigin: 2 };
    const frames = [
      { ...frame, loaderId: 'old-loader' },
      { ...frame, url: 'http://127.0.0.1:3100/?session=wrong' },
      frame, frame, frame, frame, frame, frame, frame, frame,
    ];
    const documents = [{ ...newDocument, href: 'http://127.0.0.1:3100/' }, oldDocument,
      { ...newDocument, body: false }, newDocument];
    const calls = [];
    const cdp = { send: async method => {
      calls.push(method);
      if (method === 'Page.getFrameTree') {
        assert.ok(frames.length, 'Unexpected extra frame read');
        return { frameTree: { frame: frames.shift() } };
      }
      assert.equal(method, 'Runtime.evaluate');
      assert.ok(documents.length, 'Unexpected extra document read');
      return { result: { value: documents.shift() } };
    } };
    const result = await waitForPlanSkeletonDocument(cdp, { url, navigation: { frameId: 'main', loaderId: 'new-loader' },
      previousDocument: { frameId: 'main', loaderId: 'old-loader', timeOrigin: 1 }, deadline: Date.now() + 2000 });
    assert.deepEqual(result, { ...newDocument, frameId: 'main', loaderId: 'new-loader', previousLoaderId: 'old-loader' });
    assert.equal(frames.length, 0);
    assert.equal(documents.length, 0);
    assert.equal(calls.filter(method => method === 'Runtime.evaluate').length, 4);
    assert.ok(calls.every(method => ['Page.getFrameTree', 'Runtime.evaluate'].includes(method)));
  });

  it('rejects failed or same-document navigation and a document replaced during the readiness check', async () => {
    const url = 'http://127.0.0.1:3100/?session=ses_perfparent';
    const options = { url, previousDocument: { frameId: 'main', loaderId: 'old', timeOrigin: 1 }, deadline: Date.now() + 1000 };
    const noReads = { send: async () => assert.fail('Invalid navigation must not inspect or mutate the page') };
    for (const navigation of [{ frameId: 'main' }, { frameId: 'main', loaderId: 'old' },
      { frameId: 'other', loaderId: 'new' }, { frameId: 'main', loaderId: 'new', errorText: 'navigation failed' },
      { frameId: 'main', loaderId: 'new', isDownload: true }]) {
      await assert.rejects(waitForPlanSkeletonDocument(noReads, { ...options, navigation }), /successful navigation to a new document loader/);
    }
    let frames = 0;
    const cdp = { send: async method => method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'main', url, loaderId: ++frames === 1 ? 'new' : 'replacement' } } }
      : { result: { value: { href: url, timeOrigin: 2, readyState: 'complete', body: true } } } };
    await assert.rejects(waitForPlanSkeletonDocument(cdp, { ...options, navigation: { frameId: 'main', loaderId: 'new' },
      deadline: Date.now() + 25 }), /Timed out/);
    assert.ok(frames >= 2);
  });

  it('rejects readiness that arrives after the navigation deadline', async () => {
    const url = 'http://127.0.0.1:3100/?session=ses_perfparent';
    const cdp = { send: async method => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'new', url } } };
      assert.equal(method, 'Runtime.evaluate');
      await new Promise(resolve => setTimeout(resolve, 30));
      return { result: { value: { href: url, timeOrigin: 2, readyState: 'complete', body: true } } };
    } };
    await assert.rejects(waitForPlanSkeletonDocument(cdp, { url, navigation: { frameId: 'main', loaderId: 'new' },
      previousDocument: { frameId: 'main', loaderId: 'old', timeOrigin: 1 }, deadline: Date.now() + 10 }), /Timed out/);
  });

  it('rechecks document identity and body in the same evaluation that inserts all 48 skeleton lines', async () => {
    const expected = { href: 'http://127.0.0.1:3100/?session=ses_perfparent', timeOrigin: 2 };
    const appended = [];
    const document = { readyState: 'complete', body: { isConnected: true, appendChild: host => appended.push(host) },
      getElementById: () => null, createElement: () => ({ style: {}, dataset: {}, children: [],
        appendChild(line) { this.children.push(line); }, getAnimations() { return this.children.map(() => ({ playState: 'running' })); } }) };
    const context = { document, location: { href: expected.href }, performance: { timeOrigin: expected.timeOrigin } };
    const cdp = { send: async (method, { expression }) => {
      assert.equal(method, 'Runtime.evaluate');
      try { return { result: { value: runInNewContext(expression, context) } }; }
      catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
    } };
    for (const change of [() => { context.performance.timeOrigin = 1; }, () => { context.location.href = 'http://127.0.0.1:3100/'; },
      () => { document.readyState = 'loading'; }, () => { document.body.isConnected = false; }]) {
      change();
      await assert.rejects(injectPlanSkeleton(cdp, expected), /document changed before plan skeleton insertion/);
      assert.equal(appended.length, 0);
      context.performance.timeOrigin = expected.timeOrigin;
      context.location.href = expected.href;
      document.readyState = 'complete';
      document.body.isConnected = true;
    }
    const result = await injectPlanSkeleton(cdp, expected);
    assert.equal(result.lineCount, 48);
    assert.equal(result.runningAnimations, 48);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].className, 'oc-plan-skeleton-lines');
  });

  it('audits the retained owner again after fixture closure and records detached cleanup evidence', async () => {
    const order = [];
    const ownership = { source: 'retained-os-process-ancestry-and-start-identities', rootPid: 123,
      signals: [{ pid: 456, signal: 'SIGTERM' }], observedProcesses: [{ pid: 456, startIdentity: 'owned-start' }], remainingProcessIds: [] };
    const owner = { child: { pid: 123, exitCode: 0, signalCode: null },
      stop: async () => { order.push('stop-with-first-audit'); },
      auditStopped: async () => { order.push('audit-after-fixture'); }, getCleanupEvidence: () => ownership };
    const fixture = { close: async () => { order.push('close-fixture'); }, getState: () => ({ activePrompts: 0 }) };
    const cleanup = await stopPerfOwnedResources(owner, fixture);
    assert.deepEqual(order, ['stop-with-first-audit', 'close-fixture', 'audit-after-fixture']);
    assert.equal(cleanup.complete, true);
    assert.equal(cleanup.app.ownership, ownership);
    assert.equal(cleanup.app.escalated, true);
    assert.equal(cleanup.fixture.closed, true);
  });

  it('retains every cleanup failure and still closes the fixture and performs the second audit', async () => {
    for (const failure of ['stop', 'fixture', 'audit']) {
      const order = [];
      const owner = { child: { pid: 123, exitCode: 0, signalCode: null },
        stop: async () => { order.push('stop'); if (failure === 'stop') throw new Error('stop failed'); },
        auditStopped: async () => { order.push('audit'); if (failure === 'audit') throw new Error('detached child remains'); },
        getCleanupEvidence: () => ({ source: 'retained ownership', signals: [], remainingProcessIds: failure === 'audit' ? [456] : [] }) };
      const fixture = { close: async () => { order.push('fixture'); if (failure === 'fixture') throw new Error('fixture failed'); }, getState: () => ({}) };
      const cleanup = await stopPerfOwnedResources(owner, fixture);
      assert.deepEqual(order, ['stop', 'fixture', 'audit']);
      assert.equal(cleanup.complete, false);
      assert.equal(cleanup.errors.length, 1);
      if (failure === 'audit') assert.equal(cleanup.app.stopped, false);
    }
  });

  it('pins the exact initial package evidence even if replacement metadata is otherwise valid JSON', () => {
    const original = Buffer.from(JSON.stringify({ archiveSha256: 'old', source: { sha256: 'source' } }));
    const expected = createHash('sha256').update(original).digest('hex');
    assert.doesNotThrow(() => assertPerfPackageEvidenceUnchanged(expected, original));
    for (const replacement of [Buffer.from(JSON.stringify({ archiveSha256: 'new', source: { sha256: 'source' } })),
      Buffer.from(original.toString() + '\n')]) {
      assert.throws(() => assertPerfPackageEvidenceUnchanged(expected, replacement), /Pinned package evidence changed/);
    }
  });

  it('invalidates every scenario protocol when the fixture or owned-process dependencies change', async () => {
    const original = await lifecycleProtocolIdentity(async () => 'original module bytes');
    for (const changed of ['loopback-opencode-fixture.mjs', '../qa/process.mjs', '../qa/process-ownership.mjs', '../dev-child-utils.mjs']) {
      const current = await lifecycleProtocolIdentity(async file => file === changed ? 'changed module bytes' : 'original module bytes');
      assert.notEqual(current, original, `Missing protocol dependency: ${changed}`);
    }
  });

  it('parses bounded smoke overrides while retaining production defaults', () => {
    const defaults = parseBenchmarkArguments([]);
    assert.equal(defaults.runs, 3);
    assert.equal(defaults.warmupMs, 5_000);
    assert.equal(defaults.measureMs, 30_000);
    assert.deepEqual(defaults.scenarios, ['idle', 'one-stream', 'four-stream', 'plan-skeleton']);

    const smoke = parseBenchmarkArguments([
      '--label', 'smoke',
      '--scenarios', 'idle,four-stream',
      '--runs', '1',
      '--warmup-ms', '10',
      '--measure-ms', '20',
    ]);
    assert.deepEqual(smoke.scenarios, ['idle', 'four-stream']);
    assert.equal(smoke.runs, 1);
    assert.equal(smoke.warmupMs, 10);
    assert.equal(smoke.measureMs, 20);
  });

  it('validates imported startup modes before loading artifacts and keeps full interactive/memory startup natural', async () => {
    for (const startupMode of [null, true, '', 'visible', [], {}]) {
      await assert.rejects(runElectronResourceBenchmark({ startupMode }), /startupMode must be natural or foreground/);
    }
    for (const scenario of ['interactive', 'session-memory', 'idle,interactive']) {
      await assert.rejects(runElectronResourceBenchmark({ startupMode: 'foreground', argv: [
        '--scenarios', scenario, '--package-evidence', '.cache/qa/not-loaded.json',
      ] }), /Foreground startup is only supported for resource scenarios/);
    }
    assert.throws(() => parseBenchmarkArguments(['--startup-mode', 'foreground']), /Unknown benchmark flag/);
  });

  it('admits typing-only foreground setup and rejects invalid scopes before artifact loading', async () => {
    for (const interactiveScope of [null, true, '', 'partial', [], {}]) {
      await assert.rejects(runElectronResourceBenchmark({ interactiveScope }), /interactiveScope must be full or typing/);
    }
    for (const scenario of ['idle', 'session-memory', 'idle,interactive']) {
      await assert.rejects(runElectronResourceBenchmark({ interactiveScope: 'typing', argv: [
        '--scenarios', scenario, '--package-evidence', '.cache/qa/not-loaded.json',
      ] }), /Typing scope requires only the interactive scenario/);
    }
    // ENOENT proves admission reached the artifact boundary; no host can start.
    for (const startupMode of ['natural', 'foreground']) {
      await assert.rejects(runElectronResourceBenchmark({ startupMode, interactiveScope: 'typing', argv: [
        '--scenarios', 'interactive', '--package-evidence', '.cache/qa/typing-scope-test-missing/package-evidence.json',
      ] }), error => error.code === 'ENOENT');
    }
    assert.throws(() => parseBenchmarkArguments(['--interactive-scope', 'typing']), /Unknown benchmark flag/);
  });

  it('pins actual interactive scope and startup mode plus every common lifecycle dependency', async () => {
    const read = async () => 'unchanged module bytes';
    const identities = [];
    for (const startupMode of ['natural', 'foreground']) {
      for (const interactiveScope of ['full', 'typing']) identities.push(await interactiveProtocolIdentity(startupMode, interactiveScope, read));
    }
    assert.equal(new Set(identities).size, 4);
    assert.equal(await interactiveProtocolIdentity(undefined, undefined, read), identities[0]);
    for (const changed of ['electron-interactive-benchmark.mjs', 'electron-lifecycle-benchmark.mjs',
      'loopback-opencode-fixture.mjs', '../qa/process.mjs', '../qa/process-ownership.mjs', '../dev-child-utils.mjs']) {
      assert.notEqual(await interactiveProtocolIdentity('foreground', 'typing', async file => file === changed ? 'changed' : read()), identities[3]);
    }
    await assert.rejects(interactiveProtocolIdentity('unknown', 'typing', read), /startupMode/);
    await assert.rejects(interactiveProtocolIdentity('natural', 'unknown', read), /interactiveScope/);
  });

  it('pins the normalized startup mode in protocol identity and rejects mixed comparison modes', async () => {
    const read = async () => 'unchanged module bytes';
    assert.equal(await lifecycleProtocolIdentity(read), await lifecycleProtocolIdentity(read, 'natural'));
    assert.notEqual(await lifecycleProtocolIdentity(read, 'foreground'), await lifecycleProtocolIdentity(read, 'natural'));
    await assert.rejects(lifecycleProtocolIdentity(read, 'unknown'), /startupMode must be natural or foreground/);
    for (const compare of [compareBenchmarkSummaries, compareLifecycleSummaries]) {
      for (const baseline of [{}, { startupMode: 'natural' }]) {
        assert.throws(() => compare(baseline, { startupMode: 'foreground' }), /matching startupMode/);
        assert.throws(() => compare({ startupMode: 'foreground' }, baseline), /matching startupMode/);
      }
      assert.throws(() => compare({ startupMode: null }, { startupMode: 'natural' }), /startupMode must be natural or foreground/);
    }
  });

  it('discards the first CPU sample and reports medians by Electron process type', () => {
    const summary = summarizeMemorySamples([
      sample(0, 0, 0),
      sample(40, 10, 100),
      sample(20, 6, 80),
      sample(30, 8, 90),
    ]);
    assert.equal(summary.sampleCount, 3);
    assert.equal(summary.medianTabCpu, 30);
    assert.equal(summary.medianGpuCpu, 8);
    assert.equal(summary.medianTabWorkingSet, 90);
    assert.equal(summary.medianTotalAppWorkingSet, 340);
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });

  it('requires one explicit packaged artifact source for isolated measurements', () => {
    assert.ok(parseBenchmarkArguments(['--package-evidence', '.cache/qa/package-evidence.json']).packageEvidence.endsWith('/.cache/qa/package-evidence.json'));
    assert.throws(() => parseBenchmarkArguments(['--package-evidence', '.cache/qa/package-evidence.json', '--electron-binary', 'test.app']), /not both/);
    assert.throws(() => parseBenchmarkArguments(['--scenarios', 'session-memory']), /requires --package-evidence/);
    assert.throws(() => parseBenchmarkArguments(['--scenarios', 'interactive']), /requires --package-evidence/);
    assert.deepEqual(parseBenchmarkArguments(['--scenarios', 'session-memory', '--package-evidence', '.cache/qa/package-evidence.json']).scenarios, ['session-memory']);
    assert.deepEqual(parseBenchmarkArguments(['--scenarios', 'interactive', '--package-evidence', '.cache/qa/package-evidence.json']).scenarios, ['interactive']);
  });

  it('reports startup failures explicitly and keeps lifecycle comparisons descriptive and matched', () => {
    assert.deepEqual(summarizeStartupRuns([{ outcome: 'passed', uiReadyMs: 100 }, { outcome: 'failed' }, { outcome: 'passed', uiReadyMs: 300 }]), {
      successfulRuns: 2, totalRuns: 3, medianUiReadyMs: 200, minimumUiReadyMs: 100, maximumUiReadyMs: 300,
    });
    const baseline = { fixtureSha256: 'fixture', lifecycleProtocolSha256: 'protocol', runsPerScenario: 3,
      warmupMs: 5000, measureMs: 30000, sampleIntervalMs: 500, scenarios: { 'session-memory': {
        chromium: { product: 'Chrome/123' }, startup: { successfulRuns: 3, totalRuns: 3, medianUiReadyMs: 1000 },
        display: { innerWidth: 1280, visibilityState: 'visible', devicePixelRatio: 1 },
        memory: { inactive: { postGcHeapDeltaFromInitialBytes: 100 }, deleted: { postGcHeapDeltaFromInitialBytes: 10 } },
      } } };
    const current = structuredClone(baseline);
    current.scenarios['session-memory'].startup.medianUiReadyMs = 900;
    current.scenarios['session-memory'].memory.deleted.postGcHeapDeltaFromInitialBytes = 5;
    const comparison = compareLifecycleSummaries(baseline, current);
    assert.equal(comparison.passed, undefined);
    assert.equal(comparison.changes['session-memory'].startupMs, -100);
    assert.equal(comparison.changes['session-memory'].memory.deleted.postGcHeapDeltaFromInitialBytes, -5);
    assert.throws(() => compareLifecycleSummaries(baseline, { ...current, fixtureSha256: 'different' }), /matching fixtureSha256/);
    current.scenarios['session-memory'].display.innerWidth = 900;
    assert.throws(() => compareLifecycleSummaries(baseline, current), /display\/window conditions/);
    current.scenarios['session-memory'].display.innerWidth = 1280;
    current.scenarios['session-memory'].startup.successfulRuns = 2;
    assert.throws(() => compareLifecycleSummaries(baseline, current), /successful first-document/);
  });

  it('applies renderer, GPU, idle, and memory acceptance gates', () => {
    const scenario = (tabCpu, gpuCpu, tabMemory, totalMemory) => ({
      aggregate: {
        medianTabCpu: tabCpu,
        medianGpuCpu: gpuCpu,
        medianTabWorkingSet: tabMemory,
        medianTotalAppWorkingSet: totalMemory,
      },
    });
    const baseline = {
      scenarios: {
        idle: scenario(10, 1, 100, 200),
        'one-stream': scenario(20, 2, 100, 200),
        'four-stream': scenario(100, 10, 100, 200),
        'plan-skeleton': scenario(20, 20, 100, 200),
      },
    };
    const current = {
      scenarios: {
        idle: scenario(10.5, 1, 100, 200),
        'one-stream': scenario(21, 2, 100, 200),
        'four-stream': scenario(75, 10, 105, 210),
        'plan-skeleton': scenario(20, 10, 100, 200),
      },
    };

    const comparison = compareBenchmarkSummaries(baseline, current);
    assert.equal(comparison.passed, true);
    assert.equal(comparison.checks.length, 6);
  });
});
