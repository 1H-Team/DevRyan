import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  describeDirectoryAssets,
  legacyBrandedReleaseAssetNames,
  requiredReleaseAssetNames,
  unsupportedExtensionAssets,
  verifyReleaseAssets,
} from './verify-release-assets.mjs';

const DMG = 'DevRyan-2.0.2-arm64.dmg';
const WEB = 'DevRyan-web-2.0.2.tgz';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const uploaded = (name, text = name) => ({ name, size: Buffer.byteLength(text), state: 'uploaded', digest: `sha256:${sha(text)}` });
const digests = (...names) => new Map(names.map((name) => [name, sha(name)]));
const verify = (assets, scope = 'desktop-macos-arm64', expected = digests(DMG, WEB)) => verifyReleaseAssets(assets, { version: '2.0.2', scope, digests: expected });

describe('release asset verification', () => {
  it('takes each scope allowlist from the shared release asset table', () => {
    assert.deepEqual(requiredReleaseAssetNames('2.0.2', 'desktop-macos-arm64'), [DMG]);
    assert.deepEqual(requiredReleaseAssetNames('2.0.2'), [DMG]);
    assert.throws(() => requiredReleaseAssetNames('2.0.2', 'full'), /Unknown release distribution scope/);
    assert.throws(() => requiredReleaseAssetNames('2.0.2-rc.1'), /x\.y\.z/);
  });

  it('accepts exactly the uploaded, non-empty scope assets with the packaged digests', () => {
    assert.deepEqual(verify([uploaded(DMG)]), []);
  });

  it('fails when a scope asset is missing', () => {
    assert.deepEqual(verify([]), [`missing required assets:\n- ${DMG}`]);
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

  it('rejects a partial starter upload, a duplicate installer and the v2.0.10 docs tarball', () => {
    assert.deepEqual(verify([{ ...uploaded(DMG), state: 'starter', digest: null }]), [`asset integrity failures:\n- ${DMG} is not uploaded (starter)`]);
    assert.deepEqual(verify([uploaded(DMG), uploaded(DMG)]), [`duplicate assets:\n- ${DMG}`]);
    assert.deepEqual(verify([uploaded(DMG), uploaded('DevRyan-docs-source-aa5da4d8.tar.gz')]), ['unexpected public assets:\n- DevRyan-docs-source-aa5da4d8.tar.gz']);
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
});
