import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  legacyBrandedReleaseAssetNames,
  missingRequiredReleaseAssets,
  requiredReleaseAssetNames,
} from './verify-release-assets.mjs';

describe('release asset verification', () => {
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
