import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { evaluate } from '../qa/cdp.mjs';
import { createQaUiDriver } from '../qa/ui-driver.mjs';
import { assertStartupMode, historyCoverage, projectRendererMemory } from './electron-lifecycle-benchmark.mjs';
import { PERF_PARENT_SESSION_ID } from './loopback-opencode-fixture.mjs';

export const INTERACTIVE_PROTOCOL = Object.freeze({
  version: 2,
  historySessions: 2,
  historyTurns: 180,
  historyTextBytes: 256,
  typingText: 'Keep this unsent draft intact while another session streams.',
  typingIntervalMs: 75,
  switchCycles: 4,
  scrollEvents: 12,
  scrollDeltaPx: 320,
  disclosureCycles: 4,
  disclosureTextBytes: 768,
  disclosureMinimumMs: 16000,
  disclosureIntervalMs: 8100,
  disclosureChunks: 2,
  navigationCycles: 8,
  reconnectAdvanceChunks: 10,
  streamIntervalMs: 100,
  memorySampleIntervalMs: 500,
  comparisonMinimumWarmupMs: 5000,
  comparisonMinimumMeasureMs: 30000,
  eventTimingMinimumDurationMs: 16,
  actionTimeoutMs: 15000,
  maximumTraceBytes: 512 * 1024 * 1024,
  traceBufferKiB: 512 * 1024,
});

export const INTERACTIVE_TYPING_PROTOCOL = Object.freeze({
  version: 2,
  scope: 'typing',
  setup: 'one same-origin control-session navigation after completed startup; exact session and ready composer before and after typing',
  measurement: 'one fixed sequence of 60 trusted input events; no duration-based measurement window',
  typingText: INTERACTIVE_PROTOCOL.typingText,
  typingIntervalMs: INTERACTIVE_PROTOCOL.typingIntervalMs,
  historySessions: INTERACTIVE_PROTOCOL.historySessions,
  historyTurns: INTERACTIVE_PROTOCOL.historyTurns,
  historyTextBytes: INTERACTIVE_PROTOCOL.historyTextBytes,
  comparisonMinimumWarmupMs: INTERACTIVE_PROTOCOL.comparisonMinimumWarmupMs,
  eventTimingMinimumDurationMs: INTERACTIVE_PROTOCOL.eventTimingMinimumDurationMs,
  actionTimeoutMs: INTERACTIVE_PROTOCOL.actionTimeoutMs,
  maximumTraceBytes: INTERACTIVE_PROTOCOL.maximumTraceBytes,
  traceBufferKiB: INTERACTIVE_PROTOCOL.traceBufferKiB,
});

export function assertInteractiveScope(scope) {
  assert.ok(scope === 'full' || scope === 'typing', 'interactiveScope must be full or typing');
}

export function getInteractiveProtocol(scope = 'full') {
  assertInteractiveScope(scope);
  return scope === 'typing' ? INTERACTIVE_TYPING_PROTOCOL : INTERACTIVE_PROTOCOL;
}

export const INTERACTIVE_DISCLOSURE_TEXT = Array.from({ length: 12 }, (_, index) =>
  `${String(index + 1).padStart(2, '0')}: Preserve the exact unsent draft and the canonical history anchor.`,
).join(' ').slice(0, INTERACTIVE_PROTOCOL.disclosureTextBytes);

export function assertInteractiveDisclosureTurn(rows, userMessageID) {
  const assistants = rows.filter(row => row.info.role === 'assistant' && row.info.parentID === userMessageID);
  assert.equal(assistants.length, 1, 'Interactive disclosure must have one canonical response to the submitted user');
  const assistant = assistants[0];
  assert.ok(Number.isFinite(assistant.info.time?.completed) && !assistant.info.error,
    'Interactive disclosure response must have completed successfully');
  const parts = assistant.parts.filter(part => part.type === 'reasoning');
  assert.equal(parts.length, 1, 'Interactive disclosure must contain exactly one reasoning part');
  const reasoning = parts[0];
  assert.equal(reasoning.text, INTERACTIVE_DISCLOSURE_TEXT, 'Interactive canonical reasoning text changed');
  assert.ok(Number.isFinite(reasoning.time?.start) && Number.isFinite(reasoning.time?.end),
    'Interactive disclosure needs actual start and end timestamps');
  const durationMs = reasoning.time.end - reasoning.time.start;
  assert.ok(durationMs >= INTERACTIVE_PROTOCOL.disclosureMinimumMs,
    'Interactive disclosure did not actually last 16 seconds');
  assert.ok(assistant.info.time.completed >= reasoning.time.end,
    'Interactive response completed before its reasoning ended');
  return { assistant, evidence: { canonicalUserID: userMessageID, canonicalAssistantID: assistant.info.id,
    reasoningPartID: reasoning.id, durationMs, reasoningBytes: Buffer.byteLength(reasoning.text) } };
}

export const INTERACTIVE_PRIMARY_METRICS = Object.freeze({
  typing: 'trusted input event to exact draft value and two animation frames, ms',
  historyOpen: 'trusted sidebar click to the canonical newest history row and two animation frames, ms',
  pagination: 'trusted Load Older Messages click to committed history growth and two animation frames, ms',
  sessionSwitch: 'trusted sidebar click to the selected transcript or restored draft and two animation frames, ms',
  scroll: 'trusted wheel event to the changed scroll position and two animation frames, ms',
  disclosure: 'trusted reasoning disclosure click to its requested layout and two animation frames, ms',
  cancel: 'trusted Stop click to canonical idle, restored send control and two animation frames, ms',
  reconnect: 'fixture SSE disconnection to the next prescribed numbered text being render-ready, host-clock ms including CDP return',
  navigation: 'fixed New Chat, effort-menu open/Escape-close and session-click sequence, render-ready ms',
  navigationHeap: 'natural median renderer heap after minus before repeated navigation, bytes; no forced GC',
  navigationDom: 'natural median DOM nodes after minus before repeated navigation, nodes',
});

export function getInteractivePrimaryMetrics(scope = 'full') {
  assertInteractiveScope(scope);
  return scope === 'typing' ? { typing: INTERACTIVE_PRIMARY_METRICS.typing } : INTERACTIVE_PRIMARY_METRICS;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rowSelector = id => `[data-message-id=${JSON.stringify(id)}]`;
const selectedExpression = id => `new URL(location.href).searchParams.get('session') === ${JSON.stringify(id)}`;
const textValue = text => `document.querySelector('textarea')?.value === ${JSON.stringify(text)}`;
function isInteractiveElementVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  let top = Math.max(0, rect.top); let bottom = Math.min(innerHeight, rect.bottom);
  let left = Math.max(0, rect.left); let right = Math.min(innerWidth, rect.right);
  for (let parent = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) return false;
    const bounds = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
  }
  return bottom > top && right > left;
}
const visibleExpression = selector => `(${isInteractiveElementVisible.toString()})(document.querySelector(${JSON.stringify(selector)}))`;

export function findInteractiveHistoryTranscript(session, selectedSessionID, renderedMessages) {
  if (selectedSessionID !== session.id) return null;
  const canonical = new Map(session.assistants.map(item => [item.messageID, item.text]));
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  const matched = renderedMessages.find(item => {
    const expected = canonical.get(item.messageID);
    return item.visible === true && typeof expected === 'string' && normalize(expected).length > 0
      && normalize(item.text).includes(normalize(expected));
  });
  return matched ? { sessionID: session.id, messageID: matched.messageID, canonicalTextPresent: true } : null;
}
const historyTranscriptExpression = session => `(${findInteractiveHistoryTranscript.toString()})(${JSON.stringify(session)},
  new URL(location.href).searchParams.get('session'), [...document.querySelectorAll('[data-scrollbar="chat"] [data-message-id]')]
  .map(e=>({messageID:e.dataset.messageId,text:e.innerText,visible:(${isInteractiveElementVisible.toString()})(e)})))`;

export function distribution(values) {
  assert.ok(values.length && values.every(value => Number.isFinite(value) && value >= 0), 'Timing distribution needs finite nonnegative samples');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), minimum: sorted[0], maximum: sorted.at(-1) };
}

export function assertNumberedChunks(text) {
  const numbers = [...text.matchAll(/QA response chunk (\d+)\./g)].map(match => Number(match[1]));
  assert.ok(numbers.length, 'The canonical stream has no numbered chunks');
  numbers.forEach((number, index) => assert.equal(number, index + 1, 'The canonical stream lost or duplicated a numbered chunk'));
  return numbers.length;
}

export function assertUniqueTurnCounts(counts) {
  for (const key of ['canonicalUser', 'canonicalAssistant', 'renderedUser', 'renderedAssistant']) {
    assert.equal(counts[key], 1, `The cancelled turn must have exactly one ${key} row`);
  }
  return true;
}

export function summarizeInteractiveActions(actions, scope = 'full') {
  assertInteractiveScope(scope);
  if (scope === 'typing') {
    assert.equal(actions.length, INTERACTIVE_PROTOCOL.typingText.length, 'Typing scope requires exactly 60 input actions');
    assert.ok(actions.every(action => action.group === 'typing' && action.outcome === 'passed' && action.trustedEvent === true),
      'Typing scope requires every input action to be trusted and passed');
    assert.equal(new Set(actions.map(action => action.id)).size, actions.length, 'Typing scope requires distinct input actions');
    return { typing: distribution(actions.map(action => action.latencyMs)) };
  }
  const required = { typing: INTERACTIVE_PROTOCOL.typingText.length, historyOpen: 2,
    sessionSwitch: INTERACTIVE_PROTOCOL.switchCycles * 4, scroll: INTERACTIVE_PROTOCOL.scrollEvents,
    disclosure: INTERACTIVE_PROTOCOL.disclosureCycles * 2, cancel: 1, reconnect: 1,
    navigation: INTERACTIVE_PROTOCOL.navigationCycles * 5 };
  const summary = {};
  for (const name of Object.keys(INTERACTIVE_PRIMARY_METRICS).filter(name => !name.startsWith('navigationH') && name !== 'navigationDom')) {
    const samples = actions.filter(action => action.group === name);
    if (name === 'pagination') assert.ok(samples.length >= 2, 'Both histories require measured pagination');
    else assert.equal(samples.length, required[name], `Incomplete interactive action group: ${name}`);
    assert.ok(samples.every(action => action.outcome === 'passed'), `An interactive action failed: ${name}`);
    summary[name] = distribution(samples.map(action => action.latencyMs));
  }
  return summary;
}

// Runs only in the owned renderer through CDP. Timing starts at a trusted DOM
// event, after the driver's control-discovery work. Two rAFs are a render-ready
// approximation, not evidence of actual compositor presentation. Event Timing
// remains a separate browser-provided dataset, including its 16 ms threshold.
export function createInteractiveProbe(options) {
  const actions = [];
  const eventTiming = [];
  const longTasks = [];
  const frames = [];
  const observers = [];
  const jobs = new Map();
  const pending = new Set();
  const phases = [{ name: 'setup', startedAt: performance.now() }];
  const support = { longtask: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    event: PerformanceObserver.supportedEntryTypes.includes('event') };
  let nextID = 0;
  let active = null;
  let typingSeries = null;
  let frameID;
  let lastFrame;
  let overflow = false;
  const phaseAt = time => phases.findLast(phase => phase.startedAt <= time)?.name ?? 'setup';
  const push = (array, value, maximum) => { if (array.length >= maximum) overflow = true; else array.push(value); };
  const observe = (type, receiver) => {
    if (!support[type]) return;
    const observer = new PerformanceObserver(list => receiver(list.getEntries()));
    observer.observe({ type, buffered: false, ...(type === 'event' ? { durationThreshold: options.eventTimingMinimumDurationMs } : {}) });
    observers.push(observer);
  };
  observe('longtask', entries => entries.forEach(entry => push(longTasks,
    { startTime: entry.startTime, duration: entry.duration, phase: phaseAt(entry.startTime) }, 10000)));
  observe('event', entries => entries.forEach(entry => push(eventTiming, { name: entry.name,
    startTime: entry.startTime, duration: entry.duration, processingStart: entry.processingStart,
    processingEnd: entry.processingEnd, interactionId: entry.interactionId, phase: phaseAt(entry.startTime) }, 10000)));
  const frame = time => {
    if (lastFrame !== undefined) push(frames, { startTime: lastFrame, duration: time - lastFrame, phase: phaseAt(lastFrame) }, 100000);
    lastFrame = time;
    frameID = requestAnimationFrame(frame);
  };
  frameID = requestAnimationFrame(frame);
  const finish = (job, result) => {
    if (!pending.has(job)) return;
    clearTimeout(job.timer);
    pending.delete(job);
    if (active === job) active = null;
    const value = { id: job.id, group: job.group, action: job.action, ...result };
    push(actions, value, 5000);
    job.resolve(value);
  };
  const check = async job => {
    if (!pending.has(job)) return;
    try {
      if (!await job.condition()) { requestAnimationFrame(() => check(job)); return; }
      requestAnimationFrame(() => requestAnimationFrame(async () => {
        if (!pending.has(job)) return;
        try {
          if (!await job.condition()) { requestAnimationFrame(() => check(job)); return; }
          const endedAt = performance.now();
          finish(job, { outcome: 'passed', startedAt: job.startedAt, endedAt,
            latencyMs: endedAt - job.startedAt, trustedEvent: job.trustedEvent });
        } catch (error) { finish(job, { outcome: 'failed', error: String(error) }); }
      }));
    } catch (error) { finish(job, { outcome: 'failed', error: String(error) }); }
  };
  const begin = (job, timestamp, trustedEvent) => {
    if (job.startedAt !== undefined) return;
    job.startedAt = timestamp;
    job.trustedEvent = trustedEvent;
    requestAnimationFrame(() => check(job));
  };
  const makeJob = input => {
    const job = { ...input, id: ++nextID };
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    jobs.set(job.id, job);
    pending.add(job);
    job.timer = setTimeout(() => finish(job, { outcome: 'failed', error: 'Interactive event or rendered condition timed out' }), options.actionTimeoutMs);
    return job;
  };
  const eventClockSupported = event => Number.isFinite(event.timeStamp) && event.timeStamp <= performance.now() + 1
    && performance.now() - event.timeStamp <= options.actionTimeoutMs;
  const onEvent = event => {
    if (typingSeries && event.isTrusted && event.type === 'input' && event.target?.closest?.('textarea')) {
      const index = typingSeries.jobs.length;
      const prefix = typingSeries.text.slice(0, index + 1);
      const target = event.target;
      const job = makeJob({ group: 'typing', action: `character ${index + 1}`, condition: () => target.isConnected && target.value.startsWith(prefix) });
      typingSeries.jobs.push(job);
      if (index >= typingSeries.text.length || target.value !== prefix || !eventClockSupported(event)) {
        finish(job, { outcome: 'failed', error: 'Fixed-cadence input event did not match the prescribed draft' });
      } else begin(job, event.timeStamp, true);
      return;
    }
    if (!active || !event.isTrusted || active.event !== event.type || !event.target?.closest?.(active.selector)) return;
    const timestamp = event.timeStamp;
    if (!eventClockSupported(event)) {
      finish(active, { outcome: 'failed', error: 'Unsupported DOM event clock' });
      return;
    }
    begin(active, timestamp, true);
  };
  for (const name of ['input', 'click', 'keydown', 'wheel']) document.addEventListener(name, onEvent, true);
  return {
    support,
    phase: name => { phases.push({ name, startedAt: performance.now() }); },
    arm: ({ group, action, event, selector, condition }) => {
      if (active || typingSeries) throw Error('Interactive action already pending');
      const job = makeJob({ group, action, event, selector, condition: new Function(`return (${condition})`) });
      active = job;
      return job.id;
    },
    beginTyping: text => { if (active || typingSeries) throw Error('Interactive action already pending'); typingSeries = { text, jobs: [] }; },
    finishTyping: async () => {
      if (!typingSeries || typingSeries.jobs.length !== typingSeries.text.length) throw Error('Fixed-cadence input event count is incomplete');
      const results = await Promise.all(typingSeries.jobs.map(job => job.promise));
      typingSeries.jobs.forEach(job => jobs.delete(job.id));
      typingSeries = null;
      return results;
    },
    start: id => { const job = jobs.get(id); if (active !== job || job.event !== 'manual') throw Error('Invalid manual timing action'); begin(job, performance.now(), false); },
    wait: async id => { const job = jobs.get(id); if (!job) throw Error('Unknown timing action'); const result = await job.promise; jobs.delete(id); return result; },
    snapshot: () => ({ support, actions, eventTiming, longTasks, frames, phases, overflow, pending: pending.size > 0 || typingSeries !== null }),
    close: () => {
      cancelAnimationFrame(frameID);
      observers.forEach(observer => observer.disconnect());
      for (const name of ['input', 'click', 'keydown', 'wheel']) document.removeEventListener(name, onEvent, true);
      for (const job of pending) finish(job, { outcome: 'failed', error: 'Interactive probe closed with a pending action' });
      typingSeries = null;
    },
  };
}

export async function prepareInteractiveSessions(fixture) {
  const histories = [];
  let control;
  for (let index = 0; index < INTERACTIVE_PROTOCOL.historySessions + 1; index++) {
    const title = index < INTERACTIVE_PROTOCOL.historySessions ? `Interactive history ${index + 1}` : 'Interactive controls';
    const response = await fetch(`${fixture.origin}/session`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.match(session.id, /^ses_[a-zA-Z0-9]+$/);
    if (index === INTERACTIVE_PROTOCOL.historySessions) { control = { id: session.id, title }; break; }
    fixture.seedHistory(session.id, { turns: INTERACTIVE_PROTOCOL.historyTurns, textBytes: INTERACTIVE_PROTOCOL.historyTextBytes });
    const rows = await (await fetch(`${fixture.origin}/session/${session.id}/message`, { signal: AbortSignal.timeout(5000) })).json();
    const assistants = rows.filter(row => row.info.role === 'assistant').map(row => ({ messageID: row.info.id,
      text: row.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') }));
    assert.equal(assistants.length, INTERACTIVE_PROTOCOL.historyTurns);
    histories.push({ id: session.id, title, expectedMessages: INTERACTIVE_PROTOCOL.historyTurns * 2,
      assistants, firstAssistantID: assistants[0].messageID, lastAssistantID: assistants.at(-1).messageID });
  }
  // The preceding direct reads establish canonical IDs only. They must never
  // count as evidence that the UI fetched or paginated those histories.
  return { histories, control, messagePageRequestOffset: fixture.getState().messagePageRequests.length };
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function naturalMemoryWindow({ cdp, readHostMemory, measureMs, settleMs }) {
  await pause(settleMs);
  const samples = [];
  const started = performance.now();
  for (let index = 0; index < Math.max(2, Math.ceil(measureMs / INTERACTIVE_PROTOCOL.memorySampleIntervalMs)); index++) {
    const [host, heap, dom] = await Promise.all([readHostMemory(), cdp.send('Runtime.getHeapUsage'), cdp.send('Memory.getDOMCounters')]);
    samples.push(projectRendererMemory({ host, heap, dom }));
    await pause(Math.max(0, started + (index + 1) * INTERACTIVE_PROTOCOL.memorySampleIntervalMs - performance.now()));
  }
  return { gcPolicy: 'natural; no explicit collection', settleMs, measureMs, samples,
    heapMedianBytes: median(samples.map(sample => sample.rendererHeapUsedBytes)),
    domNodesMedian: median(samples.map(sample => sample.dom.nodes)),
    workingSetMedianBytes: median(samples.map(sample => sample.rendererWorkingSetBytes)) };
}

export async function saveInteractiveTrace({ cdp, handle, filename, maximumBytes = INTERACTIVE_PROTOCOL.maximumTraceBytes }) {
  assert.ok(typeof handle === 'string' && handle, 'Chromium did not return a trace stream');
  assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes > 0, 'Invalid trace byte limit');
  let uncompressedBytes = 0;
  let chunks = 0;
  async function* readChunks() {
    try {
      for (;;) {
        const result = await cdp.send('IO.read', { handle, size: 1024 * 1024 });
        assert.equal(typeof result.data, 'string', 'Chromium trace chunk is missing');
        const bytes = Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8');
        uncompressedBytes += bytes.length;
        chunks += 1;
        assert.ok(uncompressedBytes <= maximumBytes, 'Chromium trace exceeded the bounded byte limit');
        assert.ok(result.eof || bytes.length > 0, 'Chromium returned an empty unfinished trace chunk');
        if (bytes.length) yield bytes;
        if (result.eof) break;
      }
    } finally {
      await cdp.send('IO.close', { handle });
    }
  }
  // CDP and gzip backpressure keep only bounded chunks in Node; tracing stays
  // in Chromium until measurement ends. Never retain millions of JS events.
  await pipeline(Readable.from(readChunks()), createGzip(), createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
  return { filename, format: 'Chromium JSON through a bounded CDP stream', chunks, uncompressedBytes,
    compressedBytes: (await stat(filename)).size, maximumBytes };
}

const typingControlReadyExpression = (session, url) => `(() => {
  const composer=document.querySelector('textarea');
  if(location.href!==${JSON.stringify(url)} || !(${selectedExpression(session.id)}) || document.readyState!=='complete'
    || !composer?.isConnected || composer.disabled || !(${isInteractiveElementVisible.toString()})(composer)
    || document.querySelector('[data-message-id]')) return false;
  return {sessionID:${JSON.stringify(session.id)},href:location.href,composerReady:true};
})()`;

export async function prepareInteractiveControl({ cdp, ui, session, origin, interactiveScope = 'full' }) {
  if (interactiveScope === 'typing') {
    const url = new URL('/', origin);
    url.searchParams.set('session', session.id);
    assert.equal(await evaluate(cdp, 'location.origin'), url.origin, 'Typing setup must remain on the observed app origin');
    const navigation = await cdp.send('Page.navigate', { url: url.href });
    assert.ok(!navigation.errorText, `Typing control navigation failed: ${navigation.errorText}`);
    const ready = await ui.waitExpression('typing control session and composer ready', typingControlReadyExpression(session, url.href));
    return { ...ready, method: 'Page.navigate', navigation };
  }
  await ui.click({ selector: `[data-session-row="${session.id}"] button`, text: session.title });
  await ui.waitExpression('interactive canonical session selected', selectedExpression(session.id));
  await ui.waitExpression('interactive composer mounted', `Boolean(document.querySelector('textarea'))`);
}

export async function runInteractiveScenario({ cdp, fixture, sessions, origin, readHostMemory, measureMs, warmupMs, record, screenshot, traceFilename,
  interactiveScope = 'full' }) {
  assertInteractiveScope(interactiveScope);
  const ui = createQaUiDriver(cdp);
  const evidence = { outcome: 'pending', interactiveScope, protocol: getInteractiveProtocol(interactiveScope),
    primaryMetrics: getInteractivePrimaryMetrics(interactiveScope),
    actions: [], ...(interactiveScope === 'full' ? { histories: [] } : {}), correctness: {}, sessions, limitations: [
      'Two animation frames measure render-ready latency, not compositor presentation or exact input-to-paint.',
      'Chromium Event Timing is separate and omits entries below its configured 16 ms duration threshold.',
      ...(interactiveScope === 'full' ? [
        'Reconnect uses the host clock and includes the final CDP response; cancellation polls the canonical endpoint inside the renderer.',
        'Natural heap and DOM growth alone do not establish a leak. No provider or scheduler work is simulated.',
      ] : ['Only the fixed typing sequence is measured; histories remain unopened and navigation/retention are not measured.']),
    ] };
  let probeInstalled = false;
  let tracing = false;
  let maximumTraceBufferUsage = 0;
  const removeBufferUsage = cdp.on('Tracing.bufferUsage', ({ percentFull, value }) => {
    const usage = percentFull ?? value;
    if (Number.isFinite(usage)) maximumTraceBufferUsage = Math.max(maximumTraceBufferUsage, usage);
  });
  const api = async route => {
    const response = await fetch(`${fixture.origin}${route}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `Fixture canonical endpoint failed: ${route}`);
    return response.json();
  };
  const phase = async name => {
    evidence.phase = name;
    await evaluate(cdp, `window.__devryanInteractiveProbe.phase(${JSON.stringify(name)})`);
    await record(evidence);
  };
  const measure = async ({ group, action, event = 'click', selector, condition }, perform) => {
    const id = await evaluate(cdp, `window.__devryanInteractiveProbe.arm(${JSON.stringify({ group, action, event, selector, condition })})`);
    let hostStarted;
    if (event === 'manual') {
      await evaluate(cdp, `window.__devryanInteractiveProbe.start(${id})`);
      hostStarted = performance.now();
    }
    await perform();
    const result = await evaluate(cdp, `window.__devryanInteractiveProbe.wait(${id})`);
    if (event === 'manual') { result.rendererRenderReadyMs = result.latencyMs; result.latencyMs = performance.now() - hostStarted; result.clock = 'host with CDP return'; }
    evidence.actions.push(result);
    assert.equal(result.outcome, 'passed', `${group}/${action}: ${result.error ?? 'rendered condition failed'}`);
    return result;
  };
  const clickSession = (session, group, condition) => measure({ group, action: session.title,
    selector: `[data-session-row="${session.id}"] button`, condition: `(${selectedExpression(session.id)}) && (${condition})` },
  () => ui.click({ selector: `[data-session-row="${session.id}"] button`, text: session.title }));
  const clickHistory = async (session, group) => {
    const condition = historyTranscriptExpression(session);
    let action;
    try { action = await clickSession(session, group, condition); }
    catch (error) {
      evidence.historySwitchFailure = await evaluate(cdp, `(() => {
        const nodes=[...document.querySelectorAll('[data-message-id]')];
        return {selectedSessionID:new URL(location.href).searchParams.get('session'),expectedSessionID:${JSON.stringify(session.id)},
          nodeCount:nodes.length,inChatCount:document.querySelectorAll('[data-scrollbar="chat"] [data-message-id]').length,
          rendered:nodes.slice(-40).map(e=>({messageID:e.dataset.messageId,text:e.innerText.slice(0,1024),textLength:e.innerText.length,
            textContent:e.textContent.slice(0,1024),html:e.outerHTML.slice(0,4096),
            textTruncated:e.innerText.length>1024,inChat:Boolean(e.closest('[data-scrollbar="chat"]')),
            visible:(${isInteractiveElementVisible.toString()})(e),rect:e.getBoundingClientRect().toJSON(),
            ancestors:(()=>{const result=[];for(let p=e;p&&result.length<16;p=p.parentElement){const s=getComputedStyle(p);
              result.push({tag:p.tagName,scrollbar:p.dataset.scrollbar??null,opacity:s.opacity,display:s.display,visibility:s.visibility,
                overflowX:s.overflowX,overflowY:s.overflowY,rect:p.getBoundingClientRect().toJSON()});}return result;})()}))};
      })()`).catch(diagnosticError => ({ captureError: diagnosticError.message, originalError: error.message }));
      const visibleIDs = new Set(evidence.historySwitchFailure.rendered?.filter(item => item.visible).map(item => item.messageID));
      evidence.historySwitchFailure.canonicalReads = await Promise.all(session.assistants.filter(item => visibleIDs.has(item.messageID)).slice(-2).map(async item => {
        const route = `/session/${session.id}/message/${item.messageID}`;
        const fixtureRow = await api(route);
        const app = await evaluate(cdp, `fetch(${JSON.stringify(`/api${route}`)}).then(async r=>({status:r.status,row:await r.json()}))`);
        const project = row => ({ messageID: row?.info?.id ?? null, texts: row?.parts?.filter(part => part.type === 'text').map(part => part.text) ?? [] });
        return { expected: item, fixture: project(fixtureRow), app: { status: app.status, ...project(app.row) } };
      })).catch(diagnosticError => [{ captureError: diagnosticError.message }]);
      evidence.historySwitchFailure.appList = await evaluate(cdp, `fetch(${JSON.stringify(`/api/session/${session.id}/message?limit=50`)})
        .then(async r=>({status:r.status,rows:(await r.json()).filter(row=>${JSON.stringify([...visibleIDs])}.includes(row.info?.id))
          .map(row=>({messageID:row.info.id,texts:row.parts.filter(p=>p.type==='text').map(p=>p.text)}))}))`)
        .catch(diagnosticError => ({ captureError: diagnosticError.message }));
      evidence.historySwitchFailure.debugAssistant = await evaluate(cdp, `(() => {const row=window.__opencodeDebug?.getLastAssistantMessage?.();
        return row?{messageId:row.messageId,parts:row.parts}: {unavailable:true};})()`)
        .catch(diagnosticError => ({ captureError: diagnosticError.message }));
      throw error;
    }
    const rendered = await evaluate(cdp, condition);
    assert.ok(rendered, 'The selected history lost its visible canonical transcript');
    evidence.historySwitches ??= [];
    evidence.historySwitches.push({ actionID: action.id, group, ...rendered });
  };
  const selectUnmeasured = async session => {
    await ui.click({ selector: `[data-session-row="${session.id}"] button`, text: session.title });
    await ui.waitExpression('interactive canonical session selected', selectedExpression(session.id));
    await ui.waitExpression('interactive composer mounted', `Boolean(document.querySelector('textarea'))`);
  };
  const wheel = async deltaY => {
    const geometry = await evaluate(cdp, `(() => { const e=document.querySelector('[data-scrollbar="chat"]');if(!e)return null;
      const r=e.getBoundingClientRect();return {x:r.left+8,y:r.top+r.height/2,deltaX:0,deltaY:${deltaY}}; })()`);
    assert.ok(geometry, 'Interactive transcript scroll surface is unavailable');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...geometry });
  };
  const scrollTop = async () => {
    await wheel(-10000000);
    await ui.waitExpression('interactive older-history edge', `document.querySelector('[data-scrollbar="chat"]')?.scrollTop <= 1`);
  };
  const acceptedSend = async text => {
    const count = fixture.getState().receivedPrompts.length;
    await ui.send(text);
    const accepted = await ui.waitFor('interactive canonical prompt acknowledgement', () => fixture.getState().receivedPrompts[count]);
    assert.equal(accepted.sessionID, sessions.control.id);
    return accepted;
  };
  try {
    const setup = await prepareInteractiveControl({ cdp, ui, session: sessions.control, origin, interactiveScope });
    if (interactiveScope === 'typing') evidence.controlNavigation = setup;
    await ui.type('');
    await evaluate(cdp, `window.__devryanInteractiveProbe=(${createInteractiveProbe.toString()})(${JSON.stringify(INTERACTIVE_PROTOCOL)})`);
    probeInstalled = true;
    await record(evidence);
    await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none',
      bufferUsageReportingInterval: 1000, traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: INTERACTIVE_PROTOCOL.traceBufferKiB,
        includedCategories: ['devtools.timeline', 'blink', 'cc', 'gpu', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame'] } });
    tracing = true;
    await pause(warmupMs);
    await phase('typing while another session streams');
    fixture.startScenario('one-stream');
    await ui.waitFor('background fixture stream advancing', () => fixture.getState().textLengths[PERF_PARENT_SESSION_ID] > 100);
    const typingBackgroundBefore = interactiveScope === 'typing' ? fixture.getState().textLengths[PERF_PARENT_SESSION_ID] : null;
    const initialPrompts = fixture.getState().receivedPrompts.length;
    if (interactiveScope === 'typing') {
      evidence.correctness.typingSelectionBefore = await evaluate(cdp, typingControlReadyExpression(sessions.control, evidence.controlNavigation.href));
      assert.ok(evidence.correctness.typingSelectionBefore, 'Typing control changed before inputs');
    }
    await evaluate(cdp, `window.__devryanInteractiveProbe.beginTyping(${JSON.stringify(INTERACTIVE_PROTOCOL.typingText)})`);
    const typingStarted = performance.now();
    evidence.typingDispatch = [];
    for (let index = 0; index < INTERACTIVE_PROTOCOL.typingText.length; index++) {
      await pause(Math.max(0, typingStarted + index * INTERACTIVE_PROTOCOL.typingIntervalMs - performance.now()));
      const dispatchedAtMs = performance.now() - typingStarted;
      evidence.typingDispatch.push({ character: index + 1, scheduledAtMs: index * INTERACTIVE_PROTOCOL.typingIntervalMs,
        dispatchedAtMs, latenessMs: dispatchedAtMs - index * INTERACTIVE_PROTOCOL.typingIntervalMs });
      await cdp.send('Input.insertText', { text: INTERACTIVE_PROTOCOL.typingText[index] });
    }
    const typing = await evaluate(cdp, 'window.__devryanInteractiveProbe.finishTyping()');
    evidence.actions.push(...typing);
    assert.ok(typing.every(action => action.outcome === 'passed'), 'Fixed-cadence typing failed to preserve its input events');
    assert.equal(fixture.getState().receivedPrompts.length, initialPrompts, 'Typing submitted the unsent draft');
    evidence.correctness.typingDraft = await evaluate(cdp, textValue(INTERACTIVE_PROTOCOL.typingText));
    assert.equal(evidence.correctness.typingDraft, true);
    if (interactiveScope === 'typing') {
      evidence.correctness.typingSelectionAfter = await evaluate(cdp, typingControlReadyExpression(sessions.control, evidence.controlNavigation.href));
      assert.ok(evidence.correctness.typingSelectionAfter, 'Typing control changed after inputs');
      const state = fixture.getState();
      assert.equal(initialPrompts, 0, 'Typing scope must begin without submitted prompts');
      assert.equal(state.activeScenario, 'one-stream', 'The background stream stopped during typing');
      assert.ok(state.textLengths[PERF_PARENT_SESSION_ID] > typingBackgroundBefore, 'The background stream did not advance during typing');
      assert.equal(state.activePrompts, 0, 'Typing scope must not leave an active prompt');
      evidence.correctness.typingNoSubmit = true;
      evidence.correctness.typingBackground = { sessionID: PERF_PARENT_SESSION_ID,
        beforeTextLength: typingBackgroundBefore, afterTextLength: state.textLengths[PERF_PARENT_SESSION_ID], activeScenario: state.activeScenario };
    }
    await screenshot('interactive-typing-background');
    fixture.stopScenario();

    if (interactiveScope === 'full') {
      await phase('history opening and pagination');
      for (const session of sessions.histories) {
        await clickSession(session, 'historyOpen', visibleExpression(rowSelector(session.lastAssistantID)));
        const pages = [];
        const historyEvidence = { ...session, pages, requests: [] };
        evidence.histories.push(historyEvidence);
        for (let index = 0; index < 12; index++) {
          await scrollTop();
          if (!await evaluate(cdp, `[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='LOAD OLDER MESSAGES')`)) break;
          const anchor = await evaluate(cdp, `(() => {const s=document.querySelector('[data-scrollbar="chat"]'),b=s.getBoundingClientRect();
            const e=[...s.querySelectorAll('[data-message-id]')].find(e=>e.getBoundingClientRect().top>=b.top&&e.getBoundingClientRect().top<b.bottom);
            return e?{id:e.dataset.messageId,top:e.getBoundingClientRect().top-b.top,height:s.scrollHeight,virtualized:Boolean(s.querySelector('[data-turn-entry][data-index]'))}:null;})()`);
          assert.ok(anchor, 'Pagination requires a visible canonical anchor');
          await measure({ group: 'pagination', action: `${session.title} page ${index + 1}`, selector: 'button',
            condition: `document.querySelector('[data-scrollbar="chat"]').scrollHeight>${anchor.height} && Boolean(document.querySelector(${JSON.stringify(rowSelector(anchor.id))}))` },
          () => ui.click({ text: 'LOAD OLDER MESSAGES' }));
          const result = await evaluate(cdp, `(() => {const s=document.querySelector('[data-scrollbar="chat"]'),e=s.querySelector(${JSON.stringify(rowSelector(anchor.id))});
            return {shiftPx:e?e.getBoundingClientRect().top-s.getBoundingClientRect().top-${anchor.top}:null,
              virtualized:Boolean(s.querySelector('[data-turn-entry][data-index]'))};})()`);
          pages.push({ anchorID: anchor.id, anchorTop: anchor.top, previousHeight: anchor.height, beforeVirtualized: anchor.virtualized, ...result });
          historyEvidence.requests = fixture.getState().messagePageRequests.slice(sessions.messagePageRequestOffset).filter(page => page.sessionID === session.id);
          if (result.shiftPx === null || Math.abs(result.shiftPx) > 2) {
            historyEvidence.failureLayout = await evaluate(cdp, `(() => {const s=document.querySelector('[data-scrollbar="chat"]');return {
              scrollTop:s.scrollTop,scrollHeight:s.scrollHeight,clientHeight:s.clientHeight,
              loadOlderPresent:[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='LOAD OLDER MESSAGES')};})()`);
          }
          assert.ok(result.shiftPx !== null && Math.abs(result.shiftPx) <= 2, `History anchor moved by ${result.shiftPx}px`);
        }
        await scrollTop();
        await ui.waitVisibleText('History response 1.', '[data-scrollbar="chat"]');
        const requests = fixture.getState().messagePageRequests.slice(sessions.messagePageRequestOffset).filter(page => page.sessionID === session.id);
        assert.equal(historyCoverage(requests), session.expectedMessages, 'Interactive history coverage is incomplete');
        assert.ok(pages.some(page => !page.beforeVirtualized && page.virtualized), 'Pagination must cross the rendered virtualization boundary');
        historyEvidence.requests = requests;
      }
      await screenshot('interactive-history-paginated');

      await phase('session switching restores the unsent draft');
      for (let index = 0; index < INTERACTIVE_PROTOCOL.switchCycles; index++) {
        for (const session of sessions.histories) {
          await clickHistory(session, 'sessionSwitch');
          await clickSession(sessions.control, 'sessionSwitch', `${textValue(INTERACTIVE_PROTOCOL.typingText)} && !document.querySelector('[data-message-id]')`);
        }
      }
      evidence.correctness.restoredDraft = true;

      await phase('fixed scrolling sequence');
      await selectUnmeasured(sessions.histories[0]);
      await scrollTop();
      evidence.scrollPositions = [];
      for (let index = 0; index < INTERACTIVE_PROTOCOL.scrollEvents; index++) {
        const before = await evaluate(cdp, `document.querySelector('[data-scrollbar="chat"]').scrollTop`);
        const delta = index % 2 === 0 ? INTERACTIVE_PROTOCOL.scrollDeltaPx : -INTERACTIVE_PROTOCOL.scrollDeltaPx;
        await measure({ group: 'scroll', action: `wheel ${index + 1}`, event: 'wheel', selector: '[data-scrollbar="chat"]',
          condition: `document.querySelector('[data-scrollbar="chat"]').scrollTop ${delta > 0 ? '>' : '<'} ${before + (delta > 0 ? 1 : -1)}` }, () => wheel(delta));
        const position = await evaluate(cdp, `(() => {const e=document.querySelector('[data-scrollbar="chat"]');return {
          top:e.scrollTop,maximum:e.scrollHeight-e.clientHeight};})()`);
        assert.ok(position.top >= 0 && position.top <= position.maximum + 1, 'Scroll moved outside the transcript bounds');
        evidence.scrollPositions.push({ before, wheelDelta: delta, ...position });
      }

      await phase('reasoning disclosure');
      await selectUnmeasured(sessions.control);
      await ui.type('');
      fixture.configureNextPrompt(sessions.control.id, { reasoning: 'text', reasoningText: INTERACTIVE_DISCLOSURE_TEXT,
        tool: 'completed', chunks: INTERACTIVE_PROTOCOL.disclosureChunks, intervalMs: INTERACTIVE_PROTOCOL.disclosureIntervalMs });
      const disclosureSent = await acceptedSend('Interactive fixture disclosure turn.');
      await ui.waitFor('interactive disclosure turn idle', async () => (await api('/session/status'))[sessions.control.id]?.type === 'idle');
      const disclosureRows = await api(`/session/${sessions.control.id}/message`);
      const disclosureTurn = assertInteractiveDisclosureTurn(disclosureRows, disclosureSent.messageID);
      const disclosureAssistant = disclosureTurn.assistant;
      evidence.correctness.disclosure = disclosureTurn.evidence;
      const trigger = `${rowSelector(disclosureAssistant.info.id)} [data-reasoning-group][data-reasoning-disclosure-active="false"] button`;
      const content = `${rowSelector(disclosureAssistant.info.id)} [data-reasoning-disclosure-content]`;
      await ui.waitExpression('completed reasoning disclosure', `Boolean(document.querySelector(${JSON.stringify(trigger)}))`);
      if (await evaluate(cdp, `document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded')==='true'`)) {
        await ui.click({ selector: trigger });
        await ui.waitExpression('reasoning initially closed', `document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded')==='false'`);
      }
      for (let cycle = 0; cycle < INTERACTIVE_PROTOCOL.disclosureCycles; cycle++) {
        for (const open of [true, false]) {
          await ui.reveal(trigger, undefined, { scrollContainer: '[data-scrollbar="chat"]', direction: 'down' });
          await measure({ group: 'disclosure', action: `${open ? 'open' : 'close'} ${cycle + 1}`, selector: trigger,
            condition: `document.querySelector(${JSON.stringify(trigger)})?.getAttribute('aria-expanded')===${JSON.stringify(String(open))}
              && (()=>{const e=document.querySelector(${JSON.stringify(content)});return ${open ? 'e && e.getBoundingClientRect().height>=e.scrollHeight-1 && e.getBoundingClientRect().height>0' : '!e || e.getBoundingClientRect().height<1'};})()` },
          () => ui.click({ selector: trigger }));
        }
      }

      await phase('SSE reconnect and canonical cancellation');
      fixture.configureNextPrompt(sessions.control.id, { chunks: 1000, intervalMs: INTERACTIVE_PROTOCOL.streamIntervalMs });
      const sent = await acceptedSend('Interactive fixture reconnect and cancel turn.');
      const streamAssistant = (await api(`/session/${sessions.control.id}/message`)).at(-1);
      const assistantSelector = rowSelector(streamAssistant.info.id);
      await ui.waitVisibleText('QA response chunk 1.', assistantSelector);
      const beforeDisconnect = (await api(`/session/${sessions.control.id}/message`)).at(-1);
      assert.equal(beforeDisconnect.info.id, streamAssistant.info.id);
      const beforeText = beforeDisconnect.parts.find(part => part.type === 'text').text;
      const targetChunk = assertNumberedChunks(beforeText) + INTERACTIVE_PROTOCOL.reconnectAdvanceChunks;
      await measure({ group: 'reconnect', action: `resume by numbered chunk ${targetChunk}`, event: 'manual', selector: 'body',
        condition: `document.querySelector(${JSON.stringify(assistantSelector)})?.innerText.includes(${JSON.stringify(`QA response chunk ${targetChunk}.`)})` },
      () => fixture.disconnectEvents());
      const statusUrl = `${origin}/api/session/status`;
      await measure({ group: 'cancel', action: 'Stop to canonical idle', selector: 'button[aria-label="Stop Generating"]',
        condition: `(async()=>{const response=await fetch(${JSON.stringify(statusUrl)},{signal:AbortSignal.timeout(2000)});
          if(!response.ok)throw Error('Canonical status request failed');const states=await response.json();
          return states[${JSON.stringify(sessions.control.id)}]?.type==='idle' && !document.querySelector('button[aria-label="Stop Generating"]')
            && Boolean(document.querySelector('textarea'));})()` }, () => ui.click({ label: 'Stop Generating' }));
      const finalRows = await api(`/session/${sessions.control.id}/message`);
      const saved = finalRows.find(row => row.info.id === beforeDisconnect.info.id);
      const finalText = saved.parts.find(part => part.type === 'text').text;
      evidence.correctness.reconnectChunks = assertNumberedChunks(finalText);
      assert.ok(finalText.startsWith(beforeText), 'Reconnect or cancellation erased streamed text');
      await ui.waitExpression('cancelled canonical text retained', `document.querySelector(${JSON.stringify(assistantSelector)})?.innerText.includes(${JSON.stringify(finalText.trim())})`);
      const turnCounts = async rows => ({
        canonicalUser: rows.filter(row => row.info.id === sent.messageID).length,
        canonicalAssistant: rows.filter(row => row.info.id === saved.info.id).length,
        ...await evaluate(cdp, `({renderedUser:document.querySelectorAll(${JSON.stringify(rowSelector(sent.messageID))}).length,
          renderedAssistant:document.querySelectorAll(${JSON.stringify(assistantSelector)}).length})`),
      });
      evidence.correctness.cancelledTurnCounts = await turnCounts(finalRows);
      evidence.correctness.canonicalTurnUnique = assertUniqueTurnCounts(evidence.correctness.cancelledTurnCounts);
      const renderedCancelledText = await evaluate(cdp, `document.querySelector(${JSON.stringify(assistantSelector)}).innerText`);
      assert.equal(assertNumberedChunks(renderedCancelledText), evidence.correctness.reconnectChunks, 'Rendered stream chunks differ from canonical chunks');
      evidence.correctness.cancelledMessageID = sent.messageID;
      evidence.correctness.cancelledAssistantID = saved.info.id;
      await screenshot('interactive-reconnected-cancelled');

      await phase('repeated navigation and natural heap/DOM');
      await ui.type(INTERACTIVE_PROTOCOL.typingText);
      evidence.navigationBefore = await naturalMemoryWindow({ cdp, readHostMemory, measureMs, settleMs: warmupMs });
      for (let cycle = 0; cycle < INTERACTIVE_PROTOCOL.navigationCycles; cycle++) {
        await measure({ group: 'navigation', action: `New Chat ${cycle + 1}`, selector: 'button[aria-label="New Chat"]',
          condition: `!new URL(location.href).searchParams.get('session') && ${textValue('')} && !document.querySelector('[data-message-id]')` },
        () => ui.click({ label: 'New Chat' }));
        await measure({ group: 'navigation', action: `effort menu open ${cycle + 1}`, selector: 'button.model-controls__variant-trigger',
          condition: `[...document.querySelectorAll('[role="menu"]')].some(e=>e.getBoundingClientRect().height>0)` },
        () => ui.click({ selector: 'button.model-controls__variant-trigger' }));
        await measure({ group: 'navigation', action: `effort menu Escape ${cycle + 1}`, event: 'keydown', selector: 'body',
          condition: `![...document.querySelectorAll('[role="menu"]')].some(e=>e.getBoundingClientRect().height>0)` },
        () => ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 }));
        await clickHistory(sessions.histories[cycle % 2], 'navigation');
        await clickSession(sessions.control, 'navigation', `${textValue(INTERACTIVE_PROTOCOL.typingText)} && Boolean(document.querySelector(${JSON.stringify(assistantSelector)}))`);
      }
      evidence.navigationAfter = await naturalMemoryWindow({ cdp, readHostMemory, measureMs, settleMs: warmupMs });
      const memorySamples = [...evidence.navigationBefore.samples, ...evidence.navigationAfter.samples];
      assert.ok(memorySamples.every(sample => sample.rendererPid === memorySamples[0].rendererPid
        && sample.rendererCreatedAt === memorySamples[0].rendererCreatedAt), 'Renderer changed during repeated navigation');
      evidence.correctness.finalDraft = await evaluate(cdp, textValue(INTERACTIVE_PROTOCOL.typingText));
      assert.equal(evidence.correctness.finalDraft, true);
      evidence.correctness.finalTurnCounts = await turnCounts(await api(`/session/${sessions.control.id}/message`));
      evidence.correctness.finalTurnUnique = assertUniqueTurnCounts(evidence.correctness.finalTurnCounts);
      assert.equal(assertNumberedChunks(await evaluate(cdp, `document.querySelector(${JSON.stringify(assistantSelector)}).innerText`)),
        evidence.correctness.reconnectChunks, 'Navigation changed or duplicated the rendered stream');
      assert.equal(fixture.getState().activePrompts, 0);
      evidence.navigationGrowth = { heapBytes: evidence.navigationAfter.heapMedianBytes - evidence.navigationBefore.heapMedianBytes,
        domNodes: evidence.navigationAfter.domNodesMedian - evidence.navigationBefore.domNodesMedian,
        workingSetBytes: evidence.navigationAfter.workingSetMedianBytes - evidence.navigationBefore.workingSetMedianBytes };
      await screenshot('interactive-navigation-final');
    }
    evidence.actionsSummary = summarizeInteractiveActions(evidence.actions, interactiveScope);
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.outcome = 'failed';
    evidence.error = error.message;
    throw error;
  } finally {
    fixture.stopScenario();
    if (probeInstalled) {
      evidence.browser = await evaluate(cdp, `window.__devryanInteractiveProbe.snapshot()`).catch(error => ({ error: error.message }));
      if (interactiveScope === 'typing') {
        try {
          evidence.probeClosed = await evaluate(cdp, `(() => {window.__devryanInteractiveProbe.close();
            delete window.__devryanInteractiveProbe;return !Object.hasOwn(window, '__devryanInteractiveProbe');})()`);
          assert.equal(evidence.probeClosed, true, 'Typing probe cleanup did not complete');
        } catch (error) {
          evidence.outcome = 'failed';
          evidence.error ??= error.message;
        }
      } else {
        await evaluate(cdp, `window.__devryanInteractiveProbe.close();delete window.__devryanInteractiveProbe`).catch(() => {});
      }
    }
    if (tracing) {
      try {
        const complete = cdp.waitFor('Tracing.tracingComplete', 30000);
        await cdp.send('Tracing.end');
        const result = await complete;
        if (interactiveScope === 'typing' && result.dataLossOccurred !== false && typeof result.stream === 'string' && result.stream) {
          await cdp.send('IO.close', { handle: result.stream });
        }
        assert.equal(result.dataLossOccurred, false, 'Chromium trace data-loss status was missing or reported lost events');
        evidence.trace = await saveInteractiveTrace({ cdp, handle: result.stream, filename: traceFilename });
        evidence.trace.maximumBufferUsage = maximumTraceBufferUsage;
        assert.ok(maximumTraceBufferUsage < 0.99, 'Chromium trace buffer filled before the workload finished');
      } catch (error) {
        evidence.outcome = 'failed';
        evidence.traceError = error.message;
        evidence.error ??= 'Chromium tracing did not complete';
      }
    }
    removeBufferUsage();
    if (evidence.browser?.overflow || evidence.browser?.pending || evidence.browser?.error) {
      evidence.outcome = 'failed';
      evidence.error ??= 'Interactive measurements were incomplete or exceeded their bounded buffers';
    }
    if (evidence.browser?.support?.longtask !== true) {
      evidence.outcome = 'failed';
      evidence.error ??= 'The required browser Long Tasks observation was unavailable';
    }
    await record(evidence);
  }
  assert.equal(evidence.outcome, 'passed', evidence.error);
  return evidence;
}

export function aggregateInteractiveRuns(runs) {
  assert.ok(runs.length && runs.every(run => run.outcome === 'passed'), 'Every interactive run must pass correctness');
  const scope = runs[0].interactiveScope === undefined ? 'full' : runs[0].interactiveScope;
  assertInteractiveScope(scope);
  assert.ok(runs.every(run => (run.interactiveScope === undefined ? 'full' : run.interactiveScope) === scope),
    'Interactive aggregation requires one scope');
  if (scope === 'typing') {
    for (const run of runs) {
      assertTypingCorrectness(run.correctness);
      assert.deepEqual(run.actionsSummary, summarizeInteractiveActions(run.actions, scope));
      assert.equal(Object.hasOwn(run, 'navigationGrowth'), false, 'Typing scope cannot contain unmeasured navigation growth');
    }
  }
  const values = samples => ({ runCount: samples.length, median: median(samples), minimum: Math.min(...samples), maximum: Math.max(...samples), values: samples });
  return { runCount: runs.length, interactiveScope: scope,
    latencies: Object.fromEntries(Object.keys(runs[0].actionsSummary).map(name => [name, {
      sampleCount: runs.reduce((sum, run) => sum + run.actionsSummary[name].count, 0),
      p50: values(runs.map(run => run.actionsSummary[name].p50)), p95: values(runs.map(run => run.actionsSummary[name].p95)),
    }])),
    ...(scope === 'full' ? { navigationGrowth: Object.fromEntries(['heapBytes', 'domNodes', 'workingSetBytes']
      .map(name => [name, values(runs.map(run => run.navigationGrowth[name]))])) } : {}),
    longTasks: runs.map(run => ({ supported: run.browser.support.longtask, count: run.browser.longTasks.length,
      totalDurationMs: run.browser.longTasks.reduce((sum, task) => sum + task.duration, 0),
      ...(run.browser.longTasks.length ? { durationMs: distribution(run.browser.longTasks.map(task => task.duration)) } : {}) })),
    frames: runs.map(run => ({ count: run.browser.frames.length, durationMs: distribution(run.browser.frames.map(frame => frame.duration)) })),
    eventTiming: runs.map(run => ({ supported: run.browser.support.event, entries: run.browser.eventTiming.length,
      minimumDurationMs: INTERACTIVE_PROTOCOL.eventTimingMinimumDurationMs })),
    phases: runs.map(run => Object.fromEntries((run.browser.phases ?? []).map(({ name }) => {
      const frames = run.browser.frames.filter(frame => frame.phase === name);
      const tasks = run.browser.longTasks.filter(task => task.phase === name);
      return [name, { frameCount: frames.length, ...(frames.length ? { frameDurationMs: distribution(frames.map(frame => frame.duration)) } : {}),
        longTaskCount: tasks.length, longTaskTotalDurationMs: tasks.reduce((sum, task) => sum + task.duration, 0) }];
    }))),
    observations: { longTaskCount: values(runs.map(run => run.browser.longTasks.length)),
      longTaskTotalDurationMs: values(runs.map(run => run.browser.longTasks.reduce((sum, task) => sum + task.duration, 0))),
      frameP95Ms: values(runs.map(run => distribution(run.browser.frames.map(frame => frame.duration)).p95)) },
  };
}

function assertTypingCorrectness(correctness) {
  assert.equal(correctness?.typingDraft, true, 'Typing scope requires the exact unsent draft');
  assert.equal(correctness?.typingNoSubmit, true, 'Typing scope requires no submitted prompt');
  const before = correctness.typingSelectionBefore;
  const after = correctness.typingSelectionAfter;
  assert.ok(before?.composerReady === true && after?.composerReady === true
    && typeof before.sessionID === 'string' && before.sessionID !== PERF_PARENT_SESSION_ID
    && before.sessionID === after.sessionID && before.href === after.href
    && new URL(before.href).searchParams.get('session') === before.sessionID,
  'Typing scope requires the same selected control session and ready composer before and after inputs');
  const stream = correctness?.typingBackground;
  assert.ok(stream?.sessionID === PERF_PARENT_SESSION_ID && stream.activeScenario === 'one-stream'
    && Number.isSafeInteger(stream.beforeTextLength) && stream.beforeTextLength > 100
    && Number.isSafeInteger(stream.afterTextLength) && stream.afterTextLength > stream.beforeTextLength,
  'Typing scope requires the prescribed background stream to advance');
}

export function compareInteractiveSummaries(baseline, current) {
  const scope = current.interactiveScope === undefined ? 'full' : current.interactiveScope;
  assertInteractiveScope(scope);
  const beforeScope = baseline.interactiveScope === undefined ? 'full' : baseline.interactiveScope;
  assertInteractiveScope(beforeScope);
  assert.equal(beforeScope, scope, 'Interactive comparison requires matching interactiveScope');
  const startupMode = current.startupMode === undefined ? 'natural' : current.startupMode;
  const beforeStartupMode = baseline.startupMode === undefined ? 'natural' : baseline.startupMode;
  assertStartupMode(startupMode); assertStartupMode(beforeStartupMode);
  assert.equal(beforeStartupMode, startupMode, 'Interactive comparison requires matching startupMode');
  const keys = ['fixtureSha256', 'interactiveProtocolSha256', 'runsPerScenario', 'warmupMs'];
  if (scope === 'full') keys.push('measureMs', 'sampleIntervalMs');
  for (const key of keys) {
    assert.ok(baseline[key] !== undefined && baseline[key] === current[key], `Interactive comparison requires matching ${key}`);
  }
  assert.ok(current.runsPerScenario >= 3, 'Interactive comparison requires at least three fresh runs per package');
  assert.ok(current.warmupMs >= INTERACTIVE_PROTOCOL.comparisonMinimumWarmupMs,
    'Interactive comparison requires at least a 5-second warmup');
  if (scope === 'full') {
    assert.ok(current.measureMs >= INTERACTIVE_PROTOCOL.comparisonMinimumMeasureMs,
      'Interactive comparison requires at least a 30-second measurement window');
  } else {
    for (const summary of [baseline, current]) {
      assert.equal(Object.hasOwn(summary, 'measureMs'), false, 'Typing scope has no duration-based measurement window');
      assert.equal(Object.hasOwn(summary, 'sampleIntervalMs'), false, 'Typing scope has no memory sampling interval');
      assert.equal(summary.measurement, INTERACTIVE_TYPING_PROTOCOL.measurement);
      assert.deepEqual(summary.interactivePrimaryMetrics, getInteractivePrimaryMetrics(scope));
    }
  }
  for (const key of ['backendSha256', 'shellSha256', 'nativeSha256']) {
    assert.ok(baseline.packageEvidence?.[key] && baseline.packageEvidence[key] === current.packageEvidence?.[key], `Interactive comparison requires matching packaged ${key}`);
  }
  const before = baseline.scenarios?.interactive;
  const after = current.scenarios?.interactive;
  assert.ok(before?.interactive && after?.interactive, 'Both summaries require completed interactive evidence');
  assert.deepEqual(baseline.interactiveProtocol, current.interactiveProtocol, 'Interactive workload parameters differ');
  assert.deepEqual(current.interactiveProtocol, getInteractiveProtocol(scope), 'Interactive workload parameters are missing or unsupported');
  assert.deepEqual(before.chromium, after.chromium, 'Interactive comparison requires matching Chromium');
  assert.deepEqual(before.display, after.display, 'Interactive comparison requires matching display/window conditions');
  assert.equal(after.display?.visibilityState, 'visible');
  assert.equal(before.interactive.runCount, current.runsPerScenario);
  assert.equal(after.interactive.runCount, current.runsPerScenario);
  for (const scenario of [before, after]) {
    assert.equal(scenario.runs?.length, current.runsPerScenario, 'Interactive comparison needs every fresh run');
    assert.ok(scenario.runs.every(run => run.interactive?.outcome === 'passed' && run.startup?.outcome === 'passed'),
      'Interactive comparison requires correctness and startup success for every run');
    if (scope === 'typing') {
      assert.equal(scenario.interactive.interactiveScope, scope);
      assert.deepEqual(Object.keys(scenario.interactive.latencies), ['typing']);
      assert.equal(scenario.interactive.latencies.typing.sampleCount, INTERACTIVE_PROTOCOL.typingText.length * current.runsPerScenario);
      assert.equal(Object.hasOwn(scenario.interactive, 'navigationGrowth'), false);
      for (const run of scenario.runs) {
        assert.equal(run.interactive.interactiveScope, scope);
        assert.deepEqual(Object.keys(run.interactive.actions), ['typing']);
        assert.equal(run.interactive.actions.typing.count, INTERACTIVE_PROTOCOL.typingText.length);
        assertTypingCorrectness(run.interactive.correctness);
        assert.equal(Object.hasOwn(run.interactive, 'navigationGrowth'), false);
      }
    }
  }
  const change = (old, next) => {
    const rangesOverlap = Math.max(old.minimum, next.minimum) <= Math.min(old.maximum, next.maximum);
    return { baseline: old, current: next, absoluteChange: next.median - old.median,
      percentageChange: old.median === 0 ? null : (next.median - old.median) / old.median * 100,
      rangesOverlap, interpretation: rangesOverlap ? 'ranges overlap; no clear change'
        : next.median < old.median ? 'lower in these matched fixture runs' : 'higher in these matched fixture runs' };
  };
  return { scope: 'descriptive matched fixture measurements; no compositor or provider latency claim', interactiveScope: scope,
    latencies: Object.fromEntries(Object.keys(after.interactive.latencies).map(name => {
      assert.equal(before.interactive.latencies[name]?.sampleCount, after.interactive.latencies[name].sampleCount, `Interactive sample count differs: ${name}`);
      return [name, { sampleCount: after.interactive.latencies[name].sampleCount,
        p50: change(before.interactive.latencies[name].p50, after.interactive.latencies[name].p50),
        p95: change(before.interactive.latencies[name].p95, after.interactive.latencies[name].p95) }];
    })),
    ...(scope === 'full' ? { navigationGrowth: Object.fromEntries(Object.keys(after.interactive.navigationGrowth).map(name => [name,
      change(before.interactive.navigationGrowth[name], after.interactive.navigationGrowth[name])])) } : {}),
    observations: Object.fromEntries(Object.keys(after.interactive.observations).map(name => [name,
      change(before.interactive.observations[name], after.interactive.observations[name])])),
  };
}
