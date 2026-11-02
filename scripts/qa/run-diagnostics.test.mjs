import assert from 'node:assert/strict';
import test from 'node:test';
import { qaConsoleObservationMetadata, qaDiagnosticUrl } from './run.mjs';
import { gradeQaRendererErrors } from './matrix-runner.mjs';

test('QA console context distinguishes buffered events and retains bounded correlation without URL credentials', () => {
  const metadata = qaConsoleObservationMetadata({ timestamp: 1000, executionContextId: 7 }, {
    runStartedAtMs: 500, captureStartedAtMs: 2000, receivedAtMs: 2500, lastCheckName: 'initial native runtime readiness',
    topFrameUrl: 'http://fixture-user:fixture-pass@127.0.0.1:4000/?session=ses_qa&token=fixture-token#fixture-fragment',
  });
  assert.deepEqual(metadata, { receivedAtMs: 2500, cdpTimestampMs: 1000, runStartedAtMs: 500, captureStartedAtMs: 2000,
    eventPrecedesCapture: true, executionContextId: 7, lastCheckName: 'initial native runtime readiness',
    topFrameUrl: 'http://127.0.0.1:4000/?session=ses_qa' });
  const text = '[event-pipeline] SSE stream error TypeError: network error';
  assert.deepEqual(gradeQaRendererErrors([{ ordinal: 1, kind: 'console', text, ...metadata }]), [text]);
});

test('QA diagnostic metadata rejects unavailable timestamps and unsupported URLs and bounds display strings', () => {
  const metadata = qaConsoleObservationMetadata({ timestamp: Infinity, executionContextId: -1 }, {
    runStartedAtMs: 1, captureStartedAtMs: 2, receivedAtMs: 3, lastCheckName: 'x'.repeat(1000), topFrameUrl: 'file:///private/profile',
  });
  assert.equal(metadata.cdpTimestampMs, null); assert.equal(metadata.eventPrecedesCapture, null);
  assert.equal(metadata.executionContextId, null); assert.equal(metadata.topFrameUrl, null);
  assert.equal(metadata.lastCheckName.length, 256);
  assert.equal(qaDiagnosticUrl('about:blank'), 'about:blank');
  assert.equal(qaDiagnosticUrl('http://127.0.0.1:4000/private?session=not%20an%20id&code=fixture', value => value.replace('/private', '/<QA>')),
    'http://127.0.0.1:4000/<QA>');
});
