import {expect,test} from 'vitest';
import {Effect} from 'effect';
import {createManagedTaskScheduler} from '@openchamber/orchestration-runtime';
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
