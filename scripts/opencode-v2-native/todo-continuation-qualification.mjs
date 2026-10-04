import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createSessionExecutionHost} from '../../packages/web/server/lib/opencode/session-execution-host.js';
import {createManagedOrchestrationPrivateHost} from '../../packages/web/server/lib/orchestration/private-host.js';
import {createNativeAdmissionOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-owner.js';
import {createNativeSessionContextOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-session-context-owner.js';
import {createNativePrimaryStepOwner} from '../../packages/web/server/lib/opencode/runtime-host/primary-step-owner.js';
import {createOpenCodeClient} from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import {createPrivilegedOpenCodeClient} from '../../packages/web/server/lib/opencode/opencode-client/privileged.js';
import {createOpenCodeAdmission,createV2MessageId} from '../../packages/web/server/lib/opencode/v2/admission.js';
import {createNativeManagedFixture} from './managed-fixture.mjs';
import {verifyNativeAcceptanceArtifacts,repositoryRoot} from './artifacts.mjs';
import {createQaHostLaunchEnvironment} from '../qa/launch-environment.mjs';
import {reservePort} from '../qa/process.mjs';
import {startNativeFixtureProcess} from './fixture-process.mjs';

const exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code,statusCode:403});
const waitFor=async(read,predicate,label)=>{const deadline=Date.now()+30_000;for(;;){const value=await read();if(predicate(value))return value;assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,20));}};

/** Focused real native qualification. No provider traffic or installed-app state. */
export async function qualifyNativeTodoContinuation(){
 const artifacts=await verifyNativeAcceptanceArtifacts();
 const root=await fs.realpath(await fs.mkdtemp(path.join(repositoryRoot,'.cache/v2-validation/native-todo-')));
 const directory=path.join(root,'project'),home=path.join(root,'home'),tmp=path.join(root,'tmp'),dataDirectory=path.join(root,'web-data');
 for(const folder of [directory,tmp,dataDirectory,...['config','data','state','cache','git-template'].map(name=>path.join(home,name))])await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
 const gitConfig=path.join(root,'git-config');await fs.writeFile(gitConfig,'');
 const env=createQaHostLaunchEnvironment({HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),
  XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),TMPDIR:tmp,TMP:tmp,TEMP:tmp,
  GIT_CEILING_DIRECTORIES:root,GIT_CONFIG_GLOBAL:gitConfig,GIT_CONFIG_NOSYSTEM:'1'});
 const probe=spawnSync('bun',['--print','process.execPath'],{cwd:root,env,encoding:'utf8'});assert.equal(probe.status,0);const bun=probe.stdout.trim();assert.ok(path.isAbsolute(bun));
 await exec('git',['init','--quiet',`--template=${path.join(home,'git-template')}`],{cwd:directory,env});
 const rgTarget=path.join(home,'cache/opencode/bin/rg');await fs.mkdir(path.dirname(rgTarget),{recursive:true});await fs.copyFile(artifacts.rg,rgTarget);await fs.chmod(rgTarget,0o755);
 const token=randomBytes(32).toString('base64url'),observations=[],diagnostics=[];
 const contextDigest=hash(await fs.readFile(path.join(repositoryRoot,'packages/web/server/lib/opencode/runtime-host/native-session-context.ts')));
 let child,nativeUrl,owner,managed,context,step,nativeEpoch=1,instanceID=randomUUID(),runnerGate,runnerBlocked=false,lostAck=false,sessionID;
 const deps={getRuntime:()=>({generation:2,baseUrl:nativeUrl,version:'2.0.20',epoch:nativeEpoch}),
  getAuthHeaders:()=>({authorization:`Bearer ${token}`,...owner?.requestHeaders()}),
  withNativeWebOperation:(input,action)=>owner.withWebOperation(input,action),recordDiagnostic:row=>diagnostics.push(row)};
 const admission=createOpenCodeAdmission(deps,{beforePromptDispatch:(receipt,context)=>managed.admitNativePrompt(receipt,context),onPromptDispatchFailure:receipt=>managed.markNativePromptUncertain(receipt),
  nativeOwner:{requestHeaders:()=>owner.requestHeaders(),withAcceptedOperation:(input,action)=>owner.withAcceptedOperation(input,action),checkQueuedPromptAdmission:(...args)=>owner.checkQueuedPromptAdmission(...args),
    stageQueuedPromptAdmission:(...args)=>owner.stageQueuedPromptAdmission(...args),
    assertQueuedPromptReconciled:(...args)=>owner.assertQueuedPromptReconciled(...args),
    queuedPromptWasRejected:(...args)=>owner.queuedPromptWasRejected(...args),
    updateAcceptedOperation:input=>owner.updateAcceptedOperation(input)}});
 const client=createOpenCodeClient({...deps,getAdmission:()=>admission}),privileged=createPrivilegedOpenCodeClient(deps);
 const host=createSessionExecutionHost({dataDirectory,openCodeClient:client,getLauncher:()=>artifacts.launcher,
  buildOpenCodeUrl:route=>new URL(route,nativeUrl).href,getOpenCodeAuthHeaders:deps.getAuthHeaders,onDiagnostic:row=>diagnostics.push(row),
  nativeExecution:{isReady:()=>!!nativeUrl,socketDirectory:null,workerBrowsers:false,readRoots:[directory],protectedRoots:[home,dataDirectory],helperRoots:[directory],gitCommand:'/usr/bin/git',
   workerCommand:bun,workerArgs:[path.join(repositoryRoot,'packages/web/server/lib/opencode/runtime-host/writer-worker.ts')],workerEnvironment:env,
   recheckPermit:input=>owner.recheckExecution(input),stopSessions:async({sessions})=>{for(const id of sessions)await child.call({action:'hold',sessionID:id});return {terminated:true,sessions};}}});
 owner=createNativeAdmissionOwner({runtime:host.runtime,directory,ownerID:`todo_${hash(path.join(home,'data/native.db'))}`,withSessionLock:admission.withSessionLock,
    verifyQueuedPrimaryIdle:input=>child.call({action:'queued-primary-idle-owned',...input}),
    readQueuedPrimaryRecord:sessionID=>managed.primaryRuntime.readRecord(sessionID),
    captureQueuedPrimaryAdmission:sessionID=>managed.primaryRuntime.captureNativePromptAdmission(sessionID),
  getSession:id=>client.sessions.get(id,{directory}),readSessionMetadata:input=>privileged.readSessionMetadata(input.sessionID,{directory:input.directory}),verifyManagedTaskDispatch:input=>managed.verifyNativeTaskDispatch(input),
  verifyPrimaryContinuationDispatch:input=>managed.primaryRuntime.captureNativeContinuationDispatch({...input,instanceID}),
  captureWebAuthorization:async(request,session)=>{
   assert.equal(request.directory,directory);if(request.sessionID)assert.equal(request.sessionID,session?.id);
   return async()=>assert.equal(await fs.realpath(session?.directory??directory),directory);
  },
  authorizeOperation:async(request,session)=>{
   if(session)assert.equal(session.directory,directory);
   const allowed=['session.create','tool.execute','runner.drain','store.claim','store.countResume','session.generate','execution.wake','execution.resume','inbox.compaction'];
   if(request.operation==='primary.step'){assert.equal(request.parentAuthorization?.operation,'runner.drain');return;}
   assert.ok(allowed.includes(request.operation),`Unexpected TODO operation ${request.operation}`);
   if(request.operation==='tool.execute'){assert.equal(request.input.provenance.id,'devryan.harness-context');assert.equal(request.input.provenance.manifestDigest,contextDigest);assert.ok(['todowrite','todoread'].includes(request.input.toolID));}
   if(request.operation==='runner.drain'&&runnerGate&&request.sessionID===sessionID){runnerBlocked=true;await runnerGate.promise;}
  }});
 managed=createNativeManagedFixture({client,admissionOwner:owner,executionHost:host,directory,dataDirectory,buildOpenCodeUrl:route=>new URL(route,nativeUrl).href,
  getOpenCodeAuthHeaders:deps.getAuthHeaders,environment:env,observations,diagnostics});
 const makeOwners=()=>{
  step=createNativePrimaryStepOwner({admissionOwner:owner,openCodeClient:client,primaryRuntime:managed.primaryRuntime,instanceID});
  context=createNativeSessionContextOwner({admissionOwner:owner,taskContext:managed.taskContext,openCodeClient:client,primaryRuntime:managed.primaryRuntime,instanceID,
   isHeld:async input=>{const state=await host.runtime.nativeAdmissionState(input);return state.held||state.reverting;},
   readSessionMetadata:input=>privileged.readSessionMetadata(input.sessionID,{directory:input.directory}),
   authorizeContext:input=>owner.captureContextAuthorization(input),
   writeTodos:async({sessionID:target,directory:project,todos,invocation},recheck)=>{
    const current=await privileged.readSessionMetadata(target,{directory:project}),metadata=structuredClone(current.metadata);
    const rev=metadata.devryan?.todo?.rev??0;
    metadata.devryan={...metadata.devryan,todo:{sessionID:target,items:todos,rev:rev+1}};
    return owner.withNativeTodoWrite({invocation,metadata},async()=>{await recheck();await privileged.setMetadata(target,metadata,{directory:project});await recheck();return metadata.devryan.todo;});
   },
   deliverContinuation:async({scope,prompt},recheck)=>{
    await recheck();await owner.withPrimaryContinuationDispatch(scope,()=>client.prompts.prompt(scope.sessionID,prompt,{directory,origin:'managed-primary',objectiveID:prompt.objectiveID}));
    if(lostAck)throw fail('fixture_lost_todo_ack');
    const record=await managed.primaryRuntime.readRecord(scope.sessionID);if(!record.nativeContinuation&&record.continuationID===scope.messageID)return;
    await owner.withPrimaryContinuationOperation(scope,permit=>child.call({action:'reconcile-primary-owned',...scope,permit}));
   }});
 };
 makeOwners();
 const bridge=createManagedOrchestrationPrivateHost({handleRpc:async({method,params},rpcContext)=>{
  try{
   if(method==='native.primary-step')return await step(params);
   if(method==='native.session-context.tool')return await context.tool(params,rpcContext);
   if(method==='native.session-context.observe-tool')return await context.observeTool(params,rpcContext);
   if(method==='native.session-context')return await context.context(params,rpcContext);
   if(method.startsWith('native.admission.'))return await owner.handleRpc(method,params);
   if(method.startsWith('execution.native.'))return await host.nativeExecution({...params,action:method.slice('execution.native.'.length)},rpcContext);
   throw fail('todo_fixture_rpc_unknown');
  }catch(error){diagnostics.push({method,operation:params?.operation,code:error.code??error.message});throw error;}
 }});
 let failure,cleanup;
 try{
  const privateEnv=await bridge.start();
  const settingsFile=path.join(root,'settings.json');
  await fs.writeFile(settingsFile,JSON.stringify({root,directory,token,databasePath:path.join(home,'data/native.db'),bridgeUrl:privateEnv.DEVRYAN_ORCHESTRATION_URL,
   bridgeToken:privateEnv.DEVRYAN_ORCHESTRATION_TOKEN,contextDigest,coreDigest:artifacts.packages.core.manifestSha256,simulationDigest:artifacts.packages.simulation.providerSha256,
   simulationEndpoint:`ws://127.0.0.1:${await reservePort()}`,configuration:{model:'sim/m1',shell:'/bin/sh',snapshots:false,permissions:[{action:'*',resource:'*',effect:'allow'}],
    providers:{sim:{name:'Owned TODO simulator',package:'@ai-sdk/openai-compatible',settings:{baseURL:'https://api.openai.com/v1',apiKey:'fixture'},models:{m1:{name:'TODO fixture',limit:{context:200000,output:32000}}}}},
    agents:{orchestrator:{mode:'primary',model:'sim/m1'},title:{disabled:true}}}}),{mode:0o600});
  const launch=()=>startNativeFixtureProcess(bun,[path.join(repositoryRoot,'scripts/opencode-v2-native/todo-fixture-host.ts'),settingsFile],{cwd:directory,env});
  child=launch();nativeUrl=(await child.ready).url;await child.call({action:'open'});
  const session=await client.sessions.create({title:'Actual native TODO continuation',agent:'orchestrator',model:{providerID:'sim',modelID:'m1'}},{directory});sessionID=session.id;
  await managed.admitPrimary(sessionID);
  await client.prompts.prompt(sessionID,{messageID:createV2MessageId(),agent:'orchestrator',model:{providerID:'sim',modelID:'m1'},variant:'default',parts:[{type:'text',text:'Complete the actual TODO fixture.'}]},{directory,delivery:'queue'});
  await waitFor(()=>client.sessions.messages(sessionID,{}, {directory}),page=>page.records.some(row=>row.parts?.some(part=>part.type==='text'&&part.text==='TODO remains open')),'Initial TODO native turn failed');
  await waitFor(()=>client.sessions.status({directory}),states=>!states[sessionID]||states[sessionID].type==='idle','Native TODO source remained busy');
  const initial=await managed.primaryRuntime.readRecord(sessionID);const source=await client.sessions.message(sessionID,initial.stepID,{directory});assert.equal(source.info.id,initial.stepID);assert.equal(source.turnOwnership.source,'native-sequence');assert.ok(source.info.time.completed);
  const initialPage=await client.sessions.messages(sessionID,{}, {directory});const initialTools=initialPage.records.flatMap(row=>row.parts??[]).filter(part=>part.type==='tool');assert.equal(initialTools.find(part=>part.callID==='todo_initial')?.state.status,'completed',JSON.stringify(initialTools));
  assert.equal((await privileged.readSessionMetadata(sessionID,{directory})).metadata.devryan.todo.items[0].status,'pending');
  runnerGate={};runnerGate.promise=new Promise((resolve,reject)=>{runnerGate.resolve=resolve;runnerGate.reject=reject;});lostAck=true;
  await assert.rejects(context.continueTodos({sessionID,directory}),/fixture_lost_todo_ack/);
  await waitFor(async()=>runnerBlocked,value=>value,'Reserved TODO runner did not reach actual admission');
  const reserved=await managed.primaryRuntime.readRecord(sessionID);assert.ok(reserved.nativeContinuation);const continuationID=reserved.nativeContinuation.messageID;
  const inbox=await client.sessions.messages(sessionID,{}, {directory});assert.equal(inbox.records.some(row=>row.info.role==='assistant'&&row.info.parentID===continuationID),false);
  const actualInbox=await fetch(`${nativeUrl}/api/session/${sessionID}/inbox`,{headers:deps.getAuthHeaders()});assert.equal(actualInbox.status,200);
  const pending=await actualInbox.json();assert.ok(JSON.stringify(pending).includes(continuationID),'Actual native queued TODO ID absent');
  const previous=child;const crashed=await previous.crash();await fs.writeFile(path.join(root,'controller-1.log'),previous.getLog());
  runnerGate.reject(fail('fixture_old_controller_closed'));runnerGate=undefined;
  await host.nativeExecution({action:'cancel-sessions',sessions:[sessionID]});await owner.invalidateController();
  nativeUrl=undefined;nativeEpoch++;instanceID=randomUUID();makeOwners();lostAck=false;
  child=launch();nativeUrl=(await child.ready).url;await child.call({action:'recovered'});await child.call({action:'open'});
  await context.recoverContinuations({directory});
  const page=await waitFor(()=>client.sessions.messages(sessionID,{}, {directory}),value=>value.records.some(row=>row.parts?.some(part=>part.type==='text'&&part.text==='TODO is complete')),'Recovered TODO native inference did not complete');
  const final=await managed.primaryRuntime.readRecord(sessionID);
  assert.equal(final.continuationID,continuationID);assert.equal(final.nativeContinuation,undefined);assert.equal(final.todoContinuationCount,reserved.todoContinuationCount);assert.equal(final.todoContinuationCount,1);assert.equal(final.anchorID,initial.anchorID);
  assert.equal(page.records.filter(row=>row.info.id===continuationID&&row.info.role==='user').length,1);
  const recoveredAssistants=page.records.filter(row=>row.info.role==='assistant'&&row.info.parentID===continuationID&&row.info.time?.completed);
  assert.equal(recoveredAssistants.length,2,'Expected exactly the native tool round and final text round');
  assert.equal(new Set(recoveredAssistants.map(row=>row.info.id)).size,2);
  assert.equal(recoveredAssistants.filter(row=>row.parts.some(part=>part.type==='text'&&part.text==='TODO is complete')).length,1);
  assert.equal(recoveredAssistants.filter(row=>row.parts.some(part=>part.type==='tool'&&part.callID==='todo_recovered')).length,1);
  const tools=page.records.flatMap(row=>row.parts??[]).filter(part=>part.type==='tool');
  for(const callID of ['todo_initial','todo_recovered'])assert.equal(tools.filter(part=>part.callID===callID&&part.state.status==='completed').length,1);
  assert.equal((await privileged.readSessionMetadata(sessionID,{directory})).metadata.devryan.todo.items[0].status,'completed');
  assert.equal((await privileged.readSessionMetadata(sessionID,{directory})).metadata.devryan.todo.rev,2);
  const recoveredState=(await child.call({action:'state'})).result;assert.equal(recoveredState.requests,2);assert.equal(recoveredState.finished,true);
  const before=recoveredState.requests;await context.recoverContinuations({directory});assert.equal((await child.call({action:'state'})).result.requests,before);
  observations.push({phase:'qualified',sessionID,continuationID,sourceAssistantID:initial.stepID,finalAssistantID:final.stepID,crashed});
 }catch(error){failure=error;}
 finally{
  runnerGate?.reject(fail('fixture_cleanup'));
  const results=await Promise.allSettled([child?.stop()]);cleanup=results;
  if(child)await fs.writeFile(path.join(root,'controller-final.log'),child.getLog());
  const remaining=await Promise.allSettled([managed.close(),host.drain()]);cleanup.push(...remaining);owner.dispose();await bridge.stop();
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify({status:failure?'failed':'passed',observations,diagnostics,
   failure:failure&&{message:failure.message,stack:failure.stack},cleanup:cleanup.map(row=>({status:row.status,...(row.status==='rejected'?{error:row.reason.message}:{})}))},null,2));
 }
 if(failure)throw Object.assign(failure,{root});
 assert.ok(cleanup.every(row=>row.status==='fulfilled'),'Actual TODO qualification cleanup failed');return {root,observations};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 qualifyNativeTodoContinuation().then(value=>process.stdout.write(JSON.stringify(value)+'\n'),error=>{process.stderr.write(JSON.stringify({root:error.root,error:error.message})+'\n');process.exitCode=1;});
}
