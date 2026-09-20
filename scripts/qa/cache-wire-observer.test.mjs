import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeCacheStudy, initializeCacheCampaign, reserveCacheAttempt, ownedQaDirectory, readCacheAttempts } from './cache-study.mjs';
import { createQaWireObserver } from './cache-wire-observer.mjs';
import { createWireUsageParser, projectWireRequest } from './cache-wire-evidence.mjs';
import { selectTitleEfficiencyVariant, isLoopbackCacheOrigin } from '../../packages/shared-runtime/lib/cache-efficiency-policy.js';
import QaTitleEfficiencyPlugin, { applyConversationAffinity, titleScreenCases, gradeTitleScreen } from './cache-efficiency-experiments.mjs';
import { runCachePairs } from './cache-pair-runner.mjs';

const route = { id: 'grok-api', provider: 'xai', model: 'grok-4.6', auth: 'api_key', transport: 'chat_completions', origin: 'http://127.0.0.1:9123', path: '/v1/chat/completions' };
const liveRoute = { ...route, origin: 'https://api.x.ai', experiments: { titleEffort: true } };
liveRoute.qualification = { ...liveRoute, source: 'final_wire', evidence: 'live', allAttemptsObserved: true, redirectsBlocked: true,
  runtimeVersion: '1.18.31', baselineEffort: 'medium', verifiedTitleEfforts: ['low'], responseModel: 'grok-4.6-snapshot' };
const setup = async ({ live = false, routes = [live ? liveRoute : route] } = {}) => {
  const base = fileURLToPath(new URL('../../.cache/qa/', import.meta.url));
  await fs.mkdir(base, { recursive: true });
  const ownerRoot = await fs.mkdtemp(path.join(base, 'cache-observer-test-'));
  const runtimeRoot = live ? path.join(ownerRoot, 'profile') : ownerRoot, home = path.join(runtimeRoot, 'home');
  if (live) {
    const campaignHome = path.join(ownerRoot, 'campaign-home');
    await fs.mkdir(campaignHome); await fs.writeFile(path.join(campaignHome, '.devryan-qa-home'), 'owned QA home\n');
    await initializeCacheCampaign({ campaignRoot: ownerRoot, home: campaignHome, routes, runtimeVersion: '1.18.31' });
    await fs.mkdir(runtimeRoot);
  }
  await fs.mkdir(home); await fs.writeFile(path.join(home, '.devryan-qa-home'), 'owned QA home\n');
  await initializeCacheStudy({ runtimeRoot, home, routes, runtimeVersion: '1.18.31', campaignRoot: live ? ownerRoot : undefined });
  return { runtimeRoot, home, campaignRoot: live ? ownerRoot : undefined, clean: () => fs.rm(ownerRoot, { recursive: true, force: true }) };
};
const request = JSON.stringify({ model: route.model, messages: [{ role: 'user', content: 'PRIVATE PROMPT' }], reasoning_effort: 'medium' });
const sse = 'data: ' + JSON.stringify({ id: 'resp1', model: route.model, choices: [{ delta: { content: 'PRIVATE ANSWER' } }],
  usage: { prompt_tokens: 32, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 94 }, prompt_tokens_details: { cached_tokens: 16 } } }) + '\r\n\r\ndata: [DONE]\r\n\r\n';

test('requires real owned QA directories and is a no-op without them', async () => {
  const fetchImpl = () => {};
  assert.equal((await createQaWireObserver({ fetchImpl })).fetch, fetchImpl);
  assert.equal(await ownedQaDirectory(), null);
  const owned = await setup();
  try {
    await assert.rejects(ownedQaDirectory(owned.runtimeRoot, path.dirname(owned.runtimeRoot)), /owned/);
    await assert.rejects(initializeCacheStudy({ ...owned, routes: [route] }), { code: 'EEXIST' });
  } finally { await owned.clean(); }
});
test('preserves request arguments and response bytes, status and headers; retains no contents', async () => {
  const owned = await setup();
  let received;
  const observer = await createQaWireObserver({ ...owned, context: () => ({ request: { sessionID: 's1', purpose: 'main', use: 'first' } }),
    fetchImpl: async (...args) => { received = args; return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-test': 'same' } }); } });
  const init = { method: 'POST', body: request, headers: { authorization: 'SECRET CREDENTIAL' } };
  try {
    const result = await observer.fetch(route.origin + route.path, init);
    assert.equal(received[1], init); assert.equal(result.headers.get('x-test'), 'same');
    assert.equal(await result.text(), sse);
    await observer.close();
    const text = await fs.readFile(path.join(owned.runtimeRoot, 'cache-wire.ndjson'), 'utf8');
    assert.equal(/PRIVATE|SECRET|authorization/.test(text), false);
    const rows = text.trim().split('\n').map(JSON.parse), observation = rows.at(-1).usageObservation;
    assert.equal(observation.responseModel, route.model); assert.equal(observation.tokens.totalOutput, 103);
    assert.equal(observation.tokens.cacheWrite, null); assert.equal(observation.tokens.cacheRead, 16);
    assert.equal(observation.timing.firstToken.origin, 'client_wire');
    assert.equal(observation.purpose, 'main'); assert.equal(observation.sessionID, 's1');
  } finally { await owned.clean(); }
});
test('does not drain ahead of the consumer and propagates cancellation', async () => {
  const owned = await setup(); let pulls = 0, cancelled;
  const observer = await createQaWireObserver({ ...owned, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode(': ping\n\n')); },
    cancel(reason) { cancelled = reason; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await observer.fetch(route.origin + route.path, { body: request });
    assert.equal(pulls, 0);
    const reader = response.body.getReader(); await reader.read(); assert.equal(pulls, 1);
    await reader.cancel('test-stop'); assert.equal(cancelled, 'test-stop');
    await observer.close();
    const rows = (await fs.readFile(path.join(owned.runtimeRoot, 'cache-wire.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).usageObservation.status, 'aborted');
  } finally { await owned.clean(); }
});
test('reservations survive restart/concurrency and enforce phase/route caps before dispatch', async () => {
  const owned = await setup(); let dispatched = 0;
  try {
    const attempts = await Promise.all(Array.from({ length: 16 }, () => reserveCacheAttempt(owned.runtimeRoot, route.id, 'aa')));
    assert.equal(new Set(attempts.map(a => a.ordinal)).size, 16);
    const observer = await createQaWireObserver({ ...owned, fetchImpl: async () => { dispatched++; return new Response('ok'); } });
    await assert.rejects(observer.fetch(route.origin + route.path, { body: request }), { code: 'CACHE_ATTEMPT_CAP' });
    assert.equal(dispatched, 0); await observer.close();
    for (let i = 0; i < 24; i++) await reserveCacheAttempt(owned.runtimeRoot, route.id, 'title');
    await assert.rejects(reserveCacheAttempt(owned.runtimeRoot, route.id, 'title'), { code: 'CACHE_ATTEMPT_CAP' });
  } finally { await owned.clean(); }
});
test('response capture is bounded and accepts CRLF split across arbitrary chunks', () => {
  const p = createWireUsageParser({ route, metadata: { observationID: 'a' } });
  for (const byte of new TextEncoder().encode(sse)) p.push(Uint8Array.of(byte), 5);
  assert.equal(p.finish('complete', 10).usageObservation.tokens.cacheRead, 16);
  const limited = createWireUsageParser({ route, metadata: { observationID: 'a' }, maximumFrameBytes: 10 });
  limited.push(new TextEncoder().encode(sse), 5);
  assert.equal(limited.finish('complete', 10).gap, 'response_frame_limit');
});
test('xAI Responses output includes reasoning and API cost ticks stay separate from OAuth billing', () => {
  const raw = JSON.stringify({ model: route.model, id: 'response1', usage: { input_tokens: 131, output_tokens: 624,
    output_tokens_details: { reasoning_tokens: 246 }, input_tokens_details: { cached_tokens: 128 }, cost_in_usd_ticks: 37756000 } });
  const api = createWireUsageParser({ route: { ...route, transport: 'responses' }, sse: false, metadata: { observationID: 'a' } });
  api.push(new TextEncoder().encode(raw), 1);
  const result = api.finish('complete', 2).usageObservation;
  assert.equal(result.tokens.totalOutput, 624); assert.equal(result.tokens.output, 378);
  assert.deepEqual(result.cost, { amount: 0.0037756, currency: 'USD', provenance: 'provider_billed' });
  const oauth = createWireUsageParser({ route: { ...route, auth: 'oauth', transport: 'responses' }, sse: false, metadata: { observationID: 'b' } });
  oauth.push(new TextEncoder().encode(raw), 1);
  assert.equal(oauth.finish('complete', 2).usageObservation.cost.provenance, 'unknown');
});
test('hashes ordered prefixes and cache parameters, including permission/history changes', () => {
  const value = { model: route.model, tools: [{ name: 'read' }, { name: 'write' }], messages: [{ role: 'system', content: 'PRIVATE' }, { role: 'user', content: 'one' }] };
  const a = projectWireRequest(JSON.stringify(value));
  const b = projectWireRequest(JSON.stringify({ ...value, messages: [...value.messages, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }] }));
  assert.deepEqual(b.history.slice(0, a.history.length), a.history); assert.deepEqual(b.tools, a.tools);
  assert.notDeepEqual(projectWireRequest(JSON.stringify({ ...value, tools: [value.tools[0]] })).tools, a.tools);
  assert.notDeepEqual(projectWireRequest(JSON.stringify({ ...value, messages: [{ role: 'user', content: 'compacted' }] })).history, a.history);
  assert.equal(JSON.stringify(a).includes('PRIVATE'), false);
});
test('title effort requires matching live qualification; affinity preserves explicit identifiers and isolates helpers', () => {
  const selection = { provider: route.provider, model: route.model, runtimeVersion: '1.18.31', sessionID: 's1', variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' } } };
  assert.equal(selectTitleEfficiencyVariant(route, selection), null);
  const enabled = { ...liveRoute, experiments: { titleEffort: true, conversationAffinity: true }, qualification: { ...liveRoute,
    source: 'final_wire', evidence: 'live', allAttemptsObserved: true, runtimeVersion: '1.18.31', verifiedTitleEfforts: ['low'] } };
  assert.equal(selectTitleEfficiencyVariant(enabled, selection).variant, 'low');
  assert.equal(selectTitleEfficiencyVariant({ ...enabled, qualification: { ...enabled.qualification, evidence: 'fixture' } }, selection), null);
  assert.equal(selectTitleEfficiencyVariant(enabled, { ...selection, runtimeVersion: 'different' }), null);
  assert.equal(selectTitleEfficiencyVariant({ ...enabled, origin: 'https://other.example' }, selection), null);
  assert.equal(selectTitleEfficiencyVariant({ ...enabled, path: '/v1/responses' }, selection), null);
  assert.equal(selectTitleEfficiencyVariant({ ...enabled, origin: route.origin, qualification: { ...enabled.qualification, origin: route.origin } }, selection), null);
  const a = { headers: {} }, b = { headers: {} }, explicit = { headers: { 'X-Grok-Conv-Id': 'existing' } };
  applyConversationAffinity(enabled, selection, a); applyConversationAffinity(enabled, { ...selection, sessionID: 'helper' }, b);
  assert.notEqual(a.headers['x-grok-conv-id'], b.headers['x-grok-conv-id']);
  assert.equal(applyConversationAffinity(enabled, selection, explicit), false); assert.equal(explicit.headers['X-Grok-Conv-Id'], 'existing');
});
test('eight title pairs are only a rejection screen and preserve long and multilingual source text', () => {
  const cases = titleScreenCases('fixture'); assert.equal(cases.length, 8); assert.ok(cases[2].text.length > 20000);
  const pair = { control: { valid: true, qualityAccepted: true, repairs: 0, requestErrors: 0 }, candidate: { valid: true, qualityAccepted: true, repairs: 0, requestErrors: 0 } };
  assert.equal(gradeTitleScreen(Array(8).fill(pair)), 'not_rejected');
  assert.equal(gradeTitleScreen([pair]), 'incomplete');
  assert.equal(gradeTitleScreen([{ ...pair, candidate: { ...pair.candidate, repairs: 1 } }]), 'rejected');
  assert.equal(gradeTitleScreen([{ control: { ...pair.control, repairs: null }, candidate: { ...pair.candidate, repairs: 1 } }]), 'incomplete');
});
test('unqualified routes cannot dispatch paired runs and capped retries remain spent', async () => {
  const owned = await setup(); let sent = 0;
  try {
    const result = await runCachePairs({ ...owned, routeID: route.id, send: () => { sent++; } });
    assert.equal(result.status, 'observability_only'); assert.equal(sent, 0);
    const observer = await createQaWireObserver({ ...owned, fetchImpl: async () => { throw new Error('synthetic transport failure'); } });
    await assert.rejects(observer.fetch(route.origin + route.path, { body: request }), /synthetic/);
    await observer.close();
    assert.equal(JSON.parse(await fs.readFile(path.join(owned.runtimeRoot, 'cache-attempts.json'))).attempts.length, 1);
  } finally { await owned.clean(); }
});
test('the paired runner preserves source, records the gap, and does not resume a spent case set', async () => {
  const owned = await setup({ live: true }); let time = 0; const seen = [];
  const observer = await createQaWireObserver({ ...owned, now: () => time,
    context: async () => JSON.parse(await fs.readFile(path.join(owned.runtimeRoot, 'cache-context.json'), 'utf8')),
    fetchImpl: async () => new Response(sse.replaceAll(route.model, liveRoute.qualification.responseModel), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const send = async input => {
      seen.push(input);
      const response = await observer.fetch(liveRoute.origin + liveRoute.path, { redirect: 'error', body: JSON.stringify({ ...JSON.parse(request),
        reasoning_effort: input.experiment ? 'low' : 'medium', messages: [{ role: 'user', content: input.text }] }) });
      await response.text();
      return { valid: true, output: 'Fix cache accounting', responseModel: 'untrusted-adapter-value', effortMatched: false, repairs: 0, requestErrors: 99 };
    };
    const grade = async ({ rubric, samples }) => {
      assert.equal(rubric.version, 1); assert.equal(samples.length, 16);
      for (const sample of samples) assert.deepEqual(Object.keys(sample).sort(), ['id', 'output', 'source']);
      return samples.map(sample => ({ id: sample.id, accepted: true }));
    };
    const result = await runCachePairs({ ...owned, routeID: route.id, runtimeVersion: '1.18.31', phase: 'title', send, grade, now: () => time, wait: async ms => { time += ms; } });
    assert.equal(result.status, 'not_rejected'); assert.equal(result.pairs.length, 8);
    for (let i = 0; i < seen.length; i += 2) {
      assert.equal(seen[i].text, seen[i + 1].text);
      assert.equal(seen[i].context.titleEffortEnabled, i / 2 % 2 === 1);
      assert.notEqual(seen[i].context.titleEffortEnabled, seen[i + 1].context.titleEffortEnabled);
      assert.equal(seen[i].context.order, 'first'); assert.equal(seen[i + 1].context.order, 'warm');
      assert.equal(result.pairs[i / 2].actualGapMs, 2000);
    }
    assert.equal(new Set(seen.filter((_, i) => i % 2 === 0).map(item => item.text)).size, 8);
    assert.equal((await readCacheAttempts(owned.runtimeRoot)).length, 16);
    const evidence = (await fs.readFile(path.join(owned.runtimeRoot, 'cache-wire.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(evidence.every(row => row.usageObservation.purpose === 'unknown' && row.usageObservation.use === 'unknown'));
    await assert.rejects(runCachePairs({ ...owned, routeID: route.id, runtimeVersion: '1.18.31', phase: 'title', send, grade }), { code: 'EEXIST' });
  } finally { await observer.close(); await owned.clean(); }
});
test('simulated retention misses leave matching prefix hashes unexplained; bad frames never become usage', () => {
  const before = projectWireRequest(request), after = projectWireRequest(request);
  assert.equal(before.bodyHash, after.bodyHash);
  const parser = createWireUsageParser({ route, metadata: { observationID: 'retention-miss', use: 'warm' } });
  parser.push(new TextEncoder().encode('data: {"usage":{"prompt_tokens":10000,"prompt_tokens_details":{"cached_tokens":0}}}\n\n'), 3600000);
  const result = parser.finish('complete', 3600001);
  assert.equal(result.usageObservation.tokens.cacheRead, 0); assert.equal(result.usageObservation.use, 'warm');
  const bad = createWireUsageParser({ route, metadata: { observationID: 'bad' } });
  bad.push(new TextEncoder().encode('data: null\n\n'), 1);
  assert.equal(bad.finish('complete', 2).gap, 'invalid_response_frame');
  const failure = createWireUsageParser({ route, metadata: { observationID: 'failed' } });
  failure.push(new TextEncoder().encode('data: {"type":"error","error":{"message":"PRIVATE"}}\n\n'), 1);
  const failed = failure.finish('complete', 2);
  assert.equal(failed.usageObservation.status, 'failed'); assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
});

test('empty opening deltas do not start first-token timing on supported streams', () => {
  const shapes = [
    text => ({ type: 'response.output_text.delta', delta: text }),
    text => ({ type: 'content_block_delta', delta: { text } }),
    text => ({ choices: [{ delta: { content: text } }] }),
    text => ({ choices: [{ delta: { reasoning_content: text } }] }),
  ];
  for (const shape of shapes) {
    const parser = createWireUsageParser({ route, metadata: { observationID: 'timing' } });
    parser.push(new TextEncoder().encode('data: ' + JSON.stringify(shape('')) + '\n\n'), 100);
    parser.push(new TextEncoder().encode('data: ' + JSON.stringify(shape('token')) + '\n\n'), 250);
    assert.equal(parser.finish('complete', 300).usageObservation.timing.firstToken.at, 250);
  }
});
test('preserves midstream failures and signal aborts, including the original error identity', async () => {
  for (const abort of [false, true]) {
    const owned = await setup(), signal = new AbortController(), failure = new Error('synthetic upstream failure');
    let pulls = 0;
    const observer = await createQaWireObserver({ ...owned, fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal.addEventListener('abort', () => controller.error(init.signal.reason)); },
      pull(controller) { if (++pulls === 1) controller.enqueue(new TextEncoder().encode(': first\n\n')); else if (!abort) controller.error(failure); },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const response = await observer.fetch(route.origin + route.path, { body: request, signal: signal.signal });
      const reader = response.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), ': first\n\n');
      const pending = reader.read();
      if (abort) signal.abort(failure);
      await assert.rejects(pending, error => error === failure);
      await observer.close();
      const rows = (await fs.readFile(path.join(owned.runtimeRoot, 'cache-wire.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).usageObservation.status, abort ? 'aborted' : 'failed');
    } finally { await owned.clean(); }
  }
});
test('parser exceptions produce an evidence gap without changing response bytes', async () => {
  const owned = await setup();
  const observer = await createQaWireObserver({ ...owned, fetchImpl: async () => new Response(sse),
    parserFactory: () => ({ push() { throw new Error('PRIVATE parser detail'); }, finish() { throw new Error('PRIVATE parser detail'); } }) });
  try {
    assert.equal(await (await observer.fetch(route.origin + route.path, { body: request })).text(), sse);
    await observer.close();
    const text = await fs.readFile(path.join(owned.runtimeRoot, 'cache-wire.ndjson'), 'utf8');
    assert.ok(text.includes('response_parser_failure')); assert.equal(text.includes('PRIVATE'), false);
  } finally { await owned.clean(); }
});
test('live profiles require one shared parent ledger and cannot renew their route allocation', async () => {
  const owned = await setup({ live: true });
  try {
    const runtimeRoot = path.join(owned.campaignRoot, 'second-profile'), home = path.join(runtimeRoot, 'home');
    await fs.mkdir(home, { recursive: true }); await fs.writeFile(path.join(home, '.devryan-qa-home'), 'owned QA home\n');
    await assert.rejects(initializeCacheStudy({ runtimeRoot, home, routes: [liveRoute], runtimeVersion: '1.18.31' }), /shared parent campaign/);
    await initializeCacheStudy({ runtimeRoot, home, routes: [liveRoute], runtimeVersion: '1.18.31', campaignRoot: owned.campaignRoot });
    for (let index = 0; index < 16; index++) await reserveCacheAttempt(index % 2 ? runtimeRoot : owned.runtimeRoot, route.id, 'aa');
    await assert.rejects(reserveCacheAttempt(runtimeRoot, route.id, 'aa'), { code: 'CACHE_ATTEMPT_CAP' });
    assert.equal((await readCacheAttempts(owned.runtimeRoot)).length, 16);
  } finally { await owned.clean(); }
});
test('a qualified observer rejects unregistered inference routes while allowing unrelated fetches', async () => {
  const owned = await setup({ live: true }); let fetched = 0;
  const observer = await createQaWireObserver({ ...owned, fetchImpl: async () => { fetched++; return new Response('ok'); } });
  try {
    for (const url of [liveRoute.origin + '/v1/responses', liveRoute.origin + liveRoute.path + '/', 'https://unknown.example/inference']) {
      await assert.rejects(observer.fetch(url, { body: request, redirect: 'error' }), /Unregistered inference/);
    }
    assert.equal(fetched, 0); assert.equal((await readCacheAttempts(owned.runtimeRoot)).length, 0);
    assert.equal(await (await observer.fetch('https://docs.example/reference')).text(), 'ok');
    assert.equal(fetched, 1);
  } finally { await observer.close(); await owned.clean(); }
});
test('adapter assertions cannot substitute for missing wire observations', async () => {
  const owned = await setup({ live: true }); let calls = 0;
  try {
    const result = await runCachePairs({ ...owned, routeID: route.id, runtimeVersion: '1.18.31',
      send: async () => { calls++; return { valid: true, qualityAccepted: true, responseModel: route.model, effortMatched: true, repairs: 0 }; },
      wait: async () => {} });
    assert.equal(calls, 1); assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'wire_evidence_incomplete');
  } finally { await owned.clean(); }
});
test('model identity and mixed title effort leave a cell incomplete, not rejected', async () => {
  for (const mode of ['model', 'effort']) {
    const owned = await setup({ live: true });
    const observer = await createQaWireObserver({ ...owned,
      context: async () => JSON.parse(await fs.readFile(path.join(owned.runtimeRoot, 'cache-context.json'), 'utf8')),
      fetchImpl: async () => new Response(sse.replaceAll(route.model, mode === 'model' ? 'different-model' : liveRoute.qualification.responseModel),
        { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const result = await runCachePairs({ ...owned, routeID: route.id, runtimeVersion: '1.18.31', phase: 'title',
        send: async () => {
          await (await observer.fetch(liveRoute.origin + liveRoute.path, { body: request, redirect: 'error' })).text();
          if (mode === 'effort') await (await observer.fetch(liveRoute.origin + liveRoute.path,
            { body: request.replace('medium', 'high'), redirect: 'error' })).text();
          return { valid: true, repairs: 0, output: 'A title', effortMatched: true, responseModel: route.model };
        }, grade: async () => [], wait: async () => {} });
      assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'wire_evidence_incomplete');
    } finally { await observer.close(); await owned.clean(); }
  }
});

test('the title hook selects the exact run route and preserves unrelated options and main effort', async () => {
  const first = { ...liveRoute, experiments: { titleEffort: false } };
  const second = { ...liveRoute, id: 'second-route', origin: 'https://proxy.example' };
  second.qualification = { ...liveRoute.qualification, id: second.id, origin: second.origin };
  const owned = await setup({ live: true, routes: [first, second] });
  const saved = { DEVRYAN_QA_RUNTIME_ROOT: process.env.DEVRYAN_QA_RUNTIME_ROOT, DEVRYAN_QA_HOME: process.env.DEVRYAN_QA_HOME };
  try {
    process.env.DEVRYAN_QA_RUNTIME_ROOT = owned.runtimeRoot; process.env.DEVRYAN_QA_HOME = owned.home;
    const hooks = await QaTitleEfficiencyPlugin();
    await fs.writeFile(path.join(owned.runtimeRoot, 'cache-context.json'), JSON.stringify({ phase: 'title', routeID: second.id, titleEffortEnabled: true }));
    const model = { providerID: 'xai', id: route.model, variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' } } };
    const output = { options: { reasoningEffort: 'medium', preserve: true } };
    await hooks['chat.params']({ agent: 'devryan-title', model }, output);
    assert.deepEqual(output.options, { reasoningEffort: 'low', preserve: true });
    const main = { options: { reasoningEffort: 'medium' } };
    await hooks['chat.params']({ agent: 'builder', model }, main);
    assert.equal(main.options.reasoningEffort, 'medium');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await owned.clean();
  }
});

test('non-loopback admission does not depend on a live evidence label', async () => {
  const unlabelled = { ...liveRoute, qualification: undefined };
  const owned = await setup({ live: true, routes: [unlabelled] }); let fetched = 0;
  const observer = await createQaWireObserver({ ...owned, fetchImpl: async () => { fetched++; return new Response('ok'); } });
  try {
    for (const origin of ['http://127.0.0.1', 'https://localhost', 'https://[::1]', 'https://[::ffff:127.0.0.1]']) assert.equal(isLoopbackCacheOrigin(origin), true);
    assert.equal(isLoopbackCacheOrigin(liveRoute.origin), false);
    await assert.rejects(observer.fetch(liveRoute.origin + '/v1/responses', { body: request, redirect: 'error' }), /Unregistered inference/);
    await assert.rejects(observer.fetch(liveRoute.origin + liveRoute.path, { body: request }), /Uncounted automatic redirects/);
    const runtimeRoot = path.join(owned.campaignRoot, 'no-campaign'), home = path.join(runtimeRoot, 'home');
    await fs.mkdir(home, { recursive: true }); await fs.writeFile(path.join(home, '.devryan-qa-home'), 'owned QA home\n');
    await assert.rejects(initializeCacheStudy({ runtimeRoot, home, routes: [{ ...route, id: 'local-fixture' }, unlabelled], runtimeVersion: '1.18.31' }), /shared parent campaign/);
    assert.equal(fetched, 0);
  } finally { await observer.close(); await owned.clean(); }
});
test('late attempts in an inter-arm gap are included and make the run incomplete', async () => {
  const owned = await setup({ live: true }); let time = 0, late = false;
  const observer = await createQaWireObserver({ ...owned,
    context: async () => JSON.parse(await fs.readFile(path.join(owned.runtimeRoot, 'cache-context.json'), 'utf8')),
    fetchImpl: async () => new Response(sse.replaceAll(route.model, liveRoute.qualification.responseModel), { headers: { 'content-type': 'text/event-stream' } }) });
  const dispatch = async () => { await (await observer.fetch(liveRoute.origin + liveRoute.path, { body: request, redirect: 'error' })).text(); };
  try {
    const result = await runCachePairs({ ...owned, routeID: route.id, runtimeVersion: '1.18.31', now: () => time,
      send: async () => { await dispatch(); return { valid: true, qualityAccepted: true, repairs: 0 }; },
      wait: async ms => { if (ms === 2000 && !late) { late = true; await dispatch(); } time += ms; } });
    assert.equal(late, true); assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'wire_evidence_incomplete');
    assert.equal((await readCacheAttempts(owned.runtimeRoot)).length, 3);
  } finally { await observer.close(); await owned.clean(); }
});
test('transient or unattributed request errors are incomplete; only structured effort errors reject', async () => {
  for (const failure of [{ status: 429, param: 'reasoning_effort' }, { status: 500, param: 'reasoning_effort' },
    { status: 400, param: null }, { status: 422, param: 'reasoning_effort' }]) {
    const owned = await setup({ live: true }); let time = 0;
    const observer = await createQaWireObserver({ ...owned,
      context: async () => JSON.parse(await fs.readFile(path.join(owned.runtimeRoot, 'cache-context.json'), 'utf8')),
      fetchImpl: async (_url, init) => JSON.parse(init.body).reasoning_effort === 'low'
        ? new Response(JSON.stringify({ error: { param: failure.param, message: 'PRIVATE reasoning_effort error text' } }),
          { status: failure.status, headers: { 'content-type': 'application/json' } })
        : new Response(sse.replaceAll(route.model, liveRoute.qualification.responseModel), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const result = await runCachePairs({ ...owned, routeID: route.id, runtimeVersion: '1.18.31', phase: 'title', now: () => time,
        send: async ({ experiment }) => {
          await (await observer.fetch(liveRoute.origin + liveRoute.path, { body: experiment ? request.replace('medium', 'low') : request, redirect: 'error' })).text();
          return { valid: !experiment, output: 'A title', repairs: 0 };
        }, grade: async () => [], wait: async ms => { time += ms; } });
      assert.equal(result.status, failure.status === 422 ? 'rejected' : 'incomplete');
      assert.equal((await fs.readFile(path.join(owned.runtimeRoot, 'cache-wire.ndjson'), 'utf8')).includes('PRIVATE'), false);
    } finally { await observer.close(); await owned.clean(); }
  }
});
