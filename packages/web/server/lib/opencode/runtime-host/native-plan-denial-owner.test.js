import { expect, it } from 'vitest';
import { createNativePlanDenialOwner } from './native-plan-denial-owner.js';
import { createNativeAdmissionOwner } from './native-admission-owner.js';
const session = { id: 'ses_plan', directory: '/fixture' };
const request = { operation: 'tool.execute', sessionID: session.id, messageID: 'msg_step', input: { toolID: 'write', callID: 'call_denied' } };
const message = () => ({ info: { id: request.messageID, sessionID: session.id, role: 'assistant' },
  parts: [{ type: 'tool', callID: 'call_denied', tool: 'write', state: { status: 'pending' } }] });
const guard = {assertCurrent:()=>{},admissionRevision:0};
it('negative admission requires the exact pending canonical tool and an absent execution pointer', async () => {
  let canonical = message(), checks = 0; const writes = [];
  const record = createNativePlanDenialOwner({ readMessage: async () => canonical, runtime: { cancelUnstartedCall: async input => writes.push(input) } });
  await record(request, session, async () => { checks++; },guard);
  expect(checks).toBe(3); expect(writes).toEqual([{ directory: '/fixture', sessionID: 'ses_plan', messageID: 'msg_step', callID: 'call_denied', requireAbsent: true,guard }]);
  for (const change of ['session', 'message', 'role', 'completed', 'call', 'tool', 'status']) {
    canonical = message();
    if (change === 'session') canonical.info.sessionID = 'ses_foreign';
    if (change === 'message') canonical.info.id = 'msg_foreign';
    if (change === 'role') canonical.info.role = 'user';
    if (change === 'completed') canonical.info.time = { completed: 1 };
    if (change === 'call') canonical.parts[0].callID = 'call_foreign';
    if (change === 'tool') canonical.parts[0].tool = 'read';
    if (change === 'status') canonical.parts[0].state.status = 'error';
    await expect(record(request, session, async () => {},guard)).rejects.toMatchObject({ code: 'native_plan_denial_unproved' });
  }
  expect(writes).toHaveLength(1);
});
it.each([2,3])('controller replacement during denial state read %s refuses before cancellation',async replaceAt=>{
  let owner,reads=0,writes=0;
  const runtime={registerNativeSession:async()=>{},nativeAdmissionState:async()=>{if(++reads===replaceAt)await owner.invalidateController();return {held:false,revision:0};},cancelUnstartedCall:async()=>{writes++;}};
  owner=createNativeAdmissionOwner({ownerID:'fixture',directory:session.directory,runtime,getSession:async()=>session,authorizeOperation:async()=>{},readPlanPolicy:async()=>({readOnly:true}),
    recordPlanToolDenial:createNativePlanDenialOwner({runtime,readMessage:async()=>message()})});
  try{await expect(owner.handleRpc('native.admission.authorize',request)).rejects.toMatchObject({code:'native_permit_revoked'});expect(writes).toBe(0);}finally{owner.dispose();}
});
it('the constructor guard refuses replacement while the actual ledger cancellation waits',async()=>{
  let owner,writes=0;
  const runtime={registerNativeSession:async()=>{},nativeAdmissionState:async()=>({held:false,revision:0}),cancelUnstartedCall:async input=>{
    await owner.invalidateController();input.guard.assertCurrent();writes++;
  }};
  owner=createNativeAdmissionOwner({ownerID:'fixture',directory:session.directory,runtime,getSession:async()=>session,authorizeOperation:async()=>{},readPlanPolicy:async()=>({readOnly:true}),recordPlanToolDenial:createNativePlanDenialOwner({runtime,readMessage:async()=>message()})});
  try{await expect(owner.handleRpc('native.admission.authorize',request)).rejects.toMatchObject({code:'native_permit_revoked'});expect(writes).toBe(0);}finally{owner.dispose();}
});
it('a retained denial guard cannot regain authority outside the original async controller context',async()=>{
  let captured;
  const owner=createNativeAdmissionOwner({ownerID:'fixture',directory:session.directory,runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({held:false,revision:0})},getSession:async()=>session,authorizeOperation:async()=>{},readPlanPolicy:async()=>({readOnly:true}),
    recordPlanToolDenial:async(_request,_session,recheck,guard)=>{await recheck();captured=guard;}});
  try{await expect(owner.handleRpc('native.admission.authorize',request)).rejects.toMatchObject({code:'native_plan_write_denied'});captured.assertCurrent();await owner.invalidateController();expect(()=>captured.assertCurrent()).toThrow('native_permit_revoked');}finally{owner.dispose();}
});
it.each(['policy','canonical'])('replacement while reading %s cannot persist negative admission',async stage=>{
  let owner,writes=0;
  const runtime={registerNativeSession:async()=>{},nativeAdmissionState:async()=>({held:false,revision:0}),cancelUnstartedCall:async()=>{writes++;}};
  owner=createNativeAdmissionOwner({ownerID:'fixture',directory:session.directory,runtime,getSession:async()=>session,authorizeOperation:async()=>{},
    readPlanPolicy:async()=>{if(stage==='policy')await owner.invalidateController();return {readOnly:true};},
    recordPlanToolDenial:createNativePlanDenialOwner({runtime,readMessage:async()=>{if(stage==='canonical')await owner.invalidateController();return message();}})});
  try{await expect(owner.handleRpc('native.admission.authorize',request)).rejects.toMatchObject({code:'native_permit_revoked'});expect(writes).toBe(0);}finally{owner.dispose();}
});
it('only a valid initial negative Plan admission records proof; issued-permit rechecks and foreign origins do not', async () => {
  let readOnly = true, foreign = false, policyError = false, recorded = 0;
  const owner = createNativeAdmissionOwner({ directory: '/fixture', ownerID: 'fixture', getSession: async () => session,
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ held: false, revision: 0 }) },
    authorizeOperation: async () => { if (foreign) throw Error('foreign origin'); },
    readPlanPolicy: async () => { if (policyError) throw Object.assign(Error('policy read failed'), { code: 'native_plan_write_denied' }); return { readOnly }; },
    recordPlanToolDenial: async (_request, _session, recheck) => { await recheck(); recorded++; } });
  try {
    await expect(owner.handleRpc('native.admission.authorize', request)).rejects.toMatchObject({ code: 'native_plan_write_denied' });
    expect(recorded).toBe(1);
    policyError = true; await expect(owner.handleRpc('native.admission.authorize', request)).rejects.toThrow('policy read failed'); expect(recorded).toBe(1); policyError = false;
    foreign = true; await expect(owner.handleRpc('native.admission.authorize', request)).rejects.toThrow('foreign origin'); expect(recorded).toBe(1);
    foreign = false; readOnly = false; const permit = await owner.handleRpc('native.admission.authorize', request);
    readOnly = true;
    await expect(owner.handleRpc('native.admission.recheck', { permit, request })).rejects.toMatchObject({ code: 'native_plan_write_denied' });
    expect(recorded).toBe(1);
  } finally { owner.dispose(); }
});
