import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { VERSION_FILES, release, simulate, stage } from './release.mjs';
import { releaseManifest, serializeReleaseManifest } from './release-candidate.mjs';
import { createFakeGitHub } from './release-github-fake.mjs';
import { RELEASE_REPOSITORY, releaseAssetDownloadUrl } from '../packages/electron/release-assets.mjs';
import { CANONICAL_RELEASE_REPOSITORY } from './release-artifacts.mjs';
import { DISCOVERY_PAYLOAD_MAX_BYTES, RELEASE_BODY_MAX_BYTES, SHIPPED_RELEASE_IDENTITY, assertShippedDiscovery, bridgeReleaseRequired, manifestIdentityProblems,
  parseReleaseMarker, projectForDiscovery, releasePayloadProblems } from './release-state.mjs';

// End-to-end release behaviour against the stateful fake GitHub
// (scripts/release-github-fake.mjs): crash-point convergence, golden API
// shapes, payload budgets and the identity installed apps compare literally.
const version = '9.8.7';
const source = 'a'.repeat(40);
const name = `DevRyan-${version}-arm64.dmg`;
const bytes = 'synthetic installer bytes';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const quiet = () => {};
const instant = async () => {};

async function fixture(t, { notes = '- Fixed things.', signingMode = 'adhoc', bundleId = 'dev.devryan.desktop' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-release-convergence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of VERSION_FILES) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify({ version }));
  }
  await fs.writeFile(path.join(root, 'packages/desktop/src-tauri/Cargo.toml'), `[package]\nversion = "${version}"\n`);
  await fs.writeFile(path.join(root, 'packages/desktop/src-tauri/Cargo.lock'), `name = "devryan-desktop"\nversion = "${version}"\n`);
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - 2026-10-23\n\n${notes}\n\n## [9.8.6]\n\n- Older.\n`);
  const assets = path.join(root, 'assets');
  await fs.mkdir(assets);
  await fs.writeFile(path.join(assets, name), bytes);
  const manifest = path.join(root, 'release-manifest.json');
  await fs.writeFile(manifest, serializeReleaseManifest(releaseManifest({
    candidate: { version, revision: source, runID: '40', attempt: '1', name, size: Buffer.byteLength(bytes), sha256: sha(bytes) },
    bundle: { bundleId, shortVersion: version, executable: 'DevRyan' }, arch: 'arm64', signingMode, runtimeManifestSha256: 'f'.repeat(64) })));
  const environment = { GITHUB_REF: `refs/tags/v${version}`, GITHUB_SHA: source, GITHUB_TOKEN: 'fixture-token', GITHUB_REPOSITORY: RELEASE_REPOSITORY,
    GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '1', RELEASE_PUBLICATION_LOCK: 'devryan-production-publication', RELEASE_ASSET_DIRECTORY: assets, RELEASE_MANIFEST_PATH: manifest };
  return { root, assets, manifest, environment };
}

const trustedRun = { id: 7, path: '.github/workflows/ci.yml', head_sha: source, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', repository: { full_name: RELEASE_REPOSITORY } };
const github = () => createFakeGitHub({ tags: { [`v${version}`]: source }, ciRuns: [trustedRun] });
const run = (context, fake) => release({ repositoryRoot: context.root, environment: context.environment, fetchImpl: fake.fetchImpl, log: quiet, wait: instant });

function assertConverged(fake, label) {
  const published = fake.publicReleases();
  assert.equal(published.length, 1, `${label}: exactly one published release`);
  assert.deepEqual(published[0].assets.map(asset => [asset.name, asset.state, asset.digest]), [[name, 'uploaded', `sha256:${sha(bytes)}`]], `${label}: one asset with the manifest digest`);
  assert.equal(fake.state.releases.filter(row => row.draft).length, 0, `${label}: no drafts`);
  assert.deepEqual(fake.ledgerRefs(), [`tags/devryan-release/v${version}`], `${label}: one ledger tag`);
  const ledger = parseReleaseMarker(fake.state.tagObjects[fake.state.refs[`tags/devryan-release/v${version}`].sha].message);
  assert.equal(ledger.sha256, sha(bytes), `${label}: the ledger names the published bytes`);
  assert.deepEqual(fake.state.violations, [], `${label}: never published with zero assets, never changed a published asset`);
  const count = prefix => fake.state.effects.filter(effect => effect.startsWith(prefix)).length;
  for (const effect of ['create release', 'upload', 'publish release', 'create ref tags/devryan-release/']) assert.equal(count(effect), 1, `${label}: exactly one "${effect}" effect`);
  assert.equal(fake.state.latestId, published[0].id, `${label}: the release is latest`);
}

test('a clean release is one draft, one upload, one promotion and one ledger tag', async t => {
  const context = await fixture(t);
  const fake = github();
  const result = await run(context, fake);
  assert.equal(result.published, true);
  assertConverged(fake, 'clean');
  // A rerun of the finished job changes nothing.
  const effects = [...fake.state.effects];
  await run(context, fake);
  assert.deepEqual(fake.state.effects, effects);
});

test('a crash at any request of stage → publish converges on rerun from a fresh process', async t => {
  const context = await fixture(t);
  const probe = github();
  await run(context, probe);
  const total = probe.requests.length;
  assert.ok(total > 15, `the release makes ${total} requests`);
  const outcomes = { crashed: 0, absorbed: 0 };
  for (let index = 0; index < total; index++) {
    for (const mode of ['before', 'lost', '502']) {
      const fake = github();
      fake.fault(index, mode);
      const label = `request ${index} (${probe.requests[index].method} ${new URL(probe.requests[index].url).pathname}) ${mode}`;
      try { await run(context, fake); outcomes.absorbed++; } catch { outcomes.crashed++; }
      assert.deepEqual(fake.state.violations, [], `${label}: first attempt`);
      // A new process: nothing survives but GitHub's state.
      await run(context, fake);
      assertConverged(fake, label);
    }
  }
  assert.ok(outcomes.crashed > 0 && outcomes.absorbed > 0, JSON.stringify(outcomes));
});

test('release mutates nothing without the publication lock or on a dry run', async t => {
  const context = await fixture(t);
  for (const extra of [{ RELEASE_PUBLICATION_LOCK: '' }, { RELEASE_DRY_RUN: 'true' }]) {
    const fake = github();
    const result = await release({ repositoryRoot: context.root, environment: { ...context.environment, ...extra }, fetchImpl: fake.fetchImpl, log: quiet, wait: instant }).catch(error => error);
    if (extra.RELEASE_DRY_RUN) assert.deepEqual(result, { published: false, releaseId: '' });
    else assert.match(result.message, /publication lock/);
    assert.deepEqual(fake.state.effects, []);
    assert.ok(fake.requests.every(request => request.method === 'GET'));
  }
});

test('release refuses to promote without trusted CI, leaving only the verified draft', async t => {
  const context = await fixture(t);
  const fake = createFakeGitHub({ tags: { [`v${version}`]: source }, ciRuns: [{ ...trustedRun, conclusion: 'failure' }] });
  await assert.rejects(run(context, fake), /Trusted CI for a{40} is completed\/failure/);
  assert.equal(fake.publicReleases().length, 0);
  assert.equal(fake.state.releases.filter(row => row.draft).length, 1);
  assert.deepEqual(fake.ledgerRefs(), []);
});

test('--simulate runs the real stage, publish and post-publish verifier against the fake without the network', async t => {
  const context = await fixture(t);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('the simulation must not reach the network');
  t.after(() => { globalThis.fetch = realFetch; });
  const lines = [];
  const environment = { RELEASE_ASSET_DIRECTORY: context.assets, RELEASE_MANIFEST_PATH: context.manifest, RELEASE_DRY_RUN: 'true', GITHUB_REF: 'refs/heads/main' };
  const result = await simulate('release', { repositoryRoot: context.root, environment, source, log: line => lines.push(line) });
  assert.equal(result.published, true);
  assert.ok(lines.some(line => /\[simulate\] release of v9\.8\.7 at a{40} passed/.test(line)), lines.join('\n'));
  assert.ok(lines.some(line => line.includes('public download bytes verified')));

  // Split stage and publish processes share the simulated GitHub through a state file that publish removes.
  const state = path.join(context.root, 'simulation.json');
  await simulate('stage', { repositoryRoot: context.root, environment: { ...environment, RELEASE_SIMULATION_STATE: state }, source, log: quiet });
  assert.ok(JSON.parse(await fs.readFile(state, 'utf8')).simulatedStaged.releaseId);
  await simulate('publish', { repositoryRoot: context.root, environment: { ...environment, RELEASE_SIMULATION_STATE: state }, source, log: quiet });
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${state}.blobs`), { code: 'ENOENT' });
  await assert.rejects(simulate('stage', { repositoryRoot: context.root, environment, source, log: quiet }), /RELEASE_SIMULATION_STATE/);
});

// Sanitized capture of GET /repos/1H-Team/DevRyan/releases/latest for v2.1.10 (download_count zeroed).
const golden = JSON.parse(readFileSync(new URL('./fixtures/github-api/release-latest-v2.1.10.json', import.meta.url), 'utf8'));
const goldenExpected = { version: '2.1.10', name: 'DevRyan-2.1.10-arm64.dmg', sha256: golden.assets[0].digest.slice(7), size: golden.assets[0].size };

test('every shipped discovery accepts the real published v2.1.10 API payload, within budget', async () => {
  const found = await assertShippedDiscovery(golden, goldenExpected);
  assert.deepEqual(found.map(row => row.label), ['current', 'v2.1.9']);
  assert.equal(found[0].update.url, releaseAssetDownloadUrl('macos-arm64', '2.1.10'));
  assert.deepEqual(releasePayloadProblems({ body: golden.body, payload: golden }), []);
  assert.equal(parseReleaseMarker(golden.body).sha256, goldenExpected.sha256);
});

test('the real payload as a draft (untagged URLs, unpublished) projects to what installed apps will see', async () => {
  const untagged = 'untagged-4f1c2e0d9b8a7c6e5d4f';
  const draft = { ...structuredClone(golden), draft: true, published_at: null, html_url: golden.html_url.replace('/tag/v2.1.10', `/tag/${untagged}`),
    assets: golden.assets.map(asset => ({ ...asset, browser_download_url: asset.browser_download_url.replace('/download/v2.1.10/', `/download/${untagged}/`) })) };
  await assert.rejects(assertShippedDiscovery(draft, goldenExpected), /rejected the release/);
  const projected = projectForDiscovery(draft, { version: '2.1.10' });
  assert.equal(projected.html_url, golden.html_url);
  assert.equal(projected.assets[0].browser_download_url, golden.assets[0].browser_download_url);
  await assertShippedDiscovery(projected, goldenExpected);
  // Another repository's URLs are never rewritten into ours.
  const foreign = { ...draft, html_url: `https://github.com/other/DevRyan/releases/tag/${untagged}` };
  await assert.rejects(assertShippedDiscovery(projectForDiscovery(foreign, { version: '2.1.10' }), goldenExpected), /rejected the release/);
});

test('release notes stay within 64 KiB and the discovery payload under 2 MiB', async t => {
  assert.equal(RELEASE_BODY_MAX_BYTES, 64 * 1024);
  assert.equal(DISCOVERY_PAYLOAD_MAX_BYTES, 2 * 1024 * 1024);
  assert.deepEqual(releasePayloadProblems({ body: 'x'.repeat(RELEASE_BODY_MAX_BYTES) }), []);
  assert.match(releasePayloadProblems({ body: 'x'.repeat(RELEASE_BODY_MAX_BYTES + 1) })[0], /installed updaters keep only 65536/);
  assert.match(releasePayloadProblems({ payload: { ...golden, padding: 'x'.repeat(DISCOVERY_PAYLOAD_MAX_BYTES) } })[0], /refuse 2097152 or more/);
  const context = await fixture(t, { notes: `- ${'long note '.repeat(7000)}` });
  const fake = github();
  await assert.rejects(stage({ repositoryRoot: context.root, environment: context.environment, fetchImpl: fake.fetchImpl, log: quiet }), /installed updaters keep only 65536/);
  await assert.rejects(stage({ repositoryRoot: context.root, environment: { ...context.environment, RELEASE_DRY_RUN: 'true' }, fetchImpl: fake.fetchImpl, log: quiet }), /installed updaters keep only/);
  assert.deepEqual(fake.requests, [], 'refused before any GitHub request');
});

test('the repository, URLs and ad-hoc signing equal what the shipped v2.1.9 updater compares literally', async t => {
  const shipped = await import('./fixtures/shipped-updater/v2.1.9/packages/electron/release-assets.mjs');
  const bridge = detail => bridgeReleaseRequired(detail);
  assert.equal(shipped.RELEASE_REPOSITORY, SHIPPED_RELEASE_IDENTITY.repository, bridge('The v2.1.9 updater reads another repository'));
  assert.equal(RELEASE_REPOSITORY, SHIPPED_RELEASE_IDENTITY.repository, bridge(`Releases moved to ${RELEASE_REPOSITORY}`));
  assert.equal(CANONICAL_RELEASE_REPOSITORY, SHIPPED_RELEASE_IDENTITY.repository, bridge(`Release writes target ${CANONICAL_RELEASE_REPOSITORY}`));
  for (const candidate of ['2.1.11', '10.0.0']) {
    assert.equal(shipped.releaseAssetDownloadUrl('macos-arm64', candidate), SHIPPED_RELEASE_IDENTITY.downloadUrl(candidate), bridge('The download URL changed'));
    assert.equal(releaseAssetDownloadUrl('macos-arm64', candidate), SHIPPED_RELEASE_IDENTITY.downloadUrl(candidate), bridge('The download URL changed'));
  }
  const updater = readFileSync(new URL('./fixtures/shipped-updater/v2.1.9/packages/electron/desktop-updater.mjs', import.meta.url), 'utf8');
  assert.ok(updater.includes('const metadataUrl = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;'), bridge('The v2.1.9 feed URL is not the one we publish to'));
  assert.equal(`https://api.github.com/repos/${shipped.RELEASE_REPOSITORY}/releases/latest`, SHIPPED_RELEASE_IDENTITY.feedUrl);
  assert.ok(updater.includes('payload.html_url !== `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`'), bridge('The v2.1.9 html_url check changed'));
  assert.equal(golden.html_url, SHIPPED_RELEASE_IDENTITY.htmlUrl('2.1.10'), bridge('Published html_url differs'));

  // Installed v2.1.9 apps are ad-hoc signed and require the candidate's signing mode to match theirs.
  const installer = readFileSync(new URL('./fixtures/shipped-updater/v2.1.9/packages/electron/desktop-update-install.mjs', import.meta.url), 'utf8');
  assert.match(installer, /actual\.mode !== signing\.mode/, bridge('The v2.1.9 installer signing comparison changed'));
  const packaging = JSON.parse(readFileSync(new URL('../packages/electron/package.json', import.meta.url), 'utf8')).build;
  assert.equal(SHIPPED_RELEASE_IDENTITY.signingMode, 'adhoc', bridge('The release signing mode changed'));
  assert.equal(packaging.afterPack, './scripts/adhoc-sign-macos-app.mjs', bridge('Packaging no longer signs ad hoc'));
  assert.equal(packaging.mac.notarize, false, bridge('Packaging notarizes'));
  assert.equal(packaging.dmg.sign, false, 'dmg.sign matches the -c.dmg.sign=false release override');
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /-c\.mac\.identity=null -c\.mac\.notarize=false -c\.dmg\.sign=false/, bridge('The release build is no longer ad hoc'));

  const manifest = { signingMode: 'adhoc', executable: 'DevRyan', arch: 'arm64', bundleId: 'dev.devryan.desktop' };
  assert.deepEqual(await manifestIdentityProblems(manifest), []);
  assert.deepEqual(await manifestIdentityProblems({ ...manifest, bundleId: 'dev.openchamber.desktop' }), []);
  for (const change of [{ signingMode: 'developer-id' }, { bundleId: 'com.example.devryan' }, { arch: 'x64' }]) {
    const [problem] = await manifestIdentityProblems({ ...manifest, ...change });
    assert.match(problem, /bridge release required/);
  }
  const context = await fixture(t, { signingMode: 'developer-id' });
  const fake = github();
  await assert.rejects(stage({ repositoryRoot: context.root, environment: context.environment, fetchImpl: fake.fetchImpl, log: quiet }), /signed developer-id, not adhoc.*bridge release required/s);
  assert.deepEqual(fake.requests, []);
});
