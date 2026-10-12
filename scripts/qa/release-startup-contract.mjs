import assert from 'node:assert/strict';

export const RELEASE_STARTUP_SCENARIOS = Object.freeze([
  'empty-profile', 'unchanged-reopen', 'upgrade-previous', 'upgrade-second-previous',
  'same-runtime-upgrade', 'service-cold', 'service-warm', 'stale-owner', 'interrupted-upgrade', 'rejected-candidate',
]);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Publication consumes only the exact DMG's complete, non-retried receipt. */
export function assertReleaseStartupReceipt(receipt, { sourceCommit, dmgSha256, version }) {
  assert.equal(receipt?.protocol, 'devryan.release-startup/1');
  assert.equal(receipt.outcome, 'passed');
  assert.equal(receipt.runAttempt, 1);
  assert.equal(receipt.compiledNative, 'passed');
  assert.equal(receipt.sourceCommit, sourceCommit);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(receipt.version, version);
  assert.equal(receipt.dmgSha256, dmgSha256);
  assert.ok(digest(receipt.dmgSha256) && digest(receipt.manifestSha256) && digest(receipt.appSha256));
  assert.equal(receipt.platform, 'darwin-arm64');
  assert.equal(receipt.guiPrerequisites, 'passed');
  assert.deepEqual(receipt.cleanupErrors, []);
  assert.deepEqual(receipt.scenarios.map(row => row.id).sort(), [...RELEASE_STARTUP_SCENARIOS].sort());
  for (const row of receipt.scenarios) {
    assert.equal(row.outcome, 'passed', row.id);
    assert.equal(row.attempts, 1, row.id);
    assert.equal(row.gapRecords, 0, row.id);
    assert.equal(row.cleanup, 'passed', row.id);
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0, row.id);
    assert.ok(digest(row.manifestSha256), row.id);
    assert.equal(row.manifestSha256, receipt.manifestSha256, row.id);
    assert.equal(row.usableChat, true, row.id);
    assert.equal(row.submission, 'passed', row.id);
    assert.equal(row.eventStream, 'acknowledged', row.id);
    if (row.id.startsWith('upgrade-')) {
      assert.match(row.baselineVersion, /^2\.\d+\.\d+$/);
      assert.ok(digest(row.baselineDmgSha256), row.id);
      assert.equal(row.dataPreserved, true);
      assert.ok(['unchanged', 'upgraded'].includes(row.transition));
      assert.equal(row.stableReopen, true);
    }
    if (row.id === 'same-runtime-upgrade') { assert.equal(row.transition, 'upgraded'); assert.equal(row.stableReopen, true); }
    if (row.id === 'empty-profile') assert.equal(row.setupInterface, true);
    if (row.id === 'stale-owner') assert.equal(row.liveOwnerProtected, true);
  }
  assert.notEqual(receipt.scenarios.find(row => row.id === 'upgrade-previous').baselineVersion,
    receipt.scenarios.find(row => row.id === 'upgrade-second-previous').baselineVersion);
  return receipt;
}

export function selectReleaseStartupBaselines(releases, candidateVersion) {
  assert.match(candidateVersion, /^2\.\d+\.\d+$/);
  const compare = (left, right) => {
    const a = left.split('.').map(Number), b = right.split('.').map(Number);
    for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
  };
  const candidates = releases.filter(release => !release.draft && !release.prerelease && /^v2\.\d+\.\d+$/.test(release.tag_name)
    && compare(release.tag_name.slice(1), candidateVersion) < 0).sort((a, b) => compare(b.tag_name.slice(1), a.tag_name.slice(1)));
  const selected = candidates.slice(0, 2).map(release => {
    const version = release.tag_name.slice(1), name = `DevRyan-${version}-arm64.dmg`;
    const assets = release.assets.filter(asset => asset.name === name);
    assert.equal(assets.length, 1, `Missing baseline ${name}`);
    assert.match(assets[0].digest ?? '', /^sha256:[a-f0-9]{64}$/, 'Baseline must have a published digest');
    return { version, tag: release.tag_name, name, sha256: assets[0].digest.slice(7) };
  });
  assert.equal(selected.length, 2, 'Two published baseline installers are required');
  return selected;
}
