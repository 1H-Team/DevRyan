import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {assertQaColdRecoveryState,probeQaColdRecoveryIpc} from './packaged-bundle-recovery.mjs';
import {confirmRuntimeBundleResume} from '../../packages/electron/runtime-bundle-recovery.mjs';

const status=()=>({state:'held',revision:3,reconciliationRequired:true,resumeAvailable:true,recoveryRequiresOriginalCheckpoint:true});

test('actual original recovery IPC owner refuses stale and malformed preload requests before any native dialog or resume',async()=>{
 let dialogs=0,resumes=0,senderChecks=0;
 const context={window:{__TAURI__:{core:{invoke:async(command,args)=>{
  assert.equal(command,'desktop_runtime_bundle_resume');
  return confirmRuntimeBundleResume({args,handle:{runtimeBundle:{inspect:async()=>status(),resume:async()=>{resumes++;}}},
   assertSender:()=>{senderChecks++;},confirm:async()=>{dialogs++;return false;}});
 }}}}};
 const observations=await probeQaColdRecoveryIpc(async expression=>JSON.parse(JSON.stringify(await vm.runInNewContext(expression,context))),3);
 assert.deepEqual(observations.map(row=>row.kind),['stale','foreign','invalid']);
 assert.equal(dialogs,0);assert.equal(resumes,0);assert.equal(senderChecks,2);
});

test('a foreign trusted-sender result cannot be graded as the expected revision refusal',async()=>{
 const context={window:{__TAURI__:{core:{invoke:async()=>{throw Error('bundle_recovery_sender_denied');}}}}};
 await assert.rejects(probeQaColdRecoveryIpc(async expression=>JSON.parse(JSON.stringify(await vm.runInNewContext(expression,context))),3));
});

test('unexpected accepted IPC is never graded as an input refusal',async()=>{
 const context={window:{__TAURI__:{core:{invoke:async()=>({state:'restart_required'})}}}};
 await assert.rejects(probeQaColdRecoveryIpc(async expression=>JSON.parse(JSON.stringify(await vm.runInNewContext(expression,context))),3));
});

test('recovery inspection rejects missing authority, foreign revision and an admitted runtime',()=>{
 assertQaColdRecoveryState(status(),3);
 for(const change of [{state:'ready'},{revision:4},{reconciliationRequired:false},{resumeAvailable:false},{recoveryRequiresOriginalCheckpoint:false}]){
  assert.throws(()=>assertQaColdRecoveryState({...status(),...change},3));
 }
});
