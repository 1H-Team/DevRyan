import { testCaseShard } from '../test-case-shard.mjs';
import {afterAll,expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
// The verified inputs and pinned asset rewrites are read-only plugin state; hashing the
// 334 MB reviewed-inputs tree once per file, not once per build (28 builds), is enough.
let reviewedBuildPluginsPromise:Promise<[import('bun').BunPlugin,import('bun').BunPlugin]>|undefined;
const reviewedBuildPlugins=()=>reviewedBuildPluginsPromise??=Promise.all([createNativeAssetFixturePlugin(repository),
 prepareReviewedNativeInputs(repository).then(reviewedNativeInputPlugin)]);
// Every scenario runs one shared program; the compiled executable of that same
// program is proven on the success path and the tool-denial path.
const cases:Array<{scenario:string;slim:boolean;compiled:boolean;setter?:string}>=[...['continue','exhausted','plain-retry','stop-publication','missing-attempt'].map(scenario=>({scenario,slim:false,compiled:false})),{scenario:'continue',slim:true,compiled:false},{scenario:'exhausted',slim:true,compiled:false},{scenario:'continue',slim:false,compiled:true},{scenario:'silence',slim:false,compiled:false},{scenario:'denied-tool',slim:false,compiled:false},{scenario:'denied-tool',slim:false,compiled:true},...['text-start','reasoning-start','tool-input-start','tool-input-error','tool-call'].map(setter=>({scenario:'setter-'+setter,slim:false,compiled:process.env.DEVRYAN_NATIVE_STREAM_COMPILED_SETTERS==='1',setter})),...['late-provider-error','late-content-filter'].map(scenario=>({scenario,slim:false,compiled:false}))];
type FixtureConfig={scenario:string;slim:boolean;setter?:string};
// The generated program reads its scenario from DEVRYAN_STREAM_FIXTURE at runtime, so every
// scenario shares one bundle (and one compiled executable) instead of building 28 variants.
let buildRootPromise:Promise<string>|undefined,bundlePromise:Promise<string>|undefined,executablePromise:Promise<string>|undefined,buildRoot:string|undefined;
const sharedBuildRoot=()=>buildRootPromise??=fs.mkdtemp(path.join(repository,'.cache/v2-validation/native-stream-build-')).then(root=>buildRoot=root);
const fixtureSource=async(root:string)=>{
  const sourcePath=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');let source=await fs.readFile(sourcePath,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw Error('Native graph fixture changed: '+before);source=source.replace(before,after);};
  source=`import {createNativeObservation} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-observation.ts'))};
import {createControllerWebfetch} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/controller-webfetch.ts'))};
import * as helperOriginals from ${JSON.stringify(path.join(repository,'packages/agents-core/src/devryan/index.ts'))};
import {createNativeStreamContinuationOwner} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-stream-continuation-owner.js'))};
import {createNativePlanDenialOwner} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-plan-denial-owner.js'))};
import {createPrimaryRecoveryHost} from ${JSON.stringify(path.join(repository,'packages/harness-runtime/lib/provider-recovery-host.js'))};
import {createNativePrimaryStepOwner} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/primary-step-owner.js'))};
import {SessionMessage} from '@opencode/core/session/message';
import {LLMRequest} from '@opencode/ai';
import {HttpOptions} from '@opencode/ai/schema/options';
import {primaryStepOverride} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/primary-step.ts'))};
const FIXTURE=JSON.parse(process.env.DEVRYAN_STREAM_FIXTURE);
`+source;
  replace('let initialPairReleased=false;','let initialPairReleased=true;');
  replace('let nativeURL, ready = false, handler, map,',`let primaryRuntime,realPrimaryStep,streamOwner,nativeStore,nativeExecution,slimOwner,slimContext;const published=[],streamTransitions=[],bodyTimings=[],transportFailures=[],nativeRetryProposals=[],outputFlags=[];const streamRefusals=[];let primaryRequests=0;let nativeURL, ready = false, handler, map,`);
  replace('const options = { database:',"const options = { app:{name:'DevRyan native stream graph',version:'2.1.4',channel:'fixture'},database:");
  replace('let result, primaryFailure;','let result, primaryFailure, client;');
  replace('  const client = createOpenCodeClient(', '  client = createOpenCodeClient(');
  replace('const configuration = { model:',`const configuration = { commands:{interview:{description:'Owned stream fixture',template:'Original owned objective $ARGUMENTS'}}, model:`);
  replace('  withSessionLock: lock,',`  ...(FIXTURE.scenario==='denied-tool'?{readPlanPolicy:async()=>({readOnly:true}),recordPlanToolDenial:createNativePlanDenialOwner({runtime,readMessage:(sessionID,messageID,directory)=>client.sessions.message(sessionID,messageID,{directory})})}:{}),
  getReviewedConfiguration:directory=>snapshot.locations.find(row=>row.directory===directory)?.configuration,
  verifyQueuedPrimaryIdle:input=>gates.controls.queuedPrimaryIdleOwned(input),captureQueuedPrimaryAdmission:sessionID=>primaryRuntime.captureNativePromptAdmission(sessionID),
  readQueuedPrimaryRecord:sessionID=>primaryRuntime.readRecord(sessionID),
  captureCommandPromptAdmission:async({sessionID,directory})=>{const original=callerContext.getStore();assert.equal(original,caller);
   return {admit:(receipt,authorizeWrite)=>{assert.equal(receipt.sessionID,sessionID);assert.equal(receipt.directory,directory);assert.equal(original.active,true);return primaryRuntime.admitNativePrompt(receipt,{sessionID,owner:null,authorizeWrite});},uncertain:receipt=>primaryRuntime.markNativePromptUncertain(receipt)};},
  readUserMessage:async input=>{const value=await Effect.runPromise(nativeStore.message(SessionMessage.ID.make(input.messageID)));return value&&{...value.message,sessionID:value.sessionID,directory:input.directory};},
  withSessionLock: lock,`);
  replace('const rpc = async (method, input, context) => {',`const rpc = async (method, input, context) => {
  input=input===undefined?undefined:JSON.parse(JSON.stringify(input));
  if(method==='fixture.transport-error'){transportFailures.push(input);return null;}
  if(method==='fixture.output-flags'){outputFlags.push(input);return null;}
  if(method==='fixture.native-retry'){nativeRetryProposals.push(input);return null;}
  if(method==='native.provider-timing'){bodyTimings.push(input);return null;}
  if(method==='native.observation')return null;
  if(method==='native.primary-step')return realPrimaryStep(input);
  if(method==='native.stream-continuation'){try{const answer=await streamOwner(input);streamTransitions.push({action:input.action,answer,record:await primaryRuntime.readRecord(input.sessionID)});return answer;}catch(error){streamRefusals.push({action:input.action,code:error.code});await fs.appendFile(path.join(root,'rpc-errors.jsonl'),JSON.stringify({method,action:input.action,code:error.code,message:error.message})+'\\n');throw error;}}
`);
  {
   const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
   source=`import {createControllerSlim} from ${JSON.stringify(path.join(host,'controller-slim.ts'))};
import {createNativeSlimOwner} from ${JSON.stringify(path.join(host,'native-slim-owner.js'))};
import {createNativeSlimContextOwner} from ${JSON.stringify(path.join(host,'native-slim-context-owner.js'))};
import * as originals from ${JSON.stringify(path.join(repository,'packages/agents-core/src/devryan/index.ts'))};
`+source;
   replace('const runtime = createSessionMutationRuntime(',`if(FIXTURE.slim)for(const row of snapshot.locations)row.compatibility.slim={mergedConfig:{autoUpdate:false,companion:{enabled:false},backgroundJobs:{orchestratorWake:{enabled:false}},webfetch:{enabled:false}},nativeRuntime:{runtimeChains:{},fallback:{enabled:false}}};
const runtime = createSessionMutationRuntime(`);
   replace("  if(method==='native.provider-timing'){",`  if(method==='native.slim.hook')return slimOwner.hook(input,context);
  if(method==='native.slim.path')return slimOwner.path(input,context);
  if(method==='native.slim.context')return input.action==='retry'?slimContext.retry(input,context):slimContext.transformMessages(input,context);
  if(method==='native.provider-timing'){`);
   replace('const gates = createAdmissionGates({',`const slimOrigin={kind:'plugin',id:'devryan.slim',manifestDigest:'a'.repeat(64),capabilities:['read','write','network','process']};
const unavailable=()=>{throw Error('unexpected_fixture_owner');};
const actualSlim=!FIXTURE.slim?undefined:createControllerSlim({snapshot,origin:slimOrigin,originals,rpc,executeOwned:unavailable,withControl:(_invocation,action)=>action,
 commands:{assertCommand:unavailable,executeCommand:unavailable},webfetchBinaryDirectory:directory=>directory,webfetchOwnersFor:unavailable,
 interviewForDirectory:()=>({runtime:{},service:{getActiveInterviewId:async()=>null,handleCommandExecuteBefore:unavailable,handleEvent:async()=>{}},submitCommand:unavailable,assertAcceptedCommand:unavailable,assertCurrent:async()=>{},dispose:async()=>{}}),
 observePrompt:async()=>{},observeLifecycle:async()=>{},transformImages:async()=>{},disposeLocation:async()=>{},log:()=>{}});
const gates = createAdmissionGates({...(FIXTURE.slim?{sessionHooks:(inner,location,owners)=>actualSlim.decorateHooks(inner,location,owners)}:{}),`);
   replace('plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin}]','plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin},...(FIXTURE.slim?[{plugin:actualSlim.plugin,origin:slimOrigin}]:[])]');
  }
  replace('const gates = createAdmissionGates({',`const webfetchScope=createControllerWebfetch({tmpDirectory:globals.tmp,originals:helperOriginals,withSecondary:()=>Effect.die(Error('Unexpected stream fixture secondary'))});
const observation=createNativeObservation({controllerInstanceID:controller.instanceID,configurationDigest:snapshot.digest,rpc,streamContinuation:true,decorateLlmClient:webfetchScope.captureLlmClient,
   ...(FIXTURE.scenario==='silence'?{decorateModelRequests:inner=>Effect.succeed({...inner,primary:input=>inner.primary(input).pipe(Effect.map(prepared=>({...prepared,request:LLMRequest.update(prepared.request,{http:new HttpOptions({...prepared.request.http,chunkTimeout:250})})})))})}:{})});
const gates = createAdmissionGates({executionActivity:inner=>{nativeExecution=inner;return inner;},captureSessionStore:inner=>{nativeStore=inner;return Effect.succeed(inner);},`);
  replace('...factory.overrides,...compatibility.overrides,',`...factory.overrides,...compatibility.overrides,...webfetchScope.overrides,...observation.overrides,primaryStepOverride(rpc,undefined,(event,disposition)=>Effect.sync(()=>published.push(event)).pipe(Effect.andThen(observation.observePublished(event,disposition))),undefined,undefined,undefined,undefined,events=>gates.controls.prepareQueuedPublication(events),event=>gates.controls.assertQueuedPublication(event),sessionID=>gates.controls.interruptStoppedHandoff(sessionID)),`);
  replace("      if(kind==='title'){initialPairReleased=true;releaseInitialPair();}",`      if(kind==='title'){initialPairReleased=true;releaseInitialPair();}
      if(kind==='primary')primaryRequests++;
      if(kind==='primary'&&FIXTURE.scenario==='denied-tool'&&primaryRequests===1){
       const item={id:'denied_item',type:'function_call',call_id:'denied_call',name:'patch',arguments:JSON.stringify({patchText:'*** Begin Patch\\n*** Add File: '+directories[0]+'/must-never-write.txt\\n+Forbidden Plan write\\n*** End Patch'}),status:'completed'};
       const result={id:'denied_response',object:'response',created_at:Math.floor(Date.now()/1000),model:'gpt-6.1-sol',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
       const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}},
        {type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments},{type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:item.arguments},
        {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result}];
       response.writeHead(200,{'content-type':'text/event-stream'});response.end(events.map(value=>'data: '+JSON.stringify(value)+'\\n\\n').join(''));return;
      }

      if(kind==='primary'&&FIXTURE.scenario==='plain-retry'&&primaryRequests===1){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Fixture unavailable',type:'server_error'}}));return;}`);
  replace("      response.end(events.map(value => `data: ${JSON.stringify(value)}\\n\\n`).join('')); return;",`      if(kind==='primary'&&FIXTURE.scenario==='silence'&&primaryRequests===1){response.write(events.slice(0,3).map(value=>'data: '+JSON.stringify(value)+'\\n\\n').join(''));return;}
      if(kind==='primary'&&(FIXTURE.scenario.startsWith('late-')||Boolean(FIXTURE.setter)||FIXTURE.scenario==='missing-attempt'||FIXTURE.scenario==='exhausted'||FIXTURE.scenario==='stop-publication'||FIXTURE.scenario==='continue'&&primaryRequests===1||FIXTURE.scenario==='denied-tool'&&primaryRequests===2)){
       response.end(events.slice(0,3).map(value=>'data: '+JSON.stringify(value)+'\\n\\n').join(''));return;
      }
      response.end(events.map(value=>'data: '+JSON.stringify(value)+'\\n\\n').join(''));return;`);
  const begin=source.indexOf('  const session = await callerContext.run(caller, () => client.sessions.create('),end=source.indexOf('} catch (error) { primaryFailure = error;');if(begin<0||end<begin)throw Error('Native graph main changed');
  source=source.slice(0,begin)+`
  const directory=directories[0];
  primaryRuntime=createPrimaryRecoveryHost({dataDirectory:path.join(root,'primary-recovery'),openCodeClient:client,mode:'observe',progressTimeoutMs:false,isManaged:()=>true,managedBarrier:async()=>({state:'clear'}),...(FIXTURE.scenario==='denied-tool'?{executionOutcomes:input=>runtime.executionOutcomes(input)}:{}),authorize:async()=>caller.active});
  await primaryRuntime.initialize();realPrimaryStep=createNativePrimaryStepOwner({admissionOwner,openCodeClient:client,primaryRuntime,instanceID:controller.instanceID,allowStopHandoff:true});
  if(FIXTURE.slim){slimOwner=createNativeSlimOwner({admissionOwner,openCodeClient:client,configurationSnapshot:snapshot,locations:directories.map(directory=>({directory,readRoots:[directory],protectedRoots:[globals.home]}))});slimContext=createNativeSlimContextOwner({admissionOwner,openCodeClient:client,primaryRuntime,getManagedRuntime:()=>{throw Error('build_context_has_no_managed_board');},getInstanceID:()=>controller.instanceID,originals,locations:snapshot.locations});}
  const actualOwner=createNativeStreamContinuationOwner({instanceID:controller.instanceID,configurationDigest:snapshot.digest,admissionOwner,openCodeClient:client,primaryRuntime,isCurrent:()=>ready});
  streamOwner=async input=>{const answer=await actualOwner(input);if(FIXTURE.scenario==='stop-publication'&&input.action==='reserve'&&answer===true)await primaryRuntime.control(input.sessionID,'stop');return answer;};
  const session=await callerContext.run(caller,()=>client.sessions.create({title:'Owned stream fixture',model:{providerID:'openai',modelID:'gpt-6.1-sol'}},{directory}));
  await callerContext.run(caller,()=>client.prompts.command(session.id,{command:'interview',arguments:'preserve objective',agent:'build',model:{providerID:'openai',modelID:'gpt-6.1-sol'}},{directory}));
  // Hang detection, not a performance bound: retries with real backoff can take
  // well over 25 s on a loaded host. The settled state asserted below is unchanged.
  const deadline=Date.now()+120_000;let record,done=false;
  while(Date.now()<deadline){record=await primaryRuntime.readRecord(session.id);const messages=await client.sessions.messages(session.id,{limit:100},{directory});
   const assistants=messages.records.filter(row=>row.info.role==='assistant');
   if(FIXTURE.scenario.startsWith('late-'))done=primaryRequests===1&&assistants.some(row=>row.info.time.completed&&row.info.error)&&await Effect.runPromise(nativeExecution.isActive(session.id))===false;
   else if(Boolean(FIXTURE.setter)&&!['text-start','reasoning-start'].includes(FIXTURE.setter??''))done=streamRefusals.some(row=>row.action==='reserve')&&await Effect.runPromise(nativeExecution.isActive(session.id))===false;
   else if(Boolean(FIXTURE.setter))done=record?.state==='needs_attention'&&await Effect.runPromise(nativeExecution.isActive(session.id))===false;
   else if(['exhausted','stop-publication'].includes(FIXTURE.scenario))done=record?.state===(FIXTURE.scenario==='exhausted'?'needs_attention':'cancelled')&&await Effect.runPromise(nativeExecution.isActive(session.id))===false;
   else if(FIXTURE.scenario==='missing-attempt')done=primaryRequests===2&&assistants.some(row=>row.info.time.completed&&row.info.error)&&await Effect.runPromise(nativeExecution.isActive(session.id))===false;
   else done=assistants.some(row=>row.info.time.completed&&!row.info.error)&&await Effect.runPromise(nativeExecution.isActive(session.id))===false;
   if(done)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  await fs.writeFile(path.join(root,'stream-proof.json'),JSON.stringify({done,primaryRequests,record,events:published.map(row=>row.type),deniedToolErrors:published.filter(row=>row.type==='session.tool.failed').map(row=>row.data.error),
   deniedOutcomes:(FIXTURE.scenario==='denied-tool'?await runtime.executionOutcomes({directory,sessionID:session.id,calls:[{messageID:published.find(row=>row.type==='session.step.started'&&row.data.sessionID===session.id).data.assistantMessageID,callID:'denied_call'}]}):[]),
   outputFlags,transitions:streamTransitions.map(row=>({action:row.action,answer:row.answer,consumed:row.record?.nativeStream?.consumed,pending:Boolean(row.record?.nativeStream?.pending),committed:Boolean(row.record?.nativeStream?.committed)})),bodyTimings}));
  assert.equal(done,true,'Actual pinned native runner did not settle');
  assert.equal(primaryRequests,FIXTURE.scenario.startsWith('late-')?1:FIXTURE.setter?(['text-start','reasoning-start'].includes(FIXTURE.setter)?3:1):['exhausted','denied-tool'].includes(FIXTURE.scenario)?3:FIXTURE.scenario==='stop-publication'?1:2);
  const synthetics=published.filter(row=>row.type==='session.synthetic'&&row.data.sessionID===session.id),steps=published.filter(row=>row.type==='session.step.started'&&row.data.sessionID===session.id);
  assert.equal(record.anchorID,steps.length?(await client.sessions.message(session.id,steps[0].data.assistantMessageID,{directory})).info.parentID:record.anchorID);
  if(['continue','silence'].includes(FIXTURE.scenario)){assert.equal(synthetics.length,1);assert.equal(steps.length,2);assert.equal(record.nativeStream.consumed,1);assert.equal(record.nativeStream.pending,undefined);assert.equal(record.nativeStream.committed,undefined);assert.equal(record.activeUserID,SessionMessage.ID.fromEvent(synthetics[0].id));}
  if(FIXTURE.scenario==='denied-tool'){assert.equal(synthetics.length,1);assert.equal(steps.length,3);assert.equal(record.nativeStream.consumed,1);
   assert.equal((await runtime.executionOutcomes({directory,sessionID:session.id,calls:[{messageID:steps[0].data.assistantMessageID,callID:'denied_call'}]}))[0].outcome,'never_started');
   assert.equal(await fs.stat(path.join(directory,'must-never-write.txt')).then(()=>true,()=>false),false);}
  if(FIXTURE.scenario==='silence'){assert.ok(transportFailures.some(row=>row.reason._tag==='Transport'&&row.reason.code==='Timeout'&&row.reason.operation==='read'));assert.ok(nativeRetryProposals.some(row=>row.retry===true&&row.outputStarted===true));
   // The chunk timeout wraps the HTTP middleware from outside; the typed stream error still reports it.
   // The host is the request's target (the fixture serves the OAuth route's URL locally).
   const failed=bodyTimings.filter(row=>row.event==='failed');assert.equal(failed.length,1);
   assert.equal(failed[0].kind,'primary');assert.equal(failed[0].transport,'http');assert.equal(failed[0].statusCode,null);
   assert.deepEqual(Object.keys(failed[0].failure).sort(),['code','elapsedMs','host','modelID','phase','port','providerID','providerRequestID','sinceLastByteMs']);
   assert.equal(failed[0].failure.phase,'stream');assert.equal(failed[0].failure.code,'Timeout');assert.equal(failed[0].failure.host,'chatgpt.com');assert.equal(failed[0].failure.port,443);
   assert.equal(failed[0].failure.providerID,'openai');assert.equal(failed[0].failure.modelID,'gpt-6.1-sol');assert.ok(failed[0].failure.sinceLastByteMs>=200);}
  if(FIXTURE.scenario==='plain-retry')assert.equal(bodyTimings.some(row=>row.event==='failed'),false,'A provider status error is not a transport failure');
  if(FIXTURE.scenario==='exhausted'){assert.equal(synthetics.length,2);assert.equal(steps.length,3);assert.equal(record.nativeStream.consumed,2);assert.equal(record.reason,'provider_stream_interrupted');assert.equal(streamTransitions.filter(row=>row.action==='reserve'&&row.answer===false).length,1);}
  if(FIXTURE.scenario==='plain-retry'){assert.equal(synthetics.length,0);assert.equal(record.nativeStream,undefined);assert.equal(streamTransitions.some(row=>row.action==='reserve'),false);}
  if(FIXTURE.scenario==='missing-attempt'){assert.equal(primaryRequests,2,'Lost post-output attempt must veto the third physical send');assert.equal(synthetics.length,1);assert.equal(steps.length,2);assert.equal(record.nativeStream.consumed,1);assert.equal(streamTransitions.filter(row=>row.action==='reserve').length,1);}
  if(FIXTURE.scenario==='stop-publication'){assert.equal(record.nativeStream.consumed,0);assert.equal(record.nativeStream.pending,undefined);assert.equal(streamTransitions.some(row=>row.action==='prepare'&&row.record?.nativeStream?.consumed),false);}
  if(FIXTURE.scenario.startsWith('late-')){assert.equal(synthetics.length,0);assert.equal(record.nativeStream,undefined);assert.equal(streamTransitions.some(row=>row.action==='reserve'),false);
   assert.equal(published.some(row=>['session.text.started','session.reasoning.started','session.tool.input.started'].includes(row.type)),false);
   assert.deepEqual(outputFlags,[{outputStarted:false,attemptOutputStarted:false}]);}
  if(Boolean(FIXTURE.setter)){assert.ok(published.some(row=>row.type===(FIXTURE.setter==='text-start'?'session.text.started':FIXTURE.setter==='reasoning-start'?'session.reasoning.started':'session.tool.input.started')),'Canonical empty/implicit output start witness must be committed');
   if(['text-start','reasoning-start'].includes(FIXTURE.setter??'')){assert.equal(record.nativeStream.consumed,2);assert.equal(record.reason,'provider_stream_interrupted');assert.equal(synthetics.length,2);}
   else {assert.equal(record.nativeStream,undefined);assert.equal(synthetics.length,0);assert.equal(streamRefusals.filter(row=>row.action==='reserve').length,1);}
  }
  assert.ok(bodyTimings.some(row=>row.event==='headers'));assert.ok(bodyTimings.some(row=>row.event==='first-byte'));assert.ok(bodyTimings.some(row=>row.event==='body-end'&&row.body.bytes>0));
  result={scenario:FIXTURE.scenario,primaryRequests,synthetics:synthetics.length,steps:steps.length,consumed:record.nativeStream?.consumed??0};
`+source.slice(end);
  replace('  await cleanup(() => runtime.drain());','  await cleanup(() => primaryRuntime?.drain());await cleanup(() => runtime.drain());');
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(path.resolve(path.dirname(sourcePath),relative)));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify('file://'+path.resolve(path.dirname(sourcePath),relative))+')');
  const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,source);return entry;
};
// One combined transformation; the inserted code branches on the scenario read at runtime, and is
// inert for the continue/exhausted/plain-retry/stop-publication/denied-tool scenarios.
const rawSetterPlugin:Bun.BunPlugin={name:'fixture-model-qualification',setup(builder){
 builder.onLoad({filter:/native-stream-continuation\.ts$/},async event=>{
  const contents=await fs.readFile(event.path,'utf8'),before='return inner.stream(request,streamOptions).pipe(',retry='if(!event.decision.retry)return;',
   finalizer='Stream.ensuring(Effect.sync(()=>{if(identity)attempts.delete(key(identity));}))',registry='const requests=new WeakMap';
  for(const [seam,message] of [[before,'Constructor raw model delivery seam changed'],[retry,'Constructor retry observation seam changed'],[finalizer,'Constructor stream finalization seam changed'],[registry,'Constructor request registry seam changed']] as const)
   if(contents.split(seam).length!==2)throw Error(message);
  const header=`const __F=process.env.DEVRYAN_STREAM_FIXTURE?JSON.parse(process.env.DEVRYAN_STREAM_FIXTURE):{};
const __lateEvents=[__F.scenario==='late-provider-error'?{type:'provider-error',message:'Fixture provider refusal'}:{type:'step-finish',index:0,reason:{normalized:'content-filter'}},{type:'text-start',id:'late-text'},{type:'reasoning-start',id:'late-reasoning'},{type:'tool-input-start',id:'late-input',name:'read'},
 {type:'tool-input-error',id:'late-error',name:'read',raw:'{'},{type:'tool-call',id:'late-call',name:'read',input:{path:'/fixture/no-file'},providerExecuted:true}];
const __rawSetter=__F.setter==='text-start'?{type:'text-start',id:'empty-start'}:__F.setter==='reasoning-start'?{type:'reasoning-start',id:'empty-start'}:__F.setter==='tool-input-error'?{type:'tool-input-error',id:'fixture-call',name:'read',raw:'{'}:__F.setter==='tool-call'?{type:'tool-call',id:'fixture-call',name:'read',input:{path:'/fixture/no-file'},providerExecuted:true}:{type:'tool-input-start',id:'fixture-call',name:'read'};
`;
  // Empty starts and implicit tool starts are delivered at the model fixture seam.
  // The pinned native publisher, Step, retry and Bus services are unmodified.
  const delivery=`return (stream=>__F.scenario==='silence'?stream.pipe(Stream.tapError(error=>Effect.promise(()=>options.rpc('fixture.transport-error',{reason:error.reason})))):__F.scenario?.startsWith('late-')?stream.pipe(Stream.flatMap(event=>event.type==='text-start'?Stream.fromIterable(__lateEvents):['text-delta','text-end'].includes(event.type)?Stream.empty:Stream.succeed(event))):__F.setter?stream.pipe(Stream.flatMap(event=>event.type==='text-start'?Stream.succeed(__rawSetter):['text-delta','text-end'].includes(event.type)?Stream.empty:Stream.succeed(event))):stream)(inner.stream(request,streamOptions)).pipe(`;
  const retryObservation=`if(__F.scenario==='missing-attempt'&&event.decision.retry&&scope.outputStarted&&++qualificationRetries===2)scope.attempt=undefined;
   if(__F.scenario==='silence')yield* Effect.promise(()=>options.rpc('fixture.native-retry',{retry:event.decision.retry,outputStarted:scope.attempt?.outputStarted===true}));
   `+retry;
  const lateFinalizer=`(__F.scenario?.startsWith('late-')?Stream.ensuring(Effect.promise(()=>options.rpc('fixture.output-flags',{outputStarted:scope?.outputStarted===true,attemptOutputStarted:scope?.attempt?.outputStarted===true}))):(stream=>stream)),`+finalizer;
  return {contents:header+contents.replace(registry,()=>'let qualificationRetries=0;\n '+registry).replace(before,()=>delivery).replace(retry,()=>retryObservation).replace(finalizer,()=>lateFinalizer),loader:'ts'};
 });
}};
const sharedBundle=()=>bundlePromise??=(async()=>{
 const root=await sharedBuildRoot(),entry=await fixtureSource(root);
 const built=await Bun.build({entrypoints:[entry],target:'bun',outdir:root,naming:{entry:'stream.mjs',asset:'[name]-[hash].[ext]'},plugins:[rawSetterPlugin,...await reviewedBuildPlugins()]});
 if(!built.success)throw new AggregateError(built.logs,'Pinned stream continuation graph build failed');await writeNativeFixtureOutputs(built.outputs);
 return path.join(root,'stream.mjs');
})();
const sharedExecutable=()=>executablePromise??=(async()=>{
 await sharedBundle();const root=await sharedBuildRoot(),entry=path.join(root,'fixture.mjs');
 const disk=Bun.spawn(['df','-h',repository],{stdout:'pipe',stderr:'pipe'});if(await disk.exited!==0)throw Error('Disk check unavailable');
 const executable=path.join(root,'DevRyan-native-stream-fixture');
 const compiledBuild=await Bun.build({entrypoints:[entry],target:'bun',compile:{target:'bun-darwin-arm64',outfile:executable,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false},
  plugins:[rawSetterPlugin,...await reviewedBuildPlugins()]});
 if(!compiledBuild.success)throw new AggregateError(compiledBuild.logs,'Compiled native fixture failed');await fs.chmod(executable,0o755);return executable;
})();
afterAll(async()=>{if(buildRootPromise)await buildRootPromise.catch(()=>undefined);if(buildRoot)await fs.rm(buildRoot,{recursive:true,force:true});});
for(const {scenario,slim,compiled,setter} of cases.filter((_, index) => testCaseShard(index, process.env.DEVRYAN_STREAM_TEST_SHARD)))test('pinned 2.1.4 native stream graph '+scenario+' Slim='+slim+' compiled='+compiled,async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/native-stream-'));let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const fixture:FixtureConfig={scenario,slim,...(setter?{setter}:{})};
  const command=compiled?[await sharedExecutable()]:[process.execPath,await sharedBundle()];
  const home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
  child=Bun.spawn(command,{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root,DEVRYAN_STREAM_FIXTURE:JSON.stringify(fixture)},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code!==0){const errors=await fs.readFile(path.join(root,'rpc-errors.jsonl'),'utf8').catch(()=>'');const proof=await fs.readFile(path.join(root,'stream-proof.json'),'utf8').catch(()=>'');throw Error(JSON.stringify({code,stderr,errors,proof,root}));}
  expect(JSON.parse(stdout)).toMatchObject({scenario,primaryRequests:scenario.startsWith('late-')?1:setter?(['text-start','reasoning-start'].includes(setter)?3:1):['exhausted','denied-tool'].includes(scenario)?3:scenario==='stop-publication'?1:2});
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},300_000);
