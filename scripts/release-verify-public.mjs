#!/usr/bin/env node
// Read-only check of a published release as installed apps see it
// (`post-publish-verify` in .github/workflows/release.yml, and by hand):
//
//   node scripts/release-verify-public.mjs vX.Y.Z
//
// It needs no retained artifact: the expected bytes come from the
// devryan-release/vX.Y.Z ledger tag. It checks /releases/latest (tag, html_url,
// exactly one asset with the contract name, state, size and digest), every
// shipped updater discovery (for a fresh app and every installed version from
// 2.0.0 up to the previous release), the payload budget, the ledger, the
// release notes against CHANGELOG.md, that no draft is visible, and that the
// public download hashes to the ledger bytes. A token (GITHUB_TOKEN or GH_TOKEN) only raises
// the rate limit; nothing is ever written. A failure here never means the
// release failed: promotion and the ledger already happened.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, RELEASE_VERSION_PATTERN, releaseAssetDownloadUrl, releaseAssetName } from '../packages/electron/release-assets.mjs';
import { verifyDownloadedUpdate } from '../packages/electron/desktop-updater.mjs';
import { createRunRoot, scratchParent } from './qa/run-root.mjs';
import { githubClient } from './release-github.mjs';
import { assertShippedDiscovery, installedVersionsBefore, ledgerTagName, parseReleaseMarker, releasePayloadProblems } from './release-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The published-bytes ledger entry for `version`: an annotated devryan-release/vX.Y.Z tag. */
export async function readLedger(client, version) {
  const name = ledgerTagName(version);
  const ref = await client.request('GET', `/git/ref/tags/${name}`, { allowNotFound: true });
  if (!ref) return null;
  if (ref.object?.type !== 'tag') throw new Error(`${name} is not an annotated ledger tag; inspect it before releasing v${version}`);
  const ledger = parseReleaseMarker((await client.request('GET', `/git/tags/${ref.object.sha}`)).message);
  if (ledger?.version !== version) throw new Error(`${name} does not record v${version}; inspect it before releasing v${version}`);
  return ledger;
}

/** Discovery retries this long after promotion before reporting verification pending. */
export const DISCOVERY_TIMEOUT_MS = 10 * 60_000;
/** The interim updater-discovery target, logged as a timing metric, not enforced. */
export const DISCOVERY_TARGET_MS = 60_000;
/** The public download must sustain at least this rate (bytes per second), plus a fixed slack. */
export const MINIMUM_DOWNLOAD_BYTES_PER_SECOND = 5_000_000;
export const DOWNLOAD_SLACK_MS = 60_000;

export const downloadDeadlineMs = (size, { bytesPerSecond = MINIMUM_DOWNLOAD_BYTES_PER_SECOND, slackMs = DOWNLOAD_SLACK_MS } = {}) =>
  slackMs + Math.ceil(size / bytesPerSecond * 1000);

/**
 * Download the unauthenticated public URL and use the shipped updater's byte
 * verifier. A connection lost mid-download resumes with a Range request.
 */
export async function verifyPublicInstaller(update, { fetchImpl = fetch, timeoutMs = 180_000, attempts = 3 } = {}) {
  const controller = new AbortController();
  const run = createRunRoot({ parent: scratchParent('release-download'), owner: 'release-public-download', onInterrupt: () => controller.abort() });
  let passed = false;
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref();
  try {
    const file = path.join(run.dir, update.name);
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      let size = 0;
      for (let attempt = 1; ; attempt++) {
        const headers = size ? { 'Accept-Encoding': 'identity', Range: `bytes=${size}-` } : { 'Accept-Encoding': 'identity' };
        const response = await fetchImpl(update.url, { signal: controller.signal, headers });
        if (size ? response.status !== 206 || !String(response.headers.get('content-range') ?? '').startsWith(`bytes ${size}-`) : !response.ok) {
          throw new Error(`Public installer download failed (${response.status}${size ? ', resume refused' : ''})`);
        }
        if (!response.body) throw new Error(`Public installer download failed (${response.status}, empty body)`);
        try {
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > update.size) { controller.abort(); throw Object.assign(new Error('Public installer exceeds the expected size'), { final: true }); }
            await handle.write(chunk);
          }
          break;
        } catch (error) {
          if (error.final || controller.signal.aborted || attempt >= attempts) throw error;
        }
      }
    } finally { await handle.close(); }
    await verifyDownloadedUpdate(file, update);
    passed = true;
  } finally { clearTimeout(timer); run.finish(passed ? 'passed' : 'failed'); }
}

const releaseProblems = (payload, { version, repository, expected }) => {
  const problems = [];
  const name = releaseAssetName('macos-arm64', version);
  if (payload?.tag_name !== `v${version}`) problems.push(`latest is ${payload?.tag_name ?? 'missing'}, not v${version}`);
  if (payload?.draft !== false || payload?.prerelease !== false) problems.push('the release is a draft or a prerelease');
  if (payload?.html_url !== `https://github.com/${repository}/releases/tag/v${version}`) problems.push(`html_url is ${payload?.html_url}`);
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  if (assets.length !== 1) problems.push(`it carries ${assets.length} assets, not exactly ${name}`);
  const asset = assets.find(row => row?.name === name);
  if (!asset) problems.push(`${name} is missing`);
  else {
    if (asset.state !== 'uploaded') problems.push(`${name} is ${asset.state}`);
    if (asset.size !== expected.size) problems.push(`${name} is ${asset.size} bytes, not the ledger's ${expected.size}`);
    if (asset.digest !== `sha256:${expected.sha256}`) problems.push(`${name} is ${asset.digest ?? 'undigested'}, not the ledger's sha256:${expected.sha256}`);
    if (asset.browser_download_url !== releaseAssetDownloadUrl('macos-arm64', version, repository)) problems.push(`${name} downloads from ${asset.browser_download_url}`);
  }
  problems.push(...releasePayloadProblems({ payload }));
  return problems;
};

/** Release notes for `version` from CHANGELOG.md, or null when this checkout has no section for it. */
async function changelogNotes(repositoryRoot, version) {
  const { releaseNotes } = await import('./release.mjs');
  const changelog = await fs.readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8').catch(() => '');
  try { return releaseNotes(changelog, version); } catch { return null; }
}

/**
 * Verify a published version without writing anything. Expected bytes come
 * from `expected` (the original candidate) or the ledger; when both exist they
 * must agree. Discovery is retried for `discoveryTimeoutMs`; the download has a
 * size-scaled deadline. Returns the report; throws "published, verification
 * pending" on failure.
 */
export async function verifyPublicRelease({ version, repository = RELEASE_REPOSITORY, client, expected: given, fetchImpl = fetch, log = console.log,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, discoveryTimeoutMs = DISCOVERY_TIMEOUT_MS, pollMs = 15_000,
  targetMs = DISCOVERY_TARGET_MS, bytesPerSecond = MINIMUM_DOWNLOAD_BYTES_PER_SECOND, downloadSlackMs = DOWNLOAD_SLACK_MS,
  repositoryRoot = root, checkNotes = true, rerun = 'rerun the post-publish-verify job' }) {
  if (!RELEASE_VERSION_PATTERN.test(version ?? '')) throw new Error(`Version must be x.y.z, got ${version}`);
  const tag = `v${version}`;
  const pending = (reason, cause) => new Error(`${tag} is published (promotion and the ledger are recorded); verification pending: ${reason}. To retry, ${rerun} or run \`node scripts/release-verify-public.mjs ${tag}\`. Never rebuild or replace published bytes.`, { cause });
  const report = { version, checks: [] };
  const pass = (name, detail) => { report.checks.push({ name, passed: true, detail }); log(`[verify] pass ${name}${detail ? `: ${detail}` : ''}`); };

  const ledger = await readLedger(client, version).catch(error => { throw pending(`the ledger could not be read (${error.message})`, error); });
  if (!ledger && !given) throw pending(`${ledgerTagName(version)} is missing, so the published bytes are unknown; rerun the release job, which records it`);
  if (ledger && given && (ledger.sha256 !== given.sha256 || ledger.size !== given.size)) {
    throw pending(`the ledger records sha256:${ledger.sha256} (${ledger.size} bytes), not the candidate's sha256:${given.sha256} (${given.size} bytes)`);
  }
  const expected = { version, name: releaseAssetName('macos-arm64', version), sha256: given?.sha256 ?? ledger.sha256, size: given?.size ?? ledger.size };
  pass('ledger', ledger ? `${ledgerTagName(version)} records sha256:${ledger.sha256}, ${ledger.size} bytes` : `missing (published before the ledger); using the candidate's bytes`);

  // Every supported installed version must be offered this one, not only a fresh app.
  const installedVersions = installedVersionsBefore(await client.paginate('/releases').catch(error => { throw pending(`the releases could not be listed (${error.message})`, error); }), version);
  // Discovery: /releases/latest as installed apps read it, until it shows this version or the deadline.
  const started = now(), deadline = started + discoveryTimeoutMs;
  let payload, lastError = null, superseded = null;
  for (;;) {
    try {
      const latest = await client.request('GET', '/releases/latest', { attempts: 1, signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - now()))) });
      const latestVersion = latest?.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
      const { compareVersions } = await import('./release.mjs');
      if (latestVersion && compareVersions(latestVersion, version) > 0) {
        superseded = latestVersion;
        payload = await client.request('GET', `/releases/tags/${tag}`);
      } else payload = latest;
      const problems = releaseProblems(payload, { version, repository, expected });
      if (problems.length) throw new Error(problems.join('; '));
      await assertShippedDiscovery(payload, expected, { installedVersions });
      break;
    } catch (error) {
      lastError = error;
      if (now() + pollMs >= deadline) throw pending(`updater discovery did not offer exactly the ledger bytes within ${Math.round(discoveryTimeoutMs / 1000)} seconds: ${error.message}`, error);
      await wait(pollMs);
    }
  }
  const discoveredAt = now();
  const published = Date.parse(payload.published_at ?? '');
  report.discoveryLatencyMs = Number.isFinite(published) ? Math.max(0, discoveredAt - published) : null;
  report.withinTarget = report.discoveryLatencyMs === null ? null : report.discoveryLatencyMs <= targetMs;
  pass('discovery', superseded ? `superseded by v${superseded}; ${tag} itself is unchanged` : `every shipped updater offers ${expected.name} to a fresh app and to installed ${installedVersions.map(installed => `v${installed}`).join(', ') || 'versions (none supported yet)'}`);
  log(`[release] updater-discovery-verified-at=${new Date(discoveredAt).toISOString()}`);
  log(`[release] updater-discovery-latency-ms=${report.discoveryLatencyMs ?? 'unknown'} target-ms=${targetMs} ${report.withinTarget === false ? 'missed' : report.withinTarget ? 'met' : 'unmeasured'}${lastError ? ' (after retries)' : ''}`);

  const marker = parseReleaseMarker(payload.body);
  if (!marker || marker.sha256 !== expected.sha256 || marker.size !== expected.size) throw pending('the release body marker does not name the published bytes');
  if (checkNotes) {
    const notes = await changelogNotes(repositoryRoot, version);
    if (notes === null) pass('release notes', 'skipped: this checkout has no CHANGELOG section for it');
    else if (!payload.body.startsWith(`${notes}\n`)) throw pending('the release notes differ from the CHANGELOG.md section');
    else pass('release notes', 'equal to the CHANGELOG.md section');
  }
  const drafts = (await client.paginate('/releases')).filter(row => row.tag_name === tag && row.draft !== false);
  if (drafts.length) throw pending(`${drafts.length} draft(s) for ${tag} remain; rerun the release job, which removes them`);
  // Informational for a read-only token, which never sees drafts: the hard check is assertNoDrafts in the writer `release` job.
  pass('drafts', 'none visible to this token (drafts are visible only to writers; the release job removes them and asserts none remain)');

  const timeoutMs = downloadDeadlineMs(expected.size, { bytesPerSecond, slackMs: downloadSlackMs });
  const downloadStarted = now();
  try {
    await verifyPublicInstaller({ ...expected, url: releaseAssetDownloadUrl('macos-arm64', version, repository) }, { fetchImpl, timeoutMs });
  } catch (error) { throw pending(`the public download did not hash to the ledger bytes within ${Math.round(timeoutMs / 1000)} seconds: ${error.message}`, error); }
  report.downloadMs = now() - downloadStarted;
  pass('public download', `${expected.size} bytes hash to sha256:${expected.sha256} in ${Math.round(report.downloadMs / 1000)} s`);
  log(`Published ${tag}; the in-app updater discovers ${expected.name} (${expected.size} bytes, sha256:${expected.sha256}); public download bytes verified.`);
  return report;
}

/** CLI: `release-verify-public.mjs vX.Y.Z`; read-only, a token is optional. */
export async function main({ argv = process.argv.slice(2), environment = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const [tag, ...rest] = argv;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || rest.length) throw Object.assign(new Error('Usage: release-verify-public.mjs vX.Y.Z'), { usage: true });
  const repository = environment.GITHUB_REPOSITORY || RELEASE_REPOSITORY;
  const token = environment.GITHUB_TOKEN || environment.GH_TOKEN || '';
  // No write-capable environment is ever passed: the client refuses every write.
  const client = githubClient({ token, anonymous: !token, repository, fetchImpl, environment: { RELEASE_DRY_RUN: 'true' }, log });
  const rerun = environment.GITHUB_RUN_ID ? `rerun the post-publish-verify job (gh run rerun ${environment.GITHUB_RUN_ID} --failed)` : 'rerun the post-publish-verify job';
  const report = await verifyPublicRelease({ version: tag.slice(1), repository, client, fetchImpl, log, rerun });
  if (environment.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(environment.GITHUB_STEP_SUMMARY, `### Post-publish verification ${tag}\n\n${report.checks.map(check => `- pass ${check.name}: ${check.detail ?? ''}`).join('\n')}\n- updater discovery latency: ${report.discoveryLatencyMs ?? 'unknown'} ms (target ${DISCOVERY_TARGET_MS} ms)\n`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error(error.message);
    if (!error.usage && process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Post-publish verification\n\n${error.message}\n`).catch(() => {});
    process.exitCode = error.usage ? 2 : 1;
  });
}
