import {expect,test} from 'vitest';
import {createNativeAdmissionOwner} from './native-admission-owner.js';

// PERMIT_MAX (2048) is a refusal window of the private owner, not a launch cap:
// a managed launch prompt waits for a slot instead of failing by count.
const PERMIT_MAX=2048;
const segment={jobID:'devryan_subagent_one',messageID:'msg_input',notificationID:'msg_notice'};
const scope={taskId:'dvr_task_one',leaseToken:'lease_one',rootSessionId:'ses_root',directory:'/fixture',sessionID:'ses_child',
  providerId:'fixture',modelId:'saved',agent:'fixer',variant:null};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(){
  let task={owner:'devryan',taskId:scope.taskId,leaseToken:scope.leaseToken,rootSessionId:scope.rootSessionId,directory:scope.directory,
    childSessionId:scope.sessionID,status:'running',dispatchCallId:'call_parent',providerId:scope.providerId,modelId:scope.modelId,
    agent:scope.agent,variant:null,executionBackend:'native-job',nativeJobSegments:[{...segment,state:'prepared'}]};
  const owner=createNativeAdmissionOwner({directory:scope.directory,ownerID:'fixture',withSessionLock:async(_id,action)=>action(),
    runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:1,held:false,reverting:false,holds:[]}),
      capturedSessionState:async()=>({captured:true,pending:false,generation:1}),
      leaseForCall:async()=>({generation:1,executionKind:'control',preparation:'none',state:'published',directory:scope.directory,
        scope:{sessionID:scope.rootSessionId,callID:'call_parent'}}),activeLeases:async()=>[],nativeRemovals:async()=>[]},
    verifyManagedTaskDispatch:async()=>{if(task.status!=='running')throw Object.assign(Error('stopped'),{code:'native_managed_task_lease_invalid'});return {...task};},
    verifyNativeJobSegment:async request=>({task:{...task},segment:{...segment},...request.phase==='acknowledge'?{envelopeID:'env_one'}:{}}),
    getSession:async id=>({id,directory:scope.directory,...id===scope.sessionID?{parentID:scope.rootSessionId}:{}}),
    authorizeOperation:async()=>{throw Error('unowned');}});
  return {owner,stop:()=>{task={...task,status:'aborted'};}};
}
const accepted={sessionID:scope.sessionID,messageID:'msg_input',fingerprint:'b'.repeat(64),metadata:{devryan:{v:1}},request:{text:'Assigned work',parts:[]}};
const fill=async owner=>{
  const release=deferred();let entered=0;const reached=deferred();
  const held=Array.from({length:PERMIT_MAX},()=>owner.withManagedJobOperation('acknowledge',{...scope,...segment,envelopeID:'env_one'},async()=>{
    if(++entered===PERMIT_MAX)reached.resolve();await release.promise;}));
  await reached.promise;
  return {release:async()=>{release.resolve();await Promise.all(held);}};
};
const launchPrompt=(owner,action)=>owner.withManagedTaskDispatch({operation:'prompt',...scope},()=>owner.withAcceptedOperation(accepted,action));

test('a managed launch prompt waits for a permit slot instead of failing by count',async()=>{
  const f=fixture();try{
    const permits=await fill(f.owner);
    let settled=false;const prompt=launchPrompt(f.owner,async()=>'admitted').finally(()=>{settled=true;});
    await new Promise(resolve=>setTimeout(resolve,150));expect(settled).toBe(false);
    await permits.release();
    await expect(prompt).resolves.toBe('admitted');
  }finally{f.owner.dispose();}
});

test('Stop ends a managed prompt permit wait without admitting it',async()=>{
  const f=fixture();try{
    const permits=await fill(f.owner);let admitted=false;
    const prompt=launchPrompt(f.owner,async()=>{admitted=true;});
    await new Promise(resolve=>setTimeout(resolve,60));f.stop();
    await expect(prompt).rejects.toMatchObject({code:'native_managed_task_lease_invalid'});expect(admitted).toBe(false);
    await permits.release();
  }finally{f.owner.dispose();}
});
