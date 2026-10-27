// Serial installed Electron qualification on an isolated macOS host. Candidate
// mode redirects transport only inside the inspected test process; public mode
// exercises the unchanged public feed after promotion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubClient } from '../release-github.mjs';
import { SUPPORTED_INSTALLED_FLOOR, installedVersionsBefore } from '../release-state.mjs';
import { runVisualQa } from './release-visual-qa.mjs';

export function installedUpgradeBaselines(releases, version, { previousOnly = false } = {}) {
  const versions = installedVersionsBefore(releases, version);
  const published = new Set(releases.filter(row => row.draft === false && row.prerelease === false).map(row => row.tag_name?.slice(1)));
  if (!published.has(SUPPORTED_INSTALLED_FLOOR)) throw new Error('Supported floor has no published baseline');
  const available = versions.filter(value => published.has(value));
  if (!available.length) throw new Error('No supported installed release predates the candidate');
  // The floor and the most recent app. Updater and installer code is byte-identical
  // across the supported range and the installer pins are checked in preflight,
  // so an intervening baseline added time, not coverage. After publication only
  // the previous app is repeated against the public feed.
  return previousOnly ? [available.at(-1)] : [...new Set([available[0], available.at(-1)])];
}

export async function runInstalledUpgrades(options, { releases, qualify = runVisualQa } = {}) {
  const versions = installedUpgradeBaselines(releases, options.version, { previousOnly: !options.candidateUpgrade });
  const results = [];
  await fs.mkdir(path.dirname(options.report), { recursive: true });
  try {
    for (const from of versions) {
      const report = path.join(path.dirname(options.report), `from-${from}`, 'report.json');
      const result = await qualify({ dmg: options.dmg, manifest: options.manifest, version: options.version,
        upgradeFrom: `v${from}`, candidateUpgrade: options.candidateUpgrade, requireUpgrade: true, upgradeOnly: true,
        isolatedHost: options.isolatedHost, report });
      results.push({ from, passed: result.passed === true && result.upgrade?.status === 'passed', report,
        failures: result.failures ?? [], upgrade: result.upgrade ?? null });
      if (!results.at(-1).passed) break;
    }
    return { passed: results.length === versions.length && results.every(row => row.passed), baselines: versions, results };
  } finally {
    await fs.writeFile(options.report, `${JSON.stringify({ schemaVersion: 1, kind: 'installed-electron-upgrades',
      version: options.version, transport: options.candidateUpgrade ? 'isolated-inspector-fixture' : 'public-feed',
      passed: results.length === versions.length && results.every(row => row.passed), baselines: versions, results }, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, dmg, manifest, report, mode] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || ![dmg, manifest, report].every(value => value && path.isAbsolute(value)) || !['candidate', 'public'].includes(mode)) {
    throw new Error('Usage: release-installed-upgrades.mjs X.Y.Z <absolute dmg> <absolute manifest> <absolute report> candidate|public');
  }
  const client = githubClient({ token: process.env.GITHUB_TOKEN, anonymous: !process.env.GITHUB_TOKEN,
    environment: { RELEASE_DRY_RUN: 'true' } });
  const result = await runInstalledUpgrades({ version, dmg, manifest, report, candidateUpgrade: mode === 'candidate' },
    { releases: await client.paginate('/releases') });
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
}
