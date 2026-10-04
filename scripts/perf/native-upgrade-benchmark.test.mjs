import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPerformanceResponder, createPerformanceTerminalObserver, performanceModelLimits } from '../opencode-v2-native/performance-fixture.mjs';
import { createHttpProvider } from '../opencode-v2-native/http-provider.mjs';
import { assertOperationEvidence, summarizeTerminalAttribution, measureScenario, buildSummary, benchmarkProtocol, runPairedBenchmark, parseWriterProcessSample, joinReceiptProcessIdentities, treeRssMetrics, captureBenchmarkSource, benchmarkArmSchedule, createProcessSampler } from './native-upgrade-benchmark.mjs';

test('collector refuses subset qualification or duplicate scenarios before any fixture or output creation',async()=>{
  for (const omitted of benchmarkProtocol.scenarios) {
    await assert.rejects(runPairedBenchmark({generations:[2],selectedScenarios:benchmarkProtocol.scenarios.filter(name=>name!==omitted)}),/Subset scenarios require explicit --diagnostic/);
  }
  await assert.rejects(runPairedBenchmark({generations:[2],selectedScenarios:[...benchmarkProtocol.scenarios,'idle']}),/Duplicate benchmark scenarios/);
});

const receipt = id => ({id,kind:'canonical-terminal',sessionID:'ses_fixture',messageID:`msg_${id}`,completedAt:1,
  durationMs:2,providerProof:{providerRequests:[`http_${id}`],observedTools:['glob','write']},toolProofs:[]});
const request = (id, marker, extra=[]) => ({id,body:{messages:[{role:'user',content:marker},...extra],tools:[{function:{name:'write'}},{function:{name:'glob'}}]}});

test('terminal attribution joins the exact canonical assistant on the existing stream without content or replay substitution', () => {
  const observer = createPerformanceTerminalObserver({ generation: 2, directory: '/owned', maxRecords: 2 });
  const event = { id: 'evt_exact', sequence: 12, created: 100, type: 'session.step.ended', location: { directory: '/owned' },
    data: { sessionID: 'ses_actual', assistantMessageID: 'msg_final', content: 'must not be retained' } };
  assert.equal(observer.observe({ ...event, location: { directory: '/foreign' } }, 30), null);
  assert.equal(observer.observe({ ...event, type: 'session.idle' }, 30), null);
  assert.equal(observer.observe({ ...event, id: undefined }, 30), null);
  const row = observer.observe(event, 30);
  assert.equal(JSON.stringify(row).includes('must not be retained'), false);
  assert.equal(observer.observe(event, 70), null);
  const timing = observer.join({ sessionID: 'ses_actual', assistantMessageID: 'msg_final', submissionAtMs: 10, completionObservedAtMs: 50 });
  assert.equal(timing.status, 'observed'); assert.equal(timing.terminal.arrivedAtMs, 30);
  assert.equal(timing.submissionToTerminalArrivalMs, 20); assert.equal(timing.terminalArrivalToCompletionObservationMs, 20);
  assert.equal(timing.terminal.sequence, 12);
  for (const [sessionID, assistantMessageID] of [['ses_foreign', 'msg_final'], ['ses_actual', 'msg_latest']]) {
    const missing = observer.join({ sessionID, assistantMessageID, submissionAtMs: 10, completionObservedAtMs: 50 });
    assert.equal(missing.status, 'unavailable'); assert.equal(missing.submissionToTerminalArrivalMs, undefined);
  }
  assert.equal(observer.join({ sessionID: 'ses_actual', assistantMessageID: 'msg_final', submissionAtMs: 40, completionObservedAtMs: 50 }).status, 'unavailable');
  assert.equal(observer.join({ sessionID: 'ses_actual', assistantMessageID: 'msg_final', submissionAtMs: 10, completionObservedAtMs: 20 }).status, 'unavailable');
  observer.observe({ ...event, id: 'evt_second', data: { sessionID: 'ses_actual', assistantMessageID: 'msg_second' } }, 40);
  assert.throws(() => observer.observe({ ...event, id: 'evt_third', data: { sessionID: 'ses_actual', assistantMessageID: 'msg_third' } }, 50), /benchmark_terminal_observation_bound/);
});

test('retired terminal observers cannot start a generation1 fixture', () => {
  assert.throws(() => createPerformanceTerminalObserver({ generation: 1, directory: '/owned' }));
});

test('attribution aggregates require every receipt exact-linked; missing evidence is not zero or a reduced cohort', () => {
  const observer = createPerformanceTerminalObserver({ generation: 2, directory: '/fixture' });
  const rows = Array.from({ length: 100 }, (_, index) => {
    const row = receipt(String(index));
    observer.observe({ id: `evt_${index}`, type: 'session.step.ended', location: { directory: '/fixture' },
      data: { sessionID: row.sessionID, assistantMessageID: row.messageID } }, 11);
    return { ...row, terminalTiming: observer.join({ sessionID: row.sessionID, assistantMessageID: row.messageID,
      submissionAtMs: 10, completionObservedAtMs: 12 }) };
  });
  const full = summarizeTerminalAttribution(rows);
  assert.deepEqual(full.coverage, { status: 'observed', required: 100, observed: 100, unavailable: [] });
  assert.deepEqual(full.metrics, { terminalArrivalP50Ms: 1, terminalArrivalP95Ms: 1, terminalObservationGapP50Ms: 1, terminalObservationGapP95Ms: 1 });
  for (const partial of [rows.map((row, index) => index === 0 ? { ...row, terminalTiming: undefined } : row),
    rows.map((row, index) => index === 0 ? { ...row, messageID: 'msg_foreign' } : row)]) {
    const result = summarizeTerminalAttribution(partial);
    assert.equal(result.coverage.status, 'unavailable'); assert.equal(result.coverage.required, 100); assert.equal(result.coverage.observed, 99);
    assert.equal(result.coverage.unavailable[0].id, '0'); assert.ok(Object.values(result.metrics).every(value => value === null));
  }
  const idle = summarizeTerminalAttribution([]);
  assert.equal(idle.coverage.status, 'not-applicable'); assert.ok(Object.values(idle.metrics).every(value => value === null));
});

test('concurrent provider routes exact last-user markers, validates every tool result and refuses replays',()=>{
  const router=createPerformanceResponder();
  const a=router.register({id:'a',calls:[{id:'call_a',name:'write',input:{path:'a.txt',content:'a'}}]}), b=router.register({id:'b'});
  assert.equal(router.respond(request('http1',a.marker)).reason,'tool-calls');
  assert.equal(router.respond(request('http2',b.marker)).reason,'stop');b.complete();
  assert.throws(()=>router.respond(request('http3',a.marker)),/Missing or duplicate/);
  router.respond(request('http4',a.marker,[{role:'tool',tool_call_id:'call_a',content:'actual fixture result'}]));
  assert.deepEqual(a.complete().providerRequests,['http1','http3','http4']);
  assert.throws(()=>router.respond(request('http5',a.marker)),/Duplicate benchmark inference/);
  assert.throws(()=>router.respond(request('http6','foreign user')),/Unrelated/);
});

test('actual bounded local HTTP transport emits original concurrent SSE responses without provider keys',async()=>{
  const router=createPerformanceResponder(),provider=await createHttpProvider({responder:router.respond});
  try{
    const turns=Array.from({length:4},(_,index)=>router.register({id:`stream_${index}`,text:'x'.repeat(1024),deltas:32}));
    const responses=await Promise.all(turns.map(turn=>fetch(provider.baseURL+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:'smoke-write',stream:true,messages:[{role:'user',content:turn.marker}]})}).then(async response=>{assert.equal(response.status,200);return response.text();})));
    for(const [index,body] of responses.entries()){
      assert.equal((body.match(/"content"/g)??[]).length,32);assert.match(body,/data: \[DONE\]/);turns[index].complete();
    }
    assert.equal(provider.requests.length,4);provider.check();
  }finally{await provider.close();}
});

test('burst completion requires each real process termination/publication receipt and unique operation identities',()=>{
  const row=receipt('burst');row.toolProofs=Array.from({length:8},()=>({state:{status:'completed'},ledger:{receipt:{terminated:true,confined:true},result:{operationID:'actual-unit-proof'}}}));
  assert.match(assertOperationEvidence([row],1,'eight-call-bursts'),/^[a-f0-9]{64}$/);
  const missing=structuredClone(row);delete missing.toolProofs[7].ledger;
  assert.throws(()=>assertOperationEvidence([missing],1,'eight-call-bursts'));
  assert.throws(()=>assertOperationEvidence([row,row],2,'eight-call-bursts'),/Duplicate/);
  assert.throws(()=>assertOperationEvidence([row],100,'eight-call-bursts'),/quota/);
});

test('idle submits zero work; four streams retain every completion after parallel dispatch',async()=>{
  const observations=[],submitted=[],fixture={generation:2,pid:100,directory:'/fixture',observations,
    createSession:async title=>title,streamEvidence:()=>({blocks:submitted.length,bytes:submitted.length,sha256:'unit'}),
    invoke:async input=>{submitted.push(input);observations.push({phase:'provider'});return receipt(input.id);}};
  fixture.subscribeWriterStarts=()=>()=>{};
  const samplerFactory=async(_pid,_interval,options)=>{assert.equal(options.subscribeWriterStarts,fixture.subscribeWriterStarts);return {stop:async()=>({durationMs:1,samples:[{}],metrics:{hostCpuMs:0},failures:[]})};};
  const idle=await measureScenario(fixture,'idle',{operations:4,idleMs:1,warmupMs:0,samplerFactory});
  assert.equal(idle.completedOperations,0);assert.equal(idle.submittedOperations,0);assert.deepEqual(submitted,[]);
  const stream=await measureScenario(fixture,'four-streams',{operations:8,warmupMs:0,samplerFactory});
  assert.equal(stream.receipts.length,8);assert.equal(stream.submittedOperations,8);
  assert.equal(new Set(submitted.slice(benchmarkProtocol.warmupOperations).map(row=>row.sessionID)).size,4);
  assert.equal(new Set(stream.receipts.map(row=>row.id)).size,8);
  const failures=[{code:'process_sample_unavailable',pid:100}];
  await assert.rejects(measureScenario(fixture,'idle',{operations:1,idleMs:1,warmupMs:0,
    samplerFactory:async()=>({stop:async()=>({durationMs:1,samples:[{}],metrics:{},failures})})}),error=>{
    assert.equal(error.code,'benchmark_resource_observation_failed');assert.deepEqual(error.resource.failures,failures);
    assert.deepEqual(error.receipts,[]);assert.equal(error.submittedOperations,0);return true;
  });
});

test('summaries reject failed cleanup/source and retain per-launch latency distributions without quota pooling',()=>{
  const run={generation:2,scenario:'one-stream',status:'completed',runtimeVersion:'2.0.20',artifactSha256:'a'.repeat(64),
    pluginHash:'b'.repeat(64),source:{sourceDigest:'c'.repeat(64)},sourceCohort:{valid:true},cleanup:{cleanupFailures:[]},
    observedTools:['glob','write'],metrics:{operationP95Ms:2},startupMs:3,observations:[],completedOperationReceiptsSha256:'d'.repeat(64),
    resource:{failures:[]},sampleCount:1,modelLimits:performanceModelLimits};
  const summary=buildSummary(2,[run,{...run,metrics:{operationP95Ms:100}},{...run,metrics:{operationP95Ms:5}}],
    {platform:'unit',arch:'unit',node:'unit',cpu:'unit'});
  assert.equal(summary.scenarios['one-stream'].aggregate.median_operationP95Ms,5);
  assert.equal(summary.scenarios['one-stream'].aggregate.max_operationP95Ms,100);
  assert.equal(summary.scenarios['one-stream'].runs.length,3);
  assert.equal(summary.diagnostic,true);
  assert.deepEqual(summary.missingScenarios,benchmarkProtocol.scenarios.filter(name=>name!=='one-stream'));
  assert.equal(summary.runsPerScenario,3,'Partial summary labeling must retain the actual full-run protocol');
  assert.throws(()=>buildSummary(2,[{...run,sourceCohort:{valid:false}}],{}));
  assert.throws(()=>buildSummary(2,[{...run,cleanup:undefined}],{}));
  assert.throws(()=>buildSummary(2,[run,{...run,pluginHash:'f'.repeat(64)}],{}),/plugin closure changed/);
  assert.throws(()=>buildSummary(2,[{...run,resource:{failures:[{code:'lost'}]}}],{}),/resource observation was incomplete/);
  assert.throws(()=>buildSummary(2,[{...run,modelLimits:{...performanceModelLimits,input:16384}}],{}),/model limits differ/);
});

test('actual OS observer includes Node-owned supervised siblings while host RSS/CPU remain separate',async()=>{
  const [{createProcessSampler},{startOwnedProcess}]=await Promise.all([import('./native-upgrade-benchmark.mjs'),import('../qa/process.mjs')]);
  const children=Array.from({length:2},()=>startOwnedProcess(process.execPath,['--eval','process.stdout.write("ready");setTimeout(()=>{},10000)'],{stdio:['ignore','pipe','pipe']}));
  let sampler;
  try{
    await Promise.all(children.map(child=>new Promise(resolve=>child.child.stdout.once('data',resolve))));
    sampler=await createProcessSampler(children[0].child.pid,25,{writerProcessLauncher:'/owned/nonmatching-supervisor'});
    await new Promise(resolve=>setTimeout(resolve,50));
    const result=await sampler.stop();sampler=undefined;
    const observed=result.processOwnership.observedProcesses.map(row=>row.pid);
    assert.ok(observed.includes(children[0].child.pid));assert.ok(observed.includes(children[1].child.pid));
    assert.equal(result.processOwnership.rootPid,process.pid);
    assert.deepEqual(result.metrics.peakTreeRssMiB,Math.max(...result.samples.map(row=>row.hostRssMiB+row.descendantRssMiB)));
    assert.equal(result.metrics.settledTreeRssMiB,result.samples.at(-1).hostRssMiB+result.samples.at(-1).descendantRssMiB);
    assert.equal(result.receiptProcessIdentities.status,'not-applicable');
    for(const sample of result.samples){
      assert.equal(sample.processes.some(row=>row.pid===process.pid),false,'Host CPU/RSS counted twice');
      assert.ok(sample.hostRssMiB>0);assert.ok(sample.descendantRssMiB>0);
    }
  }finally{await sampler?.stop();await Promise.all(children.map(child=>child.stop()));}
});


test('copied snapshot preserves exact native provider and benchmark tuple without ambient discovery', async () => {
  const fs = await import('node:fs/promises'), path = await import('node:path');
  const { repositoryRoot } = await import('../opencode-v2-native/artifacts.mjs');
  const { loadPerformanceLocation, performanceRole, performanceSha256 } = await import('../opencode-v2-native/performance-fixture.mjs');
  const { createHttpProviderConfiguration } = await import('../opencode-v2-native/http-provider.mjs');
  const { createNativeConfigurationSnapshotResolver } = await import('../../packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js');
  const root = await fs.mkdtemp(path.join(repositoryRoot, '.cache/v2-validation/performance-snapshot-'));
  const directory = path.join(root, 'project'), opencodeConfigDirectory = path.join(root, 'opencode');
  const launch = { opencodeConfigDirectory, webConfigDirectory: path.join(root, 'web'), global: { home: path.join(root, 'home'), config: opencodeConfigDirectory },
    reviewedPluginManifestPath: path.join(root, 'plugins.json'), reviewedNativeConfigPath: path.join(root, 'reviewed.json') };
  try {
    await Promise.all([directory, opencodeConfigDirectory, launch.webConfigDirectory, launch.global.home].map(file => fs.mkdir(file)));
    const providers = createHttpProviderConfiguration('http://127.0.0.1:32123/v1').providers;
    await fs.writeFile(path.join(opencodeConfigDirectory, 'opencode.json'), JSON.stringify({ providers, model: 'devryan-smoke/smoke-write',
      agent: { benchmark: { ...performanceRole, model: 'devryan-smoke/smoke-write', variant: 'default' } } }));
    await fs.mkdir(path.join(directory, '.opencode'));
    await fs.writeFile(path.join(directory, '.opencode/opencode.json'), JSON.stringify({ agent: { benchmark: { description: 'Exact project layer' } } }));
    const registrations = JSON.stringify({ schema: 1, plugins: [] });
    await fs.writeFile(launch.reviewedPluginManifestPath, registrations);
    await fs.writeFile(launch.reviewedNativeConfigPath, JSON.stringify({ schema: 1, locations: [{ directory }], catalogRequirements: {} }));
    const resolve = createNativeConfigurationSnapshotResolver({ loadLocation: loadPerformanceLocation, ponytailDefaultMode: undefined });
    const binding = { descriptor: { generation: 2, launch, projectMap: [{ targetDirectory: directory }] } };
    const first = await resolve({ binding, revision: 1, expectedRegistrationDigest: performanceSha256(registrations) });
    assert.deepEqual(first.locations[0].configuration.providers, providers);
    assert.deepEqual(first.locations[0].configuration.agents.benchmark.model, { providerID: 'devryan-smoke', model: 'smoke-write', variant: 'default' });
    assert.equal(first.locations[0].configuration.agents.benchmark.system, performanceRole.prompt);
    assert.equal(first.locations[0].configuration.agents.benchmark.description, 'Exact project layer');
    await fs.writeFile(path.join(directory, '.opencode/opencode.json'), JSON.stringify({ agent: { benchmark: { description: 'New exact revision' } } }));
    const second = await resolve({ binding, revision: 2, expectedRegistrationDigest: performanceSha256(registrations) });
    assert.notEqual(second.sourceStamp, first.sourceStamp); assert.notEqual(second.digest, first.digest);
    await fs.symlink(path.join(opencodeConfigDirectory, 'opencode.json'), path.join(opencodeConfigDirectory, 'opencode.jsonc'));
    await assert.rejects(loadPerformanceLocation({ directory, launch }), /Unreviewed fixture configuration/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('writer receipt coverage requires exact lease argv and actually sampled OS identity', () => {
  const launcher='/owned/DevRyan-session-execution', viewDirectory='/owned/lease/view',
    profile='/owned/lease/sandbox-01234567-89ab-cdef-0123-456789abcdef.sb', receiptPath='/owned/lease/termination.json';
  const row={pid:91,startIdentity:'Fri Oct  2 07:00:00 2026'};
  const stdout=`1024 00:00.12 Fri Oct  2 07:00:00 2026 ${launcher} ${viewDirectory} /owned/lease/scratch ${profile} ${receiptPath} -- /worker secret-never-retained`;
  const parsed=parseWriterProcessSample(stdout,row,launcher);
  assert.deepEqual(parsed.value,{rssMiB:1,cpuMs:120});
  assert.equal(JSON.stringify(parsed).includes('secret-never-retained'),false);
  assert.equal(parseWriterProcessSample(stdout,{...row,startIdentity:'Fri Oct  2 07:00:01 2026'},launcher),null);
  assert.equal(parseWriterProcessSample(stdout.replace(`${launcher} `,'/foreign/launcher '),row,launcher).supervisor,undefined);
  assert.equal(parseWriterProcessSample(stdout.replace(' -- ',' /wrong '),row,launcher).supervisor,undefined);
  const descriptor={receiptToken:'writer_1',launcher,viewDirectory,profile,receiptPath};
  const input={receiptTokens:['writer_1'],descriptors:[descriptor],observations:[parsed.supervisor],samples:[{processes:[row]}]};
  assert.deepEqual(joinReceiptProcessIdentities(input),{status:'observed',required:1,observed:1,
    identities:[{receiptToken:'writer_1',...row}],unavailable:[]});
  const nativeDescriptor={...descriptor,profile:undefined,pid:row.pid};
  assert.equal(joinReceiptProcessIdentities({...input,descriptors:[nativeDescriptor]}).status,'observed');
  for(const invalid of [
    {samples:[]}, {samples:[{processes:[{...row,startIdentity:'reused'}]}]},
    {descriptors:[]}, {descriptors:[descriptor,descriptor]},
    {descriptors:[{...descriptor,profile:'/owned/other.sb'}]},
    {descriptors:[{...descriptor,receiptPath:'/owned/foreign/termination.json'}]},
    {descriptors:[{...descriptor,viewDirectory:'/owned/foreign/view'}]},
    {descriptors:[{...nativeDescriptor,pid:92}]},
    {observations:[{...parsed.supervisor,profile:'/foreign/sandbox-01234567-89ab-cdef-0123-456789abcdef.sb'}],descriptors:[nativeDescriptor]},
    {observations:[parsed.supervisor,{...parsed.supervisor,pid:92}],samples:[{processes:[row,{...row,pid:92}]}]},
  ]) {
    const coverage=joinReceiptProcessIdentities({...input,...invalid});
    assert.equal(coverage.status,'unavailable');
    assert.equal(coverage.unavailable.length,1);
    assert.equal(coverage.unavailable[0].receiptToken,'writer_1');
    assert.equal(coverage.unavailable[0].code,'receipt_process_sampling_unavailable');
  }
  const reused=joinReceiptProcessIdentities({...input,receiptTokens:['writer_1','writer_2'],
    descriptors:[descriptor,{...descriptor,receiptToken:'writer_2'}]});
  assert.equal(reused.status,'unavailable');assert.equal(reused.observed,1);
  assert.equal(joinReceiptProcessIdentities().status,'not-applicable');
});

test('writer coverage diagnoses the exact unavailable join stage without retaining lease paths or private fields', () => {
  const identity={pid:91,startIdentity:'Fri Oct  2 07:00:00 2026'};
  const descriptor={receiptToken:'writer_1',launcher:'/owned/launcher',viewDirectory:'/owned/view',
    profile:'/owned/sandbox-01234567-89ab-cdef-0123-456789abcdef.sb',receiptPath:'/owned/termination.json'};
  const observation={...descriptor,...identity,argv:'private-argv',environment:'private-environment'};
  const input={receiptTokens:['writer_1'],descriptors:[descriptor],observations:[observation],samples:[{processes:[identity]}]};
  const cases=[
    [{descriptors:[]},'descriptor_missing',0,0,0],
    [{descriptors:[descriptor,descriptor]},'descriptor_ambiguous',2,0,0],
    [{observations:[]},'supervisor_unmatched',1,0,0],
    [{descriptors:[{...descriptor,receiptPath:'/wrong/termination.json'}]},'supervisor_unmatched',1,0,0],
    [{descriptors:[{...descriptor,viewDirectory:'/wrong/view'}]},'supervisor_unmatched',1,0,0],
    [{descriptors:[{...descriptor,profile:'/wrong/profile'}]},'supervisor_unmatched',1,0,0],
    [{descriptors:[{...descriptor,profile:undefined,pid:92}]},'supervisor_unmatched',1,0,0,0,0],
    [{descriptors:[{...descriptor,profile:undefined,pid:91}],observations:[{...observation,profile:'/wrong/sandbox-01234567-89ab-cdef-0123-456789abcdef.sb'}]},'supervisor_unmatched',1,0,0,1,1],
    [{descriptors:[{...descriptor,profile:undefined,pid:91}],observations:[]},'supervisor_unmatched',1,0,0,0,1],
    [{descriptors:[{...descriptor,profile:undefined,pid:91}],samples:[{processes:[{...identity,startIdentity:'Fri Oct  2 07:00:01 2026'}]}]},'identity_not_sampled',1,1,0,1,1],
    [{samples:[]},'identity_not_sampled',1,1,0],
    [{samples:[{processes:[{...identity,startIdentity:'Fri Oct  2 07:00:01 2026'}]}]},'identity_not_sampled',1,1,0],
    [{observations:[observation,{...observation,pid:92}],samples:[{processes:[identity,{...identity,pid:92}]}]},'sampled_identity_ambiguous',1,2,2],
    [{observations:[{...observation,pid:0}],samples:[{processes:[{...identity,pid:0}]}]},'identity_malformed',1,1,1],
    [{observations:[{...observation,startIdentity:undefined}],samples:[]},'identity_malformed',1,1,0],
  ];
  for(const [overrides,reason,descriptorCount,matchingSupervisorCount,sampledIdentityCount,observedSupervisorsForPID=null,sampledIdentitiesForPID=null] of cases){
    const result=joinReceiptProcessIdentities({...input,...overrides});
    assert.equal(result.status,'unavailable');assert.equal(result.required,1);assert.equal(result.observed,0);
    const failure=result.unavailable[0];
    assert.equal(failure.code,'receipt_process_sampling_unavailable');assert.equal(failure.reason,reason);
    assert.deepEqual(failure.counts,{descriptors:descriptorCount,matchingSupervisors:matchingSupervisorCount,sampledIdentities:sampledIdentityCount,observedSupervisorsForPID,sampledIdentitiesForPID});
    assert.equal(JSON.stringify(failure).includes('/owned'),false);assert.equal(JSON.stringify(failure).includes('/wrong'),false);
    assert.equal(JSON.stringify(failure).includes('private-'),false);
    if(reason==='identity_not_sampled')assert.deepEqual(failure.identity,identity);
    if(reason==='identity_malformed')assert.equal(failure.identity,undefined);
  }
  const reused=joinReceiptProcessIdentities({...input,receiptTokens:['writer_1','writer_2'],
    descriptors:[descriptor,{...descriptor,receiptToken:'writer_2'}]});
  assert.equal(reused.observed,1);assert.equal(reused.required,2);
  assert.deepEqual(reused.unavailable,[{receiptToken:'writer_2',code:'receipt_process_sampling_unavailable',reason:'identity_reused',
    counts:{descriptors:1,matchingSupervisors:1,sampledIdentities:1,observedSupervisorsForPID:null,sampledIdentitiesForPID:null},identity}]);
  const duplicateObserved=joinReceiptProcessIdentities({...input,observations:[observation,observation]});
  assert.equal(duplicateObserved.status,'observed');assert.deepEqual(duplicateObserved.identities,[{receiptToken:'writer_1',...identity}]);
});

test('tree RSS uses paired samples rather than independently timed peaks', () => {
  assert.deepEqual(treeRssMetrics([{hostRssMiB:100,descendantRssMiB:2},
    {hostRssMiB:3,descendantRssMiB:80},{hostRssMiB:20,descendantRssMiB:30}]),
  {peakTreeRssMiB:102,settledTreeRssMiB:50});
});


test('benchmark source cohort freezes executable perf and QA helpers while excluding tests',async()=>{
  const fs=await import('node:fs/promises'),path=await import('node:path');
  const {repositoryRoot}=await import('../opencode-v2-native/artifacts.mjs');
  const root=await fs.mkdtemp(path.join(repositoryRoot,'.cache/v2-validation/benchmark-source-'));
  const nativeSource={sources:{'packages/native.ts':'a'.repeat(64)}};
  try {
    await fs.mkdir(path.join(root,'scripts/perf'),{recursive:true});
    await fs.mkdir(path.join(root,'scripts/qa/nested'),{recursive:true});
    await fs.writeFile(path.join(root,'scripts/perf/comparison.mjs'),'export const threshold=1;');
    await fs.writeFile(path.join(root,'scripts/qa/nested/observer.ts'),'export const cadence=250;');
    await fs.writeFile(path.join(root,'scripts/qa/launch.cjs'),'module.exports=1;');
    await fs.writeFile(path.join(root,'scripts/perf/ignored.test.mjs'),'test before');
    await fs.writeFile(path.join(root,'scripts/qa/ignored.spec.ts'),'spec before');
    const dependencies=['scripts/dev-child-utils.mjs','packages/cursor-sdk-runtime/ripgrep-path.js',
      'packages/web/server/default-config/plugins/devryan-managed-orchestration.mjs',
      'packages/web/server/default-config/plugins/council-session.js','packages/web/server/default-config/plugins/devryan-browser.mjs'];
    for(const relative of dependencies){
      await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});
      await fs.writeFile(path.join(root,relative),'export {};');
    }
    const before=await captureBenchmarkSource({root,nativeSource});
    assert.deepEqual(Object.keys(before.sources),['packages/native.ts','scripts/perf/comparison.mjs',
      'scripts/qa/launch.cjs','scripts/qa/nested/observer.ts',...dependencies].sort((left,right)=>left.localeCompare(right)));
    assert.deepEqual(await captureBenchmarkSource({root,nativeSource}),before);
    await fs.writeFile(path.join(root,'scripts/perf/ignored.test.mjs'),'test after');
    await fs.writeFile(path.join(root,'scripts/qa/ignored.spec.ts'),'spec after');
    assert.equal((await captureBenchmarkSource({root,nativeSource})).sourceDigest,before.sourceDigest);
    await fs.writeFile(path.join(root,'scripts/qa/nested/observer.ts'),'export const cadence=251;');
    const changed=await captureBenchmarkSource({root,nativeSource});
    assert.notEqual(changed.sourceDigest,before.sourceDigest);
    assert.notEqual(changed.sources['scripts/qa/nested/observer.ts'],before.sources['scripts/qa/nested/observer.ts']);
    await fs.writeFile(path.join(root,'scripts/perf/added.js'),'export {};');
    const added=await captureBenchmarkSource({root,nativeSource});
    assert.notEqual(added.sourceDigest,changed.sourceDigest);
    await fs.writeFile(path.join(root,'scripts/dev-child-utils.mjs'),'export const changed=true;');
    assert.notEqual((await captureBenchmarkSource({root,nativeSource})).sourceDigest,added.sourceDigest);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});


test('v2 calibration remains 21 launches and explicit comparison alternates 42 same-artifact arms', () => {
  const calibration = benchmarkArmSchedule({artifactRoot:'/repo/artifact',comparisonArmID:'control'});
  assert.equal(calibration.order.flat().length * benchmarkProtocol.scenarios.length,21);
  const arms = [{id:'control',artifactRoot:'/repo/artifact',eventReconcileIntervalMs:750},
    {id:'candidate',artifactRoot:'/repo/artifact',eventReconcileIntervalMs:5000}];
  assert.deepEqual(benchmarkArmSchedule({comparisonArms:arms}).order.map(pair=>pair.map(row=>row.id)),
    [['control','candidate'],['candidate','control'],['control','candidate']]);
  assert.equal(benchmarkArmSchedule({comparisonArms:arms}).order.flat().length * benchmarkProtocol.scenarios.length,42);
  for(const input of [[arms[0],arms[0]], [{...arms[0],eventReconcileIntervalMs:-1}], [{...arms[0],unknown:true}]]) {
    assert.throws(()=>benchmarkArmSchedule({comparisonArms:input}));
  }
});


const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferredSample = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function samplerTestFixture({ snapshotFailureAt, unsubscribeFailure=false } = {}) {
  const launcher='/owned/launcher', startIdentity='Fri Oct  2 07:00:00 2026', controllerPID=101, writerPIDs=[102,103];
  const rows=[{pid:process.pid,parentPid:0,startIdentity,running:true},
    ...[controllerPID,...writerPIDs].map(pid=>({pid,parentPid:process.pid,startIdentity,running:true}))];
  const reads=[]; let listener, unsubscribeCount=0, snapshots=0, readHook, active=0, maxActive=0;
  const sampler=await createProcessSampler(controllerPID,250,{writerProcessLauncher:launcher,
    subscribeWriterStarts:callback=>{listener=callback;return ()=>{unsubscribeCount++;if(unsubscribeFailure)throw new Error('private unsubscribe message');};},
    readSnapshot:async()=>{snapshots++;if(snapshots===snapshotFailureAt)throw Object.assign(new Error('snapshot unavailable'),{code:'unit_snapshot_failed'});return rows;},
    executeSample:async(_command,args)=>{
      const pid=Number(args[2]);reads.push(pid);active++;maxActive=Math.max(maxActive,active);
      try { await readHook?.(pid);return {stdout:`1024 00:00.12 ${startIdentity} ${writerPIDs.includes(pid)?launcher:'/controller'} /owned/view /owned/scratch /owned/sandbox-01234567-89ab-cdef-0123-456789abcdef.sb /owned/termination.json -- /worker`}; }
      finally { active--; }
    }});
  assert.equal(typeof listener,'function','writer observer must be registered');
  return {sampler,reads,notify:pid=>listener(pid),setReadHook:hook=>{readHook=hook;},
    snapshotCount:()=>snapshots,unsubscribeCount:()=>unsubscribeCount,maxActive:()=>maxActive};
}

test('writer start immediately requests a prioritized full-tree sample without awaiting workload',async()=>{
  const fixture=await samplerTestFixture();
  try {
    fixture.reads.length=0;
    assert.equal(fixture.notify(103),undefined);
    await nextTurn();
    assert.deepEqual(fixture.reads,[103,101,102]);
    const resource=await fixture.sampler.stop();
    assert.equal(resource.samples.length,3);assert.equal(fixture.maxActive(),1);
    for(const sample of resource.samples)assert.equal(sample.processes.length,3);
    assert.equal(resource.processOwnership.observationIntervalMs,250);
    assert.equal(resource.processOwnership.writerStartSampling,'coalesced-prioritized-whole-tree');
    assert.deepEqual(resource.processOwnership.writerStartRequests,{received:1,coalesced:0,sampledPasses:1});
    assert.equal(fixture.unsubscribeCount(),1);
    const reads=fixture.reads.length;fixture.notify(102);await nextTurn();assert.equal(fixture.reads.length,reads);
  } finally { await fixture.sampler.stop(); }
});

test('busy writer requests coalesce into one serialized whole-tree pass and stop drains accepted priorities',async()=>{
  const fixture=await samplerTestFixture(),blocked=deferredSample(),entered=deferredSample();
  let held=true;
  fixture.setReadHook(async pid=>{if(pid===101&&held){entered.resolve();await blocked.promise;}});
  fixture.reads.length=0;
  try {
    fixture.notify(102);await entered.promise;
    fixture.notify(103);fixture.notify(103);
    let stopped=false;const stopping=fixture.sampler.stop().then(value=>{stopped=true;return value;});
    await nextTurn();assert.equal(stopped,false);assert.equal(fixture.unsubscribeCount(),1);
    fixture.notify(102);held=false;blocked.resolve();
    const resource=await stopping;
    assert.deepEqual(fixture.reads,[102,101,103,103,101,102,101,102,103]);
    assert.equal(resource.samples.length,4);assert.equal(fixture.maxActive(),1);
    for(const sample of resource.samples)assert.equal(sample.processes.length,3);
    assert.deepEqual(resource.processOwnership.writerStartRequests,{received:3,coalesced:2,sampledPasses:2});
    assert.deepEqual(resource.failures,[]);assert.equal(resource.metrics.peakTreeRssMiB,Math.max(...resource.samples.map(sample=>sample.hostRssMiB+3)));assert.equal(resource.metrics.settledTreeRssMiB,resource.samples.at(-1).hostRssMiB+3);
  } finally { held=false;blocked.resolve();await fixture.sampler.stop(); }
});

test('requested sampling errors do not strand stop or retain a live writer subscription',async()=>{
  const fixture=await samplerTestFixture({snapshotFailureAt:2});
  fixture.notify(103);await nextTurn();
  const stopping=fixture.sampler.stop();assert.equal(fixture.sampler.stop(),stopping);
  const resource=await stopping;
  assert.equal(resource.failures.length,1);assert.equal(resource.failures[0].code,'writer_start_sample_failed');
  assert.equal(resource.samples.length,2);assert.equal(fixture.unsubscribeCount(),1);
  const snapshots=fixture.snapshotCount();fixture.notify(102);await nextTurn();assert.equal(fixture.snapshotCount(),snapshots);
});

test('final sampling error still revokes subscription and closes request acceptance',async()=>{
  const fixture=await samplerTestFixture({snapshotFailureAt:2});
  await assert.rejects(fixture.sampler.stop(),{code:'unit_snapshot_failed'});
  assert.equal(fixture.unsubscribeCount(),1);
  const snapshots=fixture.snapshotCount();fixture.notify(103);await nextTurn();assert.equal(fixture.snapshotCount(),snapshots);
});


test('producer microtasks at whole-tree pass settlement cannot strand an immediate follow-up',async()=>{
  for(let depth=1;depth<=8;depth++){
    const fixture=await samplerTestFixture();let queued=false;
    fixture.setReadHook(pid=>{
      if(pid!==103||queued)return;
      queued=true;
      const schedule=remaining=>queueMicrotask(()=>{if(remaining) schedule(remaining-1);else fixture.notify(103);});
      schedule(depth);
    });
    fixture.reads.length=0;
    try {
      fixture.notify(102);await nextTurn();
      assert.deepEqual([...fixture.reads],[102,101,103,103,101,102],`follow-up stranded at microtask boundary ${depth}`);
      assert.equal(fixture.maxActive(),1);
    } finally { await fixture.sampler.stop(); }
  }
});


test('initial sampler failure never registers a writer listener or starts periodic work',async()=>{
  let snapshots=0,subscriptions=0;
  await assert.rejects(createProcessSampler(101,250,{readSnapshot:async()=>{snapshots++;throw Object.assign(new Error('unavailable'),{code:'unit_initial_failed'});},
    subscribeWriterStarts:()=>{subscriptions++;return ()=>{};}}),{code:'unit_initial_failed'});
  await nextTurn();assert.equal(snapshots,1);assert.equal(subscriptions,0);
});

test('subscription registration failure drains accepted work and revokes its captured callback',async()=>{
  const identity='Fri Oct  2 07:00:00 2026', rows=[{pid:process.pid,parentPid:0,startIdentity:identity,running:true},
    {pid:101,parentPid:process.pid,startIdentity:identity,running:true}];
  const entered=deferredSample(),release=deferredSample();let listener,snapshots=0,reads=0,rejected=false;
  const creating=createProcessSampler(101,250,{readSnapshot:async()=>{snapshots++;return rows;},
    executeSample:async()=>{reads++;if(reads===2){entered.resolve();await release.promise;}return {stdout:'1024 00:00.12'};},
    subscribeWriterStarts:callback=>{listener=callback;callback(101);throw Object.assign(new Error('registration unavailable'),{code:'unit_registration_failed'});}});
  const rejection=assert.rejects(creating,{code:'unit_registration_failed'}).then(()=>{rejected=true;});
  await entered.promise;await nextTurn();assert.equal(rejected,false);
  listener(101);release.resolve();await rejection;
  const count=snapshots;listener(101);await nextTurn();assert.equal(snapshots,count);assert.equal(reads,2);
});

test('unsubscribe failure is fixed evidence and stop remains idempotent with late requests revoked',async()=>{
  const fixture=await samplerTestFixture({unsubscribeFailure:true});
  const stopping=fixture.sampler.stop();assert.equal(fixture.sampler.stop(),stopping);
  const resource=await stopping;
  assert.equal(fixture.unsubscribeCount(),1);assert.equal(resource.samples.length,2);
  assert.equal(resource.failures.length,1);assert.equal(resource.failures[0].code,'writer_start_unsubscribe_failed');
  assert.equal(JSON.stringify(resource.failures).includes('private'),false);
  const count=fixture.snapshotCount();fixture.notify(103);await nextTurn();assert.equal(fixture.snapshotCount(),count);
});
