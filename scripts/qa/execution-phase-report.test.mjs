import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionPhaseCollector, parseAdmissionSteps, parseWorkerTrace } from './execution-phase-report.mjs';

test('parses admission step summaries and rejects malformed entries', () => {
  assert.deepEqual(parseAdmissionSteps('reconciliation:1/40,lease_preparation:2/120,bad,x:1'), [
    { phase: 'reconciliation', count: 1, elapsedMs: 40 },
    { phase: 'lease_preparation', count: 2, elapsedMs: 120 },
  ]);
  assert.deepEqual(parseAdmissionSteps(undefined), []);
});

test('parses worker trace milestones only', () => {
  assert.deepEqual(parseWorkerTrace('worker registry 812ms\n'), { milestone: 'registry', sinceStartMs: 812 });
  assert.equal(parseWorkerTrace('user shell: entry'), null);
});

test('summarizes admission phases and worker milestones', () => {
  const collector = createExecutionPhaseCollector();
  const record = (elapsedMs, steps, state = 'completed') => ({ type: 'lifecycle', event: 'session_execution',
    payload: { phase: 'admission', state, elapsedMs, steps } });
  collector.addJournalRecord(record(100, 'reconciliation:1/40,host_request:1/90'));
  collector.addJournalRecord(record(300, 'reconciliation:1/200', 'failed'));
  collector.addJournalRecord({ type: 'lifecycle', event: 'session_execution', payload: { phase: 'reconciliation', state: 'completed', elapsedMs: 5 } });
  collector.addLogLine('worker runtime 400ms');
  collector.addLogLine('worker runtime 600ms');
  const report = collector.finish();
  assert.deepEqual(report.coverage, { admissions: 2, failed: 1, gaps: 0 });
  assert.deepEqual(report.admissionMs, { count: 2, totalMs: 400, p50: 100, p95: 300, max: 300 });
  assert.equal(report.phases.reconciliation.calls, 2);
  assert.equal(report.phases.reconciliation.p95, 200);
  assert.equal(report.workerMilestonesSinceStartMs.runtime.p50, 400);
});
