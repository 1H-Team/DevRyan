import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { parseNativeJournalObservation } from '../../packages/shared-runtime/lib/native-observation.js';

export const REHEARSAL_PHASE_SECONDS = Object.freeze({ inspection: 150, firstReady: 120, chat: 60, stop: 30, reopen: 90, history: 30, cleanup: 60, receipt: 30 });
const readiness = new Set(['firstReady', 'reopen']);
export function freezeReleaseSmokeBudget(receipts, identity) {
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts.map(row => row.sample).sort(), [1, 2, 3]);
  for (const receipt of receipts) assertReleaseSmokeReceipt(receipt, { ...identity, rehearsal: true });
  assert.equal(new Set(receipts.map(row=>row.runnerID)).size, 3, 'Three rehearsals must use distinct original hosted runners');
  for (const key of ['dmgSha256', 'manifestSha256', 'appSha256']) assert.equal(new Set(receipts.map(row => row[key])).size, 1, 'All rehearsals must use the same retained candidate bytes and extracted app');
  const phases = Object.fromEntries(Object.keys(REHEARSAL_PHASE_SECONDS).map(name => [name,
    Math.max(readiness.has(name) ? 30 : 10, Math.ceil(3 * Math.max(...receipts.map(row => row.phases[name].elapsedMs)) / 1000))]));
  assert.ok(Object.values(phases).reduce((sum, seconds) => sum + seconds, 0) <= 570, 'Frozen smoke phases exceed the 570 second absolute budget');
  return phases;
}
export function assertReleaseSmokeRetry(receipts, { sourceCommit, dmgSha256, sample, runID, runAttempt, qualificationAttempt, runnerID }) {
  assert.ok(Number.isSafeInteger(runAttempt) && runAttempt >= 1, 'GitHub attempt correlation required');
  assert.ok(Number.isSafeInteger(runnerID) && runnerID > 0, 'Hosted runner identity required');
  assert.ok(Number.isInteger(qualificationAttempt) && qualificationAttempt >= 1 && qualificationAttempt <= 3, 'At most two fresh-runner GUI retries are permitted');
  assert.equal(receipts.length, qualificationAttempt - 1, 'Every previous qualification receipt is required');
  const runners = new Set([runnerID]);
  for (let attempt = 1; attempt < qualificationAttempt; attempt++) {
    const receipt = receipts.find(row => row.qualificationAttempt === attempt);
    assert.ok(receipt && receipt.sourceCommit === sourceCommit && receipt.dmgSha256 === dmgSha256
      && receipt.sample === sample && receipt.runID === runID && Number.isSafeInteger(receipt.runAttempt) && receipt.runAttempt < runAttempt
      && receipt.outcome === 'failed' && receipt.failureClass === 'pre_app_gui_unavailable'
      && receipt.appStarted === false && receipt.fixtureAttempts === 0 && receipt.safeCleanup === true
      && Array.isArray(receipt.cleanupErrors) && receipt.cleanupErrors.length === 0
      && Number.isSafeInteger(receipt.runnerID) && receipt.runnerID > 0 && !runners.has(receipt.runnerID),
    'Only a typed pre-app GUI failure with safe cleanup may retry the same retained bytes');
    runners.add(receipt.runnerID);
  }
}
export function assertReleaseSmokeArtifactIdentity(receipt, identity) {
  for (const key of ['sourceCommit', 'version', 'dmgSha256', 'manifestSha256', 'appSha256']) {
    if (identity[key] !== undefined) assert.equal(receipt[key], identity[key], 'Final tag must reuse the exact qualified candidate');
  }
}
export function assertReleaseSmokeReceipt(receipt, identity) {
  assert.equal(receipt?.protocol, 'devryan.release-startup-smoke/1');
  assert.equal(receipt.ioWitness?.protocol, 'devryan.release-receipt-io/1');
  assert.match(receipt.ioWitness.receiptSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(receipt.ioObservation?.protocol, 'devryan.release-receipt-observation/1');
  assert.equal(receipt.ioObservation.receiptSha256, receipt.ioWitness.receiptSha256);
  assert.match(receipt.ioObservation.witnessSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.phases.receipt, receipt.ioObservation.phase);
  assert.equal(receipt.elapsedMs, receipt.ioObservation.elapsedMs);
  assert.equal(receipt.outcome, 'passed'); assertReleaseSmokeArtifactIdentity(receipt, identity); assert.equal(receipt.sourceCommit, identity.sourceCommit);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/); assert.equal(receipt.version, identity.version);
  if (identity.dmgSha256) assert.equal(receipt.dmgSha256, identity.dmgSha256);
  assert.equal(receipt.rehearsal, identity.rehearsal === true);
  for (const key of ['dmgSha256', 'manifestSha256', 'appSha256']) assert.match(receipt[key] ?? '', /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(receipt.runAttempt) && receipt.runAttempt >= 1);
  assert.ok(Number.isSafeInteger(receipt.qualificationAttempt) && receipt.qualificationAttempt >= 1 && receipt.qualificationAttempt <= 3);
  assert.ok(Number.isSafeInteger(receipt.runnerID) && receipt.runnerID > 0);
  assert.equal(receipt.appStarted, true); assert.equal(receipt.fixtureAttempts, 1); assert.equal(receipt.safeCleanup, true);
  assert.equal(receipt.guiPrerequisites, 'passed'); assert.equal(receipt.eventStream, 'acknowledged');
  assert.equal(receipt.providerObservation, 'passed'); assert.equal(receipt.completedAssistant, 'passed');
  assert.equal(receipt.renderedResponse, 'passed'); assert.equal(receipt.retainedHistory, 'passed');
  assert.equal(receipt.gapRecords, 0); assert.equal(receipt.nativeCorrelation?.status, 'passed');
  assert.deepEqual(receipt.cleanupErrors, []);
  assert.ok(Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs <= 570 * 1000);
  assert.deepEqual(Object.keys(receipt.phases).sort(), Object.keys(REHEARSAL_PHASE_SECONDS).sort());
  for (const [name, phase] of Object.entries(receipt.phases)) {
    assert.equal(phase.status, 'passed', name); assert.ok(Number.isFinite(phase.elapsedMs) && phase.elapsedMs >= 0);
    assert.ok(phase.elapsedMs <= phase.limitSeconds * 1000, name);
  }
  return receipt;
}
export function correlateReleaseNativeJournal(journal, { sessionID, directory, messages }) {
  const records = journal.filter(row => row.event === 'native_observation' && row.sessionID === sessionID)
    .map(row => parseNativeJournalObservation(row.payload));
  assert.equal(journal.some(row => row.event === 'native_observation_gap' && row.sessionID === sessionID), false);
  const journalDirectory = `<WORKTREE_${createHash('sha256').update(directory).digest('hex').slice(0, 12)}>`;
  const accepted = records.find(row => row.stage === 'accepted-user' && row.directory === journalDirectory
    && messages.some(message => message.info?.id === row.messageID && message.info?.role === 'user'));
  assert.ok(accepted, 'Actual native accepted-user observation missing');
  const step = records.find(row => row.stage === 'step-link' && row.userMessageID === accepted.messageID
    && messages.some(message => message.info?.id === row.assistantMessageID && message.info?.time?.completed));
  assert.ok(step?.attempt, 'Actual native committed step link missing');
  const physical = records.find(row => row.stage === 'physical' && row.kind === 'primary' && row.transport === 'http'
    && row.attempt?.traceID === step.attempt.traceID && row.attempt?.spanID === step.attempt.spanID);
  assert.ok(physical, 'Actual physical HTTP inference missing');
  const prepared = records.find(row => row.stage === 'model-prepared' && row.requestID === physical.requestID);
  assert.ok(prepared, 'Actual native model preparation missing');
  assert.equal(prepared.execution.agent, 'builder'); assert.equal(prepared.execution.providerID, 'devryan-smoke'); assert.equal(prepared.execution.modelID, 'smoke-write');
  const cohort = [accepted, step, prepared, physical];
  assert.equal(new Set(cohort.map(row => row.controllerInstanceID)).size, 1);
  assert.equal(new Set(cohort.map(row => row.configurationDigest)).size, 1);
  assert.equal(new Set(cohort.map(row => row.sessionID)).size, 1);
  assert.equal(new Set(cohort.map(row => row.directory)).size, 1);
  assert.deepEqual({ ...prepared.execution, variant: prepared.execution.variant ?? 'default' },
    { ...step.execution, variant: step.execution.variant ?? 'default' });
  return { status: 'passed', sessionID, userMessageID: accepted.messageID, assistantMessageID: step.assistantMessageID,
    requestID: prepared.requestID, controllerInstanceID: prepared.controllerInstanceID,
    configurationDigest: prepared.configurationDigest, traceID: step.attempt.traceID, spanID: step.attempt.spanID };
}

export function finalizeReleaseSmokeIoReceipt(bytes, witnessBytes, observationBytes) {
  const receipt = JSON.parse(bytes), witness = JSON.parse(witnessBytes), observation = JSON.parse(observationBytes);
  assert.equal(witness.protocol, 'devryan.release-receipt-io/1');
  assert.equal(witness.receiptSha256, createHash('sha256').update(bytes).digest('hex'), 'Receipt I/O witness belongs to other bytes');
  assert.equal(observation.protocol, 'devryan.release-receipt-observation/1');
  assert.equal(observation.receiptSha256, witness.receiptSha256);
  assert.equal(observation.witnessSha256, createHash('sha256').update(witnessBytes).digest('hex'), 'Receipt observation belongs to another witness');
  for (const key of ['sourceCommit', 'dmgSha256', 'sample', 'runID', 'runAttempt', 'qualificationAttempt', 'runnerID']) {
    assert.equal(witness[key], receipt[key]); assert.equal(observation[key], receipt[key]);
  }
  assert.equal(observation.clockScope, 'receipt-json-and-digest-witness-io');
  assert.equal(observation.observationCommit, 'bounded-by-receipt-deadline-excluded-from-observation');
  assert.equal(receipt.phases?.receipt?.status, 'pending', 'Receipt cannot certify its own unfinished I/O');
  assert.equal(observation.phase?.limitSeconds, receipt.phases.receipt.limitSeconds, 'Observed receipt allowance changed');
  assert.equal(observation.phase?.status, 'passed');
  assert.ok(Number.isFinite(observation.phase.elapsedMs) && observation.phase.elapsedMs >= 0
    && Number.isSafeInteger(observation.phase.limitSeconds) && observation.phase.limitSeconds > 0
    && observation.phase.elapsedMs <= observation.phase.limitSeconds * 1000);
  assert.ok(Number.isFinite(observation.elapsedMs) && observation.elapsedMs >= observation.phase.elapsedMs);
  receipt.phases.receipt = observation.phase; receipt.elapsedMs = observation.elapsedMs;
  receipt.ioWitness = witness; receipt.ioObservation = observation; return receipt;
}
export async function readReleaseSmokeReceipt(file, { signal } = {}) {
  const bytes = await Promise.all([file, `${file}.receipt-io`, `${file}.receipt-observation`].map(name => fs.readFile(name, { signal })));
  return finalizeReleaseSmokeIoReceipt(...bytes);
}
