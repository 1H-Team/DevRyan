import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASE_SCOPES, releaseAssetDownloadUrl, releaseAssetName, releaseAssetNames } from '../release-assets.mjs';

test('names every installable platform with DevRyan branding', () => {
  assert.equal(releaseAssetName('macos-arm64', '2.0.2'), 'DevRyan-2.0.2-arm64.dmg');
  assert.equal(releaseAssetName('win-x64', '2.0.2'), 'DevRyan-2.0.2-win-x64.exe');
  assert.equal(releaseAssetName('win-arm64', '2.0.2'), 'DevRyan-2.0.2-win-arm64.exe');
  assert.equal(releaseAssetName('web', '2.0.2'), 'DevRyan-web-2.0.2.tgz');
});

test('scopes are exact lists', () => {
  assert.deepEqual(releaseAssetNames('desktop-macos-arm64', '2.0.2'), ['DevRyan-2.0.2-arm64.dmg']);
  assert.deepEqual(releaseAssetNames('desktop', '2.0.2'), ['DevRyan-2.0.2-arm64.dmg', 'DevRyan-2.0.2-win-x64.exe', 'DevRyan-2.0.2-win-arm64.exe']);
  assert.deepEqual(releaseAssetNames('full', '2.0.2'), ['DevRyan-2.0.2-arm64.dmg', 'DevRyan-web-2.0.2.tgz']);
  assert.ok(Object.isFrozen(RELEASE_SCOPES) && Object.isFrozen(RELEASE_SCOPES.desktop));
});

test('refuses unknown platforms, scopes and non x.y.z versions', () => {
  assert.throws(() => releaseAssetName('linux-x64', '2.0.2'), /platform/);
  assert.throws(() => releaseAssetName('toString', '2.0.2'), /platform/);
  assert.throws(() => releaseAssetNames('everything', '2.0.2'), /scope/);
  for (const version of ['2.0.2-beta.1', 'v2.0.2', '2.0.2/../../x', '', null]) assert.throws(() => releaseAssetName('macos-arm64', version), /x\.y\.z/);
});

test('builds the exact release download URL', () => {
  assert.equal(releaseAssetDownloadUrl('macos-arm64', '2.0.2'), 'https://github.com/1H-Team/DevRyan/releases/download/v2.0.2/DevRyan-2.0.2-arm64.dmg');
});
