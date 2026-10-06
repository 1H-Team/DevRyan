import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
const repository=path.resolve(import.meta.dirname,'../..');

for (const boundary of ['physical','context'] as const) test(`owned original status notice during ${boundary} is retained without a second request; private authority stays exact`,async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/native-notification-'));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const sourcePath=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');
  let source=await fs.readFile(sourcePath,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw Error('Original graph fixture changed: '+before);source=source.replace(before,after);};
  source="import {createControllerImages} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/controller-images.ts'))+";\nimport {toLLMMessages2} from "+JSON.stringify(path.join(repository,'packages/web/node_modules/@opencode/core/dist/chunks/credential-hd8vw2pw.js'))+";\nimport {createPrimaryRecoveryHost} from "+JSON.stringify(path.join(repository,'packages/harness-runtime/lib/provider-recovery-host.js'))+";\nimport {createNativePrimaryStepOwner} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/primary-step-owner.js'))+";\nimport {createPrivilegedOpenCodeClient} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/opencode-client/privileged.js'))+";\nimport {createNativeImageRuntime} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-image-runtime.js'))+";\nimport {SessionMessage} from '@opencode/core/session/message';\nimport {primaryStepOverride} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/primary-step.ts'))+";\n"+source;
  replace('let nativeURL, ready = false, handler, map,',`let primaryRuntime,realPrimaryStep;let nativeStore,nativeExecution,runnerPermit,foreignScope=false,revokeOnRead=false,releaseResponse,primaryObserved,capturedBus;const primarySteps=[],published=[];const responseBarrier=new Promise(resolve=>releaseResponse=resolve),primaryStarted=new Promise(resolve=>primaryObserved=resolve),physicalKinds=[],primaryBodies=new Set();let nativeURL, ready = false, handler, map,`);
  replace('const options = { database:', "const options = { app:{name:'DevRyan notification graph',version:'2.0.20',channel:'fixture'},database:");
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
  replace('return { ...session, directory: session.location.directory };','if(revokeOnRead){revokeOnRead=false;await Promise.resolve();caller.active=false;}return { ...session, directory: foreignScope?directories[1]:session.location.directory };');
  replace("if (method === 'native.admission.authorize') ownedTokens.add(result.token);",`if (method === 'native.admission.authorize') {ownedTokens.add(result.token);if(input.operation==='runner.drain')runnerPermit=result;}`);
  replace('const rpc = async (method, input, context) => {',`const rpc = async (method, input, context) => {
  // Match the real private HTTP JSON boundary, including omitted optional properties.
  input=input===undefined?undefined:JSON.parse(JSON.stringify(input));
  if(method==='native.primary-step'){assert.ok(ownedTokens.has(input.permit.token));primarySteps.push(input.event);try{return await realPrimaryStep(input);}catch(error){await fs.appendFile(path.join(root,'rpc-errors.jsonl'),JSON.stringify({method,code:error.code,name:error.name,message:error.message})+'\\n');throw error;}}`);
  replace('actual.trigger(domain,name,event).pipe(Effect.tap(',`Effect.gen(function*(){if(${JSON.stringify(boundary)}==='context'&&domain==='session'&&name==='context'){primaryObserved();yield*Effect.promise(()=>responseBarrier);}return yield*actual.trigger(domain,name,event).pipe(Effect.tap(result=>Effect.sync(()=>{
   if(domain==='session'&&name==='http.request')physicalKinds.push(result.kind);
  })),Effect.tap(result=>domain==='session'&&name==='http.request'&&result.kind==='primary'?Effect.promise(async()=>{primaryBodies.add(createHash('sha256').update(await result.request.clone().text()).digest('hex'));}):Effect.void));}).pipe(Effect.tap(`);
  replace('...factory.overrides,...compatibility.overrides,',`...factory.overrides,...compatibility.overrides,primaryStepOverride(rpc,inner=>Effect.sync(()=>{capturedBus=inner;return inner;}),event=>Effect.sync(()=>published.push(event)),undefined,undefined,undefined,undefined,events=>gates.controls.prepareQueuedPublication(events),event=>gates.controls.assertQueuedPublication(event)),`);
  replace('const gates = createAdmissionGates({','const gates = createAdmissionGates({executionActivity:inner=>{nativeExecution=inner;return inner;},captureSessionStore:inner=>{nativeStore=inner;return Effect.succeed(inner);},');
  replace('      const output = JSON.stringify(body)',`      if(${JSON.stringify(boundary)}==='physical'&&primaryBodies.has(createHash('sha256').update(text).digest('hex'))){primaryObserved();await responseBarrier;}
      const output = JSON.stringify(body)`);
  // The context cell deliberately holds primary before its physical request.
  // Start the original pair deadline only after that controlled hold is released.
  replace('const awaitInitialPhysicalPair = async kind => {',`const awaitInitialPhysicalPair = async kind => {
   if(${JSON.stringify(boundary)}==='context')await responseBarrier;`);
  const begin=source.indexOf('  const session = await callerContext.run(caller, () => client.sessions.create(');
  const end=source.indexOf('} catch (error) { primaryFailure = error;');
  if(begin<0||end<begin)throw Error('Original graph main changed');
  source=source.slice(0,begin)+`
  const directory=directories[0];
  primaryRuntime=createPrimaryRecoveryHost({dataDirectory:path.join(root,'primary-recovery'),openCodeClient:client,mode:'observe',isManaged:()=>true,managedBarrier:async()=>({state:'clear'}),authorize:async()=>caller.active});
  await primaryRuntime.initialize();realPrimaryStep=createNativePrimaryStepOwner({admissionOwner,openCodeClient:client,primaryRuntime,instanceID:'owned_controller'});
  const session=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'openai',modelID:'gpt-5.5'}},{directory}));
  await callerContext.run(caller,()=>client.prompts.command(session.id,{command:'interview',arguments:'Bound original command',agent:'build',model:{providerID:'openai',modelID:'gpt-5.5'}},{directory}));
  let primaryTimer;try{await Promise.race([primaryStarted,new Promise((_,reject)=>{primaryTimer=setTimeout(()=>reject(Error('Actual primary did not start')),15_000);})]);}finally{clearTimeout(primaryTimer);}
  assert.equal(physicalKinds.filter(kind=>kind==='primary').length,${boundary==='context'?0:1},'Held boundary must be before the first physical request in context case');
  const before=await client.sessions.messages(session.id,{}, {directory});
  const rawUser=(await Effect.runPromise(nativeStore.messages({sessionID:session.id}))).find(row=>row.type==='user'&&row.metadata?.devryan?.command?.name==='interview');assert.ok(rawUser,'Original command provenance missing');const user={info:{id:rawUser.id}};assert.ok(runnerPermit);assert.equal((await primaryRuntime.readRecord(session.id)).anchorID,rawUser.id,'Original queued command commit must admit its exact primary');
  const grant=await admissionOwner.captureInterviewAuthorization({directory,sessionID:session.id,messageID:user.info.id,permit:runnerPermit,name:'interview',arguments:'Bound original command'});
  const action={directory,sessionID:session.id,messageID:user.info.id,authorizationID:grant.authorizationID,kind:'notify',text:'Owned UI status; no response requested'};
  let savedPayload;
  await admissionOwner.withInterviewAction(action,async payload=>{savedPayload=payload;
   await assert.rejects(()=>gates.controls.interviewActionOwned({...payload,body:{...payload.body,text:'Changed private body'}}));
   await assert.rejects(()=>gates.controls.interviewActionOwned({...payload,permit:{...payload.permit,token:'0'.repeat(64)}}));
   await gates.controls.interviewActionOwned(payload);
  });
  await assert.rejects(()=>gates.controls.interviewActionOwned(savedPayload));
  const retained=await client.sessions.messages(session.id,{}, {directory});
  const notice=retained.records.find(row=>row.info.id===savedPayload.body.id);assert.ok(notice,'Original synthetic event not projected');
  assert.ok(notice.parts.some(part=>part.type==='text'&&part.text===action.text&&part.synthetic===true));
  assert.equal((await Effect.runPromise(nativeStore.messages({sessionID:session.id}))).filter(row=>row.type==='synthetic'&&row.id===savedPayload.body.id).length,1);
  const privileged=createPrivilegedOpenCodeClient(deps);
  const readUsers=async()=>{const records=[],cursors=new Set();let before,count=0,bytes=0;do{
   const page=await privileged.readCanonicalUserPage(session.id,{limit:200,...before?{before}:{}},{directory,maxResponseBytes:64*1024*1024});
   count+=page.scannedCount;bytes+=page.scannedBytes;assert.ok(count<=2000&&bytes<=64*1024*1024);records.unshift(...page.records);before=page.cursor;
   if(before){assert.equal(cursors.has(before),false);cursors.add(before);}
  }while(before);return records;};
  const readContext=async()=>{const records=[],cursors=new Set();let before,count=0,bytes=0,latestTurnParent;do{
   const page=await privileged.readCanonicalUserPage(session.id,{limit:200,...before?{before}:{}},{directory,maxResponseBytes:64*1024*1024});
   count+=page.scannedCount;bytes+=page.scannedBytes;assert.ok(count<=2000&&bytes<=64*1024*1024);records.unshift(...page.records);latestTurnParent??=page.latestTurnParent;before=page.cursor;
   if(before){assert.equal(cursors.has(before),false);cursors.add(before);}
  }while(before);return {records,latestTurnParent};};
  let enteredAssets=0;const images=createNativeImageRuntime({admissionOwner,locations:[{directory}],readContext,executionHost:{nativeContextAssets:async input=>{enteredAssets++;return {messages:(await readUsers()).filter(row=>input.messageIDs.includes(row.info.id)),imagesSkipped:false};}}});
  const imageInput=permit=>({requestID:crypto.randomUUID(),directory,sessionID:session.id,permit,phase:'context',messageIDs:[user.info.id]});
  const imageScope=input=>({requestID:input.requestID,directory,sessionID:session.id,permit:input.permit});
  if(${JSON.stringify(boundary)}==='context'){
   const canonical=await readUsers();assert.equal(canonical.at(-1).info.id,user.info.id);assert.equal(canonical.some(row=>row.info.id===savedPayload.body.id),false);
   const rows=await Effect.runPromise(nativeStore.messages({sessionID:session.id}));
   const actualContext={messages:toLLMMessages2([...rows].reverse(),{providerID:'openai'}).map(info=>({info,parts:info.content}))};
   assert.equal(actualContext.messages.at(-1).info.id,savedPayload.body.id,'Original native AI conversion retains the status-tail ID');
   const controllerImages=createControllerImages(async(method,input)=>method==='native.slim.images'?images.transform(input):images.settle(input),async()=>{});
   await controllerImages({directory,sessionID:session.id,permit:runnerPermit,domain:'session',phase:'context',signal:new AbortController().signal,event:{}},{},actualContext);
   assert.equal(enteredAssets,1,'Actual controller context must process the accepted input despite the trailing status notice');enteredAssets=0;
   const input=imageInput(runnerPermit);try{assert.deepEqual(await images.transform(input),{replacements:[],imagesSkipped:false});assert.equal(enteredAssets,1);}
   finally{await images.settle(imageScope(input));}
  }
  foreignScope=true;await assert.rejects(()=>admissionOwner.withInterviewAction(action,payload=>gates.controls.interviewActionOwned(payload)));foreignScope=false;
  const count=(await Effect.runPromise(nativeStore.messages({sessionID:session.id}))).length;
  // Revoke between the action's private authorization and its actual effect.
  await assert.rejects(()=>admissionOwner.withInterviewAction(action,async payload=>{revokeOnRead=true;await gates.controls.interviewActionOwned(payload);}));
  caller.active=true;assert.equal((await Effect.runPromise(nativeStore.messages({sessionID:session.id}))).length,count);
  releaseResponse();
  const deadline=Date.now()+15_000;let settled=false;
  while(Date.now()<deadline){if(!(await Effect.runPromise(nativeExecution.isActive(session.id)))){settled=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(settled,true);const completedPage=await client.sessions.messages(session.id,{}, {directory});assert.ok(completedPage.records.some(row=>row.info.role==='assistant'&&row.info.time.completed));
  assert.equal(physicalKinds.filter(kind=>kind==='primary').length,1,'Status-only notice caused a second physical primary request');const primary=await primaryRuntime.readRecord(session.id);assert.equal(primary.anchorID,user.info.id);assert.ok(primary.stepID);assert.notEqual(primary.stepID,savedPayload.body.id);assert.ok(primary.requestedAt);assert.equal(completedPage.records.find(row=>row.info.id===primary.stepID).info.parentID,user.info.id);assert.ok(capturedBus);assert.equal(primarySteps.filter(event=>event.data.sessionID===session.id).length,1);assert.equal(published.filter(event=>event.type==='session.synthetic'&&event.data.sessionID===session.id).length,1);
  const final=await client.sessions.messages(session.id,{}, {directory});assert.ok(final.records.some(row=>row.info.id===savedPayload.body.id));
  // A real accepted user consisting only of synthetic-marked text remains a
  // canonical user. It makes the old context stale even after a status notice.
  await callerContext.run(caller,()=>client.prompts.prompt(session.id,{agent:'build',model:{providerID:'openai',modelID:'gpt-5.5'},parts:[{type:'text',text:'A genuine newer accepted user',synthetic:true}]},{directory}));
  let newest;const nextDeadline=Date.now()+15_000;while(Date.now()<nextDeadline){const rows=await readUsers();if(rows.length===2){newest=rows.at(-1);break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(newest);assert.notEqual(newest.info.id,user.info.id);assert.ok(newest.parts.some(part=>part.type==='text'&&part.synthetic===true&&part.text==='A genuine newer accepted user'));
  const rawNewest=await Effect.runPromise(nativeStore.message(SessionMessage.ID.make(newest.info.id)));assert.equal(rawNewest.message.type,'user');
  const currentPermit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'execution.resume',sessionID:session.id});
  try{
   const stale=imageInput(currentPermit),beforeAssets=enteredAssets;
   try{await assert.rejects(()=>images.transform(stale),error=>error.code==='native_image_message_stale');assert.equal(enteredAssets,beforeAssets);}finally{await images.settle(imageScope(stale));}
   const current={...imageInput(currentPermit),messageIDs:[user.info.id,newest.info.id]};
   try{assert.deepEqual(await images.transform(current),{replacements:[],imagesSkipped:false});assert.equal(enteredAssets,beforeAssets+1);}finally{await images.settle(imageScope(current));}
  }finally{await admissionOwner.handleRpc('native.admission.release',currentPermit);await images.close();}
  result={statusNoticeRetained:true,primaryRequests:1,authorityNegatives:6,canonicalSyntheticUserPreserved:true};
`+source.slice(end);
  replace('  await cleanup(() => runtime.drain());', '  await cleanup(() => primaryRuntime?.drain());await cleanup(() => runtime.drain());');
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(path.resolve(path.dirname(sourcePath),relative)));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify('file://'+path.resolve(path.dirname(sourcePath),relative))+')');
  const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,source);
  const built=await Bun.build({entrypoints:[entry],target:'bun',outdir:root,naming:{entry:'notification.mjs',asset:'[name]-[hash].[ext]'},plugins:[await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
  if(!built.success)throw new AggregateError(built.logs,'Actual notification graph build failed');await writeNativeFixtureOutputs(built.outputs);
  const home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
  child=Bun.spawn([process.execPath,path.join(root,'notification.mjs')],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  await fs.writeFile(path.join(repository,'.cache/v2-validation/resume-native-notification-child.log'),stderr);
  if(code!==0){for(const name of ['rpc-errors.jsonl','reported-causes.jsonl','native-causes.jsonl','hooks.jsonl']){const bytes=await fs.readFile(path.join(root,name)).catch(()=>Buffer.alloc(0));await fs.writeFile(path.join(repository,'.cache/v2-validation/resume-native-notification-'+boundary+'-'+name),bytes);}}
  expect({code,stderr}).toEqual({code:0,stderr:''});expect(JSON.parse(stdout)).toEqual({statusNoticeRetained:true,primaryRequests:1,authorityNegatives:6,canonicalSyntheticUserPreserved:true});
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},120_000);
