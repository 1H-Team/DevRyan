import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeManagedWakeAttribution, managedWakeProtocol, runManagedWakeAttribution } from './managed-wake-attribution.mjs';

// Synthetic grading contracts only; these records are never runtime evidence.
const cohort = () => managedWakeProtocol.order.map(mode => ({ mode, timing: { status: 'measured', waitSettlementMs: mode === 'enabled' ? 50 : 250 },
  operationCount: 10, resources: { failures: [], exitedBeforeSample: [], metrics: {
    hostCpuMs: 100, sampledDescendantCpuMs: 100, peakHostRssMiB: 80, peakDescendantRssMiB: 100 } } }));
test('predeclared paired attribution requires causal timing, full owned sampling and actual operation counts', () => {
  assert.deepEqual(managedWakeProtocol.order, ['disabled', 'enabled', 'enabled', 'disabled', 'disabled', 'enabled']);
  const full = gradeManagedWakeAttribution(cohort());
  assert.equal(full.status, 'measured'); assert.equal(full.reductionMs, 200); assert.equal(full.retentionSatisfied, true);
  assert.equal(full.denominator.completedChildren, 6);
  for (const field of ['resources', 'operationCount']) {
    const rows = cohort(); rows[0][field] = null;
    assert.equal(gradeManagedWakeAttribution(rows).status, 'inconclusive');
    assert.equal(gradeManagedWakeAttribution(rows).retentionSatisfied, false);
  }
  const early = cohort(); early[1].timing = { status: 'inconclusive' };
  assert.equal(gradeManagedWakeAttribution(early).reductionMs, null);
  const costly = cohort(); costly[1].resources.metrics.hostCpuMs = 400; costly[2].resources.metrics.hostCpuMs = 400;
  assert.equal(gradeManagedWakeAttribution(costly).retentionSatisfied, false);
  const exited = cohort(); exited[0].resources.exitedBeforeSample.push({ pid: 42, startIdentity: 'helper-start', at: 1 });
  const retained = gradeManagedWakeAttribution(exited);
  assert.equal(retained.status, 'measured');
  assert.equal(retained.resourceComparisons.length, 4);
  assert.equal(retained.retentionSatisfied, true);
  assert.equal(exited[0].resources.exitedBeforeSample.length, 1);
  for (const field of ['failures', 'exitedBeforeSample']) {
    const missing = cohort(); delete missing[0].resources[field];
    assert.equal(gradeManagedWakeAttribution(missing).status, 'inconclusive');
  }
  for (const metric of Object.keys(cohort()[0].resources.metrics)) for (const value of [undefined, null, NaN, Infinity, -1]) {
    const missing = cohort(); missing[1].resources.metrics[metric] = value;
    const result = gradeManagedWakeAttribution(missing);
    assert.equal(result.status, 'inconclusive'); assert.equal(result.retentionSatisfied, false);
  }
});
test('missing authenticated opener is unavailable before any actual child is started', async () => {
  let starts = 0;
  const result = await runManagedWakeAttribution({ client: { events: {} }, observations: [], directory: '/fixture',
    managed: { getManagedRuntime() {}, runAcceptance() { starts++; } }, nativeControl: {} });
  assert.equal(result.status, 'unavailable'); assert.equal(starts, 0); assert.deepEqual(result.arms, []);
});
test('synthetic orchestration contract keeps six unique fixture cases, canonical page API and stream disposal', async () => {
  const observations = [], cases = []; let closed = 0;
  const client = { events: { url: () => 'http://fixture/event', createProjector: () => ({ project: () => [] }) }, sessions: {
    messages: async (session, paging, scope) => {
      assert.deepEqual(paging, {}); assert.deepEqual(scope, { directory: '/fixture' });
      return { records: [{ info: { id: `${session}-final`, role: 'assistant', time: { completed: 10 } },
        parts: [{ type: 'text', text: `managed child completed ${session}` }] }] };
    } } };
  const managed = { getManagedRuntime: () => ({}), runAcceptance: async (_control, { caseID, revert }) => {
    assert.equal(revert, false); cases.push(caseID);
    observations.push({ phase: 'managed_event', properties: { task: { taskId: caseID, status: 'completed', sequence: 1 } } });
    return { taskID: caseID, childSessionID: caseID, rootSessionID: `root-${caseID}`, status: 'passed' };
  } };
  const result = await runManagedWakeAttribution({ client, managed, nativeControl: {}, directory: '/fixture', observations,
    openEventStream: async () => new Response(new ReadableStream({ cancel() { closed++; } })) });
  assert.equal(new Set(cases).size, 6); assert.equal(closed, 6);
  assert.deepEqual(result.arms.map(arm => arm.mode), managedWakeProtocol.order);
  assert.equal(result.status, 'inconclusive'); assert.equal(result.retentionSatisfied, false);
  assert.ok(result.arms.every(arm => arm.timing.status === 'inconclusive' && arm.resources === null));
});
