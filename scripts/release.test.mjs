import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { VERSION_FILES, admit, publish, releaseNotes, releaseTarget, requireTrustedCI, stage, stagedDifferences, verifyPublished, verifyPublicInstaller } from './release.mjs';
import { releaseManifest, serializeReleaseManifest } from './release-candidate.mjs';
import { formatReleaseMarker } from './release-state.mjs';

const version = '9.8.7';
const source = 'a'.repeat(40);
const repository = '1H-Team/DevRyan';
const name = `DevRyan-${version}-arm64.dmg`;
const bytesSha = text => crypto.createHash('sha256').update(text).digest('hex');
const quiet = () => {};

async function fixture(t, { files = { [name]: 'installer bytes' }, packageVersion = version, manifestBytes = 'installer bytes' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of VERSION_FILES) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify({ version: file === 'package.json' ? packageVersion : version }));
  }
  await fs.writeFile(path.join(root, 'packages/desktop/src-tauri/Cargo.toml'), `[package]\nversion = "${version}"\n`);
  await fs.writeFile(path.join(root, 'packages/desktop/src-tauri/Cargo.lock'), `name = "devryan-desktop"\nversion = "${version}"\n`);
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - 2026-10-16\n\n- Fixed things.\n\n## [9.8.6]\n\n- Older.\n`);
  const assets = path.join(root, 'assets');
  await fs.mkdir(assets);
  for (const [file, bytes] of Object.entries(files)) await fs.writeFile(path.join(assets, file), bytes);
  const manifest = path.join(root, 'release-manifest.json');
  await fs.writeFile(manifest, serializeReleaseManifest(releaseManifest({
    candidate: { version, revision: source, runID: '40', attempt: '1', name, size: Buffer.byteLength(manifestBytes), sha256: bytesSha(manifestBytes) },
    bundle: { bundleId: 'dev.devryan.desktop', shortVersion: version, executable: 'DevRyan' }, arch: 'arm64', signingMode: 'adhoc', runtimeManifestSha256: 'f'.repeat(64) })));
  return { root, assets, manifest };
}

// In-memory GitHub REST double for the endpoints the release scripts call, per repository.
function fakeGitHub({ releases = [], tagSha = source, expired = false } = {}) {
  let nextId = 100, tick = 0;
  const stamp = () => `2026-10-22T00:00:${String(tick++).padStart(2, '0')}Z`;
  const repo = () => ({ releases: [], refs: new Map(), tags: new Map() });
  const repos = { [repository]: repo() };
  repos[repository].releases = releases.map((release) => ({ assets: [], updated_at: stamp(), ...release }));
  const state = { repos, calls: [], downloads: new Map(), tagSha, get releases() { return repos[repository].releases; } };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const tagName = release => release.draft ? `untagged-${release.id}abc` : release.tag_name;
  const assetView = (repoName, release, asset) => ({ ...asset, browser_download_url: `https://github.com/${repoName}/releases/download/${tagName(release)}/${asset.name}` });
  const releaseView = (repoName, release) => ({ ...release, html_url: `https://github.com/${repoName}/releases/tag/${tagName(release)}`,
    assets: release.assets.map(asset => assetView(repoName, release, asset)) });
  const fetchImpl = async (url, { method = 'GET', body } = {}) => {
    const { hostname, pathname, searchParams } = new URL(url);
    if (hostname === 'github.com') {
      state.calls.push(`GET ${pathname}`);
      return new Response(state.downloads.get(url) ?? 'installer bytes');
    }
    const repoName = /^\/repos\/([^/]+\/[^/]+)/.exec(pathname)?.[1];
    const data = repos[repoName];
    if (!data) return json(404, { message: `unknown repository ${repoName}` });
    state.calls.push(`${method} ${hostname === 'uploads.github.com' ? 'upload ' : ''}${pathname}`);
    const api = pathname.slice(`/repos/${repoName}`.length);
    const release = (id) => data.releases.find((row) => row.id === Number(id));
    const page = Number(searchParams.get('page') ?? '1');
    const paged = rows => json(200, page > 1 ? [] : rows);
    let match;
    if (api === '') return json(200, { full_name: repoName, default_branch: 'main' });
    if (api === '/actions/workflows/release.yml/runs') return json(200, { workflow_runs: page > 1 ? [] : [{ id: 22, path: '.github/workflows/release.yml', head_sha: source, event: 'push', head_branch: `v${version}`, repository: { full_name: repository } }] });
    if (api === '/actions/runs/22/artifacts') return json(200, { artifacts: page > 1 ? [] : [{ name: 'DevRyan-macos-arm64-release', expired }] });
    if (method === 'GET' && api === '/releases') return paged(data.releases.map(row => releaseView(repoName, row)));
    if (method === 'POST' && api === '/releases') {
      const created = { id: nextId++, assets: [], updated_at: stamp(), ...JSON.parse(body) };
      data.releases.push(created);
      return json(201, releaseView(repoName, created));
    }
    if (method === 'GET' && api === '/releases/latest') {
      const latest = data.releases.filter((row) => !row.draft).at(-1);
      return latest ? json(200, releaseView(repoName, latest)) : json(404, {});
    }
    if ((match = /^\/releases\/(\d+)$/.exec(api))) {
      const row = release(match[1]);
      if (!row) return json(404, {});
      if (method === 'GET') return json(200, releaseView(repoName, row));
      if (method === 'PATCH') {
        const fields = JSON.parse(body);
        Object.assign(row, fields, { updated_at: stamp() });
        return json(200, releaseView(repoName, row));
      }
      if (method === 'DELETE') { data.releases.splice(data.releases.indexOf(row), 1); return json(204); }
    }
    if ((match = /^\/releases\/(\d+)\/assets$/.exec(api))) {
      const row = release(match[1]);
      if (method === 'GET') return paged(row.assets.map(asset => assetView(repoName, row, asset)));
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const asset = { id: nextId++, name: searchParams.get('name'), size: bytes.length, state: 'uploaded', digest: `sha256:${bytesSha(bytes)}`, updated_at: stamp() };
      row.assets.push(asset);
      return json(201, assetView(repoName, row, asset));
    }
    if ((match = /^\/releases\/assets\/(\d+)$/.exec(api)) && method === 'DELETE') {
      for (const row of data.releases) row.assets = row.assets.filter((asset) => asset.id !== Number(match[1]));
      return json(204);
    }
    if ((match = /^\/git\/ref\/(tags\/.+)$/.exec(api))) {
      if (repoName === repository && match[1] === `tags/v${version}`) return state.tagSha ? json(200, { object: { type: 'commit', sha: state.tagSha } }) : json(404, {});
      const ref = data.refs.get(match[1]);
      return ref ? json(200, { ref: `refs/${match[1]}`, object: ref }) : json(404, {});
    }
    if ((match = /^\/git\/tags\/([a-f0-9]+)$/.exec(api))) return data.tags.has(match[1]) ? json(200, data.tags.get(match[1])) : json(404, {});
    if (method === 'POST' && api === '/git/tags') {
      const { tag, message, object } = JSON.parse(body);
      const sha = crypto.createHash('sha1').update(`${repoName}${tag}${nextId++}`).digest('hex');
      data.tags.set(sha, { sha, tag, message, object: { type: 'commit', sha: object } });
      return json(201, { sha });
    }
    if (method === 'POST' && api === '/git/refs') {
      const { ref, sha } = JSON.parse(body);
      const key = ref.slice('refs/'.length);
      if (data.refs.has(key)) return json(422, { message: 'Reference already exists' });
      data.refs.set(key, { type: 'tag', sha });
      return json(201, { ref });
    }
    if (method === 'GET' && api === '/git/matching-refs/tags') return json(200, [...data.refs.keys()].filter(key => key.startsWith('tags/')).map(key => ({ ref: `refs/${key}` })));
    if (method === 'DELETE' && (match = /^\/git\/refs\/(tags\/.+)$/.exec(api))) { data.refs.delete(match[1]); return json(204); }
    return json(500, { message: `unhandled ${method} ${api}` });
  };
  return { state, fetchImpl };
}

const environment = (extra = {}) => ({ GITHUB_REF: `refs/tags/v${version}`, GITHUB_SHA: source, GITHUB_TOKEN: 'fixture-token', RELEASE_PUBLICATION_LOCK: 'devryan-production-publication',
  GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '1', ...extra });
const releaseEnvironment = ({ assets, manifest }, extra = {}) => environment({ RELEASE_ASSET_DIRECTORY: assets, RELEASE_MANIFEST_PATH: manifest, ...extra });
const writes = calls => calls.filter(call => !call.startsWith('GET '));
const instant = { wait: async () => {} };

async function stageAndPublish(root, env, github, options = {}) {
  const staged = await stage({ repositoryRoot: root, environment: env, fetchImpl: github.fetchImpl, log: quiet, ...instant });
  await publish({ repositoryRoot: root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged.staged) }, fetchImpl: github.fetchImpl, log: quiet, ...instant, ...options });
  return staged;
}

test('release notes come from the matching CHANGELOG section and must not be empty', () => {
  assert.equal(releaseNotes(`## [${version}]\n\n- A\n\n## [1.0.0]\n- B\n`, version), '- A');
  assert.throws(() => releaseNotes('## [1.0.0]\n- B\n', version), /no "## \[9\.8\.7\]" section/);
  assert.throws(() => releaseNotes(`## [${version}]\n\n## [1.0.0]\n`, version), /empty/);
});

test('trusted CI requires this repository workflow, main push and exact SHA', async () => {
  const good = { id: 7, path: '.github/workflows/ci.yml', head_sha: source, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', repository: { full_name: repository } };
  const check = async (runs) => requireTrustedCI({ environment: environment(), fetchImpl: async () => new Response(JSON.stringify({ workflow_runs: runs })), log: quiet });
  assert.equal((await check([good])).id, 7);
  for (const override of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { conclusion: 'failure' }, { status: 'in_progress' }, { repository: { full_name: 'other/repository' } }]) {
    await assert.rejects(check([{ ...good, ...override }]), /Trusted CI/);
  }
  await assert.rejects(check([good, { ...good, id: 8, conclusion: 'failure' }]), /Trusted CI/);
});

test('releases are written only to the canonical repository', () => {
  assert.equal(releaseTarget(environment()).repository, repository);
  assert.throws(() => releaseTarget({ GITHUB_REPOSITORY: 'fork/DevRyan' }), /only from/);
});

test('admission is read-only, refuses a mismatched tag, and makes no API calls in a dry run', async (t) => {
  const { root } = await fixture(t);
  const github = fakeGitHub();
  const result = await admit({ repositoryRoot: root, environment: environment(), fetchImpl: github.fetchImpl, log: quiet });
  assert.equal(result.version, version);
  assert.equal(result.releaseId, '');
  assert.deepEqual(github.state.releases, []);
  assert.deepEqual(writes(github.state.calls), []);

  const dry = fakeGitHub();
  await admit({ repositoryRoot: root, environment: environment({ RELEASE_DRY_RUN: 'true', GITHUB_REF: 'refs/heads/main' }), fetchImpl: dry.fetchImpl, log: quiet });
  assert.deepEqual(dry.state.calls, []);

  await assert.rejects(admit({ repositoryRoot: root, environment: environment({ GITHUB_REF: 'refs/tags/v9.8.8' }), fetchImpl: github.fetchImpl, log: quiet }),
    /Tag v9\.8\.8 does not match package\.json 9\.8\.7/);
  const { root: drifted } = await fixture(t);
  await fs.writeFile(path.join(drifted, 'packages/ui/package.json'), JSON.stringify({ version: '1.0.0' }));
  await assert.rejects(admit({ repositoryRoot: drifted, environment: environment(), fetchImpl: fakeGitHub().fetchImpl, log: quiet }),
    /packages\/ui\/package\.json: 1\.0\.0/);
});

test('admission leaves every draft unchanged and routes published versions to retained-candidate verification', async (t) => {
  const { root } = await fixture(t);
  const github = fakeGitHub({ releases: [
    { id: 1, tag_name: `v${version}`, draft: true, target_commitish: 'b'.repeat(40), assets: [{ id: 7, name: 'stale.dmg' }] },
    { id: 2, tag_name: `v${version}`, draft: true, assets: [] },
  ] });
  const result = await admit({ repositoryRoot: root, environment: environment(), fetchImpl: github.fetchImpl, log: quiet });
  assert.equal(result.releaseId, '');
  assert.deepEqual(github.state.releases.map((row) => [row.id, row.target_commitish, row.assets.length]), [[1, 'b'.repeat(40), 1], [2, undefined, 0]]);
  assert.deepEqual(writes(github.state.calls), []);

  const release = { id: 3, tag_name: `v${version}`, draft: false, target_commitish: source };
  const published = fakeGitHub({ releases: [release] });
  assert.deepEqual(await admit({ repositoryRoot: root, environment: environment(), fetchImpl: published.fetchImpl, log: quiet }), { version, releaseId: '3', published: true, candidateRunId: '22' });
  assert.deepEqual(writes(published.state.calls), []);
  await assert.rejects(admit({ repositoryRoot: root, environment: environment(), fetchImpl: fakeGitHub({ releases: [release], expired: true }).fetchImpl, log: quiet }), /missing or expired/);
  await assert.rejects(admit({ repositoryRoot: root, environment: environment(), fetchImpl: fakeGitHub({ releases: [{ ...release, target_commitish: 'b'.repeat(40) }] }).fetchImpl, log: quiet }), /already published from another source/);
  const newer = fakeGitHub({ releases: [{ id: 4, tag_name: 'v10.0.0', draft: false }] });
  await assert.rejects(admit({ repositoryRoot: root, environment: environment(), fetchImpl: newer.fetchImpl, log: quiet }), /v10\.0\.0 is already latest/);
});

test('stage attaches exactly the manifest DMG, removes other assets, and refuses extras, a moved tag or a different manifest', async (t) => {
  const context = await fixture(t);
  const github = fakeGitHub({ releases: [{ id: 1, tag_name: `v${version}`, draft: true, assets: [{ id: 9, name, state: 'uploaded', size: 3, digest: `sha256:${'0'.repeat(64)}` }, { id: 8, name: 'latest-mac.yml', state: 'uploaded', size: 1 }] }] });
  const env = releaseEnvironment(context);
  const result = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  assert.deepEqual(github.state.releases[0].assets.map((asset) => [asset.name, asset.size]), [[name, 15]]);
  assert.equal(result.staged.digest, `sha256:${bytesSha('installer bytes')}`);
  assert.match(github.state.releases[0].body, /Fixed things\.\n\n<!-- devryan-release: version=9\.8\.7 sha256=[a-f0-9]{64} size=15 source=a{40} run=41\/1 -->/);

  const moved = fakeGitHub({ releases: [{ id: 1, tag_name: `v${version}`, draft: true }], tagSha: 'c'.repeat(40) });
  await assert.rejects(stage({ repositoryRoot: context.root, environment: env, fetchImpl: moved.fetchImpl, log: quiet }), /now points at c{40}/);
  assert.deepEqual(writes(moved.state.calls), []);

  const mismatched = await fixture(t, { manifestBytes: 'other bytes' });
  await assert.rejects(stage({ repositoryRoot: mismatched.root, environment: releaseEnvironment(mismatched), fetchImpl: fakeGitHub().fetchImpl, log: quiet }), /does not match its release manifest/);

  const extra = await fixture(t, { files: { [name]: 'installer bytes', 'latest-mac.yml': 'y' } });
  const dry = fakeGitHub();
  await assert.rejects(stage({ repositoryRoot: extra.root, environment: releaseEnvironment(extra, { RELEASE_DRY_RUN: 'true' }), fetchImpl: dry.fetchImpl, log: quiet }),
    /unexpected public assets:\n- latest-mac\.yml/);
  assert.deepEqual(dry.state.calls, []);
});

test('a re-staged identical draft keeps its asset without uploading again', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  const asset = github.state.releases[0].assets[0];
  github.state.calls.length = 0;
  await stage({ repositoryRoot: context.root, environment: { ...env, GITHUB_RUN_ATTEMPT: '2' }, fetchImpl: github.fetchImpl, log: quiet });
  assert.deepEqual(github.state.releases[0].assets, [asset]);
  assert.ok(!github.state.calls.some(call => call.startsWith('POST upload')));
});

test('locked stage creates and reconciles drafts; without the lock it cannot mutate', async t => {
  const context = await fixture(t);
  const github = fakeGitHub({ releases: [{ id: 1, tag_name: `v${version}`, draft: true }, { id: 2, tag_name: `v${version}`, draft: true }] });
  const env = releaseEnvironment(context);
  await assert.rejects(stage({ repositoryRoot: context.root, environment: { ...env, RELEASE_PUBLICATION_LOCK: '' }, fetchImpl: github.fetchImpl, log: quiet }), /publication lock/);
  assert.deepEqual(writes(github.state.calls), []);
  const result = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  assert.deepEqual(github.state.releases.map(row => row.id), [2], 'the newest draft is kept, the stale one removed');
  assert.equal(result.releaseId, '2');
  assert.equal(github.state.releases[0].target_commitish, source);
  assert.equal(github.state.releases[0].assets.length, 1);
});

test('stage rechecks a draft after lookup and refuses a release published in between', async t => {
  const context = await fixture(t);
  const github = fakeGitHub({ releases: [{ id: 1, tag_name: `v${version}`, draft: true }] });
  const fetchImpl = async (url, options) => {
    const response = await github.fetchImpl(url, options);
    if (new URL(url).pathname.endsWith('/releases/latest')) github.state.releases[0].draft = false;
    return response;
  };
  await assert.rejects(stage({ repositoryRoot: context.root, environment: releaseEnvironment(context), fetchImpl, log: quiet }), /became published/);
  assert.deepEqual(writes(github.state.calls), []);
});

test('tag movement after initial stage qualification refuses all mutations', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const fetchImpl = async (url, options) => {
    const response = await github.fetchImpl(url, options);
    if (new URL(url).pathname.endsWith('/releases/latest')) github.state.tagSha = 'b'.repeat(40);
    return response;
  };
  await assert.rejects(stage({ repositoryRoot: context.root, environment: releaseEnvironment(context), fetchImpl, log: quiet }), /now points at/);
  assert.deepEqual(writes(github.state.calls), []);
});

test('publish is one PATCH of the unchanged staged draft, then the ledger and shipped discovery', async (t) => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  const { staged } = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  github.state.calls.length = 0;
  const lines = [];
  await publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl: github.fetchImpl, log: line => lines.push(line), ...instant });
  assert.equal(github.state.releases[0].draft, false);
  assert.deepEqual(writes(github.state.calls), [`PATCH /repos/${repository}/releases/${staged.releaseId}`, `POST /repos/${repository}/git/tags`, `POST /repos/${repository}/git/refs`]);
  const [ledger] = github.state.repos[repository].tags.values();
  assert.equal(ledger.message, `${staged.marker}\n`);
  assert.equal(ledger.object.sha, source);
  assert.match(lines.find(line => line.startsWith('Published')), /in-app updater discovers DevRyan-9\.8\.7-arm64\.dmg \(15 bytes/);

  // A rerun after promotion records nothing new and changes nothing.
  github.state.calls.length = 0;
  await publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl: github.fetchImpl, log: quiet, ...instant });
  assert.deepEqual(writes(github.state.calls), []);
});

test('publish refuses a draft changed after staging and never promotes it', async t => {
  const context = await fixture(t);
  const env = releaseEnvironment(context);
  for (const change of [row => { row.assets[0].digest = `sha256:${'0'.repeat(64)}`; }, row => { row.assets.push({ id: 999, name: 'extra.dmg', state: 'uploaded', size: 1 }); },
    row => { row.body = '- edited by hand\n'; row.updated_at = 'later'; }, row => { row.assets[0].id = 998; }]) {
    const github = fakeGitHub();
    const { staged } = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
    change(github.state.releases[0]);
    github.state.calls.length = 0;
    await assert.rejects(publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl: github.fetchImpl, log: quiet, ...instant }), /changed since it was staged/);
    assert.deepEqual(writes(github.state.calls), []);
    assert.equal(github.state.releases[0].draft, true);
  }
  assert.ok(stagedDifferences({ id: 1, tag_name: 'v1.0.0' }, [], { releaseId: '1', tag: `v${version}` }).includes(`tag: v1.0.0 (staged v${version})`));
  await assert.rejects(publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify({ schema: 1, repository, version, source: 'b'.repeat(40) }) },
    fetchImpl: fakeGitHub().fetchImpl, log: quiet }), /staged\.json of this version, source/);
});

test('publication never replaces a newer latest and published reruns make no release writes', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  const { staged } = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  github.state.releases.push({ id: 2, tag_name: 'v10.0.0', draft: false, assets: [] });
  github.state.calls.length = 0;
  await assert.rejects(stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet }), /production deployment must not run/);
  await assert.rejects(publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl: github.fetchImpl, log: quiet }), /already latest/);
  assert.deepEqual(writes(github.state.calls), []);
});

test('promotion repeats source validation immediately before changing latest', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  const { staged } = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  github.state.calls.length = 0;
  const fetchImpl = async (url, options) => {
    const response = await github.fetchImpl(url, options);
    if (new URL(url).pathname.endsWith('/releases/latest')) github.state.tagSha = 'b'.repeat(40);
    return response;
  };
  await assert.rejects(publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl, log: quiet }), /now points at/);
  assert.deepEqual(writes(github.state.calls), []);
  assert.equal(github.state.releases[0].draft, true);
});

test('promotion needs the production lock', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  const { staged } = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  github.state.calls.length = 0;
  await assert.rejects(publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_PUBLICATION_LOCK: '', RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl: github.fetchImpl, log: quiet }), /publication lock/);
  assert.deepEqual(writes(github.state.calls), []);
  assert.equal(github.state.releases[0].draft, true);
});

test('the published-bytes ledger refuses re-creating a deleted release, even with identical bytes', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  await stageAndPublish(context.root, env, github);
  github.state.releases.length = 0;
  for (const operation of [admit, stage]) {
    await assert.rejects(operation({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet }), /no longer exists.*bump the patch version/);
  }
  assert.equal(github.state.releases.length, 0);
});

test('admission refuses a published release whose bytes no longer match the ledger', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  await stageAndPublish(context.root, env, github);
  github.state.releases[0].assets[0].digest = `sha256:${'9'.repeat(64)}`;
  await assert.rejects(admit({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet }), /replaced outside the pipeline/);
});

test('admission paused on a draft cannot demote or delete a concurrently published release', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  const { staged } = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  const admissionCalls = [];
  let interleaved = false;
  const fetchImpl = async (url, options) => {
    admissionCalls.push(options.method);
    const response = await github.fetchImpl(url, options);
    if (!interleaved && new URL(url).pathname === `/repos/${repository}/releases`) {
      interleaved = true;
      await publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl: github.fetchImpl, log: quiet, ...instant });
    }
    return response;
  };
  await admit({ repositoryRoot: context.root, environment: env, fetchImpl, log: quiet });
  assert.equal(interleaved, true);
  assert.ok(admissionCalls.every(method => method === 'GET'));
  assert.equal(github.state.releases[0].draft, false);
  assert.equal(github.state.releases[0].assets.length, 1);
});

test('dry runs cannot reach canonical writes whatever token they hold', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const build = releaseEnvironment(context, { RELEASE_DRY_RUN: 'true' });
  assert.deepEqual(await stage({ repositoryRoot: context.root, environment: build, fetchImpl: github.fetchImpl, log: quiet }), { published: false, releaseId: '' });
  assert.deepEqual(writes(github.state.calls), []);
  // Even holding a real canonical draft's staged.json and the repository token, a dry run cannot promote it.
  const { staged } = await stage({ repositoryRoot: context.root, environment: releaseEnvironment(context), fetchImpl: github.fetchImpl, log: quiet });
  github.state.calls.length = 0;
  await assert.rejects(publish({ repositoryRoot: context.root, environment: { ...build, RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl: github.fetchImpl, log: quiet, ...instant }),
    { code: 'release_dry_run_write_forbidden' });
  assert.deepEqual(writes(github.state.calls), []);
  assert.equal(github.state.releases[0].draft, true);
});

test('public byte verification rejects corrupt, truncated, oversized and unavailable downloads', async () => {
  const update = { name, url: 'https://github.com/public.dmg', size: 4, sha256: bytesSha('good') };
  let headers;
  await verifyPublicInstaller(update, { fetchImpl: async (_url, options) => { headers = options.headers; return new Response('good'); } });
  assert.deepEqual(headers, { 'Accept-Encoding': 'identity' }, 'public download must not send the GitHub API token');
  for (const bytes of ['evil', 'goo', 'good!']) await assert.rejects(verifyPublicInstaller(update, { fetchImpl: async () => new Response(bytes) }), /verification failed|expected size/);
  await assert.rejects(verifyPublicInstaller(update, { fetchImpl: async () => new Response('unavailable', { status: 503 }) }), /download failed \(503\)/);
});

test('published CDN failure preserves original bytes and verify-published is read-only', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  github.state.downloads.set(`https://github.com/${repository}/releases/download/v${version}/${name}`, 'corrupted bytes');
  await assert.rejects(stageAndPublish(context.root, env, github, { attempts: 1 }), /Published.*public verification failed.*never rebuild or replace/);
  assert.equal(github.state.releases[0].draft, false);
  const original = structuredClone(github.state.releases[0].assets);
  github.state.downloads.clear();
  github.state.calls.length = 0;
  await verifyPublished({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet, ...instant });
  assert.deepEqual(writes(github.state.calls), []);
  assert.deepEqual(github.state.releases[0].assets, original);
});

test('published-only verification cannot turn a reverted draft back into a release', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  github.state.calls.length = 0;
  await assert.rejects(verifyPublished({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet }), /refuses an unpublished/);
  assert.deepEqual(writes(github.state.calls), []);
});

test('post-publication discovery polls every five seconds and stops at sixty without replacing bytes', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  const { staged } = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  const original = structuredClone(github.state.releases[0].assets);
  let time = 0, polls = 0;
  const waits = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/releases/latest') && github.state.releases[0].draft === false) {
      polls++;
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json({ tag_name: 'v1.0.0', draft: false, assets: [] });
    }
    return github.fetchImpl(url, init);
  };
  await assert.rejects(publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged) }, fetchImpl, log: quiet,
    now: () => time, wait: async ms => { waits.push(ms); time += ms; } }), /Published.*60-second discovery deadline.*never rebuild or replace/);
  assert.equal(time, 60_000);
  assert.equal(polls, 12);
  assert.ok(waits.every(ms => ms === 5_000));
  assert.equal(github.state.releases[0].draft, false);
  assert.deepEqual(github.state.releases[0].assets, original);
});

test('a slow discovery response consumes the deadline instead of adding another full retry window', async t => {
  const context = await fixture(t);
  const github = fakeGitHub();
  const env = releaseEnvironment(context);
  const { staged } = await stage({ repositoryRoot: context.root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  let time = 0;
  await assert.rejects(publish({ repositoryRoot: context.root, environment: { ...env, RELEASE_STAGED: JSON.stringify(staged) }, log: quiet, now: () => time,
    wait: async () => assert.fail('No retry after the deadline'), fetchImpl: async (url, init) => {
      const response = await github.fetchImpl(url, init);
      if (url.endsWith('/releases/latest') && github.state.releases[0].draft === false) time = 60_000;
      return response;
    } }), /deadline/);
  assert.ok(!github.state.calls.some(call => call.includes('/releases/download/')));
});

test('public download honors the remaining discovery timeout', async () => {
  const update = { name, url: 'https://github.com/fixture', size: 4, sha256: 'a'.repeat(64) };
  await assert.rejects(verifyPublicInstaller(update, { timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    // Keep the fixture alive just as a real pending socket would.
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('timeout did not abort request')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('bounded download aborted')); }, { once: true });
    });
  } }), /bounded download aborted/);
});

test('the release marker written at stage is the one publish records', () => {
  assert.equal(formatReleaseMarker({ version, sha256: 'c'.repeat(64), size: 15, source, runId: '41', runAttempt: '1' }),
    `devryan-release: version=${version} sha256=${'c'.repeat(64)} size=15 source=${source} run=41/1`);
});
