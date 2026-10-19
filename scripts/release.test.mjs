import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { VERSION_FILES, admit, publish, releaseNotes, upload } from './release.mjs';

const version = '9.8.7';
const source = 'a'.repeat(40);
const repository = '1H-Team/DevRyan';
const quiet = () => {};

async function fixture(t, { files = { [`DevRyan-${version}-arm64.dmg`]: 'installer bytes' }, packageVersion = version } = {}) {
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
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(assets, name), bytes);
  return { root, assets };
}

// In-memory GitHub REST double covering the endpoints release.mjs calls.
function fakeGitHub({ releases = [], tagSha = source } = {}) {
  let nextId = 100;
  const state = { releases: releases.map((release) => ({ assets: [], ...release })), calls: [] };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetchImpl = async (url, { method = 'GET', body } = {}) => {
    const { pathname, searchParams } = new URL(url);
    state.calls.push(`${method} ${pathname}`);
    const api = pathname.replace(`/repos/${repository}`, '');
    const release = (id) => state.releases.find((row) => row.id === Number(id));
    let match;
    if (method === 'GET' && api === '/releases') return json(200, state.releases);
    if (method === 'POST' && api === '/releases') {
      const created = { id: nextId++, assets: [], ...JSON.parse(body) };
      state.releases.push(created);
      return json(201, created);
    }
    if (method === 'GET' && api === '/releases/latest') {
      const latest = state.releases.filter((row) => !row.draft).at(-1);
      return latest ? json(200, { ...latest, html_url: `https://github.com/${repository}/releases/tag/${latest.tag_name}` }) : json(404, {});
    }
    if ((match = /^\/releases\/(\d+)$/.exec(api))) {
      const row = release(match[1]);
      if (method === 'GET') return json(200, row);
      if (method === 'PATCH') { Object.assign(row, JSON.parse(body)); return json(200, row); }
      if (method === 'DELETE') { state.releases.splice(state.releases.indexOf(row), 1); return json(204); }
    }
    if ((match = /^\/releases\/(\d+)\/assets$/.exec(api))) {
      const row = release(match[1]);
      if (method === 'GET') return json(200, row.assets);
      const bytes = Buffer.from(body);
      const name = searchParams.get('name');
      const asset = { id: nextId++, name, size: bytes.length, state: 'uploaded',
        digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
        browser_download_url: `https://github.com/${repository}/releases/download/${row.tag_name}/${name}` };
      row.assets.push(asset);
      return json(201, asset);
    }
    if ((match = /^\/releases\/assets\/(\d+)$/.exec(api)) && method === 'DELETE') {
      for (const row of state.releases) row.assets = row.assets.filter((asset) => asset.id !== Number(match[1]));
      return json(204);
    }
    if (api === `/git/ref/tags/v${version}`) return tagSha ? json(200, { object: { type: 'commit', sha: tagSha } }) : json(404, {});
    return json(500, { message: `unhandled ${method} ${api}` });
  };
  return { state, fetchImpl };
}

const environment = (extra = {}) => ({ GITHUB_REF: `refs/tags/v${version}`, GITHUB_SHA: source, GITHUB_TOKEN: 'fixture-token', GITHUB_REPOSITORY: repository, ...extra });

test('release notes come from the matching CHANGELOG section and must not be empty', () => {
  assert.equal(releaseNotes(`## [${version}]\n\n- A\n\n## [1.0.0]\n- B\n`, version), '- A');
  assert.throws(() => releaseNotes('## [1.0.0]\n- B\n', version), /no "## \[9\.8\.7\]" section/);
  assert.throws(() => releaseNotes(`## [${version}]\n\n## [1.0.0]\n`, version), /empty/);
});

test('admit creates a draft, refuses a mismatched tag, and makes no writes in a dry run', async (t) => {
  const { root } = await fixture(t);
  const github = fakeGitHub();
  const result = await admit({ repositoryRoot: root, environment: environment(), fetchImpl: github.fetchImpl, log: quiet });
  assert.equal(result.version, version);
  const [draft] = github.state.releases;
  assert.equal(String(draft.id), result.releaseId);
  assert.deepEqual([draft.tag_name, draft.target_commitish, draft.name, draft.draft], [`v${version}`, source, `DevRyan v${version}`, true]);
  assert.match(draft.body, /Fixed things/);

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

test('admit reuses an unpublished draft for a moved tag and refuses a published version', async (t) => {
  const { root } = await fixture(t);
  const github = fakeGitHub({ releases: [
    { id: 1, tag_name: `v${version}`, draft: true, target_commitish: 'b'.repeat(40), assets: [{ id: 7, name: 'stale.dmg' }] },
    { id: 2, tag_name: `v${version}`, draft: true, assets: [] },
  ] });
  const result = await admit({ repositoryRoot: root, environment: environment(), fetchImpl: github.fetchImpl, log: quiet });
  assert.equal(result.releaseId, '1');
  assert.deepEqual(github.state.releases.map((row) => [row.id, row.target_commitish, row.assets.length]), [[1, source, 0]]);

  const published = fakeGitHub({ releases: [{ id: 3, tag_name: `v${version}`, draft: false, html_url: 'https://example.invalid/r' }] });
  await assert.rejects(admit({ repositoryRoot: root, environment: environment(), fetchImpl: published.fetchImpl, log: quiet }), /already published/);
});

test('upload attaches exactly the DMG, replaces earlier assets, and refuses extras or a moved tag', async (t) => {
  const { root, assets } = await fixture(t);
  const github = fakeGitHub({ releases: [{ id: 1, tag_name: `v${version}`, draft: true, assets: [{ id: 9, name: `DevRyan-${version}-arm64.dmg` }] }] });
  const env = environment({ RELEASE_ID: '1', RELEASE_ASSET_DIRECTORY: assets });
  await upload({ repositoryRoot: root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  assert.deepEqual(github.state.releases[0].assets.map((asset) => [asset.name, asset.size]), [[`DevRyan-${version}-arm64.dmg`, 15]]);

  const moved = fakeGitHub({ releases: [{ id: 1, tag_name: `v${version}`, draft: true }], tagSha: 'c'.repeat(40) });
  await assert.rejects(upload({ repositoryRoot: root, environment: env, fetchImpl: moved.fetchImpl, log: quiet }), /now points at c{40}/);

  const { root: extraRoot, assets: extraAssets } = await fixture(t, { files: { [`DevRyan-${version}-arm64.dmg`]: 'x', 'latest-mac.yml': 'y' } });
  const dry = fakeGitHub();
  await assert.rejects(upload({ repositoryRoot: extraRoot, environment: environment({ RELEASE_DRY_RUN: 'true', RELEASE_ASSET_DIRECTORY: extraAssets }), fetchImpl: dry.fetchImpl, log: quiet }),
    /unexpected public assets:\n- latest-mac\.yml/);
  assert.deepEqual(dry.state.calls, []);
});

test('publish promotes the draft and waits until the shipped updater discovers the uploaded DMG', async (t) => {
  const { root, assets } = await fixture(t);
  const github = fakeGitHub({ releases: [{ id: 1, tag_name: `v${version}`, draft: true, prerelease: false }] });
  const env = environment({ RELEASE_ID: '1', RELEASE_ASSET_DIRECTORY: assets });
  await upload({ repositoryRoot: root, environment: env, fetchImpl: github.fetchImpl, log: quiet });
  const lines = [];
  await publish({ repositoryRoot: root, environment: env, fetchImpl: github.fetchImpl, log: (line) => lines.push(line), wait: async () => {} });
  assert.equal(github.state.releases[0].draft, false);
  assert.match(lines[0], /in-app updater discovers DevRyan-9\.8\.7-arm64\.dmg \(15 bytes/);

  const wrong = fakeGitHub({ releases: [{ id: 1, tag_name: `v${version}`, draft: true, prerelease: false, assets: [] }] });
  await assert.rejects(publish({ repositoryRoot: root, environment: env, fetchImpl: wrong.fetchImpl, log: quiet, wait: async () => {}, attempts: 2 }));
});
