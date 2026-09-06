import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrimaryRecoveryHost } from './provider-recovery-host.js';

const cleanup = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function setup(overrides = {}) {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'primary-host-'));
  cleanup.push(() => fs.rm(dataDirectory, { recursive: true, force: true }));
  const calls = [];
  const messages = [
    { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'Original input' }] },
    { info: { id: 'msg_assistant', role: 'assistant', parentID: 'msg_user', time: { completed: 1 },
      error: { name: 'UnknownError', data: { message: 'The operation timed out.' } } }, parts: [] },
  ];
  const fetchImpl = async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    if (overrides.response) { const result = overrides.response(url, init); if (result) return result; }
    let data;
    if (url.pathname === '/global/health') data = { healthy: true, version: '1.18.25' };
    else if (url.pathname === '/session/ses_test') data = { id: 'ses_test', directory: '/project' };
    else if (url.pathname === '/session/status') data = {};
    else if (url.pathname.endsWith('/message')) data = messages;
    else if (url.pathname === '/permission' || url.pathname === '/question') data = [];
    else if (url.pathname === '/experimental/tool/ids') data = ['read', 'glob', 'grep', 'bash', 'write', 'devryan_task'];
    else if (url.pathname.endsWith('/prompt_async')) return new Response(null, { status: 204 });
    else if (url.pathname.endsWith('/abort')) data = true;
    else throw new Error(`Unexpected fixture path ${url.pathname}`);
    return Response.json(data);
  };
  const host = createPrimaryRecoveryHost({ dataDirectory, mode: 'enforce', isManaged: () => true,
    buildOpenCodeUrl: (pathname) => `http://fixture.invalid${pathname}`, fetchImpl,
    authorize: async () => true, managedBarrier: async () => ({ state: 'clear' }), ...overrides });
  await host.initialize(); cleanup.push(() => host.drain());
  await host.plugin({ action: 'hello', policyVersion: 1, instanceID: 'fixture', transport: 'fetch' });
  const body = { messageID: 'msg_user', model: { providerID: 'openai', modelID: 'gpt-5.6-sol' }, agent: 'orchestrator', variant: 'xhigh' };
  const admit = await host.handleRequest('POST', '/api/session/ses_test/prompt_async?directory=/project', body);
  expect(admit).toBeNull();
  return { host, calls, messages, body, fail: async () => {
    const r = await host.readRecord('ses_test');
    if (r.state === 'observing' && r.requestedAt === null) await host.plugin({ action: 'step', instanceID: 'fixture',
      sessionID: 'ses_test', userMessageID: 'msg_user', assistantMessageID: overrides.stepID ?? messages.at(-1).info.id });
    return host.observe({ type: 'session.error', properties: { sessionID: 'ses_test', error: messages.at(-1).info.error } });
  } };
}

test.each(['/api/session/ses_test/recovery', '/session/ses_test/recovery'])(
  'web/Electron path contract: %s', async (endpoint) => {
    const f = await setup(); await f.fail();
    const result = await f.host.handleRequest('GET', endpoint, null);
    expect(result.status).toBe(200); expect(result.body.schemaVersion).toBe(1);
    expect(result.body.record).toMatchObject({ attemptCount: 1, readOnly: true, variant: 'xhigh' });
    const prompt = f.calls.find((call) => call.url.pathname.endsWith('/prompt_async'));
    expect(JSON.parse(prompt.init.body).tools).toMatchObject({ read: true, bash: false, write: false, devryan_task: false });
  });

test('successful status omission is idle only with a finalized canonical turn', async () => {
  const f = await setup(); await f.fail();
  expect(f.calls.filter((call) => call.url.pathname.endsWith('/prompt_async'))).toHaveLength(1);
  const invalid = await setup({ response: (url) => url.pathname === '/session/status' ? Response.json([]) : null });
  await invalid.fail();
  expect(invalid.calls.filter((call) => call.url.pathname.endsWith('/prompt_async'))).toHaveLength(0);
});

test('duplicate prompt admission is rejected; a message ID is not POST idempotency', async () => {
  const f = await setup();
  const result = await f.host.handleRequest('POST', '/session/ses_test/prompt_async', f.body);
  expect(result).toMatchObject({ status: 409, body: { code: 'prompt_already_admitted' } });
});

test('queue intent cancels undispatched recovery while leaving original work admitted', async () => {
  const f = await setup();
  const snapshot = await f.host.getSnapshot('ses_test');
  const intent = await f.host.handleRequest('POST', '/session/ses_test/recovery/intent', { revision: snapshot.record.revision });
  expect(intent.status).toBe(200);
  await f.fail();
  expect(f.calls.filter((call) => call.url.pathname.endsWith('/prompt_async'))).toHaveLength(0);
});

test('Stop persists cancellation and still aborts primary if descendant cancellation fails', async () => {
  const f = await setup({ cancelDescendants: async () => { throw new Error('child unavailable'); } });
  const result = await f.host.handleRequest('POST', '/session/ses_test/abort', {});
  expect(result.status).toBe(409);
  expect((await f.host.getSnapshot('ses_test')).record.state).toBe('cancelled');
  expect(f.calls.some((call) => call.url.pathname.endsWith('/abort'))).toBe(true);
});

test('stale control versions cannot cancel a newer user turn', async () => {
  const f = await setup();
  const result = await f.host.handleRequest('POST', '/session/ses_test/recovery/cancel', { revision: 9999 });
  expect(result).toMatchObject({ status: 409, body: { code: 'recovery_revision_conflict' } });
  expect(f.calls.some((call) => call.url.pathname.endsWith('/abort'))).toBe(false);
});

test('Stop fences durable state before any request to an unavailable OpenCode', async () => {
  let offline = false;
  const f = await setup({ response: () => offline ? new Response(null, { status: 503 }) : null });
  offline = true;
  const result = await f.host.handleRequest('POST', '/session/ses_test/abort', {});
  expect(result).toMatchObject({ status: 409, body: { code: 'provider_stop_unconfirmed' } });
  const status = await f.host.handleRequest('GET', '/session/ses_test/recovery');
  expect(status).toMatchObject({ status: 200, body: { record: { state: 'cancelled' } } });
  offline = false; await f.fail();
  expect(f.calls.some((call) => call.url.pathname.endsWith('/prompt_async'))).toBe(false);
});

test('unsupported external and WebSocket runtimes retain manual recovery', async () => {
  const f = await setup();
  await f.host.plugin({ action: 'hello', policyVersion: 1, instanceID: 'fixture', transport: 'websocket-unverified' });
  await f.fail(); expect((await f.host.getSnapshot('ses_test')).enforced).toBe(false);
  expect(f.calls.some((call) => call.url.pathname.endsWith('/prompt_async'))).toBe(false);
});

test('custom inspection-tool overrides are explicitly disabled in recovery prompts', async () => {
  const f = await setup({ response: (url) => url.pathname === '/experimental/tool/ids' ? Response.json(['read', 'read', 'glob', 'grep', 'bash']) : null });
  await f.fail();
  const prompt = f.calls.find((call) => call.url.pathname.endsWith('/prompt_async'));
  expect(JSON.parse(prompt.init.body).tools).toMatchObject({ read: false, glob: true, bash: false });
});

test('complete turn fetch follows pagination beyond the loaded page', async () => {
  const f = await setup({ stepID: 'msg_tail', response: (url) => {
    if (!url.pathname.endsWith('/message') || url.searchParams.has('before')) return null;
    return Response.json([{ info: { id: 'msg_tail', role: 'assistant', parentID: 'msg_user', time: { completed: 5 },
      error: { name: 'TimeoutError', message: 'The operation timed out.' } }, parts: [] }], { headers: { 'x-next-cursor': 'older' } });
  } });
  await f.fail();
  expect(f.calls.some((call) => call.url.searchParams.get('before') === 'older')).toBe(true);
  expect(f.calls.filter((call) => call.url.pathname.endsWith('/prompt_async'))).toHaveLength(1);
});
