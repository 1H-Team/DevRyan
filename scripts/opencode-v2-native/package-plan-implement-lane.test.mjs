import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createPlanImplementResponder, settleApplicationPlanBrowser, cleanupApplicationPlanResources, awaitApplicationPlanExit,
  captureApplicationPlanIdentity, captureApplicationPlanJournal, finishApplicationPlanSourceVerification, PLAN_REQUEST, REPAIR_REQUEST, PLAN_CONTENT } from './package-plan-implement-lane.mjs';
import {openOwnedPlan, restoreApplicationPlanFiles, createApplicationPlanChangesEvidence, applicationPlanHelperLabel,
  waitApplicationPlanHelperTrigger, waitApplicationPlanCapture, selectApplicationPlanCurrentHelper,
  waitApplicationPlanHelperMenuClosed, applicationPlanControlReady, openApplicationPlanSessionDefaults, reloadApplicationPlanDocument} from './package-plan-implement-lane.mjs';
import { createRuntimeUiProvider, runtimeUiConfiguration, runtimeUiNativeConfiguration } from '../qa/native-backend-ui-diagnostic.mjs';

// Decision/transport contract tests are not SDK lifecycle qualification.
const request = content => ({ id: 'http_test', body: { model: 'smoke-write', messages: [{ role: 'user', content }] } });
const result = (body, id, value) => body.messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(value) });

async function planJournalFixture(t, { lines = [{ type: 'lifecycle' }], manifestGaps = 0 } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plan-journal-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journalDirectory = path.join(root, 'profile/harness/journal');
  await fs.mkdir(path.join(journalDirectory, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(journalDirectory, 'runtime/manifest.json'), JSON.stringify({ title: 'private title', gapCount: manifestGaps }));
  await fs.writeFile(path.join(journalDirectory, 'runtime/000001.ndjson.open'), lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  return { root, journalDirectory, deadline: performance.now() + 1000 };
}

test('post-exit Plan journal proof retains finite counts and deliberate errors without private detail', async t => {
  const input = await planJournalFixture(t, { lines: [{ type: 'lifecycle' },
    { type: 'log', level: 'error', sessionID: 'ses_private', source: '/private/path', message: 'private credential and deliberate error' }] });
  const evidence = await captureApplicationPlanJournal(input);
  assert.equal(evidence.records, 2); assert.equal(evidence.errorRecords, 1);
  assert.deepEqual(evidence.errorCodes, ['error_log']); assert.equal(evidence.gapRecords, 0); assert.equal(evidence.manifestGapRecords, 0);
  assert.equal(evidence.available, true); assert.equal(evidence.complete, true);
  const retained = await fs.readFile(path.join(input.root, 'plan-journal-coverage.json'), 'utf8');
  assert.deepEqual(JSON.parse(retained), evidence); assert.doesNotMatch(retained, /private|ses_|credential|title|\.cache/);
});

for (const kind of ['explicit','manifest','empty','missing']) test(`Plan journal ${kind} coverage refuses qualification after retaining its summary`, async t => {
  const input = await planJournalFixture(t, { lines: kind === 'explicit' ? ['invalid JSON'] : kind === 'empty' ? [] : undefined,
    manifestGaps: kind === 'manifest' ? 2 : 0 });
  if (kind === 'missing') await fs.rm(input.journalDirectory, { recursive: true });
  await assert.rejects(captureApplicationPlanJournal(input), kind === 'missing' ? /ENOENT/ : /coverage must be/);
  const evidence = JSON.parse(await fs.readFile(path.join(input.root, 'plan-journal-coverage.json'), 'utf8'));
  if (kind === 'explicit') { assert.equal(evidence.gapRecords, 1); assert.deepEqual(evidence.gapCodes, ['segment_parse_failed']); }
  if (kind === 'manifest') assert.equal(evidence.manifestGapRecords, 2);
  if (kind === 'empty') assert.equal(evidence.records, 0);
  if (kind === 'missing') { assert.equal(evidence.available, false); assert.equal(evidence.captureCode, 'ENOENT'); }
});

for (const stage of ['capture','write']) test(`Plan journal ${stage} failure preserves the primary failure and independent cleanup`, async t => {
  const input = await planJournalFixture(t), primary = Error('original Plan failure'), secondary = Object.assign(Error('private detail'), { code: 'EIO' });
  const order = [];
  const options = stage === 'capture' ? { captureJournal: async () => { throw secondary; } }
    : { writeEvidence: async () => { throw secondary; } };
  await assert.rejects(cleanupApplicationPlanResources({ failure: primary, deadline: input.deadline,
    operations: [phase => captureApplicationPlanJournal({ ...input, ...options, deadline: phase.deadline }),
      async () => { order.push('provider'); }, async () => { order.push('reaper'); }] }),
  error => error.cause === primary && error.errors[0] === primary && error.errors[1] === secondary);
  assert.deepEqual(order, ['provider','reaper']);
  if (stage === 'capture') {
    const evidence = JSON.parse(await fs.readFile(path.join(input.root, 'plan-journal-coverage.json'), 'utf8'));
    assert.equal(evidence.captureCode, 'EIO'); assert.doesNotMatch(JSON.stringify(evidence), /private detail/);
  }
});

for (const beforeCapture of [false, true]) test(`Plan journal capture settles when its cleanup signal aborts ${beforeCapture ? 'before' : 'during'} capture`, async t => {
  const input = await planJournalFixture(t), order = [];
  let now = 100, entered, capturedSignal, initiallyAborted;
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadline = now + 25;
  if (beforeCapture) now = deadline;
  const rejected = assert.rejects(cleanupApplicationPlanResources({ deadline, operations: [
    phase => captureApplicationPlanJournal({ ...input, deadline: phase.deadline,
      captureJournal: async (_directory, { signal }) => {
        capturedSignal = signal; initiallyAborted = signal.aborted; entered();
        try {
          signal.throwIfAborted();
          await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        finally { order.push('capture-settled'); }
      } }), async () => { order.push('provider'); },
  ] }));
  await started;
  if (!beforeCapture) { now = deadline; t.mock.timers.tick(25); }
  await rejected;
  assert.equal(initiallyAborted, beforeCapture);
  assert.equal(capturedSignal.aborted, true); assert.equal(capturedSignal.reason.code, 'ABORT_ERR');
  assert.deepEqual([...order].sort(), ['capture-settled','provider'], 'Cleanup must drain the cancelled read and attempt the other owner');
});

test('changes network proof retains only bounded exact owned routes and finite timing/status facts', () => {
  let now = 100;
  const proof = createApplicationPlanChangesEvidence({ origin: 'http://127.0.0.1:1234', sessionID: 'ses_owned', directory: '/owned/project', now: () => now });
  const request = (requestId, pathname, extra = {}) => proof.request({ requestId, request: {
    url: `http://127.0.0.1:1234${pathname}`, method: 'GET', postData: 'private body', headers: { authorization: 'private credential' }, ...extra } });
  request('1.1', '/api/openchamber/session/ses_foreign/changes?directory=private');
  request('1.2', '/api/config/settings');
  request('1.3', '/api/openchamber/session/ses_owned/changes?directory=%2Fowned%2Fproject&private=private-query');
  now = 125; proof.response({ requestId: '1.3', response: { status: 503, headers: { private: 'private-response' }, url: 'private-url' } });
  proof.finished({ requestId: '1.3' });
  request('1.4', '/api/openchamber/session/ses_owned/changes?directory=%2Fforeign');
  now = 130; proof.failed({ requestId: '1.4', errorText: 'private network detail' });
  const evidence = proof.snapshot();
  assert.deepEqual(evidence.records.map(row => [row.phase, row.pathKind, row.directoryMatches]), [
    ['request', 'summary', true], ['response', 'summary', true], ['request', 'summary', false], ['failed', 'summary', false],
  ]);
  assert.equal(evidence.records[1].status, 503); assert.equal(evidence.records[1].elapsedMs, 25); assert.equal(evidence.pending, 0);
  assert.doesNotMatch(JSON.stringify(evidence), /private|credential|authorization|\/owned|\/foreign|headers|postData|errorText/);
  for (let i = 0; i < 300; i++) request(`bound.${i}`, '/api/openchamber/session/ses_owned/changes');
  assert.ok(proof.snapshot().pending <= 128); assert.ok(proof.snapshot().records.length <= 256); assert.ok(proof.snapshot().dropped > 0);
});

test('helper uses the actual live model display label and both real responsive trigger shapes', async () => {
  const selection = { providerID: 'fixture', modelID: 'actual-id' };
  assert.equal(applicationPlanHelperLabel({ providers: [{ id: 'fixture', models: { 'actual-id': { name: 'Actual live label' } } }] }, selection), 'Actual live label');
  assert.equal(applicationPlanHelperLabel({ providers: [{ id: 'fixture', models: { 'actual-id': {} } }] }, selection), 'actual-id');
  assert.throws(() => applicationPlanHelperLabel({ providers: [] }, selection));
  for (const shape of ['desktop-div', 'mobile-button']) {
    let blocked = false, revealed;
    const control = { innerText: 'Actual live label', getClientRects: () => [1], getAttribute: () => null };
    const ui = {
      reveal: async selector => { revealed = selector; },
      waitExpression: async (_label, expression) => runInNewContext(expression, {
        document: { querySelectorAll: selector => {
          assert.ok(shape === 'desktop-div' ? selector.includes('[data-slot="dropdown-menu-trigger"]') : selector.includes('button:has(> div):has(> svg)'));
          return [control];
        } }, getComputedStyle: () => ({ pointerEvents: blocked ? 'none' : 'auto', opacity: blocked ? '0.6' : '1' }),
      }),
    };
    assert.equal(await waitApplicationPlanHelperTrigger(ui, 'Actual live label'), true);
    assert.ok(revealed.includes('[data-helper-model-settings]'));
    blocked = true; assert.equal(await waitApplicationPlanHelperTrigger(ui, 'Actual live label'), false);
    blocked = false; assert.equal(await waitApplicationPlanHelperTrigger(ui, 'guessed seed label'), false);
  }
});

test('helper reselects only the unique current model inside its owning menu and refuses foreign or ambiguous rows', async () => {
  for (const scenario of ['current', 'foreign-menu', 'foreign-label', 'ambiguous', 'disabled']) {
    const clicks = []; let closed = false;
    const trigger = { innerText: 'Actual live label', getClientRects: () => [1],
      getAttribute: name => name === 'aria-expanded' ? closed ? 'false' : 'true' : 'owned-menu' };
    const row = { querySelector: selector => selector.includes('span') ? { textContent: scenario === 'foreign-label' ? 'Other model' : 'Actual live label' } : {},
      getAttribute: () => scenario === 'disabled' ? 'true' : null };
    const menu = { getAttribute: () => 'menu', querySelectorAll: () => scenario === 'ambiguous' ? [row, row] : [row] };
    const ui = {
      reveal: async () => {}, click: async input => { clicks.push(input); if (clicks.length === 2) closed = true; },
      waitExpression: async (_label, expression) => {
        const value = await runInNewContext(expression, { document: {
          querySelectorAll: () => [trigger], querySelector: () => trigger,
          getElementById: id => id === 'owned-menu' && scenario !== 'foreign-menu' && !closed ? menu : null,
        }, getComputedStyle: () => ({ pointerEvents: 'auto', opacity: '1' }), requestAnimationFrame: callback => queueMicrotask(callback) });
        if (!value) throw Error('fixture menu refused');
        return value;
      },
    };
    if (scenario === 'current') {
      await selectApplicationPlanCurrentHelper(ui, 'Actual live label');
      assert.equal(clicks.length, 2); assert.ok(clicks[1].selector.includes('[id="owned-menu"]'));
      assert.equal(clicks[1].text, 'Actual live label');
    } else {
      await assert.rejects(selectApplicationPlanCurrentHelper(ui, 'Actual live label'), /fixture menu refused/);
      assert.equal(clicks.length, 1, 'opening a menu cannot qualify or save a selection');
    }
  }
});

test('helper capture waits for its exact menu to close without accepting painted ghosts or closing animations', async () => {
  for (const scenario of ['absent', 'nonpainted', 'painted-ghost', 'closing-animation', 'still-open', 'reopens-during-paint']) {
    let expanded = scenario === 'still-open' ? 'true' : 'false';
    const menu = { getAnimations: options => { assert.equal(options.subtree, true); return scenario === 'closing-animation' ? [{ playState: 'running' }] : []; },
      getBoundingClientRect: () => ({ width: 200, height: 100 }) };
    const ui = { waitExpression: async (_label, expression) => runInNewContext(expression, {
      document: { querySelector: () => ({ getAttribute: () => expanded }), getElementById: id => {
        assert.equal(id, 'owned-menu'); return ['absent', 'reopens-during-paint'].includes(scenario) ? null : menu;
      } },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: scenario === 'painted-ghost' ? '0.5' : '0' }),
      requestAnimationFrame: callback => { if (scenario === 'reopens-during-paint') expanded = 'true'; queueMicrotask(callback); },
    }) };
    assert.equal(await waitApplicationPlanHelperMenuClosed(ui, 'owned-menu'), ['absent', 'nonpainted'].includes(scenario));
  }
});

test('fresh responsive settings navigation waits for hit-ready controls and opens the actual sidebar', async () => {
  for (const initial of ['hydrating', 'drawer', 'settings']) {
    let state = initial; const clicks = [];
    const button = (label, { left = 10, top = 10, text = false } = {}) => {
      const e = { innerText: text ? label : '', disabled: false, parentElement: null,
        getAttribute: name => name === 'aria-label' ? label : null,
        getBoundingClientRect: () => ({ left, top, width: 30, height: 30 }), contains: hit => hit === e };
      return e;
    };
    const hiddenSettings = button('Settings', { left: -200 }), settings = button('Settings'), sessions = button('Open Sessions');
    const agents = button('Agents', { text: true });
    const document = {
      querySelectorAll: selector => selector.includes('data-settings-view') ? state === 'settings' ? [agents] : []
        : state === 'hydrating' ? [] : state === 'closed' ? [hiddenSettings, sessions] : state === 'drawer' ? [settings] : [],
      elementFromPoint: () => state === 'closed' ? sessions : state === 'drawer' ? settings : agents,
    };
    const ui = {
      waitExpression: async (_label, expression) => {
        for (let i = 0; i < 3; i++) {
          const value = runInNewContext(expression, { document, innerWidth: 1280, innerHeight: 800,
            getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' }) });
          if (value) return value;
          if (state === 'hydrating') state = 'closed';
        }
        throw Error('fixture navigation unavailable');
      },
      click: async input => {
        const label = input.label ?? input.text; clicks.push(label);
        if (label === 'Open Sessions') { assert.equal(state, 'closed'); state = 'drawer'; }
        if (label === 'Settings') { assert.equal(state, 'drawer'); state = 'settings'; }
      },
    };
    await openApplicationPlanSessionDefaults(ui);
    assert.deepEqual(clicks, [...(initial === 'hydrating' ? ['Open Sessions'] : []), ...(initial !== 'settings' ? ['Settings'] : []), 'Agents', 'Session Defaults']);
    assert.equal(state, 'settings');
  }
});

test('rect-only, hidden and occluded Settings controls cannot qualify shell readiness', () => {
  const e = { disabled: false, parentElement: null, getAttribute: name => name === 'aria-label' ? 'Settings' : null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 30, height: 30 }), contains: hit => hit === e };
  for (const scenario of ['ready', 'hidden', 'occluded', 'disabled']) {
    e.disabled = scenario === 'disabled';
    const value = runInNewContext(applicationPlanControlReady('Settings'), {
      document: { querySelectorAll: () => [e], elementFromPoint: () => scenario === 'occluded' ? {} : e }, innerWidth: 1280, innerHeight: 800,
      getComputedStyle: () => ({ display: scenario === 'hidden' ? 'none' : 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' }),
    });
    assert.equal(value, scenario === 'ready');
  }
});

test('helper reload arms the owned load waiter before reload and never admits the old settings DOM', async () => {
  const order = []; let finishLoad, complete = false, timeout;
  const loaded = new Promise(resolve => { finishLoad = resolve; });
  const cdp = { waitFor: (event, bound) => { assert.equal(event, 'Page.loadEventFired'); timeout = bound; order.push('waiter'); return loaded; },
    send: async (method, _params, options) => { assert.equal(method, 'Page.reload'); assert.equal(options.timeoutMs, timeout); order.push('reload'); } };
  const work = reloadApplicationPlanDocument(cdp, { deadline: performance.now() + 500 }).then(() => { complete = true; });
  await Promise.resolve();
  assert.deepEqual(order, ['waiter', 'reload']); assert.equal(complete, false); assert.ok(timeout > 0 && timeout <= 500);
  finishLoad(); await work; assert.equal(complete, true);
  const cancelled = new AbortController(); cancelled.abort(Error('cancelled'));
  await assert.rejects(reloadApplicationPlanDocument(cdp, { deadline: performance.now() + 500, signal: cancelled.signal }), /cancelled/);
  assert.deepEqual(order, ['waiter', 'reload']);
});

test('each positive capture rechecks card authority after responsive refresh and rejects error or unsettled paint', async () => {
  for (const phase of ['file-undo', 'file-redo', 'restart-restored', 'continued-plan', 'recovered-outcome']) {
    let disabled = true, status = 'Loading session changes…', opacity = '1', running = false, lateRefresh = false;
    const control = { get disabled() { return disabled; }, getAttribute: () => null, getAnimations: () => running ? [{ playState: 'running' }] : [],
      closest: selector => selector.includes('session-changes') ? { querySelector: () => ({ innerText: status }) } : {},
    };
    const ui = { waitExpression: async (_label, expression) => runInNewContext(expression, {
      document: { querySelector: () => control }, getComputedStyle: () => ({ pointerEvents: 'auto', opacity }),
      requestAnimationFrame: callback => { if (lateRefresh) disabled = true; queueMicrotask(callback); },
    }) };
    assert.equal(await waitApplicationPlanCapture(ui, phase, '.plan'), false);
    status = ''; disabled = false;
    assert.equal((await waitApplicationPlanCapture(ui, phase, '.plan')).paintStable, true);
    running = true; assert.equal(await waitApplicationPlanCapture(ui, phase, '.plan'), false); running = false;
    opacity = '0.65'; assert.equal(await waitApplicationPlanCapture(ui, phase, '.plan'), false); opacity = '1';
    lateRefresh = true; assert.equal(await waitApplicationPlanCapture(ui, phase, '.plan'), false); lateRefresh = false;
    disabled = true; status = 'Session changes could not be loaded. Retry';
    await assert.rejects(waitApplicationPlanCapture(ui, phase, '.plan'), /qa_plan_session_changes_load_failed/);
  }
});

test('partial outcome requires a settled summary but reports legitimate blocked restoration without manufacturing authority', async () => {
  let status = 'Loading session changes…';
  const control = { disabled: true, getAttribute: () => null, getAnimations: () => [],
    closest: () => ({ querySelector: () => ({ innerText: status }) }) };
  const ui = { waitExpression: async (_label, expression) => runInNewContext(expression, {
    document: { querySelector: () => control }, getComputedStyle: () => ({ pointerEvents: 'none', opacity: '0.5' }),
    requestAnimationFrame: callback => queueMicrotask(callback),
  }) };
  assert.equal(await waitApplicationPlanCapture(ui, 'partial-outcome', null), false);
  status = '';
  const state = await waitApplicationPlanCapture(ui, 'partial-outcome', null);
  assert.equal(state.enabled, false); assert.equal(state.status, 'settled'); assert.equal(state.paintStable, true);
  status = 'Session changes could not be loaded. Retry';
  await assert.rejects(waitApplicationPlanCapture(ui, 'partial-outcome', null), /qa_plan_session_changes_load_failed/);
});

function fileRestoreUi({ title = 'Undo this session’s changes?', disabled = false, additionalDialog = false, cancelled = false } = {}) {
  let modal = false, mode = 'changes', publications = 0;
  const order = [];
  const dialog = { getBoundingClientRect: () => ({ width: 320, height: 160 }), getAttribute: () => 'undo-title',
    querySelectorAll: () => [{ innerText: 'Undo', disabled }] };
  const document = {
    getElementById: () => ({ textContent: title }),
    querySelectorAll: () => modal ? additionalDialog ? [dialog, dialog] : [dialog] : [],
    querySelector: selector => {
      if (selector.startsWith('[role="dialog"]')) return modal ? dialog : null;
      if (selector.startsWith('[data-session-changes-card=')) return selector.includes(`="${mode}"`) ? { disabled: false } : null;
      return { disabled: false };
    },
  };
  const ui = {
    reveal: async () => {},
    waitExpression: async (label, expression) => {
      const value = runInNewContext(expression, { document });
      if (!value) throw Error(`fixture wait refused: ${label}`);
      order.push(label);
      return value;
    },
    click: async ({ selector }) => {
      if (selector.includes('[role="dialog"]')) {
        if (cancelled) modal = false;
        if (!modal || disabled || title !== 'Undo this session’s changes?') throw Error('confirmation unavailable');
        assert.equal(publications, 0, 'opening Undo must not dispatch its owner');
        modal = false; mode = 'undone'; publications++; order.push('confirmed-undo');
      } else if (selector.includes('"undo"')) { modal = true; order.push('opened-undo'); }
      else { mode = 'changes'; publications++; order.push('direct-redo'); }
    },
  };
  return { ui, order, publications: () => publications };
}

test('file Undo dispatches only through its exact enabled confirmation before waiting for the real card; Redo is direct', async () => {
  const fixture = fileRestoreUi();
  await restoreApplicationPlanFiles(fixture.ui, 'undo');
  assert.equal(fixture.publications(), 1);
  assert.ok(fixture.order.indexOf('opened-undo') < fixture.order.indexOf('confirmed-undo'));
  assert.ok(fixture.order.indexOf('file Undo confirmation is closed') < fixture.order.indexOf('file restoration settled in the real card'));
  await restoreApplicationPlanFiles(fixture.ui, 'redo');
  assert.equal(fixture.publications(), 2);
  assert.equal(fixture.order.filter(value => value === 'opened-undo').length, 1);
  assert.ok(fixture.order.includes('direct-redo'));
});

test('wrong, ambiguous, disabled or cancelled Undo confirmations never dispatch or report a settled restoration', async () => {
  for (const options of [{ title: 'Delete session?' }, { disabled: true }, { additionalDialog: true }, { cancelled: true }]) {
    const fixture = fileRestoreUi(options);
    await assert.rejects(restoreApplicationPlanFiles(fixture.ui, 'undo'), /fixture wait refused|confirmation unavailable/);
    assert.equal(fixture.publications(), 0);
    assert.equal(fixture.order.includes('file restoration settled in the real card'), false);
  }
});

test('Plan shutdown acknowledges only after pending captures and physical browser cleanup', async () => {
  const order = [];
  let captureDone, browserDone;
  const capture = new Promise(resolve => { captureDone = resolve; });
  const stopped = new Promise(resolve => { browserDone = resolve; });
  const settlement = settleApplicationPlanBrowser({ approvalWork: [capture],
    closeBrowser: async () => { order.push('browser-stop'); await stopped; order.push('profile-removed'); },
    acknowledge: () => { order.push('ipc-ack'); } });
  await Promise.resolve(); assert.deepEqual(order, []);
  captureDone(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(order, ['browser-stop']);
  browserDone(); await settlement;
  // The driver may begin production shutdown only after this exact ACK.
  order.push('application-stop');
  assert.deepEqual(order, ['browser-stop', 'profile-removed', 'ipc-ack', 'application-stop']);
});

test('failed Plan captures still close their browser and cannot acknowledge settlement', async () => {
  const failure = Error('capture failed'), order = [];
  await assert.rejects(settleApplicationPlanBrowser({ approvalWork: [Promise.reject(failure)],
    closeBrowser: async () => { order.push('browser-closed'); },
    acknowledge: () => { order.push('ipc-ack'); } }), error => error === failure);
  assert.deepEqual(order, ['browser-closed']);
});

test('failed physical Plan browser cleanup cannot acknowledge settlement', async () => {
  const failure = Error('browser ownership cleanup failed');
  let acknowledged = false;
  await assert.rejects(settleApplicationPlanBrowser({ approvalWork: [],
    closeBrowser: async () => { throw failure; },
    acknowledge: () => { acknowledged = true; } }), error => error === failure);
  assert.equal(acknowledged, false);
});

test('one failed capture drains concurrent captures before browser close and preserves cleanup errors', async () => {
  const original = Error('first capture failed'), cleanup = Error('browser failed'), order = [];
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const settled = settleApplicationPlanBrowser({ approvalWork: [Promise.reject(original), pending],
    closeBrowser: async () => { order.push('closed'); throw cleanup; },
    acknowledge: () => { order.push('ack'); } });
  const rejected = assert.rejects(settled, error => error.cause === original && error.errors[1] === cleanup);
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(order, []);
  complete(); await rejected; assert.deepEqual(order, ['closed']);
});

test('all owned cleanup operations run despite browser failure and retain the primary failure', async () => {
  const primary = Error('product failed'), cleanup = Error('browser failed'), order = [];
  await assert.rejects(cleanupApplicationPlanResources({ failure: primary, deadline: performance.now() + 1000,
    operations: [async () => { order.push('browser'); throw cleanup; },
      async () => { order.push('provider'); }, async () => { order.push('reaper'); }] }),
  error => error.cause === primary && error.errors[1] === cleanup);
  assert.deepEqual(order, ['browser', 'provider', 'reaper']);
});

test('a hung cleanup step is bounded and cannot prevent later cleanup attempts', async () => {
  let reaped = false;
  await assert.rejects(cleanupApplicationPlanResources({ deadline: performance.now() + 10,
    operations: [() => new Promise(() => {}), () => { reaped = true; }] }),
    error => /cleanup deadline/.test((error.cause ?? error).message));
  assert.equal(reaped, true);
});
test('failure cleanup passes its bounded phase to real async closers and settles before propagating the primary failure',async()=>{
 const primary=Error('original application failure');let physicalCloseSettled=false,phase;
 const deadline=performance.now()+1000;
 await assert.rejects(cleanupApplicationPlanResources({failure:primary,deadline,operations:[async input=>{
  phase=input.deadline;await new Promise(resolve=>setTimeout(resolve,15));physicalCloseSettled=true;
 }]}),error=>error===primary);
 assert.ok(phase<=deadline);assert.equal(physicalCloseSettled,true);
});
test('a stalled browser opener publishes its physical closer before readiness and failure cleanup drains it without late readiness',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-plan-opener-'))),profile=path.join(root,'chromium');await fs.mkdir(profile);
 const lifetime=new AbortController(),primary=Error('original work deadline');
 let closePhysical,entered,physicallyClosed=false,lateReady=false,phase;
 const composerRead=new Promise(resolve=>{entered=resolve;});
 const cdp={send:async method=>{if(method==='Runtime.evaluate'){entered();return {result:{value:false}};}return {};},on:()=>{},close:()=>{}};
 const opening=openOwnedPlan({origin:'http://fixture',owner:{name:'fixture',value:'fixture'},sessionID:'ses_fixture',root,environment:{},showBrowser:false,
  deadline:performance.now()+2000,workDeadline:performance.now()+1000,identity:{},signal:lifetime.signal,onAcquired:close=>{closePhysical=close;},
  discoverTarget:async()=>({webSocketDebuggerUrl:'fixture'}),connectCdp:async()=>cdp,
  startBrowser:()=>({check:()=>{},stop:async input=>{phase=input.deadline;await new Promise(resolve=>setTimeout(resolve,20));physicallyClosed=true;}})
 }).then(()=>{lateReady=true;},error=>error);
 try{
  await composerRead;assert.equal(typeof closePhysical,'function');assert.equal(physicallyClosed,false);
  lifetime.abort(primary);
  const deadline=performance.now()+1500;
  await assert.rejects(cleanupApplicationPlanResources({failure:primary,deadline,
   operations:[input=>closePhysical(input),()=>Promise.allSettled([opening])]}),error=>error===primary);
  assert.equal(await opening,primary);assert.equal(physicallyClosed,true);assert.ok(phase<=deadline);assert.equal(lateReady,false);
  await assert.rejects(fs.access(profile),{code:'ENOENT'});
 }finally{lifetime.abort(primary);await closePhysical?.();await opening;await fs.rm(root,{recursive:true,force:true});}
});
test('source verification checks native source, runner, TSX and UI asset identity on success and failure without replacing the primary error',async()=>{
 const repository=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-plan-source-')));
 const runner='scripts/opencode-v2-native/package-plan-implement-lane.mjs',tsx='packages/ui/src/Fixture.tsx',asset='packages/web/dist/assets/fixture.js',native='packages/web/server/lib/opencode/native.js';
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 try{
  for(const file of [runner,tsx,asset,native,'packages/web/dist/.vite/manifest.json'])await fs.mkdir(path.dirname(path.join(repository,file)),{recursive:true});
  await fs.writeFile(path.join(repository,'packages/web/dist/.vite/manifest.json'),JSON.stringify({'index.html':{isEntry:true,file:'assets/fixture.js'}}));
  for(const file of [runner,tsx,asset,native])await fs.writeFile(path.join(repository,file),'original fixture');
  const capture=()=>captureApplicationPlanIdentity({repository,captureNativeSource:async()=>({sourceDigest:digest(await fs.readFile(path.join(repository,native))),sources:{[native]:digest(await fs.readFile(path.join(repository,native)))}}),
   captureUiSource:async()=>({sha256:digest(await fs.readFile(path.join(repository,tsx))),entries:[tsx]})});
  const before=await capture();
  assert.deepEqual((await finishApplicationPlanSourceVerification({identity:before,root:repository,captureIdentity:capture})).sourceCohort,{valid:true,changedPaths:[]});
  const primary=Error('actual product failure');
  for(const file of [runner,tsx,asset,native]){
   await fs.writeFile(path.join(repository,file),'changed fixture');
   const checked=await finishApplicationPlanSourceVerification({identity:before,root:repository,failure:primary,captureIdentity:capture});
   assert.equal(checked.sourceCohort.valid,false);assert.equal(checked.failure.cause,primary);assert.equal(checked.failure.errors[0],primary);
   assert.equal(JSON.parse(await fs.readFile(path.join(repository,'plan-source-cohort.json'))).valid,false);
   await fs.writeFile(path.join(repository,file),'original fixture');
  }
  const unchanged=await finishApplicationPlanSourceVerification({identity:before,root:repository,failure:primary,captureIdentity:capture});
  assert.equal(unchanged.failure,primary);assert.equal(unchanged.sourceCohort.valid,true);
 }finally{await fs.rm(repository,{recursive:true,force:true});}
});

test('a Plan child ignoring TERM cannot withhold cleanup after the absolute deadline', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    child.kill('SIGTERM');
    await assert.rejects(awaitApplicationPlanExit(child, closed, performance.now() + 25), { code: 'qa_plan_deadline_exceeded' });
    assert.deepEqual(await closed, [null, 'SIGKILL']);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
});

test('isolated Plan decisions require real native refusal/results and never manufacture approval', () => {
  const fixture = createPlanImplementResponder(), input = request(PLAN_REQUEST);
  assert.equal(fixture.responder(input).items[0].name, 'write');
  result(input.body, 'native_plan_denied_write', { error: 'readonly' });
  assert.equal(fixture.responder(input).items[0].name, 'shell');
  result(input.body, 'native_plan_denied_shell', { error: 'confined' });
  assert.equal(fixture.responder(input).items[0].input.command, 'test -r plan-seed.txt');
  result(input.body, 'native_plan_safe_read', { exitCode: 0 });
  const start = fixture.responder(input).items[0];
  assert.equal(start.name, 'devryan_task'); assert.equal(start.input.action, 'start');
  assert.equal(Object.hasOwn(start.input, 'required_checks'), false, 'Read-only child uses its allowed inspection tool');
  assert.equal(Object.hasOwn(start.input, 'readOnly'), false, 'Read-only authority is captured by the product owner');
  assert.throws(() => fixture.responder(request('unrelated paid/account request')), /Unrelated provider request/);
});

test('managed decisions drain exact report/metadata cursors before the later native continue step', () => {
  const fixture = createPlanImplementResponder(), input = request('[openchamber-plan-action:v1] UI fixture marker');
  result(input.body, 'native_plan_fixer_start', { task: { taskId: 'dvr_task_fixer' } });
  assert.equal(fixture.responder(input).items[0].input.action, 'wait');
  result(input.body, 'native_plan_fixer_wait', { task: { taskId: 'dvr_task_fixer', status: 'completed' },
    metadataReference: { complete: false, nextCursor: 'metadata-1' }, resultReference: { complete: false, nextCursor: 'report-1' } });
  assert.equal(fixture.responder(input).items[0].input.result_cursor, 'metadata-1');
  result(input.body, 'native_plan_fixer_page_0', { metadataReference: { complete: true, nextCursor: null } });
  assert.equal(fixture.responder(input).items[0].input.result_cursor, 'report-1');
  result(input.body, 'native_plan_fixer_page_1', { resultReference: { complete: true, nextCursor: null } });
  assert.deepEqual(fixture.responder(input).items[0].input, { action: 'continue', task_id: 'dvr_task_fixer' });
  const failed = request('[openchamber-plan-action:v1] UI fixture marker');
  result(failed.body, 'native_plan_fixer_start', { task: { taskId: 'dvr_task_fixer' } });
  result(failed.body, 'native_plan_fixer_wait', { task: { status: 'failed', failureReason: 'actual check failed' } });
  assert.throws(() => fixture.responder(failed), /Actual fixer child failed/);
});

test('recovery decision runs an actual writer and check before its final answer', () => {
  const fixture = createPlanImplementResponder(), input = request(REPAIR_REQUEST);
  assert.equal(fixture.responder(input).items[0].id, 'native_plan_repair_write');
  result(input.body, 'native_plan_repair_write', { saved: true });
  assert.equal(fixture.responder(input).items[0].name, 'shell');
  result(input.body, 'native_plan_repair_check', { exitCode: 0 });
  assert.equal(fixture.responder(input).reason, 'stop');
});

test('managed title decisions require the delegated source and no conversation tools or reasoning', () => {
  const fixture = createPlanImplementResponder();
  const input = request('Generate a concise title for this coding session\n[devryan-plan-child:fixer] Write fixer.txt and check it.');
  assert.equal(fixture.responder(input).items[0].text, 'Publish Fixer Implementation');
  assert.deepEqual(fixture.decisions, [{ requestID: 'http_test', phase: 'title', role: 'fixer' }]);
  input.body.tools = [{ name: 'write' }];
  assert.throws(() => fixture.responder(input), /Title helper acquired conversation tools/);
  delete input.body.tools; input.body.reasoning_effort = 'high';
  assert.throws(() => fixture.responder(input), /Title helper inherited conversation reasoning/);
  assert.throws(() => fixture.responder(request('Generate a concise title for this coding session\nunrelated private task')), /Unrelated title source/);
});

test('runtime UI provider accepts only an explicit constructor fixture responder', async () => {
  let called = 0;
  const provider = await createRuntimeUiProvider({ generation: 2, directory: '/owned/project', packetDelayMs: 0,
    fixtureResponder: input => { called++; assert.equal(input.body.model, 'smoke-write');
      return { items: [{ type: 'textDelta', text: 'explicit bounded fixture' }], reason: 'stop' }; } });
  try {
    const response = await fetch(provider.baseURL + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'smoke-write', stream: true, messages: [{ role: 'user', content: 'owned fixture' }] }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /explicit bounded fixture/);
    assert.equal(called, 1); assert.equal(provider.observations.length, 1); provider.check();
  } finally { await provider.close(); }
  await assert.rejects(createRuntimeUiProvider({ generation: 2, directory: '/owned/project', fixtureResponder: true }));
});

test('finite fixture cut preserves prefix bytes and omits only the terminal finish/DONE once', async () => {
  let cut = false;
  const provider = await createRuntimeUiProvider({ generation: 2, directory: '/owned/project', packetDelayMs: 0,
    fixtureResponder: () => ({ items: [{ type: 'textDelta', text: 'exact interrupted prefix 世界\n' }], reason: 'stop' }),
    truncateFixtureReply: () => { if (cut) return false; cut = true; return true; } });
  try {
    const invoke = () => fetch(provider.baseURL + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'smoke-write', stream: true, messages: [{ role: 'user', content: 'owned finite cut' }] }) }).then(response => response.text());
    const first = await invoke(); assert.match(first, /exact interrupted prefix 世界/);
    assert.equal(first.includes('"finish_reason":"stop"'), false); assert.equal(first.includes('[DONE]'), false);
    const second = await invoke(); assert.match(second, /"finish_reason":"stop"/); assert.match(second, /\[DONE\]/);
    provider.check();
  } finally { await provider.close(); }
});

test('fixture continuation decision returns only the exact heading-free Plan remainder', () => {
  const fixture = createPlanImplementResponder({ continuePlan: true }), input = request(PLAN_REQUEST);
  for (const id of ['native_plan_denied_write','native_plan_denied_shell','native_plan_safe_read']) result(input.body,id,{});
  result(input.body,'native_plan_inspection_start',{task:{taskId:'dvr_task_inspection'}});
  result(input.body,'native_plan_inspection_wait',{task:{status:'completed'},resultReference:{complete:true,nextCursor:null}});
  result(input.body,'native_plan_inspection_continue',{resultEnvelope:{action:'continue'}});
  const prefix = fixture.responder(input).items[0].text;
  input.body.messages.push({ role:'user',content:'The previous response was interrupted. Continue from where you left off without repeating completed content.' });
  const tail = fixture.responder(input).items[0].text;
  assert.equal((prefix+tail).replace('<!--plan-->\n',''),PLAN_CONTENT);
  assert.equal(/^#|<!--plan-->/m.test(tail),false);
  const declared = runtimeUiNativeConfiguration(runtimeUiConfiguration('http://127.0.0.1:12345/v1',{modelContext:200000}));
  assert.deepEqual(declared.providers['devryan-smoke'].models['smoke-write'].limit,{context:200000,input:195904,output:4096});
});
