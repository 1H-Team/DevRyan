import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RELEASE_SCOPES, releaseAssetName } from '../packages/electron/release-assets.mjs';

// electron-builder configuration that decides what the release DMG is (docs/RELEASE_PIPELINE.md).
const manifest = JSON.parse(readFileSync(new URL('../packages/electron/package.json', import.meta.url), 'utf8'));
const { build } = manifest;

test('the macOS artifact name expands to the single allowlisted release asset', () => {
  assert.deepEqual(Object.keys(RELEASE_SCOPES), ['desktop-macos-arm64']);
  const expanded = build.artifactName.replaceAll('${productName}', build.productName).replaceAll('${version}', '9.8.7')
    .replaceAll('${arch}', 'arm64').replaceAll('${ext}', 'dmg');
  assert.equal(expanded, releaseAssetName('macos-arm64', '9.8.7'));
  assert.equal(build.productName, 'DevRyan');
});

test('macOS packaging builds only a DMG, publishes nothing and signs ad hoc without notarization', () => {
  assert.deepEqual(build.mac.target, ['dmg']);
  for (const section of [build, build.mac, build.dmg]) assert.equal(Object.hasOwn(section, 'publish'), false, 'electron-builder must never publish');
  assert.equal(build.mac.notarize, false);
  assert.equal(build.afterPack, './scripts/adhoc-sign-macos-app.mjs');
  assert.ok(existsSync(new URL('../packages/electron/scripts/adhoc-sign-macos-app.mjs', import.meta.url)));
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /package-prepared\.mjs --mac --arm64 --publish=never -c\.mac\.identity=null -c\.mac\.notarize=false/);
});
