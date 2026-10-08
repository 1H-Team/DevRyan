import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { managedTaskTurn, assertWriterOutcome } from './assertions.mjs';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';
import { createProcessSampler } from '../perf/native-upgrade-benchmark.mjs';
import { repositoryRoot } from './artifacts.mjs';
import {createRunRoot} from '../qa/run-root.mjs';

// Prospective diagnostic policy. This never changes the production 750ms default
// and does not replace the separate 21 calibration + 42 paired workload launches.
export const managedIntervalPolicy = Object.freeze({ schema: 1,
  order: Object.freeze([750, 1500, 1500, 750, 750, 1500]), quietHoldMs: 4500,
  armTimeoutMs: 60_000, maximumQuietReadRatio: 0.75, maximumLatencyGrowthMs: 100,
  maximumResourceGrowthRatio: 1.1, cpuAllowanceMs: 20, rssAllowanceMiB: 8,
  operationAllowance: 1, maxStreamBytes: 16 * 1024 * 1024, maxEvents: 8000 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = rows => [...rows].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
const count = value => Number.isSafeInteger(value) && value >= 0;
const metrics = [['hostCpuMs', 20], ['sampledDescendantCpuMs', 20],
  ['peakHostRssMiB', 8], ['peakDescendantRssMiB', 8]];
const hasResourceIdentity = arm => {
  const resource = arm.resources, coverage = resource?.receiptProcessIdentities;
  const identity = coverage?.identities?.[0];
  return Array.isArray(resource?.samples) && resource.samples.length > 0
    && Array.isArray(resource.failures) && resource.failures.length === 0
    && Array.isArray(resource.exitedBeforeSample) && resource.exitedBeforeSample.every(process => Number.isSafeInteger(process?.pid)
      && process.pid > 0 && typeof process.startIdentity === 'string' && process.startIdentity.length > 0)
    && coverage?.status === 'observed' && coverage.required === 1 && coverage.observed === 1
    && coverage.identities?.length === 1 && typeof arm.proof?.receiptToken === 'string' && arm.proof.receiptToken.length > 0
    && identity?.receiptToken === arm.proof.receiptToken && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && typeof identity.startIdentity === 'string' && identity.startIdentity.length > 0
    && resource.samples.some(sample => sample.processes?.some(process => process.pid === identity.pid && process.startIdentity === identity.startIdentity))
    && typeof resource.processOwnership?.rootIdentity === 'string' && resource.processOwnership.rootIdentity.length > 0
    && resource.processOwnership.observedProcesses?.length > 0
    && metrics.every(([key]) => Number.isFinite(resource.metrics?.[key]) && resource.metrics[key] >= 0);
};

/** Synthetic grading tests are policy checks, never evidence of native execution. */
export function gradeCompiledManagedInterval(arms) {
  const reasons = [];
  if (arms.length !== 6 || arms.some((arm, index) => arm.intervalMs !== managedIntervalPolicy.order[index])) reasons.push('paired_cohort_incomplete');
  if (arms.some(arm => arm.correctness !== 'passed' || arm.cleanup !== 'passed')) reasons.push('correctness_or_cleanup_unavailable');
  if (arms.some(arm => arm.timing?.status !== 'measured' || !Number.isFinite(arm.timing.waitSettlementMs)
    || arm.timing.waitSettlementMs < 0)) reasons.push('causal_timing_unavailable');
  if (arms.some(arm => !count(arm.quietReads?.active) || !count(arm.quietReads?.history)
    || !count(arm.httpOperations))) reasons.push('canonical_operation_counts_unavailable');
  if (arms.some(arm => !hasResourceIdentity(arm))) reasons.push('owned_resource_identity_unavailable');
  const identities = ['artifactSha256', 'sourceSha256', 'configurationSha256'];
  if (identities.some(key => arms.some(arm => !/^[a-f0-9]{64}$/.test(arm.identity?.[key] ?? '')
    || arm.identity[key] !== arms[0]?.identity?.[key]))) reasons.push('same_artifact_configuration_unavailable');
  const baseline = arms.filter(arm => arm.intervalMs === 750), candidate = arms.filter(arm => arm.intervalMs === 1500);
  const comparable = reasons.length === 0;
  const quietReads = comparable ? { baseline: median(baseline.map(arm => arm.quietReads.active + arm.quietReads.history)),
    candidate: median(candidate.map(arm => arm.quietReads.active + arm.quietReads.history)) } : null;
  const latency = comparable ? { baseline: median(baseline.map(arm => arm.timing.waitSettlementMs)),
    candidate: median(candidate.map(arm => arm.timing.waitSettlementMs)) } : null;
  const resources = comparable ? metrics.map(([key, allowance]) => {
    const a = median(baseline.map(arm => arm.resources.metrics[key])), b = median(candidate.map(arm => arm.resources.metrics[key]));
    return { metric: key, baseline: a, candidate: b, withinBand: b <= a * managedIntervalPolicy.maximumResourceGrowthRatio + allowance };
  }) : [];
  const operationsWithinBand = comparable && median(candidate.map(arm => arm.httpOperations))
    <= median(baseline.map(arm => arm.httpOperations)) * managedIntervalPolicy.maximumResourceGrowthRatio + managedIntervalPolicy.operationAllowance;
  const diagnosticCriteriaSatisfied = comparable && quietReads.baseline > 0
    && quietReads.candidate <= quietReads.baseline * managedIntervalPolicy.maximumQuietReadRatio
    && latency.candidate <= latency.baseline + managedIntervalPolicy.maximumLatencyGrowthMs
    && operationsWithinBand && resources.every(row => row.withinBand);
  return { status: comparable ? 'measured' : 'inconclusive', reasons: [...new Set(reasons)], quietReads, latency,
    resources, operationsWithinBand, diagnosticCriteriaSatisfied, productionRetentionQualified: false,
    limitations: ['Six children are attribution only; the complete seven-workload matrix remains required.',
      'Missed-event, deadline and cancellation correctness at both intervals require separate qualification.',
      'OS identities or short-lived writer sampling gaps make this diagnostic inconclusive.'] };
}

export function isCompiledIntervalParentCompletion(parsed, directory, rootID, replyIssued) {
  const event = parsed.envelope;
  return parsed.kind === 'event' && replyIssued === true && typeof rootID === 'string' && rootID.length > 0
    && event.type === 'session.execution.succeeded' && event.data?.sessionID === rootID
    && (parsed.directory === directory || (parsed.directory === null && event.location?.directory === undefined));
}

/** One actual compiled arm, called only after the existing package catalog gate.
 * readCounts observes the existing client fetch; it must not perform extra reads. */
export async function runCompiledManagedIntervalArm({ caseID, intervalMs, client, managed, provider,
  executionHost, controller, directory, observations, getAuthHeaders, readCounts, writerProcessLauncher }) {
  assert.match(caseID, /^interval-[a-f0-9-]+$/);
  assert.ok([750, 1500].includes(intervalMs));
  const turn = managedTaskTurn(caseID, 'fixer'), abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(Error('compiled_interval_arm_timeout')), managedIntervalPolicy.armTimeoutMs);
  let rootID, parentReplyIssued = false, releaseWait, releaseParent, streamFailure, sampler, resources;
  const waitRegistered = new Promise(resolve => { releaseWait = resolve; });
  const parentCompleted = new Promise(resolve => { releaseParent = resolve; });
  const records = [], handles = new Map(); let bytes = 0, eventCount = 0, forwardedHints = 0, quietReads;
  const writerStartListeners = new Set();
  let writerStartObserverFailed = false;
  const subscribeWriterStarts = listener => {
    assert.equal(typeof listener, 'function');
    writerStartListeners.add(listener);
    return () => writerStartListeners.delete(listener);
  };
  const originalExecution = executionHost.nativeExecution;
  executionHost.nativeExecution = async (input, context) => {
    const result = await originalExecution(input, context);
    if (input.action === 'start' && input.callID === turn.callIDs.writerID && typeof result.handle === 'string') {
      handles.set(result.handle, { sessionID: input.sessionID, callID: input.callID, pids: new Set() });
    }
    if (input.action === 'read') for (const event of result.events ?? []) {
      const scope = handles.get(input.handle);
      if (scope && event.type === 'started' && Number.isSafeInteger(event.pid) && !scope.pids.has(event.pid)) {
        scope.pids.add(event.pid);
        for (const listener of writerStartListeners) {
          try { listener(event.pid); } catch { writerStartObserverFailed = true; }
        }
      }
    }
    return result;
  };
  const before = readCounts();
  let reader, pump, lease;
  try {
    const response = await fetch(client.events.url(), { headers: await getAuthHeaders(), signal: abort.signal });
    assert.ok(response.ok && response.body, 'Compiled interval native SSE unavailable');
    reader = response.body.getReader();
    const projector = client.events.createProjector();
    pump = (async () => {
      const decoder = new TextDecoder(); let pending = '';
      try {
        while (!abort.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) throw Error('compiled_interval_native_sse_ended');
          bytes += chunk.value.byteLength; assert.ok(bytes <= managedIntervalPolicy.maxStreamBytes);
          pending = (pending + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, end); pending = pending.slice(end + 2);
            const parsed = client.events.parseBlock(block); if (parsed?.kind !== 'event') continue;
            const event = parsed.envelope;
            // Native execution terminals omit location; only this arm's exact
            // parent may settle its wait without a directory.
            if (isCompiledIntervalParentCompletion(parsed, directory, rootID, parentReplyIssued)) releaseParent();
            if (parsed.directory !== directory && event.location?.directory !== directory) continue;
            assert.ok(++eventCount <= managedIntervalPolicy.maxEvents);
            const data = event.data, at = performance.now();
            if (['session.step.ended', 'session.tool.called', 'session.tool.success'].includes(event.type)) {
              records.push({ type: event.type, eventID: event.id, sequence: event.seq ?? event.sequence ?? null,
                sessionID: data?.sessionID, assistantMessageID: data?.assistantMessageID, callID: data?.id, at });
            }
            if (event.type === 'session.tool.called' && data?.sessionID === rootID && data.id === turn.callIDs.waitID) releaseWait();
            for (const projected of projector.project(event)) {
              managed.getManagedRuntime().processOpenCodeEvent(projected.payload, projected.directory); forwardedHints++;
            }
          }
        }
      } catch (error) { if (!abort.signal.aborted) { streamFailure = error; abort.abort(error); } }
    })();
    sampler = await createProcessSampler(controller.pid, undefined, { writerProcessLauncher, subscribeWriterStarts });
    await provider.setResponder(async (request, signal) => {
      const reply = turn.responder(request);
      const signalOwner = AbortSignal.any([abort.signal, signal]);
      if (request.body.messages.some(message => message.role === 'tool' && message.tool_call_id === turn.callIDs.writerID)) {
        const registrationWait = new AbortController();
        try { await Promise.race([waitRegistered, delay(managedIntervalPolicy.armTimeoutMs, undefined,
          { signal: AbortSignal.any([signalOwner, registrationWait.signal]) }).then(() => { throw Error('compiled_interval_wait_unregistered'); })]); }
        finally { registrationWait.abort(); }
        signalOwner.throwIfAborted();
        const start = readCounts();
        await delay(managedIntervalPolicy.quietHoldMs, undefined, { signal: signalOwner });
        const end = readCounts();
        quietReads = { active: end.active - start.active, history: end.history - start.history };
      }
      if (request.body.messages.some(message => message.role === 'tool' && message.tool_call_id === turn.callIDs.waitID)) parentReplyIssued = true;
      return reply;
    });
    const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
    const root = await client.sessions.create({ title: 'Compiled managed interval attribution', agent: 'orchestrator', model }, { directory });
    rootID = root.id; await managed.admitPrimary(rootID);
    const messageID = createV2MessageId();
    await client.prompts.prompt(rootID, { messageID, agent: 'orchestrator', model, variant: 'default',
      parts: [{ type: 'text', text: turn.marker }] }, { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
    const completionWait = new AbortController();
    try { await Promise.race([parentCompleted, delay(managedIntervalPolicy.armTimeoutMs, undefined,
      { signal: AbortSignal.any([abort.signal, completionWait.signal]) }).then(() => { throw Error('compiled_interval_parent_unsettled'); })]); }
    finally { completionWait.abort(); }
    if (streamFailure) throw streamFailure;
    const proof = turn.complete();
    const snapshot = await managed.getManagedRuntime().getSnapshot({ rootSessionId: rootID });
    assert.equal(snapshot.tasks.length, 1);
    const task = snapshot.tasks[0]; assert.equal(task.taskId, proof.taskID); assert.equal(task.status, 'completed');
    assert.deepEqual([task.providerId, task.modelId, task.variant ?? 'default', task.agent], ['devryan-smoke', 'smoke-write', 'default', 'fixer']);
    assert.equal((await client.sessions.get(task.childSessionId, { directory })).parentID, rootID);
    const [parent, child] = await Promise.all([client.sessions.messages(rootID, {}, { directory }),
      client.sessions.messages(task.childSessionId, {}, { directory })]);
    assert.equal(parent.records.filter(row => row.info.role === 'user').length, 1);
    assert.ok(parent.records.some(row => row.info.role === 'assistant' && row.info.time?.completed
      && row.parts.some(part => part.type === 'text' && part.text === `completed ${caseID}`)), 'Actual interval parent final response missing');
    assert.equal((await managed.readPrimaryRecord(rootID)).anchorID, messageID);
    const final = child.records.findLast(row => row.info.role === 'assistant' && row.info.time?.completed
      && row.parts.some(part => part.type === 'text' && part.text === `managed child completed ${caseID}`));
    assert.ok(final, 'Actual interval child final assistant missing');
    for (const callID of [turn.callIDs.startID, turn.callIDs.waitID]) {
      const calls = parent.records.flatMap(row => row.parts).filter(part => part.type === 'tool' && part.callID === callID);
      assert.equal(calls.length, 1); assert.equal(calls[0].state.status, 'completed');
    }
    assert.ok(observations.some(row => row.phase === 'managed_event' && row.properties?.task?.taskId === task.taskId
      && row.properties.task.status === 'completed'), 'Actual durable managed completion publication missing');
    await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID: task.childSessionId,
      callID: proof.childWriterCallID, observations, succeeded: true });
    assert.equal(await fs.readFile(path.join(directory, proof.childWriterFile), 'utf8'), `managed writer ${caseID}\n`);
    lease = await executionHost.runtime.leaseForCall({ directory, sessionID: task.childSessionId, callID: proof.childWriterCallID });
    const receipt = await readSessionExecutionReceipt(lease); assert.equal(receipt.terminated, true); assert.equal(receipt.confined, true);
    const descriptors = [...handles.values()].filter(row => row.sessionID === task.childSessionId)
      .flatMap(row => [...row.pids].map(pid => ({ pid, receiptToken: lease.token, launcher: writerProcessLauncher,
        viewDirectory: lease.viewDirectory, receiptPath: path.join(path.dirname(lease.viewDirectory), 'termination.json') })));
    resources = await sampler.stop({ receiptTokens: [lease.token], descriptors }); sampler = undefined;
    if (writerStartObserverFailed) throw Object.assign(new Error('writer_start_observer_failed'), { code: 'writer_start_observer_failed' });
    const terminal = records.find(row => row.type === 'session.step.ended' && row.sessionID === task.childSessionId && row.assistantMessageID === final.info.id);
    const wait = records.find(row => row.type === 'session.tool.called' && row.sessionID === rootID && row.callID === turn.callIDs.waitID);
    const settled = records.find(row => row.type === 'session.tool.success' && row.sessionID === rootID && row.callID === turn.callIDs.waitID);
    const causal = terminal && wait && settled && wait.at <= terminal.at && settled.at >= terminal.at;
    const after = readCounts();
    return { caseID, intervalMs, correctness: 'passed', proof: { rootSessionID: rootID, childSessionID: task.childSessionId,
      taskID: task.taskId, childFinalAssistantID: final.info.id, childWriterCallID: proof.childWriterCallID,
      operationID: lease.result.operationID, receiptToken: lease.token }, quietReads, httpOperations: after.total - before.total,
      timing: causal ? { status: 'measured', waitSettlementMs: settled.at - terminal.at, terminal, wait, settled }
        : { status: 'inconclusive', reason: 'exact_terminal_wait_order_unavailable' },
      resources, stream: { bytes, eventCount, forwardedHints } };
  } finally {
    clearTimeout(timeout); abort.abort();
    executionHost.nativeExecution = originalExecution;
    await reader?.cancel().catch(() => {}); await pump; reader?.releaseLock();
    if (sampler) await sampler.stop();
  }
}

/** The existing package verifier constructs and closes every real private arm. */
export async function runCompiledManagedIntervalDiagnostic({ artifactRoot, onArm = () => {} }) {
  const run = createRunRoot({ parent: path.join(repositoryRoot, '.cache/v2-validation'), prefix: 'managed-interval-', owner: 'scripts/opencode-v2-native/package-managed-interval-lane.mjs' });
  const root = await fs.realpath(run.dir);
  const policyFile = path.join(root, 'policy.json');
  const prospective = { policy: managedIntervalPolicy, policySha256: hash(managedIntervalPolicy),
    configurationDelta: { path: ['policies', 'eventReconcileIntervalMs'], baseline: 750, candidate: 1500 },
    helperSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
    verifierSha256: createHash('sha256').update(await fs.readFile(path.join(repositoryRoot, 'scripts/verify-opencode-v2-package.mjs'))).digest('hex') };
  await fs.writeFile(policyFile, JSON.stringify(prospective, null, 2) + '\n', { flag: 'wx' });
  const { runNativePackageAcceptance } = await import('../verify-opencode-v2-package.mjs');
  const arms = [], prefix = randomUUID();
  for (const [index, intervalMs] of managedIntervalPolicy.order.entries()) {
    const result = await runNativePackageAcceptance({ artifactRoot, diagnostic: true,
      managedInterval: { intervalMs, caseID: `interval-${prefix}-${index}` } });
    const arm = { ...result.managedInterval, intervalMs, packageResult: path.join(result.root, 'result.json'),
      cleanup: result.status === 'interval-diagnostic-passed' && result.sourceCohort.valid && !result.cleanupFailures.length ? 'passed' : 'failed' };
    arms.push(arm); await onArm(arm);
    if (arm.cleanup !== 'passed') break;
  }
  const graded = gradeCompiledManagedInterval(arms);
  run.finish(arms.length && arms.every(arm => arm.cleanup === 'passed') ? 'passed' : 'failed');
  return { root, policyFile, policy: managedIntervalPolicy, policySha256: hash(managedIntervalPolicy), arms, ...graded };
}

async function main() {
  const { values } = parseArgs({ options: { 'artifact-root': { type: 'string' } } });
  assert.ok(values['artifact-root'], 'Usage: node scripts/opencode-v2-native/package-managed-interval-lane.mjs --artifact-root <verified-repository-artifact>');
  const result = await runCompiledManagedIntervalDiagnostic({ artifactRoot: path.resolve(values['artifact-root']) });
  const output = path.join(result.root, 'result.json'); await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: result.status, diagnosticCriteriaSatisfied: result.diagnosticCriteriaSatisfied, result: output }) + '\n');
  if (!result.diagnosticCriteriaSatisfied) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[managed-interval] diagnostic failed (${error?.code || 'unknown'})`);
    process.exitCode = 1;
  });
}
