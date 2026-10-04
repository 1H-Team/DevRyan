import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
const repository=path.resolve(import.meta.dirname,'../..');

for (const boundary of ['physical','handoff','missing-callback'] as const) test('real Stop preserves native interrupted cleanup at '+boundary+' boundary',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/native-stop-'));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const sourcePath=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');
  let source=await fs.readFile(sourcePath,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw Error('Original graph fixture changed: '+before);source=source.replace(before,after);};
  source="import {Fiber} from 'effect';\nimport {SessionEvent} from '@opencode/schema/session-event';\nimport {SessionMessage} from '@opencode/core/session/message';\nimport {Database as SqliteDatabase} from 'bun:sqlite';\n"+
    "import {createNativeObservation} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-observation.ts'))+";\n"+
    "import {createNativeObservationOwner} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-observation-owner.js'))+";\n"+
    "import {OperationPermitRef} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-admission-contract.ts'))+";\n"+
    "import {createPrimaryRecoveryHost} from "+JSON.stringify(path.join(repository,'packages/harness-runtime/lib/provider-recovery-host.js'))+";\n"+
    "import {createNativePrimaryStepOwner} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/primary-step-owner.js'))+";\n"+
    "import {primaryStepOverride} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/primary-step.ts'))+";\n"+source;
  replace('let nativeURL, ready = false, handler, map,',`let primaryRuntime,realPrimaryStep;let nativeStore,nativeExecution,runnerPermit,releaseResponse,primaryObserved,capturedBus;let physicalAborted=false;const primarySteps=[],published=[];const responseBarrier=new Promise(resolve=>releaseResponse=resolve),primaryStarted=new Promise(resolve=>primaryObserved=resolve),physicalKinds=[],primaryBodies=new Set();let nativeURL, ready = false, handler, map,`);
  replace('const options = { database:', "const options = { app:{name:'DevRyan interrupted cleanup graph',version:'2.0.20',channel:'fixture'},database:");
  replace('const configuration = { model:',`const configuration = { commands:{interview:{description:'Owned interview status fixture',template:'Owned status $ARGUMENTS'}}, model:`);
  replace('  withSessionLock: lock,',`  getReviewedConfiguration:directory=>snapshot.locations.find(row=>row.directory===directory)?.configuration,
  verifyQueuedPrimaryIdle:input=>gates.controls.queuedPrimaryIdleOwned(input),
  captureQueuedPrimaryAdmission:sessionID=>primaryRuntime.captureNativePromptAdmission(sessionID),
  readQueuedPrimaryRecord:sessionID=>primaryRuntime.readRecord(sessionID),
  captureCommandPromptAdmission:async({sessionID,directory})=>{
   const original=callerContext.getStore();assert.equal(original,caller);
   const assertReceipt=receipt=>{assert.equal(receipt.sessionID,sessionID);assert.equal(receipt.directory,directory);assert.equal(original.active,true);};
   return {admit:(receipt,authorizeWrite)=>{assertReceipt(receipt);return primaryRuntime.admitNativePrompt(receipt,{sessionID,owner:null,authorizeWrite});},
    uncertain:receipt=>{assertReceipt(receipt);return primaryRuntime.markNativePromptUncertain(receipt);}};
  },
  readUserMessage:async input=>{const value=await Effect.runPromise(nativeStore.message(SessionMessage.ID.make(input.messageID)));return value&&{...value.message,sessionID:value.sessionID,directory:input.directory};},
  withSessionLock: lock,`);
  replace("if (method === 'native.admission.authorize') ownedTokens.add(result.token);",`if (method === 'native.admission.authorize') {ownedTokens.add(result.token);if(input.operation==='runner.drain')runnerPermit=result;}`);
  replace('const rpc = async (method, input, context) => {',`let observationOwner,observationClient,adapterMode='normal',handoffObserved,rejectHandoff;const diagnosticObservations=[];
const rpc = async (method, input, context) => {
  // Match the real private HTTP JSON boundary, including omitted optional properties.
  input=input===undefined?undefined:JSON.parse(JSON.stringify(input));
  if(method==='native.observation')return observationOwner.handleRpc(method,input);
  if(method==='native.primary-step'){if(adapterMode.startsWith('stop-')){const stop={sessionID:input.event.data.sessionID,assistantMessageID:input.event.data.assistantMessageID};if(adapterMode==='stop-wrong')stop.assistantMessageID='msg_foreign';if(adapterMode==='stop-array')return Object.assign([],{tracked:false,stop});return {tracked:false,stop,...(adapterMode==='stop-extra'?{foreign:true}:{})};}if(adapterMode==='unavailable')throw Error('fixture_handoff_unavailable');if(adapterMode==='provider-only'){const abort=new AbortController();abort.abort();throw abort.signal.reason;}if(adapterMode==='race'){handoffObserved();return await new Promise((_,reject)=>{rejectHandoff=()=>reject(Error('fixture_handoff_refused'));});}assert.ok(ownedTokens.has(input.permit.token));primarySteps.push(input.event);try{return await realPrimaryStep(input);}catch(error){await fs.appendFile(path.join(root,'rpc-errors.jsonl'),JSON.stringify({method,code:['provider_recovery_fenced','native_primary_step_invalid','native_permit_revoked'].includes(error?.code)?error.code:'inner_code_unavailable'})+'\\n');throw error;}}`);
  replace('actual.trigger(domain,name,event).pipe(Effect.tap(',`Effect.gen(function*(){if(${JSON.stringify(boundary)}==='context'&&domain==='session'&&name==='context'){primaryObserved();yield*Effect.promise(()=>responseBarrier);}return yield*actual.trigger(domain,name,event).pipe(Effect.tap(result=>Effect.sync(()=>{
   if(domain==='session'&&name==='http.request')physicalKinds.push(result.kind);
  })),Effect.tap(result=>domain==='session'&&name==='http.request'&&result.kind==='primary'?Effect.promise(async()=>{primaryBodies.add(createHash('sha256').update(await result.request.clone().text()).digest('hex'));}):Effect.void));}).pipe(Effect.tap(`);
  replace('...factory.overrides,...compatibility.overrides,',`...factory.overrides,...compatibility.overrides,...observation.overrides,primaryStepOverride(rpc,inner=>Effect.sync(()=>{capturedBus=inner;return inner;}),(event,disposition)=>Effect.sync(()=>published.push(event)).pipe(Effect.andThen(observation.observePublished(event,disposition))),undefined,undefined,undefined,undefined,events=>gates.controls.prepareQueuedPublication(events),event=>gates.controls.assertQueuedPublication(event),${JSON.stringify(boundary)}==='missing-callback'?undefined:sessionID=>gates.controls.interruptStoppedHandoff(sessionID)),`);
  replace('const gates = createAdmissionGates({',`observationOwner=createNativeObservationOwner({instanceID:controller.instanceID,snapshot,controller:()=>controller,isReady:()=>ready,admissionOwner,openCodeClient:{sessions:{message:(...args)=>observationClient.sessions.message(...args)}},recordDiagnostic:entry=>diagnosticObservations.push(entry)});const observation=createNativeObservation({controllerInstanceID:controller.instanceID,configurationDigest:snapshot.digest,rpc});
const gates = createAdmissionGates({executionActivity:inner=>{nativeExecution=inner;return inner;},captureSessionStore:inner=>{nativeStore=inner;return Effect.succeed(inner);},`);
  replace('  const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });','  const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });observationClient=client;');
  replace('    return nativeFetch(new Request(loopback + url.pathname + url.search, request));',`    if(url.pathname.endsWith('/responses')&&primaryBodies.has(createHash('sha256').update(await request.clone().text()).digest('hex')))request.signal.addEventListener('abort',()=>{physicalAborted=true;},{once:true});
    return nativeFetch(new Request(loopback + url.pathname + url.search, request));`);
  replace('      const output = JSON.stringify(body)',`      if(${JSON.stringify(boundary)}==='physical'&&primaryBodies.has(createHash('sha256').update(text).digest('hex'))){response.once('close',()=>{if(!response.writableEnded)physicalAborted=true;});primaryObserved();await responseBarrier;}
      const output = JSON.stringify(body)`);
  const begin=source.indexOf('  const session = await callerContext.run(caller, () => client.sessions.create(');
  const end=source.indexOf('} catch (error) { primaryFailure = error;');
  if(begin<0||end<begin)throw Error('Original graph main changed');
  source=source.slice(0,begin)+`
  const directory=directories[0];
  primaryRuntime=createPrimaryRecoveryHost({dataDirectory:path.join(root,'primary-recovery'),openCodeClient:client,mode:'observe',isManaged:()=>true,managedBarrier:async()=>({state:'clear'}),authorize:async()=>caller.active,
    recordIncident:row=>{if(${JSON.stringify(boundary)}!=='physical'&&row.event==='provider_recovery_control'&&row.action==='stop')releaseResponse();}});
  if(${JSON.stringify(boundary)}!=='physical'){
    const originalPlugin=primaryRuntime.plugin;
    primaryRuntime.plugin=async input=>{if(input.action==='step'){primaryObserved();await responseBarrier;}return originalPlugin(input);};
  }
  await primaryRuntime.initialize();realPrimaryStep=createNativePrimaryStepOwner({admissionOwner,openCodeClient:client,primaryRuntime,instanceID:'owned_controller',allowStopHandoff:true});
  const session=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'openai',modelID:'gpt-5.5'}},{directory}));
  await callerContext.run(caller,()=>client.prompts.command(session.id,{command:'interview',arguments:'Bound original command',agent:'build',model:{providerID:'openai',modelID:'gpt-5.5'}},{directory}));
  let timer;try{await Promise.race([primaryStarted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual primary did not start')),15_000);})]);}finally{clearTimeout(timer);}
  const rawUser=(await Effect.runPromise(nativeStore.messages({sessionID:session.id}))).find(row=>row.type==='user');assert.ok(rawUser);
  assert.equal((await primaryRuntime.readRecord(session.id)).anchorID,rawUser.id,'Original queued command commit must admit its exact primary');
  try{
    if(${JSON.stringify(boundary)}!=='physical'){
      const stopReply=await callerContext.run(caller,()=>primaryRuntime.handleRequest('POST','/session/'+session.id+'/abort',{}));
      assert.deepEqual(stopReply,{status:200,body:true});await Effect.runPromise(nativeExecution.awaitIdle(session.id));
    }else await gates.controls.holdAndStop(session.id);
    assert.equal(await Effect.runPromise(nativeExecution.isActive(session.id)),false);if(${JSON.stringify(boundary)}==='physical'){const abortDeadline=Date.now()+2000;while(!physicalAborted&&Date.now()<abortDeadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(physicalAborted,true,'Stop must close the actual held HTTP transport');}
    const evidence=new SqliteDatabase(options.database.path,{readonly:true});let idle,assistant,claim;try{claim=evidence.query('SELECT time_suspended FROM session_v2 WHERE id=?').get(session.id)?.time_suspended;idle=evidence.query('SELECT idle_outcome FROM session_v2 WHERE id=?').get(session.id)?.idle_outcome;assistant=JSON.parse(evidence.query("SELECT data FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1").get(session.id).data);}finally{evidence.close();}
    const records=await client.sessions.messages(session.id,{}, {directory});
    await fs.writeFile(path.join(root,'stop-result.json'),JSON.stringify({idle,physicalRequests:physicalKinds.filter(kind=>kind==='primary').length,primaryHandoffs:primarySteps.length,assistant:[{completed:Number.isFinite(assistant.time.completed),error:assistant.error?.type??null}],events:published.map(event=>event.type)}));
    if(${JSON.stringify(boundary)}==='missing-callback'){
      assert.equal(idle,'failed');assert.equal(assistant.time.completed,undefined);assert.equal(assistant.error,undefined);
      result={missingCallbackRefused:true};
    }else{
    assert.equal(claim,null,'User Stop must release the original native claim');
    assert.equal(idle,'interrupted','Stop must retain the original native interrupted idle outcome');
    assert.equal(assistant.error?.type,'aborted');assert.ok(Number.isFinite(assistant.time.completed),'Stop must commit the original aborted/completed assistant');assert.ok(records.records.some(row=>row.info.role==='assistant'&&row.info.time.completed));
    assert.equal(physicalKinds.filter(kind=>kind==='primary').length,1);
    assert.equal(primarySteps.length,${JSON.stringify(boundary)}!=='physical'?1:0,'One committed pending handoff, or no handoff after physical interruption');
    const observed=diagnosticObservations.filter(row=>row.event==='native_observation').map(row=>row.payload).filter(row=>row.sessionID===session.id);
    const physical=observed.filter(row=>row.stage==='physical'&&row.kind==='primary');assert.equal(physical.length,1);assert.ok(physical[0].attempt);
    assert.ok(observed.some(row=>row.stage==='model-prepared'&&row.requestID===physical[0].requestID));
    assert.equal(observed.some(row=>row.stage==='step-link'),false,'Cancelled physical request must remain unmatched');
    assert.equal(diagnosticObservations.some(row=>row.event==='native_observation_gap'),false);
    const actualStarted=${JSON.stringify(boundary)}!=='physical'?primarySteps[0]:published.find(event=>event.type==='session.step.started'&&event.data.sessionID===session.id);assert.ok(actualStarted);
    // Adapter probes use separate canonical sessions and the original Bus. They
    // publish no provider requests and must not be confused with Stop evidence.
    for(const mode of ['held','unavailable','provider-only','missing-permit','self-interrupt','stop-wrong','stop-array','stop-extra']){
      const probe=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'openai',modelID:'gpt-5.5'}},{directory}));
      const data={...actualStarted.data,sessionID:probe.id,assistantMessageID:SessionMessage.ID.make('msg_'+crypto.randomUUID().replaceAll('-',''))};
      if(mode==='held')await bridge.hold(probe.id);
      adapterMode=mode==='held'?'normal':mode==='self-interrupt'?'unavailable':mode;
      const action=capturedBus.publish(SessionEvent.Step.Started,data).pipe(Effect.provideService(OperationPermitRef,mode==='missing-permit'?undefined:runnerPermit));
      const outcome=await Effect.runPromise(Effect.exit(Effect.uninterruptible(mode==='self-interrupt'?Effect.gen(function*(){yield* Effect.exit(Effect.interrupt);return yield*action;}):action)));
      assert.equal(Exit.isFailure(outcome),true,mode+' must remain refused without delivered fiber interruption');assert.ok(outcome.cause.reasons.some(reason=>(reason.defect??reason.error)?.code===(mode==='missing-permit'?'native_primary_permit_required':'native_primary_step_unavailable')));
    }
    const probe=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'openai',modelID:'gpt-5.5'}},{directory}));
    const data={...actualStarted.data,sessionID:probe.id,assistantMessageID:SessionMessage.ID.make('msg_'+crypto.randomUUID().replaceAll('-',''))};
    const entered=new Promise(resolve=>handoffObserved=resolve);adapterMode='race';
    const fiber=Effect.runFork(Effect.uninterruptible(capturedBus.publish(SessionEvent.Step.Started,data).pipe(Effect.provideService(OperationPermitRef,runnerPermit))));
    await entered;const interrupted=Effect.runPromise(Fiber.interrupt(fiber));rejectHandoff();
    await interrupted;const interruptedExit=await Effect.runPromise(Fiber.await(fiber));assert.equal(Exit.hasInterrupts(interruptedExit),true);
    assert.ok(published.some(event=>event.type==='session.step.started'&&event.data.sessionID===probe.id),'Interrupted rejected handoff must retain original publication');
    assert.equal(diagnosticObservations.some(row=>row.event==='native_observation_gap'),false);
    await fs.writeFile(path.join(root,'stop-result.json'),JSON.stringify({idle,physicalAborted,pendingHandoff:${JSON.stringify(boundary)}!=='physical',primaryPhysicalRequests:1,totalPhysicalRequests:observed.filter(row=>row.stage==='physical').length,primaryHandoffs:primarySteps.length,assistant:{completed:true,error:assistant.error.type},events:published.filter(event=>event.data?.sessionID===session.id).map(event=>event.type),observations:observed.map(row=>({stage:row.stage,kind:row.kind,requestID:row.requestID,attempt:row.attempt})),unmatchedCancelledRequests:physical.map(row=>row.requestID),observationGaps:0,noninterruptedRefusals:8,interruptedHandoffRace:true}));result={interrupted:true,abortedAssistant:true,primaryPhysicalRequests:1};
    }
  }finally{releaseResponse();}
`+source.slice(end);
  replace('  await cleanup(() => runtime.drain());', '  await cleanup(() => primaryRuntime?.drain());await cleanup(() => runtime.drain());');
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(path.resolve(path.dirname(sourcePath),relative)));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify('file://'+path.resolve(path.dirname(sourcePath),relative))+')');
  const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,source);
  const built=await Bun.build({entrypoints:[entry],target:'bun',outdir:root,naming:{entry:'interrupted.mjs',asset:'[name]-[hash].[ext]'},plugins:[await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
  if(!built.success)throw new AggregateError(built.logs,'Actual interrupted cleanup graph build failed');await writeNativeFixtureOutputs(built.outputs);
  const home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
  child=Bun.spawn([process.execPath,path.join(root,'interrupted.mjs')],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  await fs.writeFile(path.join(repository,'.cache/v2-validation/resume-native-stop-'+boundary+'-child.log'),stderr);
  {for(const name of ['rpc-errors.jsonl','reported-causes.jsonl','native-causes.jsonl','hooks.jsonl','stop-result.json']){const bytes=await fs.readFile(path.join(root,name)).catch(()=>Buffer.alloc(0));await fs.writeFile(path.join(repository,'.cache/v2-validation/resume-native-stop-'+boundary+'-'+name),bytes);}}
  expect({code,stderr}).toEqual({code:0,stderr:''});expect(JSON.parse(stdout)).toEqual(boundary==='missing-callback'?{missingCallbackRefused:true}:{interrupted:true,abortedAssistant:true,primaryPhysicalRequests:1});
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},120_000);
