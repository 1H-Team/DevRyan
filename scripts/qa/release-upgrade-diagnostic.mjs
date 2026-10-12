import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunRoot } from './run-root.mjs';
import { downloadStartupRelease, inspectReleaseDmg } from './release-startup-artifacts.mjs';
import { createReleaseStartupProfile } from './release-startup-profile.mjs';
import { launchReleaseStartup, verifyReleaseJournal } from './release-startup-launch.mjs';
import { readBundleStartupState, assertNativeStartupUpgrade, readNativeStartupLogs } from './native-startup-benchmark.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { requireDisposableMacRunner, probeDisposableMacGui } from './macos-gui-prerequisites.mjs';

/** Historical app-bound reproduction cannot issue a release qualification receipt. */
export async function runReleaseUpgradeDiagnostic(fromVersion, toVersion) {
  requireDisposableMacRunner();
  assert.equal((await probeDisposableMacGui()).status, 'passed');
  for (const version of [fromVersion, toVersion]) assert.match(version ?? '', /^2\.\d+\.\d+$/);
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  let active, profile;
  const stop = async () => { const current = active; active = null; await current?.stop(); };
  const run = createRunRoot({ parent: path.join(repository, '.cache/release-startup'), prefix: 'historical-',
    owner: 'release-upgrade-diagnostic', extraPayloads: ['downloads', 'installations', 'profile'],
    onInterrupt: async () => { await stop(); await profile?.close(); } });
  const sanitize = createDiagnosticSanitizer({ homeDir: process.env.HOME,
    pathMappings: [{ path: run.dir, placeholder: '<QA>' }, { path: repository, placeholder: '<REPOSITORY>' }] });
  const result = { protocol: 'devryan.release-upgrade-diagnostic/1', outcome: 'failed', diagnosticOnly: true,
    fromVersion, toVersion, attempts: 1, stage: 'download', cleanupErrors: [], excluded: ['service-registration', 'release-qualification'] };
  try {
    const artifacts = [];
    for (const version of [fromVersion, toVersion]) {
      const input = await downloadStartupRelease({ version, directory: path.join(run.dir, 'downloads', version) });
      artifacts.push(await inspectReleaseDmg({ ...input, directory: path.join(run.dir, 'installations', version), purpose: 'bundle-source' }));
    }
    result.artifacts = artifacts.map(({ version, dmgSha256, appSha256, manifestSha256 }) => ({ version, dmgSha256, appSha256, manifestSha256 }));
    profile = await createReleaseStartupProfile(path.join(run.dir, 'profile'));
    result.stage = 'baseline';
    active = await launchReleaseStartup(artifacts[0], profile);
    const id = await active.submit(); result.baselineStartup = active.startup;
    await stop(); result.baseline = readBundleStartupState(profile.controlRoot);
    await profile.configure({ selected: true });
    result.stage = 'upgrade';
    active = await launchReleaseStartup(artifacts[1], profile);
    const sessions = await active.request('/api/session?directory=' + encodeURIComponent(profile.workspace) + '&roots=true&limit=50');
    assert.equal(sessions.status, 200); assert.ok(sessions.body.some(row => row.id === id));
    await active.submit(); result.candidateStartup = active.startup;
    await stop(); result.candidate = readBundleStartupState(profile.controlRoot);
    assertNativeStartupUpgrade(result.baseline, result.candidate, { opencodeVersion: artifacts[1].opencodeVersion, artifactManifestSha256: artifacts[1].manifestSha256 });
    result.gapRecords = await verifyReleaseJournal(profile); result.outcome = 'passed';
  } catch (error) {
    result.error = sanitize.sanitizeText(error.message, { highEntropy: false }).slice(0, 2000);
    if (profile) result.earlyStartup = sanitize.sanitizeText(readNativeStartupLogs(null, profile.env.HOME), { highEntropy: true }).slice(-16 * 1024);
  } finally {
    try { await stop(); } catch { result.cleanupErrors.push('foreground_cleanup_failed'); }
    try { await profile?.close(); } catch { result.cleanupErrors.push('fixture_cleanup_failed'); }
    if (result.cleanupErrors.length) result.outcome = 'failed';
    await fs.writeFile(path.join(run.dir, 'diagnostic.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    run.finish(result.outcome);
  }
  return { ...result, output: run.dir };
}
