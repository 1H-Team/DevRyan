// Release upgrade qualification as one job: every required lane (today only
// the previous supported release) runs against one extracted candidate
// runtime. Each lane is its own process with its own private run root, profile and report
// (release-upgrade-lane.mjs); the candidate runtime is shared read-only input,
// and a tree digest taken before and after proves no lane changed it.
// Usage: node scripts/qa/release-upgrade-lanes.mjs --candidate-artifacts <abs dir> --report-dir <abs dir> [--sequential]
//        node scripts/qa/release-upgrade-lanes.mjs --report-dir <abs dir> --fallback-reports
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTestUnits, summarizeTestUnits } from '../test-pool.mjs';

// Node built-ins only (test-pool.mjs too): the fallback-report step must work
// even when dependency installation failed.
/** Upgrades are qualified from the previous supported release only (SUPPORTED_UPGRADE_FLOOR and later). */
export const REQUIRED_UPGRADE_LANES = Object.freeze(['previous']);
const lanePath = fileURLToPath(new URL('./release-upgrade-lane.mjs', import.meta.url));
const USAGE = 'Usage: node scripts/qa/release-upgrade-lanes.mjs --candidate-artifacts <abs dir> --report-dir <abs dir> [--sequential] | --report-dir <abs dir> --fallback-reports';

export function parseUpgradeLanesArgs(argv) {
  const options = { sequential: false, fallbackReports: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--sequential') { options.sequential = true; continue; }
    if (flag === '--fallback-reports') { options.fallbackReports = true; continue; }
    const value = argv[index + 1];
    if (!['--candidate-artifacts', '--report-dir'].includes(flag) || !value || value.startsWith('--')) throw new Error(USAGE);
    if (!path.isAbsolute(value)) throw new Error(`${flag} must be absolute`);
    options[flag === '--report-dir' ? 'reportDirectory' : 'candidateArtifacts'] = value;
    index += 1;
  }
  if (!options.reportDirectory || (!options.fallbackReports && !options.candidateArtifacts)) throw new Error(USAGE);
  return options;
}

export const laneReport = (reportDirectory, lane) => path.join(reportDirectory, `upgrade-${lane}.json`);

export function upgradeLaneUnits({ candidateArtifacts, reportDirectory }) {
  return REQUIRED_UPGRADE_LANES.map(lane => ({ name: `upgrade:${lane}`, command: process.execPath, args: [lanePath,
    '--candidate-artifacts', candidateArtifacts, '--report', laneReport(reportDirectory, lane), '--direct-baseline', lane] }));
}

/** Content digest of a directory tree: relative paths, types, modes, symlink targets and file bytes. */
export async function treeDigest(root) {
  const hash = createHash('sha256');
  const walk = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), relative = path.relative(root, file), info = await lstat(file);
      hash.update(`${relative}\0${info.mode}\0`);
      if (info.isSymbolicLink()) hash.update(`link:${await readlink(file)}\0`);
      else if (info.isDirectory()) await walk(file);
      else hash.update(await readFile(file));
    }
  };
  await walk(root);
  return hash.digest('hex');
}

/** A lane that could not write its own report still leaves a failing, incomplete one. */
export async function writeMissingReports(reportDirectory, { environment = process.env } = {}) {
  await mkdir(reportDirectory, { recursive: true });
  const written = [];
  for (const lane of REQUIRED_UPGRADE_LANES) {
    const file = laneReport(reportDirectory, lane);
    if (await stat(file).catch(() => null)) continue;
    await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: 'release-upgrade-lane', sourceRevision: environment.GITHUB_SHA ?? null,
      runID: environment.GITHUB_RUN_ID ?? null, directBaseline: lane, passed: false,
      failures: ['Qualification did not complete; inspect the failed setup step'] }) + '\n');
    written.push(lane);
  }
  return written;
}

export async function runUpgradeLanes({ candidateArtifacts, reportDirectory, sequential = false, run = runTestUnits, log = console.log }) {
  await mkdir(reportDirectory, { recursive: true });
  const before = await treeDigest(candidateArtifacts);
  const units = upgradeLaneUnits({ candidateArtifacts, reportDirectory });
  const outcome = await run(units, { concurrency: sequential ? 1 : units.length, label: 'upgrade', heartbeatMs: 60_000 });
  summarizeTestUnits(outcome, { label: 'upgrade', log });
  const missing = await writeMissingReports(reportDirectory);
  const failures = outcome.results.filter(row => row.status !== 'passed').map(row => `${row.name} ${row.status}`);
  if (missing.length) failures.push(`No report from: ${missing.join(', ')}`);
  if (await treeDigest(candidateArtifacts) !== before) failures.push('The shared candidate runtime changed during qualification');
  for (const failure of failures) log(`[upgrade] ${failure}`);
  return { passed: failures.length === 0, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseUpgradeLanesArgs(process.argv.slice(2));
    if (options.fallbackReports) {
      const written = await writeMissingReports(options.reportDirectory);
      if (written.length) console.log(`[upgrade] incomplete report(s) for: ${written.join(', ')}`);
    } else {
      process.exitCode = (await runUpgradeLanes(options)).passed ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
