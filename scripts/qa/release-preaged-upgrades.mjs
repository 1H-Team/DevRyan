// Profiles and baseline inputs stay on this runner. Only sanitized reports leave it.
// Setup failures are classified (release-qualification-failure.mjs): an
// infrastructure failure is retried once, a product failure never.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRunRoot, scratchParent } from './run-root.mjs';
import { createPhaseTimings } from './phase-timings.mjs';
import { withMountedDmg } from './mounted-dmg.mjs';
import { runUpgradeCommand as execute, stopUpgradeChildren } from './upgrade-processes.mjs';
import { createBaselineInputs, finishUpgradeScratch, prepareReleaseUpgradeLane } from './release-upgrade-lane.mjs';
import { REQUIRED_UPGRADE_LANES, laneReport, treeDigest, writeMissingReports } from './release-upgrade-lanes.mjs';
import { classifyQualificationFailure, describeQualificationError, retryInfraOnce } from './release-qualification-failure.mjs';
import { CANDIDATE_ARTIFACT, CANDIDATE_IDENTITY_ARTIFACT, waitForCandidate, verifyCandidate } from '../release-candidate.mjs';

async function acquireCandidate(root, environment, attempt = 1) {
  const { identity } = await waitForCandidate({ environment });
  const download = path.join(root, `candidate-${attempt}`), mount = path.join(root, `mount-${attempt}`), target = path.join(root, 'runtime');
  await mkdir(download); await mkdir(mount);
  for (const name of [CANDIDATE_ARTIFACT, CANDIDATE_IDENTITY_ARTIFACT]) await execute('gh', ['run', 'download', identity.runID, '--repo', '1H-Team/DevRyan', '--name', name, '--dir', download], { timeout: 180_000 });
  const dmg = await verifyCandidate(download, identity);
  await withMountedDmg(dmg, mount, () => execute('ditto', [path.join(mount, 'DevRyan.app/Contents/Resources/revert-runtime/darwin-arm64'), target], { timeout: 120_000 }));
  return target;
}

export async function runPreagedUpgrades({ reportDirectory, environment = process.env,
  prepare = prepareReleaseUpgradeLane, acquire = acquireCandidate, digest = treeDigest, log = console.log } = {}) {
  const timings = createPhaseTimings();
  const root = createRunRoot({ parent: scratchParent('release-upgrade'), owner: 'release-preaged-upgrades', onInterrupt: stopUpgradeChildren });
  const prepared = [], results = [];
  let passed = false;
  try {
    const prepareInput = createBaselineInputs(root.dir);
    for (const lane of REQUIRED_UPGRADE_LANES) {
      prepared.push(await retryInfraOnce(`prepare:${lane}`, () => prepare({ directBaseline: lane, hopTimeoutMs: 240_000,
        report: laneReport(reportDirectory, lane), prepareInput }), { log, runRoot: root.dir }));
    }
    const candidate = await timings.measure('candidate-wait-download-extract',
      () => retryInfraOnce('candidate-download', attempt => acquire(root.dir, environment, attempt), { log, runRoot: root.dir }));
    const before = await digest(candidate);
    // Cold native starts, including held recovery, never overlap. A failing
    // candidate hop is a product failure and is not retried.
    for (const profile of prepared) results.push(await profile.qualify(candidate));
    if (await digest(candidate) !== before) throw Object.assign(new Error('Candidate runtime changed during qualification'), { qualificationClass: 'product' });
    passed = results.every(result => result.passed);
    for (const result of results.filter(row => !row.passed)) log(`[qualification] product failure: ${(result.failures ?? []).join('; ')}`);
    return { passed, results };
  } finally {
    const cleanup = await Promise.allSettled(prepared.map(profile => profile.cleanup()));
    timings.measureSync('shared-input-scratch-cleanup', () => finishUpgradeScratch(root, passed ? 'passed' : 'failed'));
    await writeMissingReports(reportDirectory, { environment });
    await writeFile(path.join(reportDirectory, 'qualification-timings.json'), JSON.stringify({ passed: passed && cleanup.every(result => result.status === 'fulfilled'),
      sourceRevision: environment.GITHUB_SHA ?? null, runID: environment.GITHUB_RUN_ID ?? null, phases: timings.phases }) + '\n');
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('Profile cleanup failed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('exit', () => console.log(`[qualification] process-exit: ${Math.round(process.uptime() * 1000)}ms total`));
  try {
    const reportDirectory = process.argv[2];
    if (!path.isAbsolute(reportDirectory ?? '')) throw new Error('Absolute report directory required');
    process.exitCode = (await runPreagedUpgrades({ reportDirectory })).passed ? 0 : 1;
  } catch (error) {
    console.error(`Release upgrade qualification failed (${classifyQualificationFailure(error)}): ${describeQualificationError(error)}. Inspect the phase timings and sanitized reports.`);
    process.exitCode = 1;
  }
}
