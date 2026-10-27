import {expect,test} from 'vitest';
import fs from 'node:fs/promises';
import yaml from 'yaml';
import {Effect,Schema} from 'effect';
import {Permission} from '@opencode/core/permission';
import {Location} from '@opencode/core/location';
import {Session} from '@opencode/schema/session';
import {SessionMessage} from '@opencode/schema/session-message';
import {Agent} from '@opencode/schema/agent';
import {Tool} from '@opencode/schema/tool';
import {withManagedTaskExecution} from './managed-task.js';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {createNativeManagedTaskOwner} from './managed-task-owner.js';

test.each(['explorer','librarian'])('build-mode %s policy permits the assigned reader while denying delegation and edits',async agent=>{
 const source=await fs.readFile(new URL(`../../../default-config/agents/${agent}.md`,import.meta.url),'utf8');
 const {permission}=yaml.parse(source.split('---')[1]);
 const rules=Object.entries(permission).flatMap(([action,value])=>typeof value==='string'?[{action,resource:'*',effect:value}]:
  Object.entries(value).map(([resource,effect])=>({action,resource,effect})));
 expect(Permission.evaluate('devryan_plan_read','*',rules).effect).toBe('allow');
 for(const action of ['devryan_task','write','edit','bash'])expect(Permission.evaluate(action,'*',rules).effect).toBe('deny');
});

test('Plan child reaches the assigned-plan owner through a fixed read-only tool and a real permit without delegation authority',async()=>{
 const origin={kind:'plugin',id:'devryan.managed-task',manifestDigest:'a'.repeat(64),capabilities:['managed-task']};
 const admission=createNativeAdmissionOwner({directory:'/project',ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({held:false,revision:0})},
  getSession:async(id)=>({id,directory:'/project',...(id==='ses_child'?{parentID:'ses_root'}:{})}),authorizeOperation:async()=>{},withSessionLock:async(_sessionID,action)=>action(),readPlanPolicy:async()=>({readOnly:true})});
 const authorized=[],reads=[],controls=[];
 const owner=createNativeManagedTaskOwner({admissionOwner:admission,
  executionHost:{nativeManagedControl:async input=>{controls.push(input);return {lease:{token:'control'}};}},
  taskContext:{authorizeNativePlanInvocation:async(input)=>{
   expect(input.tool).toBe('devryan_plan_read');expect(input.input).toEqual({});if(input.sessionID!=='ses_child')throw Error('context_child_assignment_unavailable');authorized.push(input);
  },handleNativePlanRpc:async(input,recheck)=>{await recheck();reads.push(input);return {text:'Immutable assigned phase',version:'b'.repeat(64)};},
   authorizeNativeTaskInvocation:async()=>{throw Error('Child cannot delegate');}},
  getManagedRuntime:()=>({handleRpc:async()=>{throw Error('No scheduler operation permitted');}})});
 const request={operation:'tool.execute',sessionID:'ses_child',messageID:'msg_assistant',input:{toolID:'devryan_plan_read',callID:'call_plan',provenance:origin,input:{}}};
 const permit=await admission.handleRpc('native.admission.authorize',request);
 const invocation={toolID:'devryan_plan_read',provenance:origin,input:{},existingPermit:permit,
  location:Schema.decodeUnknownSync(Location.Info)({directory:'/project',project:{id:'global',directory:'/project',canonical:'/project'}}),
  nativeContext:{sessionID:Session.ID.make('ses_child'),messageID:SessionMessage.ID.make('msg_assistant'),id:Tool.CallID.make('call_plan'),agent:Agent.ID.make('fixer'),progress:()=>Effect.void},
  recheckPermit:()=>Effect.void,nativePermissionAssert:()=>Effect.void,executeNative:()=>Effect.die(Error('No native execution'))};
 const execute=withManagedTaskExecution({origin,directory:'/project',executeOwned:()=>Effect.die(Error('No fallback')),rpc:async(method,params)=>{expect(method).toBe('native.managed-task');return owner(params);}});
 try{
  expect(await Effect.runPromise(execute(invocation))).toEqual({content:JSON.stringify({text:'Immutable assigned phase',version:'b'.repeat(64)})});
  expect(authorized).toHaveLength(1);expect(reads).toEqual([{action:'plan_read',tool:'devryan_plan_read',sessionID:'ses_child',directory:'/project',messageID:'msg_assistant',callID:'call_plan'}]);
  expect(controls.map(input=>input.action)).toEqual(['begin','finish']);
  for(const input of [{action:'start',agent:'fixer',prompt:'escape'},{action:'plan_update',text:'changed'}, {path:'/arbitrary/parent'}]){
   await expect(Effect.runPromise(execute({...invocation,input}))).rejects.toThrow('native_task_input_invalid');
  }
  for(const sessionID of ['ses_root','ses_unassigned']){
   const foreignPermit=await admission.handleRpc('native.admission.authorize',{...request,sessionID});
   await expect(Effect.runPromise(execute({...invocation,existingPermit:foreignPermit,nativeContext:{...invocation.nativeContext,sessionID:Session.ID.make(sessionID)}}))).rejects.toThrow('context_child_assignment_unavailable');
  }
  await expect(owner({tool:'devryan_plan_read',input:{action:'start'},authorization:{input:{provenance:origin}}})).rejects.toThrow('native_task_input_invalid');
 }finally{admission.dispose();}
});
