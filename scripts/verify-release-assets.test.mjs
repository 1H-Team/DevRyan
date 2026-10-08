import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  describeDirectoryAssets,
  expectedReleaseDigests,
  fetchReleaseAssets,
  fetchReleaseByTag,
  legacyBrandedReleaseAssetNames,
  parseArguments,
  releaseDigestVariable,
  requiredReleaseAssetNames,
  unsupportedExtensionAssets,
  verifyReleaseAssets,
} from './verify-release-assets.mjs';

const script = fileURLToPath(new URL('./verify-release-assets.mjs', import.meta.url));
const DMG = 'DevRyan-2.0.2-arm64.dmg';
const WEB = 'DevRyan-web-2.0.2.tgz';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const uploaded = (name, text = name) => ({ name, size: Buffer.byteLength(text), state: 'uploaded', digest: `sha256:${sha(text)}` });
const digests = (...names) => new Map(names.map((name) => [name, sha(name)]));
const verify = (assets, scope = 'desktop-macos-arm64', expected = digests(DMG, WEB)) => verifyReleaseAssets(assets, { version: '2.0.2', scope, digests: expected });

describe('release asset verification', () => {
  it('takes each scope allowlist from the shared release asset table', () => {
    assert.deepEqual(requiredReleaseAssetNames('2.0.2', 'desktop-macos-arm64'), [DMG]);
    assert.deepEqual(requiredReleaseAssetNames('2.0.2', 'full'), [DMG, WEB]);
    assert.deepEqual(requiredReleaseAssetNames('2.0.2', 'desktop'), [DMG, 'DevRyan-2.0.2-win-x64.exe', 'DevRyan-2.0.2-win-arm64.exe']);
    assert.throws(() => requiredReleaseAssetNames('2.0.2', 'unknown'), /Unknown release distribution scope/);
    assert.throws(() => requiredReleaseAssetNames('2.0.2-rc.1', 'full'), /x\.y\.z/);
  });

  it('accepts exactly the uploaded, non-empty scope assets with the packaged digests', () => {
    assert.deepEqual(verify([uploaded(DMG)]), []);
    assert.deepEqual(verify([uploaded(WEB), uploaded(DMG)], 'full'), []);
  });

  it('fails when a scope asset is missing', () => {
    assert.deepEqual(verify([]), [`missing required assets:\n- ${DMG}`]);
    assert.deepEqual(verify([uploaded(DMG)], 'full'), [`missing required assets:\n- ${WEB}`]);
    assert.match(verify([uploaded('DevRyan-2.0.1-arm64.dmg')]).join('\n'), /missing required assets:\n- DevRyan-2\.0\.2-arm64\.dmg/);
  });

  it('fails on updater metadata, ZIP, blockmaps, Bot manifest, duplicates and off-scope assets', () => {
    const extras = [
      'latest-mac.yml',
      'DevRyan-2.0.2-arm64.zip',
      'DevRyan-2.0.2-arm64.dmg.blockmap',
      'DevRyan-2.0.2-arm64.zip.blockmap',
      'DevRyan-bot-runtime-images-2.0.2.json',
      WEB,
      'DevRyan-2.0.1-arm64.dmg',
    ];
    const failures = verify([uploaded(DMG), ...extras.map((name) => uploaded(name))]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0], `unexpected public assets:\n${extras.map((name) => `- ${name}`).join('\n')}`);
    assert.deepEqual(verify([uploaded(DMG), uploaded(DMG)]), [`duplicate assets:\n- ${DMG}`]);
  });

  it('fails on legacy-prefixed and extension assets even beside the exact allowlist', () => {
    assert.deepEqual(verify([
      uploaded(DMG),
      uploaded('OpenChamber-2.0.2-arm64.dmg'),
      uploaded('openchamber-web-2.0.2.tgz'),
      uploaded('DevRyan-2.0.2.vsix'),
    ]), [
      'unsupported extension assets:\n- DevRyan-2.0.2.vsix',
      'legacy-branded public assets:\n- OpenChamber-2.0.2-arm64.dmg\n- openchamber-web-2.0.2.tgz',
    ]);
    assert.deepEqual(unsupportedExtensionAssets(['DevRyan-1.1.13.vsix', 'legacy.VSIX', 'DevRyan-1.1.13.vsix.sha256', 'DevRyan-vscode-vsix.zip', DMG]),
      ['DevRyan-1.1.13.vsix', 'legacy.VSIX', 'DevRyan-1.1.13.vsix.sha256', 'DevRyan-vscode-vsix.zip']);
    assert.deepEqual(legacyBrandedReleaseAssetNames(['DevRyan-1.1.1-arm64.dmg', 'OpenChamber_1.1.1_arm64.dmg', 'OPENCHAMBER-legacy.zip', 'latest-mac.yml']),
      ['OpenChamber_1.1.1_arm64.dmg', 'OPENCHAMBER-legacy.zip']);
  });

  it('fails on a pending upload, an empty asset, or a digest that differs from the packaging job', () => {
    const integrity = (asset) => verify([{ ...uploaded(DMG), ...asset }]);
    assert.deepEqual(integrity({ state: 'open' }), [`asset integrity failures:\n- ${DMG} is not uploaded (open)`]);
    assert.deepEqual(integrity({ size: 0 }), [`asset integrity failures:\n- ${DMG} is empty`]);
    assert.match(integrity({ digest: `sha256:${sha('tampered')}` })[0], /DevRyan-2\.0\.2-arm64\.dmg digest sha256:[a-f0-9]{64} does not match the packaged sha256:/);
    assert.match(integrity({ digest: null })[0], /digest missing does not match/);
    assert.match(verify([uploaded(DMG)], 'desktop-macos-arm64', new Map())[0], /packaged sha256:missing/);
  });

  it('reads one packaging digest per scope platform and rejects missing or malformed values', () => {
    assert.equal(releaseDigestVariable('macos-arm64'), 'RELEASE_SHA256_MACOS_ARM64');
    assert.equal(releaseDigestVariable('win-arm64'), 'RELEASE_SHA256_WIN_ARM64');
    const environment = { RELEASE_SHA256_MACOS_ARM64: sha('dmg'), RELEASE_SHA256_WEB: sha('web') };
    assert.deepEqual([...expectedReleaseDigests('full', '2.0.2', environment)], [[DMG, sha('dmg')], [WEB, sha('web')]]);
    assert.deepEqual([...expectedReleaseDigests('desktop-macos-arm64', '2.0.2', environment)], [[DMG, sha('dmg')]]);
    assert.throws(() => expectedReleaseDigests('desktop', '2.0.2', environment), /RELEASE_SHA256_WIN_X64 must be/);
    assert.throws(() => expectedReleaseDigests('full', '2.0.2', { ...environment, RELEASE_SHA256_WEB: '' }), /RELEASE_SHA256_WEB must be/);
    assert.throws(() => expectedReleaseDigests('desktop-macos-arm64', '2.0.2', { RELEASE_SHA256_MACOS_ARM64: sha('dmg').toUpperCase() }), /must be/);
    assert.throws(() => expectedReleaseDigests('unknown', '2.0.2', environment), /Unknown release distribution scope/);
  });

  it('describes staged files for directory mode, flagging non-files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'release-assets-'));
    try {
      await fs.writeFile(path.join(directory, DMG), DMG);
      await fs.mkdir(path.join(directory, 'nested'));
      assert.deepEqual(await describeDirectoryAssets(directory), [
        uploaded(DMG),
        { name: 'nested', size: 0, state: 'not a regular file', digest: null },
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('verifies a dry-run directory end to end and fails closed on extras, mismatches and bad arguments', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'release-assets-'));
    const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, VERSION: '2.0.2', RELEASE_SCOPE: 'desktop-macos-arm64', RELEASE_SHA256_MACOS_ARM64: sha(DMG), ...extra },
    });
    try {
      await fs.writeFile(path.join(directory, DMG), DMG);
      const passed = run(['--directory', directory]);
      assert.equal(passed.status, 0, passed.stderr);
      assert.match(passed.stdout, /exactly the desktop-macos-arm64 public assets/);
      assert.notEqual(run(['--directory', directory], { RELEASE_SHA256_MACOS_ARM64: sha('other') }).status, 0);
      assert.notEqual(run(['--directory', directory], { RELEASE_SCOPE: 'full', RELEASE_SHA256_WEB: sha(WEB) }).status, 0);
      assert.match(run(['--directory', directory], { RELEASE_SHA256_MACOS_ARM64: '' }).stderr, /RELEASE_SHA256_MACOS_ARM64 must be/);
      await fs.writeFile(path.join(directory, 'latest-mac.yml'), 'x');
      assert.match(run(['--directory', directory]).stderr, /unexpected public assets:\n- latest-mac\.yml/);
      assert.match(run(['--directory']).stderr, /Usage: verify-release-assets\.mjs/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    assert.deepEqual(parseArguments([]), { directory: null });
    assert.deepEqual(parseArguments(['--directory', 'release-assets']), { directory: 'release-assets' });
    assert.throws(() => parseArguments(['--scope', 'full']), /Usage/);
  });

  it('reads draft release assets with their state, size and API digest across pages', async () => {
    const requests = [];
    const page = Array.from({ length: 100 }, (_, index) => ({ name: `extra-${index}`, size: 1, state: 'uploaded', digest: null, id: index }));
    const fetchImpl = async (url) => {
      requests.push(url);
      const json = (body) => ({ ok: true, status: 200, json: async () => body });
      if (url.endsWith('/releases/tags/v2.0.2')) return json({ id: 7, tag_name: 'v2.0.2', draft: true });
      if (url.endsWith('/releases/7/assets?per_page=100&page=1')) return json(page);
      if (url.endsWith('/releases/7/assets?per_page=100&page=2')) return json([{ ...uploaded(DMG), id: 101, browser_download_url: 'x' }]);
      throw new Error(`unexpected request ${url}`);
    };
    const assets = await fetchReleaseAssets({ repo: '1H-Team/DevRyan', tag: 'v2.0.2', token: 'test-token', fetchImpl });
    assert.equal(assets.length, 101);
    assert.deepEqual(assets.at(-1), uploaded(DMG));
    assert.deepEqual(assets[0], { name: 'extra-0', size: 1, state: 'uploaded', digest: null });
    assert.equal(requests.length, 3);
  });

  it('finds a draft when GitHub does not expose it through the tag endpoint', async () => {
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.includes('/releases/tags/')) {
        return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
      }
      return { ok: true, status: 200, json: async () => [{ id: 42, tag_name: 'v1.1.8', draft: true }] };
    };

    const release = await fetchReleaseByTag({ repo: '1H-Team/DevRyan', tag: 'v1.1.8', token: 'test-token', fetchImpl });

    assert.deepEqual(release, { id: 42, tag_name: 'v1.1.8', draft: true });
    assert.equal(requests.length, 2);
    assert.match(requests[1], /\/releases\?per_page=100&page=1$/);
  });
});
