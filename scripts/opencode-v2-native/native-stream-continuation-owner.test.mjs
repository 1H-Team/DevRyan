import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeStreamContinuationOwner } from '../../packages/web/server/lib/opencode/runtime-host/native-stream-continuation-owner.js';

test('private recovered stream keeps exact session, instance and native permit checks before preparation', async () => {
  const input = { action: 'prepare', controllerInstanceID: 'current', configurationDigest: 'a'.repeat(64),
    permit: { token: 'owned' }, sessionID: 'ses_owned', requestID: 'request',
    execution: { agent: 'build', providerID: 'fixture', modelID: 'model', variant: 'default' } };
  const events = [], refusals = []; let grant = false, permit = true;
  const owner = createNativeStreamContinuationOwner({ instanceID: 'current', configurationDigest: input.configurationDigest,
    isCurrent: sessionID => sessionID === input.sessionID && grant,
    recordRefusal: entry => refusals.push(entry),
    openCodeClient: { sessions: { get: async id => ({ id, directory: '/owned' }) } },
    admissionOwner: { withProviderAttempt: async (value, action) => {
      assert.equal(value.permit, input.permit); events.push('permit');
      const recheck = async () => { if (!permit) throw Object.assign(Error('private detail'), { code: 'native_permit_revoked' }); };
      await recheck(); return action(recheck);
    } },
    primaryRuntime: { helloNative: async (_input, context) => { await context.authorize(); assert.equal(context.isCurrent(), true); events.push('hello'); },
      nativeStreamContinuation: async () => { events.push('prepare'); return true; } },
  });
  await assert.rejects(owner(input), { code: 'native_stream_continuation_fenced' });
  assert.deepEqual(events, []); assert.deepEqual(refusals, [{ sessionID: 'ses_owned', action: 'prepare', code: 'native_stream_continuation_fenced' }]);
  grant = true;
  await assert.rejects(owner({ ...input, controllerInstanceID: 'stale' }), { code: 'native_stream_continuation_fenced' });
  await assert.rejects(owner({ ...input, sessionID: 'ses_unknown' }), { code: 'native_stream_continuation_fenced' });
  assert.deepEqual(events, []);
  permit = false; await assert.rejects(owner(input), { code: 'native_permit_revoked' }); assert.deepEqual(events, ['permit']);
  permit = true; events.length = 0; assert.equal(await owner(input), true); assert.deepEqual(events, ['permit', 'hello', 'prepare']);
});

test('a recovery grant revoked after permit admission refuses the same session without changing its error', async () => {
  let grant = true;
  const owner = createNativeStreamContinuationOwner({ instanceID: 'current', configurationDigest: 'a'.repeat(64), isCurrent: () => grant,
    recordRefusal: () => { throw Error('observer failed'); },
    openCodeClient: { sessions: { get: async id => ({ id, directory: '/owned' }) } },
    admissionOwner: { withProviderAttempt: async (_input, action) => { grant = false; return action(async () => {}); } },
    primaryRuntime: { helloNative: () => assert.fail('Revoked grant reached primary preparation') },
  });
  await assert.rejects(owner({ action: 'prepare', controllerInstanceID: 'current', configurationDigest: 'a'.repeat(64),
    permit: { token: 'owned' }, sessionID: 'ses_owned', requestID: 'request',
    execution: { agent: 'build', providerID: 'fixture', modelID: 'model', variant: 'default' } }), { code: 'native_stream_continuation_fenced' });
});

test('an asynchronously rejected refusal observer cannot change the native fence', async () => {
  const owner = createNativeStreamContinuationOwner({ instanceID: 'current', configurationDigest: 'a'.repeat(64), isCurrent: () => false,
    recordRefusal: () => Promise.reject(Error('private observer failure')) });
  await assert.rejects(owner({ action: 'prepare', controllerInstanceID: 'current', configurationDigest: 'a'.repeat(64),
    permit: { token: 'owned' }, sessionID: 'ses_owned', requestID: 'request',
    execution: { agent: 'build', providerID: 'fixture', modelID: 'model', variant: 'default' } }), { code: 'native_stream_continuation_fenced' });
  await Promise.resolve();
});
