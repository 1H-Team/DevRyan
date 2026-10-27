import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('owned Cursor records preserve native projection and settle managed Stop before restart', async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-cursor-ingress-')));
  const home = path.join(root, 'home'), tmp = path.join(home, 'tmp'), directory = path.join(root, 'project');
  await Promise.all([tmp, path.join(directory, '.git')].map(value => fs.mkdir(value, { recursive: true })));
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
  const host = new URL('../../packages/web/server/lib/opencode/runtime-host/', import.meta.url).href;
  const server = new URL('../../packages/web/node_modules/@opencode/server/dist/fetch.js', import.meta.url).href;
  const projection = new URL('../../packages/web/server/lib/opencode/v2/projection/', import.meta.url).href;
  const orchestration = new URL('../../packages/orchestration-runtime/', import.meta.url).href;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const source = `
import assert from 'node:assert/strict';
import {Effect,Layer,Logger,Schema} from 'effect';
const {ServerFetch}=await import(${JSON.stringify(server)});
import {Bus} from '@opencode/core/bus';
import {SessionStore} from '@opencode/core/session/store';
import {SessionExecution} from '@opencode/core/session/execution';
import {Session as NativeSession} from '@opencode/core/session';
import {LocationServiceMap} from '@opencode/core/location-service-map';
import {SessionMessage} from '@opencode/schema/session-message';
import {LocationActivity} from '@opencode/core/location-activity';
import {makeGlobalNode} from '@opencode/util/effect/app-node';
import {Global} from '@opencode/util/global';
const {createNativeCursorIngress,isNativeCursorIngress}=await import(${JSON.stringify(host + 'native-cursor-ingress.ts')});
const {primaryStepOverride}=await import(${JSON.stringify(host + 'primary-step.ts')});
const {createNativeObservation}=await import(${JSON.stringify(host + 'native-observation.ts')});
const {OperationPermitRef}=await import(${JSON.stringify(host + 'native-admission-contract.ts')});
const {createAdmissionGates}=await import(${JSON.stringify(host + 'admission-gates.ts')});
const {createReviewedNativePluginRegistry}=await import(${JSON.stringify(host + 'native-plugin-registry.ts')});
const {createOpenCodeAdmission}=await import(${JSON.stringify(projection + '../admission.js')});
const {configurationOverrides}=await import(${JSON.stringify(host + 'configuration.ts')});
const {projectMessagePage}=await import(${JSON.stringify(projection + 'messages.js')});
const {createEventProjector}=await import(${JSON.stringify(projection + 'events.js')});
const {createManagedTaskScheduler}=await import(${JSON.stringify(orchestration + 'scheduler.js')});
const {createManagedOpenCodeExecutor}=await import(${JSON.stringify(orchestration + 'open-code-executor.js')});
const directory=process.env.DEVRYAN_GRAPH_DIRECTORY;
let revoked=false,store,bus,sessionService;const events=[],scoped=[],observationRpcs=[];
const observation=createNativeObservation({controllerInstanceID:'owned-controller',configurationDigest:'c'.repeat(64),rpc:async(method,input)=>{
 observationRpcs.push({method,stage:input.observation?.stage});throw Error('Original observation authority refused');
}});
let settlementAllowed=false;const ingress=createNativeCursorIngress({controllerInstanceID:'owned-controller',authorizeSettlement:()=>Effect.sync(()=>{if(!settlementAllowed)throw Error('unsettled process refused');}),authorizeRecord:input=>Effect.sync(()=>{
 assert.equal(input.permit.sessionID,input.sessionID);assert.match(input.recordFingerprint,/^[a-f0-9]{64}$/);if(revoked)throw Error('original caller revoked');
})});
const requests=[];const bridge={awaitReady:async()=>{},authorize:async r=>{requests.push(r);return {token:'d'.repeat(64),revision:0,sessionID:r.sessionID};},recheck:async()=>{},release:async()=>{},sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
const gates=createAdmissionGates({bridge,nativePlugins:createReviewedNativePluginRegistry('c'.repeat(64)),executeOwned:()=>Effect.die('No native tool may run'),executionActivity:ingress.decorateExecution,captureSessionStore:ingress.captureStore});await gates.controls.openStartup();
const overrides=[...configurationOverrides({}),Global.node.replace(Global.layerWith({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,state:process.env.XDG_STATE_HOME,cache:process.env.XDG_CACHE_HOME,tmp:process.env.TMPDIR,bin:process.env.HOME+'/bin',log:process.env.HOME+'/log',repos:process.env.HOME+'/repos'})),primaryStepOverride(async()=>{throw Error('External cursor must not call native primary runner observer');},ingress.captureBus,observation.observePublished),

 ...gates.overrides,
 LocationActivity.node.replace(makeGlobalNode({service:LocationActivity.Service,deps:[Bus.node,SessionStore.node,SessionExecution.node,LocationServiceMap.node,NativeSession.node],layer:Layer.effect(LocationActivity.Service,Effect.gen(function*(){store=yield* SessionStore.Service;bus=yield* Bus.Service;sessionService=yield* NativeSession.Service;return yield* LocationActivity.Service;})).pipe(Layer.provide(LocationActivity.layer()))}))];
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const handler=yield* ServerFetch.make({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false},simulation:false},{overrides});
 const request=(route,body)=>Effect.promise(async()=>{const response=await handler(new Request('http://owned'+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-opencode-directory':encodeURIComponent(directory)},...(body===undefined?{}:{body:JSON.stringify(body)})}));assert.equal(response.status,200);const envelope=await response.json();return envelope.data;});
 const created=yield* request('/api/session',{location:{directory}});assert.ok(created.id,JSON.stringify(created));const session=created;

 yield* bus.listen(event=>Effect.gen(function*(){events.push(event);scoped.push(yield* isNativeCursorIngress());}));
 const userID='msg_cursor_owned_user',assistantID='msg_cursor_owned_assistant';
 const accepted={id:userID,text:'Plan\\nhello',metadata:{devryan:{v:1,parts:[{kind:'synthetic',length:5,id:'prt_plan'},{kind:'text',length:5,id:'prt_user'}]}},delivery:'steer',resume:false};
 const scope={controllerInstanceID:'owned-controller',directory,sessionID:session.id,userMessageID:userID,assistantMessageID:assistantID,agent:'build',modelID:'composer-2.5',accepted,permit:{token:'d'.repeat(64),sessionID:session.id,revision:0}};
 const user={info:{id:userID,sessionID:session.id,role:'user',providerID:'cursor-acp',modelID:'composer-2.5',time:{created:100}},parts:[{id:'prt_user',type:'text',text:'hello'}]};
 const assistant={info:{id:assistantID,parentID:userID,sessionID:session.id,role:'assistant',providerID:'cursor-acp',modelID:'composer-2.5',time:{created:101}},parts:[]};
 yield* Effect.promise(()=>ingress.persistOwned({...scope,record:user}));
 const count=events.length;yield* Effect.promise(()=>ingress.persistOwned({...scope,record:user}));assert.equal(events.length,count);
 yield* Effect.promise(()=>ingress.persistOwned({...scope,record:assistant}));
 assert.deepEqual((yield* request('/api/session/active'))[session.id],{type:'running'});
 const admission=createOpenCodeAdmission({getRuntime:()=>({generation:2,baseUrl:'http://owned'}),getAuthHeaders:()=>({}),fetchImpl:(url,init)=>handler(new Request(url,init))});
 yield* Effect.promise(()=>assert.rejects(admission.prompt(session.id,{messageID:'msg_selection_while_busy',agent:'plan',parts:[{type:'text',text:'change selection'}]},{directory}),error=>error.code==='selection_change_while_busy'));
 assert.equal((yield* store.get(session.id)).agent,undefined);
 assert.ok(!requests.some(request=>request.operation==='runner.drain'||request.operation==='execution.wake'));

 assistant.parts=[{id:'prt_first',type:'text',text:'earlier'},{id:'prt_reason',type:'reasoning',text:'reason',time:{start:102}},{id:'prt_later',type:'text',text:'later'},{id:'prt_tool',type:'tool',callID:'call_original',tool:'read',state:{status:'running',input:{path:'owned.txt'},time:{start:103}}}];
 yield* Effect.promise(()=>ingress.persistOwned({...scope,record:assistant}));
 assistant.parts[0].text='corrected earlier';assistant.parts[3].state={status:'completed',input:{path:'owned.txt'},output:'actual external result',time:{start:103,end:105},metadata:{fixture:true}};
 yield* Effect.promise(()=>ingress.persistOwned({...scope,record:assistant}));
 const current=yield* store.message(Schema.decodeUnknownSync(SessionMessage.ID)(assistantID));
 assert.equal(current.message.content[0].text,'corrected earlier');assert.equal(current.message.content[2].text,'later');assert.equal(current.message.content[3].state.status,'completed');
 const rows=yield* store.messages({sessionID:session.id,order:'asc'});
 const records=projectMessagePage(rows,{sessionID:session.id,path:{cwd:directory,root:directory}}).records;
 const rest=records.find(row=>row.info.id===assistantID);assert.deepEqual(rest.parts.map(part=>part.id),['prt_first','prt_reason','prt_later','prt_tool']);
 const userRest=records.find(row=>row.info.id===userID);assert.deepEqual(userRest.parts.map(part=>part.id),['prt_plan','prt_user']);assert.equal(userRest.parts[0].text,'Plan\\n');
 const projector=createEventProjector();const projected=events.flatMap(event=>projector.project(event));
 const changed=projected.filter(event=>event.payload.type==='message.part.updated').map(event=>event.payload.properties.part);
 assert.ok(changed.some(part=>part.id==='prt_first'&&part.text==='corrected earlier'));
 assert.ok(changed.some(part=>part.id==='prt_tool'&&part.callID==='call_original'&&part.state.status==='completed'));
 assistant.info.time.completed=110;assistant.info.tokens={input:2,output:3,reasoning:1,cache:{read:0,write:0}};
 yield* Effect.promise(()=>ingress.persistOwned({...scope,record:assistant}));
 assert.equal((yield* request('/api/session/active'))[session.id],undefined);
 const terminalEvents=events.length;yield* Effect.promise(()=>ingress.persistOwned({...scope,record:assistant}));assert.equal(events.length,terminalEvents);
 const terminal=yield* store.message(Schema.decodeUnknownSync(SessionMessage.ID)(assistantID));assert.ok(terminal.message.time.completed);
 assistant.parts[0].text='forged terminal correction';yield* Effect.promise(()=>assert.rejects(ingress.persistOwned({...scope,record:assistant}),/native_cursor_terminal_record_changed/));assistant.parts[0].text='corrected earlier';
 const eventCount=events.length;revoked=true;yield* Effect.promise(()=>assert.rejects(ingress.persistOwned({...scope,record:assistant}),/original caller revoked/));assert.equal(events.length,eventCount);revoked=false;
 const secondUser='msg_cursor_second_user',secondAssistant='msg_cursor_second_assistant';
 const secondScope={...scope,userMessageID:secondUser,assistantMessageID:secondAssistant,accepted:{...accepted,id:secondUser}};
 const secondUserRecord={...user,info:{...user.info,id:secondUser}},secondRecord={...assistant,info:{...assistant.info,id:secondAssistant,parentID:secondUser,time:{created:120}},parts:[{id:'prt_retained',type:'text',text:'actual retained partial'}]};
 yield* Effect.promise(()=>ingress.persistOwned({...secondScope,record:secondUserRecord}));
 yield* Effect.promise(()=>ingress.persistOwned({...secondScope,record:secondRecord}));
 assert.deepEqual((yield* request('/api/session/active'))[session.id],{type:'running'});
 const {accepted:_accepted,...settlement}=secondScope;
 yield* Effect.promise(()=>assert.rejects(ingress.settleOwned(settlement),/unsettled process refused/));
 revoked=true;settlementAllowed=true;yield* Effect.promise(()=>ingress.settleOwned(settlement));
 const cancelled=yield* store.message(Schema.decodeUnknownSync(SessionMessage.ID)(secondAssistant));assert.ok(cancelled.message.time.completed);assert.deepEqual(cancelled.message.error,{type:'aborted',message:'Cursor execution interrupted'});assert.equal(cancelled.message.content[0].text,'actual retained partial');
 const cancelledRows=yield* store.messages({sessionID:session.id,order:'asc'});
 const cancelledRest=projectMessagePage(cancelledRows,{sessionID:session.id,path:{cwd:directory,root:directory}}).records.find(row=>row.info.id===secondAssistant);
 assert.deepEqual(cancelledRest.info.error,{name:'MessageAbortedError',data:{v2Type:'aborted',message:'Cursor execution interrupted'}});
 assert.equal((yield* request('/api/session/active'))[session.id],undefined);const afterSettle=events.length;
 yield* Effect.promise(()=>ingress.settleOwned(settlement));assert.equal(events.length,afterSettle);
 assert.equal((yield* store.get(session.id)).outcome,'interrupted');
 revoked=false;
 const parentUser='msg_cursor_waiting_parent_user',parentAssistant='msg_cursor_waiting_parent_assistant';
 const parentScope={...scope,userMessageID:parentUser,assistantMessageID:parentAssistant,accepted:{...accepted,id:parentUser}};
 yield* Effect.promise(()=>ingress.persistOwned({...parentScope,record:{...user,info:{...user.info,id:parentUser}}}));
 const parentRecord={info:{...assistant.info,id:parentAssistant,parentID:parentUser,time:{created:125}},parts:[
  {id:'prt_parent_dispatch',type:'tool',callID:'call_cursor_stop',tool:'devryan_task',state:{status:'running',input:{action:'wait_any'},time:{start:125}}}
 ]};
 yield* Effect.promise(()=>ingress.persistOwned({...parentScope,record:parentRecord}));
 const managedChildren=[];
 for(let index=0;index<2;index++){
  const child=yield* sessionService.create({parentID:session.id});assert.equal(child.parentID,session.id);
  const userID='msg_cursor_stopped_user_'+index,assistantID='msg_cursor_stopped_assistant_'+index;
  const childScope={...scope,sessionID:child.id,userMessageID:userID,assistantMessageID:assistantID,accepted:{...accepted,id:userID},permit:{...scope.permit,sessionID:child.id}};
  const childRecord={info:{...assistant.info,id:assistantID,parentID:userID,sessionID:child.id,time:{created:130}},parts:[
   {id:'prt_stopped_text_'+index,type:'text',text:'retained before stop'},
   {id:'prt_stopped_tool_'+index,type:'tool',callID:'call_stopped_'+index,tool:'read',state:{status:'running',input:{path:'owned.txt'},metadata:{fixture:true},time:{start:131}}}
  ]};
  yield* Effect.promise(()=>ingress.persistOwned({...childScope,record:{...user,info:{...user.info,id:userID,sessionID:child.id}}}));
  managedChildren.push({session:child,scope:childScope,record:childRecord});
 }
 let ledgerSnapshot=null,managedPrompts=0,managedRestarts=0,childIndex=0,scheduler;
 const childFor=id=>{const child=managedChildren.find(child=>child.session.id===id);assert.ok(child);return child;};
 const managedExecutor=createManagedOpenCodeExecutor({pollIntervalMs:2,idleStablePolls:1,cursorReadOnly:true,transport:{
  createSession:async()=>managedChildren[childIndex++].session,readSession:async input=>childFor(input.sessionId).session,deleteSession:async()=>{},abortSession:async()=>true,
  promptSession:async input=>{managedPrompts++;const child=childFor(input.sessionId);await ingress.persistOwned({...child.scope,record:child.record});},
  readStatus:async input=>{const active=await Effect.runPromise(request('/api/session/active'));return {type:active[input.sessionId]?'busy':'idle'};},
  readMessages:async input=>{const rows=await Effect.runPromise(store.messages({sessionID:input.sessionId,order:'asc'}));return projectMessagePage(rows,{sessionID:input.sessionId,path:{cwd:directory,root:directory}}).records;},
  readOperatorAbort:input=>scheduler.readOperatorStop(input),
 }});
 scheduler=createManagedTaskScheduler({executor:managedExecutor,persistence:{load:async()=>null,save:async value=>{ledgerSnapshot=structuredClone(value);}}});
 const managedTasks=yield* Effect.promise(()=>Promise.all(managedChildren.map((_,index)=>scheduler.submit({idempotencyKey:'cursor-stop-restart-'+index,rootSessionId:session.id,directory,mode:'orchestrator',
  dispatchGroupId:'cursor-stop-wave',dispatchCallId:'call_cursor_stop',parentTaskId:null,providerId:'cursor-acp',modelId:'composer-2.5',agent:'explorer',variant:null,
  label:'Stopped explorer '+index,prompt:'Inspect without writing',timeoutAt:null}))));
 yield* Effect.promise(async()=>{const deadline=Date.now()+5000;while(managedTasks.some(task=>scheduler.getTask(task.taskId).status!=='running')){
  assert.ok(Date.now()<deadline,'Both managed Cursor children did not become running');await new Promise(resolve=>setTimeout(resolve,2));
 }});
 const activeBeforeStop=yield* request('/api/session/active');assert.ok(activeBeforeStop[session.id]);
 assert.ok(managedChildren.every(child=>activeBeforeStop[child.session.id]));assert.equal(managedPrompts,2);
 const beforeStopped=events.length;
 for(const child of managedChildren){
  const stopReceipt=yield* Effect.promise(()=>scheduler.recordOperatorStop({sessionId:child.session.id,directory,requestedAt:Date.now()}));assert.ok(stopReceipt);
  const invalidStopped={...child.record,parts:[{...child.record.parts[1],state:{...child.record.parts[1].state,status:'aborted'}}]};
  yield* Effect.promise(()=>assert.rejects(ingress.persistOwned({...child.scope,record:invalidStopped}),error=>error.code==='native_cursor_part_invalid'&&error.status===403));
  child.record.info.finish='cancelled';child.record.info.time.completed=140;
  child.record.parts[1].state={...child.record.parts[1].state,status:'cancelled',time:{start:131,end:140}};
  yield* Effect.promise(()=>ingress.persistOwned({...child.scope,record:child.record}));
  yield* Effect.promise(()=>scheduler.acceptOperatorStop(stopReceipt));
 }
 for(const task of managedTasks){
  const settled=yield* Effect.promise(()=>scheduler.waitForTask(task.taskId));assert.equal(settled.status,'aborted');assert.equal(settled.terminationIntent,'user_stopped');
  yield* Effect.promise(()=>assert.rejects(scheduler.acknowledgeResult(task.taskId,{action:'resume',idempotencyKey:'forbidden-agent-resume-'+task.taskId}),error=>error.code==='user_stopped_recovery_required'));
 }
 parentRecord.info.finish='cancelled';parentRecord.info.time.completed=150;parentRecord.parts[0].state={...parentRecord.parts[0].state,status:'cancelled',time:{start:125,end:150}};
 yield* Effect.promise(()=>ingress.persistOwned({...parentScope,record:parentRecord}));
 const activeAfterStop=yield* request('/api/session/active');assert.equal(activeAfterStop[session.id],undefined);assert.ok(managedChildren.every(child=>!activeAfterStop[child.session.id]));
 const parentStopped=yield* store.message(Schema.decodeUnknownSync(SessionMessage.ID)(parentAssistant));assert.equal(parentStopped.message.error.type,'aborted');assert.equal(parentStopped.message.content[0].state.status,'error');
 yield* Effect.promise(()=>scheduler.withRuntimeRestart(async()=>{managedRestarts++;assert.ok(ledgerSnapshot.tasks.every(task=>!['starting','running','cancelling'].includes(task.status)));}));
 assert.equal(managedRestarts,1);assert.equal(managedPrompts,2);assert.equal(scheduler.listTasks().length,2);
 yield* Effect.promise(()=>scheduler.shutdown());yield* Effect.promise(()=>managedExecutor.shutdown());
 const {scope:stoppedScope,record:stoppedRecord,session:stoppedSession}=managedChildren[0],stoppedAssistant=stoppedScope.assistantMessageID;
 const stopped=yield* store.message(Schema.decodeUnknownSync(SessionMessage.ID)(stoppedAssistant));
 assert.deepEqual(stopped.message.error,{type:'aborted',message:'Cursor execution interrupted'});
 assert.equal(stopped.message.content[0].text,'retained before stop');
 assert.equal(stopped.message.content[1].id,'call_stopped_0');
 assert.deepEqual(stopped.message.content[1].state,{status:'error',input:{path:'owned.txt'},metadata:{fixture:true},error:{type:'aborted',message:'Cursor tool interrupted'}});
 assert.equal(stopped.message.content[1].time.ran.epochMilliseconds,131);assert.equal(stopped.message.content[1].time.completed.epochMilliseconds,140);
 assert.equal((yield* store.get(session.id)).outcome,'interrupted');assert.equal((yield* request('/api/session/active'))[session.id],undefined);
 assert.ok(!events.slice(beforeStopped).some(event=>event.type==='session.execution.succeeded'));
 const stoppedCount=events.length;yield* Effect.promise(()=>ingress.persistOwned({...stoppedScope,record:stoppedRecord}));assert.equal(events.length,stoppedCount);
 const stoppedRows=yield* store.messages({sessionID:stoppedSession.id,order:'asc'});
 const stoppedRest=projectMessagePage(stoppedRows,{sessionID:stoppedSession.id,path:{cwd:directory,root:directory}}).records.find(row=>row.info.id===stoppedAssistant);
 assert.equal(stoppedRest.info.error.name,'MessageAbortedError');assert.equal(stoppedRest.parts[1].id,'prt_stopped_tool_0');
 globalThis.retainedCursor={scope,record:assistant};

 assert.ok(scoped.filter((_,i)=>events[i].type.startsWith('session.step.')||events[i].type==='session.message.content.updated').every(Boolean));
 assert.equal(yield* isNativeCursorIngress(),false);
 assert.equal(observationRpcs.length,0,'Private external Cursor publication borrowed native observation authority');
 assert.ok(events.some(event=>event.type==='session.step.started'));
 assert.ok(events.some(event=>event.type==='session.step.ended'));
 assert.ok(events.some(event=>event.type==='session.step.failed'));
 assert.ok(events.some(event=>event.type==='session.execution.interrupted'));
 // Copying genuine Cursor metadata cannot reproduce the private WeakSet scope.
 // The original emitter must still request fresh authority and retain refusal.
 const copied=events.find(event=>event.type==='session.step.started');
 assert.equal(copied.metadata.devryan.cursor.source,'cursor-acp');
 const warnings=[];const warningLogger=Logger.make(options=>{if(options.message.includes('native_observation_unavailable'))warnings.push(options.message);});
 yield* observation.observePublished(copied).pipe(Effect.provideService(OperationPermitRef,{token:'e'.repeat(64),revision:0,sessionID:session.id}),
  Effect.provideService(Logger.CurrentLoggers,new Set([warningLogger])));
 assert.deepEqual(observationRpcs,[{method:'native.observation',stage:'step-link'}]);assert.equal(warnings.length,1);
}).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
await assert.rejects(ingress.persistOwned({...globalThis.retainedCursor.scope,record:globalThis.retainedCursor.record}),/native_cursor_ingress_expired/);await ingress.close();
process.stdout.write(JSON.stringify({nativeBus:true,cumulativeCorrection:true,originalPartIDs:true,revocation:true,closed:true,privateMarker:true,externalObservationExcluded:true,forgedMetadataRefused:true,managedStopRestart:true}));
`;
    child = Bun.spawn([process.execPath, '--eval', source], { cwd: repository,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
        GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DEVRYAN_GRAPH_DIRECTORY: directory },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child?.kill('SIGKILL'), 40_000);
    try {
      const stdout = child.stdout, stderr = child.stderr;
      if (!stdout || typeof stdout === 'number' || !stderr || typeof stderr === 'number') throw Error('Owned pipes required');
      const [output, errors, code] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), child.exited]);
      if (code !== 0) throw Error(errors.slice(0, 16000));
      expect(code).toBe(0); expect(errors).toBe('');
      expect(JSON.parse(output)).toEqual({ nativeBus: true, cumulativeCorrection: true, originalPartIDs: true, revocation: true, closed: true, privateMarker: true, externalObservationExcluded: true, forgedMetadataRefused: true, managedStopRestart: true });
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45_000);
