import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeDataRootMigration, gradeHeldRecovery, gradeReleaseUpgrade, parseReleaseUpgradeArgs, selectPreviousReleases } from './release-upgrade-lane.mjs';

test('arguments require absolute candidate artifacts and a distinct tag chain', () => {
  assert.deepEqual(parseReleaseUpgradeArgs(['--candidate-artifacts', '/a', '--chain', 'v2.0.15,v2.1.0', '--keep-artifacts']),
    { candidateArtifacts: '/a', chain: ['v2.0.15', 'v2.1.0'], hopTimeoutMs: 240000 });
  for (const argv of [[], ['--candidate-artifacts', 'relative'], ['--candidate-artifacts', '/a', '--chain', 'v2.1.0,v2.1.0'],
    ['--candidate-artifacts', '/a', '--chain', 'main'], ['--candidate-artifacts', '/a', '--hop-timeout-ms', '10'], ['--other', 'x']]) {
    assert.throws(() => parseReleaseUpgradeArgs(argv), { code: 'qa_release_upgrade_usage' });
  }
});

test('the chain is the newest published releases, oldest first', () => {
  const release = (tagName, publishedAt, extra = {}) => ({ tagName, publishedAt, isDraft: false, isPrerelease: false, ...extra });
  assert.deepEqual(selectPreviousReleases([release('v2.1.0', '2026-10-17T12:00:00Z'), release('v2.1.1', '2026-10-18T00:00:00Z', { isDraft: true }),
    release('v2.0.12', '2026-10-13T00:00:00Z'), release('v2.0.15', '2026-10-17T04:00:00Z'), release('v2.0.11', '2026-10-12T00:00:00Z'),
    release('nightly', '2026-10-19T00:00:00Z'), release('v2.0.16', '2026-10-17T06:00:00Z', { isPrerelease: true })]),
  ['v2.0.12', 'v2.0.15', 'v2.1.0']);
});

const candidateManifestSha256 = 'c'.repeat(64);
const hops = [
  { release: 'v2.0.15', result: { provisioned: true, ready: true, kept: ['ses_a'], deleted: ['ses_b'] } },
  // A published upgrade that was refused, as 2.1.0 refused 2.0.30 databases, is what users have.
  { release: 'v2.1.0', result: { provisioned: true, ready: false, upgradeFailure: 'bundle_v2_upgrade_compatibility_required', kept: [], deleted: [] } },
];
const candidate = { result: { upgradeFailure: null, ready: true, sessions: ['ses_a'], selected: { artifactManifestSha256: candidateManifestSha256 } } };

test('only the candidate hop must upgrade, become ready and keep history', () => {
  assert.deepEqual(gradeReleaseUpgrade({ hops, candidate, candidateManifestSha256 }), { passed: true, failures: [] });
  const failing = [
    [{ ...candidate.result, upgradeFailure: 'bundle_v2_upgrade_compatibility_required' }, /was refused/],
    [{ ...candidate.result, ready: false }, /did not become ready/],
    [{ ...candidate.result, selected: { artifactManifestSha256: 'd'.repeat(64) } }, /not the selected bundle/],
    [{ ...candidate.result, sessions: [] }, /Sessions lost.*ses_a/],
    [{ ...candidate.result, sessions: ['ses_a', 'ses_b'] }, /Deleted sessions reappeared.*ses_b/],
    [{ ...candidate.result, error: { code: 'bundle_upgrade_required', message: 'refused' } }, /Candidate startup failed/],
  ];
  for (const [result, message] of failing) {
    const grade = gradeReleaseUpgrade({ hops, candidate: { result }, candidateManifestSha256 });
    assert.equal(grade.passed, false); assert.match(grade.failures.join('\n'), message);
  }
  assert.match(gradeReleaseUpgrade({ hops: [{ release: 'v2.0.15', result: { provisioned: false } }], candidate, candidateManifestSha256 }).failures.join('\n'),
    /did not provision/);
});

test('a held selection starts only the recovery composition and resumes once the hold clears', () => {
  const held = { result: { ready: false, held: { healthStatus: 503, executionRuntime: 'held', bundleState: 'held', reconciliationRequired: true, revision: 4 } } };
  const input = { hops, held, selectionUnchanged: true, selectedRevision: 4, resumed: candidate, candidateManifestSha256 };
  assert.deepEqual(gradeHeldRecovery(input), { passed: true, failures: [] });
  const failing = [
    [{ held: { result: { ...held.result, error: { code: 'bundle_rollback_reconciliation_required', message: 'refused' } } } }, /Held startup failed/],
    [{ held: { result: { ...held.result, held: { ...held.result.held, healthStatus: 200, executionRuntime: 'ready' } } } }, /did not start the recovery composition/],
    [{ held: { result: { ...held.result, held: { ...held.result.held, revision: 5 } } } }, /did not report the held selection/],
    [{ held: { result: { ...held.result, ready: true } } }, /reported a ready runtime/],
    [{ selectionUnchanged: false }, /changed the selection/],
    [{ resumed: { result: { ...candidate.result, sessions: [] } } }, /After the hold cleared: Sessions lost.*ses_a/],
    [{ resumed: { result: { ...candidate.result, ready: false } } }, /After the hold cleared: .*did not become ready/],
  ];
  for (const [override, message] of failing) {
    const grade = gradeHeldRecovery({ ...input, ...override });
    assert.equal(grade.passed, false); assert.match(grade.failures.join('\n'), message);
  }
});

test('data-root grading requires the aged folder to move whole and leave a devryan link', () => {
  const before = { legacy: { kind: 'directory', entries: ['logs', 'release-upgrade-sentinel.json'] }, root: { kind: 'absent' } };
  const after = { legacy: { kind: 'link', target: 'devryan' }, root: { kind: 'directory', entries: ['.devryan-migration.json', 'logs', 'release-upgrade-sentinel.json'] } };
  assert.deepEqual(gradeDataRootMigration({ before, after }), { passed: true, failures: [] });
  const cases = [
    [{ ...before, legacy: { kind: 'absent' } }, after, /no ~\/.config\/openchamber/],
    [{ ...before, root: { kind: 'directory', entries: [] } }, after, /existed before/],
    [before, { ...after, legacy: { kind: 'directory', entries: [] } }, /not a link/],
    [before, { ...after, root: { kind: 'directory', entries: ['logs'] } }, /missing after the move: release-upgrade-sentinel.json/],
  ];
  for (const [b, a, failure] of cases) assert.match(gradeDataRootMigration({ before: b, after: a }).failures.join('\n'), failure);
});
