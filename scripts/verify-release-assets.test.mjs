import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchReleaseByTag,
  legacyBrandedReleaseAssetNames,
  missingRequiredReleaseAssets,
  requiredReleaseAssetNames,
  unexpectedReleaseAssets,
  unsupportedExtensionAssets,
  verifyReleaseAssetNames,
} from './verify-release-assets.mjs';

describe('release asset verification', () => {
  it('desktop-only scope publishes exactly the arm64 DMG and full adds the web tarball', () => {
    assert.deepEqual(requiredReleaseAssetNames('2.0.1', 'desktop-macos-arm64'), ['DevRyan-2.0.1-arm64.dmg']);
    assert.deepEqual(requiredReleaseAssetNames('2.0.1'), ['DevRyan-2.0.1-arm64.dmg', 'DevRyan-web-2.0.1.tgz']);
    assert.deepEqual(verifyReleaseAssetNames(['DevRyan-2.0.1-arm64.dmg'], '2.0.1', 'desktop-macos-arm64'), []);
    assert.deepEqual(verifyReleaseAssetNames(['DevRyan-web-2.0.1.tgz', 'DevRyan-2.0.1-arm64.dmg'], '2.0.1', 'full'), []);
    assert.throws(() => requiredReleaseAssetNames('2.0.0', 'unknown'), /Unknown release distribution scope/);
  });

  it('fails when the DMG or the full-scope web tarball is missing', () => {
    const [desktop] = verifyReleaseAssetNames([], '2.0.1', 'desktop-macos-arm64');
    assert.match(desktop, /missing required assets:\n- DevRyan-2\.0\.1-arm64\.dmg$/);
    assert.deepEqual(missingRequiredReleaseAssets(['DevRyan-2.0.1-arm64.dmg'], '2.0.1'), ['DevRyan-web-2.0.1.tgz']);
    assert.deepEqual(missingRequiredReleaseAssets(['DevRyan-2.0.0-arm64.dmg'], '2.0.1', 'desktop-macos-arm64'), ['DevRyan-2.0.1-arm64.dmg']);
  });

  it('fails on updater metadata, ZIP, blockmaps, Bot manifest and off-scope assets', () => {
    const extras = [
      'latest-mac.yml',
      'DevRyan-2.0.1-arm64.zip',
      'DevRyan-2.0.1-arm64.dmg.blockmap',
      'DevRyan-2.0.1-arm64.zip.blockmap',
      'DevRyan-bot-runtime-images-2.0.1.json',
      'DevRyan-web-2.0.1.tgz',
      'DevRyan-2.0.0-arm64.dmg',
    ];
    const assets = ['DevRyan-2.0.1-arm64.dmg', ...extras];
    assert.deepEqual(unexpectedReleaseAssets(assets, '2.0.1', 'desktop-macos-arm64'), extras);
    const failures = verifyReleaseAssetNames(assets, '2.0.1', 'desktop-macos-arm64');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^unexpected public assets:/);
    for (const name of extras) assert.ok(failures[0].includes(`- ${name}`), name);
    assert.equal(unexpectedReleaseAssets(assets, '2.0.1').includes('DevRyan-web-2.0.1.tgz'), false);
    assert.match(verifyReleaseAssetNames(['DevRyan-2.0.1-arm64.dmg', 'DevRyan-2.0.1-arm64.dmg'], '2.0.1', 'desktop-macos-arm64')[0], /^duplicate assets:/);
  });

  it('fails on legacy-prefixed and extension assets even beside the exact allowlist', () => {
    const failures = verifyReleaseAssetNames([
      'DevRyan-2.0.1-arm64.dmg',
      'OpenChamber-2.0.1-arm64.dmg',
      'openchamber-web-2.0.1.tgz',
      'DevRyan-2.0.1.vsix',
    ], '2.0.1', 'desktop-macos-arm64');
    assert.deepEqual(failures, [
      'unsupported extension assets:\n- DevRyan-2.0.1.vsix',
      'legacy-branded public assets:\n- OpenChamber-2.0.1-arm64.dmg\n- openchamber-web-2.0.1.tgz',
    ]);
  });

  it('rejects extension packages and their download artifacts regardless of branding', () => {
    assert.deepEqual(unsupportedExtensionAssets([
      'DevRyan-1.1.13.vsix',
      'legacy.VSIX',
      'DevRyan-1.1.13.vsix.sha256',
      'DevRyan-vscode-vsix.zip',
      ...requiredReleaseAssetNames('1.1.13'),
    ]), [
      'DevRyan-1.1.13.vsix',
      'legacy.VSIX',
      'DevRyan-1.1.13.vsix.sha256',
      'DevRyan-vscode-vsix.zip',
    ]);
  });
  it('finds a draft when GitHub does not expose it through the tag endpoint', async () => {
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.includes('/releases/tags/')) {
        return {
          ok: false,
          status: 404,
          text: async () => '{"message":"Not Found"}',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 42, tag_name: 'v1.1.8', draft: true }],
      };
    };

    const release = await fetchReleaseByTag({
      repo: '1H-Team/DevRyan',
      tag: 'v1.1.8',
      token: 'test-token',
      fetchImpl,
    });

    assert.deepEqual(release, { id: 42, tag_name: 'v1.1.8', draft: true });
    assert.equal(requests.length, 2);
    assert.match(requests[1], /\/releases\?per_page=100&page=1$/);
  });

  it('rejects public release assets with the legacy product prefix', () => {
    assert.deepEqual(
      legacyBrandedReleaseAssetNames([
        'DevRyan-1.1.1-arm64.dmg',
        'openchamber-web-1.1.1.tgz',
        'OpenChamber_1.1.1_arm64.dmg',
        'OPENCHAMBER-legacy.zip',
        'OpenChamber-bot-runtime-images-1.1.1.json',
        'latest-mac.yml',
      ]),
      [
        'openchamber-web-1.1.1.tgz',
        'OpenChamber_1.1.1_arm64.dmg',
        'OPENCHAMBER-legacy.zip',
        'OpenChamber-bot-runtime-images-1.1.1.json',
      ],
    );
  });
});
