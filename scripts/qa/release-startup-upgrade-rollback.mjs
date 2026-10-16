// Separate pre-tag qualification: the short GUI smoke never claims upgrade or rollback.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRunRoot, removeRunPayloads } from './run-root.mjs';
import { requireDisposableMacRunner } from './macos-gui-prerequisites.mjs';
import { inspectReleaseDmg, downloadStartupRelease } from './release-startup-artifacts.mjs';
import { githubReleaseClient } from '../release-publication.mjs';

const requiredCases = ['compiled-clone-layout-legacy', 'compiled-clone-layout-fresh-install',
  'compiled-fresh-install-clone', 'compiled-fresh-install-rollback', 'candidate-work-rollback-retention'];
export function assertReleaseUpgradeRollbackReceipt(receipt, identity) {
  assert.equal(receipt?.protocol, 'devryan.release-upgrade-rollback/1'); assert.equal(receipt.outcome, 'passed');
  for (const key of ['sourceCommit', 'version', 'dmgSha256']) assert.equal(receipt[key], identity[key]);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(receipt.baseline?.sourceCommit ?? '', /^[a-f0-9]{40}$/);
  assert.match(receipt.baseline?.version ?? '', /^2\.\d+\.\d+$/);
  for (const digest of [receipt.dmgSha256, receipt.manifestSha256, receipt.baseline.dmgSha256, receipt.baseline.manifestSha256]) assert.match(digest ?? '', /^[a-f0-9]{64}$/);
  assert.equal(receipt.diagnostic, false); assert.equal(receipt.attempts, 1); assert.equal(receipt.safeCleanup, true);
  assert.deepEqual(receipt.cleanupErrors, []); assert.equal(receipt.sourceChanged, false);
  for (const id of requiredCases) assert.equal(receipt.cases.filter(row => row.id === id && row.status === 'passed').length, 1);
  return receipt;
}
export async function runReleaseUpgradeRollback({ dmg, metadata, baseline, receiptPath }) {
  requireDisposableMacRunner(); assert.equal(metadata.sourceCommit, process.env.GITHUB_SHA);
  assert.equal(Number(process.env.GITHUB_RUN_ATTEMPT), 1, 'Upgrade/rollback product or fixture failures cannot be retried');
  const client = githubReleaseClient(); await client.frozenTag(baseline.version, baseline.sourceCommit);
  const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const run = createRunRoot({ parent: path.join(repository, '.cache/release-upgrade-rollback'), owner: 'release-upgrade-rollback', extraPayloads: ['downloads', 'installations'] });
  const receipt = { protocol: 'devryan.release-upgrade-rollback/1', sourceCommit: metadata.sourceCommit, version: metadata.version, dmgSha256: metadata.dmgSha256,
    baseline, diagnostic: false, attempts: 1, outcome: 'failed', safeCleanup: false, cleanupErrors: [], cases: [] };
  try {
    const input = await downloadStartupRelease({ version: baseline.version, directory: path.join(run.dir, 'downloads') });
    assert.equal(input.expectedSha256, baseline.dmgSha256, 'Frozen baseline installer digest changed');
    const previous = await inspectReleaseDmg({ ...input, purpose: 'bundle-source', directory: path.join(run.dir, 'installations/baseline') });
    const candidate = await inspectReleaseDmg({ dmg, version: metadata.version, expectedSha256: metadata.dmgSha256, directory: path.join(run.dir, 'installations/candidate') });
    receipt.manifestSha256 = candidate.manifestSha256; receipt.baseline = { ...baseline, manifestSha256: previous.manifestSha256 };
    const { runNativePackageAcceptance } = await import('../verify-opencode-v2-package.mjs');
    const result = await runNativePackageAcceptance({ artifactRoot: candidate.artifactRoot, baselineArtifactRoot: previous.artifactRoot });
    assert.equal(result.status, 'passed'); assert.equal(result.diagnostic, false); assert.equal(result.preflight, false);
    assert.deepEqual(result.cleanupFailures, []); assert.deepEqual(result.sourceCohort.changedPaths, []);
    receipt.sourceChanged = false; receipt.cases = result.cases.map(({ id, status }) => ({ id, status }));
    await client.frozenTag(baseline.version, baseline.sourceCommit); receipt.outcome = 'passed';
  } catch (error) { receipt.error = /^[a-z_]{1,100}$/.test(error.code ?? '') ? error.code : 'release_upgrade_rollback_failed'; }
  finally {
    try { removeRunPayloads(run.dir, { extra: ['downloads', 'installations'] }); receipt.safeCleanup = true; }
    catch { receipt.cleanupErrors.push('payload_cleanup_failed'); receipt.outcome = 'failed'; }
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); run.finish(receipt.outcome);
  }
  if (receipt.outcome === 'passed') assertReleaseUpgradeRollbackReceipt(receipt, metadata);
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { dmg: { type: 'string' }, metadata: { type: 'string' }, baseline: { type: 'string' }, receipt: { type: 'string' } }, strict: true });
  const read = file => fs.readFile(file, 'utf8').then(JSON.parse);
  const result = await runReleaseUpgradeRollback({ dmg: path.resolve(values.dmg), metadata: await read(values.metadata), baseline: await read(values.baseline), receiptPath: path.resolve(values.receipt) });
  process.exitCode = result.outcome === 'passed' ? 0 : 1;
}
