import {expect,test,vi} from 'vitest';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {parseNativeCommand} from './native-process-protocol.js';

const segment={jobID:'devryan_subagent_one',messageID:'msg_input',notificationID:'msg_notice'};
const input={taskId:'dvr_task_one',leaseToken:'lease_one',rootSessionId:'ses_root',directory:'/fixture',sessionID:'ses_child',
  providerId:'fixture',modelId:'saved',agent:'fixer',variant:null,...segment};
function fixture(){
  let task={owner:'devryan',taskId:input.taskId,leaseToken:input.leaseToken,rootSessionId:input.rootSessionId,directory:input.directory,
    childSessionId:input.sessionID,status:'running',dispatchCallId:'call_parent',providerId:input.providerId,modelId:input.modelId,
    agent:input.agent,variant:null,executionBackend:'native-job',nativeJobSegments:[{...segment,state:'prepared'}]};
  let revision=1,captured=true,removed=false,removalConfirmed=false;
  const members=[{id:input.rootSessionId,parentID:null,directory:input.directory,generation:1},
    {id:input.sessionID,parentID:input.rootSessionId,directory:input.directory,generation:1}];
  const verifyNativeJobSegment=vi.fn(async request=>{
    if(request.taskId!==task.taskId||request.leaseToken!==task.leaseToken||request.messageID!==segment.messageID
      ||request.notificationID!==segment.notificationID||request.jobID!==segment.jobID)throw Error('foreign segment');
    if(request.phase==='acknowledge'&&(task.status!=='completed'||request.envelopeID!=='env_one'))throw Error('terminal envelope required');
    if(request.phase==='activate'&&task.status!=='running')throw Error('active task required');
    return {task:{...task},segment:{...segment},...request.phase==='acknowledge'?{envelopeID:'env_one'}:{}};
  });
  const owner=createNativeAdmissionOwner({directory:input.directory,ownerID:'fixture',withSessionLock:async(_id,action)=>action(),
    runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false,reverting:false,
      holds:removed?members.map(member=>({sessionID:member.id,removalID:'removal_one',ownerID:'native-removal:removal_one'})):[]}),
      capturedSessionState:async()=>({captured,pending:false,generation:1}),leaseForCall:async()=>({generation:1,executionKind:'control',preparation:'none',state:'published',
        directory:input.directory,scope:{sessionID:input.rootSessionId,callID:'call_parent'}}),
      activeLeases:async()=>[],nativeRemovals:async()=>[{id:'removal_one',ownerID:'fixture',directory:input.directory,state:removalConfirmed?'completed':'committed',
        members,removed:members.map(member=>member.id),dispositions:members.map(member=>({sessionID:member.id,inboxIDs:[],pendingIDs:[]}))}]},
    verifyManagedTaskDispatch:async()=>({...task}),verifyNativeJobSegment,
    getSession:async id=>removed?null:({id,directory:input.directory,...id===input.sessionID?{parentID:input.rootSessionId}:{}}),
    authorizeOperation:async()=>{throw Error('unowned');}});
  const authorize=(permit,phase='prepare',payload=input)=>owner.handleRpc('native.admission.authorize',{
    operation:`job.managed.${phase}`,sessionID:payload.sessionID,input:payload,existingPermit:permit});
  return {owner,authorize,verifyNativeJobSegment,terminal:()=>{task={...task,status:'completed'};captured=false;},
    revoke:()=>{revision++;},uncapture:()=>{captured=false;},remove:confirmed=>{removed=true;removalConfirmed=confirmed;}};
}

test('native job grants require exact private task/segment authority and cannot mutate prompts or invoke automatic restart',async()=>{
  const f=fixture();try{
    await expect(f.authorize(undefined)).rejects.toMatchObject({code:'native_managed_job_owner_required'});
    await f.owner.withManagedJobOperation('prepare',input,async permit=>{
      expect(await f.authorize(permit)).toEqual(permit);
      await expect(f.authorize(permit,'activate')).rejects.toMatchObject({code:'native_managed_job_scope_invalid'});
      await expect(f.authorize(permit,'prepare',{...input,messageID:'msg_foreign'})).rejects.toMatchObject({code:'native_managed_job_scope_invalid'});
      for(const operation of ['session.prompt','session.interrupt','job.shell.ack','restart.resume'])await expect(f.owner.handleRpc('native.admission.authorize',{
        operation,sessionID:input.sessionID,input:{},existingPermit:permit})).rejects.toBeDefined();
      f.revoke();await expect(f.authorize(permit)).rejects.toMatchObject({code:'native_permit_revoked'});
    });
    await expect(f.owner.handleRpc('native.admission.withManagedJobOperation',input)).rejects.toMatchObject({code:'native_admission_rpc_unavailable'});
  }finally{f.owner.dispose();}
});

test('terminal completion acknowledgement has separate exact envelope authority and cannot reauthorize execution',async()=>{
  const f=fixture();try{
    f.terminal();const terminal={...input,envelopeID:'env_one'};
    await f.owner.withManagedJobOperation('acknowledge',terminal,async permit=>{
      expect(await f.authorize(permit,'acknowledge',terminal)).toEqual(permit);
      await expect(f.authorize(permit,'activate',input)).rejects.toMatchObject({code:'native_managed_job_scope_invalid'});
    });
    await expect(f.owner.withManagedJobOperation('acknowledge',{...terminal,envelopeID:'env_foreign'},async()=>{})).rejects.toThrow('terminal envelope required');
    await expect(f.owner.withManagedJobOperation('activate',input,async()=>{})).rejects.toMatchObject({code:'native_managed_task_lease_invalid'});
  }finally{f.owner.dispose();}
});

test('task cancellation refuses omitted segments, foreign roots and model changes even for an empty segment list',async()=>{
  const f=fixture();try{
    const {jobID:_jobID,messageID:_messageID,notificationID:_notificationID,...task}=input;
    await expect(f.owner.withManagedJobOperation('cancelTask',{...task,segments:[]},async()=>{})).rejects.toMatchObject({code:'native_managed_job_scope_invalid'});
    await expect(f.owner.withManagedJobOperation('cancelTask',{...task,modelId:'foreign',segments:[]},async()=>{})).rejects.toMatchObject({code:'native_managed_job_scope_invalid'});
    await expect(f.owner.withManagedJobOperation('cancelTask',{...task,rootSessionId:'ses_foreign',segments:[segment]},async()=>{})).rejects.toMatchObject({code:'native_managed_job_scope_invalid'});
    let accepted=false;await f.owner.withManagedJobOperation('cancelTask',{...task,segments:[segment]},async()=>{accepted=true;});expect(accepted).toBe(true);
    f.uncapture();await expect(f.owner.withManagedJobOperation('prepare',input,async()=>{})).rejects.toMatchObject({code:'native_managed_task_control_invalid'});
  }finally{f.owner.dispose();}
});

test('private process commands strictly validate phase, scope, identities and capability isolation',()=>{
  const command={protocol:1,id:'request',action:'managed-job-owned',sessionID:input.sessionID,phase:'prepare',input,permit:{token:'a'.repeat(64),revision:1,sessionID:input.sessionID}};
  expect(parseNativeCommand(command)).toEqual(command);
  for(const value of [
    {...command,phase:'start'}, {...command,sessionID:'ses_foreign'}, {...command,input:{...input,sessionID:input.rootSessionId}},
    {...command,input:{...input,providerId:'cursor-acp'}}, {...command,input:{...input,jobID:input.sessionID}},
    {...command,input:{...input,notificationID:input.messageID}}, {...command,input:{...input,prompt:'untrusted'}},
    {...command,input:{...input,envelopeID:'env_unexpected'}}, {...command,permit:{...command.permit,token:'foreign'}},
  ])expect(()=>parseNativeCommand(value)).toThrow();
});

test('terminal acknowledgement after session deletion requires exact completed native removal proof',async()=>{
  const f=fixture();try{
    f.terminal();f.remove(false);const terminal={...input,envelopeID:'env_one'};
    await expect(f.owner.withManagedJobOperation('acknowledge',terminal,async()=>{})).rejects.toMatchObject({code:'native_managed_job_removal_unconfirmed'});
    f.remove(true);await f.owner.withManagedJobOperation('acknowledge',terminal,async permit=>{
      expect(await f.authorize(permit,'acknowledge',terminal)).toEqual(permit);
      await expect(f.authorize(permit,'activate',input)).rejects.toMatchObject({code:'native_managed_job_scope_invalid'});
    });
    await expect(f.owner.withManagedJobOperation('cancelTask',{...input,segments:[segment]},async()=>{})).rejects.toBeDefined();
  }finally{f.owner.dispose();}
});
