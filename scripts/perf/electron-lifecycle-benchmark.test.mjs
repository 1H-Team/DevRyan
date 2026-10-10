import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { createLoopbackOpenCodeV2Fixture } from './loopback-opencode-v2-fixture.mjs';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import { createQaUiDriver } from '../qa/ui-driver.mjs';
import {
  captureFirstDocumentStartup,
  captureMemoryCheckpoint,
  assertEarlierCanonicalHistory,
  historyCoverage,
  loadOlderHistoryPage,
  observeStartupNavigation,
  prepareMemorySessions,
  parseStartupPhaseLogs,
  projectRendererMemory,
  selectedFixtureModelIsAvailable,
  SESSION_MEMORY_FIXTURE,
  summarizeMemoryCheckpoints,
  sanitizeStartupPhases,
} from './electron-lifecycle-benchmark.mjs';

const host = { process: { heapUsed: 99999 }, appMetrics: [
  { type: 'Browser', pid: 1, creationTime: 1, memory: { workingSetSize: 500 } },
  { type: 'Tab', pid: 2, creationTime: 10, memory: { workingSetSize: 200 } },
] };
const heap = { usedSize: 123, totalSize: 456 };
const dom = { documents: 1, nodes: 20, jsEventListeners: 5 };

test('a buffered history reveal must prove older canonical content in the exact session', () => {
  const row = (id, created, sessionID = 'ses_history') => ({ info: { id, sessionID, time: { created } }, parts: [{ type: 'text', text: id }] });
  const before = row('msg_newer', 200);
  assert.doesNotThrow(() => assertEarlierCanonicalHistory(before, row('msg_older', 100), 'ses_history'));
  for (const after of [before, row('msg_newer-again', 200), row('msg_future', 300), row('msg_foreign', 100, 'ses_other'),
    row('msg_unknown', NaN), { ...row('msg_empty', 100), parts: [] }]) {
    assert.throws(() => assertEarlierCanonicalHistory(before, after, 'ses_history'));
  }
});

test('fixture preparation owns four independent histories without submitting prompts', async () => {
  const fixture = await createLoopbackOpenCodeV2Fixture({ directory: path.resolve('.cache/perf/lifecycle-unit-workspace') });
  try {
    const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }), getAuthHeaders: () => fixture.authHeaders });
    const sessions = await prepareMemorySessions(fixture);
    assert.equal(sessions.length, 4);
    assert.equal(new Set(sessions.map(session => session.id)).size, 4);
    for (const session of sessions) {
      const rows = (await client.sessions.messages(session.id, { limit: 1000 }, { directory: fixture.directory })).records;
      assert.equal(rows.length, SESSION_MEMORY_FIXTURE.turns * 2);
      assert.equal(rows.at(-1).parts.find(part => part.type === 'text').text.length, SESSION_MEMORY_FIXTURE.textBytes);
      assert.equal(rows[0].info.sessionID, session.id);
    }
    assert.equal(fixture.getState().receivedPrompts.length, 0);
  } finally { await fixture.close(); }
});

test('history coverage ignores overlapping adaptive snapshots and counts a contiguous older chain', () => {
  const pages = [
    { before: null, returned: 50, firstMessageID: 'm310' },
    { before: null, returned: 100, firstMessageID: 'm260' },
    { before: 'm260', returned: 200, firstMessageID: 'm060' },
    { before: 'm060', returned: 60, firstMessageID: 'm000' },
    { before: 'm060', returned: 60, firstMessageID: 'm000' },
  ];
  assert.equal(historyCoverage(pages), 360);
  assert.equal(historyCoverage(pages.slice(0, 2)), 100);
  assert.equal(historyCoverage([{ before: 'unrelated', returned: 900, firstMessageID: 'm000' }]), 0);
});

test('Load Older requires this click’s fresh contiguous page and visible canonical row, independent of scroll height', async t => {
  const session = { id: 'ses_history', expectedMessages: 360 };
  const firstMessageID = 'msg_110';
  const canonicalText = 'History request 56';
  const server = http.createServer((request, response) => {
    assert.equal(request.url, `/session/${session.id}/message/${firstMessageID}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ info: { id: firstMessageID, sessionID: session.id, role: 'user' },
      parts: [{ type: 'text', text: canonicalText }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  for (const failure of [undefined, 'adaptive initial snapshot', 'unrelated after adaptive snapshot', 'HTTP only', 'unchanged page', 'stale page', 'wrong session', 'absent DOM', 'wrong text']) {
    await t.test(failure ?? 'same-height canonical commit', async () => {
      const pages = [
        { sessionID: session.id, before: null, returned: 360, firstMessageID: 'msg_stale' },
        { sessionID: session.id, before: null, returned: 50, firstMessageID: 'msg_310' },
      ];
      const scroll = { scrollHeight: 1000 };
      const row = { isConnected: true, innerText: canonicalText, parentElement: null,
        getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }) };
      const location = { href: `http://renderer.invalid/?session=${session.id}` };
      let clicked = false;
      let reveals = 0;
      const document = {
        querySelector: selector => selector === '[data-scrollbar="chat"]' ? scroll
          : clicked && !['HTTP only', 'absent DOM'].includes(failure) && selector.includes(firstMessageID) ? row : null,
        createTreeWalker: root => { let visited = false; return { nextNode: () => {
          if (visited) return null; visited = true; return { textContent: root.innerText, parentElement: root };
        } }; },
        createRange: () => ({ selectNodeContents: () => {}, getClientRects: () => [row.getBoundingClientRect()] }),
      };
      const context = vm.createContext({ document, location, URL, innerWidth: 800, innerHeight: 600,
        NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ opacity: '1', display: 'block', visibility: 'visible' }) });
      const cdp = { send: async (method, { expression }) => {
        assert.equal(method, 'Runtime.evaluate');
        return { result: { value: vm.runInContext(expression, context) } };
      } };
      const ui = createQaUiDriver(cdp, { timeoutMs: -1 });
      ui.click = async options => {
        assert.deepEqual(options, { text: 'LOAD OLDER MESSAGES' });
        assert.equal(clicked, false); clicked = true;
        if (failure) scroll.scrollHeight += 500;
        if (failure?.includes('adaptive')) pages.push({ sessionID: session.id, before: null, returned: 100, firstMessageID: 'msg_260' });
        if (failure !== 'unchanged page') pages.push({ sessionID: session.id,
          before: failure === 'stale page' ? null : failure === 'adaptive initial snapshot' ? 'msg_260'
            : failure === 'unrelated after adaptive snapshot' ? 'unrelated' : 'msg_310', returned: failure === 'stale page' ? 50 : 200,
          firstMessageID: failure === 'stale page' ? 'msg_310' : firstMessageID });
        if (failure === 'wrong session') location.href = 'http://renderer.invalid/?session=ses_other';
        if (failure === 'wrong text') row.innerText = 'An earlier unrelated response';
      };
      ui.reveal = async (selector, text, options) => {
        assert.equal(selector, `[data-scrollbar="chat"] [data-message-id="${firstMessageID}"]`);
        assert.equal(text, undefined);
        assert.deepEqual(options, { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
        reveals += 1;
      };
      const fixture = { origin: `http://127.0.0.1:${server.address().port}`,
        getState: () => ({ messagePageRequests: structuredClone(pages) }) };
      const run = loadOlderHistoryPage({ session, ui, fixture, messagePageRequestOffset: 1 });
      if (failure && failure !== 'adaptive initial snapshot') await assert.rejects(run, undefined, `${failure} must not count as a UI page commit`);
      else {
        const result = await run;
        assert.equal(result.coveredMessages, failure === 'adaptive initial snapshot' ? 300 : 250, 'The old cumulative full-page read must be excluded');
        assert.equal(result.firstMessageID, firstMessageID);
        assert.equal(result.canonicalText, canonicalText);
        assert.equal(result.sessionID, session.id);
        assert.equal(reveals, 1);
        assert.equal(scroll.scrollHeight, failure === 'adaptive initial snapshot' ? 1500 : 1000);
      }
      assert.equal(clicked, true);
    });
  }
});

test('renderer metrics use CDP heap bytes and a single identified Tab working set in KiB', () => {
  const projected = projectRendererMemory({ host, heap, dom });
  assert.equal(projected.rendererWorkingSetBytes, 204800);
  assert.equal(projected.rendererHeapUsedBytes, 123);
  assert.equal(projected.mainProcess.heapUsed, 99999);
  assert.throws(() => projectRendererMemory({ host: { appMetrics: [] }, heap, dom }), /exactly one renderer/);
  assert.throws(() => projectRendererMemory({ host: { appMetrics: [...host.appMetrics, host.appMetrics[1]] }, heap, dom }), /exactly one renderer/);
  assert.throws(() => projectRendererMemory({ host, heap: {}, dom }), /Incomplete renderer/);
});

test('natural samples precede explicit GC and checkpoint deltas retain their sign', async () => {
  let collected = false;
  const methods = [];
  const cdp = { send: async method => {
    methods.push(method);
    if (method === 'HeapProfiler.collectGarbage') { collected = true; return {}; }
    if (method === 'Runtime.getHeapUsage') return { usedSize: collected ? 100 : 150, totalSize: 200 };
    if (method === 'Memory.getDOMCounters') return dom;
    throw new Error(`Unexpected CDP method ${method}`);
  } };
  const initial = await captureMemoryCheckpoint({ name: 'initial', cdp, readHostMemory: async () => host, measureMs: 1, settleMs: 0 });
  assert.equal(initial.samples[0].rendererHeapUsedBytes, 150);
  assert.equal(initial.postGc.rendererHeapUsedBytes, 100);
  assert.ok(methods.indexOf('HeapProfiler.collectGarbage') > methods.indexOf('Runtime.getHeapUsage'));
  const deleted = { ...initial, name: 'deleted', postGc: { ...initial.postGc, rendererHeapUsedBytes: 90 } };
  assert.equal(summarizeMemoryCheckpoints([initial, deleted]).deleted.postGcHeapDeltaFromInitialBytes, -10);
});

test('startup includes natural native documents while excluding benchmark-forced navigation', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/provider'
      ? { connected: ['fixture'], all: [{ id: 'fixture', models: { 'fixture-model': {} } }] }
      : { isOpenCodeReady: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const snapshot = { timeOrigin: 42, navigation: { type: 'navigate' }, composer: true, newChat: true, model: true, visibilityState: 'visible',
    selectedModel: { providerId: 'fixture', modelId: 'fixture-model', catalogAvailable: true } };
  const fixture = { getState: () => ({ sseClientCount: 1 }) };
  const methods = [];
  const cdp = { on: () => () => {}, send: async method => {
    methods.push(method);
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: structuredClone(snapshot) } };
  } };
  try {
    const result = await captureFirstDocumentStartup({ cdp, fixture, origin, startedAt: performance.now() });
    assert.equal(result.outcome, 'passed');
    assert.equal(result.startupMode, 'natural');
    assert.equal(result.foregroundActivation, undefined);
    assert.equal(result.forcedNavigations, 0);
    assert.equal(result.firstSelectedModel.modelId, 'fixture-model');
    assert.equal(methods.length, 2);
    snapshot.navigation.type = 'reload';
    const nativeReload = await captureFirstDocumentStartup({ cdp, fixture, origin, startedAt: performance.now() });
    assert.equal(nativeReload.outcome, 'passed');
    assert.equal(nativeReload.firstObservedDocument.navigation.type, 'reload');
    snapshot.navigation.type = 'navigate';
    let read = 0;
    const changed = { on: () => () => {}, send: async () => ({ result: { value: { ...snapshot, timeOrigin: ++read } } }) };
    const replaced = await captureFirstDocumentStartup({ cdp: changed, fixture, origin, startedAt: performance.now() });
    assert.equal(replaced.outcome, 'passed');
    assert.equal(replaced.nativeDocumentChanges, 1);
    const startedAt = performance.now();
    const navigationAudit = observeStartupNavigation(cdp, startedAt, origin);
    await assert.rejects(cdp.send('Page.reload'), /cannot count toward native startup/);
    const forced = await captureFirstDocumentStartup({ cdp, fixture, origin, startedAt, navigationAudit });
    assert.equal(forced.outcome, 'failed');
    assert.equal(forced.forcedNavigations, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

const startupTestHost = async t => {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/provider'
      ? { connected: ['fixture'], all: [{ id: 'fixture', models: { 'fixture-model': {} } }] }
      : { isOpenCodeReady: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
};

const readyStartupSnapshot = visibilityState => ({ timeOrigin: 42, composer: true, newChat: true, model: true, visibilityState,
  selectedModel: { providerId: 'fixture', modelId: 'fixture-model', catalogAvailable: true } });

test('foreground setup waits for prerequisites, requests once even if visible, and admits only a later fully ready snapshot', async t => {
  const origin = await startupTestHost(t);
  for (const visibilityState of ['hidden', 'visible']) {
    const methods = [];
    let reads = 0;
    let activationRead = null;
    let thirdReadStateChecks = 0;
    const fixture = { getState: () => ({ sseClientCount: reads === 7 || (reads === 3 && thirdReadStateChecks++ === 0) ? 0 : 1 }) };
    const cdp = { on: () => () => {}, send: async method => {
      methods.push(method);
      if (method === 'Page.bringToFront') {
        activationRead = reads;
        return {};
      }
      assert.equal(method, 'Runtime.evaluate');
      reads += 1;
      const snapshot = readyStartupSnapshot(activationRead === null ? visibilityState : 'visible');
      if (reads === 2 || reads === 5) snapshot.selectedModel.catalogAvailable = false;
      if (reads === 6) snapshot.composer = false;
      return { result: { value: snapshot } };
    } };
    const result = await captureFirstDocumentStartup({ cdp, fixture, origin, startedAt: performance.now(), startupMode: 'foreground' });
    assert.equal(result.outcome, 'passed');
    assert.equal(result.startupMode, 'foreground');
    assert.match(result.scope, /foreground-controlled admission, not natural startup latency/);
    assert.equal(activationRead, 4);
    assert.equal(reads, 8);
    assert.deepEqual(methods, ['Runtime.evaluate', 'Runtime.evaluate', 'Runtime.evaluate', 'Runtime.evaluate',
      'Page.bringToFront', 'Runtime.evaluate', 'Runtime.evaluate', 'Runtime.evaluate', 'Runtime.evaluate']);
    assert.equal(result.foregroundActivation.outcome, 'acknowledged');
    assert.equal(result.foregroundActivation.documentTimeOrigin, 42);
    assert.deepEqual(result.foregroundActivation.acknowledgement, {});
    assert.ok(result.foregroundActivation.acknowledgedAtMs >= result.foregroundActivation.requestedAtMs);
    assert.ok(result.uiReadyMs > result.foregroundActivation.acknowledgedAtMs);
    assert.equal(result.document.visibilityState, 'visible');
    assert.equal(result.forcedNavigations, 0);
  }
});

test('foreground setup does not retry or extend its original deadline after hidden, late-visible, or late-acknowledged results', async t => {
  const origin = await startupTestHost(t);
  for (const outcome of ['hidden', 'late-visible', 'late-acknowledgement']) {
    await t.test(outcome, async child => {
      let now = 0;
      child.mock.method(performance, 'now', () => now);
      let reads = 0;
      const methods = [];
      const cdp = { on: () => () => {}, send: async method => {
        methods.push(method);
        if (method === 'Page.bringToFront') {
          now = outcome === 'late-acknowledgement' ? 45001 : 44000;
          return {};
        }
        assert.equal(method, 'Runtime.evaluate');
        reads += 1;
        if (reads > 2) now = outcome === 'late-visible' || reads >= 5 ? 45001 : 44000 + reads;
        return { result: { value: readyStartupSnapshot(outcome === 'late-visible' && reads > 2 ? 'visible' : 'hidden') } };
      } };
      const result = await captureFirstDocumentStartup({ cdp, fixture: { getState: () => ({ sseClientCount: 1 }) },
        origin, startedAt: 0, startupMode: 'foreground' });
      assert.equal(result.outcome, 'failed');
      assert.match(result.error, /Timed out: first usable UI after native startup documents/);
      assert.equal(result.document, undefined);
      assert.equal(result.uiReadyMs, undefined);
      assert.equal(result.foregroundActivation.outcome, 'acknowledged');
      assert.equal(methods.filter(method => method === 'Page.bringToFront').length, 1);
      assert.equal(reads, outcome === 'hidden' ? 5 : outcome === 'late-visible' ? 3 : 2);
      assert.equal(result.forcedNavigations, 0);
    });
  }
});

test('foreground setup retains a rejected request and fails without retry or admission', async t => {
  const origin = await startupTestHost(t);
  const methods = [];
  const cdp = { on: () => () => {}, send: async method => {
    methods.push(method);
    if (method === 'Page.bringToFront') throw new Error('activation refused');
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: readyStartupSnapshot('visible') } };
  } };
  const result = await captureFirstDocumentStartup({ cdp, fixture: { getState: () => ({ sseClientCount: 1 }) },
    origin, startedAt: performance.now(), startupMode: 'foreground' });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error, 'activation refused');
  assert.equal(result.foregroundActivation.outcome, 'failed');
  assert.equal(result.foregroundActivation.error, 'activation refused');
  assert.equal(result.foregroundActivation.acknowledgedAtMs, undefined);
  assert.equal(result.document, undefined);
  assert.deepEqual(methods, ['Runtime.evaluate', 'Runtime.evaluate', 'Page.bringToFront']);
  await assert.rejects(captureFirstDocumentStartup({ startupMode: 'unsupported' }), /startupMode must be natural or foreground/);
});

test('startup requires the actual selected model to resolve in both UI and connected fixture catalogs', () => {
  const catalog = { connected: ['fixture'], all: [{ id: 'fixture', models: { 'fixture-model': {} } }] };
  const snapshot = { modelLabels: ['Fixture model'], selectedModel: { providerId: 'fixture', modelId: 'fixture-model', catalogAvailable: true } };
  assert.equal(selectedFixtureModelIsAvailable(snapshot, catalog), true);
  assert.equal(selectedFixtureModelIsAvailable({ ...snapshot, selectedModel: { providerId: 'openai', modelId: 'gpt-5.5', catalogAvailable: false } }, catalog), false);
  assert.equal(selectedFixtureModelIsAvailable({ ...snapshot, selectedModel: { ...snapshot.selectedModel, catalogAvailable: false } }, catalog), false);
  assert.equal(selectedFixtureModelIsAvailable(snapshot, { ...catalog, connected: [] }), false);
  assert.equal(selectedFixtureModelIsAvailable(snapshot, { ...catalog, all: [] }), false);
});

test('startup evidence separates host availability, native readiness and usable UI without admitting a failure splash', async t => {
  for (const terminal of [false, true]) await t.test(terminal ? 'terminal failure' : 'delayed ready', async child => {
    let healthCalls = 0;
    let catalogCalls = 0;
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/provider') {
        catalogCalls++;
        response.end(JSON.stringify({ connected: ['fixture'], all: [{ id: 'fixture', models: { 'fixture-model': {} } }] }));
      } else {
        healthCalls++;
        response.end(JSON.stringify({ isOpenCodeReady: !terminal && healthCalls > 1,
          openCodeStartup: { state: terminal ? 'failed' : healthCalls > 1 ? 'ready' : 'starting', attempt: 4,
            code: terminal ? 'NATIVE_BOOT_FAILED' : null }, lastOpenCodeError: 'sensitive host details' }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    child.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const cdp = { on: () => () => {}, send: async () => ({ result: { value: readyStartupSnapshot('visible') } }) };
    const result = await captureFirstDocumentStartup({ cdp, origin: `http://127.0.0.1:${server.address().port}`,
      fixture: { getState: () => ({ sseClientCount: 1 }) }, startedAt: performance.now(),
      readStartupPhases: () => [{ phase: 'initial_url', outcome: 'completed', elapsedMs: 17, directory: '/private' }] });
    assert.equal(result.nativeStartupObservation, 'observed');
    assert.deepEqual(result.electronStartupPhases.records, [{ phase: 'initial_url', outcome: 'completed', durationMs: 17 }]);
    assert.equal(JSON.stringify(result).includes('sensitive host details'), false);
    assert.equal(JSON.stringify(result).includes('/private'), false);
    if (terminal) {
      assert.equal(result.outcome, 'failed');
      assert.equal(result.startupFailure.code, 'NATIVE_BOOT_FAILED');
      assert.equal(result.startupFailure.attempt, 4);
      assert.equal(healthCalls, 1);
      assert.equal(catalogCalls, 0);
      assert.equal(result.uiReadyMs, undefined);
    } else {
      assert.equal(result.outcome, 'passed');
      assert.deepEqual(result.healthObservations.map(record => record.state), ['starting', 'ready']);
      assert.ok(result.nativeStartupReadyMs >= result.hostAvailableMs);
      assert.ok(result.hostReadyMs >= result.nativeStartupReadyMs);
      assert.ok(result.fixtureCatalogReadyMs >= result.hostReadyMs);
      assert.ok(result.uiReadyMs >= result.fixtureCatalogReadyMs);
    }
  });
});

test('startup phase projection keeps durations and fixed codes without paths or arbitrary log payloads', () => {
  const logs = `[electron] startup phase { phase: 'initial_url', outcome: 'completed', elapsedMs: 12, secret: 'private' }\n`
    + `[electron] startup phase {\n phase: 'service_connection', outcome: 'failed', elapsedMs: 15, code: 'runtime_service_not_registered' }\n`
    + `[runtime-bundle] startup phase { phase: 'bundle_upgrade', outcome: 'completed', elapsedMs: 42 }`;
  assert.deepEqual(sanitizeStartupPhases(parseStartupPhaseLogs(logs)), [
    { phase: 'initial_url', outcome: 'completed', durationMs: 12 },
    { phase: 'service_connection', outcome: 'failed', durationMs: 15, code: 'runtime_service_not_registered' },
    { phase: 'bundle_upgrade', outcome: 'completed', durationMs: 42 },
  ]);
  assert.deepEqual(sanitizeStartupPhases([{ phase: '/private/path', outcome: 'completed', elapsedMs: 3 },
    { phase: 'service', outcome: 'failed', elapsedMs: 2, code: 'secret token' },
    { phase: 'service', outcome: 'completed', elapsedMs: -1 }]), [
    { phase: 'service', outcome: 'failed', durationMs: 2, code: null },
  ]);
});

test('native startup requires its exact model/agent tuple and an authoritative event-stream acknowledgement', async t => {
  const tuple = { providerId: 'devryan-smoke', modelId: 'smoke-write', agent: 'builder' };
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/provider'
      ? { connected: [tuple.providerId], all: [{ id: tuple.providerId, models: { [tuple.modelId]: {} } }] }
      : { isOpenCodeReady: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let reads = 0;
  const cdp = { on: () => () => {}, send: async () => {
    reads++;
    return { result: { value: { ...readyStartupSnapshot('visible'),
      selectedModel: { ...tuple, agent: reads < 3 ? 'wrong-agent' : tuple.agent, catalogAvailable: true } } } };
  } };
  const result = await captureFirstDocumentStartup({ cdp, origin: `http://127.0.0.1:${server.address().port}`,
    startedAt: performance.now(), runtimeUiTuple: tuple, isEventStreamReady: () => reads >= 4 });
  assert.equal(result.outcome, 'passed');
  assert.equal(reads, 4);
  assert.match(result.scope, /actual native backend; local HTTP model fixture/);
  assert.equal(result.nativeStartupObservation, 'unavailable');
  await assert.rejects(captureFirstDocumentStartup({ cdp, startedAt: 0, runtimeUiTuple: tuple }), /authoritative event-stream readiness/);
});


test('foreground admission uses the owned shell focus command once and still requires a later visible snapshot', async t => {
  const origin = await startupTestHost(t);
  let focused = false, requests = 0, reads = 0;
  const methods = [];
  const cdp = { on: () => () => {}, send: async method => {
    methods.push(method);
    assert.equal(method, 'Runtime.evaluate');
    reads++;
    return { result: { value: readyStartupSnapshot(focused ? 'visible' : 'hidden') } };
  } };
  const result = await captureFirstDocumentStartup({ cdp, fixture: { getState: () => ({ sseClientCount: 1 }) },
    origin, startedAt: performance.now(), startupMode: 'foreground',
    foregroundWindow: { method: 'desktop_focus_main_window', activate: async () => { requests++; focused = true; return { focused: true }; } } });
  assert.equal(result.outcome, 'passed');
  assert.equal(requests, 1);
  assert.ok(reads >= 3);
  assert.equal(result.foregroundActivation.method, 'desktop_focus_main_window');
  assert.deepEqual(result.foregroundActivation.acknowledgement, { focused: true });
  assert.equal(result.document.visibilityState, 'visible');
  assert.ok(result.uiReadyMs > result.foregroundActivation.acknowledgedAtMs);
  assert.equal(result.forcedNavigations, 0);
});
