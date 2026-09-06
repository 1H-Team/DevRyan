import assert from 'node:assert/strict';
import { evaluate } from '../qa/cdp.mjs';
import { createQaUiDriver } from '../qa/ui-driver.mjs';
import { waitForQaHostReady } from '../qa/host-readiness.mjs';

export const SESSION_MEMORY_FIXTURE = Object.freeze({ sessions: 4, turns: 180, textBytes: 4096 });
export const MEMORY_SETTLE_MS = 6000;
const SAMPLE_INTERVAL_MS = 500;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function observeStartupNavigation(cdp, startedAt, initialUrl = '') {
  const transitions = [];
  const attempts = [];
  let overflow = false;
  const target = raw => {
    try {
      const url = new URL(raw);
      return url.protocol === 'data:' ? 'data:startup-document' : `${url.origin === 'null' ? url.protocol : url.origin}${url.pathname}`;
    } catch { return 'unavailable'; }
  };
  const record = (url, loaderId, kind) => {
    if (transitions.length >= 32) { overflow = true; return; }
    transitions.push({ elapsedMs: performance.now() - startedAt, url: target(url), loaderId, kind });
  };
  record(initialUrl, null, 'initial-cdp-target');
  const remove = cdp.on('Page.frameNavigated', ({ frame }) => {
    if (frame && !frame.parentId) record(frame.url, frame.loaderId, 'native-top-frame-navigation');
  });
  const originalSend = cdp.send;
  const guardedSend = function(method, params) {
    if (['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry', 'Page.setDocumentContent'].includes(method)) {
      attempts.push({ method, elapsedMs: performance.now() - startedAt });
      return Promise.reject(new Error('Benchmark-forced navigation cannot count toward native startup'));
    }
    return originalSend.call(this, method, params);
  };
  cdp.send = guardedSend;
  return { transitions, attempts, hasOverflow: () => overflow, complete: () => {
    remove();
    if (cdp.send === guardedSend) cdp.send = originalSend;
  } };
}

const documentSnapshot = () => `(() => {
  const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const composer = [...document.querySelectorAll('textarea')].find(e => visible(e) && !e.disabled);
  const newChat = [...document.querySelectorAll('button[aria-label="New Chat"]')].some(e => visible(e) && !e.disabled);
  const modelLabels = [...document.querySelectorAll('.model-controls__model-label')]
    .filter(e => visible(e) && e.closest('button') && !e.closest('button').disabled).map(e => e.innerText.trim()).filter(Boolean);
  const config = window.__zustand_config_store__?.getState();
  const provider = config?.providers?.find(p => p.id === config.currentProviderId);
  const model = provider?.models?.find(m => m.id === config.currentModelId);
  const selectedModel = config ? { providerId: config.currentProviderId, modelId: config.currentModelId,
    agent: config.currentAgentName, catalogAvailable: Boolean(model && model.available !== false) } : null;
  const navigation = performance.getEntriesByType('navigation')[0];
  return { timeOrigin: performance.timeOrigin, href: location.href, readyState: document.readyState,
    visibilityState: document.visibilityState, composer: Boolean(composer), newChat, model: modelLabels.length > 0, modelLabels, selectedModel,
    sessionID: new URL(location.href).searchParams.get('session'),
    navigation: navigation ? { type: navigation.type, domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
      loadEventEnd: navigation.loadEventEnd, duration: navigation.duration } : null,
    paints: performance.getEntriesByType('paint').map(e => ({ name: e.name, startTime: e.startTime })) };
})()`;

export function selectedFixtureModelIsAvailable(snapshot, catalog) {
  const selected = snapshot.selectedModel;
  return selected?.providerId === 'fixture' && selected.modelId === 'fixture-model' && selected.catalogAvailable === true
    && catalog.connected?.includes(selected.providerId)
    && Boolean(catalog.all?.find(provider => provider.id === selected.providerId)?.models?.[selected.modelId]);
}

export function assertStartupMode(startupMode) {
  assert.ok(startupMode === 'natural' || startupMode === 'foreground', 'startupMode must be natural or foreground');
}

export async function captureFirstDocumentStartup({ cdp, fixture, origin, startedAt, milestones = {}, checkAlive, navigationAudit,
  startupMode = 'natural' }) {
  assertStartupMode(startupMode);
  const audit = navigationAudit ?? observeStartupNavigation(cdp, startedAt, origin);
  const evidence = { outcome: 'pending', startupMode,
    scope: startupMode === 'foreground'
      ? 'fresh-process/fresh-profile; deterministic external OpenCode fixture; foreground-controlled admission, not natural startup latency'
      : 'fresh-process/fresh-profile; deterministic external OpenCode fixture',
    clock: 'parent performance.now; elapsed milliseconds since spawn invocation', pollIntervalMs: 100,
    forcedNavigations: 0, documents: [], ...milestones };
  const observe = async () => {
    const snapshot = await evaluate(cdp, documentSnapshot());
    evidence.lastObservedDocument = snapshot;
    if (!evidence.firstSelectedModel && snapshot.selectedModel?.providerId && snapshot.selectedModel?.modelId) {
      evidence.firstSelectedModel = { observedAtMs: performance.now() - startedAt, ...snapshot.selectedModel };
    }
    if (evidence.documents.at(-1)?.timeOrigin !== snapshot.timeOrigin) {
      assert.ok(evidence.documents.length < 32 && !audit.hasOverflow(), 'Native startup navigation evidence overflowed');
      evidence.documents.push({ observedAtMs: performance.now() - startedAt, ...snapshot });
    }
    return snapshot;
  };
  try {
    evidence.firstObservedDocument = await observe();
    await waitForQaHostReady({ origin, checkAlive });
    evidence.hostReadyMs = performance.now() - startedAt;
    const response = await fetch(`${origin}/api/provider`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, 'Startup fixture provider catalog is unavailable');
    const catalog = await response.json();
    assert.ok(catalog.connected?.includes('fixture') && catalog.all?.some(provider => provider.id === 'fixture' && provider.models?.['fixture-model']),
      'Startup must use the deterministic fixture provider catalog');
    evidence.fixtureCatalogReadyMs = performance.now() - startedAt;
    const ui = createQaUiDriver(cdp, { checkAlive, timeoutMs: 45000 });
    const foregroundDeadline = startupMode === 'foreground' ? performance.now() + 45000 : null;
    evidence.document = await ui.waitFor('first usable UI after native startup documents', async () => {
      if (foregroundDeadline !== null && performance.now() > foregroundDeadline) {
        throw new Error('Timed out: first usable UI after native startup documents');
      }
      const snapshot = await observe();
      assert.equal(audit.attempts.length, 0, 'Benchmark-forced navigation was attempted during startup');
      if (foregroundDeadline !== null && performance.now() > foregroundDeadline) {
        throw new Error('Timed out: first usable UI after native startup documents');
      }
      if (startupMode === 'foreground' && !evidence.foregroundActivation) {
        if (!snapshot.composer || !snapshot.newChat || !snapshot.model || !selectedFixtureModelIsAvailable(snapshot, catalog)
          || fixture.getState().sseClientCount < 1) return false;
        const activation = { method: 'Page.bringToFront', requestedAtMs: performance.now() - startedAt,
          documentTimeOrigin: snapshot.timeOrigin, outcome: 'pending' };
        evidence.foregroundActivation = activation;
        try {
          activation.acknowledgement = await cdp.send('Page.bringToFront');
          activation.acknowledgedAtMs = performance.now() - startedAt;
          activation.outcome = 'acknowledged';
        } catch (error) {
          activation.outcome = 'failed';
          activation.error = error.message;
          throw error;
        }
        // Admission must use a later observation, even when already visible.
        // This one-shot setup shares the original deadline and is never retried.
        return false;
      }
      if (!snapshot.composer || !snapshot.newChat || !snapshot.model || !selectedFixtureModelIsAvailable(snapshot, catalog)
        || snapshot.visibilityState !== 'visible'
        || fixture.getState().sseClientCount < 1) return false;
      return snapshot;
    });
    evidence.uiReadyMs = performance.now() - startedAt;
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.outcome = 'failed';
    evidence.error = error.message;
  } finally {
    evidence.nativeTransitions = [...audit.transitions];
    evidence.forcedNavigations = audit.attempts.length;
    evidence.benchmarkNavigationAttempts = [...audit.attempts];
    evidence.nativeDocumentChanges = Math.max(0, evidence.documents.length - 1);
    audit.complete();
  }
  return evidence;
}

export async function prepareMemorySessions(fixture) {
  const sessions = [];
  for (let index = 0; index < SESSION_MEMORY_FIXTURE.sessions; index += 1) {
    const title = `Memory fixture ${index + 1}`;
    const response = await fetch(`${fixture.origin}/session`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, 'Fixture must support independent owned sessions');
    const session = await response.json();
    assert.match(session.id, /^ses_[a-zA-Z0-9]+$/);
    assert.equal(session.parentID, undefined);
    const history = fixture.seedHistory(session.id, SESSION_MEMORY_FIXTURE);
    sessions.push({ id: session.id, title, expectedMessages: history.messages });
  }
  return sessions;
}

// Count a contiguous newest-to-oldest HTTP page chain, not overlapping adaptive
// snapshots or the number of virtualized DOM rows.
export function historyCoverage(pages) {
  const visit = (before, seen) => {
    if (seen.has(before)) return 0;
    const nextSeen = new Set([...seen, before]);
    return Math.max(0, ...pages.filter(page => page.before === before && page.returned > 0)
      .map(page => page.returned + visit(page.firstMessageID, nextSeen)));
  };
  return visit(null, new Set());
}

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function projectRendererMemory({ host, heap, dom }) {
  const renderers = host.appMetrics?.filter(metric => metric.type === 'Tab') ?? [];
  assert.equal(renderers.length, 1, 'Session-memory measurement requires exactly one renderer');
  const renderer = renderers[0];
  for (const value of [renderer.pid, renderer.creationTime, renderer.memory?.workingSetSize,
    heap.usedSize, heap.totalSize, dom.documents, dom.nodes, dom.jsEventListeners]) {
    assert.ok(Number.isFinite(value) && value >= 0, 'Incomplete renderer memory diagnostics');
  }
  return { rendererPid: renderer.pid, rendererCreatedAt: renderer.creationTime,
    rendererWorkingSetBytes: renderer.memory.workingSetSize * 1024,
    rendererHeapUsedBytes: heap.usedSize, rendererHeapTotalBytes: heap.totalSize,
    ...(Number.isFinite(heap.backingStorageSize) ? { rendererBackingStorageBytes: heap.backingStorageSize } : {}),
    dom, mainProcess: host.process };
}

export function summarizeMemoryCheckpoints(checkpoints) {
  const initial = checkpoints.find(checkpoint => checkpoint.name === 'initial');
  const summary = {};
  for (const checkpoint of checkpoints) {
    const row = { naturalMedianRendererWorkingSetBytes: median(checkpoint.samples.map(sample => sample.rendererWorkingSetBytes)),
      naturalMedianRendererHeapUsedBytes: median(checkpoint.samples.map(sample => sample.rendererHeapUsedBytes)),
      postGcRendererHeapUsedBytes: checkpoint.postGc.rendererHeapUsedBytes,
      postGcDomNodes: checkpoint.postGc.dom.nodes };
    row.postGcHeapDeltaFromInitialBytes = initial ? row.postGcRendererHeapUsedBytes - initial.postGc.rendererHeapUsedBytes : null;
    summary[checkpoint.name] = row;
  }
  return summary;
}

export async function captureMemoryCheckpoint({ name, cdp, readHostMemory, measureMs, settleMs = MEMORY_SETTLE_MS }) {
  await pause(settleMs);
  const read = async () => {
    const [host, heap, dom] = await Promise.all([readHostMemory(), cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters')]);
    return { elapsedMs: performance.now() - measuredAt, ...projectRendererMemory({ host, heap, dom }) };
  };
  const samples = [];
  const measuredAt = performance.now();
  for (let index = 0; index < Math.ceil(measureMs / SAMPLE_INTERVAL_MS); index += 1) {
    samples.push(await read());
    await pause(Math.max(0, measuredAt + (index + 1) * SAMPLE_INTERVAL_MS - performance.now()));
  }
  await cdp.send('HeapProfiler.collectGarbage');
  const postGc = await read();
  for (const sample of [...samples, postGc]) {
    assert.equal(sample.rendererPid, samples[0].rendererPid, 'Renderer restarted during memory measurement');
    assert.equal(sample.rendererCreatedAt, samples[0].rendererCreatedAt, 'Renderer identity changed during memory measurement');
  }
  return { name, settleMs, measureMs, sampleIntervalMs: SAMPLE_INTERVAL_MS, samples, postGc,
    gcPolicy: 'natural samples first; one explicit CDP collection before the separate postGc sample' };
}

async function scrollHistoryTop(cdp, ui) {
  const event = await evaluate(cdp, `(() => {const e=document.querySelector('[data-scrollbar="chat"]');
    if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,deltaY:-e.scrollHeight,deltaX:0};})()`);
  assert.ok(event, 'Fixture transcript scroll surface is unavailable');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...event });
  await ui.waitExpression('history scroll reaches top', `document.querySelector('[data-scrollbar="chat"]')?.scrollTop <= 1`);
}

export async function loadOlderHistoryPage({ session, ui, fixture, messagePageRequestOffset }) {
  const before = fixture.getState().messagePageRequests;
  assert.ok(Number.isSafeInteger(messagePageRequestOffset) && messagePageRequestOffset >= 0
    && messagePageRequestOffset <= before.length, 'Older history requires an explicit UI page-request offset');
  const previousPages = before.slice(messagePageRequestOffset).filter(page => page.sessionID === session.id);
  const previousCoverage = historyCoverage(previousPages);
  assert.ok(previousCoverage > 0, 'Load Older requires this session’s initial UI page');
  await ui.click({ text: 'LOAD OLDER MESSAGES' });
  const page = await ui.waitFor('fresh contiguous older history page', () =>
    fixture.getState().messagePageRequests.slice(before.length).find(candidate => candidate.sessionID === session.id
      && candidate.before !== null && candidate.returned > 0
      && historyCoverage([...previousPages, candidate]) > previousCoverage));
  const coveredMessages = historyCoverage([...previousPages, page]);
  assert.ok(coveredMessages <= session.expectedMessages, 'Older page exceeds the prescribed history');
  // This single-message read supplies canonical text only; it never contributes
  // to the UI's page-coverage evidence or loads anything into the renderer.
  const response = await fetch(`${fixture.origin}/session/${session.id}/message/${page.firstMessageID}`,
    { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, 'The returned older-page first message is unavailable');
  const canonical = await response.json();
  assert.equal(canonical.info?.id, page.firstMessageID);
  assert.equal(canonical.info?.sessionID, session.id);
  const canonicalText = canonical.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.ok(canonicalText.trim(), 'Older-page canonical message text is empty');
  const selector = `[data-scrollbar="chat"] [data-message-id=${JSON.stringify(page.firstMessageID)}]`;
  await ui.reveal(selector, undefined, { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
  await ui.waitVisibleText(canonicalText, selector);
  await ui.waitExpression('older canonical row committed in selected session', `(() => {
    const row=document.querySelector(${JSON.stringify(selector)});
    return new URL(location.href).searchParams.get('session')===${JSON.stringify(session.id)}
      && row?.isConnected && row.innerText.includes(${JSON.stringify(canonicalText)});
  })()`);
  return { ...page, coveredMessages, canonicalText };
}

async function loadHistory({ session, cdp, ui, fixture }) {
  const messagePageRequestOffset = fixture.getState().messagePageRequests.length;
  await ui.click({ selector: `[data-session-row="${session.id}"] button`, text: session.title });
  await ui.waitExpression('owned session selected', `new URL(location.href).searchParams.get('session') === ${JSON.stringify(session.id)}`);
  await ui.waitVisibleText(`History response ${SESSION_MEMORY_FIXTURE.turns}.`, '[data-scrollbar="chat"]');
  let pageClicks = 0;
  const commits = [];
  while (pageClicks < 12) {
    await scrollHistoryTop(cdp, ui);
    const hasOlder = await evaluate(cdp, `[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='LOAD OLDER MESSAGES')`);
    if (!hasOlder) break;
    commits.push(await loadOlderHistoryPage({ session, ui, fixture, messagePageRequestOffset }));
    pageClicks += 1;
  }
  await scrollHistoryTop(cdp, ui);
  await ui.waitVisibleText('History response 1.', '[data-scrollbar="chat"]');
  const pages = fixture.getState().messagePageRequests.slice(messagePageRequestOffset).filter(page => page.sessionID === session.id);
  const coveredMessages = historyCoverage(pages);
  assert.equal(coveredMessages, session.expectedMessages, 'UI did not materialize the full prescribed history');
  return { ...session, pageClicks, coveredMessages, pages, commits, messagePageRequestOffset };
}

async function rowAction({ session, action, cdp, ui, acknowledged }) {
  const selector = `[data-session-row="${session.id}"]`;
  // The actual row context menu has no visible three-dot trigger.
  const point = await ui.waitExpression(`owned ${action} row settled`, `(async () => {
    const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;
    e.scrollIntoView({block:'nearest'});const before=e.getBoundingClientRect();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const r=e.getBoundingClientRect();if(!e.isConnected||Math.abs(r.y-before.y)>0.5||r.width<=0||r.height<=0)return null;
    const point={x:r.x+Math.min(60,r.width/2),y:r.y+r.height/2};
    return e.contains(document.elementFromPoint(point.x,point.y))?point:null;
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', clickCount: 1 });
  await ui.click({ selector: '[role="menuitem"]', text: action });
  // The normal private-profile setting may apply the action immediately.
  // Only confirm if the UI actually presents its optional confirmation dialog.
  const state = await ui.waitFor(`${action} confirmation or authoritative acknowledgement`, async () => {
    if (await evaluate(cdp, `Boolean(document.querySelector('[role="dialog"]'))`)) return 'dialog';
    return await acknowledged() ? 'acknowledged' : false;
  });
  if (state === 'dialog') {
    await ui.click({ selector: '[role="dialog"] button', text: action });
    await ui.waitExpression('confirmation dialog closed', `!document.querySelector('[role="dialog"]')`);
  }
  await ui.waitExpression('row context menu closed', `!document.querySelector('[role="menu"]')`);
}

async function captureDeletedCacheEvidence(cdp, ui, sessionIDs) {
  await ui.key('D', { code: 'KeyD', modifiers: process.platform === 'darwin' ? 12 : 10, windowsVirtualKeyCode: 68 });
  await ui.waitVisibleText('Debug Panel');
  let objectID;
  const remove = cdp.on('Runtime.consoleAPICalled', event => {
    if (event.args?.[0]?.value === '[DebugPanel] Session store state:') objectID = event.args[1]?.objectId;
  });
  try {
    await ui.click({ text: 'Log State' });
    await ui.waitFor('debug cache snapshot', () => objectID);
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: objectID, returnByValue: true,
      functionDeclaration: `function(ids) { return { currentSessionId: this.currentSessionId,
        cachedSessionCount: this.cachedSessions.length, ownedCachedSessions: this.cachedSessions.filter(id => ids.includes(id)) }; }`,
      arguments: [{ value: sessionIDs }] });
    assert.ok(!result.exceptionDetails && result.result?.value, 'Debug panel cache snapshot is unsupported');
    const snapshot = result.result.value;
    assert.deepEqual(snapshot.ownedCachedSessions, [], 'Deleted fixture sessions remain in the renderer message cache');
    return { ...snapshot, capturedAfterAllMemoryMeasurements: true };
  } finally {
    remove();
    if (objectID) await cdp.send('Runtime.releaseObject', { objectId: objectID });
    await cdp.send('Runtime.discardConsoleEntries');
    await ui.key('D', { code: 'KeyD', modifiers: process.platform === 'darwin' ? 12 : 10, windowsVirtualKeyCode: 68 });
  }
}

export async function runSessionMemoryScenario({ cdp, fixture, sessions, readHostMemory, measureMs, warmupMs, record, screenshot }) {
  const ui = createQaUiDriver(cdp);
  const evidence = { outcome: 'pending', fixture: SESSION_MEMORY_FIXTURE, checkpoints: [], loadedHistories: [],
    lifecycle: [], measurement: 'one renderer; natural windows and separately labeled forced-GC checkpoints',
    limitations: ['Inactive histories may remain cached; four sessions do not exceed the 40-session LRU.',
      'Heap and working-set differences alone do not establish a leak.', 'Fixture transport does not measure provider initialization or scheduling.'] };
  const checkpoint = async name => {
    const result = await captureMemoryCheckpoint({ name, cdp, readHostMemory, measureMs, settleMs: Math.max(MEMORY_SETTLE_MS, warmupMs) });
    const first = evidence.checkpoints[0]?.postGc;
    if (first) {
      assert.equal(result.postGc.rendererPid, first.rendererPid, 'Renderer changed between memory checkpoints');
      assert.equal(result.postGc.rendererCreatedAt, first.rendererCreatedAt, 'Renderer identity changed between checkpoints');
    }
    result.structure = await evaluate(cdp, `({ sessionID: new URL(location.href).searchParams.get('session'),
      mountedMessageRows: document.querySelectorAll('[data-message-id]').length })`);
    if (name !== 'loaded') {
      assert.equal(result.structure.sessionID, null, 'Memory checkpoint requires the empty draft');
      assert.equal(result.structure.mountedMessageRows, 0, 'Inactive fixture messages remain mounted');
    } else {
      // Recheck after the settle window and collection: shared-ID collisions
      // can remove cached parts after pagination initially rendered them.
      await ui.waitVisibleText('History response 1.', '[data-scrollbar="chat"]');
      result.structure.visibleHistoryText = 'History response 1.';
    }
    evidence.checkpoints.push(result);
    evidence.summary = summarizeMemoryCheckpoints(evidence.checkpoints);
    await record(evidence);
    await screenshot(`memory-${name}`);
  };
  const canonical = async session => {
    const response = await fetch(`${fixture.origin}/session/${session.id}`, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, session: response.ok ? await response.json() : null };
  };
  try {
    await ui.click({ label: 'New Chat' });
    await ui.waitExpression('initial empty draft', `!new URL(location.href).searchParams.get('session') && !document.querySelector('[data-message-id]')`);
    await checkpoint('initial');
    for (const session of sessions) evidence.loadedHistories.push(await loadHistory({ session, cdp, ui, fixture }));
    await checkpoint('loaded');
    await ui.click({ label: 'New Chat' });
    await ui.waitExpression('inactive histories unmounted', `!new URL(location.href).searchParams.get('session') && !document.querySelector('[data-message-id]')`);
    await checkpoint('inactive');
    for (const session of sessions) {
      await rowAction({ session, action: 'Archive', cdp, ui,
        acknowledged: async () => Boolean((await canonical(session)).session?.time?.archived) });
      await ui.waitFor('owned fixture archived', async () => Boolean((await canonical(session)).session?.time?.archived));
      evidence.lifecycle.push({ sessionID: session.id, action: 'archive', outcome: 'passed' });
    }
    if (await evaluate(cdp, `Boolean(document.querySelector('[aria-label="Expand Archived"]'))`)) {
      await ui.click({ label: 'Expand Archived' });
    } else {
      await ui.waitExpression('archived group expanded', `Boolean(document.querySelector('[aria-label="Collapse Archived"]'))`);
    }
    for (const session of sessions) {
      await rowAction({ session, action: 'Delete', cdp, ui,
        acknowledged: async () => (await canonical(session)).status === 404 });
      await ui.waitFor('owned fixture permanently deleted', async () => (await canonical(session)).status === 404);
      await ui.waitExpression('deleted row absent', `!document.querySelector('[data-session-row="${session.id}"]')`);
      evidence.lifecycle.push({ sessionID: session.id, action: 'delete', outcome: 'passed' });
    }
    await checkpoint('deleted');
    evidence.deletedCache = await captureDeletedCacheEvidence(cdp, ui, sessions.map(session => session.id));
    assert.equal(fixture.getState().receivedPrompts.length, 0, 'Memory scenario must not submit a prompt');
    evidence.outcome = 'passed';
    await record(evidence);
    return evidence;
  } catch (error) {
    evidence.outcome = 'failed';
    evidence.error = error.message;
    await record(evidence);
    throw error;
  }
}
