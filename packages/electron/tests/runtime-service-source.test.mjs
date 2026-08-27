import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

const mainSource = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const releaseWorkflow = fs.readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
const helperBuildSource = fs.readFileSync(
  new URL('../scripts/build-runtime-service-control.mjs', import.meta.url),
  'utf8',
);
const adhocSignSource = fs.readFileSync(
  new URL('../scripts/adhoc-sign-macos-app.mjs', import.meta.url),
  'utf8',
);

describe('runtime-service desktop bootstrap source contract', () => {
  test('background mode owns the server and returns before creating a window', () => {
    const readyBranch = mainSource.slice(
      mainSource.indexOf('app.whenReady().then(async () => {'),
      mainSource.indexOf('nativeTheme.themeSource = readThemeSource();'),
    );

    assert.match(readyBranch, /if \(isRuntimeServiceMode\)/);
    assert.match(readyBranch, /acquire\(\{ mode: 'service' \}\)/);
    assert.match(readyBranch, /await spawnLocalServer\(\)/);
    assert.match(readyBranch, /prepareBotRuntimeInBackground\(\)/);
    assert.match(readyBranch, /return;/);
    assert.doesNotMatch(readyBranch, /createBrowserWindow\(/);
  });

  test('ordinary desktop activation precedes non-blocking Docker preparation', () => {
    const startup = mainSource.slice(
      mainSource.indexOf('const startDesktopRuntime = () => {'),
      mainSource.indexOf("app.on('before-quit'"),
    );
    const activation = startup.indexOf('await activateMainWindow(initialUrl, localOrigin, bootOutcome);');
    const preparation = startup.indexOf('prepareBotRuntimeInBackground();');

    assert.notEqual(activation, -1);
    assert.notEqual(preparation, -1);
    assert.ok(activation < preparation, 'the renderer must activate before Docker preparation begins');
    assert.doesNotMatch(startup, /await requirePreparedBotRuntime\(\);[\s\S]*activateMainWindow\(initialUrl/);
  });

  test('packages the signed service helper and LaunchAgent template', () => {
    assert.match(packageManifest.scripts['build:native-helpers'], /build:runtime-service-control/);
    assert.match(packageManifest.scripts.package, /build:native-helpers/);
    assert.match(packageManifest.scripts.package, /verify:runtime-service-package/);
    assert.match(releaseWorkflow, /bun run build:native-helpers/);
    assert.match(releaseWorkflow, /bun run verify:runtime-service-package/);
    assert.match(helperBuildSource, /ELECTRON_BUILDER_ARCH/);
    assert.match(helperBuildSource, /x86_64-apple-macosx13\.0/);
    assert.match(helperBuildSource, /arm64-apple-macosx13\.0/);
    assert.match(adhocSignSource, /DevRyanRuntimeServiceControl/);
    assert.match(
      adhocSignSource,
      /run\("codesign", \["--force", "--sign", "-", runtimeServiceHelperPath\]\)/,
    );
    assert.ok(packageManifest.build.extraResources.some((resource) => (
      resource.from === 'resources/native' && resource.to === 'native'
    )));
    assert.ok(packageManifest.build.extraFiles.some((resource) => (
      resource.to === 'Library/LaunchAgents/dev.openchamber.desktop.runtime-service.plist'
    )));
  });
});
