import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createQaManagedTaskReadModel, projectQaManagedTaskUpdates, createQaManagedTaskFetchScript, installQaManagedTaskReadModel, resolveQaManagedTaskRead } from './fixture-managed-tasks.mjs';
import { createLoopbackOpenCodeV2Fixture, PERF_PARENT_SESSION_ID } from '../perf/loopback-opencode-v2-fixture.mjs';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';

const children = () => ['running', 'completed'].map((status, index) => ({ sessionID: `ses_child${index}`,
  parentSessionID: 'ses_root', userMessageID: `msg_user${index}`, assistantMessageID: `msg_assistant${index}`, status }));
const model = () => createQaManagedTaskReadModel({ transport: 'fixture', directory: '/fixture', rootSessionID: 'ses_root', children: children(), now: 100 });

test('visual task model uses production projections and exact completed envelope identities', () => {
  const value = model();
  assert.equal(value.snapshot.tasks.length, 2);
  assert.equal(value.snapshot.resultEnvelopes.length, 1);
  const completed = value.snapshot.tasks[1]; const envelope = value.snapshot.resultEnvelopes[0];
  for (const key of ['taskId', 'rootSessionId', 'childSessionId', 'directory', 'status', 'sequence']) assert.equal(completed[key], envelope[key]);
  assert.equal(envelope.action, null);
  assert.equal(value.snapshot.bridgeReady, false);
  assert.equal(Object.hasOwn(completed, 'prompt'), false);
  assert.equal(Object.hasOwn(completed, 'leaseToken'), false);
  assert.equal(Object.hasOwn(completed, 'idempotencyKey'), false);
  assert.throws(() => createQaManagedTaskReadModel({ transport: 'live' }), /fixture transport/);
  const invalid = children(); invalid[0].parentSessionID = 'other';
  assert.throws(() => createQaManagedTaskReadModel({ transport: 'fixture', directory: '/fixture', rootSessionID: 'ses_root', children: invalid }), /exact fixture root/);
});

test('task visual reads reject wrong origin/root/directory, all actions and unknown routes', () => {
  const data = model(); const origin = 'http://127.0.0.1:32100';
  const read = (suffix, patch = {}) => resolveQaManagedTaskRead({ model: data, origin, request: { method: 'GET', url: origin + suffix, ...patch } });
  assert.equal(read('/api/orchestration/snapshot').accepted, true);
  assert.equal(read('/api/orchestration/snapshot?rootSessionId=ses_root').accepted, true);
  const task = `/api/orchestration/task/${data.records[1].task.taskId}`;
  assert.equal(read(task + '?rootSessionId=ses_root&directory=%2Ffixture').body.resultEnvelope.taskId, data.records[1].task.taskId);
  for (const suffix of ['/api/orchestration/snapshot?rootSessionId=other', '/api/orchestration/snapshot?extra=1',
    task, task + '?rootSessionId=ses_root&directory=other', task + '/cancel', '/api/orchestration/handoff', '/api/orchestration/task/missing?rootSessionId=ses_root']) {
    const response = read(suffix); assert.equal(response.accepted, false); assert.equal(response.status, 501);
  }
  assert.equal(read('/api/orchestration/snapshot', { method: 'POST' }).accepted, false);
  assert.equal(read('/api/orchestration/snapshot', { postData: '{}' }).accepted, false);
  assert.equal(read('/api/orchestration/snapshot', { url: 'http://elsewhere/api/orchestration/snapshot' }).accepted, false);
});

const createPage = (origin) => {
  const forwarded = [];
  const context = vm.createContext({ URL, Request, Response, structuredClone, location: { origin, href: origin + '/?session=ses_root' },
    fetch: async (...args) => { forwarded.push(args); return new Response('native-forwarded', { status: 200 }); } });
  return { context, forwarded };
};

test('scoped fetch transport serves only exact reads and forwards unrelated traffic unchanged', async () => {
  const origin = 'http://127.0.0.1:32100';
  const page = createPage(origin);
  vm.runInContext(createQaManagedTaskFetchScript({ transport: 'fixture', origin, model: model() }), page.context);
  const response = await page.context.fetch('/api/orchestration/snapshot');
  assert.equal(response.status, 200);assert.deepEqual((await response.json()).tasks, model().snapshot.tasks);
  const taskPath = '/api/orchestration/task/dvr_task_qa_visual_ses_root_2?rootSessionId=ses_root&directory=%2Ffixture';
  assert.equal((await (await page.context.fetch(new Request(origin + taskPath))).json()).resultEnvelope.status, 'completed');
  for (const [url, options] of [['/api/orchestration/handoff', { method: 'POST', body: '{}' }],
    ['/api/orchestration/snapshot?rootSessionId=foreign'], ['https://foreign.invalid/api/orchestration/snapshot'], ['/api/orchestration']]) {
    assert.equal((await page.context.fetch(url, options)).status, 501);
  }
  const request = new Request(origin + '/api/session/status');const options = { cache: 'no-store' };
  await page.context.fetch(request, options);await page.context.fetch('https://external.invalid/a', { method: 'GET' });
  assert.equal(page.forwarded.length, 2);assert.equal(page.forwarded[0][0], request);assert.equal(page.forwarded[0][1], options);
  const state = page.context.__devryanQaManagedReadFixture;
  assert.equal(state.requests.length, 6);assert.equal(state.requests[2].requestBody, '[body-present]');assert.equal(state.failures.length, 4);
  const capturedFetch = page.context.fetch;state.restore();
  await capturedFetch('/api/orchestration/snapshot');assert.equal(page.forwarded.length, 3, 'Captured production fetch references must also forward after cleanup');
  const foreign = createPage('http://127.0.0.1:32101');
  vm.runInContext(createQaManagedTaskFetchScript({ transport: 'fixture', origin, model: model() }), foreign.context);
  assert.equal(foreign.context.__devryanQaManagedReadFixture, undefined);
});

test('read adapter requires the isolated fixture page and records failures across real-reload setup and cleanup', async () => {
  const calls = [];const origin = 'http://127.0.0.1:32100';const page = createPage(origin);
  const cdp = { send: async (name, args) => {
    calls.push({ name, args });
    if (name === 'Runtime.evaluate') return { result: { value: structuredClone(await vm.runInContext(args.expression, page.context)) } };
    if (name === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'fixture-script' };
    return {};
  } };
  await assert.rejects(installQaManagedTaskReadModel({ transport: 'live' }), /fixture transport/);
  const intercept = await installQaManagedTaskReadModel({ transport: 'fixture', cdp, origin, model: model() });
  await assert.rejects(intercept.assertHealthy(), /real page reload/);
  vm.runInContext(calls.find(call => call.name === 'Page.addScriptToEvaluateOnNewDocument').args.source, page.context);
  await page.context.fetch('/api/orchestration/snapshot');await intercept.assertHealthy();
  await page.context.fetch('/api/orchestration/handoff', { method: 'POST', body: '{}' });
  await intercept.close();
  assert.equal(intercept.evidence.closed, true);assert.equal(intercept.evidence.requests[0].responseBody.tasks.length, 2);
  await assert.rejects(intercept.assertHealthy(), /Unexpected/);
  assert.deepEqual(calls.find(call => call.name === 'Page.removeScriptToEvaluateOnNewDocument').args, { identifier: 'fixture-script' });
  page.context.location.origin = 'http://127.0.0.1:32101';
  await assert.rejects(installQaManagedTaskReadModel({ transport: 'fixture', cdp, origin, model: model() }), /known isolated page/);
});

test('managed visual tool parts require owned canonical child/root/assistant and unique dispatch calls', async () => {
  const fixture = await createLoopbackOpenCodeV2Fixture({ directory: '/qa-task-visual' });
  const directory = '/qa-task-visual';
  const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }), getAuthHeaders: () => fixture.authHeaders });
  const post = async (id, body) => {
    const response = await fetch(`${fixture.origin}/api/session/${id}/prompt`, { method: 'POST', headers: { ...fixture.authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  };
  const rows = async id => (await client.sessions.messages(id, {}, { directory })).records;
  try {
    fixture.configureNextPrompt(PERF_PARENT_SESSION_ID, { hold: true });
    await post(PERF_PARENT_SESSION_ID, { id: 'msg_visual_parent', text: 'Visual parent' });
    const parent = (await rows(PERF_PARENT_SESSION_ID)).at(-1);
    const childRecords = [];
    for (const [index, status] of ['running', 'completed'].entries()) {
      const child = await client.sessions.create({ parentID: PERF_PARENT_SESSION_ID, title: 'Visual child' }, { directory });
      fixture.configureNextPrompt(child.id, { hold: status === 'running', chunks: 1, intervalMs: 10 });
      await post(child.id, { id: `msg_visual_child_${index}`, text: 'Visual child' });
      if (status === 'completed') await new Promise(resolve => setTimeout(resolve, 25));
      const assistant = (await rows(child.id)).at(-1);
      childRecords.push({ sessionID: child.id, parentSessionID: PERF_PARENT_SESSION_ID, status,
        userMessageID: assistant.info.parentID, assistantMessageID: assistant.info.id });
    }
    const data = createQaManagedTaskReadModel({ transport: 'fixture', directory: '/qa-task-visual', rootSessionID: PERF_PARENT_SESSION_ID, children: childRecords });
    const append = record => fixture.appendManagedTaskVisual({ sessionID: PERF_PARENT_SESSION_ID, messageID: parent.info.id, ...record });
    const added = append(data.records[0]);
    assert.equal(added.part.callID, data.records[0].task.dispatchCallId);
    assert.equal(JSON.parse(added.part.state.output).task.childSessionId, childRecords[0].sessionID);
    assert.throws(() => append(data.records[0]), /unique dispatch/);
    assert.throws(() => append({ ...data.records[0], task: { ...data.records[0].task, childSessionId: 'ses_foreign', dispatchCallId: 'call_wrong_child' } }), /owned canonical/);
    assert.throws(() => append({ ...data.records[1], task: { ...data.records[1].task, canonicalRefs: [] } }), /do not match/);
    append(data.records[1]);
    const saved = (await rows(PERF_PARENT_SESSION_ID)).at(-1);
    assert.equal(saved.parts.filter(part => part.type === 'tool' && part.tool === 'devryan_task').length, 2);
  } finally { await fixture.close(); }
});


test('visual model updates use canonical upserts and exact removals without native event projection', () => {
  const previous = model(), next = { ...previous, records: previous.records.slice(1) };
  const frames = projectQaManagedTaskUpdates(previous, next);
  assert.deepEqual(frames.map(frame => frame.payload.type), ['devryan:managed-task', 'devryan:managed-task-removed']);
  assert.equal(frames[1].payload.properties.taskId, previous.records[0].task.taskId);
  assert.equal(frames[0].directory, '/fixture');
  assert.throws(() => projectQaManagedTaskUpdates(previous, { ...next, rootSessionID: 'foreign' }), /retain its root/);
  assert.throws(() => projectQaManagedTaskUpdates(previous, { ...next, records: [{ task: { ...next.records[0].task, directory: '/foreign' } }] }), /directory and root/);
});

test('isolated app WebSocket relay forwards canonical frames and stops on close or cleanup', () => {
  const origin = 'http://127.0.0.1:32100';
  class NativeSocket extends EventTarget { readyState = 1; }
  const page = createPage(origin);
  Object.assign(page.context, { WebSocket: NativeSocket, MessageEvent });
  vm.runInContext(createQaManagedTaskFetchScript({ transport: 'fixture', origin, model: model() }), page.context);
  const socket = new page.context.WebSocket('ws://127.0.0.1:32100/api/global/event/ws?clientID=fixture');
  const unrelated = new page.context.WebSocket('ws://127.0.0.1:32100/other');
  const foreign = new page.context.WebSocket('ws://127.0.0.1:32101/api/global/event/ws');
  const messages = [], extra = [];
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)));
  unrelated.addEventListener('message', event => extra.push(event)); foreign.addEventListener('message', event => extra.push(event));
  const state = page.context.__devryanQaManagedReadFixture;
  const frames = projectQaManagedTaskUpdates(model(), { ...model(), records: model().records.slice(1) });
  state.publish(frames);
  assert.deepEqual(messages, frames.map(frame => ({ type: 'event', ...frame })));
  assert.deepEqual(extra, []);
  socket.dispatchEvent(new Event('close'));state.publish(frames);assert.equal(messages.length, 2);
  const second = new page.context.WebSocket('ws://127.0.0.1:32100/api/global/event/ws');
  second.addEventListener('message', event => extra.push(event));
  state.restore();state.publish(frames);
  assert.equal(page.context.WebSocket, NativeSocket);assert.equal(state.wsSockets.size, 0);assert.deepEqual(extra, []);
});

test('SSE relay preserves partial native frames, scopes injection and releases cancellation', async () => {
  const origin = 'http://127.0.0.1:32100', page = createPage(origin), encoder = new TextEncoder();
  let nativeController, cancelled = false;
  const nativeBody = new ReadableStream({ start(controller) { nativeController = controller; }, cancel() { cancelled = true; } });
  Object.assign(page.context, { ReadableStream, TextEncoder, TextDecoder,
    fetch: async () => new Response(nativeBody, { headers: { 'Content-Type': 'text/event-stream' } }) });
  vm.runInContext(createQaManagedTaskFetchScript({ transport: 'fixture', origin, model: model() }), page.context);
  const response = await page.context.fetch('/api/global/event');
  const reader = response.body.getReader(), state = page.context.__devryanQaManagedReadFixture;
  nativeController.enqueue(encoder.encode('data: {"native":'));
  const frames = projectQaManagedTaskUpdates(model(), { ...model(), records: model().records.slice(1) });
  state.publish(frames);
  const decoder = new TextDecoder();
  for (const frame of frames) assert.equal(decoder.decode((await reader.read()).value), 'data: ' + JSON.stringify(frame) + '\n\n');
  nativeController.enqueue(encoder.encode('true}\n\n'));
  assert.equal(decoder.decode((await reader.read()).value), 'data: {"native":true}\n\n');
  await reader.cancel();assert.equal(cancelled, true);assert.equal(state.sseSinks.size, 0);
  state.restore();state.publish(frames);assert.equal(state.relayedFrames, 2);
});


test('a running recovery child retains its finished introductory text through canonical HTTP reads', async () => {
  const directory = '/qa-recovery-child', fixture = await createLoopbackOpenCodeV2Fixture({ directory });
  const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }), getAuthHeaders: () => fixture.authHeaders });
  try {
    const session = await client.sessions.create({ parentID: PERF_PARENT_SESSION_ID, title: 'Recovery child' }, { directory });
    const text = 'Recovered child: inspecting shared calendar and appointment details.';
    fixture.replayRecoveryVisual({ sessionID: session.id, status: 'busy', rows: [
      { info: { id: 'msg_recoveryuser', sessionID: session.id, role: 'user', time: { created: 100 } }, parts: [] },
      { info: { id: 'msg_recoveryassistant', sessionID: session.id, parentID: 'msg_recoveryuser', role: 'assistant', agent: 'build', providerID: 'fixture', modelID: 'fixture-model', time: { created: 101 } },
        parts: [{ id: 'prt_recoverytext', sessionID: session.id, messageID: 'msg_recoveryassistant', type: 'text', text, time: { start: 101, end: 102 } }] },
    ] });
    const rows = (await client.sessions.messages(session.id, {}, { directory })).records;
    assert.equal(rows.at(-1).parts.find(part => part.type === 'text').text, text);
    assert.equal(rows.at(-1).info.time.completed, undefined, 'The child must remain running');
  } finally { await fixture.close(); }
});

test('objective visual reads are exact scoped, reject stale identity and expose only fixture evidence', () => {
  const data = { ...model(), objectiveId: 'msg_current', originatingMessageId: 'msg_wake', objectiveVerification: { objectiveId: 'msg_current', checks: [] } };
  const origin = 'http://127.0.0.1:32100';
  const read = (suffix, patch = {}) => resolveQaManagedTaskRead({ model: data, origin, request: { method: 'GET', url: origin + suffix, ...patch } });
  const route = '/api/orchestration/objective/verification?rootSessionId=ses_root&directory=%2Ffixture';
  assert.deepEqual(read(route).body, { objectiveId: 'msg_current', verification: { objectiveId: 'msg_current', checks: [] } });
  assert.equal(read(route + '&expectedObjectiveId=msg_current').status, 200);
  assert.equal(read(route + '&expectedObjectiveId=msg_old').status, 409);
  assert.equal(read(route + '&originatingMessageId=msg_forged').status, 409);
  assert.equal(read(route + '&originatingMessageId=msg_wake').body.originatingMessageId, 'msg_wake');
  assert.equal(read(route.replace('ses_root', 'ses_foreign')).accepted, false);
  assert.equal(read(route.replace('%2Ffixture', '%2Fforeign')).accepted, false);
  assert.equal(read(route + '&extra=x').accepted, false);
  assert.equal(read(route, { method: 'POST', postData: '{}' }).accepted, false);
});

test('fixture task updates carry supplied verification without changing execution status', () => {
  const previous = model(), completed = previous.records[1];
  const verification = { objectiveId: 'msg_current', status: 'pending', ready: false, checks: [] };
  const next = { ...previous, records: [previous.records[0], { ...completed, verification }] };
  const update = projectQaManagedTaskUpdates(previous, next).find(frame => frame.payload.properties.task.taskId === completed.task.taskId);
  assert.equal(update.payload.properties.task.status, 'completed');
  assert.deepEqual(update.payload.properties.task.verification, verification);
});
