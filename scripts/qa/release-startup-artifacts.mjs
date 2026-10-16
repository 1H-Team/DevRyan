import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureQaElectronAppIdentity } from './artifact-evidence.mjs';
import { selectReleaseStartupBaselines } from './release-startup-contract.mjs';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';

const exec = promisify(execFile);
export async function assertNoPriorStartupFailure(sourceCommit, runId) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/); assert.match(runId ?? '', /^\d+$/);
  const query = async route => JSON.parse((await exec('gh', ['api', '--paginate', '--slurp', route], { maxBuffer: 16 * 1024 * 1024 })).stdout);
  const runs = (await query(`repos/1H-Team/DevRyan/actions/workflows/release.yml/runs?head_sha=${sourceCommit}&per_page=100`)).flatMap(page => page.workflow_runs);
  for (const run of runs) {
    if (String(run.id) === runId) continue;
    const jobs = (await query(`repos/1H-Team/DevRyan/actions/runs/${run.id}/jobs?filter=all&per_page=100`)).flatMap(page => page.jobs);
    assert.ok(!jobs.some(job => job.name === 'qualify-release-startup' && ['failure', 'timed_out'].includes(job.conclusion)),
      'A prior startup trial failed for this source commit; investigate and commit the correction before qualification');
  }
}
export async function hashReleaseFile(file, { signal } = {}) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, { signal })) hash.update(bytes);
  return hash.digest('hex');
}

/** Extract only the signed app from the immutable installer; never refresh its manifest or signature. */
export async function inspectReleaseDmg({ dmg, directory, purpose = 'current', expectedSha256, version, deadline, signal }) {
  const check = () => { signal?.throwIfAborted(); if (deadline !== undefined) assert.ok(performance.now() < deadline, 'Installer inspection deadline expired'); };
  const execute = (command, args, options = {}) => { check(); return exec(command, args, { ...options, signal, timeout: deadline === undefined ? options.timeout : Math.max(1, Math.min(options.timeout ?? 30000, deadline - performance.now())) }); };
  check();
  assert.ok(path.isAbsolute(dmg) && path.isAbsolute(directory));
  const dmgSha256 = await hashReleaseFile(dmg, { signal });
  if (expectedSha256) assert.equal(dmgSha256, expectedSha256, 'Published installer digest differs');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const mount = path.join(directory, 'mount'), appPath = path.join(directory, 'DevRyan.app');
  await fs.mkdir(mount);
  await execute('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { timeout: 60_000 });
  try {
    const source = path.join(mount, 'DevRyan.app');
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', source], { timeout: 60_000 });
    await execute('/usr/bin/ditto', [source, appPath], { timeout: 120_000 });
  } finally { await exec('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 }); }
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { timeout: 60_000 });
  const { stdout } = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents/Info.plist')]);
  assert.equal(stdout.trim(), version, 'Installer version differs');
  const artifactRoot = path.join(appPath, 'Contents/Resources/revert-runtime/darwin-arm64');
  const manifestPath = path.join(artifactRoot, 'native-bundle.json'), manifestSha256 = await hashReleaseFile(manifestPath);
  const native = await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256,
    launcher: path.join(artifactRoot, 'DevRyan-execution-darwin-arm64'), purpose });
  check();
  const appSha256 = (await captureQaElectronAppIdentity(appPath)).sha256;
  assert.equal(await hashReleaseFile(dmg, { signal }), dmgSha256);
  check();
  return { dmg, dmgSha256, appPath, appSha256, version, manifestSha256, artifactRoot,
    opencodeVersion: native.manifest.opencodeVersion, binary: path.join(appPath, 'Contents/MacOS/DevRyan') };
}

export async function downloadReleaseStartupBaselines({ version, directory }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const { stdout } = await exec('gh', ['api', '--paginate', '--slurp', 'repos/1H-Team/DevRyan/releases?per_page=100'], { maxBuffer: 16 * 1024 * 1024 });
  const baselines = selectReleaseStartupBaselines(JSON.parse(stdout).flat(), version);
  for (const baseline of baselines) {
    const output = path.join(directory, baseline.version); await fs.mkdir(output);
    await exec('gh', ['release', 'download', baseline.tag, '--repo', '1H-Team/DevRyan', '--pattern', baseline.name, '--dir', output],
      { timeout: 300_000, maxBuffer: 64 * 1024 });
    baseline.dmg = path.join(output, baseline.name);
    assert.equal(await hashReleaseFile(baseline.dmg), baseline.sha256, 'Downloaded baseline differs from published digest');
  }
  return baselines;
}

export async function downloadStartupRelease({ version, directory }) {
  assert.match(version, /^2\.\d+\.\d+$/);
  const name = `DevRyan-${version}-arm64.dmg`;
  const { stdout } = await exec('gh', ['api', `repos/1H-Team/DevRyan/releases/tags/v${version}`], { maxBuffer: 1024 * 1024 });
  const release = JSON.parse(stdout), asset = release.assets.find(row => row.name === name);
  assert.ok(!release.draft && !release.prerelease); assert.match(asset?.digest ?? '', /^sha256:[a-f0-9]{64}$/);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await exec('gh', ['release', 'download', `v${version}`, '--repo', '1H-Team/DevRyan', '--pattern', name, '--dir', directory],
    { timeout: 300_000, maxBuffer: 64 * 1024 });
  const dmg = path.join(directory, name), expectedSha256 = asset.digest.slice(7);
  assert.equal(await hashReleaseFile(dmg), expectedSha256);
  return { dmg, version, expectedSha256 };
}
