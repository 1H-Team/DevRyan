import {expect,it} from 'vitest';
import {createNativeSessionContextOwner,validateNativeTodos} from './native-session-context-owner.js';
const todo={id:'one',content:'Verify the actual change',status:'in_progress',priority:'high'};
const invocation={tool:'todowrite',directory:'/project',sessionID:'ses_root',messageID:'msg_step',callID:'call_todo',input:{todos:[todo]},
 authorization:{input:{provenance:{kind:'plugin',id:'devryan.harness-context'}}}};
function fixture(){
 let revoked=false,checks=0,commits=0;
 const recheck=async()=>{checks++;if(revoked)throw Error('revoked');};
 const owner=createNativeSessionContextOwner({admissionOwner:{recheckExecution:recheck,withPermit:async(_input,action)=>action()},
  taskContext:{authorizeNativeTodoInvocation:async()=>{},compactionAnchor:async()=>({available:true,text:'[devryan-compaction-anchor:v1]\nOriginal objective'})},
  openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory:'/project',metadata:undefined})}},
  readSessionMetadata:async()=>({id:'ses_root',directory:'/project',metadata:{devryan:{todo:{sessionID:'ses_root',items:[todo],rev:4}}}}),
  writeTodos:async(input,authorize)=>{await authorize();commits++;return {items:input.todos,rev:5};},authorizeContext:async()=>recheck});
 return {owner,revoke:()=>{revoked=true;},counts:()=>({checks,commits})};
}
it('validates ordered TODO IDs and exact native list fields',()=>{
 expect(validateNativeTodos([todo])).toEqual([todo]);
 for(const value of [[todo,todo],[{...todo,status:'done'}],[{...todo,extra:'caller'}],[{...todo,content:''}]])expect(()=>validateNativeTodos(value)).toThrow('native_todos_invalid');
});
it('reads only session-owned TODO metadata and commits through original final authorization',async()=>{
 const f=fixture();expect(await f.owner.tool({...invocation,tool:'todoread',input:{}})).toEqual({items:[todo],rev:4});
 expect(await f.owner.tool(invocation)).toEqual({items:[todo],rev:5});expect(f.counts().commits).toBe(1);
 f.revoke();await expect(f.owner.tool(invocation)).rejects.toThrow('revoked');expect(f.counts().commits).toBe(1);
});
it('refuses revocation between canonical validation and actual metadata commit',async()=>{
 let revoked=false,commits=0;
 const owner=createNativeSessionContextOwner({admissionOwner:{recheckExecution:async()=>{if(revoked)throw Error('revoked');},withPermit:async(_input,action)=>action()},
  taskContext:{authorizeNativeTodoInvocation:async()=>{}},writeTodos:async(_input,authorize)=>{revoked=true;await authorize();commits++;},});
 await expect(owner.tool(invocation)).rejects.toThrow('revoked');expect(commits).toBe(0);
});
it('requires exact tool origin and does not adopt an inherited parent TODO list',async()=>{
 const f=fixture();await expect(f.owner.tool({...invocation,authorization:{input:{provenance:{kind:'plugin',id:'unreviewed'}}}})).rejects.toThrow('native_todo_origin_required');
 const owner=createNativeSessionContextOwner({admissionOwner:{recheckExecution:async()=>{},withPermit:async(_input,action)=>action()},
  taskContext:{authorizeNativeTodoInvocation:async()=>{}},readSessionMetadata:async()=>({id:'ses_child',directory:'/project',metadata:{devryan:{todo:{sessionID:'ses_root',items:[todo]}}}}),openCodeClient:{sessions:{get:async()=>({id:'ses_child',directory:'/project',metadata:{devryan:{todo:{sessionID:'ses_root',items:[todo]}}}})}}});
 expect(await owner.tool({...invocation,tool:'todoread',sessionID:'ses_child',input:{}})).toEqual({items:[],rev:0});
});
it('compaction projects only bounded canonical context and rechecks after an awaited anchor read',async()=>{
 const f=fixture();expect(await f.owner.context({phase:'compaction',directory:'/project',sessionID:'ses_root',permit:{token:'actual'}})).toMatchObject({available:true});
 let revoked=false;
 const owner=createNativeSessionContextOwner({authorizeContext:async()=>async()=>{if(revoked)throw Error('revoked');},
  openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory:'/project'})}},taskContext:{compactionAnchor:async()=>{revoked=true;return {available:true,text:'Objective'};}}});
 await expect(owner.context({phase:'compaction',directory:'/project',sessionID:'ses_root'})).rejects.toThrow('revoked');
});
it('primary tool observations use exact native-sequence calls and static native vocabulary',async()=>{
 const events=[];
 const assistant={info:{id:'msg_step',sessionID:'ses_root',role:'assistant',parentID:'msg_user'},turnOwnership:{source:'native-sequence',userMessageID:'msg_user'},
  parts:[{type:'tool',tool:'apply_patch',callID:'call_todo',state:{status:'running'}}]};
 const owner=createNativeSessionContextOwner({admissionOwner:{recheckExecution:async()=>{}},instanceID:'controller',
  openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory:'/project'}),message:async()=>assistant}},
  primaryRuntime:{readRecord:async()=>({sessionID:'ses_root',directory:'/project',stepID:'msg_step',anchorID:'msg_user'}),plugin:async event=>{events.push(event);return {allowed:true};}}});
 expect(await owner.observeTool({...invocation,tool:'patch',phase:'tool_before'})).toEqual({allowed:true});
 expect(events).toEqual([{action:'tool_before',instanceID:'controller',sessionID:'ses_root',assistantMessageID:'msg_step',userMessageID:'msg_user',callID:'call_todo',tool:'apply_patch',nativeToolVerified:false}]);
 assistant.turnOwnership.source='display';await expect(owner.observeTool({...invocation,tool:'patch',phase:'tool_after'})).rejects.toThrow('native_primary_tool_call_stale');
 expect(events).toHaveLength(1);
});

function continuationFixture(){
 const primary={sessionID:'ses_root',directory:'/project',stepID:'msg_step',anchorID:'msg_user',objectiveID:'msg_user',
  state:'completed',executionGeneration:2,agent:'orchestrator',providerID:'fixture',modelID:'m1',variant:'default',tools:{read:true}};
 const session={id:'ses_root',directory:'/project',metadata:{devryan:{todo:{sessionID:'ses_root',items:[todo],rev:4}}}};
 const user={info:{id:'msg_user',sessionID:'ses_root',role:'user',metadata:{}},parts:[]};
 const assistant={info:{id:'msg_step',sessionID:'ses_root',role:'assistant',parentID:'msg_user',agent:'orchestrator',
  providerID:'fixture',modelID:'m1',variant:'default',finish:'stop',time:{completed:100}},
  turnOwnership:{source:'native-sequence',userMessageID:'msg_user'},parts:[{type:'text',text:'Still open'}]};
 let status={},reservations=0,allowed=true,lostAck=false,held;
 const deliveries=[];
 const recheck=async()=>{if(!allowed)throw Error('revoked');};
 const runtime={helloNative:async()=>{},readRecord:async()=>structuredClone(primary),
  reserveNativeContinuation:async(input,prompt)=>{await recheck();reservations++;primary.continuationID=input.userMessageID;
   primary.nativeContinuation={messageID:input.userMessageID,prompt:structuredClone(prompt)};},
  captureNativeContinuationDispatch:async input=>{await recheck();expect(input.messageID).toBe(primary.nativeContinuation.messageID);
   return {record:structuredClone(primary),prompt:structuredClone(primary.nativeContinuation.prompt),recheck};},
  pendingNativeContinuations:async()=>primary.nativeContinuation?[{sessionID:primary.sessionID,directory:primary.directory,messageID:primary.continuationID}]:[]};
 const owner=createNativeSessionContextOwner({primaryRuntime:runtime,instanceID:'controller',isHeld:async()=>false,
  readSessionMetadata:async()=>({id:session.id,directory:session.directory,metadata:session.metadata}),
  openCodeClient:{sessions:{get:async()=>({...session,metadata:undefined}),status:async()=>status,message:async(_id,id)=>id==='msg_user'?user:assistant}},
  deliverContinuation:async(input,authorize)=>{await held;await authorize();deliveries.push(input);if(lostAck)throw Error('lost delivery ACK');}});
 return {owner,primary,session,user,assistant,deliveries,reservations:()=>reservations,status:value=>{status=value;},
  revoke:()=>{allowed=false;},lostAck:value=>{lostAck=value;},hold:value=>{held=value;}};
}
it('scans canonical idle root TODOs once and recovers the same durable prompt after lost delivery ACK',async()=>{
 const f=continuationFixture();let release;
 f.hold(new Promise(resolve=>{release=resolve;}));
 const first=f.owner.continueTodos({sessionID:'ses_root',directory:'/project'}),duplicate=f.owner.continueTodos({sessionID:'ses_root',directory:'/project'});
 expect(duplicate).toBe(first);release();f.lostAck(true);
 await expect(first).rejects.toThrow('lost delivery ACK');expect(f.reservations()).toBe(1);
 const reserved=f.deliveries[0];f.lostAck(false);
 await f.owner.recoverContinuations({directory:'/project'});
 expect(f.deliveries[1]).toEqual(reserved);expect(f.reservations()).toBe(1);
 expect(reserved.prompt).toMatchObject({agent:'orchestrator',variant:'default',objectiveID:'msg_user',tools:{read:true}});
 expect(reserved.prompt.parts[0].text).toContain('[devryan-open-todo-continuation:v1]');
});
it('refuses busy, foreign-sequence, failed and guarded TODO sources without reserving work',async()=>{
 for(const change of [f=>f.status({ses_root:{type:'busy'}}),f=>{f.assistant.turnOwnership.source='display';},
  f=>{f.assistant.info.error={name:'UnknownError'};},f=>{f.session.parentID='ses_parent';},
  f=>{f.primary.recoverySuppressed=true;},f=>{f.assistant.info.providerID='changed';}]){
  const f=continuationFixture();change(f);expect(await f.owner.continueTodos({sessionID:'ses_root',directory:'/project'})).toMatchObject({continued:false});
  expect(f.reservations()).toBe(0);expect(f.deliveries).toHaveLength(0);
 }
});
it('retains the exact canonical plan instruction and refuses a missing plan preface',async()=>{
 const f=continuationFixture();f.user.info.metadata.openchamberPlanMode=true;
 await expect(f.owner.continueTodos({sessionID:'ses_root',directory:'/project'})).rejects.toThrow('native_primary_plan_instruction_unavailable');
 expect(f.reservations()).toBe(0);
 const text='User has requested to enter plan mode. Preserve the reviewed plan-only instruction verbatim.';
 f.user.parts=[{type:'text',synthetic:true,text}];
 await f.owner.continueTodos({sessionID:'ses_root',directory:'/project'});
 expect(f.deliveries[0].prompt.parts[0]).toEqual({type:'text',synthetic:true,text});
});
it('does not deliver a reserved TODO after the original authority is revoked while delivery awaits',async()=>{
 const f=continuationFixture();let release;
 f.hold(new Promise(resolve=>{release=resolve;}));
 const work=f.owner.continueTodos({sessionID:'ses_root',directory:'/project'});
 // Wait for the reservation itself, not an arbitrary timer.
 while(!f.reservations())await new Promise(resolve=>setImmediate(resolve));
 f.revoke();release();await expect(work).rejects.toThrow('revoked');
 expect(f.deliveries).toHaveLength(0);expect(f.primary.nativeContinuation).toBeDefined();
});

it('recovery skips held intents, recovers other sessions, and reuses the exact ID after explicit release',async()=>{
 const held=new Set(['ses_held']),deliveries=[];
 const scopes=[{sessionID:'ses_held',directory:'/project',messageID:'msg_held'},
  {sessionID:'ses_live',directory:'/project',messageID:'msg_live'}];
 const pending=new Map(scopes.map(scope=>[scope.sessionID,{sessionID:scope.sessionID,directory:scope.directory,
  continuationID:scope.messageID,nativeContinuation:{messageID:scope.messageID,prompt:{messageID:scope.messageID}}}]));
 const owner=createNativeSessionContextOwner({instanceID:'controller',isHeld:async scope=>held.has(scope.sessionID),
  primaryRuntime:{helloNative:async()=>{},pendingNativeContinuations:async()=>scopes,readRecord:async id=>pending.get(id),
   captureNativeContinuationDispatch:async scope=>({record:pending.get(scope.sessionID),prompt:pending.get(scope.sessionID).nativeContinuation.prompt,
    recheck:async()=>{if(held.has(scope.sessionID))throw Error('held');}})},
  deliverContinuation:async({scope},recheck)=>{await recheck();deliveries.push(scope);}});
 await owner.recoverContinuations({directory:'/project'});expect(deliveries).toEqual([scopes[1]]);
 expect(pending.get('ses_held').nativeContinuation.messageID).toBe('msg_held');
 held.delete('ses_held');await owner.recoverContinuations({directory:'/project'});
 expect(deliveries).toEqual([scopes[1],scopes[0],scopes[1]]);
 expect(pending.get('ses_held').nativeContinuation.messageID).toBe('msg_held');
});

it('requires private matched metadata and rechecks authority after its async read',async()=>{
 let revoked=false;
 const owner=createNativeSessionContextOwner({admissionOwner:{withPermit:async(_input,action)=>action(),recheckExecution:async()=>{if(revoked)throw Error('revoked');}},
  taskContext:{authorizeNativeTodoInvocation:async()=>{}},openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory:'/project'})}},
  readSessionMetadata:async()=>{revoked=true;return {id:'ses_root',directory:'/project',metadata:{devryan:{todo:{sessionID:'ses_root',items:[todo],rev:9}}}};}});
 await expect(owner.tool({...invocation,tool:'todoread',input:{}})).rejects.toThrow('revoked');
 const missing=createNativeSessionContextOwner({admissionOwner:{withPermit:async(_input,action)=>action(),recheckExecution:async()=>{}},
  taskContext:{authorizeNativeTodoInvocation:async()=>{}},openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory:'/project',metadata:{devryan:{todo:{sessionID:'ses_root',items:[todo]}}}})}}});
 await expect(missing.tool({...invocation,tool:'todoread',input:{}})).rejects.toThrow('native_todo_metadata_owner_required');
 const foreign=createNativeSessionContextOwner({admissionOwner:{withPermit:async(_input,action)=>action(),recheckExecution:async()=>{}},
  taskContext:{authorizeNativeTodoInvocation:async()=>{}},openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory:'/project'})}},
  readSessionMetadata:async()=>({id:'ses_foreign',directory:'/project',metadata:{}})});
 await expect(foreign.tool({...invocation,tool:'todoread',input:{}})).rejects.toThrow('native_todo_metadata_scope_invalid');
});


it('checks the current constructor instance at both delayed TODO and startup recovery hello writes',async()=>{
 for(const action of ['continueTodos','recoverContinuations']){
  let instanceID='old-controller',hellos=0,reads=0,releaseHello,enterHello;
  const deferred=new Promise(resolve=>{releaseHello=resolve}),entered=new Promise(resolve=>{enterHello=resolve});
  const primaryRuntime={helloNative:async(input,owner)=>{enterHello();await deferred;await owner.authorize();expect(owner.isCurrent()).toBe(true);expect(input.instanceID).toBe(instanceID);hellos++;},readRecord:async()=>{reads++;return null;},pendingNativeContinuations:async()=>{reads++;return [];}};
  const options={instanceID,getInstanceID:()=>instanceID,primaryRuntime,deliverContinuation:async()=>{throw Error('unexpected_continuation');}};
  const old=createNativeSessionContextOwner(options),input={directory:'/project',sessionID:'ses_root'};
  const stale=expect(old[action](input)).rejects.toThrow('native_primary_continuation_controller_stale');
  await entered;instanceID='new-controller';releaseHello();await stale;
  expect({hellos,reads}).toEqual({hellos:0,reads:0});
  const current=createNativeSessionContextOwner({...options,instanceID});
  await current[action](input);expect({hellos,reads}).toEqual({hellos:1,reads:1});
 }
});
