import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUPPORTED_UPGRADE_FLOOR, gradeDataRootMigration, gradeHeldRecovery, gradeReleaseUpgrade, parseReleaseUpgradeArgs, releaseHopAdapter, selectPreviousRelease } from './release-upgrade-lane.mjs';

test('upgrades are supported from v2.1.9; older release hops are refused', () => {
  assert.equal(SUPPORTED_UPGRADE_FLOOR, 'v2.1.9');
  for (const release of ['v2.1.9', 'v2.1.10', 'v3.0.0', 'candidate', 'held-recovery']) assert.equal(releaseHopAdapter(release).statusModule, true);
  for (const release of ['v2.0.2', 'v2.0.15', 'v2.1.8']) assert.throws(() => releaseHopAdapter(release), /older than the supported upgrade floor v2\.1\.9/);
});

test('arguments default to the previous supported release and refuse retired baselines', () => {
  assert.deepEqual(parseReleaseUpgradeArgs(['--candidate-artifacts', '/a', '--keep-artifacts']), { candidateArtifacts: '/a', chain: null, hopTimeoutMs: 240000, directBaseline: 'previous' });
  assert.deepEqual(parseReleaseUpgradeArgs(['--candidate-artifacts', '/a', '--direct-baseline', 'v2.1.9']).directBaseline, 'v2.1.9');
  assert.deepEqual(parseReleaseUpgradeArgs(['--candidate-artifacts', '/a', '--chain', 'v2.1.9,v2.1.10']).chain, ['v2.1.9', 'v2.1.10']);
  for (const argv of [[], ['--candidate-artifacts', 'relative'], ['--candidate-artifacts', '/a', '--chain', 'v2.1.9,v2.1.9'],
    ['--candidate-artifacts', '/a', '--chain', 'main'], ['--candidate-artifacts', '/a', '--hop-timeout-ms', '10'], ['--other', 'x'],
    ['--candidate-artifacts', '/a', '--direct-baseline', 'v2.0.2'], ['--candidate-artifacts', '/a', '--direct-baseline', 'v2.0.15'],
    ['--candidate-artifacts', '/a', '--chain', 'v2.1.8,v2.1.9'], ['--candidate-artifacts', '/a', '--direct-baseline', 'latest'],
    ['--candidate-artifacts', '/a', '--direct-baseline', 'v2.1.9', '--chain', 'v2.1.9']]) {
    assert.throws(() => parseReleaseUpgradeArgs(argv), { code: 'qa_release_upgrade_usage' });
  }
});

test('the previous supported release is the newest published one below the candidate', () => {
  const release = (tagName, extra = {}) => ({ tagName, isDraft: false, isPrerelease: false, ...extra });
  const releases = [release('v2.1.11', { isDraft: true }), release('v2.1.10'), release('v2.1.12', { isPrerelease: true }), release('v2.1.9'), release('v2.1.8'), release('nightly')];
  assert.equal(selectPreviousRelease(releases, '2.1.11'), 'v2.1.10');
  assert.equal(selectPreviousRelease(releases, '2.1.10'), 'v2.1.9');
  assert.equal(selectPreviousRelease(releases, '2.1.9'), 'v2.1.9', 'a dry run of the floor release re-qualifies it');
  assert.equal(selectPreviousRelease([release('v2.1.8')], '2.1.10'), null);
});

const candidateManifestSha256 = 'c'.repeat(64);
const hops = [
  { release: 'v2.1.9', result: { provisioned: true, ready: true, kept: ['ses_a'], deleted: ['ses_b'] } },
  // A published upgrade that was refused, as 2.1.0 refused 2.0.30 databases, is what users have.
  { release: 'v2.1.10', result: { provisioned: true, ready: false, upgradeFailure: 'bundle_v2_upgrade_compatibility_required', kept: [], deleted: [] } },
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
  assert.match(gradeReleaseUpgrade({ hops: [{ release: 'v2.1.9', result: { provisioned: false } }], candidate, candidateManifestSha256 }).failures.join('\n'),
    /did not provision/);
});

test('direct baseline requires actual ready history rather than an empty provisioned profile', () => {
  assert.equal(gradeReleaseUpgrade({ hops: [hops[0]], candidate, candidateManifestSha256, directBaseline: true }).passed, true);
  for (const result of [{ provisioned: true, ready: false }, { ...hops[0].result, kept: [] }, { ...hops[0].result, deleted: [] }]) {
    assert.match(gradeReleaseUpgrade({ hops: [{ result }], candidate, candidateManifestSha256, directBaseline: true }).failures.join('\n'), /direct baseline/);
  }
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

test('data-root grading preserves a profile already migrated by an aging release', () => {
  const before = { legacy: { kind: 'link', target: 'devryan' },
    root: { kind: 'directory', entries: ['.devryan-migration.json', 'logs', 'release-upgrade-sentinel.json'] } };
  assert.deepEqual(gradeDataRootMigration({ before, after: before }), { passed: true, failures: [] });
  const cases = [
    [before, { ...before, legacy: { kind: 'link', target: 'elsewhere' } }, /not a link to devryan/],
    [before, { ...before, root: { kind: 'absent' } }, /not a folder/],
    [before, { ...before, root: { kind: 'directory', entries: ['.devryan-migration.json', 'logs'] } }, /missing after the move: release-upgrade-sentinel.json/],
    [before, { ...before, root: { kind: 'directory', entries: ['logs', 'release-upgrade-sentinel.json'] } }, /missing after the move: .devryan-migration.json/],
    [{ ...before, legacy: { kind: 'link', target: 'elsewhere' } }, before, /without the migration link/],
    [{ ...before, legacy: { kind: 'absent' } }, before, /without the migration link/],
    [{ ...before, root: { kind: 'absent' } }, before, /no ~\/.config\/openchamber/],
  ];
  for (const [b, a, failure] of cases) {
    const grade = gradeDataRootMigration({ before: b, after: a });
    assert.equal(grade.passed, false);
    assert.match(grade.failures.join('\n'), failure);
  }
});


test('aging cannot qualify an empty history or an unclean hop', () => {
  assert.equal(gradeReleaseUpgrade({ hops: [{ result: { provisioned: true, kept: [], deleted: [] } }],
    candidate, candidateManifestSha256 }).passed, false);
  assert.equal(gradeReleaseUpgrade({ hops, candidate: { ...candidate, cleanupErrors: ['Owned process survived'] }, candidateManifestSha256 }).passed, false);
});
