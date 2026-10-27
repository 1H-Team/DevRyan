import {test} from 'node:test';
import assert from 'node:assert/strict';
import {confirmRuntimeBundleResume} from '../runtime-bundle-recovery.mjs';

const fixture=()=>{
 let status={state:'held',reconciliationRequired:true,revision:3,resumeAvailable:true},allowed=true,calls=0;
 const options={args:{expectedRevision:3},handle:{runtimeBundle:{inspect:async()=>status,resume:async input=>{calls++;assert.deepEqual(input,{expectedRevision:3});return {state:'restart_required'};}}},
  assertSender:()=>{if(!allowed)throw new Error('sender denied');},confirm:async()=>true};
 return {options,calls:()=>calls,setStatus:value=>{status=value;},revoke:()=>{allowed=false;}};
};
test('recovery confirms and resumes only the original held revision',async()=>{
 const f=fixture();assert.deepEqual(await confirmRuntimeBundleResume(f.options),{state:'restart_required'});assert.equal(f.calls(),1);
});
test('cancellation does not mutate selection',async()=>{
 const f=fixture();f.options.confirm=async()=>false;assert.deepEqual(await confirmRuntimeBundleResume(f.options),{state:'cancelled'});assert.equal(f.calls(),0);
});
test('sender and revision changes while the dialog is open refuse',async()=>{
 for(const change of ['sender','revision']){
  const f=fixture();f.options.confirm=async()=>{if(change==='sender')f.revoke();else f.setStatus({state:'held',reconciliationRequired:true,revision:4,resumeAvailable:true});return true;};
  await assert.rejects(confirmRuntimeBundleResume(f.options));assert.equal(f.calls(),0);
 }
});
test('extra caller paths, missing proof and nonrecovery state refuse',async()=>{
 const args=fixture();args.options.args.controlRoot='/untrusted';await assert.rejects(confirmRuntimeBundleResume(args.options));assert.equal(args.calls(),0);
 for(const status of [{state:'ready',reconciliationRequired:false,revision:3,resumeAvailable:true},{state:'held',reconciliationRequired:true,revision:3,resumeAvailable:false}]){
  const f=fixture();f.setStatus(status);await assert.rejects(confirmRuntimeBundleResume(f.options));assert.equal(f.calls(),0);
 }
});
