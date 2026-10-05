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
const packageVerifierSource = fs.readFileSync(
  new URL('../scripts/verify-runtime-service-package.mjs', import.meta.url),
  'utf8',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

describe('runtime-service desktop bootstrap source contract', () => {
  test('post-update registration and connection failures share guarded startup recovery', () => {
    const preparation = mainSource.slice(
      mainSource.indexOf('const prepareForegroundRuntime = async () => {'),
      mainSource.indexOf('const startDesktopRuntime = () => {'),
    );
    assert.match(preparation, /try \{\s+await resumeBackgroundRuntimeAfterAppUpdate\(\);\s+await reregisterBackgroundRuntimeAfterManualUpgrade\(\);\s+await ensureRuntimeServiceRegistered\(\{ registration: getRuntimeServiceRegistration\(\), log \}\);\s+await waitForRuntimeServiceConnection\(\);\s+\} catch \(error\) \{\s+await recoverStartupToAppBound\(error\);/);
  });

  test('ordinary and held background startup own the server without opening a recovery window', async () => {
    const marker = 'app.whenReady().then(async () => {';
    const start = mainSource.indexOf(marker);
    const end = mainSource.indexOf('nativeTheme.themeSource = readThemeSource();', start);
    assert.notEqual(start, -1);
    assert.ok(end > start);
    const ready = new AsyncFunction('owners', `
      const { app, log, APP_VERSION, process, isRuntimeServiceControlProbe,
        isRuntimeServiceMode, runtimeBundleRecoveryRequired, shellRuntimeBundleBindingError, holdDesktopSettingsForCheckpoint,
        performConfirmedQuit, state, createBrowserWindow, startDesktopRuntime,
        acquireRuntimeOwner, spawnLocalServer, prepareBotRuntimeInBackground,
        shutdownOwnedRuntimeService, desktopDmgInstaller = null } = owners;
      ${mainSource.slice(start + marker.length, end)}
      throw new Error('startup did not return before ordinary foreground setup');
    `);
    for (const serviceMode of [true, false]) for (const held of [false, true]) {
      if (!serviceMode && !held) continue; // Ordinary foreground startup follows the remaining body.
      const calls = [], signals = [], state = {};
      const window = {};
      await ready({
        app: { isPackaged: true, setActivationPolicy: () => calls.push('accessory') },
        log: { info: () => {} }, APP_VERSION: 'fixture',
        process: { platform: 'darwin', arch: 'arm64', once: name => signals.push(name) },
        isRuntimeServiceControlProbe: false, isRuntimeServiceMode: serviceMode,
        runtimeBundleRecoveryRequired: held, state,
        holdDesktopSettingsForCheckpoint: async () => calls.push('settings-held'),
        performConfirmedQuit: () => {},
        createBrowserWindow: () => {
          assert.equal(serviceMode, false, 'Background recovery must not create a window');
          calls.push('window'); return window;
        },
        startDesktopRuntime: async () => calls.push('foreground-recovery'),
        acquireRuntimeOwner: async mode => calls.push(`owner:${mode}`),
        spawnLocalServer: async () => calls.push('server'),
        prepareBotRuntimeInBackground: () => calls.push('background-preparation'),
        shutdownOwnedRuntimeService: async () => {},
      });
      assert.deepEqual(signals, ['SIGTERM', 'SIGINT']);
      assert.deepEqual(calls, serviceMode
        ? [...(held ? ['settings-held'] : []), 'accessory', 'owner:service', 'server', 'background-preparation']
        : ['settings-held', 'window', 'foreground-recovery']);
      assert.equal(state.mainWindow, serviceMode ? undefined : window);
    }
  });

  test('headless service processes stay out of the macOS Dock; the foreground app does not', () => {
    const lockIndex = mainSource.indexOf('app.requestSingleInstanceLock()');
    const preReady = mainSource.slice(0, lockIndex);
    assert.match(preReady, /if \(isRuntimeServiceMode \|\| isRuntimeServiceControlProbe\) \{\s+hideHeadlessProcessFromDock\(\);/);
    assert.match(preReady, /app\.dock\?\.hide\(\)/);

    const readyStart = mainSource.indexOf('app.whenReady().then(async () => {');
    const serviceBranch = mainSource.slice(
      mainSource.indexOf('if (isRuntimeServiceMode) {', readyStart),
      mainSource.indexOf('nativeTheme.themeSource = readThemeSource();'),
    );
    const policy = serviceBranch.indexOf("app.setActivationPolicy('accessory')");
    assert.notEqual(policy, -1);
    assert.ok(policy < serviceBranch.indexOf("acquireRuntimeOwner('service')"));

    const foregroundPath = mainSource.slice(mainSource.indexOf('nativeTheme.themeSource = readThemeSource();'));
    assert.doesNotMatch(foregroundPath, /setActivationPolicy\(|dock\?\.hide\(|dock\.hide\(/);
    assert.equal(mainSource.match(/app\.dock\?\.hide\(\)/g)?.length, 1);
    assert.equal(mainSource.match(/setActivationPolicy\(/g)?.length, 1);
  });

  test('ordinary desktop activation precedes non-blocking Docker preparation', () => {
    const startup = mainSource.slice(
      mainSource.indexOf('const startDesktopRuntime = () => {'),
      mainSource.indexOf("app.on('before-quit'"),
    );
    const activation = startup.indexOf('await activateMainWindow(initialUrl, localOrigin, bootOutcome);');
    const openCodeResume = startup.indexOf('state.serverHandle?.resumeDeferredOpenCodeStartup?.()');
    const preparation = startup.indexOf('prepareBotRuntimeInBackground()');

    assert.notEqual(activation, -1);
    assert.notEqual(openCodeResume, -1);
    assert.notEqual(preparation, -1);
    assert.ok(activation < openCodeResume, 'the renderer must activate before OpenCode startup resumes');
    assert.ok(openCodeResume < preparation, 'Bot preparation must wait for deferred OpenCode startup');
    assert.ok(activation < preparation, 'the renderer must activate before Docker preparation begins');
    assert.doesNotMatch(startup, /await requirePreparedBotRuntime\(\);[\s\S]*activateMainWindow\(initialUrl/);
  });

  test('uses the automatic preflight result directly and leaves startup cache clearing manual', () => {
    const readyBranch = mainSource.slice(
      mainSource.indexOf('app.whenReady().then(async () => {'),
    );
    assert.match(mainSource, /const automaticRuntime = await autoEnableBackgroundRuntimeOnFirstLaunch\(\)/);
    assert.match(mainSource, /if \(automaticRuntime\.mode === 'service'\)/);
    assert.doesNotMatch(readyBranch, /await clearElectronRuntimeCaches\(/);
    assert.match(mainSource, /deferOpenCodeStartup: true/);
  });

  test('packages the in-process service bridge and LaunchAgent template for unsigned releases', () => {
    assert.match(packageManifest.scripts['build:native-helpers'], /build:runtime-service-control/);
    assert.match(packageManifest.scripts['prepare:native'], /build:native-helpers/);
    assert.match(packageManifest.scripts.package, /prepare && bun run package:prepared/);
    assert.match(packageManifest.scripts['package:prepared'], /package-prepared/);
    assert.match(releaseWorkflow, /bun run build:native-helpers/);
    assert.match(
      releaseWorkflow,
      /node scripts\/package-prepared\.mjs --mac --\$\{\{ matrix\.arch \}\}/,
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
    assert.ok(packageManifest.build.extraResources.some((resource) => (
      resource.from === 'resources/native' && resource.to === 'native'
    )));
    assert.ok(packageManifest.build.extraFiles.some((resource) => (
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

test('service publication distinguishes held recovery from ordinary deferred startup', async () => {
  const start = mainSource.indexOf('  state.serverHandle = handle;');
  assert.notEqual(start, -1);
  const end = mainSource.indexOf('\n  // Managed startup', start);
  assert.ok(end > start);
  const publish = new AsyncFunction('isRuntimeServiceMode', 'state', 'handle', 'port', 'url', 'log',
    'holdDesktopSettingsForCheckpoint', 'session', mainSource.slice(start, end));
  for (const bundleStatus of [{ reconciliationRequired: false }, { reconciliationRequired: true },
    { state: 'held', reconciliationRequired: false }]) {
    const held = bundleStatus.state === 'held' || bundleStatus.reconciliationRequired;
    const publications = [], logs = [], ordering = [];
    let inspections = 0;
    await publish(true, { runtimeServiceCoordinator: { start: async value => {
      ordering.push('published'); publications.push(value);
    } } }, {
      isReady: () => false, // Ordinary startup defers native readiness too.
      runtimeBundle: { inspect: async () => { inspections++; ordering.push('inspected'); return bundleStatus; } },
      issueLocalOwnerSession: () => assert.fail('Service startup must not mint an owner cookie'),
      issueBotOwnerSession: () => assert.fail('Service startup must not mint a Bot cookie'),
    }, 41234, 'http://127.0.0.1:41234', { info: (...args) => logs.push(args) },
    async () => ordering.push('settings-held'), {});
    assert.equal(inspections, 1);
    assert.deepEqual(ordering, held ? ['inspected', 'settings-held', 'published'] : ['inspected', 'published']);
    assert.deepEqual(publications, [{ port: 41234, health: held ? 'degraded' : 'healthy' }]);
    assert.match(logs[0][0], held ? /recovery-only.*listening/ : /background runtime is listening/);
    assert.doesNotMatch(logs[0][0], /is healthy/);
  }
  const foreground = { runtimeServiceCoordinator: { start: () => assert.fail('Foreground recovery must not publish a service') } };
  let settingsHeld = false;
  const recoveryUrl = 'http://127.0.0.1:41234';
  assert.equal(await publish(false, foreground, {
    runtimeBundle: { inspect: async () => ({ state: 'held' }) },
    issueLocalOwnerSession: () => assert.fail('Held recovery must not mint an owner cookie'),
    issueBotOwnerSession: () => assert.fail('Held recovery must not mint a Bot cookie'),
  }, 41234, recoveryUrl, { info: () => assert.fail('Foreground recovery must not log service publication') },
  async () => { settingsHeld = true; }, {}), recoveryUrl);
  assert.equal(settingsHeld, true);
  assert.equal(foreground.runtimeServiceOwnsServer, false);
  let published = false;
  await assert.rejects(publish(true, { runtimeServiceCoordinator: { start: async () => { published = true; } } }, {
    runtimeBundle: { inspect: async () => { throw Error('bundle_binding_invalid'); } },
  }, 41234, 'http://127.0.0.1:41234', { info: () => {} }, () => assert.fail('Invalid inspection must not hold settings'), {}), /bundle_binding_invalid/);
  assert.equal(published, false);
  await assert.rejects(publish(true, { runtimeServiceCoordinator: { start: async () => { published = true; } } }, {
    runtimeBundle: { inspect: async () => ({ state: 'held' }) },
  }, 41234, 'http://127.0.0.1:41234', { info: () => {} }, async () => { throw Error('settings_hold_failed'); }, {}), /settings_hold_failed/);
  assert.equal(published, false, 'A failed settings hold must not publish the service');
});

test('background checkpoint refuses without a foreground drain ACK; app-bound checkpoint awaits settings', async () => {
  const start = mainSource.indexOf('    onRuntimeBundleCheckpoint: async () => {');
  const end = mainSource.indexOf('\n    onRestartHost:', start);
  assert.notEqual(start, -1);
  const factory = new Function('isRuntimeServiceMode', 'holdDesktopSettingsForCheckpoint',
    `return ({${mainSource.slice(start, end)}}).onRuntimeBundleCheckpoint;`);
  let calls = 0;
  // There is deliberately no lease argument: expired or absent leases cannot
  // establish that another process's settings writer has drained.
  await assert.rejects(factory(true, async () => { calls++; })(), { code: 'bundle_service_requires_app_bound', status: 503 });
  assert.equal(calls, 0);
  const release = Promise.withResolvers();
  const checkpoint = factory(false, () => { calls++; return release.promise; });
  let settled = false;
  const draining = checkpoint().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(settled, false);
  release.resolve();
  await draining;
  assert.equal(settled, true);
});
