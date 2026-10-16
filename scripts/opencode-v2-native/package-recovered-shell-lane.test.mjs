import assert from 'node:assert/strict';
import test from 'node:test';
import { compiledShellRefusalDiagnostic } from './package-recovered-shell-lane.mjs';

test('retained shell refusal evidence contains only its exact session and bounded typed code', () => {
  const error = Object.assign(new Error('private failure detail'), { code: 'native_permit_revoked', secret: 'private payload' });
  assert.deepEqual(compiledShellRefusalDiagnostic('ses_owned', 'native.admission.authorize',
    { sessionID: 'ses_owned', operation: 'runner.drain', permit: { token: 'private' } }, error), {
    type: 'lifecycle', event: 'compiled_shell_admission_refusal', sessionID: 'ses_owned',
    payload: { method: 'native.admission.authorize', operation: 'runner.drain', code: 'native_permit_revoked' },
  });
  assert.deepEqual(compiledShellRefusalDiagnostic('ses_owned', 'native.provider-attempt', { sessionID: 'ses_owned' }, error).payload,
    { method: 'native.provider-attempt', code: 'native_permit_revoked' });
});

test('retained shell evidence drops foreign sessions, untyped errors and unbounded labels', () => {
  const input = { sessionID: 'ses_owned' }, error = { code: 'native_permit_revoked' };
  for (const [method, value, failure] of [
    ['native.admission.authorize', { sessionID: 'ses_other' }, error],
    ['native.admission.authorize', input, new Error('native_permit_revoked')],
    ['native.admission.authorize', input, { code: 'native_private\nsecret' }],
    ['native.admission.authorize', input, { code: 'native_' + 'x'.repeat(101) }],
    ['native.private\nsecret', input, error],
  ]) assert.equal(compiledShellRefusalDiagnostic('ses_owned', method, value, failure), null);
  assert.equal(Object.hasOwn(compiledShellRefusalDiagnostic('ses_owned', 'native.admission.authorize',
    { ...input, operation: 'private\nsecret' }, error).payload, 'operation'), false);
});
