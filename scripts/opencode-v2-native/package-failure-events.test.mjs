import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectPackageFailureEvent } from './package-failure-events.mjs';

test('native failure SSE keeps exact identities/code/time without retaining generic error text', () => {
  const event = { id: 'evt_owned', type: 'session.execution.failed', seq: 7, created: 42,
    location: { directory: '/owned/project' }, data: { sessionID: 'ses_owned', messageID: 'msg_owned',
      error: { type: 'unknown', message: 'native_image_message_stale' } } };
  const row = projectPackageFailureEvent(`data: ${JSON.stringify(event)}\r\n`, 55);
  assert.equal(row.sessionID, 'ses_owned'); assert.equal(row.messageID, 'msg_owned');
  assert.equal(row.sequence, 7); assert.equal(row.created, 42); assert.equal(row.receivedAt, 55);
  assert.equal(row.error.code, 'native_image_message_stale'); assert.equal(row.error.codeSource, 'exact-error-message');
  const secret = 'Generic provider error containing private body';
  event.data.error = { type: 'provider.error', message: secret, code: 'sk_secret_value' };
  const generic = projectPackageFailureEvent(`data: ${JSON.stringify(event)}`, 56);
  assert.equal(generic.error.code, null); assert.equal(generic.error.messageBytes, Buffer.byteLength(secret));
  assert.equal(generic.error.type, 'provider.error');
  assert.equal(generic.error.messageSha256, createHash('sha256').update(secret).digest('hex'));
  assert.equal(JSON.stringify(generic).includes(secret), false);
  assert.equal(projectPackageFailureEvent(': heartbeat', 57), null);
  assert.equal(projectPackageFailureEvent('data: [DONE]', 57), null);
  assert.equal(projectPackageFailureEvent('data: {"type":"session.updated","data":{"text":"private"}}', 58), null);
  assert.throws(() => projectPackageFailureEvent('data: malformed', 59), /package_native_failure_sse_invalid/);
});
