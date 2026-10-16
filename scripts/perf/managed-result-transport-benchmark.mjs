import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createManagedTaskRecord, createManagedTaskResultEnvelope } from '../../packages/orchestration-runtime/index.js';
import { createAtomicManagedOrchestrationLedger } from '../../packages/web/server/lib/orchestration/atomic-ledger.js';
import { createWebManagedOrchestrationRuntime } from '../../packages/web/server/lib/orchestration/runtime.js';
import { createNativeManagedTaskOwner } from '../../packages/web/server/lib/opencode/runtime-host/managed-task-owner.js';
import { createNativeManagedPublicationReader, readManagedPublicationMessages } from '../../packages/web/server/lib/opencode/runtime-host/native-managed-publication-owner.js';

const script = fileURLToPath(import.meta.url), repository = path.resolve(path.dirname(script), '../..');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sourceFiles = ['packages/orchestration-runtime/scheduler.js', 'packages/web/server/lib/orchestration/runtime.js',
  'packages/web/server/lib/opencode/runtime-host/managed-task-owner.js', 'packages/web/server/lib/opencode/runtime-host/native-managed-results.js',
  'packages/web/server/lib/opencode/runtime-host/native-managed-publication-owner.js', 'scripts/opencode-v2-native/native-result-publication.graph.test.ts',
  'packages/orchestration-runtime/managed-result-projection.js', 'packages/orchestration-runtime/managed-result-sections.js',
  'packages/orchestration-runtime/result-envelope.js', 'packages/orchestration-runtime/tool-output-limits.js',
  'packages/web/server/lib/orchestration/atomic-ledger.js', 'packages/harness-runtime/lib/atomic-file.js',
  'scripts/perf/managed-result-transport-benchmark.mjs'];
const captureSource = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha256(await fs.readFile(path.join(repository, file)))])));
const scope = { rootSessionId: 'ses_benchmark', directory: '/fixture-project' };
export const managedResultTransportWorkload = Object.freeze({ tasks: 2, reportBytes: 35 * 1024, canonicalReferencesPerTask: 128, outputCapBytes: 48 * 1024 });

async function measure(version, directory) {
  const reports = [1, 2].map(index => (`# Result ${index}\n` + 'Verified retained report content.\n'.repeat(1200)).slice(0, managedResultTransportWorkload.reportBytes));
  const tasks = reports.map((report, index) => ({ ...createManagedTaskRecord({ ...scope,
    taskId: `dvr_task_benchmark_${index}`, idempotencyKey: `retained-${index}`, parentTaskId: null, childSessionId: `ses_child_${index}`,
    sequence: index + 1, mode: 'orchestrator', dispatchGroupId: 'msg_dispatch', providerId: 'fixture', modelId: 'fixture', agent: 'explorer', variant: null,
    label: `Result ${index}`, prompt: 'Inspect retained result', attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1, timeoutAt: null }),
    status: 'completed', startedAt: 2, finishedAt: 3, recoverablePreview: report,
    canonicalRefs: Array.from({ length: managedResultTransportWorkload.canonicalReferencesPerTask }, (_, item) => ({ type: 'message', id: `msg_child_${index}_${item}` })) }));
  for (const task of tasks) assert.equal(Buffer.byteLength(task.recoverablePreview), managedResultTransportWorkload.reportBytes);
  const ledger = createAtomicManagedOrchestrationLedger({ dataDirectory: directory, heartbeatIntervalMs: 0 });
  await ledger.acquireOwnership();
  await ledger.save({ version: 1, tasks, resultEnvelopes: tasks.map(task => createManagedTaskResultEnvelope(task, { sequence: task.sequence, createdAt: 4 })) });
  let commits = 0;
  const mutationTimings=[];
  const runtime = createWebManagedOrchestrationRuntime({ persistence: { ...ledger, save: async (...args) => { await ledger.save(...args); commits++; } },
    executor: { start: async () => { throw Error('Retained results must not launch children'); } }, now: () => 100,
    harnessPolicies: { waitAny: true, compactResults: false },onMutationTiming:row=>mutationTimings.push(row) });
  await runtime.initialize(); commits = 0;mutationTimings.length=0;
  const messages = [], counts = {}, calls = [], reconstructed = new Map(tasks.map(task => [task.taskId, { report: '', metadata: '', next: null, reportNext: null, inline: null }]));
  let stepNumber = 0, callNumber = 0, primary;
  const step = () => {
    primary = { directory: scope.directory, stepID: `msg_step_${++stepNumber}`, anchorID: 'msg_objective', objectiveID: 'msg_objective',
      cancellationGeneration: 0, revision: stepNumber, nativeStepWitness: { attempt: { traceID: 'b'.repeat(32), spanID: stepNumber.toString(16).padStart(16, '0') } } };
    messages.push({ info: { id: primary.stepID, sessionID: scope.rootSessionId, role: 'assistant' }, parts: [] });
  };
  const admissionOwner = { recheckExecution: async input => { assert.equal(input.messageID, primary.stepID); },
    withPermit: async (_input, action) => action(), withManagedResultRead: async (_input, action) => action(), withManagedTaskCatalogInvocation: async (_input, action) => action() };
  let publicationReads=0,historyPages=0,historyBytes=0,historyReadMs=0,primaryReads=0;
  const publication = createNativeManagedPublicationReader({ readConfiguration: () => ({ controllerInstanceID: 'fixture-controller', configurationDigest: 'a'.repeat(64) }),
    recheckExecution: admissionOwner.recheckExecution, readPrimaryRecord: async () => {primaryReads++;return structuredClone(primary);},
    readMessages:async(input,messageIDs)=>{
      publicationReads++;const started=performance.now();
      try{return await readManagedPublicationMessages(async()=>{
        historyPages++;const records=structuredClone(messages);historyBytes+=bytes(records);return {records};
      },input,messageIDs);}finally{historyReadMs+=performance.now()-started;}
    } });
  const owner = createNativeManagedTaskOwner({ admissionOwner, taskContext: { authorizeNativeTaskInvocation: async () => ({ readOnly: false }) },
    ...(version === 2 ? { readResultPublication: publication } : {}), getManagedRuntime: () => ({ handleRpc: async (...args) => {
      counts[args[0].method] = (counts[args[0].method] ?? 0) + 1; return runtime.handleRpc(...args);
    } }) });
  const invoke = async input => {
    step();
    const callID = `call_${++callNumber}`, part = { type: 'tool', tool: 'devryan_task', callID, state: { status: 'running', input } };
    messages.at(-1).parts.push(part);
    const result = await owner({ tool: 'devryan_task', sessionID: scope.rootSessionId, directory: scope.directory, messageID: primary.stepID, callID, input,
      permit: { token: 'fixture-private-permit' }, nativeAttempt: primary.nativeStepWitness.attempt,
      authorization: { input: { provenance: { kind: 'plugin', id: 'devryan.managed-task' } } } });
    assert.ok(bytes(result) <= managedResultTransportWorkload.outputCapBytes, 'Model output exceeded reviewed cap');
    part.state = { status: 'completed', input, output: JSON.stringify(result) };
    calls.push({ action: input.action, inputBytes: bytes(input), outputBytes: bytes(result) });
    return result;
  };
  const accept = (taskID, result, initial = false) => {
    const state = reconstructed.get(taskID); assert.ok(state);
    if (initial) state.inline = result;
    if (result.metadataReference) {
      state.metadata += result.metadataReference.text;
      state.next = result.metadataReference.nextCursor;
      if (initial) state.reportNext = result.resultReference?.nextCursor ?? null;
      if (!state.next) state.next = state.reportNext;
    } else if (result.resultReference) {
      state.report += result.resultReference.text;
      state.reportNext = result.resultReference.nextCursor; state.next = state.reportNext;
    } else if (initial) state.report = result.resultEnvelope.recoverablePreview;
  };
  const start = performance.now(), cpu = process.cpuUsage(), startRssBytes = process.memoryUsage().rss;
  let sampledPeakRssBytes = startRssBytes;
  const sampler = setInterval(() => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); }, 1);
  try {
    if (version === 1) {
      for (const task of tasks) {
        accept(task.taskId, await invoke({ action: 'wait', task_id: task.taskId }), true);
        const seen = new Set();
        while (reconstructed.get(task.taskId).next) {
          const cursor = reconstructed.get(task.taskId).next; assert.ok(!seen.has(cursor), 'Cursor did not advance'); seen.add(cursor);
          accept(task.taskId, await invoke({ action: 'read_result', task_id: task.taskId, result_cursor: cursor }));
        }
      }
      for (const task of tasks) await invoke({ action: 'continue', task_id: task.taskId });
    } else {
      const waited = await invoke({ action: 'wait_any', task_ids: tasks.map(task => task.taskId), until: 'settled' });
      assert.deepEqual(waited.notReturnedTaskIds ?? [], []);
      for (const row of waited.results) accept(row.task.taskId, row, true);
      const seen = new Set();
      while ([...reconstructed.values()].some(state => state.next)) {
        const reads = [...reconstructed].filter(([, state]) => state.next).map(([task_id, state]) => ({ task_id, result_cursor: state.next }));
        const identity = JSON.stringify(reads); assert.ok(!seen.has(identity), 'Batch cursors did not advance'); seen.add(identity);
        const page = await invoke({ action: 'read_result', reads });
        assert.deepEqual(page.failed, []); assert.deepEqual(page.notProcessed, []);
        for (const row of page.results) accept(row.taskId, row);
      }
      const continued = await invoke({ action: 'continue', task_ids: tasks.map(task => task.taskId) });
      assert.deepEqual(continued.failed, []); assert.deepEqual(continued.notProcessed, []);
      assert.deepEqual(continued.committed.map(row => row.taskId), tasks.map(task => task.taskId));
    }
    const latencyMs = performance.now() - start, used = process.cpuUsage(cpu);
    const retained = await ledger.load();
    for (const task of tasks) {
      const collected = reconstructed.get(task.taskId), projected = collected.metadata ? JSON.parse(collected.metadata) : collected.inline;
      assert.equal(sha256(collected.report), sha256(task.recoverablePreview), 'Report bytes were not fully collected');
      assert.deepEqual(projected.resultEnvelope.canonicalRefs ?? projected.task.canonicalRefs, task.canonicalRefs, 'Required canonical references disappeared');
      assert.equal(retained.tasks.find(row => row.taskId === task.taskId).recoverablePreview, task.recoverablePreview);
      assert.deepEqual(retained.tasks.find(row => row.taskId === task.taskId).canonicalRefs, task.canonicalRefs);
      assert.equal(retained.resultEnvelopes.find(row => row.taskId === task.taskId).action, 'continue');
    }
    assert.equal(commits, tasks.length, 'Every singular acknowledgement needs its own truthful durable commit');
    return { version, passed: true, latencyMs, cpuMs: (used.user + used.system) / 1000, startRssBytes,
      sampledPeakRssBytes: Math.max(sampledPeakRssBytes, process.memoryUsage().rss), endRssBytes: process.memoryUsage().rss,
      managedOwnerCalls: calls.length, logicalToolRoundTrips: calls.length, coreRpcCalls: Object.values(counts).reduce((sum, count) => sum + count, 0),
      coreRpcMethods: counts, ledgerCommits: commits, modelInputBytes: calls.reduce((sum, row) => sum + row.inputBytes, 0),
      publicationReads,historyPages,historyBytes,historyReadMs,primaryReads,
      schedulerQueueWaitMs:mutationTimings.reduce((sum,row)=>sum+row.waitMs,0),schedulerLockHoldMs:mutationTimings.reduce((sum,row)=>sum+row.holdMs,0),
      schedulerTransactions:mutationTimings.length,
      modelOutputBytes: calls.reduce((sum, row) => sum + row.outputBytes, 0), requiredReportBytes: reports.reduce((sum, report) => sum + Buffer.byteLength(report), 0),
      networkRoundTrips: 0, descendantSubprocessCount: null, actions: calls.map(row => row.action) };
  } finally { clearInterval(sampler); await runtime.shutdown(); await fs.rm(directory, { recursive: true, force: true }); }
}

export async function runManagedResultTransportBenchmark() {
  const parent = path.join(repository, '.cache/perf'); await fs.mkdir(parent, { recursive: true });
  assert.equal(await fs.realpath(parent), parent, 'Benchmark cache must be canonical');
  const evidence = await fs.mkdtemp(path.join(parent, 'managed-result-transport-')), samples = [];
  const sourceHashes=await captureSource(),sourceDigest=sha256(JSON.stringify(sourceHashes));
  for (let pair = 1; pair <= 5; pair++) for (const warm of [false, true]) for (const version of pair % 2 ? [1, 2] : [2, 1]) {
    const workerRoot = path.join(evidence, `pair-${pair}-${warm ? 'warm' : 'cold'}-v${version}`);
    const started = performance.now(), child = spawn(process.execPath, [script, '--worker', String(version), warm ? 'warm' : 'cold', workerRoot],
      { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw Error(`Owned result benchmark worker failed: ${stderr}`);
    const sample=JSON.parse(stdout);assert.equal(sample.sourceDigest,sourceDigest,'Benchmark worker source differs from admitted cohort');
    samples.push({ pair, warm, ...sample, workerLaunchCount: 1, workerElapsedMs: performance.now() - started });
  }
  const summary = Object.fromEntries([false, true].map(warm => [warm ? 'warm' : 'cold', Object.fromEntries([1, 2].map(version => {
    const rows = samples.filter(row => row.warm === warm && row.version === version);
    return [`v${version}`, Object.fromEntries(['modelOutputBytes', 'managedOwnerCalls', 'coreRpcCalls', 'ledgerCommits', 'latencyMs', 'cpuMs', 'sampledPeakRssBytes',
      'publicationReads','historyPages','historyBytes','historyReadMs','primaryReads','schedulerQueueWaitMs','schedulerLockHoldMs','schedulerTransactions']
      .map(field => [field, median(rows.map(row => row[field]))]))];
  }))]));
  assert.deepEqual(await captureSource(),sourceHashes,'Benchmark source changed during sampling');
  const result = { schemaVersion: 1, passed: true, workload: managedResultTransportWorkload, samples, summary,
    baseline: 'current scalar version1 compatibility owner; same source cohort and runtime dependency, not original QA model performance',
    scope: 'agents-only production managed owner/core/scheduler with real disposable atomic ledger; fixture-supplied completed canonical tool records',
    sourceHashes,sourceDigest,sourceStableDuringSampling:true,
    nativeQualification: { status: 'pending', owningLane: 'scripts/opencode-v2-native/native-result-publication.graph.test.ts' },
    limitations: ['model bytes are exact minified tool input/output; no tokenizer or provider usage estimate',
      'logical tool round trips are in-process calls; no network/provider latency is measured',
      'cold means fresh worker; warm means one untimed full run then a fresh retained ledger in that same worker',
      'RSS includes imports and warmup; 1ms sampling can miss brief peaks; descendant CPU/RSS/subprocesses are not measured',
      'history reads exercise the bounded production reader over cloned canonical fixtures; JSON/copy costs are included but HTTP/database page latency is not',
      'source hashing is outside the measured operation; every worker and the parent verify the admitted source cohort before and after sampling',
      'canonical completed output records are supplied by this core fixture; pinned native source/compiled publisher qualification is a separate gate'] };
  const output = path.join(evidence, 'result.json'); await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
  return { output, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--worker') {
    const version = Number(process.argv[3]), warm = process.argv[4] === 'warm', directory = process.argv[5];
    assert.equal(process.argv.length, 6, 'Owned result worker needs exact arguments');
    assert.ok(typeof directory === 'string' && path.isAbsolute(directory) && path.normalize(directory) === directory);
    const evidence = path.dirname(directory);
    assert.equal(path.dirname(evidence), path.join(repository, '.cache/perf'));
    assert.match(path.basename(evidence), /^managed-result-transport-[A-Za-z0-9]+$/);
    assert.equal(await fs.realpath(evidence), evidence);
    assert.ok([1, 2].includes(version) && ['cold', 'warm'].includes(process.argv[4]));
    const sourceHashes=await captureSource();
    if (warm) await measure(version, `${directory}-warmup`);
    const sample=await measure(version,directory);
    assert.deepEqual(await captureSource(),sourceHashes,'Benchmark worker source changed during sampling');
    console.log(JSON.stringify({...sample,sourceDigest:sha256(JSON.stringify(sourceHashes))}));
  } else {
    assert.equal(process.argv.length, 2, 'Result transport benchmark takes no arguments');
    const { output, result } = await runManagedResultTransportBenchmark(); console.log(JSON.stringify({ passed: result.passed, output, samples: result.samples.length, summary: result.summary }));
  }
}
