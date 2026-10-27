import net from 'node:net';
import { expect, test } from 'vitest';
import { createNativeProviderTiming, formatNativeProviderFailure, parseNativeProviderTiming, probeProviderHost } from './native-provider-timing.js';

const payload = { controllerInstanceID: 'controller', sessionID: 'session', requestID: 'request', kind: 'primary',
  transport: 'http', event: 'first-byte', statusCode: 200 };
test('provider timing accepts exact content-free controller frames only', () => {
  expect(parseNativeProviderTiming(payload)).toEqual(payload);
  for (const value of [{ ...payload, text: 'private' }, { ...payload, kind: 'unknown' }, { ...payload, statusCode: 600 },
    { ...payload, event: 'first-text' }, { ...payload, controllerInstanceID: '' }]) {
    expect(() => parseNativeProviderTiming(value)).toThrow('native_provider_timing_invalid');
  }
});

test('response timings bind to observed requests and retain actual attempt identity', () => {
  let now = 100; const marks = [];
  const timing = createNativeProviderTiming({ now: () => now, onMark: value => marks.push(value) });
  timing.response(payload); expect(marks).toEqual([]);
  timing.observe({ sessionID: 'session', requestID: 'request', kind: 'primary', stage: 'model-prepared' });
  now = 200;
  timing.observe({ sessionID: 'session', requestID: 'request', kind: 'primary', stage: 'physical', transport: 'http',
    attempt: { traceID: 'trace', spanID: 'span' } });
  timing.response({ ...payload, sessionID: 'foreign' });
  timing.response({ ...payload, kind: 'title' });
  expect(marks).toHaveLength(2);
  now = 250; timing.response(payload);
  expect(timing.resolve({ sessionID: 'session', attempt: { traceID: 'trace', spanID: 'span' } }))
    .toMatchObject({ preparedAt: 100, sentAt: 200, firstByteAt: 250, requestID: 'request' });
  expect(timing.resolve({ sessionID: 'foreign', attempt: { traceID: 'trace', spanID: 'span' } })).toBeNull();
  expect(marks.at(-1)).toMatchObject({ sessionId: 'session', mark: 'provider_first_byte', metadata: { requestID: 'request' } });
});

test('headers and raw body counts remain distinct content-free timing observations',()=>{
 let now=100;const marks=[];const timing=createNativeProviderTiming({now:()=>now,onMark:value=>marks.push(value)});
 timing.observe({sessionID:'session',requestID:'request',kind:'primary',stage:'physical',transport:'http',attempt:{traceID:'trace',spanID:'span'}});
 timing.response(parseNativeProviderTiming({...payload,event:'headers'}));now=250;timing.response(payload);
 const body={bytes:17,chunks:2,maxGapMs:150};timing.response(parseNativeProviderTiming({...payload,event:'body-end',body}));
 expect(timing.resolve({sessionID:'session',attempt:{traceID:'trace',spanID:'span'}})).toMatchObject({headersAt:100,firstByteAt:250});
 expect(marks.map(row=>row.mark)).toEqual(['provider_request_sent','provider_response_headers','provider_first_byte','provider_body_end']);
 expect(marks.at(-1).metadata).toMatchObject(body);
 for(const invalid of [{...body,text:'private'}, {...body,bytes:-1}, {...body,maxGapMs:Infinity}, {...body,chunks:1.5}])
  expect(()=>parseNativeProviderTiming({...payload,event:'body-end',body:invalid})).toThrow('native_provider_timing_invalid');
});

const failure = { phase: 'stream', elapsedMs: 90_000, sinceLastByteMs: 75_000, code: 'ECONNRESET', host: 'api.openai.com', port: 443,
  providerID: 'openai', modelID: 'gpt-5.5', providerRequestID: 'req_abc123' };
const failed = { ...payload, event: 'failed', statusCode: null, failure };
test('failed frames carry only a bounded transport projection', () => {
  expect(parseNativeProviderTiming(failed)).toEqual(failed);
  const { sinceLastByteMs: _omitted, ...connect } = failure;
  expect(parseNativeProviderTiming({ ...failed, failure: { ...connect, phase: 'connect', providerRequestID: null, host: null, port: null } }).failure.phase).toBe('connect');
  expect(parseNativeProviderTiming({ ...failed, transport: 'ws', failure: { ...connect, phase: 'headers', code: 'Timeout' } }).transport).toBe('ws');
  for (const value of [{ ...failed, failure: undefined }, { ...failed, statusCode: 200 }, { ...failed, body: { bytes: 1, chunks: 1, maxGapMs: 1 } },
    { ...failed, failure: { ...failure, message: 'socket hang up' } }, { ...failed, failure: { ...failure, host: 'api.openai.com/v1/responses?key=x' } },
    { ...failed, failure: { ...failure, code: 'read ECONNRESET' } }, { ...failed, failure: { ...failure, phase: 'body' } },
    { ...failed, failure: connect }, { ...failed, failure: { ...connect, phase: 'headers', sinceLastByteMs: 1 } },
    { ...failed, failure: { ...failure, port: 70_000 } }, { ...failed, failure: { ...failure, providerRequestID: 'Bearer secret token' } },
    { ...failed, failure: { ...failure, elapsedMs: -1 } }, { ...failed, failure: { ...failure, headers: { authorization: 'x' } } }]) {
    expect(() => parseNativeProviderTiming(value)).toThrow('native_provider_timing_invalid');
  }
});

test('failures report every request kind once, probing each host at most once per window', async () => {
  let now = 1_000; const records = []; const probes = [];
  let probeResult = 'ok';
  const timing = createNativeProviderTiming({ now: () => now, onFailure: (record) => records.push(record),
    probe: async (target) => { probes.push(target); if (probeResult === 'throw') throw new Error('probe failed'); return probeResult; } });
  timing.response(parseNativeProviderTiming(failed));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(probes).toEqual([{ host: 'api.openai.com', port: 443 }]);
  expect(records).toEqual([{ sessionID: 'session', requestID: 'request', kind: 'primary', transport: 'http', statusCode: null, ...failure, probe: 'ok' }]);
  now += 59_999;
  timing.response(parseNativeProviderTiming({ ...failed, kind: 'title' }));
  expect(records.at(-1)).toMatchObject({ kind: 'title' });
  expect(records.at(-1)).not.toHaveProperty('probe');
  now += 1; probeResult = 'throw';
  timing.response(parseNativeProviderTiming(failed));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(records.at(-1)).toMatchObject({ probe: 'unreachable' });
  timing.response(parseNativeProviderTiming({ ...failed, failure: { ...failure, host: null, port: null } }));
  expect(records.at(-1)).toMatchObject({ host: null });
  expect(probes).toHaveLength(2);
  expect(records).toHaveLength(4);
});

test('the main.log line names phase, code and host but no request content', () => {
  const line = formatNativeProviderFailure({ sessionID: 'session', requestID: 'request', kind: 'primary', transport: 'http', statusCode: null, ...failure, probe: 'unreachable' });
  expect(line).toBe('[native-provider] request failed session=session request=request kind=primary transport=http phase=stream code=ECONNRESET'
    + ' host=api.openai.com:443 model=openai/gpt-5.5 elapsedMs=90000 sinceLastByteMs=75000 providerRequestID=req_abc123 probe=unreachable');
});

test('the connectivity probe resolves ok for a listening host and unreachable otherwise', async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    expect(await probeProviderHost({ host: '127.0.0.1', port })).toBe('ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  expect(await probeProviderHost({ host: '127.0.0.1', port })).toBe('unreachable');
  expect(await probeProviderHost({ host: '127.0.0.1', port }, { timeoutMs: 0 })).toBe('unreachable');
});
