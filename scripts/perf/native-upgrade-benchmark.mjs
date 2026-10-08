import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createPerformanceFixture, performanceSha256, performanceRole, performanceModelLimits } from '../opencode-v2-native/performance-fixture.mjs';
import { captureNativeAcceptanceSource, repositoryRoot } from '../opencode-v2-native/artifacts.mjs';
import { readQaProcessSnapshot } from '../qa/process-ownership.mjs';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { startOwnedProcess } from '../qa/process.mjs';
import { parseProcessSample } from './ledger-profile-worker.mjs';
import { runtimeUpgradeScenarios } from './runtime-upgrade-comparison.mjs';
import { createRunRoot } from '../qa/run-root.mjs';

const execute = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hostConditions = () => ({ observedAt: new Date().toISOString(), loadAverage: os.loadavg(), freeMemoryBytes: os.freemem() });
const file = fileURLToPath(import.meta.url);
/** Measurement and process observers are part of the same frozen source cohort. */
export async function captureBenchmarkSource({ root=repositoryRoot, nativeSource }={}) {
  root=await fs.realpath(root);
  assert.ok(root===repositoryRoot || root.startsWith(repositoryRoot+path.sep),'Benchmark sources must remain inside repository');
  const sources=new Map(Object.entries((nativeSource??await captureNativeAcceptanceSource()).sources));
  const visit=async relative=>{
    const resolved=path.join(root,relative);
    assert.equal(await fs.realpath(resolved),resolved,'Benchmark source directory contains a link');
    for(const entry of await fs.readdir(resolved,{withFileTypes:true})) {
      const file=path.join(relative,entry.name);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile()) {
        if(/\.(?:[cm]?js|ts)$/.test(file) && !/\.(?:test|spec)\./.test(file)) sources.set(file,performanceSha256(await fs.readFile(path.join(root,file))));
      } else throw new Error(`Benchmark source contains a link: ${file}`);
    }
  };
  for(const relative of ['scripts/perf','scripts/qa'])await visit(relative);
  // Direct executable dependencies outside the measurement helper directories.
  for(const relative of ['scripts/dev-child-utils.mjs','packages/cursor-sdk-runtime/ripgrep-path.js',
    'packages/web/server/default-config/plugins/devryan-managed-orchestration.mjs',
    'packages/web/server/default-config/plugins/council-session.js','packages/web/server/default-config/plugins/devryan-browser.mjs']) {
    const file=path.join(root,relative);
    assert.equal(await fs.realpath(file),file,'Benchmark dependency contains a link');
    sources.set(relative,performanceSha256(await fs.readFile(file)));
  }
  const sorted=Object.fromEntries([...sources].sort(([left],[right])=>left.localeCompare(right)));
  return {sourceDigest:digest(sorted),sources:sorted};
}

export const scenarios = runtimeUpgradeScenarios;
export const benchmarkProtocol = Object.freeze({ schema:2, scenarios, runOrder:[[2],[2],[2]],
  operations:100, idleMs:30_000, warmupOperations:3, warmupMs:5000, historyCompletedTurns:100,
  sampleIntervalMs:250, writerStartSampling:'coalesced-prioritized-whole-tree', streamDeltas:32, streamCharacters:2048, concurrency:4, burstCalls:8,
  toolKinds:['glob','write'], files:[1000,12000], modelLimits:performanceModelLimits, compaction:'separate-qualification', measurement:'owned-process-tree-and-canonical-http-sse',
  metricsLimitations:['No Chromium/UI/paid-provider measurement', 'OS sampling misses subprocesses that start and exit between samples',
    'Node host CPU and RSS include the local fixture/collector', 'Sampled descendant CPU excludes unobserved short-lived child work'] });
export const quantile = (values, fraction) => {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  return sorted.length ? sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*fraction))] : null;
};

/** Attribution only: partial coverage never becomes a smaller latency cohort. */
export function summarizeTerminalAttribution(receipts) {
  const observed = [], unavailable = [];
  for (const receipt of receipts) {
    const timing = receipt.terminalTiming, terminal = timing?.terminal;
    const valid = timing?.status === 'observed' && timing.source === 'same-native-sse-stream-exact-canonical-assistant'
      && terminal?.sessionID === receipt.sessionID && terminal.assistantMessageID === receipt.messageID
      && [timing.submissionAtMs, terminal.arrivedAtMs, timing.completionObservedAtMs].every(Number.isFinite)
      && timing.submissionAtMs >= 0 && terminal.arrivedAtMs >= timing.submissionAtMs && timing.completionObservedAtMs >= terminal.arrivedAtMs
      && timing.submissionToTerminalArrivalMs === terminal.arrivedAtMs - timing.submissionAtMs
      && timing.terminalArrivalToCompletionObservationMs === timing.completionObservedAtMs - terminal.arrivedAtMs
      && receipt.durationMs === timing.completionObservedAtMs - timing.submissionAtMs;
    if (valid) observed.push(timing);
    else unavailable.push({ id: receipt.id, sessionID: receipt.sessionID, messageID: receipt.messageID,
      reason: timing?.status === 'unavailable' && typeof timing.reason === 'string' && /^[a-z_]{1,128}$/.test(timing.reason)
        ? timing.reason : 'exact_terminal_timing_missing_or_invalid' });
  }
  const complete = receipts.length > 0 && unavailable.length === 0;
  return { coverage: { status: receipts.length === 0 ? 'not-applicable' : complete ? 'observed' : 'unavailable',
    required: receipts.length, observed: observed.length, unavailable },
  metrics: { terminalArrivalP50Ms: complete ? quantile(observed.map(row => row.submissionToTerminalArrivalMs), .5) : null,
    terminalArrivalP95Ms: complete ? quantile(observed.map(row => row.submissionToTerminalArrivalMs), .95) : null,
    terminalObservationGapP50Ms: complete ? quantile(observed.map(row => row.terminalArrivalToCompletionObservationMs), .5) : null,
    terminalObservationGapP95Ms: complete ? quantile(observed.map(row => row.terminalArrivalToCompletionObservationMs), .95) : null } };
}

export function assertOperationEvidence(receipts, expected, scenario) {
  assert.ok(Number.isSafeInteger(expected) && expected >= 0);
  assert.equal(receipts.length, expected, 'Completed operation quota cannot be pooled across launches');
  assert.equal(new Set(receipts.map(row=>row.id)).size, receipts.length, 'Duplicate completed operations');
  for (const row of receipts) {
    assert.equal(row.kind,'canonical-terminal');
    assert.ok(row.sessionID && row.messageID && Number.isFinite(row.completedAt));
    assert.ok(row.providerProof?.providerRequests?.length > 0);
    if (scenario === 'eight-call-bursts') {
      assert.equal(row.toolProofs?.length,8);
      for (const call of row.toolProofs) {
        assert.equal(call.state.status,'completed'); assert.equal(call.ledger?.receipt?.terminated,true);
        assert.equal(call.ledger?.receipt?.confined,true); assert.ok(call.ledger?.result?.operationID);
      }
    } else if (scenario.startsWith('tools-')) {
      assert.equal(row.toolProofs?.length,1); assert.equal(row.toolProofs[0].state.status,'completed');
    }
  }
  return digest(receipts);
}

// Command text is transient: retain only the reviewed supervisor's finite
// lease paths, never worker argv/environment or unrelated process commands.
export function parseWriterProcessSample(stdout, row, launcher) {
  const match = stdout.trim().match(/^(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match || match[3].replace(/\s+/g, ' ') !== row.startIdentity.replace(/\s+/g, ' ')) return null;
  const value = parseProcessSample(`${match[1]} ${match[2]}`);
  if (!value) return null;
  const args = match[4].split(/\s+/);
  const supervisor = launcher && !/\s/.test(launcher) && args[0] === launcher && args[5] === '--'
    && args.slice(1, 5).every(file => path.isAbsolute(file))
    ? { pid: row.pid, startIdentity: row.startIdentity, launcher,
      viewDirectory: args[1], profile: args[3], receiptPath: args[4] } : undefined;
  return { value, supervisor };
}

export function joinReceiptProcessIdentities({ receiptTokens = [], descriptors = [], observations = [], samples = [] } = {}) {
  const required = [...new Set(receiptTokens)], identities = [], unavailable = [];
  const sampled = new Set(), sampledStartsByPID = new Map(), supervisorCountsByPID = new Map();
  for (const sample of samples) for (const row of sample.processes ?? []) {
    sampled.add(`${row.pid}\0${row.startIdentity}`);
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.startIdentity !== 'string' || !row.startIdentity) continue;
    let starts = sampledStartsByPID.get(row.pid);
    if (!starts) { starts = new Set(); sampledStartsByPID.set(row.pid, starts); }
    starts.add(row.startIdentity);
  }
  for (const row of observations) {
    if (Number.isSafeInteger(row.pid) && row.pid > 0) supervisorCountsByPID.set(row.pid, (supervisorCountsByPID.get(row.pid) ?? 0) + 1);
  }
  const used = new Set();
  for (const receiptToken of required) {
    const bindings = descriptors.filter(row => row.receiptToken === receiptToken);
    const counts = { descriptors: bindings.length, matchingSupervisors: 0, sampledIdentities: 0,
      observedSupervisorsForPID: null, sampledIdentitiesForPID: null };
    const reject = (reason, row) => unavailable.push({ receiptToken, code: 'receipt_process_sampling_unavailable', reason, counts,
      ...(row ? { identity: { pid: row.pid, startIdentity: row.startIdentity } } : {}) });
    if (bindings.length !== 1) { reject(bindings.length ? 'descriptor_ambiguous' : 'descriptor_missing'); continue; }
    const binding = bindings[0];
    if (Number.isSafeInteger(binding.pid) && binding.pid > 0) {
      counts.observedSupervisorsForPID = supervisorCountsByPID.get(binding.pid) ?? 0;
      counts.sampledIdentitiesForPID = sampledStartsByPID.get(binding.pid)?.size ?? 0;
    }
    const matches = observations.filter(row => row.launcher === binding.launcher
      && row.viewDirectory === binding.viewDirectory && row.receiptPath === binding.receiptPath
      && (binding.profile ? row.profile === binding.profile : Number.isSafeInteger(binding.pid) && row.pid === binding.pid
        && typeof row.profile === 'string' && path.dirname(row.profile) === path.dirname(binding.receiptPath)
        && /^sandbox-[0-9a-f-]{36}\.sb$/.test(path.basename(row.profile))));
    counts.matchingSupervisors = matches.length;
    if (!matches.length) { reject('supervisor_unmatched'); continue; }
    const validIdentity = row => Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.startIdentity === 'string' && Boolean(row.startIdentity);
    const unique = new Map(matches.filter(row => sampled.has(`${row.pid}\0${row.startIdentity}`))
      .map(row => [`${row.pid}\0${row.startIdentity}`, row]));
    counts.sampledIdentities = unique.size;
    if (!unique.size) {
      const observed = new Map(matches.filter(validIdentity).map(row => [`${row.pid}\0${row.startIdentity}`, row]));
      reject(observed.size ? 'identity_not_sampled' : 'identity_malformed', observed.size === 1 ? [...observed.values()][0] : undefined);
      continue;
    }
    if (unique.size !== 1) { reject('sampled_identity_ambiguous'); continue; }
    const [key, row] = [...unique][0];
    if (!validIdentity(row)) { reject('identity_malformed'); continue; }
    if (used.has(key)) { reject('identity_reused', row); continue; }
    used.add(key); identities.push({ receiptToken, pid: row.pid, startIdentity: row.startIdentity });
  }
  return { status: required.length === 0 ? 'not-applicable' : unavailable.length ? 'unavailable' : 'observed',
    required: required.length, observed: identities.length, identities, unavailable };
}

export function treeRssMetrics(samples) {
  const totals = samples.map(row => row.hostRssMiB + row.descendantRssMiB);
  return { peakTreeRssMiB: Math.max(...totals), settledTreeRssMiB: totals.at(-1) };
}

/** Sampling follows only the fixture's exact ChildProcess ancestry/start identities. */
export async function createProcessSampler(pid, intervalMs=benchmarkProtocol.sampleIntervalMs, { writerProcessLauncher, subscribeWriterStarts, readSnapshot = readQaProcessSnapshot, executeSample = execute } = {}) {
  // Controller and writer supervisors are siblings created by this isolated
  // Node fixture. Retain their actual identities beneath this process; this
  // observer has no signalling or cleanup authority.
  const retained=new Map();let rootIdentity;
  const observe=async()=>{
    const rows=await readSnapshot(),current=new Map(rows.map(row=>[row.pid,row]));
    const root=current.get(process.pid);assert.ok(root?.running,'Fixture process identity absent');
    rootIdentity??=root.startIdentity;assert.equal(root.startIdentity,rootIdentity);
    const owned=new Set([process.pid,...[...retained.values()].filter(row=>current.get(row.pid)?.startIdentity===row.startIdentity).map(row=>row.pid)]);
    let changed=true;while(changed){changed=false;for(const row of rows){
      if(owned.has(row.pid)||!owned.has(row.parentPid)||retained.has(row.pid)&&retained.get(row.pid).startIdentity!==row.startIdentity)continue;
      retained.set(row.pid,row);owned.add(row.pid);changed=true;
    }}
    assert.ok(owned.has(pid),'Controlled runtime is not beneath this fixture owner');
    return [...retained.values()].filter(row=>current.get(row.pid)?.startIdentity===row.startIdentity&&current.get(row.pid).running);
  };
  const samples=[], failures=[], exitedBeforeSample=[]; let pending=Promise.resolve(), busy=false, requested=false, accepting=true, stopped;
  const pendingWriterPIDs=new Set(), writerStartRequests={received:0,coalesced:0,sampledPasses:0};
  const baselineCpu=new Map(), finalCpu=new Map(), writerObservations=new Map();
  const hostStart=process.cpuUsage();
  const delay=monitorEventLoopDelay({resolution:10});delay.enable();
  const started=performance.now();
  const sample=async(priorities=new Set())=>{
    const observed=await observe();
    const rows=[...observed.filter(row=>priorities.has(row.pid)),...observed.filter(row=>!priorities.has(row.pid))];
    let descendantRssMiB=0;
    const processes=[];
    for (const row of rows) {
      try {
        const {stdout}=await executeSample('ps',['-ww','-p',String(row.pid),'-o',writerProcessLauncher ? 'rss=,time=,lstart=,command=' : 'rss=,time='],
          {env:{...process.env,LC_ALL:'C'},timeout:1000,maxBuffer:64*1024});
        const parsed = writerProcessLauncher ? parseWriterProcessSample(stdout,row,writerProcessLauncher) : null;
        const value=writerProcessLauncher ? parsed?.value : parseProcessSample(stdout);
        if (parsed?.supervisor) writerObservations.set(`${row.pid}\0${row.startIdentity}`,parsed.supervisor);
        if (!value) throw Object.assign(new Error('Process resource sample was not readable'), {code:'process_sample_invalid'});
        const key=`${row.pid}\0${row.startIdentity}`;
        if (!baselineCpu.has(key)) baselineCpu.set(key,samples.length===0 ? value.cpuMs : 0);
        finalCpu.set(key,value.cpuMs); descendantRssMiB+=value.rssMiB;
        processes.push({pid:row.pid,startIdentity:row.startIdentity,...value});
      } catch (error) {
        const current = (await readSnapshot()).find(record=>record.pid===row.pid && record.startIdentity===row.startIdentity && record.running);
        const evidence={at:Date.now(),pid:row.pid,startIdentity:row.startIdentity};
        if (current) failures.push({...evidence,code:error.code??'process_sample_unavailable'});
        else exitedBeforeSample.push(evidence);
      }
    }
    samples.push({atMs:performance.now()-started,hostRssMiB:process.memoryUsage().rss/1024/1024,descendantRssMiB,processes});
  };
  try { await sample(); } catch (error) { delay.disable(); throw error; }
  const drainRequests=()=>{
    if (busy || !requested) return;
    busy=true;
    pending=(async()=>{
      try {
        while(requested){
          requested=false;
          const priorities=new Set(pendingWriterPIDs);pendingWriterPIDs.clear();
          try { await sample(priorities);if(priorities.size)writerStartRequests.sampledPasses++; }
          catch(error){failures.push({at:Date.now(),code:priorities.size?'writer_start_sample_failed':error.code??'ownership_sample_unavailable'});}
        }
      } finally { busy=false; }
    })();
  };
  const requestWriterSample=pid=>{
    if (!accepting || !Number.isSafeInteger(pid) || pid<=0) return;
    writerStartRequests.received++;if(busy)writerStartRequests.coalesced++;
    pendingWriterPIDs.add(pid);requested=true;drainRequests();
  };
  let unsubscribe=()=>{};
  try {
    if(subscribeWriterStarts){
      assert.equal(typeof subscribeWriterStarts,'function');
      unsubscribe=subscribeWriterStarts(requestWriterSample);assert.equal(typeof unsubscribe,'function');
    }
  } catch(error){
    accepting=false;
    try { if(typeof unsubscribe==='function')unsubscribe(); } catch { failures.push({at:Date.now(),code:'writer_start_unsubscribe_failed'}); }
    try { await pending; } finally { delay.disable(); }
    throw error;
  }
  const timer=setInterval(()=>{
    if (!accepting || busy)return;
    requested=true;drainRequests();
  },intervalMs);
  return { stop:(coverage={})=>stopped??=(async()=>{
    accepting=false;clearInterval(timer);
    try { unsubscribe(); } catch { failures.push({at:Date.now(),code:'writer_start_unsubscribe_failed'}); }
    try { await pending;await sample(); } finally { delay.disable(); }
    const cpu=process.cpuUsage(hostStart);
    return {samples,failures,exitedBeforeSample,receiptProcessIdentities:joinReceiptProcessIdentities({...coverage,observations:[...writerObservations.values()],samples}),durationMs:performance.now()-started,processOwnership:{source:'retained-os-start-identities-and-ancestry-under-isolated-fixture-node',rootPid:process.pid,
        controlledRuntimePid:pid,rootIdentity,observationIntervalMs:intervalMs,writerStartSampling:benchmarkProtocol.writerStartSampling,writerStartRequests,observedProcesses:[...retained.values()]},
      metrics:{...treeRssMetrics(samples),hostCpuMs:(cpu.user+cpu.system)/1000,
        sampledDescendantCpuMs:[...finalCpu].reduce((sum,[key,value])=>sum+Math.max(0,value-baselineCpu.get(key)),0),
        peakHostRssMiB:Math.max(...samples.map(row=>row.hostRssMiB)),
        peakDescendantRssMiB:Math.max(...samples.map(row=>row.descendantRssMiB)),
        hostLoopP50Ms:delay.percentile(50)/1e6,hostLoopP95Ms:delay.percentile(95)/1e6,hostLoopMaxMs:delay.max/1e6,
        sampledProcessIdentities:finalCpu.size,
        settledHostRssMiB:samples.at(-1).hostRssMiB,settledDescendantRssMiB:samples.at(-1).descendantRssMiB} };
  })()};
}

export async function measureScenario(fixture, scenario, { operations=100, idleMs=benchmarkProtocol.idleMs,
  warmupMs=benchmarkProtocol.warmupMs, samplerFactory=createProcessSampler }={}) {
  assert.ok(scenarios.includes(scenario));
  assert.ok(Number.isSafeInteger(operations) && operations>0);
  const concurrency=scenario==='four-streams'?4:1;
  const sessions=await Promise.all(Array.from({length:concurrency},(_,index)=>fixture.createSession(`Performance ${scenario} ${index}`)));
  const invoke=async(sessionID,index,prefix='measured')=>{
    const id=`${scenario}-${prefix}-${index}`;
    const calls=scenario==='eight-call-bursts' ? Array.from({length:8},(_,call)=>({id:`${id}-${call}`,name:'write',input: {path:`burst-${call}.txt`,content:`fixture ${index} ${call}\n`} }))
      : scenario.startsWith('tools-') ? [{id:`${id}-glob`,name:'glob',input:{pattern:'files/*.txt',}}] : [];
    return fixture.invoke({sessionID,id,calls,text:`completed ${id}\n`+'x'.repeat(benchmarkProtocol.streamCharacters),deltas:benchmarkProtocol.streamDeltas});
  };
  const warmupReceipts = [];
  if (scenario==='long-history') for(let index=0;index<benchmarkProtocol.historyCompletedTurns;index++)await invoke(sessions[0],index,'history');
  if (scenario!=='idle') for(let index=0;index<benchmarkProtocol.warmupOperations;index++)warmupReceipts.push(await invoke(sessions[index%concurrency],index,'warmup'));
  await pause(warmupMs);
  fixture.check?.();
  const beforeStream=fixture.streamEvidence(), providerStart=fixture.observations.filter(row=>row.phase==='provider').length;
  const sampler=await samplerFactory(fixture.pid,benchmarkProtocol.sampleIntervalMs,{writerProcessLauncher:fixture.writerProcessLauncher,subscribeWriterStarts:fixture.subscribeWriterStarts});
  const receipts=[]; let submittedOperations=0, resource;
  try {
    if (scenario==='idle') await pause(idleMs);
    else for(let offset=0;offset<operations;offset+=concurrency){
      const size=Math.min(concurrency,operations-offset);submittedOperations+=size;
      receipts.push(...await Promise.all(Array.from({length:size},(_,lane)=>invoke(sessions[lane],offset+lane))));
    }
  } finally {
    const receiptTokens=receipts.flatMap(row=>row.toolProofs??[]).flatMap(row=>row.ledger?.token ? [row.ledger.token] : []);
    resource=await sampler.stop({receiptTokens,descriptors:fixture.receiptProcessDescriptors?.()??[]});
    resource.receiptProcessIdentities??=joinReceiptProcessIdentities({receiptTokens,samples:resource.samples});
  }
  if (!Array.isArray(resource.failures) || resource.failures.length || !resource.samples?.length) {
    throw Object.assign(new Error('Owned process resource observation was incomplete'), {
      code:'benchmark_resource_observation_failed',resource,receipts,submittedOperations,
    });
  }
  fixture.check?.();
  const afterStream=fixture.streamEvidence();
  if (scenario==='idle') {
    assert.equal(fixture.observations.filter(row=>row.phase==='provider').length,providerStart,'Idle observation performed model work');
  } else assert.ok(afterStream.blocks>beforeStream.blocks,'Actual native SSE did not deliver during active work');
  const receiptsHash=assertOperationEvidence(receipts,scenario==='idle'?0:operations,scenario);
  const terminalAttribution = summarizeTerminalAttribution(receipts);
  return {kind:scenario==='idle'?'idle-observation':'completed-operations',completedOperations:receipts.length,submittedOperations,
    completedOperationReceiptsSha256:receiptsHash,observationSha256:digest({resource,beforeStream,afterStream}),
    durationMs:resource.durationMs,sampleCount:resource.samples.length,
    terminalAttribution: terminalAttribution.coverage,
    metrics:{...resource.metrics,...terminalAttribution.metrics,completedOperationsPerSecond:receipts.length/(resource.durationMs/1000),operationP50Ms:quantile(receipts.map(row=>row.durationMs),.5),
      operationP95Ms:quantile(receipts.map(row=>row.durationMs),.95),sseBytes:afterStream.bytes-beforeStream.bytes,
      sseBlocks:afterStream.blocks-beforeStream.blocks},receipts,warmupReceipts,resource,stream:{before:beforeStream,after:afterStream}};
}

async function runArm(input) {
  input = { ...input, root: await fs.realpath(input.root) };
  assert.ok(input.root.startsWith(repositoryRoot + path.sep), 'Benchmark output must remain inside the repository');
  const source=await captureBenchmarkSource();
  const runnerHashes=Object.fromEntries(await Promise.all([file,path.join(repositoryRoot,'scripts/opencode-v2-native/performance-fixture.mjs')]
    .map(async inputFile=>[path.relative(repositoryRoot,inputFile),performanceSha256(await fs.readFile(inputFile))])));
  const conditions = { before: hostConditions() };
  let fixture,result;
  try {
    fixture=await createPerformanceFixture({root:input.root,generation:input.generation,artifactRoot:input.artifactRoot,
      eventReconcileIntervalMs:input.eventReconcileIntervalMs,
      fileCount:input.scenario==='tools-12k'?12000:1000});
    const run=await measureScenario(fixture,input.scenario,input);
    result={status:'completed',...run,comparisonArmID:input.comparisonArmID,eventReconcileIntervalMs:fixture.eventReconcileIntervalMs,generation:input.generation,scenario:input.scenario,startupMs:fixture.startupMs,
      preparationMs:fixture.preparationMs,runtimeVersion:fixture.version,artifactSha256:fixture.artifactSha256,pluginHash:fixture.pluginHash,modelLimits:fixture.modelLimits,
      observedTools:[...new Set(run.receipts.flatMap(row=>row.providerProof.observedTools))].sort(),
      observations:fixture.observations,diagnostics:fixture.diagnostics};
  } catch(error){result={status:'failed',error:{code:error.code,message:error.message},
    ...(error.resource?{resource:error.resource,receipts:error.receipts,submittedOperations:error.submittedOperations}:{})};}
  finally {
    // Startup/warmup failures precede measurement but still need their actual
    // provider/owner evidence for diagnosis; retain it before shutting down.
    if(fixture){result.observations=fixture.observations;result.diagnostics=fixture.diagnostics;}
    try {result.cleanup=await fixture?.cleanup();}catch(error){result.status='failed';result.cleanupError={code:error.code,message:error.message};}
  }
  const after=await captureBenchmarkSource();
  result.source=source;result.runnerHashes=runnerHashes;result.hostConditions={...conditions,after:hostConditions()};
  const changedPaths=[];
  for(const [relative,sha256]of Object.entries(runnerHashes))if(performanceSha256(await fs.readFile(path.join(repositoryRoot,relative)))!==sha256)changedPaths.push(relative);
  result.sourceCohort={valid:source.sourceDigest===after.sourceDigest&&!changedPaths.length,after:after.sourceDigest,changedRunnerPaths:changedPaths};
  if(!result.sourceCohort.valid){result.status='failed';result.error??={code:'benchmark_source_cohort_changed',message:'Source changed during this retained diagnostic/cohort'};}
  await fs.writeFile(path.join(input.root,'result.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}

export function buildSummary(generation, launches, environmentEvidence, { diagnostic=false, comparisonArmID='baseline' }={}) {
  const arm=launches.filter(row=>row.generation===generation && (row.comparisonArmID ?? 'baseline')===comparisonArmID);
  assert.ok(arm.length);
  const versions=[...new Set(arm.map(row=>row.runtimeVersion))], artifacts=[...new Set(arm.map(row=>row.artifactSha256))], sources=[...new Set(arm.map(row=>row.source?.sourceDigest))];
  assert.equal(versions.length,1);assert.equal(artifacts.length,1);assert.equal(sources.length,1);
  assert.equal(new Set(arm.map(row=>row.pluginHash)).size,1,'Observed plugin closure changed across launches');
  for(const run of arm) assert.deepEqual(run.modelLimits, performanceModelLimits, 'Observed model limits differ from the declared benchmark');
  for(const run of arm){assert.equal(run.status,'completed');assert.equal(run.sourceCohort.valid,true);assert.ok(run.cleanup);assert.deepEqual(run.cleanup.cleanupFailures,[]);
    assert.deepEqual(run.resource?.failures,[],'Owned process resource observation was incomplete');assert.ok(run.sampleCount>0);}
  const intervals=[...new Set(arm.map(row=>row.eventReconcileIntervalMs ?? 750))];
  assert.equal(intervals.length,1,'Reconcile configuration changed across launches');
  const fingerprint={runtimeVersion:versions[0],role:{contentHash:digest(performanceRole)},
    catalog:{contentHash:digest(['glob','write'])},selection:{providerId:'devryan-smoke',modelId:'smoke-write',agent:'benchmark',variant:'default'},
    policies:{eventReconcileIntervalMs:intervals[0],fixture:'constructor-owned-isolated-local',formatter:false,history:'canonical-completed-turns',modelLimits:performanceModelLimits,compaction:'separate-qualification'},
    plugins:{observed:[{name:'execution-boundary',contentHash:arm[0].pluginHash}]}};
  for(const run of arm.filter(row=>row.scenario!=='idle'))for(const name of ['glob','write'])assert.ok(run.observedTools.includes(name),'Required actual native tool catalogue missing');
  const executionEvidence={kind:'native-runtime',generation,artifactSha256:artifacts[0],sourceSha256:sources[0],
    observationsSha256:digest(arm.map(row=>({observations:row.observations,receipts:row.completedOperationReceiptsSha256,cleanup:row.cleanup}))),runtimeFingerprintSha256:digest(fingerprint)};
  const scenarioRows={};
  for(const name of new Set(arm.map(row=>row.scenario))){
    const runs=arm.filter(row=>row.scenario===name), metrics=Object.keys(runs[0].metrics);
    scenarioRows[name]={kind:name==='idle'?'idle-observation':'completed-operations',processConditions:{kind:'owned-process-tree',
      scope:'host-collector-plus-retained-descendants',provider:'isolated-loopback-http',ui:'none'},runs,
      startup:{totalRuns:runs.length,successfulRuns:runs.length,medianRuntimeReadyMs:quantile(runs.map(row=>row.startupMs),.5)},
      aggregate:Object.fromEntries(metrics.flatMap(key=>{
        const values=runs.map(row=>row.metrics[key]).filter(Number.isFinite);
        return values.length===runs.length?[[`median_${key}`,quantile(values,.5)],[`min_${key}`,Math.min(...values)],[`max_${key}`,Math.max(...values)]]:[];
      }))};
  }
  const missingScenarios=scenarios.filter(name=>!Object.hasOwn(scenarioRows,name));
  return {fixtureGeneration:generation,measurementKind:'native-process-tree',diagnostic:diagnostic||missingScenarios.length>0,missingScenarios,scope:benchmarkProtocol.metricsLimitations,
    semanticFixtureSha256:digest({role:performanceRole,protocol:benchmarkProtocol}),upgradeProtocolSha256:digest(benchmarkProtocol),
    environmentEvidence,environmentSha256:digest(environmentEvidence),executionEvidence,executionSha256:digest(executionEvidence),
    comparisonArm:{id:comparisonArmID,configurationSha256:digest(fingerprint)},runtimeFingerprint:fingerprint,startupMode:'fresh-owned-runtime',runsPerScenario:diagnostic?1:3,warmupMs:benchmarkProtocol.warmupMs,
    measureMs:benchmarkProtocol.idleMs,sampleIntervalMs:benchmarkProtocol.sampleIntervalMs,scenarios:scenarioRows};
}

export function benchmarkArmSchedule({artifactRoot,comparisonArmID='baseline',comparisonArms,diagnostic=false}={}) {
  const arms = comparisonArms ?? [{id:comparisonArmID,artifactRoot}];
  assert.ok(Array.isArray(arms) && [1,2].includes(arms.length),'One calibration arm or two comparison arms required');
  assert.equal(new Set(arms.map(row=>row.id)).size,arms.length,'Distinct arm IDs required');
  for (const arm of arms) {
    assert.ok(arm && Object.keys(arm).every(key=>['id','artifactRoot','eventReconcileIntervalMs'].includes(key)));
    assert.match(arm.id,/^[a-zA-Z0-9_-]{1,64}$/); assert.ok(typeof arm.artifactRoot==='string' && arm.artifactRoot);
    assert.ok(arm.eventReconcileIntervalMs===undefined || Number.isSafeInteger(arm.eventReconcileIntervalMs) && arm.eventReconcileIntervalMs>=0);
  }
  const order = arms.length===2 ? [[arms[0],arms[1]],[arms[1],arms[0]],[arms[0],arms[1]]]
    : [[arms[0]],[arms[0]],[arms[0]]];
  return {arms,order:diagnostic ? [order[0]] : order};
}

export async function runPairedBenchmark({artifactRoot,outputRoot,diagnostic=false,generations=[2], selectedScenarios=scenarios,comparisonArmID='baseline',comparisonArms}={}) {
  assert.ok(selectedScenarios.length&&selectedScenarios.every(name=>scenarios.includes(name)));
  assert.equal(new Set(selectedScenarios).size,selectedScenarios.length,'Duplicate benchmark scenarios');
  assert.ok(diagnostic||selectedScenarios.length===scenarios.length,'Subset scenarios require explicit --diagnostic; Stage E requires all seven scenarios');
  assert.deepEqual(generations, [2], 'Only the native v2 benchmark is runnable');
  const schedule=benchmarkArmSchedule({artifactRoot,comparisonArmID,comparisonArms,diagnostic});
  assert.ok(typeof outputRoot==='string' && path.resolve(outputRoot).startsWith(repositoryRoot+path.sep),'Explicit repository output root required');
  await fs.mkdir(outputRoot,{recursive:true});outputRoot=await fs.realpath(outputRoot);
  assert.ok(outputRoot.startsWith(repositoryRoot+path.sep));
  const source=await captureBenchmarkSource(), launches=[];
  const env={platform:process.platform,arch:process.arch,osRelease:os.release(),node:process.version,cpu:os.cpus()[0]?.model??'unavailable',
    logicalCpus:os.cpus().length,memoryBytes:os.totalmem(),sampleClock:'monotonic',ui:'none'};
  const order=schedule.order;
  for(const [pairIndex,pair] of order.entries())for(const scenario of selectedScenarios)for(const arm of pair){
    const generation=2;
    let armProcess;
    const armRun=createRunRoot({parent:outputRoot,prefix:`${pairIndex+1}-${scenario}-${arm.id}-`,owner:'scripts/perf/native-upgrade-benchmark.mjs',
      extraPayloads:['bundles'],onInterrupt:async()=>{await armProcess?.stop().catch(()=>{});}});
    const root=armRun.dir;
    const input={root,generation,scenario,artifactRoot:arm.artifactRoot,comparisonArmID:arm.id,eventReconcileIntervalMs:arm.eventReconcileIntervalMs,operations:diagnostic?2:benchmarkProtocol.operations,
      idleMs:diagnostic?500:benchmarkProtocol.idleMs,warmupMs:diagnostic?0:benchmarkProtocol.warmupMs};
    const requestPath=path.join(root,'request.json');await fs.writeFile(requestPath,JSON.stringify(input)+'\n');
    const child=startOwnedProcess(process.execPath,[file,'--arm',requestPath],{cwd:repositoryRoot,
      env:createQaHostLaunchEnvironment({TMPDIR:root,GIT_CEILING_DIRECTORIES:repositoryRoot})});armProcess=child;
    let run,cleanup;
    try {
      const exit=await new Promise((resolve,reject)=>{child.child.once('exit',(code,signal)=>resolve({code,signal}));child.child.once('error',reject);});
      run=JSON.parse(await fs.readFile(path.join(root,'result.json'),'utf8'));
      run.armExit=exit;
    }finally{
      await fs.writeFile(path.join(root,'arm.log'),child.getLog());cleanup=await child.stop();
    }
    const armPassed=run?.status==='completed'&&run.armExit.code===0&&!run.armExit.signal;
    armRun.finish(armPassed&&!cleanup.remainingProcessIds.length?'passed':'failed');
    assert.deepEqual(cleanup.remainingProcessIds,[]);if(run?.status!=='completed'||run.armExit.code!==0||run.armExit.signal){
      const failure={status:'failed',diagnostic,launches:[...launches,run],failedRoot:root,armCleanup:cleanup};
      await fs.writeFile(path.join(outputRoot,'result.json'),JSON.stringify(failure,null,2)+'\n');
      throw Object.assign(new Error(JSON.stringify(run?.error??run?.cleanupError??run?.armExit)),{code:'benchmark_retained_arm_failed'});
    }
    launches.push({...run,armCleanup:cleanup});await fs.writeFile(path.join(outputRoot,'launches.json'),JSON.stringify(launches,null,2)+'\n');
  }
  const after=await captureBenchmarkSource();assert.equal(source.sourceDigest,after.sourceDigest,'Source changed during v2 cohort');
  const summaries=schedule.arms.map(arm=>buildSummary(2,launches,env,{diagnostic,comparisonArmID:arm.id}));
  for(const summary of summaries)await fs.writeFile(path.join(outputRoot,`arm-${summary.comparisonArm.id}.json`),JSON.stringify(summary,null,2)+'\n');
  const result={status:diagnostic?'diagnostic':'measured',sourceDigest:source.sourceDigest,summaries:summaries.map(row=>`arm-${row.comparisonArm.id}.json`),
    comparison:{status:'not-compared',reason:'Fresh v2 measurements require a reviewed v2 regression baseline; archived v1 evidence is historical only'}};
  await fs.writeFile(path.join(outputRoot,'result.json'),JSON.stringify(result,null,2)+'\n');return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===file){
  const args=process.argv.slice(2);
  if(args[0]==='--arm'){
    assert.equal(args.length,2);const input=JSON.parse(await fs.readFile(args[1],'utf8'));
    const result=await runArm(input);process.exitCode=result.status==='completed'?0:1;
  } else if(args.length===1&&args[0]==='--plan'){
    console.log(JSON.stringify({status:'prepared',protocol:benchmarkProtocol,required:['frozen compiled v2 artifact directory','owned repository output root'],
      fullCommand:'node scripts/perf/native-upgrade-benchmark.mjs --artifact-root <verified-directory> --output-root <repo-directory>',
      scope:'Actual headless native process/HTTP+SSE collector; no UI or paid-provider claim'},null,2));
  } else {
    const options={};for(let index=0;index<args.length;index++){
      if(args[index]==='--diagnostic')options.diagnostic=true;
      else if(args[index]==='--artifact-root')options.artifactRoot=path.resolve(args[++index]);
      else if(args[index]==='--output-root')options.outputRoot=path.resolve(args[++index]);
      else if(args[index]==='--arm-id')options.comparisonArmID=args[++index];
      else if(args[index]==='--comparison-arms'){
        const input=await fs.realpath(path.resolve(args[++index]));assert.ok(input.startsWith(repositoryRoot+path.sep),'Comparison input must remain repository-owned');
        const bytes=await fs.readFile(input);assert.ok(bytes.length<=16384,'Comparison input bound exceeded');options.comparisonArms=JSON.parse(bytes.toString('utf8'));
      }
      else if(args[index]==='--generation')options.generations=[Number(args[++index])];
      else if(args[index]==='--scenarios')options.selectedScenarios=args[++index].split(',');
      else throw new Error(`Unknown argument ${args[index]}`);
    }
    assert.ok(options.outputRoot,'Explicit repository output root required');
    assert.ok(options.artifactRoot || options.comparisonArms,'Explicit accepted v2 artifact root required');
    const result=await runPairedBenchmark(options);console.log(JSON.stringify(result,null,2));
  }
}
