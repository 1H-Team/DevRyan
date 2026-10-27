import {expect,test} from 'vitest';
import {Effect} from 'effect';
import {createManagedTaskScheduler} from '@devryan/orchestration-runtime';
import {createWebManagedOrchestrationRuntime} from '../../orchestration/runtime.js';
import {createNativeManagedTaskOwner} from './managed-task-owner.js';
import {withManagedTaskExecution} from './managed-task.ts';

test('composed scheduler owner and executor stay attached through unchanged parked attention and bounded slices',async()=>{
 const runs=new Map();
 const timers=new Map();let timer=0;
 const persistence={load:async()=>null,save:async()=>{}};
 const scheduler=createManagedTaskScheduler({persistence,scheduleTimeout:callback=>{timers.set(++timer,callback);return timer;},cancelTimeout:id=>timers.delete(id),
  executor:{start:async(task,control)=>{await control.setChildSessionId(`ses_child_${task.taskId}`);await control.markAccepted();return new Promise(resolve=>runs.set(task.taskId,resolve));},abort:async()=>({aborted:true})}});
 const runtime=createWebManagedOrchestrationRuntime({scheduler,persistence,harnessPolicies:{waitAny:true}});
 try{
  await runtime.initialize();
  const tasks=[];
  for(let index=0;index<2;index++)tasks.push(await scheduler.submit({idempotencyKey:`composed-${index}`,rootSessionId:'ses_root',parentTaskId:null,directory:'/project',
   mode:'orchestrator',providerId:'fixture',modelId:'fixture',agent:'explorer',variant:null,label:`Task ${index}`,prompt:`Scope ${index}`,timeoutAt:null}));
  await scheduler.flush();
  runs.get(tasks[0].taskId)?.({status:'failed',recoverablePreview:'Parked partial work',resumable:true,failureReason:'Usage limit reached'});
  await scheduler.waitForTask(tasks[0].taskId);await scheduler.flush();
  const first=await runtime.handleRpc({method:'wait_any',params:{directory:'/project',rootSessionId:'ses_root',taskIds:tasks.map(task=>task.taskId),resultContractVersion:2,until:'settled'}});
  const slices=[],requests=[];
  const owner=createNativeManagedTaskOwner({admissionOwner:{recheckExecution:async()=>{},withManagedTaskCatalogInvocation:async(_input,action)=>action()},
   taskContext:{authorizeNativeTaskInvocation:async()=>({readOnly:false})},readResultPublication:async()=>({identity:{attempt:{traceID:'trace',spanID:'span'},permitSha256:'permit'}}),
   getManagedRuntime:()=>({handleRpc:async(request,context)=>{
    slices.push(request.params.waitTimeoutMs);const response=runtime.handleRpc(request,context);await scheduler.flush();
    if(slices.length===3){runs.get(tasks[1].taskId)?.({status:'completed',recoverablePreview:'Finished sibling'});await scheduler.waitForTask(tasks[1].taskId);}
    else for(const callback of [...timers.values()])callback();
    return response;
   }})});
  const origin={kind:'plugin',id:'devryan.managed-task',manifestDigest:'a'.repeat(64),capabilities:['managed-task']};
  const input={action:'wait_any',task_ids:tasks.map(task=>task.taskId),after_cursor:first.cursor,until:'settled'};
  const call={toolID:'devryan_task',provenance:origin,input,
   location:{directory:'/project',project:{id:'global',directory:'/project',canonical:'/project'}},
   nativeContext:{sessionID:'ses_root',messageID:'msg_assistant',agent:'orchestrator',id:'call_composed',progress:()=>Effect.void},
   existingPermit:{token:'private',sessionID:'ses_root',revision:1},recheckPermit:()=>Effect.void,nativePermissionAssert:()=>Effect.void,executeNative:()=>Effect.die(Error('Unowned execution'))};
  const execute=withManagedTaskExecution({origin,directory:'/project',executeOwned:()=>Effect.die(Error('Unowned tool')),
   rpc:async(_method,request,context)=>{requests.push(request);return owner(request,context);}});
  const result=await Effect.runPromise(execute(call));
  expect(slices).toEqual([1,25000,1]);expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);expect(JSON.parse(String(result.content))).toMatchObject({settled:true,changedTaskIds:[tasks[1].taskId]});
 }finally{await runtime.shutdown();}
});

const retryOrigin={kind:'plugin',id:'devryan.managed-task',manifestDigest:'a'.repeat(64),capabilities:['managed-task']};
const attached=(input,replies)=>{
 const requests=[];
 const execute=withManagedTaskExecution({origin:retryOrigin,directory:'/project',executeOwned:()=>Effect.die(Error('Unowned tool')),
  rpc:async(_method,request)=>{requests.push(request);const reply=replies.shift();if(reply instanceof Error)throw reply;return reply;}});
 const run=Effect.runPromise(execute({toolID:'devryan_task',provenance:retryOrigin,input,
  location:{directory:'/project',project:{id:'global',directory:'/project',canonical:'/project'}},
  nativeContext:{sessionID:'ses_root',messageID:'msg_assistant',agent:'orchestrator',id:'call_retry',progress:()=>Effect.void},
  existingPermit:{token:'private',sessionID:'ses_root',revision:1},recheckPermit:()=>Effect.void,nativePermissionAssert:()=>Effect.void,
  executeNative:()=>Effect.die(Error('Unowned execution'))}));
 return {run,requests};
};
const transportTimeout=()=>new DOMException('The operation timed out.','TimeoutError');
const liveSlice={task:{taskId:'dvr_task_one',rootSessionId:'ses_root',directory:'/project',status:'running'}};
const finishedSlice={task:{...liveSlice.task,status:'completed'}};

test('an attached wait re-issues timed-out slices while live and returns the collected result',async()=>{
 const {run,requests}=attached({action:'wait',task_id:'dvr_task_one'},[transportTimeout(),liveSlice,transportTimeout(),finishedSlice]);
 expect(JSON.parse(String((await run).content))).toEqual(finishedSlice);
 expect(requests).toHaveLength(4);expect(new Set(requests.map(request=>JSON.stringify(request))).size).toBe(1);
});
test('exhausted wait timeouts return the last live state, never the raw transport text',async()=>{
 const {run,requests}=attached({action:'wait',task_id:'dvr_task_one'},[liveSlice,...Array.from({length:4},transportTimeout)]);
 const content=String((await run).content);
 expect(JSON.parse(content)).toEqual(liveSlice);expect(content).not.toContain('timed out');expect(requests).toHaveLength(5);
 const first=attached({action:'wait_any',task_ids:['dvr_task_one','dvr_task_two']},Array.from({length:4},transportTimeout));
 expect(JSON.parse(String((await first.run).content))).toMatchObject({state:'wait_slice_timeout',settled:false,taskIds:['dvr_task_one','dvr_task_two']});
});
test('timeouts on non-idempotent actions are typed and not re-issued; start re-issues its idempotent request',async()=>{
 const read=attached({action:'read_result',task_id:'dvr_task_one',result_cursor:'cursor'},[transportTimeout()]);
 await expect(read.run).rejects.toThrow('managed_task_host_timeout');
 await expect(read.run).rejects.not.toThrow('timed out');expect(read.requests).toHaveLength(1);
 const receipt={committed:true,taskId:'dvr_task_one',rootSessionId:'ses_root',action:'start',status:'queued'};
 const start=attached({action:'start',agent:'fixer',prompt:'Fix it'},[Object.assign(Error('native_task_start_timeout'),{code:'native_task_start_timeout'}),receipt]);
 expect(JSON.parse(String((await start.run).content))).toEqual(receipt);
 expect(start.requests).toHaveLength(2);expect(start.requests[0]).toEqual(start.requests[1]);
});
