import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertInterleaved, compareResourceRuns, parseResourceGateArgs, WORKING_SET_FLOOR_KB } from './resource-gate.mjs';

const MIB = 1024;
const summary = (archive, createdAt, { cpu = 20, workingSet = 1_000 * MIB, p95 = 1_100 * MIB, types = ['Browser', 'GPU', 'Tab'], ...overrides } = {}) => ({
  schemaVersion: 1, createdAt, integrity: { passed: true }, packageEvidence: { archiveSha256: archive },
  fixtureSha256: 'f', lifecycleProtocolSha256: 'l', startupMode: 'natural', fixtureGeneration: 2, warmupMs: 30_000, measureMs: 120_000, sampleIntervalMs: 500,
  scenarios: { 'twelve-stream': { chromium: { product: 'Chrome/1' }, runs: [{ runIndex: 1, concurrency: { expectedSessions: 12, observedSessions: 12 },
    summary: { medianTotalAppCpu: cpu, medianTotalAppWorkingSet: workingSet, p95TotalAppWorkingSet: p95, processTypes: types } }] } },
  ...overrides,
});
const pairs = (candidate = {}, baseline = {}) => ({
  baseline: [summary('b', '2026-10-18T10:00:00Z', baseline), summary('b', '2026-10-18T10:03:00Z', baseline)],
  candidate: [summary('c', '2026-10-18T10:01:00Z', candidate), summary('c', '2026-10-18T10:02:00Z', candidate)],
  scenarios: ['twelve-stream'],
});

test('growth within max(5%, floor) passes and beyond it fails per metric', () => {
  assert.equal(compareResourceRuns(pairs({ cpu: 21, workingSet: 1_016 * MIB, p95: 1_150 * MIB })).passed, true);
  const cpu = compareResourceRuns(pairs({ cpu: 21.5 }, { cpu: 10 }));
  assert.equal(cpu.passed, false, '1.5 points above a 10% baseline exceeds the 1-point floor');
  assert.equal(cpu.scenarios[0].checks[0].allowance, 1);
  const p95 = compareResourceRuns(pairs({ p95: 1_100 * MIB + 56 * MIB }));
  assert.deepEqual(p95.scenarios[0].checks.map(check => check.passed), [true, true, false]);
  const small = compareResourceRuns(pairs({ workingSet: 100 * MIB + WORKING_SET_FLOOR_KB }, { workingSet: 100 * MIB }));
  assert.equal(small.scenarios[0].checks[1].passed, true, 'the 16 MiB floor applies to small baselines');
});

test('the gate rejects mismatched workloads, process trees, packages and non-interleaved order', () => {
  assert.throws(() => compareResourceRuns(pairs({ types: ['Browser', 'Tab'] })), /process_tree_mismatch/);
  assert.throws(() => compareResourceRuns(pairs({ measureMs: 60_000 })), /measureMs_mismatch/);
  assert.throws(() => compareResourceRuns({ ...pairs(), candidate: pairs().candidate.map(entry => ({ ...entry, packageEvidence: { archiveSha256: 'b' } })) }), /same_package/);
  assert.throws(() => compareResourceRuns({ ...pairs(), candidate: [pairs().candidate[0]] }), /unpaired/);
  assert.throws(() => compareResourceRuns(pairs({ workloadError: 'Underloaded' })), /candidate_incomplete/);
  assert.throws(() => compareResourceRuns({ ...pairs(), scenarios: ['idle'] }), /idle_missing/);
  assert.equal(assertInterleaved([{ createdAt: '2026-01-01T00:00:00Z' }, { createdAt: '2026-01-01T00:03:00Z' }],
    [{ createdAt: '2026-01-01T00:01:00Z' }, { createdAt: '2026-01-01T00:02:00Z' }]), 'BCCB');
  assert.throws(() => assertInterleaved([1, 2, 3].map(minute => ({ createdAt: `2026-01-01T00:0${minute}:00Z` })),
    [4, 5, 6].map(minute => ({ createdAt: `2026-01-01T00:0${minute}:00Z` }))), /not_interleaved/);
});

test('the CLI requires both sides and explicit scenarios', () => {
  assert.throws(() => parseResourceGateArgs(['--baseline', 'a.json']), /Usage/);
  assert.deepEqual(parseResourceGateArgs(['--scenarios', 'idle, twelve-stream', '--baseline', 'a.json', '--candidate', 'b.json']).scenarios, ['idle', 'twelve-stream']);
});
