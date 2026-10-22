import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SHIPPED_DISCOVERY_TAGS, assertShippedDiscovery, formatReleaseMarker, gitBlobId, ledgerTagName, parseReleaseMarker, projectForDiscovery,
  releaseBody, releaseState, shippedAcceptedBundleIds, shippedDiscoveries, shippedDiscoveryFixtureProblems } from './release-state.mjs';

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
  assert.equal(releaseState({ version, releases: [release({ draft: false, commit: 'main', markerSource: source })], ledger, source, targetCommitish: 'main', sha256 }).action,
    'verify-published', 'a staging release is identified by its marker source');
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

test('projection maps only this repository\'s own release URLs and shows a draft as published', () => {
  const staging = 'https://github.com/1H-Team/DevRyan-release-staging/releases';
  const draft = published({ draft: true, html_url: `${staging}/tag/untagged-0123abcd` }, { browser_download_url: `${staging}/download/untagged-0123abcd/${name}` });
  const projected = projectForDiscovery(draft, { repository: '1H-Team/DevRyan-release-staging', version, asPublished: true });
  assert.equal(projected.draft, false);
  assert.equal(projected.html_url, `${canonical}/tag/v${version}`);
  assert.equal(projected.assets[0].browser_download_url, `${canonical}/download/v${version}/${name}`);
  assert.equal(projectForDiscovery(draft, { repository: '1H-Team/DevRyan-release-staging', version }).draft, true, 'a draft stays a draft unless asked');
  for (const html_url of ['https://evil.example/release', `${staging}/tag/v1.0.0`, `${staging}/tag/untagged-x/../v9`]) {
    assert.equal(projectForDiscovery({ ...draft, html_url }, { repository: '1H-Team/DevRyan-release-staging', version, asPublished: true }).html_url, html_url);
  }
  const elsewhere = published({}, { browser_download_url: `https://github.com/attacker/DevRyan/releases/download/v${version}/${name}` });
  assert.deepEqual(projectForDiscovery(elsewhere, { repository: '1H-Team/DevRyan', version }), elsewhere);
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
  await assert.rejects(assertShippedDiscovery(published({}, { size: 11 }), expected, { discoveries }), /found .*"size":11/);
});

test('vendored shipped updater files are byte-identical to the blobs recorded for their tags', async () => {
  assert.equal(gitBlobId(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.deepEqual(await shippedDiscoveryFixtureProblems(), []);
  assert.match((await shippedDiscoveryFixtureProblems({ tagBlob: async () => 'f'.repeat(40) })).join('\n'), /is f{40}, not the recorded/);
});

test('the packaged bundle identifier is one every supported shipped installer accepts', async () => {
  const appId = JSON.parse(readFileSync(new URL('../packages/electron/package.json', import.meta.url), 'utf8')).build.appId;
  for (const tag of SHIPPED_DISCOVERY_TAGS) assert.ok((await shippedAcceptedBundleIds(tag)).includes(appId), `${tag} installer rejects ${appId}`);
});
