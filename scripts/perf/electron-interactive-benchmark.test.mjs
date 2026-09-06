import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  aggregateInteractiveRuns,
  assertInteractiveDisclosureTurn,
  assertNumberedChunks,
  assertUniqueTurnCounts,
  compareInteractiveSummaries,
  createInteractiveProbe,
  distribution,
  findInteractiveHistoryTranscript,
  getInteractivePrimaryMetrics,
  getInteractiveProtocol,
  INTERACTIVE_PROTOCOL,
  INTERACTIVE_TYPING_PROTOCOL,
  INTERACTIVE_DISCLOSURE_TEXT,
  prepareInteractiveControl,
  runInteractiveScenario,
  saveInteractiveTrace,
  summarizeInteractiveActions,
} from './electron-interactive-benchmark.mjs';
import { createQaUiDriver } from '../qa/ui-driver.mjs';

test('typing control uses one ordinary same-origin navigation and requires the selected session plus ready composer', async t => {
  for (const failure of [undefined, 'wrong session', 'wrong origin', 'disabled composer', 'absent composer', 'stale document']) {
    await t.test(failure ?? 'ready control', async () => {
      const session = { id: 'ses_control', title: 'Interactive controls' };
      const origin = 'http://127.0.0.1:3101';
      const calls = [];
      const location = { href: `${origin}/`, get origin() { return new URL(this.href).origin; } };
      const composer = { isConnected: true, disabled: failure === 'disabled composer', parentElement: null,
        getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }) };
      const document = { readyState: failure === 'stale document' ? 'loading' : 'complete',
        querySelector: selector => selector === 'textarea' && failure !== 'absent composer' ? composer : null };
      const context = vm.createContext({ document, location, URL, innerWidth: 800, innerHeight: 600,
        getComputedStyle: () => ({ opacity: '1', display: 'block', visibility: 'visible' }) });
      const cdp = { send: async (method, params) => {
        calls.push({ method, params });
        if (method === 'Page.navigate') {
          assert.deepEqual(params, { url: `${origin}/?session=ses_control` });
          location.href = failure === 'wrong session' ? `${origin}/?session=ses_other`
            : failure === 'wrong origin' ? 'http://wrong.invalid/?session=ses_control' : params.url;
          return { frameId: 'top', loaderId: 'new-document' };
        }
        assert.equal(method, 'Runtime.evaluate');
        return { result: { value: vm.runInContext(params.expression, context) } };
      } };
      const ui = createQaUiDriver(cdp, { timeoutMs: -1 });
      ui.click = async () => { throw new Error('Typing scope must not use sidebar admission'); };
      const run = prepareInteractiveControl({ cdp, ui, session, origin, interactiveScope: 'typing' });
      if (failure) await assert.rejects(run);
      else {
        const result = await run;
        assert.equal(result.sessionID, session.id);
        assert.equal(result.href, `${origin}/?session=ses_control`);
      }
      assert.equal(calls.filter(call => call.method === 'Page.navigate').length, 1);
    });
  }
});

test('full interactive control keeps its original sidebar and readiness sequence', async () => {
  const calls = [];
  await prepareInteractiveControl({ interactiveScope: 'full', session: { id: 'ses_control', title: 'Interactive controls' },
    cdp: { send: () => assert.fail('Full control setup must not navigate') }, ui: {
      click: async options => calls.push(options), waitExpression: async label => calls.push(label),
    } });
  assert.deepEqual(calls, [{ selector: '[data-session-row="ses_control"] button', text: 'Interactive controls' },
    'interactive canonical session selected', 'interactive composer mounted']);
});

test('disclosure setup preserves the full canonical payload through the production normalizer', () => {
  assert.equal(Buffer.byteLength(INTERACTIVE_DISCLOSURE_TEXT), INTERACTIVE_PROTOCOL.disclosureTextBytes);
  const normalized = execFileSync('bun', ['-e', `
    import { normalizeAssistantPartText } from './packages/ui/src/sync/part-delta.ts';
    const text = await Bun.stdin.text();
    process.stdout.write(normalizeAssistantPartText(text, 'reasoning'));
  `], { cwd: fileURLToPath(new URL('../../', import.meta.url)), input: INTERACTIVE_DISCLOSURE_TEXT,
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(normalized, INTERACTIVE_DISCLOSURE_TEXT);
});

test('disclosure timing requires the exact completed turn and actual long reasoning duration', () => {
  const valid = () => [{ info: { id: 'msg_assistant', role: 'assistant', parentID: 'msg_user', time: { completed: 18000 } },
    parts: [{ id: 'prt_reasoning', type: 'reasoning', text: INTERACTIVE_DISCLOSURE_TEXT, time: { start: 1000, end: 17200 } }] }];
  assert.equal(assertInteractiveDisclosureTurn(valid(), 'msg_user').evidence.durationMs, 16200);
  const mutations = [
    rows => { rows[0].info.parentID = 'msg_other'; },
    rows => { delete rows[0].info.time.completed; },
    rows => { rows[0].info.error = { name: 'Aborted' }; },
    rows => { rows[0].parts[0].text = 'Shortened reasoning'; },
    rows => { delete rows[0].parts[0].time.end; },
    rows => { rows[0].parts[0].time.end = 3000; },
    rows => { rows[0].info.time.completed = 16000; },
    rows => { rows[0].parts.push({ ...rows[0].parts[0] }); },
    rows => { rows.push({ ...rows[0] }); },
  ];
  for (const mutate of mutations) {
    const rows = valid(); mutate(rows);
    assert.throws(() => assertInteractiveDisclosureTurn(rows, 'msg_user'));
  }
  const unrelated = { ...valid()[0], info: { ...valid()[0].info, id: 'msg_other_assistant', parentID: 'msg_other_user' } };
  assert.equal(assertInteractiveDisclosureTurn([...valid(), unrelated], 'msg_user').assistant.info.id, 'msg_assistant');
});

const completeActions = () => Object.entries({ typing: INTERACTIVE_PROTOCOL.typingText.length, historyOpen: 2,
  pagination: 6, sessionSwitch: INTERACTIVE_PROTOCOL.switchCycles * 4, scroll: INTERACTIVE_PROTOCOL.scrollEvents,
  disclosure: INTERACTIVE_PROTOCOL.disclosureCycles * 2, cancel: 1, reconnect: 1,
  navigation: INTERACTIVE_PROTOCOL.navigationCycles * 5 }).flatMap(([group, count]) =>
  Array.from({ length: count }, (_, index) => ({ group, action: String(index), outcome: 'passed', latencyMs: 20 + index })));

test('history switching requires visible canonical content for the selected session without choosing a scroll position', () => {
  const session = { id: 'ses_history', assistants: [{ messageID: 'msg_first', text: 'First canonical reply.' },
    { messageID: 'msg_middle', text: 'Middle canonical reply.' }, { messageID: 'msg_last', text: 'Last canonical reply.' }] };
  for (const expected of session.assistants) {
    const rendered = [{ ...expected, visible: true, text: `Builder\n${expected.text}\n10:00` }];
    assert.equal(findInteractiveHistoryTranscript(session, session.id, rendered)?.messageID, expected.messageID);
    assert.equal(findInteractiveHistoryTranscript(session, 'ses_other', rendered), null);
    assert.equal(findInteractiveHistoryTranscript(session, session.id, [{ ...rendered[0], visible: false }]), null);
    assert.equal(findInteractiveHistoryTranscript(session, session.id, [{ ...rendered[0], text: 'Loading...' }]), null);
    assert.equal(findInteractiveHistoryTranscript(session, session.id, [{ ...rendered[0], messageID: 'msg_foreign' }]), null);
  }
  assert.equal(findInteractiveHistoryTranscript(session, session.id, []), null);
});

test('interactive distributions retain sample counts and reject missing, invalid or negative timing', () => {
  assert.deepEqual(distribution([1, 2, 3, 4, 100]), { count: 5, p50: 3, p95: 100, minimum: 1, maximum: 100 });
  for (const values of [[], [NaN], [-1]]) assert.throws(() => distribution(values), /finite nonnegative/);
  const actions = completeActions();
  assert.equal(summarizeInteractiveActions(actions).typing.count, INTERACTIVE_PROTOCOL.typingText.length);
  assert.throws(() => summarizeInteractiveActions(actions.slice(1)), /Incomplete interactive action group: typing/);
  actions[0].outcome = 'failed';
  assert.throws(() => summarizeInteractiveActions(actions), /interactive action failed: typing/);
});

const typingActions = (shift = 0) => Array.from({ length: 60 }, (_, index) => ({ id: index + 1,
  group: 'typing', action: `character ${index + 1}`, outcome: 'passed', trustedEvent: true, latencyMs: 20 + index + shift }));

test('typing scope requires all 60 distinct trusted inputs while the default retains every full action group', () => {
  assert.equal(getInteractiveProtocol(), INTERACTIVE_PROTOCOL);
  assert.equal(getInteractiveProtocol('typing'), INTERACTIVE_TYPING_PROTOCOL);
  assert.equal(Object.hasOwn(INTERACTIVE_TYPING_PROTOCOL, 'streamIntervalMs'), false);
  assert.deepEqual(Object.keys(getInteractivePrimaryMetrics('typing')), ['typing']);
  assert.deepEqual(Object.keys(summarizeInteractiveActions(typingActions(), 'typing')), ['typing']);
  assert.throws(() => summarizeInteractiveActions(typingActions()), /historyOpen/);
  for (const mutate of [actions => actions.pop(), actions => actions.push({ ...actions[0], id: 61 }),
    actions => { actions[0].trustedEvent = false; }, actions => { actions[0].outcome = 'failed'; },
    actions => { actions[0].id = actions[1].id; }, actions => { actions[0].group = 'historyOpen'; },
    actions => { actions[0].latencyMs = NaN; }]) {
    const actions = typingActions(); mutate(actions);
    assert.throws(() => summarizeInteractiveActions(actions, 'typing'));
  }
  const full = completeActions();
  full.push(...Array.from({ length: 2 }, (_, index) => ({ group: 'pagination', action: `extra page ${index}`, outcome: 'passed', latencyMs: 20 })));
  assert.equal(full.length, 148);
  for (const group of Object.keys(summarizeInteractiveActions(full))) {
    assert.throws(() => summarizeInteractiveActions(full.filter(action => action.group !== group)));
  }
  for (const scope of [null, true, '', 'partial', [], {}]) assert.throws(() => getInteractiveProtocol(scope), /interactiveScope/);
});

test('canonical reconnect evidence rejects missing and duplicated numbered chunks', () => {
  assert.equal(assertNumberedChunks('QA response chunk 1. QA response chunk 2. '), 2);
  for (const text of ['', 'QA response chunk 2.', 'QA response chunk 1. QA response chunk 3.',
    'QA response chunk 1. QA response chunk 2. QA response chunk 2.']) assert.throws(() => assertNumberedChunks(text));
});

test('cancelled turn uniqueness rejects duplicate rendered assistants and missing canonical rows', () => {
  const counts = { canonicalUser: 1, canonicalAssistant: 1, renderedUser: 1, renderedAssistant: 1 };
  assert.equal(assertUniqueTurnCounts(counts), true);
  for (const key of Object.keys(counts)) {
    for (const count of [0, 2]) assert.throws(() => assertUniqueTurnCounts({ ...counts, [key]: count }), new RegExp(key));
  }
});

const browserProbe = (timeoutMs = 1000) => {
  let now = 0;
  let nextFrameID = 0;
  const callbacks = new Map();
  const listeners = new Map();
  const context = vm.createContext({
    performance: { now: () => now },
    PerformanceObserver: class { static supportedEntryTypes = ['event', 'longtask']; observe() {} disconnect() {} },
    document: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
    requestAnimationFrame: callback => { callbacks.set(++nextFrameID, callback); return nextFrameID; },
    cancelAnimationFrame: id => callbacks.delete(id), setTimeout, clearTimeout, fixtureReady: false,
  });
  const probe = vm.runInContext(`(${createInteractiveProbe.toString()})(${JSON.stringify({ ...INTERACTIVE_PROTOCOL, actionTimeoutMs: timeoutMs })})`, context);
  return { context, probe, listeners, callbacks,
    input: trusted => listeners.get('input')({ isTrusted: trusted, type: 'input', timeStamp: now,
      target: { closest: selector => selector === 'textarea' } }),
    frames: async count => { for (let index = 0; index < count; index++) {
      now += 16; const current = [...callbacks.values()]; callbacks.clear(); current.forEach(callback => callback(now));
      await Promise.resolve(); await Promise.resolve();
    } },
  };
};

test('renderer timing ignores synthetic events and waits for the rendered condition plus two frames', async () => {
  const browser = browserProbe();
  const id = browser.probe.arm({ group: 'typing', action: 'character', event: 'input', selector: 'textarea', condition: 'fixtureReady' });
  browser.input(false);
  browser.context.fixtureReady = true;
  await browser.frames(3);
  assert.equal(browser.probe.snapshot().actions.length, 0);
  browser.context.fixtureReady = false;
  browser.input(true);
  await browser.frames(3);
  assert.equal(browser.probe.snapshot().actions.length, 0);
  browser.context.fixtureReady = true;
  await browser.frames(1);
  assert.equal(browser.probe.snapshot().actions.length, 0);
  await browser.frames(3);
  const result = await browser.probe.wait(id);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.trustedEvent, true);
  assert.ok(result.latencyMs >= 80);
  browser.probe.close();
  assert.equal(browser.listeners.size, 0);
  assert.equal(browser.callbacks.size, 0);
});

test('a missing trusted event fails with bounded evidence and can be followed by another measurement', async () => {
  const browser = browserProbe(10);
  const first = browser.probe.arm({ group: 'typing', action: 'missing', event: 'input', selector: 'textarea', condition: 'fixtureReady' });
  const failure = await browser.probe.wait(first);
  assert.equal(failure.outcome, 'failed');
  assert.match(failure.error, /timed out/);
  const second = browser.probe.arm({ group: 'typing', action: 'present', event: 'input', selector: 'textarea', condition: 'fixtureReady' });
  browser.context.fixtureReady = true;
  browser.input(true);
  await browser.frames(5);
  assert.equal((await browser.probe.wait(second)).outcome, 'passed');
  browser.probe.close();
});

test('fixed-cadence inputs may overlap pending frames while retaining every observed event', async () => {
  const browser = browserProbe();
  const target = { value: '', isConnected: true, closest: selector => selector === 'textarea' };
  browser.probe.beginTyping('AB');
  for (const value of ['A', 'AB']) {
    target.value = value;
    browser.listeners.get('input')({ isTrusted: true, type: 'input', timeStamp: 0, target });
  }
  assert.equal(browser.probe.snapshot().actions.length, 0);
  await browser.frames(5);
  const results = await browser.probe.finishTyping();
  assert.equal(results.length, 2);
  assert.ok(results.every(result => result.outcome === 'passed' && result.trustedEvent));
  assert.equal(browser.probe.snapshot().pending, false);
  browser.probe.close();
});

test('trace streaming preserves mixed-encoding chunks and closes the handle even when its byte bound fails', async () => {
  const cache = fileURLToPath(new URL('../../.cache/perf/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, 'interactive-trace-test-'));
  const makeCdp = () => {
    const calls = [];
    const responses = [{ data: '{"traceEvents":[' },
      { data: Buffer.from('{"name":"click"}]}').toString('base64'), base64Encoded: true, eof: true }];
    return { calls, send: async (method, params) => { calls.push({ method, params }); return method === 'IO.read' ? responses.shift() : {}; } };
  };
  try {
    const cdp = makeCdp();
    const filename = path.join(directory, 'trace.json.gz');
    const saved = await saveInteractiveTrace({ cdp, handle: 'trace', filename });
    const json = gunzipSync(await readFile(filename)).toString('utf8');
    assert.deepEqual(JSON.parse(json), { traceEvents: [{ name: 'click' }] });
    assert.equal(saved.uncompressedBytes, Buffer.byteLength(json));
    assert.equal(saved.chunks, 2);
    assert.equal(cdp.calls.at(-1).method, 'IO.close');
    const bounded = makeCdp();
    await assert.rejects(saveInteractiveTrace({ cdp: bounded, handle: 'trace', filename: path.join(directory, 'too-large.gz'), maximumBytes: 10 }), /bounded byte limit/);
    assert.equal(bounded.calls.at(-1).method, 'IO.close');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Exercise scenario control flow and real trace writing without launching a
// host. The probe itself has independent trusted-event/two-frame tests above.
const typingScenarioHarness = (failure) => {
  const calls = [];
  const records = [];
  const screenshots = [];
  let draft = '';
  let typing = false;
  let probeClosed = false;
  let listenerRemoved = false;
  let activeScenario = 'idle';
  let textLength = 0;
  let selectionChecks = 0;
  const actions = typingActions();
  const cdp = {
    on: (event, callback) => {
      assert.equal(event, 'Tracing.bufferUsage');
      if (failure === 'trace overflow') callback({ percentFull: 0.99 });
      return () => { listenerRemoved = true; };
    },
    waitFor: async event => {
      assert.equal(event, 'Tracing.tracingComplete');
      return { dataLossOccurred: failure === 'trace loss', stream: 'trace' };
    },
    send: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expression = params.expression;
        let value;
        if (expression === 'location.origin') value = 'http://unused.invalid';
        else if (expression.includes('const composer=document.querySelector')) {
          selectionChecks += 1;
          value = (failure === 'selection before inputs' && selectionChecks === 2)
            || (failure === 'selection after inputs' && selectionChecks === 3) ? false : {
              sessionID: 'ses_control', href: 'http://unused.invalid/?session=ses_control', composerReady: true,
            };
        }
        else if (expression.startsWith('window.__devryanInteractiveProbe=')) value = undefined;
        else if (expression.startsWith('window.__devryanInteractiveProbe.phase(')) value = undefined;
        else if (expression.startsWith('window.__devryanInteractiveProbe.beginTyping(')) { typing = true; value = undefined; }
        else if (expression === 'window.__devryanInteractiveProbe.finishTyping()') value = actions;
        else if (expression === 'window.__devryanInteractiveProbe.snapshot()') value = {
          actions, support: { event: true, longtask: failure !== 'long tasks unavailable' }, frames: [{ duration: 16 }],
          longTasks: [], eventTiming: [], pending: failure === 'pending probe', overflow: failure === 'probe overflow',
        };
        else if (expression.includes('delete window.__devryanInteractiveProbe')) {
          probeClosed = true;
          if (failure === 'probe cleanup') throw new Error('probe cleanup failed');
          value = true;
        } else if (expression.includes('const matches=')) value = { x: 10, y: 10 };
        else if (expression.startsWith("new URL(location.href).searchParams.get('session')")) value = true;
        else if (expression === "Boolean(document.querySelector('textarea'))") value = true;
        else if (expression.includes('e.focus();return document.activeElement===e')) value = true;
        else if (expression.startsWith('document.activeElement?.value===')) value = draft === '';
        else if (expression.startsWith("document.querySelector('textarea')?.value === ")) value = draft === INTERACTIVE_PROTOCOL.typingText;
        else assert.fail(`Unexpected renderer evaluation in typing scope: ${expression.slice(0, 120)}`);
        return { result: { value } };
      }
      if (method === 'Input.insertText') { if (typing) draft += params.text; else draft = params.text; return {}; }
      if (method === 'IO.read') return { data: '{"traceEvents":[{"name":"typing"}]}', eof: true };
      assert.ok(['Page.navigate', 'Tracing.start', 'Tracing.end', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'IO.close'].includes(method),
        `Unexpected CDP action in typing scope: ${method}`);
      return {};
    },
  };
  const fixture = {
    startScenario: name => { assert.equal(name, 'one-stream'); activeScenario = name; textLength = 101; },
    stopScenario: () => { activeScenario = 'idle'; },
    getState: () => {
      if (activeScenario === 'one-stream') textLength += 10;
      return { activeScenario, textLengths: { ses_perfparent: textLength }, receivedPrompts: [], activePrompts: 0 };
    },
  };
  return { cdp, fixture, calls, records, screenshots,
    sessions: { control: { id: 'ses_control', title: 'Interactive controls' }, histories: [] },
    record: async evidence => records.push(structuredClone(evidence)),
    screenshot: async name => screenshots.push(name),
    readHostMemory: () => assert.fail('Typing scope must not sample navigation memory'),
    getCleanup: () => ({ probeClosed, listenerRemoved, activeScenario }),
  };
};

test('typing scope completes trace/probe cleanup and propagates every finalization failure', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => { clock += 100; return clock; });
  const cache = fileURLToPath(new URL('../../.cache/perf/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, 'interactive-typing-test-'));
  try {
    for (const failure of [undefined, 'trace loss', 'trace overflow', 'pending probe', 'probe overflow', 'probe cleanup',
      'long tasks unavailable', 'selection before inputs', 'selection after inputs']) {
      const harness = typingScenarioHarness(failure);
      const traceFilename = path.join(directory, `${failure ?? 'success'}.json.gz`);
      const run = runInteractiveScenario({ ...harness, interactiveScope: 'typing', warmupMs: 0, traceFilename,
        origin: 'http://unused.invalid', measureMs: 30000 });
      if (failure) await assert.rejects(run, undefined, `A ${failure} failure must survive scenario finalization`);
      else {
        const evidence = await run;
        assert.equal(evidence.outcome, 'passed');
        assert.equal(evidence.actions.length, 60);
        assert.equal(evidence.actionsSummary.typing.count, 60);
        assert.equal(evidence.correctness.typingDraft, true);
        assert.equal(evidence.correctness.typingNoSubmit, true);
        assert.equal(evidence.controlNavigation.href, 'http://unused.invalid/?session=ses_control');
        assert.equal(evidence.correctness.typingSelectionBefore.sessionID, 'ses_control');
        assert.equal(evidence.correctness.typingSelectionAfter.sessionID, 'ses_control');
        assert.ok(evidence.correctness.typingBackground.afterTextLength > evidence.correctness.typingBackground.beforeTextLength);
        assert.deepEqual(Object.keys(evidence.primaryMetrics), ['typing']);
        for (const key of ['histories', 'navigationGrowth', 'navigationBefore', 'navigationAfter', 'measureMs']) {
          assert.equal(Object.hasOwn(evidence, key), false, `Unmeasured ${key} must be absent`);
        }
        assert.deepEqual(JSON.parse(gunzipSync(await readFile(traceFilename))), { traceEvents: [{ name: 'typing' }] });
      }
      assert.deepEqual(harness.getCleanup(), { probeClosed: true, listenerRemoved: true, activeScenario: 'idle' });
      assert.deepEqual(harness.screenshots, failure?.startsWith('selection ') ? [] : ['interactive-typing-background']);
      assert.equal(harness.records.at(-1).outcome, failure ? 'failed' : 'passed');
      assert.equal(harness.calls.filter(call => call.method === 'Input.insertText' && call.params.text).length,
        failure === 'selection before inputs' ? 0 : 60);
      assert.equal(harness.calls.filter(call => call.method === 'Tracing.end').length, 1);
      assert.equal(harness.calls.filter(call => call.method === 'IO.close').length, 1);
      assert.equal(harness.calls.filter(call => call.method === 'Page.navigate').length, 1);
      assert.equal(harness.calls.filter(call => call.params.expression?.includes('const matches=')).length, 0);
      const navigation = harness.calls.findIndex(call => call.method === 'Page.navigate');
      assert.ok(navigation < harness.calls.findIndex(call => call.params.expression?.startsWith('window.__devryanInteractiveProbe=')));
      assert.ok(navigation < harness.calls.findIndex(call => call.method === 'Tracing.start'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const successfulRun = shift => ({ outcome: 'passed', actionsSummary: summarizeInteractiveActions(completeActions()
  .map(action => ({ ...action, latencyMs: action.latencyMs + shift }))), navigationGrowth: { heapBytes: 100 + shift, domNodes: 2, workingSetBytes: 1000 },
browser: { support: { event: true, longtask: true }, longTasks: [], eventTiming: [], frames: [{ duration: 16.67 }] } });

const summary = shifts => ({ fixtureSha256: 'fixture', interactiveProtocolSha256: 'protocol',
  interactiveProtocol: structuredClone(INTERACTIVE_PROTOCOL), runsPerScenario: 3, warmupMs: 5000, measureMs: 30000, sampleIntervalMs: 500,
  packageEvidence: { backendSha256: 'backend', shellSha256: 'shell', nativeSha256: 'native' },
  scenarios: { interactive: { interactive: aggregateInteractiveRuns(shifts.map(successfulRun)),
    chromium: { product: 'Chrome/147' }, display: { visibilityState: 'visible', innerWidth: 1280, innerHeight: 800 },
    runs: shifts.map(() => ({ startup: { outcome: 'passed' }, interactive: { outcome: 'passed' } })) } } });

const successfulTypingRun = shift => ({ outcome: 'passed', interactiveScope: 'typing', actions: typingActions(shift),
  actionsSummary: summarizeInteractiveActions(typingActions(shift), 'typing'),
  correctness: { typingDraft: true, typingNoSubmit: true,
    typingSelectionBefore: { sessionID: 'ses_control', href: 'http://renderer.invalid/?session=ses_control', composerReady: true },
    typingSelectionAfter: { sessionID: 'ses_control', href: 'http://renderer.invalid/?session=ses_control', composerReady: true },
    typingBackground: {
    sessionID: 'ses_perfparent', activeScenario: 'one-stream', beforeTextLength: 101, afterTextLength: 500,
  } }, browser: successfulRun(shift).browser });

const typingSummary = shifts => {
  const result = summary(shifts);
  delete result.measureMs;
  delete result.sampleIntervalMs;
  const runs = shifts.map(successfulTypingRun);
  return { ...result, startupMode: 'foreground', interactiveScope: 'typing',
    measurement: INTERACTIVE_TYPING_PROTOCOL.measurement, interactiveProtocol: structuredClone(INTERACTIVE_TYPING_PROTOCOL),
    interactivePrimaryMetrics: getInteractivePrimaryMetrics('typing'),
    scenarios: { interactive: { ...result.scenarios.interactive, interactive: aggregateInteractiveRuns(runs),
      runs: runs.map(run => ({ startup: { outcome: 'passed' }, interactive: { outcome: 'passed', interactiveScope: 'typing',
        actions: run.actionsSummary, correctness: run.correctness } })) } } };
};

test('typing aggregates and comparisons report exactly 180 inputs per package without navigation or duration claims', () => {
  const before = typingSummary([0, 1, 2]);
  const comparison = compareInteractiveSummaries(before, typingSummary([3, 4, 5]));
  assert.equal(comparison.interactiveScope, 'typing');
  assert.deepEqual(Object.keys(comparison.latencies), ['typing']);
  assert.equal(comparison.latencies.typing.sampleCount, 180);
  assert.equal(comparison.latencies.typing.p95.baseline.values.length, 3);
  assert.equal(Object.hasOwn(comparison, 'navigationGrowth'), false);
  assert.equal(Object.hasOwn(before.scenarios.interactive.interactive, 'navigationGrowth'), false);
  for (const mutate of [value => { value.interactiveScope = 'full'; }, value => { value.startupMode = 'natural'; },
    value => { value.measureMs = 30000; }, value => { value.sampleIntervalMs = 500; }, value => { delete value.measurement; },
    value => { value.interactivePrimaryMetrics.navigationHeap = 'unmeasured'; },
    value => { value.scenarios.interactive.interactive.navigationGrowth = {}; },
    value => { value.scenarios.interactive.interactive.latencies.typing.sampleCount--; },
    value => { value.scenarios.interactive.runs[0].interactive.actions.typing.count--; },
    value => { value.scenarios.interactive.runs[0].interactive.correctness.typingDraft = false; },
    value => { delete value.scenarios.interactive.runs[0].interactive.correctness.typingNoSubmit; },
    value => { delete value.scenarios.interactive.runs[0].interactive.correctness.typingSelectionBefore; },
    value => { value.scenarios.interactive.runs[0].interactive.correctness.typingSelectionAfter.sessionID = 'ses_other'; },
    value => { value.interactiveProtocol.version = 1; },
    value => { value.scenarios.interactive.runs[0].interactive.correctness.typingBackground.afterTextLength = 101; },
    value => { value.scenarios.interactive.runs[0].interactive.navigationGrowth = {}; }]) {
    const after = structuredClone(before); mutate(after);
    assert.throws(() => compareInteractiveSummaries(before, after));
  }
  for (const mutate of [run => { run.actions.pop(); }, run => { run.actions[0].trustedEvent = false; },
    run => { run.correctness.typingNoSubmit = false; }, run => { run.navigationGrowth = {}; },
    run => { run.actionsSummary.typing.p95 = 0; }]) {
    const run = successfulTypingRun(0); mutate(run);
    assert.throws(() => aggregateInteractiveRuns([run]));
  }
  assert.throws(() => aggregateInteractiveRuns([successfulRun(0), successfulTypingRun(0)]), /one scope/);
  for (const key of ['interactiveScope', 'startupMode']) {
    const invalid = structuredClone(before); invalid[key] = null;
    assert.throws(() => compareInteractiveSummaries(before, invalid));
  }
});

test('matched comparisons retain run variability and make no improvement claim when ranges overlap', () => {
  const before = summary([0, 10, 20]);
  const after = summary([0, 5, 10]);
  const comparison = compareInteractiveSummaries(before, after);
  assert.equal(comparison.latencies.typing.sampleCount, INTERACTIVE_PROTOCOL.typingText.length * 3);
  assert.equal(comparison.latencies.typing.p95.rangesOverlap, true);
  assert.equal(comparison.latencies.typing.p95.interpretation, 'ranges overlap; no clear change');
  assert.equal(comparison.latencies.typing.p95.absoluteChange, -5);
  assert.ok(comparison.latencies.typing.p95.percentageChange < 0);
  const lower = compareInteractiveSummaries(summary([30, 40, 50]), summary([0, 1, 2]));
  assert.equal(lower.latencies.typing.p95.rangesOverlap, false);
});

test('comparisons reject smoke counts, mismatched workload/package/display and failed correctness', () => {
  const before = summary([0, 1, 2]);
  const mismatches = [
    value => { value.fixtureSha256 = 'changed'; },
    value => { value.interactiveProtocol.typingIntervalMs = 1; },
    value => { value.packageEvidence.backendSha256 = 'changed'; },
    value => { value.scenarios.interactive.display.innerWidth = 900; },
    value => { value.scenarios.interactive.runs[0].interactive.outcome = 'failed'; },
    value => { value.scenarios.interactive.interactive.latencies.typing.sampleCount -= 1; },
  ];
  for (const mutate of mismatches) { const after = structuredClone(before); mutate(after); assert.throws(() => compareInteractiveSummaries(before, after)); }
  const smoke = structuredClone(before); smoke.runsPerScenario = 1;
  assert.throws(() => compareInteractiveSummaries(smoke, smoke), /at least three fresh/);
  assert.throws(() => aggregateInteractiveRuns([{ ...successfulRun(0), outcome: 'failed' }]), /pass correctness/);
});

test('three-run comparisons reject short smoke warmup and measurement windows on both packages', () => {
  for (const [key, value, reason] of [['warmupMs', 500, /5-second warmup/], ['measureMs', 1000, /30-second measurement/]]) {
    const smoke = summary([0, 1, 2]);
    smoke[key] = value;
    assert.throws(() => compareInteractiveSummaries(smoke, smoke), reason);
  }
});
