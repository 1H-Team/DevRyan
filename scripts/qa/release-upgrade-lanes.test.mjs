import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REQUIRED_UPGRADE_LANES, laneReport, parseUpgradeLanesArgs, runUpgradeLanes, treeDigest, upgradeLaneUnits, writeMissingReports } from './release-upgrade-lanes.mjs';

const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'devryan-upgrade-lanes-'));

test('one job qualifies the upgrade from the previous supported release only', () => {
  assert.deepEqual(REQUIRED_UPGRADE_LANES, ['previous']);
  const units = upgradeLaneUnits({ candidateArtifacts: '/c', reportDirectory: '/r' });
  assert.deepEqual(units.map(unit => unit.name), ['upgrade:previous']);
  assert.deepEqual(units.map(unit => unit.args.slice(1)), [['--candidate-artifacts', '/c', '--report', '/r/upgrade-previous.json', '--direct-baseline', 'previous']]);
  assert.ok(units.every(unit => unit.args[0].endsWith('scripts/qa/release-upgrade-lane.mjs')));
  assert.deepEqual(parseUpgradeLanesArgs(['--candidate-artifacts', '/c', '--report-dir', '/r']), { sequential: false, fallbackReports: false, candidateArtifacts: '/c', reportDirectory: '/r' });
  assert.throws(() => parseUpgradeLanesArgs(['--report-dir', '/r']), /Usage/);
  assert.throws(() => parseUpgradeLanesArgs(['--candidate-artifacts', 'relative', '--report-dir', '/r']), /absolute/);
  assert.throws(() => parseUpgradeLanesArgs(['--candidate-artifacts', '/c', '--report-dir', '/r', '--baselines', 'aging']), /Usage/);
});

test('a lane without its own report leaves a failing incomplete report', async () => {
  const directory = scratch();
  try {
    assert.deepEqual(await writeMissingReports(directory, { environment: { GITHUB_SHA: 'a'.repeat(40) } }), ['previous']);
    const missing = JSON.parse(readFileSync(laneReport(directory, 'previous'), 'utf8'));
    assert.equal(missing.passed, false);
    assert.equal(missing.directBaseline, 'previous');
    writeFileSync(laneReport(directory, 'previous'), '{"passed":true}\n');
    assert.deepEqual(await writeMissingReports(directory), []);
    assert.equal(readFileSync(laneReport(directory, 'previous'), 'utf8'), '{"passed":true}\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the shared candidate digest covers bytes, modes and links, and any lane failure fails the job', async () => {
  const directory = scratch();
  try {
    const candidate = path.join(directory, 'candidate'), reports = path.join(directory, 'reports');
    mkdirSync(candidate);
    writeFileSync(path.join(candidate, 'native-bundle.json'), '{}');
    symlinkSync('native-bundle.json', path.join(candidate, 'link'));
    const digest = await treeDigest(candidate);
    const passing = async (units) => {
      for (const unit of units) writeFileSync(unit.args[unit.args.indexOf('--report') + 1], '{"passed":true}\n');
      return { passed: true, wallMs: 1, results: units.map(unit => ({ name: unit.name, status: 'passed', durationMs: 1 })) };
    };
    assert.deepEqual(await runUpgradeLanes({ candidateArtifacts: candidate, reportDirectory: reports, run: passing, log: () => {} }), { passed: true, failures: [] });
    const mutating = async (units) => { writeFileSync(path.join(candidate, 'native-bundle.json'), '{"changed":true}'); return passing(units); };
    const mutated = await runUpgradeLanes({ candidateArtifacts: candidate, reportDirectory: reports, run: mutating, log: () => {} });
    assert.deepEqual(mutated.failures, ['The shared candidate runtime changed during qualification']);
    assert.notEqual(await treeDigest(candidate), digest);
    rmSync(reports, { recursive: true });
    const oneFails = async (units) => ({ passed: false, wallMs: 1, results: units.map(unit => ({ name: unit.name, status: 'failed', durationMs: 1 })) });
    let concurrency;
    const failed = await runUpgradeLanes({ candidateArtifacts: candidate, reportDirectory: reports, log: () => {},
      run: async (units, options) => { concurrency = options.concurrency; return oneFails(units); } });
    assert.equal(concurrency, 1);
    assert.deepEqual(failed.failures, ['upgrade:previous failed', 'No report from: previous']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
