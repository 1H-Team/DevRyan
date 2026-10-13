import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_STARTUP_SCENARIOS, assertReleaseNavigationPhase, assertReleaseStartupReceipt, selectReleaseStartupBaselines } from './release-startup-contract.mjs';
const d = 'a'.repeat(64), sourceCommit = 'b'.repeat(40);
const expectation = { sourceCommit, dmgSha256: d, version: '2.0.9' };
const screenshot = () => ({ name: 'DevRyan-startup-fixture.png', sha256: d, ...expectation, manifestSha256: d, appSha256: d });
const launchEvidence = () => ({ forcedCleanup: false, afterStop: {
  locks: { owner: { state: 'missing' }, mutation: { state: 'missing' } },
  process: { remainingProcessIds: [], observationErrors: [], trackingClosed: true },
}, navigation: [{ name: 'startup', limit: 3, documents: [{}] }] });
const receipt = () => ({ protocol: 'devryan.release-startup/1', outcome: 'passed', ...expectation, manifestSha256: d, appSha256: d,
  forcedServiceCleanup: false, baselineRelaunches: 0,
  platform: 'darwin-arm64', runAttempt: 1, compiledNative: 'passed', guiPrerequisites: 'passed', cleanupErrors: [], scenarios: RELEASE_STARTUP_SCENARIOS.map((id,index) => ({
    id, outcome: 'passed', attempts: 1, gapRecords: 0, cleanup: 'passed', elapsedMs: 1, manifestSha256: d,
    usableChat: true, eventStream: 'acknowledged', submission: 'passed', baselineVersion: `2.0.${index}`, baselineDmgSha256: d, dataPreserved: true,
    transition: 'upgraded', stableReopen: true, setupInterface: true, liveOwnerProtected: true,
    launches: [launchEvidence()], tampered: { integrityRejected: true, usable: false, selectionPreserved: true, databaseBefore: d, databaseAfter: d },
    screenshots: [screenshot()], failureCode: 'bundle_execution_unsettled', recoveryPrepared: true, sameBootRefused: true, selectionPreserved: true,
  })) });
test('publication rejects incomplete, stale, substituted, retried and unavailable startup evidence', () => {
  assertReleaseStartupReceipt(receipt(), expectation);
  for (const change of [{ outcome: 'unavailable' }, { runAttempt: 2 }, { compiledNative: 'failed' }, { guiPrerequisites: 'unavailable' }, { sourceCommit: 'c'.repeat(40) },
    { dmgSha256: 'c'.repeat(64) }, { cleanupErrors: ['owner_alive'] }, { platform: 'darwin-x64' }, { manifestSha256: null }])
    assert.throws(() => assertReleaseStartupReceipt({ ...receipt(), ...change }, expectation));
  for (const change of [{ attempts: 2 }, { gapRecords: 1 }, { cleanup: 'failed' }, { usableChat: false },
    { submission: 'not-run' }, { eventStream: 'unavailable' }, { manifestSha256: 'c'.repeat(64) }, { elapsedMs: NaN }]) {
    const value = receipt(); Object.assign(value.scenarios[0], change);
    assert.throws(() => assertReleaseStartupReceipt(value, expectation));
  }
  for (const id of RELEASE_STARTUP_SCENARIOS) {
    const value = receipt(); value.scenarios = value.scenarios.filter(row => row.id !== id);
    assert.throws(() => assertReleaseStartupReceipt(value, expectation));
  }
});
test('publication rejects screenshots from another source without requiring reboot evidence', () => {
  assertReleaseStartupReceipt(receipt(), expectation);
  const replacedImage = receipt(); replacedImage.scenarios[0].screenshots[0].sourceCommit = 'c'.repeat(40);
  assert.throws(() => assertReleaseStartupReceipt(replacedImage, expectation));
});
test('baseline selection requires the last two stable releases and their published installer digests', () => {
  const release = version => ({ tag_name: `v${version}`, assets: [{ name: `DevRyan-${version}-arm64.dmg`, digest: `sha256:${d}` }] });
  const releases = [release('2.0.6'), release('2.0.9'), release('2.0.7'), { ...release('2.0.10'), draft: true }, release('2.0.8')];
  assert.deepEqual(selectReleaseStartupBaselines(releases, '2.0.9').map(row => row.version), ['2.0.8','2.0.7']);
  releases.at(-1).assets[0].digest = null;
  assert.throws(() => selectReleaseStartupBaselines(releases, '2.0.9'));
});


test('receipt validation rejects unauthenticated navigation allowance and inflated limits', () => {
  const phase = { name: 'startup', limit: 3, documents: [
    { url: 'data:startup-document', loaderId: 'splash' },
    { url: 'http://127.0.0.1:1234/', loaderId: 'app' },
    { url: 'http://127.0.0.1:1234/', loaderId: 'auth', authenticationReload: {
      origin: 'http://127.0.0.1:1234', previousPrincipal: 'missing', principal: 'local-admin', sourceLoaderId: 'app',
    } },
    { url: 'http://127.0.0.1:1234/', loaderId: 'ready' },
  ] };
  assertReleaseNavigationPhase(phase);
  for (const change of [
    row => { row.limit = 4; },
    row => { delete row.documents[2].authenticationReload; },
    row => { row.documents[2].authenticationReload.principal = 'another-user'; },
    row => { row.documents[2].authenticationReload.previousPrincipal = 'local-admin'; },
    row => { row.documents[2].authenticationReload.sourceLoaderId = 'different'; },
    row => { row.documents[2].authenticationReload.origin = 'http://127.0.0.1:9999'; },
    row => { row.documents.push({ ...row.documents[2], loaderId: 'loop' }); },
  ]) {
    const changed = structuredClone(phase); change(changed);
    assert.throws(() => assertReleaseNavigationPhase(changed));
  }
});
