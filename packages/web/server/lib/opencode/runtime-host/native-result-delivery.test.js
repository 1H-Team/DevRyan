import { expect, test } from 'vitest';
import { createNativeResultDeliveryObserver } from './native-result-delivery.js';

const scope = { rootSessionId: 'ses_root' }, invocation = { messageID: 'msg_wait', callID: 'call_wait' };
const page = (text, returnedBytes = Buffer.byteLength(text)) => ({ taskId: 'dvr_task_one', envelopeId: 'dvr_result_one', text, returnedBytes });

test('attributes Unicode report pages, metadata, escaping and exact repeated ranges without retaining text', () => {
  const events = [], observe = createNativeResultDeliveryObserver(event => events.push(event));
  const output = { results: [{ resultReference: page('😀\n"'), metadataReference: page('{"references":[]}') }] };
  observe(scope, invocation, output);
  const [summary, report, metadata] = events.map(event => event.payload);
  expect(summary.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(output)));
  expect(summary.reportBytes).toBe(6);
  expect(summary.metadataBytes).toBe(Buffer.byteLength('{"references":[]}'));
  expect(summary.framingBytes).toBe(summary.serializedBytes
    - Buffer.byteLength(JSON.stringify('😀\n"')) + 2 - Buffer.byteLength(JSON.stringify('{"references":[]}')) + 2);
  expect(report).toMatchObject({ section: 'report', startBytes: 0, endBytes: 6, contentBytes: 6, repeated: false });
  expect(metadata.section).toBe('metadata');
  expect(report.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(events)).not.toContain('references');
  observe(scope, invocation, output);
  expect(events).toHaveLength(3); // Rechecking the same canonical tool part is not a second publication.
  observe(scope, { ...invocation, callID: 'call_again' }, output);
  expect(events[3].payload.repeatedBytes).toBe(6 + summary.metadataBytes);
  expect(events[4].payload.repeated).toBe(true);
  observe(scope, { ...invocation, callID: 'call_next' }, { resultReference: page('😀\n"', 12) });
  expect(events.at(-1).payload).toMatchObject({ startBytes: 6, endBytes: 12, repeated: false });
});

test('eager duplicate text is counted while different envelope, root and changed content stay distinct', () => {
  const events = [], observe = createNativeResultDeliveryObserver(event => events.push(event));
  const result = { task: { taskId: 'dvr_task_one', recoverablePreview: 'report' },
    resultEnvelope: { envelopeId: 'dvr_result_one', recoverablePreview: 'report' } };
  observe(scope, invocation, result);
  expect(events[0].payload).toMatchObject({ reportBytes: 12, repeatedBytes: 6 });
  observe(scope, { ...invocation, callID: 'changed' }, { resultReference: page('Report') });
  expect(events.at(-1).payload.repeated).toBe(false);
  observe({ rootSessionId: 'ses_other' }, invocation, { resultReference: page('report') });
  expect(events.at(-1).payload.repeated).toBe(false);
  observe(scope, { ...invocation, callID: 'envelope' }, { resultReference: { ...page('report'), envelopeId: 'dvr_result_two' } });
  expect(events.at(-1).payload.repeated).toBe(false);
});

test('observer failures and disabled metrics never affect a delivered result', () => {
  expect(() => createNativeResultDeliveryObserver(() => { throw new Error('observer'); })(scope, invocation, {})).not.toThrow();
  expect(() => createNativeResultDeliveryObserver()(scope, invocation, undefined)).not.toThrow();
});

test('identity history is bounded and never treats an evicted range as a proven repeat', () => {
  const events = [], observe = createNativeResultDeliveryObserver(event => events.push(event));
  for (let index = 0; index < 2050; index++) observe(scope, { messageID: 'msg_wait', callID: `call_${index}` },
    { resultReference: { ...page('result'), envelopeId: `dvr_result_${index}` } });
  observe(scope, { messageID: 'msg_again', callID: 'call_first' }, { resultReference: { ...page('result'), envelopeId: 'dvr_result_0' } });
  expect(events.at(-1).payload.repeated).toBe(false);
});
