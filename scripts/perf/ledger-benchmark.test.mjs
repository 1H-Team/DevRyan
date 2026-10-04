import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { SEED_SESSIONS, burstCallIdentity, burstModeFor, drainRuntime, fixtureEntries, parseLedgerBenchmarkArgs, seedCallIdentity, summarize } from './ledger-benchmark.mjs';
import { phaseTotals, parseProcessSample } from './ledger-profile-worker.mjs';

test('parses benchmark options and rejects invalid counts or unknown flags', () => {
  const options = parseLedgerBenchmarkArgs(['--repo', 'a', '--runtime', 'b', '--iterations', '2', '--warm-calls', '4', '--prewarm', '--keep', '--out', 'r.json']);
  assert.equal(options.repo, path.resolve('a'));
  assert.equal(options.runtime, path.resolve('b'));
  assert.equal(options.iterations, 2);
  assert.equal(options.warmCalls, 4);
  assert.equal(options.prewarm, true);
  assert.equal(options.keep, true);
  assert.equal(options.out, path.resolve('r.json'));
  assert.throws(() => parseLedgerBenchmarkArgs(['--iterations', '0']), /--iterations/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--warm-calls', '1.5']), /--warm-calls/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--repo']), /requires a value/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--bogus']), /Unknown option/);
});

test('burst, re-stamp and synthetic fixture options are bounded', () => {
  const options = parseLedgerBenchmarkArgs(['--fixture-files', '12000', '--parallel', '8', '--restamp']);
  assert.equal(options.fixtureFiles, 12000);
  assert.equal(options.parallel, 8);
  assert.equal(options.restamp, true);
  assert.equal(parseLedgerBenchmarkArgs([]).parallel, 1);
  for (const value of ['0', '33', '1.5']) assert.throws(() => parseLedgerBenchmarkArgs(['--parallel', value]), /--parallel/);
  for (const value of ['0', '200001']) assert.throws(() => parseLedgerBenchmarkArgs(['--fixture-files', value]), /--fixture-files/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--profile', '--restamp']), /not --profile/);
});

test('seeded history, same-session bursts and deferred cleanup are opt-in and bounded', () => {
  const defaults = parseLedgerBenchmarkArgs([]);
  assert.equal(defaults.seedCalls, 0);
  assert.equal(defaults.sameSession, false);
  assert.equal(defaults.deferredCleanup, false);
  assert.equal(burstModeFor(defaults), null);
  const options = parseLedgerBenchmarkArgs(['--seed-calls', '40000', '--parallel', '8', '--same-session', '--deferred-cleanup']);
  assert.equal(options.seedCalls, 40000);
  assert.equal(options.sameSession, true);
  assert.equal(options.deferredCleanup, true);
  assert.equal(burstModeFor(options), 'same-session');
  assert.equal(burstModeFor(parseLedgerBenchmarkArgs(['--parallel', '8'])), 'distinct-sessions');
  assert.equal(parseLedgerBenchmarkArgs(['--seed-calls', '200000']).seedCalls, 200000);
  for (const value of ['-1', '200001', '1.5', 'many']) assert.throws(() => parseLedgerBenchmarkArgs(['--seed-calls', value]), /--seed-calls/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--seed-calls']), /requires a value/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--same-session']), /--parallel burst/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--same-session', '--parallel', '1']), /--parallel burst/);
  for (const flag of [['--seed-calls', '10'], ['--deferred-cleanup']]) {
    assert.throws(() => parseLedgerBenchmarkArgs(['--profile', ...flag]), /not --profile/);
  }
});

test('a profiled burst is ledger-only', () => {
  const options = parseLedgerBenchmarkArgs(['--profile', '--parallel', '8', '--same-session']);
  assert.equal(options.parallel, 8);
  assert.equal(burstModeFor(options), 'same-session');
  assert.throws(() => parseLedgerBenchmarkArgs(['--profile', '--companion', '--parallel', '4']), /retired/);
});

test('burst and seed identities follow the production step shape', () => {
  assert.deepEqual(burstCallIdentity(3, true), { session: 's1', user: 'ub', call: 'bc3' });
  assert.deepEqual(burstCallIdentity(3, true, 'profile'), { session: 'profile', user: 'ub', call: 'bc3' });
  assert.deepEqual(burstCallIdentity(3, false), { session: 'b3', user: 'bu3', call: 'bc3' });
  const seeded = Array.from({ length: 200 }, (_, index) => seedCallIdentity(index));
  assert.equal(new Set(seeded.map((row) => row.callID)).size, 200);
  assert.equal(new Set(seeded.map((row) => row.sessionID)).size, SEED_SESSIONS);
  // Each assistant step (session, user message) carries eight calls.
  const steps = Map.groupBy(seeded, (row) => `${row.sessionID}/${row.userMessageID}`);
  assert.deepEqual(new Set([...steps.values()].map((rows) => rows.length)), new Set([8]));
  for (const row of seeded) assert.equal(row.messageID, `${row.userMessageID}-assistant`);
});

test('the runtime drain awaits maintenance scheduled on the next tick and tolerates older runtimes', async () => {
  assert.equal(await drainRuntime(null), null);
  assert.equal(await drainRuntime({}), null);
  // Mirrors noteLedgerCommit: maintenance registers via setImmediate after the
  // commit returns, so a drain that did not yield first would miss it.
  let running = null, finished = false;
  setImmediate(() => { running = new Promise((resolve) => setTimeout(resolve, 20)).then(() => { finished = true; }); });
  const ms = await drainRuntime({ drain: () => Promise.allSettled([running].filter(Boolean)) });
  assert.equal(finished, true);
  assert.ok(Number.isFinite(ms));
});

test('the synthetic fixture is deterministic and mixes depths, links and executables', () => {
  const entries = fixtureEntries(1000);
  assert.deepEqual(entries, fixtureEntries(1000));
  assert.equal(entries.length, 1000);
  assert.ok(entries.some((entry) => entry.link));
  assert.ok(entries.some((entry) => entry.executable));
  assert.deepEqual(new Set(entries.map((entry) => entry.file.split('/').length)), new Set([3, 4, 5, 6]));
});

test('profile bounds retain isolated ledger mode and reject the retired companion option', () => {
  const options = parseLedgerBenchmarkArgs(['--profile', '--timeout-ms', '60000']);
  assert.equal(options.profile, true); assert.equal(options.timeoutMs, 60000);
  assert.throws(() => parseLedgerBenchmarkArgs(['--companion']), /retired/);
  assert.throws(() => parseLedgerBenchmarkArgs(['--profile', '--companion']), /retired/);
  for (const timeout of ['0', '999', '900001', 'oops']) assert.throws(() => parseLedgerBenchmarkArgs(['--timeout-ms', timeout]), /--timeout-ms/);
});

test('phase summaries avoid counting repeated slow events and preserve nested phase overlap', () => {
  assert.deepEqual(phaseTotals([
    { phase: 'ledger_commit', state: 'completed', elapsedMs: 3000 },
    { phase: 'admission', steps: 'preparation:1/5000,ledger_commit:2/3000,queue_wait:2/0' },
    { phase: 'admission', steps: 'ledger_commit:1/30,garbage' },
  ]), { preparation: { count: 1, elapsedMs: 5000 }, ledger_commit: { count: 3, elapsedMs: 3030 }, queue_wait: { count: 2, elapsedMs: 0 } });
});

test('companion process samples label missing data and parse minutes, hours and days', () => {
  assert.deepEqual(parseProcessSample(' 2048 00:01.25\n'), { rssMiB: 2, cpuMs: 1250 });
  assert.deepEqual(parseProcessSample('1024 01:02:03'), { rssMiB: 1, cpuMs: 3723000 });
  assert.deepEqual(parseProcessSample('1024 2-01:02:03'), { rssMiB: 1, cpuMs: 176523000 });
  assert.equal(parseProcessSample(''), null);
});

test('summarizes finite samples with an even-count median', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { count: 4, min: 1, p50: 2.5, max: 4 });
  assert.deepEqual(summarize([5, null, Number.NaN]), { count: 1, min: 5, p50: 5, max: 5 });
  assert.deepEqual(summarize([]), { count: 0, min: null, p50: null, max: null });
});
