// Profiles and baseline inputs stay on this runner. Only sanitized reports leave it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRunRoot, scratchParent } from './run-root.mjs';
import { createPhaseTimings } from './phase-timings.mjs';
import { withMountedDmg } from './mounted-dmg.mjs';
import { runUpgradeCommand as execute, stopUpgradeChildren } from './upgrade-processes.mjs';
import { createBaselineInputs, finishUpgradeScratch, prepareReleaseUpgradeLane } from './release-upgrade-lane.mjs';
import { REQUIRED_UPGRADE_LANES, laneReport, treeDigest, writeMissingReports } from './release-upgrade-lanes.mjs';
import { CANDIDATE_ARTIFACT, CANDIDATE_IDENTITY_ARTIFACT, waitForCandidate, verifyCandidate } from '../release-candidate.mjs';

async function acquireCandidate(root, environment) {
  const { identity } = await waitForCandidate({ environment });
  const download = path.join(root, 'candidate'), mount = path.join(root, 'mount'), target = path.join(root, 'runtime');
  await mkdir(download); await mkdir(mount);
  for (const name of [CANDIDATE_ARTIFACT, CANDIDATE_IDENTITY_ARTIFACT]) await execute('gh', ['run', 'download', identity.runID, '--repo', '1H-Team/DevRyan', '--name', name, '--dir', download], { timeout: 180_000 });
  const dmg = await verifyCandidate(download, identity);
  await withMountedDmg(dmg, mount, () => execute('ditto', [path.join(mount, 'DevRyan.app/Contents/Resources/revert-runtime/darwin-arm64'), target], { timeout: 120_000 }));
  return target;
}

export async function runPreagedUpgrades({ reportDirectory, environment = process.env,
  prepare = prepareReleaseUpgradeLane, acquire = acquireCandidate, digest = treeDigest } = {}) {
  const timings = createPhaseTimings();
  const root = createRunRoot({ parent: scratchParent('release-upgrade'), owner: 'release-preaged-upgrades', onInterrupt: stopUpgradeChildren });
  const prepared = [], results = [];
  let passed = false;
  try {
    const prepareInput = createBaselineInputs(root.dir);
    // The oldest released controller has a tight boot budget: start it before the larger aging inputs.
    for (const lane of ['v2.0.2', ...REQUIRED_UPGRADE_LANES.filter(lane => lane !== 'v2.0.2')]) {
      prepared.push(await prepare({ directBaseline: lane === 'aging' ? undefined : lane, hopTimeoutMs: 240_000,
        report: laneReport(reportDirectory, lane), prepareInput }));
    }
    const candidate = await timings.measure('candidate-wait-download-extract', () => acquire(root.dir, environment));
    const before = await digest(candidate);
    // Cold native starts, including held recovery, never overlap.
    for (const profile of prepared) results.push(await profile.qualify(candidate));
    if (await digest(candidate) !== before) throw new Error('Candidate runtime changed during qualification');
    passed = results.every(result => result.passed);
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
  } catch {
    console.error('Release upgrade qualification failed; inspect phase timings and sanitized reports.');
    process.exitCode = 1;
  }
}
