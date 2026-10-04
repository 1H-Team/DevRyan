import { describe, expect, it } from 'vitest';
import { createOpenCodeAdmission } from '../v2/admission.js';
import { fillMessagePage, projectMessagePage } from '../v2/projection/messages.js';
import { readResponseBody } from './envelope.js';
import { createOpenCodeClient } from './index.js';

const runtime = { generation: 2, baseUrl: 'http://fixture.invalid', epoch: 1 };
const session = (metadata = {}) => ({ id: 'ses_a', location: { directory: '/repo' }, time: { created: 1, updated: 1 }, metadata });
const user = (id, time = 100) => ({ id, type: 'user', text: id, time: { created: time } });
const assistant = (id, time = 100) => ({ id, type: 'assistant', agent: 'build', model: { id: 'm', providerID: 'p' }, content: [], time: { created: time } });
const nativePager = (rows) => async ({ cursor, limit }) => {
  const end = cursor === undefined ? rows.length : Number(cursor);
  const start = Math.max(0, end - limit);
  return { data: rows.slice(start, end).reverse(), cursor: { next: String(start) } };
};
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

describe('owned native session deletion', () => {
  it('requires constructor delegation and never sends a raw native DELETE', async () => {
    let fetched = false;
    const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async () => { fetched = true; throw new Error('raw DELETE'); } });
    await expect(client.sessions.remove('ses_a', {directory:'/repo'})).rejects.toMatchObject({code:'capability_unavailable'});
    expect(fetched).toBe(false);
  });
  it('captures the exact web scope and propagates partial failure and runtime replacement', async () => {
    let current = runtime, scope;
    const failure = Object.assign(new Error('partial deletion'),{code:'native_removal_unconfirmed'});
    let execute = async () => true;
    const client = createOpenCodeClient({getRuntime:()=>current,
      withNativeWebOperation:async(spec,action)=>{scope=spec;return action();},
      removeNativeSession:async(id,options)=>{expect(id).toBe('ses_a');expect(options.directory).toBe('/repo');return execute();}});
    await expect(client.sessions.remove('ses_a',{directory:'/repo'})).resolves.toBe(true);
    expect(scope).toEqual({operation:'sessions.remove',method:'DELETE',path:'/api/session/ses_a',directory:'/repo'});
    execute=async()=>{throw failure;};await expect(client.sessions.remove('ses_a',{directory:'/repo'})).rejects.toBe(failure);
    execute=async()=>{current={...runtime,epoch:2};return true;};
    await expect(client.sessions.remove('ses_a',{directory:'/repo'})).rejects.toMatchObject({code:'opencode_runtime_changed'});
  });
});

// These streams deliberately ignore fetch's signal, exercising the client's
// body deadline and cancellation rather than the platform fetch implementation.
describe('bounded body reads', () => {
  it.each([2])('caps success, errors and allowed 404 bodies on generation %s', async (generation) => {
    for (const status of [200, 500, 404]) {
      const events = [];
      let cancelled = false;
      const client = createOpenCodeClient({ getRuntime: () => ({ ...runtime, generation }), fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(4096))); },
        cancel() { cancelled = true; },
      }), { status }) });
      await expect(client.sessions.get('ses_a', { allowNotFound: true, maxResponseBytes: 128, onResponseRead: (event) => events.push(event) }))
        .rejects.toMatchObject({ code: 'opencode_response_too_large', statusCode: 503 });
      expect(cancelled).toBe(true);
      expect(events).toEqual([{ phase: 'start', bytes: 0 }, { phase: 'chunk', bytes: 4096 }, { phase: 'end', bytes: 4096 }]);
    }
  });

  it.each([2])('propagates observer failures and read deadlines on generation %s', async (generation) => {
    const failure = new Error('aggregate read budget');
    const client = createOpenCodeClient({ getRuntime: () => ({ ...runtime, generation }), fetchImpl: async () => Response.json({ error: 'failed' }, { status: 500 }) });
    await expect(client.sessions.get('ses_a', { onResponseRead(event) { if (event.phase === 'chunk') throw failure; } })).rejects.toBe(failure);
    const hanging = createOpenCodeClient({ getRuntime: () => ({ ...runtime, generation }), fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 500 }) });
    await expect(hanging.sessions.get('ses_a', { timeoutMs: 5 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('accounts for empty bodies and preserves cancellation', async () => {
    for (const status of [200, 204]) {
      const events = [];
      expect(await readResponseBody(new Response(null, { status }), { maxResponseBytes: 128, onResponseRead: (event) => events.push(event) })).toMatchObject({ empty: true });
      expect(events).toEqual([{ phase: 'start', bytes: 0 }, { phase: 'end', bytes: 0 }]);
    }
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = readResponseBody(new Response(new ReadableStream({ start() {} })), { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it.each([2])('health preserves bounded error reads and caller cancellation on generation %s', async (generation) => {
    const client = createOpenCodeClient({ getRuntime: () => ({ ...runtime, generation }), fetchImpl: async () => new Response('x'.repeat(4096), { status: 500 }) });
    await expect(client.health.probe({ maxResponseBytes: 128 })).rejects.toMatchObject({ code: 'opencode_response_too_large' });
    const controller = new AbortController(), reason = new Error('health caller cancelled');
    const hanging = createOpenCodeClient({ getRuntime: () => ({ ...runtime, generation }), fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
    const pending = hanging.health.probe({ signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(hanging.health.probe({ timeoutMs: 5 })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('settles parallel health readers when an observer budget fails', async () => {
    const failure = new Error('parallel total budget'), events = [];
    let cancelled = false;
    const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async (url) => String(url).endsWith('/devryan/ready')
      ? Response.json({ ready: true }) : new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } })) });
    await expect(client.health.probe({ onResponseRead(event) { events.push(event); if (event.phase === 'chunk') throw failure; } })).rejects.toBe(failure);
    expect(cancelled).toBe(true);
    expect(events.filter((event) => event.phase === 'start')).toHaveLength(2);
    expect(events.filter((event) => event.phase === 'end')).toHaveLength(2);
  });

  it('does not turn failed cold status recovery into busy success', async () => {
    const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async (url) => new URL(url).pathname === '/api/session/active'
      ? Response.json({ data: { ses_a: { type: 'running' } } }) : new Response('x'.repeat(4096), { status: 500 }) });
    await expect(client.sessions.status({}, { maxResponseBytes: 128 })).rejects.toMatchObject({ code: 'opencode_response_too_large' });
  });

  it('preserves one aggregate observer across native pagination', async () => {
    const rows = Array.from({ length: 202 }, (_, index) => user(`msg_${index}`));
    const pager = nativePager(rows);
    let bytes = 0;
    const failure = new Error('total budget');
    const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname === '/api/session/ses_a') return Response.json({ data: session() });
      return Response.json(await pager({ cursor: target.searchParams.get('cursor') ?? undefined, limit: Number(target.searchParams.get('limit')) }));
    } });
    await expect(client.sessions.messages('ses_a', {}, { maxResponseBytes: 100000, onResponseRead(event) {
      if (event.phase === 'chunk') { bytes += event.bytes; if (bytes > 1000) throw failure; }
    } })).rejects.toBe(failure);
  });
});

describe('native runtime info', () => {
  it('reads only canonical native info and preserves the observed version', async () => {
    const calls = [];
    const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      return Response.json({ version: '2.0.21', pid: 123 });
    } });
    expect(await client.health.runtimeInfo()).toEqual({ version: '2.0.21' });
    expect(calls).toEqual(['/api/info']);
  });

  it.each([null, {}, { version: null }, { version: '' }, { version: ' 2.0.20' }, { data: { version: '2.0.20' } }])(
    'rejects malformed native info %j', async (body) => {
      const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async () => Response.json(body) });
      await expect(client.health.runtimeInfo()).rejects.toMatchObject({ code: 'opencode_invalid_response', statusCode: 502 });
    });

  it('rejects a legacy identity without a request', async () => {
    let calls = 0;
    const client = createOpenCodeClient({ getRuntime: () => ({ ...runtime, generation: 1 }), fetchImpl: async () => { calls++; return Response.json({ version: '2.0.20' }); } });
    await expect(client.health.runtimeInfo()).rejects.toMatchObject({ code: 'opencode_generation_invalid', statusCode: 503 });
    expect(calls).toBe(0);
  });

  it('preserves response bounds, observers, HTTP failures and not-found failures', async () => {
    for (const status of [200, 500, 404]) {
      const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async () => new Response('x'.repeat(4096), { status }) });
      await expect(client.health.runtimeInfo({ maxResponseBytes: 128, allowNotFound: true })).rejects.toMatchObject({ code: 'opencode_response_too_large' });
    }
    const failure = new Error('runtime info aggregate budget');
    const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async () => Response.json({ version: '2.0.20' }) });
    await expect(client.health.runtimeInfo({ onResponseRead(event) { if (event.phase === 'chunk') throw failure; } })).rejects.toBe(failure);
    const missing = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async () => Response.json({ _tag: 'RouteNotFound' }, { status: 404 }) });
    await expect(missing.health.runtimeInfo({ allowNotFound: true })).rejects.toMatchObject({ code: 'opencode_not_found', statusCode: 404 });
  });

  it('preserves caller abort, body deadline and same-URL replacement fencing', async () => {
    const hanging = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
    const controller = new AbortController(), reason = new Error('cancel runtime info');
    const pending = hanging.health.runtimeInfo({ signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(hanging.health.runtimeInfo({ timeoutMs: 5 })).rejects.toMatchObject({ name: 'TimeoutError' });
    let current = { ...runtime };
    const response = deferred();
    const client = createOpenCodeClient({ getRuntime: () => current, fetchImpl: async () => response.promise });
    const replaced = client.health.runtimeInfo();
    await Promise.resolve();
    current = { ...current, epoch: 2 };
    response.resolve(Response.json({ version: '2.0.20' }));
    await expect(replaced).rejects.toMatchObject({ code: 'opencode_runtime_changed', statusCode: 503 });
  });
});

describe('native sequence ownership', () => {
  it('single and paginated reads exclude a later equal-timestamp user', async () => {
    const rows = [user('msg_before', 1000), assistant('msg_target', 10), user('msg_later', 10)];
    const pager = nativePager(rows);
    const requests = [];
    const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async (url) => {
      const target = new URL(url); requests.push(target);
      if (target.pathname === '/api/session/ses_a') return Response.json({ data: session() });
      if (target.pathname.endsWith('/msg_target')) return Response.json({ data: rows[1] });
      return Response.json(await pager({ cursor: target.searchParams.get('cursor') ?? undefined, limit: Number(target.searchParams.get('limit')) }));
    } });
    const single = await client.sessions.message('ses_a', 'msg_target');
    const page = await client.sessions.messages('ses_a', { limit: 2 });
    for (const record of [single, page.records.find((record) => record.info.id === 'msg_target')]) {
      expect(record.info.parentID).toBe('msg_before');
      expect(record.turnOwnership).toEqual({ source: 'native-sequence', userMessageID: 'msg_before' });
    }
    expect(requests.every((target) => !target.searchParams.has('type'))).toBe(true);
  });

  it.each(['synthetic', 'compaction'])('finds a %s parent across the older edge', async (type) => {
    const rows = [{ id: 'msg_parent', type, text: 'continue', time: { created: 999 } }, assistant('msg_target', 1)];
    const page = await fillMessagePage({ limit: 1, fetchPage: nativePager(rows), context: { sessionID: 'ses_a' } });
    expect(page.records[0].info.parentID).toBe('msg_parent');
    expect(page.records[0].turnOwnership).toEqual({ source: 'native-sequence', userMessageID: 'msg_parent' });
    expect(page.nextCursor).toBe('v2:1');
  });

  it('display-only timestamp inference never grants ownership', () => {
    const page = projectMessagePage([assistant('msg_target')], { sessionID: 'ses_a', userIndex: [{ deliveredAt: 100, userID: 'msg_guess' }] });
    expect(page.records[0].info.parentID).toBe('msg_guess');
    expect(page.records[0].turnOwnership).toBeUndefined();
  });

  it('fails closed when exact parent lookbehind exceeds its budget', async () => {
    let calls = 0;
    await expect(fillMessagePage({ limit: 1, context: { sessionID: 'ses_a' }, fetchPage: async () => ({
      data: Array.from({ length: calls++ === 0 ? 1 : 200 }, () => assistant('msg_target')), cursor: { next: `page-${calls}` },
    }) })).rejects.toMatchObject({ code: 'opencode_unavailable', statusCode: 503, retryable: false });
    expect(calls).toBe(51);
  });

  it('fails closed on malformed or repeating parent cursors', async () => {
    await expect(fillMessagePage({ limit: 1, context: { sessionID: 'ses_a' }, fetchPage: async () => ({ data: [assistant('msg_target')], cursor: { next: 17 } }) }))
      .rejects.toMatchObject({ code: 'opencode_invalid_response' });
    let calls = 0;
    await expect(fillMessagePage({ limit: 1, context: { sessionID: 'ses_a' }, fetchPage: async () => ({
      data: Array.from({ length: calls++ === 0 ? 1 : 200 }, () => assistant('msg_target')), cursor: { next: 'same' },
    }) })).rejects.toMatchObject({ code: 'opencode_invalid_response' });
    expect(calls).toBe(2);
  });
});

describe('archive metadata ownership', () => {
  it('waits for the admission owner and preserves its completed metadata write', async () => {
    let metadata = { devryan: { todo: [] }, other: 'preserve' };
    const started = deferred(), release = deferred();
    const requests = [];
    const deps = { getRuntime: () => runtime, fetchImpl: async (_url, init) => {
      requests.push(init.method);
      if (init.method === 'PATCH') { metadata = JSON.parse(init.body).metadata; return new Response(null, { status: 204 }); }
      return Response.json({ data: session(metadata) });
    } };
    const admission = createOpenCodeAdmission(deps);
    const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });
    const selection = admission.withSessionLock('ses_a', async () => {
      started.resolve(); await release.promise; metadata = { ...metadata, devryan: { ...metadata.devryan, todo: ['kept'] } };
    });
    await started.promise;
    const archived = client.sessions.archive('ses_a', 123);
    await Promise.resolve();
    expect(requests).toEqual([]);
    release.resolve();
    await selection;
    await archived;
    expect(metadata).toEqual({ devryan: { todo: ['kept'], archive: { sessionID: 'ses_a', at: 123 } }, other: 'preserve' });
    expect(requests).toEqual(['GET', 'PATCH', 'GET']);
  });

  it('requires the owner before any metadata read or write', async () => {
    let fetches = 0;
    const client = createOpenCodeClient({ getRuntime: () => runtime, fetchImpl: async () => { fetches += 1; return Response.json({ data: session() }); } });
    await expect(client.sessions.archive('ses_a', 123)).rejects.toMatchObject({ code: 'opencode_unavailable', statusCode: 503 });
    expect(fetches).toBe(0);
  });
});


it('single-message lookbehind crosses an entire status-only native page without borrowing its parent', async () => {
  const metadata={devryan:{v:1,origin:'interview',statusOnly:true}};
  const target=assistant('msg_target',3),rows=[user('msg_original',1),
    ...Array.from({length:200},(_,n)=>({id:'msg_status_'+n,type:'synthetic',metadata,text:'status',time:{created:2}})),target];
  const pager=nativePager(rows),requests=[];
  const client=createOpenCodeClient({getRuntime:()=>runtime,fetchImpl:async url=>{
    const path=new URL(url);requests.push(path);
    if(path.pathname==='/api/session/ses_a')return Response.json({data:session()});
    if(path.pathname.endsWith('/msg_target'))return Response.json({data:target});
    return Response.json(await pager({cursor:path.searchParams.get('cursor')??undefined,limit:Number(path.searchParams.get('limit'))}));
  }});
  const record=await client.sessions.message('ses_a','msg_target');
  expect(record.info.parentID).toBe('msg_original');
  expect(record.turnOwnership).toEqual({source:'native-sequence',userMessageID:'msg_original'});
  expect(requests.filter(url=>url.pathname.endsWith('/message'))).toHaveLength(2);
});
