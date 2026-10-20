import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {rewriteNativeFinalizationObservation} from '../native-finalization-observation-transform.mjs';
import {rewriteNativeCompactionObservation} from '../native-compaction-observation-transform.mjs';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';

const repository = path.resolve(import.meta.dirname, '../..');
// Child logs and results land in the test's own temp root (removed afterwards) unless DEVRYAN_KEEP_ARTIFACTS=1.
const keptDiagnostics=(root:string)=>process.env.DEVRYAN_KEEP_ARTIFACTS==='1'?path.join(repository,'.cache/v2-validation'):root;

for (const compiled of [false,true]) test(`actual native physical request and committed Step.Started share the original attempt span ${compiled?'compiled':'source'}`, async () => {
  const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/observation-span-'));
  const home = path.join(root, 'home'), tmp = path.join(home, 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
  let child: ReturnType<typeof Bun.spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined, failure: unknown;
  // Kills a child still running and removes the fixture; a cleanup failure is
  // reported together with the test's own failure.
  const settleObservationChild=async()=>{
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try { if(child&&child.exitCode===null){child.kill('SIGKILL');await Promise.race([child.exited,new Promise<never>((_resolve,reject)=>{cleanupTimer=setTimeout(()=>reject(Error('Owned observation child failed to settle after SIGKILL')),5000);})]);} }
    catch(error){throw failure?new AggregateError([failure,error],'Observation fixture and child cleanup failed',{cause:failure}):error;}
    finally{clearTimeout(cleanupTimer);await fs.rm(root,{recursive:true,force:true});}
  };
  try {
    const sourcePath = path.join(repository, 'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');
    let source = await fs.readFile(sourcePath, 'utf8');
    const replace = (before: string, after: string) => {
      if (source.split(before).length !== 2) throw Error('Native integration graph fixture changed');
      source = source.replace(before, after);
    };
    source = `import {Bus} from '@opencode/core/bus';\nimport {currentNativeAttemptIdentity,createNativeObservation} from ${JSON.stringify(pathToFileURL(path.join(repository, 'packages/web/server/lib/opencode/runtime-host/native-observation.ts')).href)};\nimport {createNativeObservationOwner} from ${JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-observation-owner.js')).href)};\n` + source;
    replace("models: { 'gpt-5.5':", "models: { 'gpt-6-astra': { capabilities:{tools:true,input:['text'],output:['text']},limit:{context:400000,input:272000,output:4096},settings:{reasoningSummary:'detailed'},variants:[{id:'medium',settings:{reasoningEffort:'medium'}},{id:'high',settings:{reasoningEffort:'high'}}] }, 'gpt-5.5':");
    replace('reasoningSummary: body.reasoning?.summary });', "reasoningSummary: body.reasoning?.summary,model:body.model,wireEffort:body.reasoning?.effort??null,updateEfforts:body.input.filter(item=>item.type==='configuration_update').map(item=>item.reasoning?.effort) });");
    replace('const rpc = async (method, input, context) => {',`let observationOwner,observationClient;const diagnosticObservations=[],presentationRequests=[],rpcOutcomes=[],presentationEmitted=[],permitAliases=new Map();let activeRpc=0,rpcOrdinal=0,droppedRpcOutcomes=0;
const rpcFact=(method,input)=>{const value=input?.observation??input;const fact={ordinal:++rpcOrdinal,method};
 for(const key of ['sessionID','requestID','stepID','assistantMessageID'])if(typeof value?.[key]==='string'&&/^[A-Za-z0-9_.:/-]{1,256}$/.test(value[key]))fact[key]=value[key];
 const permit=['native.presentation','native.observation','fixture.presentation.enqueue'].includes(method)?input?.permit:method==='native.admission.release'?input:null;
 if(typeof permit?.token==='string'){if(!permitAliases.has(permit.token)){assert.ok(permitAliases.size<256,'Bounded permit alias evidence overflow');permitAliases.set(permit.token,'permit-'+(permitAliases.size+1));}fact.permitID=permitAliases.get(permit.token);}
 if(['model-prepared','physical','step-link'].includes(value?.stage))fact.stage=value.stage;
 if(['primary','title','compaction','generate'].includes(value?.kind))fact.kind=value.kind;
 if(typeof input?.operation==='string'&&/^[a-z][a-zA-Z.]{0,95}$/.test(input.operation))fact.operation=input.operation;
 if(['finalizing','cleared'].includes(value?.phase))fact.phase=value.phase;if(Number.isSafeInteger(value?.progress)&&value.progress>=0)fact.progress=value.progress;return fact;};
const retainRpc=fact=>{if(rpcOutcomes.length<256)rpcOutcomes.push(fact);else droppedRpcOutcomes++;};
globalThis[Symbol.for('devryan.fixture.presentation.enqueue')]=(permit,observation)=>retainRpc({...rpcFact('fixture.presentation.enqueue',{permit,observation}),outcome:'enqueued'});
const rawRpc = async (method, input, context) => {
  if(method==='native.presentation'){presentationRequests.push(input.observation);return observationOwner.handleRpc(method,input);}
  if(method==='native.observation')return observationOwner.handleRpc(method,input);`);
    replace('const bridge = createRemoteNativeAdmissionBridge({ rpc });', `const rpc=async(method,input,context)=>{const fact=rpcFact(method,input);activeRpc++;
 try{const value=await rawRpc(method,input,context);if(method==='native.admission.authorize'){assert.equal(typeof value?.token,'string');if(!permitAliases.has(value.token)){assert.ok(permitAliases.size<256,'Bounded permit alias evidence overflow');permitAliases.set(value.token,'permit-'+(permitAliases.size+1));}fact.permitID=permitAliases.get(value.token);}
 if(method==='native.presentation'||method==='native.admission.authorize'||method==='native.admission.release'||method==='native.observation'&&['model-prepared','physical','step-link'].includes(fact.stage))retainRpc({...fact,outcome:'returned'});return value;}
 catch(error){retainRpc({...fact,outcome:'refused',code:typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(error.code)?error.code:'unclassified',statusCode:Number.isSafeInteger(error?.statusCode)?error.statusCode:null});throw error;}
 finally{activeRpc--;}};
const bridge = createRemoteNativeAdmissionBridge({ rpc });`);
    replace('  if (failures.length) throw new AggregateError(', `  await cleanup(async()=>{const deadline=Date.now()+2000;while(activeRpc&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(activeRpc,0,'Owned diagnostic RPC settlement incomplete');
    assert.equal(droppedRpcOutcomes,0,'Bounded RPC evidence overflow');
    await fs.writeFile(path.join(root,'presentation-rpc-outcomes.json'),JSON.stringify({scope:'actual-constructor-native-owner-nonmanaged-fixture',readPrimaryRecord:'null; managed primary cancellation/state checks not exercised',outcomes:rpcOutcomes,emitted:presentationEmitted,dropped:droppedRpcOutcomes}));});
  if (failures.length) throw new AggregateError(`);
    replace('const gates = createAdmissionGates(', `observationOwner=createNativeObservationOwner({instanceID:controller.instanceID,snapshot,controller:()=>controller,isReady:()=>ready,admissionOwner,readPrimaryRecord:async()=>null,
  onPresentationProgress:input=>presentationEmitted.push({phase:input.phase,progress:input.progress,sessionID:input.sessionID,assistantID:input.assistantID,stepID:input.stepID,objectiveID:input.objectiveID}),
  openCodeClient:{sessions:{message:(...args)=>observationClient.sessions.message(...args)}},recordDiagnostic:entry=>diagnosticObservations.push(entry)});
const observation=createNativeObservation({controllerInstanceID:controller.instanceID,configurationDigest:snapshot.digest,rpc});
const attempts=[];
const captureAttempt=(stage,event)=>currentNativeAttemptIdentity.pipe(Effect.tap(identity=>Effect.sync(()=>{
  if(stage==='step'||event.kind==='primary')attempts.push({stage,identity,sessionID:event.data?.sessionID??event.sessionID,assistantMessageID:event.data?.assistantMessageID});
})));
const observationBus=Bus.node.replace(Bus.node.mapLayer(original=>Layer.effect(Bus.Service,Effect.gen(function*(){
 const inner=yield* Bus.Service;
 return {...inner,publish:(definition,data,options)=>inner.publish(definition,data,options).pipe(Effect.tap(event=>
   (definition.type==='session.step.started'?captureAttempt('step',event):Effect.void).pipe(Effect.andThen(observation.observePublished(event))))),
   publishAll:events=>inner.publishAll(events).pipe(Effect.tap(published=>Effect.forEach(published,event=>observation.observePublished(event),{discard:true})))};
})).pipe(Layer.provide(original))));
const gates = createAdmissionGates(`);
    replace('const actual=factory.providerHooks(inner);', 'const actual=observation.decorateHooks(factory.providerHooks(inner));');
    replace('actual.trigger(domain,name,event).pipe(Effect.tap(', `actual.trigger(domain,name,event).pipe(Effect.tap(result=>
  domain==='session'&&['http.request','experimental.ws.send'].includes(name)?captureAttempt(name,result):Effect.void),Effect.tap(`);
    replace('...factory.overrides,...compatibility.overrides,', '...factory.overrides,...compatibility.overrides,...observation.overrides,observationBus,');
    replace('  const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });', '  const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });observationClient=client;');
    replace('  await verifyModels();\n  const old=', `  const physical=attempts.filter(row=>row.stage!=='step'),steps=attempts.filter(row=>row.stage==='step');
  assert.ok(physical.some(row=>row.stage==='http.request'));
  assert.equal(physical.some(row=>row.stage==='experimental.ws.send'),false,'Native Codex does not use websocket Responses');
  assert.ok(steps.length>=2);
  for(const row of physical){assert.ok(row.identity,'Actual native attempt span missing');
    assert.ok(steps.some(step=>step.sessionID===row.sessionID&&step.identity?.traceID===row.identity.traceID&&step.identity?.spanID===row.identity.spanID),'Physical request has no exact native Step.Started span');}
  assert.equal(attempts.find(row=>row.sessionID===session.id).stage,'http.request','First request must precede durable Step.Started');
  const records=diagnosticObservations.map(row=>row.payload);
  for(const actual of physical){const wire=records.find(row=>row.stage==='physical'&&row.sessionID===actual.sessionID&&row.attempt?.spanID===actual.identity.spanID&&row.transport==='http');
    assert.ok(wire,'Actual post-hook physical observation missing: '+JSON.stringify({stage:actual.stage,identity:actual.identity,records:records.map(row=>({stage:row.stage,requestID:row.requestID,attempt:row.attempt}))}));
    const prepared=records.find(row=>row.stage==='model-prepared'&&row.requestID===wire.requestID);assert.ok(prepared);
    assert.ok(Number.isSafeInteger(prepared.toolCount)&&prepared.toolCount>=0,'Actual materialized prepared tools count missing');
    assert.equal(wire.toolCount,prepared.toolCount,'Physical request lost its exact prepared tool count');
    assert.ok(Number.isSafeInteger(wire.wireToolCount)&&wire.wireToolCount>=0,'Actual serialized HTTP tools count missing');
    assert.equal(prepared.execution.providerID,'openai');assert.equal(prepared.options.reasoningEffort,'high');assert.equal(wire.wireOptions.reasoning.effort,'high');
    const link=records.find(row=>row.stage==='step-link'&&row.attempt?.spanID===wire.attempt.spanID&&row.attempt?.traceID===wire.attempt.traceID);
    assert.ok(link?.userMessageID,'Canonical Node parent linkage missing');}
  assert.equal(JSON.stringify(records).includes('fixture.'),false);
  assert.equal(JSON.stringify(records).includes('Owned native primary prompt'),false);
  const trigger=records.find(row=>row.stage==='compaction-trigger'&&row.reason==='manual');assert.ok(trigger?.budget,'Original SDK budget witness missing');
  assert.equal(trigger.budget.buffer,null);assert.equal(trigger.budget.keep,15000);const window=trigger.budget.limits.input||trigger.budget.limits.context;assert.equal(window,272000);assert.equal(trigger.budget.limits.context,400000);assert.equal(trigger.budget.ceiling,window-Math.max(Math.floor(window*0.15),window>=32000?16000:0));assert.equal(trigger.budget.budget,trigger.budget.ceiling);
  assert.equal(trigger.budget.estimateContext,trigger.budget.estimatePrompt.measured+trigger.budget.estimatePrompt.estimated);
  assert.ok(records.some(row=>row.stage==='compaction-outcome'&&row.triggerID===trigger.triggerID&&row.status==='completed'));
  const ended=records.find(row=>row.stage==='compaction-event'&&row.triggerID===trigger.triggerID&&row.event==='ended');assert.ok(ended?.witness.text.bytes>0);assert.equal(ended.witness.native,null);
  const started=records.find(row=>row.stage==='compaction-event'&&row.event==='started'&&row.inputID===trigger.inputID);assert.ok(started,'Actual manual Started witness missing');
  assert.ok(started.sequence<ended.sequence&&started.created<=ended.created);
  assert.equal(diagnosticObservations.some(row=>row.event==='native_observation_gap'),false);
  assert.equal(ended.messageID,trigger.inputID,'Manual compaction must keep original running/inbox identity');
  const page=await client.sessions.messages(session.id,{directory:directories[0]});assert.ok(page.records.some(row=>row.info.id===ended.messageID),'Raw compaction ID must match native projected boundary');
  assert.ok(presentationRequests.some(row=>row.phase==='finalizing'),'Actual final prepared request lost constructor-private settlement registration');
  for(const row of presentationRequests){const physical=records.find(candidate=>candidate.stage==='physical'&&candidate.requestID===row.requestID&&candidate.attempt?.spanID===row.attempt.spanID&&candidate.attempt.traceID===row.attempt.traceID);
    const step=records.find(candidate=>candidate.stage==='step-link'&&candidate.eventID===row.stepID&&candidate.assistantMessageID===row.assistantMessageID&&candidate.attempt?.spanID===row.attempt.spanID);
    assert.ok(physical&&step,'Finalization lost exact final prepared/physical/step identity');}
  result.finalizationConstructorLinkProven=true;
  result.attemptSpanProven=true;
  // Native canonical default -> medium selection emits a GPT6 effort marker;
  // the SDK deliberately keeps effort out of the top-level generation controls.
  const effortSession=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'openai',modelID:'gpt-6-astra'}},{directory:directories[0]}));
  const effortBefore=receipts.length;
  await callerContext.run(caller,()=>client.prompts.prompt(effortSession.id,{agent:'build',model:{providerID:'openai',modelID:'gpt-6-astra'},variant:'medium',parts:[{type:'text',text:'Owned native effort transition'}]},{directory:directories[0]}));
  let effortSettled=false;const effortDeadline=Date.now()+10000;
  while(Date.now()<effortDeadline){const [page,statuses]=await Promise.all([client.sessions.messages(effortSession.id,{directory:directories[0]}),client.sessions.status({directory:directories[0]})]);
    const assistant=page.records.find(row=>row.info.role==='assistant'&&row.info.time.completed);
    if(assistant&&!statuses[effortSession.id]){assert.equal(assistant.info.error,undefined);assert.equal(assistant.info.variant,'medium');effortSettled=true;break;}
    await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(effortSettled,true,'Actual GPT6 medium generation did not settle');
  const effortReceipts=receipts.slice(effortBefore).filter(row=>row.kind==='primary'&&row.model==='gpt-6-astra');assert.equal(effortReceipts.length,1);
  assert.equal(effortReceipts[0].wireEffort,null);assert.deepEqual(effortReceipts[0].updateEfforts,['medium']);
  const effortRecords=diagnosticObservations.map(row=>row.payload).filter(row=>row.sessionID===effortSession.id);
  const effortPrepared=effortRecords.filter(row=>row.stage==='model-prepared'&&row.kind==='primary');assert.equal(effortPrepared.length,1);
  assert.equal(effortPrepared[0].execution.variant,'medium');assert.equal(effortPrepared[0].options.reasoningEffort,'medium');
  const effortPhysical=effortRecords.filter(row=>row.stage==='physical'&&row.requestID===effortPrepared[0].requestID);assert.equal(effortPhysical.length,1);
  assert.equal(effortPhysical[0].wireOptions.reasoning.effort,undefined);assert.deepEqual(effortPhysical[0].wireEffortUpdates,{count:1,effort:'medium'});
  assert.ok(effortRecords.some(row=>row.stage==='step-link'&&row.execution.variant==='medium'&&row.attempt?.spanID===effortPhysical[0].attempt?.spanID&&row.attempt?.traceID===effortPhysical[0].attempt?.traceID),'Effort evidence lost its exact canonical step');
  result.effortUpdateWireProven=true;
  await verifyModels();
  const old=`);
    source = source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g, (_all, _quote, relative: string) =>
      'from ' + JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href));
    source = source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g, (_all, _quote, relative: string) =>
      'new URL(' + JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href) + ')');
    source=source.replace(/from ("file:[^"]+")/g,(_all,specifier:string)=>'from '+JSON.stringify(fileURLToPath(JSON.parse(specifier))));
    const entry = path.join(root, 'fixture.mjs'); await fs.writeFile(entry, source);
    const assetPlugin=await createNativeAssetFixturePlugin(repository);
    const compactionPlugin: Bun.BunPlugin={name:'pinned-read-only-compaction-observation',setup(builder){builder.onLoad({filter:/shell-s389npg2\.js$/},async event=>({
      contents:rewriteNativeCompactionObservation(await fs.readFile(event.path,'utf8'),path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-compaction-observation.ts')).contents,loader:'js'}));}};
    const finalizationPlugin:Bun.BunPlugin={name:'pinned-native-finalization-observation',setup(builder){builder.onLoad({filter:/shell-4nejsby7\.js$/},async event=>({contents:rewriteNativeFinalizationObservation(await fs.readFile(event.path,'utf8'),path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-finalization-observation.ts')).contents,loader:'js'}));}};
    const enqueueTracePlugin:Bun.BunPlugin={name:'fixture-only-finalization-enqueue-trace',setup(builder){builder.onLoad({filter:/runtime-host\/native-observation\.ts$/},async event=>{
      const original=await fs.readFile(event.path,'utf8');const seam='const queueFinalization=(permit:unknown,observation:Readonly<Record<string,unknown>>,interval:FinalizationInterval)=>{';
      if(original.split(seam).length!==2)throw Error('Native finalization enqueue fixture seam changed');
      return {contents:original.replace(seam,seam+"\n    globalThis[Symbol.for('devryan.fixture.presentation.enqueue')]?.(permit,observation);"),loader:'ts'};
    });}};
    const executable=path.join(root,compiled?'observed-native':'observed.mjs');
    const built=await Bun.build({entrypoints:[entry],...compiled?{compile:{outfile:executable,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false}}:{outdir:root,naming:{entry:'observed.mjs',asset:'[name]-[hash].[ext]'}},target:'bun',plugins:[assetPlugin,compactionPlugin,finalizationPlugin,enqueueTracePlugin,reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
    if(!built.success)throw new AggregateError(built.logs,'Actual observation graph build failed');if(!compiled)await writeNativeFixtureOutputs(built.outputs);
    child = Bun.spawn(compiled?[executable]:[process.execPath,executable], { cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp,
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
      XDG_CACHE_HOME: path.join(home, 'cache'), GIT_CEILING_DIRECTORIES: root, DEVRYAN_INTEGRATION_FIXTURE_ROOT: root }, stdout: 'pipe', stderr: 'pipe' });
    if (!child.stdout || typeof child.stdout === 'number' || !child.stderr || typeof child.stderr === 'number') throw Error('Owned pipes required');
    // Hang detection, not a performance bound: the child takes ~12 s locally and
    // ~22 s on a hosted CI runner, and slower runners exceeded 30 s.
    let timedOut=false;timer=setTimeout(()=>{timedOut=true;try{child?.kill('SIGKILL');}catch{/* Already exited. */}},120_000);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);if(timedOut)throw Error('Native observation child exceeded its bounded 120-second lifetime');
    const diagnostic=JSON.parse(await fs.readFile(path.join(root,'presentation-rpc-outcomes.json'),'utf8'));
    await fs.writeFile(path.join(keptDiagnostics(root),`native-observation-${compiled?'compiled':'source'}-presentation.json`),JSON.stringify({compiled,childExitCode:code,...diagnostic}));
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout).attemptSpanProven).toBe(true);expect(JSON.parse(stdout).effortUpdateWireProven).toBe(true);expect(JSON.parse(stdout).finalizationConstructorLinkProven).toBe(true);
    const outcomes=diagnostic.outcomes as {method:string;permitID?:string;sessionID?:string;assistantMessageID?:string;stepID?:string;phase?:string;progress?:number;outcome:string;ordinal:number}[];
    const emitted=diagnostic.emitted as {sessionID:string;assistantID:string;stepID:string;phase:string;progress:number}[];
    const begins=outcomes.filter(row=>row.method==='fixture.presentation.enqueue'&&row.phase==='finalizing'&&row.progress===0);
    expect(begins.length).toBeGreaterThanOrEqual(2);
    expect(outcomes.filter(row=>row.method==='native.presentation'&&row.outcome!=='returned')).toEqual([]);
    for(const begin of begins){
      const same=(row:{sessionID?:string;assistantMessageID?:string;stepID?:string;permitID?:string})=>row.sessionID===begin.sessionID&&row.assistantMessageID===begin.assistantMessageID&&row.stepID===begin.stepID&&row.permitID===begin.permitID;
      const cleared=outcomes.find(row=>row.method==='native.presentation'&&row.phase==='cleared'&&same(row));
      const released=outcomes.find(row=>row.method==='native.admission.release'&&row.permitID===begin.permitID);
      expect(cleared?.outcome).toBe('returned');expect(released?.outcome).toBe('returned');
      expect(cleared!.ordinal).toBeLessThan(released!.ordinal);
      expect(emitted.filter(row=>row.sessionID===begin.sessionID&&row.assistantID===begin.assistantMessageID&&row.stepID===begin.stepID).map(row=>({phase:row.phase,progress:row.progress}))).toEqual([
        {phase:'finalizing',progress:0},{phase:'finalizing',progress:1},{phase:'cleared',progress:1},
      ]);
    }
  } catch(error) { failure=error;throw error; } finally {
    clearTimeout(timer);await settleObservationChild();
  }
}, 300_000);
