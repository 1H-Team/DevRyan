import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchReleaseByTag,
  legacyBrandedReleaseAssetNames,
  missingRequiredReleaseAssets,
  requiredReleaseAssetNames,
  unsupportedExtensionAssets,
} from './verify-release-assets.mjs';

describe('release asset verification', () => {
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

  it('requires both macOS app package architectures and update metadata', () => {
    assert.deepEqual(requiredReleaseAssetNames('1.1.1'), [
      'DevRyan-1.1.1-arm64.dmg',
      'DevRyan-1.1.1-arm64.dmg.blockmap',
      'DevRyan-1.1.1-arm64.zip',
      'DevRyan-1.1.1-arm64.zip.blockmap',
      'DevRyan-1.1.1-x64.dmg',
      'DevRyan-1.1.1-x64.dmg.blockmap',
      'DevRyan-1.1.1-x64.zip',
      'DevRyan-1.1.1-x64.zip.blockmap',
      'latest-mac.yml',
      'DevRyan-web-1.1.1.tgz',
      'DevRyan-bot-runtime-images-1.1.1.json',
    ]);
  });

  it('reports exactly which required release assets are missing', () => {
    const missing = missingRequiredReleaseAssets(
      [
        'DevRyan-1.1.1-arm64.dmg',
        'DevRyan-1.1.1-arm64.dmg.blockmap',
        'DevRyan-1.1.1-arm64.zip',
        'DevRyan-1.1.1-arm64.zip.blockmap',
        'DevRyan-1.1.1-x64.dmg',
        'DevRyan-1.1.1-x64.dmg.blockmap',
        'latest-mac.yml',
      ],
      '1.1.1',
    );

    assert.deepEqual(missing, [
      'DevRyan-1.1.1-x64.zip',
      'DevRyan-1.1.1-x64.zip.blockmap',
      'DevRyan-web-1.1.1.tgz',
      'DevRyan-bot-runtime-images-1.1.1.json',
    ]);
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
