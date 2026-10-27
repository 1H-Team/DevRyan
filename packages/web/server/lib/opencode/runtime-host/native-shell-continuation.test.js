import { expect, it } from 'vitest';
import { createNativeShellContinuationVerifier } from './native-shell-continuation.js';

const user = (id, metadata) => ({ info: { id, sessionID: 'ses_root', role: 'user', metadata }, parts: [] });
const assistant = (id, parentID, callID) => ({ info: { id, sessionID: 'ses_root', role: 'assistant', parentID },
  turnOwnership: { source: 'native-sequence', userMessageID: parentID },
  parts: [{ type: 'tool', tool: 'bash', callID, state: { status: 'completed' } }] });
const compact = id => ({ ...user(id), parts: [{ type: 'compaction' }] });
function fixture() {
  const record = { sessionID: 'ses_root', directory: '/project', anchorID: 'msg_anchor' };
  const observation = { complete: true, session: { id: 'ses_root', directory: '/project' }, messages: [
    user('msg_anchor'), assistant('msg_first', 'msg_anchor', 'call_first'), compact('msg_compact'),
    assistant('msg_second', 'msg_compact', 'call_second'),
    user('msg_shell1', { source: 'shell', jobID: 'job_1', shellID: 'job_1' }),
    user('msg_shell2', { source: 'shell', jobID: 'job_2', shellID: 'job_2' }), compact('msg_tail'),
  ] };
  const proofs = Object.fromEntries(['1', '2'].map((index) => [`job_${index}`, {
    lease: { directory: '/project', state: 'published', scope: { sessionID: 'ses_root',
      userMessageID: index === '1' ? 'msg_anchor' : 'msg_compact',
      messageID: index === '1' ? 'msg_first' : 'msg_second', callID: index === '1' ? 'call_first' : 'call_second' },
    nativeShellJob: { jobID: `job_${index}`, notificationID: `msg_shell${index}`, deliveredID: `msg_shell${index}` } },
    receipt: { terminated: true, confined: true },
  }]));
  let reads = 0;
  const state = { revision: 4, held: false, reverting: false };
  const verifier = createNativeShellContinuationVerifier({ runtime: { nativeAdmissionState: async () => {
    reads++; return { ...state };
  } }, getShellJobReceipt: async ({ jobID }) => proofs[jobID] ?? {} });
  return { record, observation, proofs, state, verifier, reads: () => reads };
}

it('proves multiple background jobs across compaction with receipts from the same objective', async () => {
  const f = fixture();
  expect(await f.verifier(f.record, f.observation, 'msg_tail')).toEqual({ kind: 'native-shell' });
  expect(f.reads()).toBe(2);
  f.record.activeUserID = 'msg_shell1';
  expect(await f.verifier(f.record, f.observation, 'msg_tail')).toEqual({ kind: 'native-shell' });
});

it('rejects forged metadata, unowned calls, changed objectives and incomplete or reverted history', async () => {
  const invalidations = [
    f => { f.proofs.job_1.lease.nativeShellJob.deliveredID = 'msg_other'; },
    f => { f.proofs.job_1.receipt.terminated = false; },
    f => { f.proofs.job_1.receipt.confined = false; },
    f => { f.proofs.job_1.lease.state = 'active'; },
    f => { f.proofs.job_1.lease.scope.userMessageID = 'msg_foreign'; },
    f => { f.proofs.job_1.lease.scope.callID = 'call_foreign'; },
    f => { f.observation.messages[1].turnOwnership.source = 'display'; },
    f => { f.observation.messages[1].parts[0].tool = 'write'; },
    f => { f.observation.messages[1].parts[0].state.status = 'running'; },
    f => { f.observation.messages.splice(3, 0, user('msg_intervening')); },
    f => { f.observation.messages.push(user('msg_new')); },
    f => { f.observation.messages.push(compact('msg_anchor')); },
    f => { f.observation.messages[4].info.sessionID = 'ses_foreign'; },
    f => { f.observation.session.revert = { messageID: 'msg_anchor' }; },
    f => { f.observation.complete = false; },
    f => { f.state.held = true; },
  ];
  for (const invalidate of invalidations) {
    const f = fixture(); invalidate(f);
    expect(await f.verifier(f.record, f.observation, 'msg_tail')).toBeNull();
  }
});

it('fails closed when a hold races the receipt read or current-generation evidence is unavailable', async () => {
  const f = fixture();
  const verify = createNativeShellContinuationVerifier({
    runtime: { nativeAdmissionState: async () => ({ revision: f.state.revision++, held: false }) },
    getShellJobReceipt: async ({ jobID }) => f.proofs[jobID],
  });
  expect(await verify(f.record, f.observation, 'msg_tail')).toBeNull();
  const missing = createNativeShellContinuationVerifier({ runtime: { nativeAdmissionState: async () => f.state },
    getShellJobReceipt: async () => { throw new Error('execution_reverted'); } });
  await expect(missing(f.record, f.observation, 'msg_tail')).rejects.toThrow('execution_reverted');
});


it('ignores only projected native statuses inside a genuine receipt-backed shell and compaction chain',async()=>{
  const f=fixture();
  const notice={...user('msg_status',{devryan:{v:1,origin:'interview',statusOnly:true}}),
    nativeStatus:{source:'native-sequence',kind:'status-only'}};
  f.observation.messages.splice(2,0,notice);
  f.observation.messages.push({...notice,info:{...notice.info,id:'msg_status_tail'}});
  expect(await f.verifier(f.record,f.observation,'msg_tail')).toEqual({kind:'native-shell'});
  delete notice.nativeStatus;
  expect(await f.verifier(f.record,f.observation,'msg_tail')).toBeNull();
});
