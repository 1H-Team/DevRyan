import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createQaManagedTaskReadModel, createQaManagedTaskFetchScript, installQaManagedTaskReadModel, resolveQaManagedTaskRead } from './fixture-managed-tasks.mjs';
import { createLoopbackOpenCodeFixture, PERF_PARENT_SESSION_ID } from '../perf/loopback-opencode-fixture.mjs';

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
  const fixture = await createLoopbackOpenCodeFixture({ directory: '/qa-task-visual' });
  const post = (route, body) => fetch(fixture.origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    fixture.configureNextPrompt(PERF_PARENT_SESSION_ID, { hold: true });
    await post(`/session/${PERF_PARENT_SESSION_ID}/prompt_async`, { messageID: 'msg_visual_parent', parts: [{ type: 'text', text: 'Visual parent' }] });
    const parent = (await fetch(`${fixture.origin}/session/${PERF_PARENT_SESSION_ID}/message`).then(response => response.json())).at(-1);
    const childRecords = [];
    for (const [index, status] of ['running', 'completed'].entries()) {
      const child = await post('/session', { parentID: PERF_PARENT_SESSION_ID, title: 'Visual child' }).then(response => response.json());
      fixture.configureNextPrompt(child.id, { hold: status === 'running', chunks: 1, intervalMs: 10 });
      await post(`/session/${child.id}/prompt_async`, { messageID: `msg_visual_child_${index}`, parts: [{ type: 'text', text: 'Visual child' }] });
      if (status === 'completed') await new Promise(resolve => setTimeout(resolve, 25));
      const assistant = (await fetch(`${fixture.origin}/session/${child.id}/message`).then(response => response.json())).at(-1);
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
    const saved = (await fetch(`${fixture.origin}/session/${PERF_PARENT_SESSION_ID}/message`).then(response => response.json())).at(-1);
    assert.equal(saved.parts.filter(part => part.type === 'tool' && part.tool === 'devryan_task').length, 2);
  } finally { await fixture.close(); }
});
