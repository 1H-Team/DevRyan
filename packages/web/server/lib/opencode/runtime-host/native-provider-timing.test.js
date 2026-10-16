import { expect, test } from 'vitest';
import { createNativeProviderTiming, parseNativeProviderTiming } from './native-provider-timing.js';

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
