import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkQuotaAdmission, compareQuota, projectNativeAssistant, projectQuota,
  readNativeAssistants, summarizeNativeAssistants } from './claude-quota-evidence.mjs';

const now = 1_800_000_000_000;
const assistant = (extra = {}) => ({ type: 'assistant', sessionId: 'session-one', requestId: 'request-one',
  timestamp: new Date(now).toISOString(), version: '2.fixture', message: { id: 'message-one', model: 'claude-opus-4-8',
    usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } },
    content: [{ type: 'tool_use', id: 'tool-one', name: 'edit', input: { secret: 'never-record-this' } }] }, ...extra });
const payload = (used = 0.05, fetchedAt = now) => ({ asOf: now, sources: { oauth: { fetchedAt } },
  buckets: [{ type: 'five_hour', utilization: used, resetsAt: now + 100_123 },
    { type: 'seven_day', utilization: 0.41, resetsAt: now + 600_123 }], extraUsage: { isEnabled: false } });

test('native response accounting deduplicates split blocks and resumed transcript copies', () => {
  const first = projectNativeAssistant(assistant());
  const second = projectNativeAssistant(assistant({ timestamp: new Date(now + 1).toISOString(),
    message: { ...assistant().message, usage: { ...assistant().message.usage, output_tokens: 80 },
      content: [{ type: 'tool_use', id: 'tool-two', name: 'read', input: { file: 'private' } }] } }));
  const result = summarizeNativeAssistants([first, second, { ...first, sessionId: 'fork-copy' }]);
  assert.equal(result.observedResponseCount, 1);
  assert.equal(result.usage.output_tokens, 80, 'native output already includes reasoning');
  assert.equal(result.usage.cache_creation_input_tokens, 100);
  assert.deepEqual(result.tools, { edit: 1, read: 1 });
  assert.equal(result.providerAttemptCount, null);
  assert.equal(result.transcriptSessionCount, 2, 'fork copies count as transcript IDs without duplicating usage');
  assert.ok(!JSON.stringify(result).includes('never-record-this'));
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('native sampling separates time windows and responses already present at baseline', () => {
  const row = projectNativeAssistant(assistant());
  assert.equal(summarizeNativeAssistants([row], { since: now + 1 }).observedResponseCount, 0);
  assert.equal(summarizeNativeAssistants([row], { excludeIds: ['message-one'] }).observedResponseCount, 0);
  assert.equal(projectNativeAssistant(assistant({ type: 'user' })), null);
  assert.equal(projectNativeAssistant(assistant({ message: { ...assistant().message, model: '<synthetic>' } })), null);
});

test('native readers report torn records and malformed usage without disclosing their contents', async () => {
  const cache = path.resolve(import.meta.dirname, '../../.cache/qa');
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'claude-usage-fixture-'));
  try {
    const file = path.join(root, 'session.jsonl');
    await fs.writeFile(file, [JSON.stringify(assistant()), JSON.stringify(assistant({ message: {
      ...assistant().message, usage: { input_tokens: -1 } } })), '{"private":"never-record-this"'].join('\n'));
    const result = await readNativeAssistants([file]);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.gaps.map(gap => gap.reason), ['invalid_usage', 'parse_failure']);
    assert.ok(!JSON.stringify(result).includes('never-record-this'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('quota uses OAuth freshness and fraction units, independently of response time', () => {
  const result = projectQuota(payload(), { now });
  assert.equal(result.windows.five_hour.usedPercent, 5);
  assert.equal(result.windows.seven_day.usedPercent, 41);
  assert.throws(() => projectQuota(payload(0.05, now - 100_000), { now }), /stale/);
  assert.throws(() => projectQuota({ ...payload(), sources: {} }, { now }), /missing/);
});

test('quota comparisons reject reset crossings and negative deltas without inventing consumption', () => {
  const before = projectQuota(payload(), { now });
  const afterPayload = payload(0.06, now + 1000);
  afterPayload.buckets[0].resetsAt += 700;
  const after = projectQuota(afterPayload, { now: now + 1000 });
  assert.equal(compareQuota(before, after).deltas.five_hour, 1);
  assert.equal(compareQuota(before, after).valid, true, 'subsecond parser jitter is not a reset');
  after.windows.five_hour.resetsAt += 60_000;
  assert.equal(compareQuota(before, after).valid, false);
  after.windows.five_hour = { ...before.windows.five_hour, usedPercent: 4 };
  assert.equal(compareQuota(before, after).deltas.five_hour, undefined);
});

test('quota admission preserves the ceiling, headroom and failure closure', () => {
  const start = projectQuota(payload(), { now });
  const current = projectQuota(payload(0.22, now + 1000), { now: now + 1000 });
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000 }).allowed, true);
  current.windows.five_hour.usedPercent = 23;
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000 }).reason, 'study_budget');
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000, limitPoints: 40, reservePoints: 5 }).allowed, true);
  assert.equal(checkQuotaAdmission(start, current, { now: now + 100_000 }).reason, 'stale_quota');
  current.windows.five_hour.resetsAt += 60_000;
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000 }).reason, 'quota_window_changed');
  assert.throws(() => checkQuotaAdmission(start, current, { limitPoints: 41 }), /budget/);
});

test('a recent quota snapshot cannot stand in for a post-work measurement', () => {
  const before = projectQuota(payload(), { now });
  const after = projectQuota(payload(0.06, now + 20_000), { now: now + 40_000 });
  assert.equal(compareQuota(before, after).valid, true, 'the reset window and freshness alone still match');
  assert.deepEqual(compareQuota(before, after, { completedAt: now + 30_000 }).invalid, ['after_work_completion']);
  after.fetchedAt = now + 65_000;
  assert.equal(compareQuota(before, after, { completedAt: now + 30_000, reportingDelayMs: 30_000 }).valid, true);
});

test('an explicitly carried budget survives a reset without granting a new ceiling', () => {
  const start = projectQuota(payload(0, now), { now });
  const current = projectQuota(payload(0.24, now + 1000), { now: now + 1000 });
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000, limitPoints: 40,
    reservePoints: 5, carriedConsumedPoints: 10 }).consumedPoints, 34);
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000, limitPoints: 40,
    reservePoints: 5, carriedConsumedPoints: 11 }).reason, 'study_budget');
  assert.throws(() => checkQuotaAdmission(start, current, { carriedConsumedPoints: -1 }), /budget/);
  current.windows.five_hour.resetsAt += 60_000;
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000, carriedConsumedPoints: 10 }).reason, 'quota_window_changed');
});

test('an authoritative zero/null window can open once, without silently renewing its budget later', () => {
  const raw = payload(0, now);
  raw.buckets[0].resetsAt = null;
  const inactive = projectQuota(raw, { now });
  assert.equal(inactive.windows.five_hour.inactive, true);
  assert.equal(checkQuotaAdmission(inactive, inactive, { now, carriedConsumedPoints: 10 }).allowed, true);
  const active = projectQuota(payload(0.02, now + 1000), { now: now + 1000 });
  assert.equal(compareQuota(inactive, active).valid, true, 'a new window opens after the zero baseline');
  assert.equal(checkQuotaAdmission(inactive, active, { now: now + 1000 }).reason, 'quota_window_activation_required');
  const activatedFiveHourReset = active.windows.five_hour.resetsAt;
  assert.equal(checkQuotaAdmission(inactive, active, { now: now + 1000,
    activatedFiveHourReset, carriedConsumedPoints: 10 }).consumedPoints, 12);
  const nextInactive = { ...inactive, fetchedAt: now + 2000 };
  assert.equal(compareQuota(active, nextInactive).valid, false, 'closing an active window is a reset');
  assert.equal(checkQuotaAdmission(inactive, nextInactive, { now: now + 2000, activatedFiveHourReset }).reason, 'quota_window_changed');
  active.windows.five_hour.resetsAt += 60_000;
  assert.equal(checkQuotaAdmission(inactive, active, { now: now + 1000, activatedFiveHourReset }).reason, 'quota_window_changed');
  raw.buckets[0].utilization = 0.01;
  assert.throws(() => projectQuota(raw, { now }), /primary windows/, 'nonzero usage still requires a real reset boundary');
});

test('a long workload is not admitted into a window that is about to reset', () => {
  const start = projectQuota(payload(), { now });
  const current = projectQuota(payload(0.06, now + 1000), { now: now + 1000 });
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000, minimumWindowRemainingMs: 60_000 }).allowed, true);
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000, minimumWindowRemainingMs: 120_000 }).reason, 'quota_window_ending');
  assert.equal(checkQuotaAdmission(start, current, { now: now + 1000 }).allowed, true, 'ordinary in-progress checks keep their usual bound');
  assert.throws(() => checkQuotaAdmission(start, current, { minimumWindowRemainingMs: -1 }), /budget/);
});
