import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
const reportUnit='Retained owned result 🙂 "\\\n';
// 60 KiB keeps three report pages after the 24 KiB v2 page inlined in the wait result.
const REPORT_BYTES=60*1024;
const reportUnits=Math.floor(REPORT_BYTES/Buffer.byteLength(reportUnit));
const retainedReport=reportUnit.repeat(reportUnits)+'x'.repeat(REPORT_BYTES-reportUnits*Buffer.byteLength(reportUnit));
// The shipped native host is the compiled executable; the bundled-source run proved
// nothing the compiled run does not, so only the compiled program runs.
for(const compiled of [true])test('pinned native v2 result publication and later Step compiled='+compiled,async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/native-result-publication-'));let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const sourcePath=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');let source=await fs.readFile(sourcePath,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw Error('Native fixture changed: '+before);source=source.replace(before,after);};
  const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
  source=`import {createNativeObservation} from ${JSON.stringify(path.join(host,'native-observation.ts'))};
import {createPrimaryRecoveryHost} from ${JSON.stringify(path.join(repository,'packages/harness-runtime/lib/provider-recovery-host.js'))};
import {createNativePrimaryStepOwner} from ${JSON.stringify(path.join(host,'primary-step-owner.js'))};
import {primaryStepOverride} from ${JSON.stringify(path.join(host,'primary-step.ts'))};
import {managedTaskPlugin,withManagedTaskExecution} from ${JSON.stringify(path.join(host,'managed-task.ts'))};
import {createNativeManagedTaskOwner} from ${JSON.stringify(path.join(host,'managed-task-owner.js'))};
import {createNativeManagedPublicationReader,readManagedPublicationMessages} from ${JSON.stringify(path.join(host,'native-managed-publication-owner.js'))};
import {createWebManagedOrchestrationRuntime} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/orchestration/runtime.js'))};
import {createManagedTaskRecord,createManagedTaskResultEnvelope} from ${JSON.stringify(path.join(repository,'packages/orchestration-runtime/index.js'))};
import {SessionMessage} from '@opencode/core/session/message';
`+source;
  replace('let initialPairReleased=false;','let initialPairReleased=true;');
  replace('let nativeURL, ready = false, handler, map,',`let primaryRuntime,realPrimaryStep,managedRuntime,managedOwner,nativeStore,nativeExecution,taskID,primaryRequests=0,continuationRequested=false,finalResponseSent=false;const published=[],managedCalls=[];let nativeURL, ready = false, handler, map,`);
  replace('const options = { database:',"const options = {app:{name:'DevRyan result publication fixture',version:'2.1.4',channel:'fixture'},database:");
  replace('const configuration = { model:',`const configuration = {commands:{interview:{description:'Owned result fixture',template:'Review owned results $ARGUMENTS'}},model:`);
  replace('  withSessionLock: lock,',`  getReviewedConfiguration:directory=>snapshot.locations.find(row=>row.directory===directory)?.configuration,
  verifyQueuedPrimaryIdle:input=>gates.controls.queuedPrimaryIdleOwned(input),captureQueuedPrimaryAdmission:sessionID=>primaryRuntime.captureNativePromptAdmission(sessionID),readQueuedPrimaryRecord:sessionID=>primaryRuntime.readRecord(sessionID),
  captureCommandPromptAdmission:async({sessionID,directory})=>{const original=callerContext.getStore();assert.equal(original,caller);return {
   admit:(receipt,authorizeWrite)=>primaryRuntime.admitNativePrompt(receipt,{sessionID,owner:null,authorizeWrite}),uncertain:receipt=>primaryRuntime.markNativePromptUncertain(receipt)};},
  readUserMessage:async input=>{const value=await Effect.runPromise(nativeStore.message(SessionMessage.ID.make(input.messageID)));return value&&{...value.message,sessionID:value.sessionID,directory:input.directory};},
  withSessionLock: lock,`);
  replace('const rpc = async (method, input, context) => {',`const rpc = async (method, input, context) => {
  input=input===undefined?undefined:JSON.parse(JSON.stringify(input));
  if(method==='native.observation'||method==='native.provider-timing')return null;
  if(method==='native.primary-step')return realPrimaryStep(input);
  if(method==='native.managed-task'){let answer,error;try{answer=await managedOwner(input,context);return answer;}catch(failure){error=failure;throw failure;}finally{managedCalls.push({input,answer,code:error?.code});}}
`);
  replace('const gates = createAdmissionGates({',`const managedOrigin={kind:'plugin',id:'devryan.managed-task',manifestDigest:'e'.repeat(64),capabilities:['managed-task']};
const observation=createNativeObservation({controllerInstanceID:controller.instanceID,configurationDigest:snapshot.digest,rpc});
const executeManaged=withManagedTaskExecution({origin:managedOrigin,directory:directories[0],rpc,executeOwned:factory.executeOwned});
const gates = createAdmissionGates({executionActivity:inner=>{nativeExecution=inner;return inner;},captureSessionStore:inner=>{nativeStore=inner;return Effect.succeed(inner);},`);
  replace("  executeOwned: () => Effect.die(new Error('Unexpected executable tool')) });",'  executeOwned:executeManaged });');
  replace('plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin}]','plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin},{plugin:managedTaskPlugin,origin:managedOrigin}]');
  replace('...factory.overrides,...compatibility.overrides,',`...factory.overrides,...compatibility.overrides,...observation.overrides,primaryStepOverride(rpc,undefined,(event,disposition)=>Effect.sync(()=>published.push(event)).pipe(Effect.andThen(observation.observePublished(event,disposition))),undefined,undefined,undefined,undefined,events=>gates.controls.prepareQueuedPublication(events),event=>gates.controls.assertQueuedPublication(event),sessionID=>gates.controls.interruptStoppedHandoff(sessionID)),`);
  replace("      if(kind==='title'){initialPairReleased=true;releaseInitialPair();}",`      if(kind==='title'){initialPairReleased=true;releaseInitialPair();}
      if(kind==='primary'){
       primaryRequests++;
       let args;
       if(primaryRequests===1)args=[{action:'wait',task_id:taskID},{action:'continue',task_id:taskID}];
       if(primaryRequests>1&&!continuationRequested){const outputs=body.input.filter(item=>item.type==='function_call_output').map(item=>{try{return JSON.parse(item.output);}catch{return null;}});
        const page=outputs.findLast(output=>output?.resultReference);assert.ok(page,'Canonical report output must reach the next real model Step');
        if(page.resultReference.nextCursor)args=[{action:'read_result',task_id:taskID,result_cursor:page.resultReference.nextCursor}];
        else{continuationRequested=true;args=[{action:'continue',task_id:taskID}];}}
       else if(primaryRequests>1)finalResponseSent=true;
       if(args){
        const calls=args.map((input,index)=>({id:'item_'+primaryRequests+'_'+index,type:'function_call',call_id:'call_'+primaryRequests+'_'+index,name:'devryan_task',arguments:JSON.stringify(input),status:'completed'}));
        const result={id:'response_'+receiptNumber,object:'response',created_at:Math.floor(Date.now()/1000),model:'gpt-6.1-sol',status:'completed',output:calls,usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
        const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},...calls.flatMap((item,output_index)=>[
         {type:'response.output_item.added',output_index,item:{...item,arguments:'',status:'in_progress'}},
         {type:'response.function_call_arguments.delta',output_index,item_id:item.id,delta:item.arguments},
         {type:'response.function_call_arguments.done',output_index,item_id:item.id,arguments:item.arguments},
         {type:'response.output_item.done',output_index,item}]),{type:'response.completed',response:result}];
        response.writeHead(200,{'content-type':'text/event-stream'});response.end(events.map(event=>'data: '+JSON.stringify(event)+'\\n\\n').join(''));return;
       }
      }`);
  const begin=source.indexOf('  const session = await callerContext.run(caller, () => client.sessions.create('),end=source.indexOf('} catch (error) { primaryFailure = error;');if(begin<0||end<begin)throw Error('Native graph main changed');
  source=source.slice(0,begin)+`
  const directory=directories[0];primaryRuntime=createPrimaryRecoveryHost({dataDirectory:path.join(root,'primary'),openCodeClient:client,mode:'observe',progressTimeoutMs:false,isManaged:()=>true,managedBarrier:async()=>({state:'clear'}),authorize:async()=>caller.active});
  await primaryRuntime.initialize();realPrimaryStep=createNativePrimaryStepOwner({admissionOwner,openCodeClient:client,primaryRuntime,instanceID:controller.instanceID});
  const session=await callerContext.run(caller,()=>client.sessions.create({title:'Result publication fixture',model:{providerID:'openai',modelID:'gpt-6.1-sol'}},{directory}));
  taskID='dvr_task_native_result';const task={...createManagedTaskRecord({taskId:taskID,idempotencyKey:'fixture',rootSessionId:session.id,parentTaskId:null,childSessionId:'ses_fixture_child',directory,sequence:1,
   mode:'orchestrator',providerId:'openai',modelId:'gpt-6.1-sol',agent:'explorer',variant:'default',label:'Owned result',prompt:'Fixture task',attempt:1,priorTaskId:null,executionKind:'start',createdAt:1,timeoutAt:null}),
   status:'completed',startedAt:2,finishedAt:3,partial:false,failureReason:null,recoverablePreview:${JSON.stringify(retainedReport)},canonicalRefs:[]};
  let ledger={version:1,tasks:[task],resultEnvelopes:[createManagedTaskResultEnvelope(task,{sequence:2,createdAt:4,resumable:false})]};
  managedRuntime=createWebManagedOrchestrationRuntime({persistence:{load:async()=>structuredClone(ledger),save:async value=>{ledger=structuredClone(value);}},
   executor:{start:async()=>{throw Error('No child replay');}},now:()=>100,harnessPolicies:{compactResults:false}});await managedRuntime.initialize();
  const readMessages=(input,messageIDs=[])=>readManagedPublicationMessages((scope,page)=>client.sessions.messages(scope.sessionID,page,{directory:scope.directory}),input,messageIDs);
  const readResultPublication=createNativeManagedPublicationReader({readConfiguration:()=>({controllerInstanceID:controller.instanceID,configurationDigest:snapshot.digest}),
   recheckExecution:input=>admissionOwner.recheckExecution(input),readPrimaryRecord:sessionID=>primaryRuntime.readRecord(sessionID),readMessages});
  // The fixture lends an explicit local root grant. Production account/role
  // authorization is covered by the composing task-context contract tests.
  managedOwner=createNativeManagedTaskOwner({admissionOwner,taskContext:{authorizeNativeTaskInvocation:async input=>{assert.equal(input.sessionID,session.id);assert.equal(input.directory,directory);assert.equal(caller.active,true);return {readOnly:false};}},getManagedRuntime:()=>managedRuntime,readResultPublication});
  await callerContext.run(caller,()=>client.prompts.command(session.id,{command:'interview',arguments:'publication proof',agent:'build',model:{providerID:'openai',modelID:'gpt-6.1-sol'}},{directory}));
  const deadline=Date.now()+30000;while(Date.now()<deadline){if(finalResponseSent&&!await Effect.runPromise(nativeExecution.isActive(session.id)))break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(finalResponseSent,true);assert.equal(await Effect.runPromise(nativeExecution.isActive(session.id)),false);assert.ok(primaryRequests>=5);
  const finalPage=await client.sessions.messages(session.id,{limit:200},{directory});assert.equal(finalPage.cursor,undefined);const messages=finalPage.records;
  assert.equal(ledger.resultEnvelopes[0].action,'continue');assert.equal(typeof ledger.resultEnvelopes[0].acknowledgementIdentity,'string');
  const first=managedCalls.find(row=>row.input.input.action==='continue'),last=managedCalls.findLast(row=>row.input.input.action==='continue');
  assert.ok(first.code&&['native_task_result_not_published','native_task_later_review_step_required'].includes(first.code),'Same-Step disposition must fail closed');
  assert.equal(last.code,undefined);assert.equal(last.answer.committed,true);assert.equal(last.answer.action,'continue');assert.equal(last.answer.taskId,taskID);
  const delivered=messages.filter(row=>row.parts.some(part=>part.type==='tool'&&part.tool==='devryan_task'&&part.state.status==='completed'));
  assert.ok(delivered.length>=3);assert.ok(messages.indexOf(delivered.at(-1))>messages.indexOf(delivered[1]));
  const canonical=messages.flatMap(row=>row.parts.filter(part=>part.type==='tool'&&part.tool==='devryan_task'&&part.state.status==='completed'));
  // The real native tool-output policy supplies this receipt; the host returns content only.
  const outputs=canonical.map(part=>{assert.equal(part.state.metadata?.truncated,false);assert.ok(Buffer.byteLength(part.state.output)<=48*1024);return JSON.parse(part.state.output);});
  const pages=outputs.filter((output,index)=>['wait','read_result'].includes(canonical[index].state.input.action)&&output.resultReference).map(output=>output.resultReference);let returnedBytes=0;
  assert.ok(pages.length>=3);for(const page of pages){const bytes=Buffer.byteLength(page.text);assert.ok(bytes<=24*1024);returnedBytes+=bytes;assert.equal(page.returnedBytes,returnedBytes);assert.equal(page.totalBytes,Buffer.byteLength(task.recoverablePreview));}
  assert.equal(pages.at(-1).nextCursor,null);assert.equal(pages.map(page=>page.text).join(''),task.recoverablePreview);
  const largestPageBytes=Math.max(...pages.map(page=>Buffer.byteLength(page.text)));assert.ok(largestPageBytes>8*1024);
  // v2 continue returns its committed receipt only; the ledger above proves the acknowledged envelope.
  assert.equal(outputs.at(-1).committed,true);assert.equal(outputs.at(-1).action,'continue');
  result={compiled:${compiled},sameStepCode:first.code,primaryRequests,publishedTools:delivered.length,acknowledged:true,reportBytes:returnedBytes,largestPageBytes,maxOutputBytes:Math.max(...canonical.map(part=>Buffer.byteLength(part.state.output))),nativeTruncationAbsent:true};
`+source.slice(end);
  replace('  await cleanup(() => runtime.drain());','  await cleanup(()=>managedRuntime?.shutdown());await cleanup(()=>primaryRuntime?.drain());await cleanup(() => runtime.drain());');
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(path.resolve(path.dirname(sourcePath),relative)));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify('file://'+path.resolve(path.dirname(sourcePath),relative))+')');
  const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,source);
  const plugins=[await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))];
  const build=await Bun.build({entrypoints:[entry],target:'bun',outdir:root,naming:{entry:'graph.mjs',asset:'[name]-[hash].[ext]'},plugins});if(!build.success)throw new AggregateError(build.logs);await writeNativeFixtureOutputs(build.outputs);
  const home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');let command=[process.execPath,path.join(root,'graph.mjs')];
  if(compiled){const disk=Bun.spawn(['df','-h',repository],{stdout:'pipe',stderr:'pipe'});if(await disk.exited!==0)throw Error('Disk check unavailable');
   const executable=path.join(root,'DevRyan-native-result-publication');const built=await Bun.build({entrypoints:[entry],target:'bun',compile:{target:'bun-darwin-arm64',outfile:executable,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false},plugins});
   if(!built.success)throw new AggregateError(built.logs);await fs.chmod(executable,0o755);command=[executable];}
  child=Bun.spawn(command,{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code!==0)throw Error(JSON.stringify({code,stderr,errors:await fs.readFile(path.join(root,'rpc-errors.jsonl'),'utf8').catch(()=>''),causes:await fs.readFile(path.join(root,'native-causes.jsonl'),'utf8').catch(()=>''),root}));
  const proof=JSON.parse(stdout);expect(proof).toMatchObject({compiled,acknowledged:true,reportBytes:REPORT_BYTES,nativeTruncationAbsent:true});expect(proof.largestPageBytes).toBeGreaterThan(8*1024);expect(proof.largestPageBytes).toBeLessThanOrEqual(24*1024);expect(proof.maxOutputBytes).toBeLessThanOrEqual(48*1024);
  console.log('Native managed result publication proof '+JSON.stringify(proof));
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},180000);
