import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

const earlySource = fs.readFileSync(new URL('../early-startup.mjs', import.meta.url), 'utf8');
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
const packageVerifierSource = fs.readFileSync(
  new URL('../scripts/verify-runtime-service-package.mjs', import.meta.url),
  'utf8',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

describe('retired background runtime source contract', () => {
  test('desktop startup never touches OS-sealed storage and never starts a background service', () => {
    assert.doesNotMatch(mainSource, /safeStorage/);
    assert.doesNotMatch(mainSource, /acquireRuntimeOwner\('service'\)|runtimeServiceCoordinator\.start\(|setActivationPolicy\(/);
    assert.doesNotMatch(mainSource, /runtime-service-connection|desktop-host-broker|bot-secret-store|bot-recovery-dialog/);
    assert.match(mainSource, /acquireRuntimeOwner\('app_bound'\)/);
    assert.match(mainSource, /deferOpenCodeStartup: true/);
    assert.doesNotMatch(mainSource, /productionBotsExecution|BotRuns|BotDispatcher|BotIndexer|stopRetiredBots|bot-retirement/);
  });

  test('a launchd start of the retired service exits successfully before any startup work', () => {
    const exit = earlySource.indexOf('if (isRuntimeServiceMode) {\n    app.exit(0);\n    return false;\n  }');
    assert.notEqual(exit, -1);
    assert.ok(exit < earlySource.indexOf('app.requestSingleInstanceLock()'));
    assert.match(earlySource.slice(0, exit), /if \(isRuntimeServiceMode \|\| isRuntimeServiceControlProbe\) \{\s+hideHeadlessProcessFromDock\(\);/);
    assert.equal(earlySource.match(/app\.dock\?\.hide\(\)/g)?.length, 1);
  });

  test('the leftover registration is retired before the first local server start', () => {
    const preparation = mainSource.slice(
      mainSource.indexOf('const prepareForegroundRuntime = async () => {'),
      mainSource.indexOf('const startDesktopRuntime = () => {'),
    );
    assert.match(preparation, /await retireBackgroundRuntime\(\);/);
    const startup = mainSource.slice(mainSource.indexOf('const startDesktopRuntime = () => {'));
    assert.ok(startup.indexOf("runStartupPhase('foreground_preparation'") < startup.indexOf("runStartupPhase('initial_url'"));
  });

  // Installed 2.1.x updaters verify that an update bundle still carries the
  // service LaunchAgent and the native bridge, which also performs the swap.
  test('packages the in-process service bridge and LaunchAgent template for unsigned releases', () => {
    assert.match(packageManifest.scripts['build:native-helpers'], /build:runtime-service-control/);
    assert.match(packageManifest.scripts['prepare:native'], /build:native-helpers/);
    assert.match(packageManifest.scripts.package, /prepare && bun run package:prepared/);
    assert.match(packageManifest.scripts['package:prepared'], /package-prepared/);
    assert.match(releaseWorkflow, /bun run build:native-helpers/);
    assert.match(
      releaseWorkflow,
      /node scripts\/package-prepared\.mjs --mac --arm64 /,
    );
    assert.match(releaseWorkflow, /-c\.mac\.identity=null -c\.mac\.notarize=false -c\.dmg\.sign=false/);
    assert.doesNotMatch(releaseWorkflow, /--require-developer-id/);
    assert.match(helperBuildSource, /ELECTRON_BUILDER_ARCH/);
    assert.match(helperBuildSource, /DevRyanRuntimeServiceControl\.node/);
    assert.match(helperBuildSource, /clangArch: 'x86_64'/);
    assert.match(helperBuildSource, /clangArch: 'arm64'/);
    assert.match(helperBuildSource, /path\.dirname\(process\.execPath\)/);
    assert.match(helperBuildSource, /npm_config_nodedir/);
    assert.match(adhocSignSource, /DevRyanRuntimeServiceControl\.node/);
    assert.match(
      adhocSignSource,
      /run\("codesign", \["--force", "--sign", "-", runtimeServiceBridgePath\]\)/,
    );
    assert.ok(packageManifest.build.mac.extraResources.some((resource) => (
      resource.from === 'resources/native' && resource.to === 'native'
    )));
    assert.ok(packageManifest.build.mac.extraFiles.some((resource) => (
      resource.to === 'Library/LaunchAgents/dev.devryan.desktop.runtime-service.plist'
    )));
    assert.ok(packageManifest.build.mac.extraFiles.some((resource) => (
      resource.to === 'Library/LaunchAgents/dev.openchamber.desktop.runtime-service.plist'
    )));
    assert.match(packageVerifierSource, /DevRyan-\$\{packageManifest\.version\}-\$\{requestedArchitecture\}/);
    assert.match(packageVerifierSource, /runtime-service-control=status/);
    assert.match(packageVerifierSource, /allowedStatuses: \[0\]/);
    assert.match(packageVerifierSource, /status\?\.state === 'not_found'/);
    assert.doesNotMatch(packageVerifierSource, /\.zip|ditto', \['-x', '-k'/);
    assert.match(packageVerifierSource, /hdiutil', \['attach'/);
    assert.match(packageVerifierSource, /\['attach', '-nobrowse', '-readonly'/);
    assert.match(packageVerifierSource, /must be signed with a Developer ID identity/);
    assert.match(packageVerifierSource, /native bridge is not executable/);
  });
});

test('local publication holds settings for recovery and mints only the local owner cookie', async () => {
  const start = mainSource.indexOf('  state.serverHandle = handle;');
  assert.notEqual(start, -1);
  const end = mainSource.indexOf('\n  // Managed startup', start);
  assert.ok(end > start);
  const publish = new AsyncFunction('state', 'handle', 'url', 'holdDesktopSettingsForCheckpoint', 'session',
    mainSource.slice(start, end));
  for (const bundleStatus of [{ reconciliationRequired: false }, { reconciliationRequired: true },
    { state: 'held', reconciliationRequired: false }]) {
    const held = bundleStatus.state === 'held' || bundleStatus.reconciliationRequired;
    const ordering = [], cookies = [], state = {};
    await publish(state, {
      runtimeBundle: { inspect: async () => { ordering.push('inspected'); return bundleStatus; } },
      issueLocalOwnerSession: async () => { ordering.push('owner-cookie'); return { name: 'owner', value: 'v', maxAge: 60 }; },
    }, 'http://127.0.0.1:41234', async () => ordering.push('settings-held'),
    { defaultSession: { cookies: { set: async value => cookies.push(value.name) } } });
    assert.deepEqual(ordering, held ? ['inspected', 'settings-held'] : ['inspected', 'owner-cookie']);
    assert.deepEqual(cookies, held ? [] : ['owner']);
    assert.equal(state.sidecarUrl, 'http://127.0.0.1:41234');
  }
});

test('bundle checkpoint awaits the desktop settings writer', async () => {
  const start = mainSource.indexOf('    onRuntimeBundleCheckpoint: async () => {');
  const end = mainSource.indexOf('\n    onRestartHost:', start);
  assert.notEqual(start, -1);
  const factory = new Function('holdDesktopSettingsForCheckpoint',
    `return ({${mainSource.slice(start, end)}}).onRuntimeBundleCheckpoint;`);
  let calls = 0;
  const release = Promise.withResolvers();
  let settled = false;
  const draining = factory(() => { calls++; return release.promise; })().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(settled, false);
  release.resolve();
  await draining;
  assert.equal(settled, true);
});
