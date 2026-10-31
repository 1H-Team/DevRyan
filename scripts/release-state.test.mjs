import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CANDIDATE_PIN_SOURCES, PIN_FREE_INSTALLER_SINCE, SHIPPED_DISCOVERY_TAGS, SUPPORTED_INSTALLED_FLOOR, assertShippedDiscovery, candidatePinFixtureProblems, candidatePinProblems,
  formatReleaseMarker, readCheckoutSources, readInstallerCandidatePins, readRuntimePins, recordedCandidatePins, gitBlobId, installedVersionsBefore, ledgerTagName, parseReleaseMarker,
  projectForDiscovery, releaseBody, releaseState, shippedAcceptedBundleIds, shippedDiscoveries, shippedDiscoveryFixtureProblems } from './release-state.mjs';
import { SUPPORTED_UPGRADE_FLOOR } from './qa/release-upgrade-lane.mjs';
import { NATIVE_BUNDLE_BUN_VERSION } from '../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { REVIEWED_AST_ASSET_SHA256 } from '../packages/web/server/lib/opencode/runtime-host/reviewed-ast-asset.js';

const version = '9.8.7';
const source = 'a'.repeat(40), other = 'b'.repeat(40);
const sha256 = 'c'.repeat(64), otherSha = 'd'.repeat(64);
const name = `DevRyan-${version}-arm64.dmg`;
const marker = (fields = {}) => formatReleaseMarker({ version, sha256, size: 10, source, runId: '41', runAttempt: '1', ...fields });
const release = ({ id = 1, draft, commit = source, digest = sha256, markerSource, state = 'uploaded' } = {}) => ({
  id, tag_name: `v${version}`, draft, prerelease: false, target_commitish: commit,
  body: markerSource ? releaseBody('- notes', marker({ source: markerSource })) : '- notes',
  assets: digest === null ? [] : [{ id: id * 10, name, state, size: 10, digest: `sha256:${digest}` }],
});
const ledger = parseReleaseMarker(marker());

test('the marker round-trips and malformed text is not a ledger entry', () => {
  assert.deepEqual(parseReleaseMarker(`<!-- ${marker()} -->`), { version, sha256, size: 10, source, runId: '41', runAttempt: '1' });
  assert.equal(parseReleaseMarker('devryan-release: version=9.8.7 sha256=zz'), null);
  assert.throws(() => formatReleaseMarker({ version, sha256: 'short', size: 1, source, runId: '1', runAttempt: '1' }), /Invalid/);
  assert.equal(ledgerTagName(version), 'devryan-release/v9.8.7');
  assert.match(releaseBody('- notes', marker()), /^- notes\n\n<!-- devryan-release: version=9\.8\.7 .* -->\n$/);
});

// docs/RELEASE_PIPELINE.md "Same-version retries": one test per state.
test('state: no release and no ledger takes the full path', () => {
  assert.deepEqual(releaseState({ version, releases: [], ledger: null, source, sha256 }), { action: 'create' });
  assert.deepEqual(releaseState({ version, releases: [], ledger: null, source }), { action: 'create' });
});

test('state: a draft from the same source with the manifest digest skips the upload', () => {
  const draft = release({ draft: true, markerSource: source });
  assert.equal(releaseState({ version, releases: [draft], ledger: null, source, sha256 }).action, 'reuse-draft');
});

test('state: a draft from a moved tag or with other bytes is replaced while unpublished', () => {
  for (const draft of [release({ draft: true, commit: other }), release({ draft: true, markerSource: other }), release({ draft: true, digest: otherSha }),
    release({ draft: true, state: 'starter' }), release({ draft: true, digest: null })]) {
    assert.equal(releaseState({ version, releases: [draft], ledger: null, source, sha256 }).action, 'replace-draft');
  }
  const result = releaseState({ version, releases: [release({ id: 1, draft: true }), release({ id: 2, draft: true, commit: other })], ledger: null, source, sha256 });
  assert.equal(result.release.id, 2, 'the newest draft is kept');
  assert.deepEqual(result.stale.map(row => row.id), [1]);
});

test('state: published from the same source with the ledger and manifest bytes verifies only', () => {
  const published = release({ draft: false, markerSource: source });
  assert.equal(releaseState({ version, releases: [published], ledger, source, sha256 }).action, 'verify-published');
  assert.equal(releaseState({ version, releases: [published], ledger: null, source }).action, 'verify-published', 'releases from before the ledger still verify');
});

test('state: published from another source or with other bytes is refused', () => {
  for (const [published, reason] of [[release({ draft: false, commit: other }), 'published-different-source'],
    [release({ draft: false, markerSource: other }), 'published-different-source'],
    [{ ...release({ draft: false }), prerelease: true }, 'published-different-source'],
    [release({ draft: false, digest: otherSha }), 'published-different-bytes']]) {
    const result = releaseState({ version, releases: [published], ledger: null, source, sha256 });
    assert.equal(result.action, 'refuse');
    assert.equal(result.reason, reason);
    assert.match(result.message, /bump the patch version/);
  }
  assert.equal(releaseState({ version, releases: [release({ draft: false }), release({ id: 2, draft: false })], ledger: null, source }).reason, 'duplicate-published');
});

test('state: a published release deleted and re-created with different bytes is refused (the v2.1.5 case)', () => {
  const recreated = release({ draft: false, digest: otherSha });
  const result = releaseState({ version, releases: [recreated], ledger, source, sha256: otherSha });
  assert.deepEqual([result.action, result.reason], ['refuse', 'published-bytes-replaced']);
  assert.match(result.message, /replaced outside the pipeline/);
});

test('state: a ledger entry without its release refuses re-creation, even as a draft', () => {
  for (const releases of [[], [release({ draft: true })]]) {
    const result = releaseState({ version, releases, ledger, source, sha256 });
    assert.deepEqual([result.action, result.reason], ['refuse', 'ledger-without-release']);
    assert.match(result.message, /no longer exists.*bump the patch version/);
  }
});

const canonical = `https://github.com/1H-Team/DevRyan/releases`;
const published = (overrides = {}, asset = {}) => ({ draft: false, prerelease: false, tag_name: `v${version}`, html_url: `${canonical}/tag/v${version}`, body: '- notes',
  assets: [{ name, state: 'uploaded', size: 10, digest: `sha256:${sha256}`, browser_download_url: `${canonical}/download/v${version}/${name}`, ...asset }], ...overrides });

test('projection shows a draft as published and maps only its own untagged URLs', () => {
  const draft = published({ draft: true, html_url: `${canonical}/tag/untagged-0123abcd` }, { browser_download_url: `${canonical}/download/untagged-0123abcd/${name}` });
  const projected = projectForDiscovery(draft, { version });
  assert.equal(projected.draft, false);
  assert.equal(projected.html_url, `${canonical}/tag/v${version}`);
  assert.equal(projected.assets[0].browser_download_url, `${canonical}/download/v${version}/${name}`);
  for (const html_url of ['https://evil.example/release', `${canonical}/tag/v1.0.0`, `${canonical}/tag/untagged-x/../v9`]) {
    assert.equal(projectForDiscovery({ ...draft, html_url }, { version }).html_url, html_url);
  }
  const elsewhere = published({ draft: true }, { browser_download_url: `https://github.com/attacker/DevRyan/releases/download/untagged-1/${name}` });
  assert.equal(projectForDiscovery(elsewhere, { version }).assets[0].browser_download_url, elsewhere.assets[0].browser_download_url);
});

const expected = { version, name, sha256, size: 10 };
// Every shipped discovery must decide each case identically (scripts/fixtures/shipped-updater).
const discoveryCases = {
  valid: [published(), 'offered'],
  'extra asset (the v2.0.10 docs tarball)': [published({ assets: [...published().assets, { name: 'DevRyan-docs-source-aa5da4d8.tar.gz', state: 'uploaded', size: 5, digest: `sha256:${sha256}` }] }), 'offered'],
  'duplicate installer': [published({ assets: [published().assets[0], published().assets[0]] }), 'update_asset_unverified'],
  'starter upload': [published({}, { state: 'starter' }), 'update_asset_unverified'],
  'digest null': [published({}, { digest: null }), 'update_asset_unverified'],
  prerelease: [published({ prerelease: true }), 'update_release_invalid'],
  draft: [published({ draft: true }), 'update_release_invalid'],
  'wrong html_url': [published({ html_url: 'https://github.com/attacker/DevRyan/releases/tag/v9.8.7' }), 'update_release_invalid'],
  'wrong download URL': [published({}, { browser_download_url: `https://github.com/attacker/DevRyan/releases/download/v${version}/${name}` }), 'update_asset_unverified'],
  'over 8 GiB': [published({}, { size: 8 * 1024 ** 3 + 1 }), 'update_asset_unverified'],
};

test('the discovery matrix gives identical results for the current code and every shipped tag', async () => {
  const discoveries = await shippedDiscoveries();
  assert.deepEqual(discoveries.map(row => row.label), ['current', ...SHIPPED_DISCOVERY_TAGS]);
  for (const [label, [payload, outcome]] of Object.entries(discoveryCases)) {
    for (const discovery of discoveries) {
      let result;
      try { result = discovery.discoverDesktopUpdate(payload, { currentVersion: '9.8.6', platform: 'darwin', arch: 'arm64' })?.sha256 === sha256 ? 'offered' : 'not offered'; }
      catch (error) { result = error.code; }
      assert.equal(result, outcome, `${discovery.label}: ${label}`);
    }
  }
  await assertShippedDiscovery(published(), expected, { discoveries });
  await assert.rejects(assertShippedDiscovery(published({}, { digest: null }), expected, { discoveries }), /Shipped discovery current rejected.*update_asset_unverified/);
  await assert.rejects(assertShippedDiscovery(published({}, { size: 11 }), expected, { discoveries }), /offered an app on 0\.0\.0 .*"size":11/);
});

test('every installed version from the supported floor to the previous release is offered the new one', async () => {
  assert.equal(`v${SUPPORTED_INSTALLED_FLOOR}`, SUPPORTED_UPGRADE_FLOOR, 'the discovery floor is the upgrade-qualification floor');
  const row = (tag, fields = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...fields });
  const releases = [row('v2.0.2'), row('v1.2.22'), row('v2.0.1'), row('v2.1.0', { draft: true }), row('v2.0.3', { prerelease: true }), row('v9.8.7'), row('v10.0.0'), row('nightly')];
  assert.deepEqual(installedVersionsBefore(releases, '2.0.3'), ['2.0.0', '2.0.1', '2.0.2'], 'published stable releases from 2.0.0 up to the previous one');
  assert.deepEqual(installedVersionsBefore([], '9.8.7'), ['2.0.0']);
  assert.deepEqual(installedVersionsBefore([], '2.0.0'), [], 'nothing below the floor is supported');

  const discoveries = await shippedDiscoveries();
  const installed = installedVersionsBefore(releases, version);
  assert.deepEqual(installed, ['2.0.0', '2.0.1', '2.0.2']);
  const found = await assertShippedDiscovery(published(), expected, { discoveries, installedVersions: installed });
  assert.deepEqual(found.map(entry => [entry.label, entry.installed]), discoveries.map(discovery => [discovery.label, installed]));
  // An updater that skipped a supported installed version, or offers an app its own version, fails the matrix.
  const skipping = [{ label: 'skips 2.0.1', discoverDesktopUpdate: (payload, options) => options.currentVersion === '2.0.1' ? null : discoveries[0].discoverDesktopUpdate(payload, options) }];
  await assert.rejects(assertShippedDiscovery(published(), expected, { discoveries: skipping, installedVersions: installed }), /skips 2\.0\.1 offered an app on 2\.0\.1 \{\}/);
  const always = [{ label: 'always', discoverDesktopUpdate: (payload, options) => discoveries[0].discoverDesktopUpdate(payload, { ...options, currentVersion: '0.0.0' }) }];
  await assert.rejects(assertShippedDiscovery(published(), expected, { discoveries: always, installedVersions: installed }), /always offers v9\.8\.7 to an app already on it/);
});

test('vendored shipped updater files are byte-identical to the blobs recorded for their tags', async () => {
  assert.equal(gitBlobId(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.deepEqual(await shippedDiscoveryFixtureProblems(), []);
  // No supported install predates 2.0.0, so no shipped copy is vendored and every installed app runs the current discovery.
  assert.deepEqual(SHIPPED_DISCOVERY_TAGS, []);
  assert.deepEqual(await shippedDiscoveryFixtureProblems({ tagBlob: async () => 'f'.repeat(40) }), []);
});

test('the packaged bundle identifier is one every supported shipped installer accepts', async () => {
  const appId = JSON.parse(readFileSync(new URL('../packages/electron/package.json', import.meta.url), 'utf8')).build.appId;
  for (const tag of ['current', ...SHIPPED_DISCOVERY_TAGS]) assert.ok((await shippedAcceptedBundleIds(tag)).includes(appId), `${tag} installer rejects ${appId}`);
});

const repositoryRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('the installer pin report reads this checkout\'s Bun and reviewed assets exactly', async () => {
  // Informational since 2026-10-26 (in-app upgrades are not a release gate): it
  // names installs that would refuse "Restart to update" but never blocks.
  const recorded = await recordedCandidatePins();
  assert.deepEqual(recorded, {}, 'every supported installer (2.0.0 on) is pin-free');
  const candidate = readRuntimePins(await readCheckoutSources(repositoryRoot));
  assert.deepEqual(candidate, { bunVersion: NATIVE_BUNDLE_BUN_VERSION, assets: { 'DevRyan-ast-grep-darwin-arm64': REVIEWED_AST_ASSET_SHA256 } });
  assert.ok(Array.isArray(candidatePinProblems({ recorded, candidate })));
});

test('the installer pin gate names each supported install a Bun or reviewed-asset change would strand', async () => {
  const candidate = readRuntimePins(await readCheckoutSources(repositoryRoot));
  // Synthetic pinned installers above a synthetic floor exercise the gate.
  const recorded = Object.fromEntries(['v2.1.14', 'v2.1.15', 'v2.1.16', 'v2.1.17'].map(tag => [tag, candidate]));
  const floor = '2.1.14';
  assert.deepEqual(candidatePinProblems({ recorded, candidate, floor }), []);
  const bun = candidatePinProblems({ recorded, candidate: { ...candidate, bunVersion: '9.9.9' }, floor });
  assert.equal(bun.length, 5);
  assert.match(bun[0], new RegExp(`^v2\\.1\\.14's installer requires a native runtime built by Bun ${candidate.bunVersion.replaceAll('.', '\\.')}; this checkout builds 9\\.9\\.9$`));
  assert.match(bun.at(-1), /owner decision to raise SUPPORTED_UPGRADE_FLOOR/);
  const ast = candidatePinProblems({ recorded, candidate: { ...candidate, assets: { ...candidate.assets, 'DevRyan-ast-grep-darwin-arm64': 'e'.repeat(64) } }, floor });
  assert.match(ast.join('\n'), new RegExp(`v2\\.1\\.17's installer requires DevRyan-ast-grep-darwin-arm64 ${candidate.assets['DevRyan-ast-grep-darwin-arm64'].slice(0, 12)}; this checkout ships eeeeeeeeeeee`));
  // An installer that pinned a retired reviewed asset is named, not silently accepted.
  const retired = candidatePinProblems({ recorded: { 'v2.1.17': { ...candidate, assets: { ...candidate.assets, 'DevRyan-Claude-credentials.mjs': 'd'.repeat(64) } } }, candidate, floor });
  assert.match(retired.join('\n'), /v2\.1\.17's installer requires DevRyan-Claude-credentials\.mjs dddddddddddd; this checkout ships none/);
  // Pins below the floor are not compared.
  const old = { 'v2.1.9': { ...candidate, bunVersion: '1.4.3' } };
  assert.deepEqual(candidatePinProblems({ recorded: old, candidate, floor }), []);
  assert.equal(candidatePinProblems({ recorded: old, candidate, floor: '2.1.9' }).length, 2);
});

test('installers are pinned until they verify candidates with verifyUpdateCandidateArtifacts', async () => {
  assert.equal(PIN_FREE_INSTALLER_SINCE, SUPPORTED_INSTALLED_FLOOR, 'every supported installer is pin-free');
  const checkout = await readCheckoutSources(repositoryRoot);
  assert.equal(readInstallerCandidatePins(checkout), null, 'this checkout\'s installer is pin-free');
  const pinnedMain = checkout.main.replace('verifyNativeArtifacts: verifyUpdateCandidateArtifacts,', 'verifyNativeArtifacts: verifyNativeRuntimeArtifacts,');
  assert.deepEqual(readInstallerCandidatePins({ ...checkout, main: pinnedMain }), readRuntimePins(checkout));
  assert.throws(() => readInstallerCandidatePins({ ...checkout, main: '' }), /Cannot tell which verifier/);
  assert.throws(() => readRuntimePins({ ...checkout, artifacts: '' }), /Cannot read the native runtime pins/);
  assert.throws(() => readRuntimePins({ ...checkout, ast: '' }), /Cannot read the native runtime pins/);
});

test('recorded installer pins must equal what each tag from the floor shipped', async () => {
  const checkout = await readCheckoutSources(repositoryRoot);
  const pinned = { ...checkout, main: checkout.main.replace('verifyNativeArtifacts: verifyUpdateCandidateArtifacts,', 'verifyNativeArtifacts: verifyNativeRuntimeArtifacts,') };
  const pins = readRuntimePins(checkout);
  const files = Object.fromEntries(Object.entries(CANDIDATE_PIN_SOURCES).map(([name, file]) => [file, name]));
  const readTagFile = async (tag, file) => (tag === 'v2.1.18' ? checkout : pinned)[files[file]];
  const tags = ['v2.1.9', 'v2.1.14', 'v2.1.18', 'nightly'];
  const floor = '2.1.14';
  assert.deepEqual(await candidatePinFixtureProblems({ recorded: { 'v2.1.14': pins }, tags, readTagFile, version: '2.1.19', floor }), []);
  assert.deepEqual(await candidatePinFixtureProblems({ recorded: { 'v2.1.9': {}, 'v2.1.14': pins }, tags, readTagFile, version: '2.1.19', floor }), [], 'entries below the floor are not compared');
  assert.match((await candidatePinFixtureProblems({ recorded: {}, tags, readTagFile, version: '2.1.19', floor })).join(), /records nothing from v2\.1\.14/);
  assert.match((await candidatePinFixtureProblems({ recorded: { 'v2.1.14': { ...pins, bunVersion: '1.4.3' } }, tags, readTagFile, version: '2.1.19', floor })).join(), /the tags pin/);
  assert.match((await candidatePinFixtureProblems({ recorded: { 'v2.1.14': pins }, tags, readTagFile: async () => '', version: '2.1.19', floor })).join(), /v2\.1\.14: Cannot tell/);
  // The real fixture: no release from the 2.0.0 floor precedes 2.0.0.
  assert.deepEqual(await candidatePinFixtureProblems({ recorded: await recordedCandidatePins(), tags: ['v1.2.22', 'v2.0.0'], readTagFile, version: '2.0.0' }), []);
});
