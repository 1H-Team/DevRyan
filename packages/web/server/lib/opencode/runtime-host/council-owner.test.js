import { expect,test } from 'vitest';
import { projectManagedTaskResult,readManagedResultReference } from '@openchamber/orchestration-runtime';
import { createNativeCouncilOwner } from './council-owner.js';
const input={tool:'council_session',authorization:{input:{provenance:{kind:'plugin',id:'devryan.council'}}},directory:'/project',sessionID:'ses_root',messageID:'msg_assistant',callID:'call_council',input:{prompt:'Compare designs'}};
test('preserves saved order/variants, real control call and independent paged bodies while retaining task disposition',async()=>{
  const requests=[],controls=[],members=[{providerId:'p',modelId:'slow',variant:'high'},{providerId:'q',modelId:'fast'}],records=new Map();
  let locked=false;
  const run=createNativeCouncilOwner({admissionOwner:{recheckExecution:async()=>{},withPermit:async(_input,action)=>{locked=true;try{return await action();}finally{locked=false;}}},
    taskContext:{authorizeNativeTaskInvocation:async()=>({readOnly:true})},executionHost:{nativeManagedControl:async value=>{controls.push(value.action);return {lease:{token:'control'}};}},
    readCouncilMembers:async value=>{expect(value).toEqual({directory:'/project',sessionID:'ses_root',preset:'default'});return members;},
    getManagedRuntime:()=>({handleRpc:async request=>{requests.push(request);const p=request.params;
      if(request.method==='submit'){expect(locked).toBe(true);const id=`dvr_task_${p.modelId}`,task={taskId:id,rootSessionId:'ses_root',directory:'/project',status:'completed',parentTaskId:null,childSessionId:'ses_child',partial:false,failureReason:null,attempt:1,priorTaskId:null,executionKind:'start',canonicalRefs:[],recoverablePreview:p.modelId==='slow'?'😀'.repeat(4000):'Fast answer'};
        const envelope={...task,envelopeId:`dvr_result_${p.modelId}`,action:null,partial:false,failureReason:null,recoverablePreview:p.modelId==='slow'?'😀'.repeat(4000):'Fast answer'};records.set(id,{task,envelope});return {task};}
      expect(locked).toBe(false);
      const {task,envelope}=records.get(p.taskId);
      if(request.method==='read_result')return {resultReference:readManagedResultReference({task,resultEnvelope:envelope,resultCursor:p.resultCursor})};
      expect(p.waitTimeoutMs).toBe(25000);if(task.taskId.endsWith('slow'))await new Promise(resolve=>setTimeout(resolve,5));return projectManagedTaskResult(task,envelope,'reference');}})});
  const result=await run(input);expect(controls).toEqual(['begin','finish']);expect(result.disposition).toBe('unacknowledged');
  expect(result.results.map(row=>row.modelId)).toEqual(['slow','fast']);expect(result.results[0].response).toBe('😀'.repeat(4000));expect(result.results[1].response).toBe('Fast answer');
  expect(requests.filter(row=>row.method==='submit').map(row=>row.params)).toMatchObject([{agent:'builder',deadlineClass:'council',readOnly:true,variant:'high',dispatchCallId:'call_council'},{variant:null}]);
  expect(requests.some(row=>row.method==='acknowledge')).toBe(false);
});
test('refuses payload member/model overrides and wrong origins before dispatch; final revocation propagates',async()=>{
  let revoked=false,submits=0;
  const run=createNativeCouncilOwner({admissionOwner:{recheckExecution:async()=>{if(revoked)throw Error('revoked');},withPermit:async(_input,action)=>action()},
    taskContext:{authorizeNativeTaskInvocation:async()=>({readOnly:false})},executionHost:{nativeManagedControl:async()=>({lease:{token:'control'}})},
    readCouncilMembers:async()=>[{providerId:'p',modelId:'m'}],getManagedRuntime:()=>({handleRpc:async()=>{submits++;revoked=true;return {task:{taskId:'dvr_task_one'}};}})});
  await expect(run({...input,input:{prompt:'Compare',members:[]}})).rejects.toThrow('input_invalid');
  await expect(run({...input,authorization:{input:{provenance:{kind:'plugin',id:'devryan.managed-task'}}}})).rejects.toThrow('origin_required');expect(submits).toBe(0);
  await expect(run(input)).rejects.toThrow('revoked');expect(submits).toBe(1);
});
