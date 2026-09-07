import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';
import { createManagedTaskRecord, toManagedTaskEvent } from '../../packages/orchestration-runtime/contract.js';
import { createManagedTaskResultEnvelope, assertManagedTaskResultEnvelopeMatchesTask } from '../../packages/orchestration-runtime/result-envelope.js';

export function createQaManagedTaskReadModel({ transport, directory, rootSessionID, children, agent = 'builder', now = Date.now() }) {
  assert.equal(transport, 'fixture', 'Managed task visual data requires fixture transport');
  assert.ok(Array.isArray(children) && children.length === 2 && new Set(children.map(child => child.sessionID)).size === 2);
  const records = children.map((child, index) => {
    assert.equal(child.parentSessionID, rootSessionID, 'Visual child must belong to the exact fixture root');
    assert.ok(child.sessionID && child.userMessageID && child.assistantMessageID);
    const status = index === 0 ? 'running' : 'completed';
    assert.equal(child.status, status, 'Visual task status must match the canonical fixture child');
    const base = createManagedTaskRecord({ taskId: `dvr_task_qa_visual_${rootSessionID}_${index + 1}`,
      idempotencyKey: `qa-visual-${index + 1}`, rootSessionId: rootSessionID, parentTaskId: null,
      childSessionId: child.sessionID, dispatchCallId: `call_qa_visual_${rootSessionID}_${index + 1}`,
      directory, sequence: index + 1, mode: agent, providerId: 'fixture', modelId: 'fixture-model',
      agent: child.agent ?? 'build', variant: null, label: index === 0 ? 'Review task ordering and persistence' : 'Inspect responsive task controls',
      prompt: 'Deterministic task read-model fixture; no scheduler execution.', attempt: 1, priorTaskId: null,
      executionKind: 'start', createdAt: now, timeoutAt: now + 60000 });
    const task = { ...base, status, startedAt: now + 1, finishedAt: status === 'completed' ? now + 2 : null,
      childPromptedAt: now + 1, firstAssistantPartAt: now + 1,
      recoverablePreview: status === 'completed' ? 'The fixture child completed its deterministic responsive-control review.' : '',
      canonicalRefs: [{ type: 'session', id: child.sessionID }, { type: 'message', id: child.assistantMessageID }] };
    const resultEnvelope = status === 'completed'
      ? createManagedTaskResultEnvelope(task, { sequence: index + 1, createdAt: now + 2, resumable: false }) : null;
    if (resultEnvelope) assertManagedTaskResultEnvelopeMatchesTask(task, resultEnvelope);
    const event = toManagedTaskEvent(task, resultEnvelope);
    return { task, resultEnvelope, event, child };
  });
  return { source: 'production runtime-shaped visual read model; scheduler execution, disposition and barriers are not simulated',
    directory, rootSessionID, records,
    snapshot: { available: true, bridgeReady: false, recoveryWarning: null,
      tasks: records.map(record => record.event.properties.task),
      resultEnvelopes: records.flatMap(record => record.resultEnvelope ? [record.resultEnvelope] : []) } };
}

export function resolveQaManagedTaskRead({ model, origin, request }) {
  const url = new URL(request.url);
  const body = request.postData ?? null;
  const reject = reason => ({ accepted: false, reason, status: 501, body: { error: { code: 'unsupported_visual_fixture_request', message: reason } } });
  if (url.origin !== origin || request.method !== 'GET' || body !== null) return reject('Only same-origin GET task read models are supported');
  if (url.pathname === '/api/orchestration/snapshot') {
    if ([...url.searchParams.keys()].some(key => key !== 'rootSessionId')
      || url.searchParams.getAll('rootSessionId').length > 1
      || (url.searchParams.has('rootSessionId') && url.searchParams.get('rootSessionId') !== model.rootSessionID)) return reject('Snapshot root is outside the visual fixture');
    return { accepted: true, status: 200, body: structuredClone(model.snapshot) };
  }
  const record = model.records.find(item => url.pathname === `/api/orchestration/task/${encodeURIComponent(item.task.taskId)}`);
  if (!record || [...url.searchParams.keys()].some(key => !['rootSessionId', 'directory'].includes(key))
    || url.searchParams.getAll('rootSessionId').length !== 1 || url.searchParams.get('rootSessionId') !== model.rootSessionID
    || url.searchParams.getAll('directory').length > 1
    || (url.searchParams.has('directory') && url.searchParams.get('directory') !== model.directory)) return reject('Task read is outside the visual fixture');
  return { accepted: true, status: 200, body: { task: structuredClone(record.event.properties.task),
    ...(record.resultEnvelope ? { resultEnvelope: structuredClone(record.resultEnvelope) } : {}) } };
}

const FETCH_EVIDENCE_KEY = '__devryanQaManagedReadFixture';

const assertFixtureOrigin = ({ transport, origin }) => {
  assert.equal(transport, 'fixture', 'Managed task interception requires fixture transport');
  const parsedOrigin = new URL(origin);
  assert.ok(parsedOrigin.protocol === 'http:' && parsedOrigin.hostname === '127.0.0.1' && parsedOrigin.origin === origin,
    'Managed task interception must use the exact isolated loopback origin');
};

export function createQaManagedTaskFetchScript({ transport, origin, model }) {
  assertFixtureOrigin({ transport, origin });
  return `(() => {
    const origin=${JSON.stringify(origin)},key=${JSON.stringify(FETCH_EVIDENCE_KEY)};
    if(location.origin!==origin)return;
    if(globalThis[key])throw new Error('Managed visual read fixture is already installed');
    const originalFetch=globalThis.fetch.bind(globalThis),model=${JSON.stringify(model)};
    const resolve=${resolveQaManagedTaskRead.toString()};
    const state={source:'fixture-only scoped fetch transport; no scheduler execution',model,requests:[],failures:[],closed:false};
    const wrapper=async(input,init) => {
      const isRequest=typeof Request!=='undefined'&&input instanceof Request;
      const url=new URL(isRequest?input.url:String(input),location.href);
      if(state.closed||!(url.pathname==='/api/orchestration'||url.pathname.startsWith('/api/orchestration/')))return originalFetch(input,init);
      const method=String(init?.method??(isRequest?input.method:'GET')).toUpperCase();
      const hasBody=init?.body!=null||(init?.body===undefined&&isRequest&&input.body!==null);
      const request={url:url.href,method,postData:hasBody?'[body-present]':null};
      const response=state.requests.length>=128
        ?{accepted:false,reason:'Managed task visual read request bound exceeded',status:501,body:{error:{code:'unsupported_visual_fixture_request',message:'Request bound exceeded'}}}
        :resolve({model:state.model,origin,request});
      if(state.requests.length<128)state.requests.push({method,url:url.href,requestBody:request.postData,
        accepted:response.accepted,responseStatus:response.status,responseBody:response.body});
      if(!response.accepted&&state.failures.length<128)state.failures.push(response.reason);
      return new Response(JSON.stringify(response.body),{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    };
    state.restore=()=>{state.closed=true;if(globalThis.fetch===wrapper)globalThis.fetch=originalFetch;};
    Object.defineProperty(globalThis,key,{value:state,configurable:true});
    globalThis.fetch=wrapper;
  })();`;
}

export async function installQaManagedTaskReadModel({ transport, cdp, origin, model }) {
  assertFixtureOrigin({ transport, origin });
  assert.equal(await evaluate(cdp, 'location.origin'), origin, 'Task read fixture must target the known isolated page');
  const evidence = { source: 'fixture-only scoped fetch transport installed before the real reload; no scheduler execution',
    requests: [], failures: [], installedAfterReload: false, closed: false };
  let { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: createQaManagedTaskFetchScript({ transport, origin, model }),
  });
  const readEvidence = async () => {
    const value = await evaluate(cdp, `(() => {const state=globalThis[${JSON.stringify(FETCH_EVIDENCE_KEY)}];return state?{requests:state.requests,failures:state.failures}:null;})()`);
    if (value) {
      evidence.installedAfterReload = true;
      evidence.requests.splice(0, evidence.requests.length, ...value.requests);
      evidence.failures.splice(0, evidence.failures.length, ...value.failures);
    }
    return value;
  };
  return { evidence, readEvidence,
    updateModel: async nextModel => {
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      ({ identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: createQaManagedTaskFetchScript({ transport, origin, model: nextModel }),
      }));
      await evaluate(cdp, `globalThis[${JSON.stringify(FETCH_EVIDENCE_KEY)}].model=${JSON.stringify(nextModel)}`);
    },
    assertHealthy: async () => {
      await readEvidence();
      assert.equal(evidence.installedAfterReload, true, 'Task read fixture must be installed by a real page reload');
      assert.deepEqual(evidence.failures, [], 'Unexpected task visual requests must fail');
    },
    close: async () => {
      await readEvidence();
      await evaluate(cdp, `globalThis[${JSON.stringify(FETCH_EVIDENCE_KEY)}]?.restore()`);
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      evidence.closed = true;
    } };
}
