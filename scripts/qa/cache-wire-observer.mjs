import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownedQaDirectory, reserveCacheAttempt, cacheStudyStorage } from './cache-study.mjs';
import { createWireUsageParser, projectWireRequest } from './cache-wire-evidence.mjs';
import { normalizeUsageObservation } from '../../packages/shared-runtime/lib/usage-observation.js';
import { isLoopbackCacheOrigin } from '../../packages/shared-runtime/lib/cache-efficiency-policy.js';

export async function createQaWireObserver({ runtimeRoot, home, fetchImpl = fetch, context = () => ({}), now = Date.now,
  parserFactory = createWireUsageParser } = {}) {
  const root = await ownedQaDirectory(runtimeRoot, home);
  if (!root) return { fetch: fetchImpl, active: false, close: async () => {} };
  const { study } = await cacheStudyStorage(root);
  const live = study.routes.some(route => !isLoopbackCacheOrigin(route.origin));
  const output = await fs.open(path.join(root, 'cache-wire.ndjson'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let size = (await output.stat()).size, stopped = false, pending = Promise.resolve(), queued = 0;
  const record = value => {
    if (stopped) return Promise.resolve();
    const line = JSON.stringify({ version: 1, at: now(), ...value }) + '\n';
    if (size + Buffer.byteLength(line) > 8 * 1024 * 1024 || queued >= 64) {
      stopped = true;
      pending = pending.then(() => output.write(JSON.stringify({ version: 1, type: 'gap', reason: 'observer_limit' }) + '\n'))
        .catch(() => { console.error('DEVRYAN_QA_CACHE_GAP: evidence write failed'); });
      return pending;
    }
    size += Buffer.byteLength(line); queued++;
    pending = pending.then(() => output.write(line)).finally(() => { queued--; });
    // A write failure is a diagnostic gap, not a reason to change provider bytes.
    pending = pending.catch(() => { stopped = true; console.error('DEVRYAN_QA_CACHE_GAP: evidence write failed'); });
    return pending;
  };
  const observedFetch = async function(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const targets = study.routes.filter(candidate => candidate.origin === url.origin && candidate.path === url.pathname);
    if (!targets.length) {
      const inferencePath = /\/(?:responses|chat\/completions|messages)\/?$/.test(url.pathname);
      const providerHost = ['api.openai.com', 'api.anthropic.com', 'api.x.ai', 'chatgpt.com'].includes(url.hostname)
        || study.routes.some(route => new URL(route.origin).hostname === url.hostname);
      const shaped = projectWireRequest(init?.body).model;
      if (live && (inferencePath || providerHost || shaped)) throw new Error('Unregistered inference destination; dispatch refused');
      return fetchImpl.call(this, input, init);
    }
    const signature = projectWireRequest(init?.body, init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const route = targets.find(candidate => candidate.model === signature.model);
    if (!route) throw new Error('Unregistered or opaque model on cache study route; dispatch refused');
    if (live && !['error', 'manual'].includes(init?.redirect ?? input?.redirect)) throw new Error('Uncounted automatic redirects: route is observability-only');
    const ctx = await context(route, input, init);
    if (live && (stopped || ctx.closed === true || ctx.routeID && ctx.routeID !== route.id)) throw new Error('Cache run route or evidence boundary unavailable; dispatch refused');
    const reservation = await reserveCacheAttempt(root, route.id, ctx.phase ?? 'aa', now);
    // Study/arm metadata cannot identify a hidden helper request. Only an
    // exact transport correlation supplied by the host may attribute it.
    const request = ctx.request ?? {};
    const metadata = { observationID: reservation.attemptID ?? randomUUID(), attemptID: reservation.attemptID,
      sessionID: request.sessionID, rootSessionID: request.rootSessionID, messageID: request.messageID, rootTaskID: request.rootTaskID,
      purpose: request.purpose, use: request.use, provider: route.provider, route: route.id, auth: route.auth,
      transport: route.transport, runtimeVersion: ctx.runtimeVersion, requestedModel: signature.model,
      timing: { dispatch: { at: now(), origin: 'client_wire' }, previousCompletion: { at: request.previousCompletion, origin: 'client_wire' } } };
    const runID = typeof ctx.runID === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(ctx.runID) ? ctx.runID : null;
    const armID = typeof ctx.armID === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(ctx.armID) ? ctx.armID : null;
    await record({ type: 'dispatch', reservation, runID, armID, signature,
      redirect: ['error', 'manual', 'follow'].includes(init?.redirect ?? input?.redirect) ? init?.redirect ?? input?.redirect : null,
      usageObservation: normalizeUsageObservation({ ...metadata,
      source: 'provider_request', status: 'dispatched', observedAt: now(), raw: {}, semantics: {} }) });
    if (live && stopped) throw new Error('Cache evidence boundary failed; dispatch refused');
    metadata.timing.dispatch.at = now();
    let response;
    try { response = await fetchImpl.call(this, input, init); }
    catch (error) {
      await record({ type: 'response', usageObservation: normalizeUsageObservation({ ...metadata, source: 'provider_request',
        status: (init?.signal ?? input?.signal)?.aborted ? 'aborted' : 'failed', observedAt: now(), raw: {}, semantics: {},
        timing: { ...metadata.timing, completion: { at: now(), origin: 'client_wire' } } }) });
      throw error;
    }
    let parser, parserFailed = false;
    try { parser = parserFactory({ route, metadata, sse: (response.headers.get('content-type') ?? '').includes('text/event-stream') }); }
    catch { parserFailed = true; }
    let done = false;
    const complete = async status => {
      if (done) return; done = true;
      let captured;
      try { if (!parserFailed) captured = parser.finish(status, now()); } catch { parserFailed = true; }
      if (parserFailed) captured = { gap: 'response_parser_failure', usageObservation: normalizeUsageObservation({ ...metadata,
        source: 'provider_request', status, observedAt: now(), raw: {}, semantics: {},
        timing: { ...metadata.timing, completion: { at: now(), origin: 'client_wire' } } }) };
      await record({ type: 'response', statusCode: response.status, ...captured });
    };
    if (!response.body) { await complete(response.ok ? 'complete' : 'failed'); return response; }
    // One reader, no tee or detached drain. Pulls and cancellation follow the
    // consumer; at most one upstream chunk is in flight. The parser is bounded.
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { await complete(response.ok ? 'complete' : 'failed'); controller.close(); reader.releaseLock(); return; }
          try { if (!parserFailed) parser.push(chunk.value, now()); } catch { parserFailed = true; }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error); await complete((init?.signal ?? input?.signal)?.aborted ? 'aborted' : 'failed'); reader.releaseLock();
        }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { await complete('aborted'); reader.releaseLock(); } },
    }, { highWaterMark: 0 });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const field of ['url', 'redirected', 'type']) Object.defineProperty(wrapped, field, { value: response[field] });
    return wrapped;
  };
  return { active: true, fetch: observedFetch, close: async () => { await pending; await output.close(); } };
}

// Loaded only through an explicit file:// plugin in a disposable OpenCode
// profile. No shipped config imports this module or installs a global observer.
export default async function QaCacheWirePlugin() {
  const previous = globalThis.fetch;
  const runtimeRoot = process.env.DEVRYAN_QA_RUNTIME_ROOT;
  const root = await ownedQaDirectory(runtimeRoot, process.env.DEVRYAN_QA_HOME);
  if (!root) return {};
  const key = Symbol.for('devryan.qa.cache-wire');
  if (globalThis[key]) {
    if (globalThis[key].root !== root) throw new Error('A different cache study already owns this disposable process');
    return {};
  }
  const observer = await createQaWireObserver({ runtimeRoot, home: process.env.DEVRYAN_QA_HOME, fetchImpl: previous,
    context: async () => {
      try {
        const file = path.join(runtimeRoot, 'cache-context.json');
        if ((await fs.stat(file)).size > 8192) return {};
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        // This file describes an arm, not an individual provider request.
        return { phase: value.phase, routeID: value.routeID, runID: value.runID, armID: value.armID, runtimeVersion: value.runtimeVersion, closed: value.closed };
      } catch { return {}; }
    } });
  if (observer.active) { globalThis.fetch = observer.fetch; globalThis[key] = { root }; }
  return {};
}
