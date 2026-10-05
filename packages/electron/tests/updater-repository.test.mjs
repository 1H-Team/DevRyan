import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RELEASE_REPOSITORY } from '../release-assets.mjs';

const mainSource = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("Electron update discovery targets DevRyan and packaging ships DMG without updater metadata", () => {
  assert.match(mainSource, /const GITHUB_REPOSITORY_OWNER = '1H-Team';/);
  assert.match(mainSource, /const GITHUB_REPOSITORY_NAME = 'DevRyan';/);
  assert.match(
    mainSource,
    /https:\/\/api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY_OWNER\}\/\$\{GITHUB_REPOSITORY_NAME\}/,
  );
  assert.doesNotMatch(mainSource, /github\.com\/btriapitsyn\/openchamber/);
  const updater = readFileSync(new URL('../desktop-updater.mjs', import.meta.url), 'utf8');
  assert.equal(RELEASE_REPOSITORY, '1H-Team/DevRyan');
  assert.match(updater, /api\.github\.com\/repos\/\$\{RELEASE_REPOSITORY\}\/releases\/latest/);
  assert.equal(packageJson.build.publish, undefined);
  assert.equal(packageJson.dependencies['electron-updater'], undefined);
  assert.deepEqual(packageJson.build.mac.target, ['dmg']);
  assert.equal(packageJson.build.mac.notarize, false);
  assert.ok(packageJson.build.files.includes('dist-bundle/desktop-update-install.mjs'));
});
