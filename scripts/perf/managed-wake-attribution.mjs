import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Declared before measurement: 100ms is a meaningful fraction of the existing
// 750ms reconciliation bound. Six children are attribution, not the separate
// 100-operations-per-scenario upgrade qualification.
export const managedWakeProtocol = Object.freeze({ schema: 1, order: ['disabled', 'enabled', 'enabled', 'disabled', 'disabled', 'enabled'],
  reconciliationBoundMs: 750, minimumMedianReductionMs: 100, maxResourceGrowthRatio: 1.1,
  cpuAllowanceMs: 20, rssAllowanceMiB: 8, operationAllowance: 1, maxStreamBytes: 16 * 1024 * 1024, maxEvents: 8000 });
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };

/** Pure grading only. Synthetic tests of this function are not runtime proof. */
export function gradeManagedWakeAttribution(arms) {
  const enabled = arms.filter(row => row.mode === 'enabled'), disabled = arms.filter(row => row.mode === 'disabled');
  const resourceMetrics = [['hostCpuMs', managedWakeProtocol.cpuAllowanceMs], ['sampledDescendantCpuMs', managedWakeProtocol.cpuAllowanceMs],
    ['peakHostRssMiB', managedWakeProtocol.rssAllowanceMiB], ['peakDescendantRssMiB', managedWakeProtocol.rssAllowanceMiB]];
  const reasons = [];
  if (arms.length !== 6 || enabled.length !== 3 || disabled.length !== 3) reasons.push('paired_cohort_incomplete');
  if (arms.some(row => row.timing?.status !== 'measured')) reasons.push('causal_timing_unavailable');
  if (arms.some(row => !row.resources || !Array.isArray(row.resources.failures) || row.resources.failures.length
    || !Array.isArray(row.resources.exitedBeforeSample)
    || row.resources.exitedBeforeSample.some(process => !Number.isSafeInteger(process?.pid) || process.pid <= 0
      || typeof process.startIdentity !== 'string' || !process.startIdentity)
    || resourceMetrics.some(([metric]) => !Number.isFinite(row.resources.metrics?.[metric]) || row.resources.metrics[metric] < 0))) reasons.push('owned_resource_evidence_unavailable');
  if (arms.some(row => !Number.isSafeInteger(row.operationCount) || row.operationCount < 0)) reasons.push('operation_count_unavailable');
  const reductionMs = enabled.length && disabled.length && !reasons.includes('causal_timing_unavailable')
    ? median(disabled.map(row => row.timing.waitSettlementMs)) - median(enabled.map(row => row.timing.waitSettlementMs)) : null;
  const resourceComparisons = [];
  if (!reasons.includes('owned_resource_evidence_unavailable')) {
    for (const [metric, allowance] of resourceMetrics) {
      const a = median(disabled.map(row => row.resources.metrics?.[metric])), b = median(enabled.map(row => row.resources.metrics?.[metric]));
      if (!Number.isFinite(a) || !Number.isFinite(b)) reasons.push('owned_resource_evidence_unavailable');
      else resourceComparisons.push({ metric, disabled: a, enabled: b, withinBand: b <= a * managedWakeProtocol.maxResourceGrowthRatio + allowance });
    }
  }
  const operationsWithinBand = !reasons.includes('operation_count_unavailable')
    && median(enabled.map(row => row.operationCount)) <= median(disabled.map(row => row.operationCount)) * managedWakeProtocol.maxResourceGrowthRatio + managedWakeProtocol.operationAllowance;
  const qualified = reasons.length === 0;
  return { status: qualified ? 'measured' : 'inconclusive', reasons: [...new Set(reasons)], reductionMs, resourceComparisons,
    operationsWithinBand, retentionSatisfied: qualified && reductionMs >= managedWakeProtocol.minimumMedianReductionMs
      && operationsWithinBand && resourceComparisons.every(row => row.withinBand),
    denominator: { completedChildren: arms.length, childrenPerArm: 1, pairs: 3 },
    timingScope: 'same-observer-native-child-Step.Ended-to-parent-wait-Tool.Success',
    limitations: ['No native terminal-to-task-commit clock: committed task correctness is checked separately.',
      'OS sampling misses short-lived descendants; this does not qualify the full upgrade matrix.'] };
}

/** Constructor supplies the actual authenticated SSE transport. Both arms read
 * the same native stream; only enabled arms forward projected activity hints. */
export async function runManagedWakeAttribution({ client, managed, nativeControl, observations, directory,
  openEventStream, readOperationCounts, controlledPid }) {
  assert.ok(client?.events && managed?.runAcceptance && managed?.getManagedRuntime && Array.isArray(observations));
  assert.equal(typeof directory, 'string');
  if (typeof openEventStream !== 'function') return { protocol: managedWakeProtocol, status: 'unavailable', reason: 'authenticated_event_transport_missing', arms: [] };
  const arms = [], casePrefix = `wake-${randomUUID().slice(0, 8)}`;
  for (const [index, mode] of managedWakeProtocol.order.entries()) {
    const caseID = `${casePrefix}-${index}`, waitID = `native_${caseID}_wait`, abort = new AbortController();
    const records = [], projector = client.events.createProjector();
    const beforeObservation = observations.length;
    const beforeOperations = readOperationCounts ? await readOperationCounts() : null;
    let sampler;
    let reader, streamFailure, streamBytes = 0, nativeEvents = 0, forwardedHints = 0, proof, resources;
    const response = await openEventStream({ url: client.events.url(), signal: abort.signal });
    assert.equal(response.ok, true, 'Actual native event stream refused'); assert.ok(response.body);
    reader = response.body.getReader();
    try { sampler = Number.isSafeInteger(controlledPid)
      ? await (await import('./native-upgrade-benchmark.mjs')).createProcessSampler(controlledPid) : null;
    } catch (error) { abort.abort(); await reader.cancel(); reader.releaseLock(); throw error; }
    const pump = (async () => {
      const decoder = new TextDecoder(); let pending = '';
      try {
        while (!abort.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) { if (!abort.signal.aborted) throw Error('native_event_stream_ended'); break; }
          streamBytes += chunk.value.byteLength; assert.ok(streamBytes <= managedWakeProtocol.maxStreamBytes);
          pending = (pending + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            const parsed = client.events.parseBlock(block); if (parsed?.kind !== 'event') continue;
            const event = parsed.envelope; if (parsed.directory !== directory && event.location?.directory !== directory) continue;
            assert.ok(++nativeEvents <= managedWakeProtocol.maxEvents);
            const at = performance.now(), data = event.data;
            // Keep only finite identity/timing, never tool content or prompts.
            if (['session.step.ended', 'session.tool.called', 'session.tool.success'].includes(event.type)) {
              records.push({ type: event.type, eventID: event.id, sequence: event.sequence ?? null, created: event.created,
                sessionID: data?.sessionID, assistantMessageID: data?.assistantMessageID, callID: data?.id, at });
            }
            for (const projected of projector.project(event)) if (mode === 'enabled') {
              managed.getManagedRuntime().processOpenCodeEvent(projected.payload, projected.directory); forwardedHints++;
            }
          }
        }
      } catch (error) { if (!abort.signal.aborted) streamFailure = error; }
    })();
    try {
      proof = await managed.runAcceptance(nativeControl, { caseID, revert: false });
      if (streamFailure) throw streamFailure;
    } finally {
      abort.abort(); await reader.cancel().catch(() => {}); await pump; reader.releaseLock();
      if (sampler) resources = await sampler.stop();
    }
    if (streamFailure) throw streamFailure;
    const page = await client.sessions.messages(proof.childSessionID, {}, { directory });
    const final = page.records.findLast(row => row.info?.role === 'assistant' && row.info.time?.completed
      && row.parts?.some(part => part.type === 'text' && part.text === `managed child completed ${caseID}`));
    assert.ok(final, 'Actual child canonical final assistant missing');
    const committed = observations.slice(beforeObservation).find(row => row.phase === 'managed_event'
      && row.properties?.task?.taskId === proof.taskID && row.properties.task.status === 'completed');
    assert.ok(committed, 'Real managed completed task publication missing');
    const terminal = records.find(row => row.type === 'session.step.ended' && row.sessionID === proof.childSessionID && row.assistantMessageID === final.info.id);
    const wait = records.find(row => row.type === 'session.tool.called' && row.sessionID === proof.rootSessionID && row.callID === waitID);
    const settled = records.find(row => row.type === 'session.tool.success' && row.sessionID === proof.rootSessionID && row.callID === waitID);
    const causal = terminal && wait && settled && wait.at <= terminal.at && settled.at >= terminal.at;
    const afterOperations = readOperationCounts ? await readOperationCounts() : null;
    arms.push({ mode, caseID, proof, childFinalAssistantID: final.info.id, committedTaskSequence: committed.properties.task.sequence,
      timing: causal ? { status: 'measured', waitSettlementMs: settled.at - terminal.at,
        terminal, wait, settled } : { status: 'inconclusive', reason: 'exact_terminal_after_wait_registration_not_observed', terminal: terminal ?? null, wait: wait ?? null, settled: settled ?? null },
      stream: { bytes: streamBytes, nativeEvents, forwardedHints }, resources: resources ?? null,
      operationCount: Number.isSafeInteger(beforeOperations) && Number.isSafeInteger(afterOperations) ? afterOperations - beforeOperations : null });
  }
  return { protocol: managedWakeProtocol, correctness: 'passed-six-real-managed-children-and-writer-receipts', arms, ...gradeManagedWakeAttribution(arms) };
}
