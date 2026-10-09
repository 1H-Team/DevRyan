import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {rewriteNativeCompactionObservation} from '../native-compaction-observation-transform.mjs';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';

const repository = path.resolve(import.meta.dirname, '../..');

test('actual native physical request and committed Step.Started share the original attempt span', async () => {
  const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/observation-span-'));
  const home = path.join(root, 'home'), tmp = path.join(home, 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const sourcePath = path.join(repository, 'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');
    let source = await fs.readFile(sourcePath, 'utf8');
    const replace = (before: string, after: string) => {
      if (source.split(before).length !== 2) throw Error('Native integration graph fixture changed');
      source = source.replace(before, after);
    };
    source = `import {Bus} from '@opencode/core/bus';\nimport {currentNativeAttemptIdentity,createNativeObservation} from ${JSON.stringify(pathToFileURL(path.join(repository, 'packages/web/server/lib/opencode/runtime-host/native-observation.ts')).href)};\nimport {createNativeObservationOwner} from ${JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-observation-owner.js')).href)};\n` + source;
    replace('const rpc = async (method, input, context) => {',`let observationOwner,observationClient;const diagnosticObservations=[];
const rpc = async (method, input, context) => {
  if(method==='native.observation')return observationOwner.handleRpc(method,input);`);
    replace('const gates = createAdmissionGates(', `observationOwner=createNativeObservationOwner({instanceID:controller.instanceID,snapshot,controller:()=>controller,isReady:()=>ready,admissionOwner,
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
  assert.equal(physical.some(row=>row.stage==='experimental.ws.send'),false,'SIWC plan usage does not use websocket Responses');
  assert.ok(steps.length>=2);
  for(const row of physical){assert.ok(row.identity,'Actual native attempt span missing');
    assert.ok(steps.some(step=>step.sessionID===row.sessionID&&step.identity?.traceID===row.identity.traceID&&step.identity?.spanID===row.identity.spanID),'Physical request has no exact native Step.Started span');}
  assert.equal(attempts.find(row=>row.sessionID===session.id).stage,'http.request','First request must precede durable Step.Started');
  const records=diagnosticObservations.map(row=>row.payload);
  for(const actual of physical){const wire=records.find(row=>row.stage==='physical'&&row.sessionID===actual.sessionID&&row.attempt?.spanID===actual.identity.spanID&&row.transport==='http');
    assert.ok(wire,'Actual post-hook physical observation missing: '+JSON.stringify({stage:actual.stage,identity:actual.identity,records:records.map(row=>({stage:row.stage,requestID:row.requestID,attempt:row.attempt}))}));
    const prepared=records.find(row=>row.stage==='model-prepared'&&row.requestID===wire.requestID);assert.ok(prepared);
    assert.equal(prepared.execution.providerID,'openai');assert.equal(prepared.options.reasoningEffort,'high');assert.equal(wire.wireOptions.reasoning.effort,'high');
    const link=records.find(row=>row.stage==='step-link'&&row.attempt?.spanID===wire.attempt.spanID&&row.attempt?.traceID===wire.attempt.traceID);
    assert.ok(link?.userMessageID,'Canonical Node parent linkage missing');}
  assert.equal(JSON.stringify(records).includes('fixture.'),false);
  assert.equal(JSON.stringify(records).includes('Owned native primary prompt'),false);
  const trigger=records.find(row=>row.stage==='compaction-trigger'&&row.reason==='manual');assert.ok(trigger?.budget,'Original SDK budget witness missing');
  assert.equal(trigger.budget.buffer,null);assert.equal(trigger.budget.keep,15000);const window=trigger.budget.limits.input||trigger.budget.limits.context;assert.equal(window,263500);assert.equal(trigger.budget.limits.context,1050000);assert.equal(trigger.budget.ceiling,window-Math.max(Math.floor(window*0.1),window>=32000?16000:0));assert.equal(trigger.budget.budget,trigger.budget.ceiling);
  assert.equal(trigger.budget.estimateContext,trigger.budget.estimatePrompt.measured+trigger.budget.estimatePrompt.estimated);
  assert.ok(records.some(row=>row.stage==='compaction-outcome'&&row.triggerID===trigger.triggerID&&row.status==='completed'));
  const ended=records.find(row=>row.stage==='compaction-event'&&row.triggerID===trigger.triggerID&&row.event==='ended');assert.ok(ended?.witness.text.bytes>0);
  const started=records.find(row=>row.stage==='compaction-event'&&row.event==='started'&&row.inputID===trigger.inputID);assert.ok(started,'Actual manual Started witness missing');
  assert.ok(started.sequence<ended.sequence&&started.created<=ended.created);
  assert.equal(diagnosticObservations.some(row=>row.event==='native_observation_gap'),false);
  assert.equal(ended.messageID,trigger.inputID,'Manual compaction must keep original running/inbox identity');
  const page=await client.sessions.messages(session.id,{directory:directories[0]});assert.ok(page.records.some(row=>row.info.id===ended.messageID),'Raw compaction ID must match native projected boundary');
  result.attemptSpanProven=true;
  await verifyModels();
  const old=`);
    source = source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g, (_all, _quote, relative: string) =>
      'from ' + JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href));
    source = source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g, (_all, _quote, relative: string) =>
      'new URL(' + JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href) + ')');
    source=source.replace(/from ("file:[^"]+")/g,(_all,specifier:string)=>'from '+JSON.stringify(fileURLToPath(JSON.parse(specifier))));
    const entry = path.join(root, 'fixture.mjs'); await fs.writeFile(entry, source);
    const assetPlugin=await createNativeAssetFixturePlugin(repository);
    const compactionPlugin: Bun.BunPlugin={name:'pinned-read-only-compaction-observation',setup(builder){builder.onLoad({filter:/location-services-qhaz1dgr\.js$/},async event=>({
      contents:rewriteNativeCompactionObservation(await fs.readFile(event.path,'utf8'),path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-compaction-observation.ts')).contents,loader:'js'}));}};
    const built=await Bun.build({entrypoints:[entry],outdir:root,naming:{entry:'observed.mjs',asset:'[name]-[hash].[ext]'},target:'bun',plugins:[assetPlugin,compactionPlugin,reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
    if(!built.success)throw new AggregateError(built.logs,'Actual observation graph build failed');await writeNativeFixtureOutputs(built.outputs);
    child = Bun.spawn([process.execPath, path.join(root,'observed.mjs')], { cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp,
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
      XDG_CACHE_HOME: path.join(home, 'cache'), GIT_CEILING_DIRECTORIES: root, DEVRYAN_INTEGRATION_FIXTURE_ROOT: root }, stdout: 'pipe', stderr: 'pipe' });
    if (!child.stdout || typeof child.stdout === 'number' || !child.stderr || typeof child.stderr === 'number') throw Error('Owned pipes required');
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    await fs.writeFile(path.join(repository, '.cache/v2-validation/stage-d-native-observation-span-child.log'), stderr);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout).attemptSpanProven).toBe(true);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
