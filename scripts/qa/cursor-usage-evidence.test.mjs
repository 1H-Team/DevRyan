import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectCursorQuota, cursorQuotaDelta, admitCursorWork, estimateCursorWorkPoints, cursorReferenceMatchesAttempt, summarizeCursorRuns, summarizeCursorStudy, canReuseCursorQuota } from './cursor-usage-evidence.mjs';

const origin = Date.now();
const quota = (at, cursor = 20, api = 5, resetAt = null) => projectCursorQuota({ ok: true, fetchedAt: origin + at,
  usage: { windows: { 'auto-composer': { usedPercent: cursor, resetAt }, api: { usedPercent: api, resetAt } } },
}, origin + at);

test('a transient refresh failure cannot extend freshness or satisfy a post-work reading', () => {
  const snapshot = quota(1);
  assert.equal(canReuseCursorQuota(snapshot, origin + 80_000), true);
  assert.equal(canReuseCursorQuota(snapshot, origin + 86_000), false);
  assert.equal(canReuseCursorQuota(snapshot, origin + 80_000, origin + 2), false);
  assert.throws(() => admitCursorWork({ baseline: quota(0), current: snapshot, now: origin + 91_000 }), /stale/);
  assert.equal(snapshot.fetchedAt, origin + 1);
});

test('quota requires two fresh pools and forward endpoints; reset never renews the budget', () => {
  assert.throws(() => projectCursorQuota({ ok: false }));
  assert.throws(() => projectCursorQuota({ ok: true, fetchedAt: 1 }, 100_000));
  assert.throws(() => cursorQuotaDelta(quota(1), quota(1)));
  assert.throws(() => cursorQuotaDelta(quota(1), quota(2, 19)));
  assert.throws(() => cursorQuotaDelta(quota(1), quota(2, 21, 5, 9999)));
  assert.deepEqual(cursorQuotaDelta(quota(1), quota(2, 20.1, 5.2)), { 'auto-composer': 0.10000000000000142, api: 0.20000000000000018 });
});

test('admission reserves verification and in-flight headroom in each pool', () => {
  assert.doesNotThrow(() => admitCursorWork({ baseline: quota(1), current: quota(2, 25.9, 10.9) }));
  assert.throws(() => admitCursorWork({ baseline: quota(1), current: quota(2, 26) }));
  assert.throws(() => admitCursorWork({ baseline: quota(1), current: quota(2, 20, 11) }));
  assert.doesNotThrow(() => admitCursorWork({ baseline: quota(1), current: quota(2, 27), phase: 'verification' }));
  assert.throws(() => admitCursorWork({ baseline: quota(1), current: quota(2, 28), phase: 'verification' }));
  assert.throws(() => admitCursorWork({ baseline: quota(1), current: quota(2), limitPoints: 11 }));
});

test('whole-work admission includes failed costs and cannot spend the reserved headroom', () => {
  const selection = { modelID: 'fixture', arm: 'control', workload: 'small' };
  const points = estimateCursorWorkPoints([{ ...selection, outcome: 'failed', delta: { 'auto-composer': 0.4, api: 0.2 } }], selection);
  assert.deepEqual(points, { 'auto-composer': 0.5, api: 0.25 });
  assert.throws(() => admitCursorWork({ baseline: quota(1), current: quota(2, 25.6), requiredPoints: points }), /headroom/);
  assert.doesNotThrow(() => admitCursorWork({ baseline: quota(1), current: quota(2, 25.4), requiredPoints: points }));
});

test('a reviewed completed-chat deletion can reconcile identity, never an active or unexplained change', () => {
  const attempt = { referenceBefore: { hash: 'before' }, startedAt: 10, completedAt: 30 };
  const current = { hash: 'after', active: false };
  assert.equal(cursorReferenceMatchesAttempt(attempt, current), false);
  attempt.referenceReconciliation = { kind: 'completed-session-deletion', removedWasActive: false,
    beforeHash: 'before', afterHash: 'after', deletedAt: 20, journalReconstructionVerified: true };
  assert.equal(cursorReferenceMatchesAttempt(attempt, current), true);
  assert.equal(cursorReferenceMatchesAttempt(attempt, { ...current, active: true }), false);
  assert.equal(cursorReferenceMatchesAttempt(attempt, { ...current, hash: 'unexplained' }), false);
  attempt.referenceReconciliation.removedWasActive = true;
  assert.equal(cursorReferenceMatchesAttempt(attempt, current), false);
});

test('one cumulative result per run; failures count and unknown usage is not zero', () => {
  const row = { kind: 'run-ended', agentID: 'agent', runID: 'run', status: 'finished',
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 0, reasoningTokens: 20 } };
  const summary = summarizeCursorRuns([row, row, { ...row, runID: 'failed', status: 'error', usage: undefined }]);
  assert.equal(summary.runs, 2); assert.equal(summary.failures, 1); assert.equal(summary.missingUsageRuns, 1);
  assert.equal(summary.usage.totalTokens, 1040); assert.equal(summary.cacheReadRatio, 0.9);
  assert.equal(summary.providerAttemptCount, null);
  assert.equal(summarizeCursorRuns([]).usage, null);
  const interrupted = summarizeCursorRuns([{ kind: 'send' }, { kind: 'send' },
    { kind: 'run-started', agentID: 'agent', runID: 'unfinished', status: 'running' },
    { kind: 'one-shot-started' }]);
  assert.equal(interrupted.runs, 1);
  assert.equal(interrupted.sendAttempts, 2);
  assert.equal(interrupted.runSubmissions, 1);
  assert.equal(interrupted.missingUsageRuns, 1);
  assert.equal(interrupted.oneShotUsage.unavailable, 1);
});

test('shareable study report retains failed spend and makes unknown quota explicit', () => {
  const attempt = { id: 'fixture', modelID: 'fixture', arm: 'control', workload: 'small', turns: [],
    outcome: 'completed', delta: { 'auto-composer': 0.2, api: 0 } };
  const study = { attempts: [attempt, { ...attempt, outcome: 'failed', delta: { 'auto-composer': 0.3, api: 0 } }],
    context: { prompt: 'private instructions' }, apiKey: 'private key' };
  const report = summarizeCursorStudy(study);
  assert.equal(report.groups[0].acceptedMeanPoints['auto-composer'], 0.2);
  assert.equal(report.groups[0].pointsPerAcceptedWorkloadIncludingFailures['auto-composer'], 0.5);
  assert.equal(report.groups[0].failed, 1);
  assert.equal(JSON.stringify(report).includes('private'), false);
  study.attempts.push({ ...attempt, outcome: 'failed', delta: null });
  assert.equal(summarizeCursorStudy(study).spentPoints['auto-composer'], null);
  assert.equal(summarizeCursorStudy({ attempts: [{ ...attempt, outcome: 'failed' }] })
    .groups[0].pointsPerAcceptedWorkloadIncludingFailures.api, null);
  assert.equal(summarizeCursorStudy({ attempts: [attempt, { ...attempt, workerHost: 'electron' }] }).groups.length, 2);
});
