import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runStartupPhase } from './runtime-service-startup.mjs';
import { startupDiagnosticSummary } from '../shared-runtime/startup-diagnostics.js';

import {
  buildStartupErrorHtml,
  buildStartupSplashHtml,
  resolveStartupSplashPalette,
  withStartupSplashPalette,
} from './startup-splash.mjs';

const mainSource = () => readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

describe('Electron startup splash', () => {
  it('adopts the already visible early splash without committing a second startup document', () => {
    const source = mainSource();
    const start = source.indexOf('  if (url) {\n    void navigateWindow(browserWindow, url);');
    const navigate = new Function('early', 'url', 'state', 'browserWindow', 'navigateWindow', 'buildStartupSplashHtml',
      source.slice(start, source.indexOf('  return browserWindow;', start)));
    for (const early of [{}, null]) {
      const state = {}, calls = [];
      navigate(early, null, state, {}, (_window, url) => calls.push(url), () => '<p>Starting</p>');
      expect(state.startupSplashActive).toBe(true);
      expect(calls.length).toBe(early ? 0 : 1);
    }
    const calls = [];
    navigate({}, 'http://127.0.0.1:3000', {}, {}, (_window, url) => calls.push(url), () => { throw Error('Unused splash'); });
    expect(calls).toEqual(['http://127.0.0.1:3000']);
  });
  it('replaces the splash with the original failure and Retry when selected-bundle settings become unreadable', async () => {
    const source = mainSource();
    const build = source.slice(source.indexOf('const buildStartupErrorHtml ='), source.indexOf('const startupActionForUrl ='));
    const show = source.slice(source.indexOf('const showStartupFailure ='), source.indexOf('let preparingStartupRebootRecovery ='));
    const calls = [];
    const error = Object.assign(new Error('Runtime preparation failed'), { code: 'runtime_bundle_binding_invalid' });
    const showFailure = new Function('owners', `
      const { startupErrorDetails, startupDiagnosticSummary, readSettingsRoot, buildStartupErrorHtmlFromSettings, state, navigateWindow } = owners;
      let lastStartupDiagnostic, startupRecoveryFailure, startupFailurePageUrl;
      const isPreview = false;
      const shellRuntimeBundleBindingError = null;
      const rebootRecoveryPreparable = () => false;
      ${build}
      ${show}
      return showStartupFailure;
    `)({
      startupDiagnosticSummary,
      startupErrorDetails: value => ({ displayMessage: `${value.message} (${value.code})` }),
      readSettingsRoot: () => { throw new Error('Settings binding changed after upgrade'); },
      buildStartupErrorHtmlFromSettings: buildStartupErrorHtml,
      state: { mainWindow: { isDestroyed: () => false, show: () => calls.push('show'), focus: () => calls.push('focus') } },
      navigateWindow: async (_window, url) => {
        const html = decodeURIComponent(url.split(',').slice(1).join(','));
        expect(html).toContain('Runtime preparation failed (runtime_bundle_binding_invalid)');
        expect(html).toContain('devryan://retry-startup');
        expect(html).toContain('devryan://copy-startup-diagnostics');
        expect(html).not.toContain('Settings binding changed');
        calls.push('navigate');
      },
    });
    await expect(showFailure(error)).resolves.toBeUndefined();
    expect(calls).toEqual(['navigate', 'show', 'focus']);
  });
  it('uses one foreground-colored large mark when the saved startup theme is dark', () => {
    const html = buildStartupSplashHtml({ themeMode: 'dark' });

    expect(html).toContain('data-splash-variant="dark"');
    expect(html).toContain('--splash-background: #151313');
    expect(html).toContain('--splash-foreground: #CECDC3');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('width="169" height="169"');
    expect(html).not.toContain('splash-logo-light');
    expect(html).not.toContain('splash-logo-dark');
  });

  it('honors persisted custom light colors without a fixed black logo', () => {
    const html = buildStartupSplashHtml({
      themeMode: 'light',
      splashBgLight: '#fefefe',
      splashFgLight: '#242424',
    });

    expect(html).toContain('data-splash-variant="light"');
    expect(html).toContain('--splash-background: #fefefe');
    expect(html).toContain('--splash-foreground: #242424');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('width="169" height="169"');
  });

  it('keeps system mode responsive to the operating-system color scheme', () => {
    const html = buildStartupSplashHtml({ themeMode: 'system' });

    expect(html).toContain('data-splash-variant="system"');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('--splash-background: #151313');
    expect(html).toContain('--splash-foreground: #CECDC3');
  });

  it('resolves one concrete palette for the native navigation handoff', () => {
    expect(resolveStartupSplashPalette({ themeMode: 'system' }, false)).toEqual({
      variant: 'light',
      background: '#FFFCF0',
      foreground: '#100F0F',
    });
    expect(resolveStartupSplashPalette({
      themeMode: 'system',
      splashBgDark: '#202124',
      splashFgDark: '#f1f3f4',
    }, true)).toEqual({
      variant: 'dark',
      background: '#202124',
      foreground: '#f1f3f4',
    });
  });

  it('passes the palette only to the local startup document', () => {
    const palette = resolveStartupSplashPalette({ themeMode: 'dark' }, true);
    const localUrl = withStartupSplashPalette(
      'http://127.0.0.1:3000/?existing=1#startup',
      'http://127.0.0.1:3000',
      palette,
    );

    expect(localUrl).toContain('existing=1');
    expect(localUrl).toContain('__ocSplashBackground=%23151313');
    expect(localUrl).toContain('__ocSplashForeground=%23CECDC3');
    expect(localUrl).toContain('__ocSplashVariant=dark');
    expect(localUrl).toContain('#startup');
    expect(withStartupSplashPalette('https://remote.example/', 'http://127.0.0.1:3000', palette))
      .toBe('https://remote.example/');
  });

  it('keeps the BrowserWindow and renderer navigation on the same palette', () => {
    const source = mainSource();

    expect(source).toContain('palette: startupSplashPalette');
    expect(readFileSync(new URL('./early-startup.mjs', import.meta.url), 'utf8')).toContain('backgroundColor: palette.background');
    expect(source).toContain('mainWindow.setBackgroundColor(startupSplashPalette.background)');
    expect(source).toContain('withStartupSplashPalette(url, localOrigin, startupSplashPalette)');
    expect(source).toContain('navigateWindow(mainWindow, startupUrl');
  });

  it('renders a matching large-logo retry screen without allowing error text to become markup', () => {
    const html = buildStartupErrorHtml(
      { themeMode: 'dark' },
      { message: 'fetch failed (ENOTFOUND) <script>unsafe()</script>' },
    );

    expect(html).toContain('data-splash-variant="dark"');
    expect(html).toContain('width="169" height="169"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('Startup needs attention');
    expect(html).toContain('role="alert"');
    expect(html).toContain('devryan://retry-startup');
    expect(html).toContain('fetch failed (ENOTFOUND) &lt;script&gt;unsafe()&lt;/script&gt;');
    expect(html).not.toContain('<script>unsafe()</script>');
  });

  it('activates held recovery without resuming native startup or power hooks', async () => {
    const source = mainSource();
    const start = source.indexOf('const startDesktopRuntime =');
    const end = source.indexOf('const updateCacheDirectory =', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const createStartup = new Function('owners', `
      let desktopStartupPromise = null, desktopStartupFailed = false;
      const { runtimeBundleRecoveryRequired, shellRuntimeBundleBindingError, state, prepareForegroundRuntime,
        resolveInitialUrl, activateMainWindow, installPowerResumeHook,
        isLocalStartupTarget, dataRootDirectory,
        startupErrorDetails, log, releaseDesktopKeepAwake, killSidecar, showStartupFailure, runStartupPhase } = owners;
      const desktopDmgInstaller = null;
      const isPreview = false;
      ${source.slice(start, end)}
      return startDesktopRuntime;
    `);
    for (const [held, bindingFailed] of [[false, false], [true, false], [true, true]]) {
      const calls = [];
      let releaseNativeStartup;
      const nativeStartup = new Promise(resolve => { releaseNativeStartup = resolve; });
      const context = { initialUrl: 'http://127.0.0.1:41234', localOrigin: 'http://127.0.0.1:41234',
        bootOutcome: { target: 'local', status: 'ok' } };
      const state = { serverHandle: {
        resumeDeferredOpenCodeStartup: () => { calls.push('resume-native'); return nativeStartup; },
      } };
      const startup = createStartup({
        runStartupPhase,
        runtimeBundleRecoveryRequired: held, state,
        shellRuntimeBundleBindingError: bindingFailed ? Object.assign(new Error('Cannot verify selected runtime'), { code: 'runtime_bundle_binding_invalid' }) : undefined,
        startupErrorDetails: error => ({ code: error.code }),
        log: { error: (_message, details) => calls.push(details.code) },
        releaseDesktopKeepAwake: () => calls.push('release-keep-awake'),
        killSidecar: async () => calls.push('cleanup'),
        showStartupFailure: async error => { expect(error.code).toBe('runtime_bundle_binding_invalid'); calls.push('show-failure'); },
        prepareForegroundRuntime: async () => calls.push('prepare-foreground'),
        resolveInitialUrl: async () => context,
        activateMainWindow: async (...args) => {
          expect(args).toEqual([context.initialUrl, context.localOrigin, context.bootOutcome]);
          calls.push('activate');
        },
        installPowerResumeHook: () => calls.push('power-hook'),
        isLocalStartupTarget: value => value === context,
        dataRootDirectory: () => '/fixture',
      });
      const pending = startup();
      expect(startup()).toBe(pending);
      await pending;
      if (bindingFailed) {
        expect(calls).toEqual(['runtime_bundle_binding_invalid', 'release-keep-awake', 'cleanup', 'show-failure']);
        releaseNativeStartup();
        continue;
      }
      expect(calls).toEqual(held
        ? ['prepare-foreground', 'activate']
        : ['prepare-foreground', 'activate', 'power-hook', 'resume-native']);
      // Nothing else (no Docker or Bot work) is scheduled after acceptance.
      await new Promise(resolve => setImmediate(resolve));
      expect(calls).toEqual(held
        ? ['prepare-foreground', 'activate']
        : ['prepare-foreground', 'activate', 'power-hook', 'resume-native']);
      releaseNativeStartup();
      await nativeStartup;
    }
  });
});


describe('native startup reboot recovery', () => {
  it('offers restart preparation only for the guarded recovery screen and does not offer an ineffective app retry afterward', () => {
    const waiting = buildStartupErrorHtml({}, { message: 'bundle_execution_unsettled', rebootRecovery: true });
    expect(waiting).toContain('devryan://prepare-reboot-recovery');
    expect(waiting).toContain('Your sessions and retained work will be preserved.');
    expect(waiting).toContain('devryan://retry-startup');
    const fenced = buildStartupErrorHtml({}, { message: 'bundle_reboot_required', rebootRequired: true });
    expect(fenced).toContain('Restart your computer to continue');
    expect(fenced).not.toContain('devryan://prepare-reboot-recovery');
    expect(fenced).not.toContain('devryan://retry-startup');
    expect(fenced).toContain('Copy Diagnostics');
  });

  it('native recovery accepts only its own displayed failure and rereads authoritative root and revision', () => {
    const source = mainSource();
    expect(source).toContain("browserWindow === state.mainWindow && browserWindow.webContents.getURL() === startupFailurePageUrl");
    expect(source).toContain("!rebootRecoveryPreparable(startupErrorDetails(startupRecoveryFailure).code)");
    expect(source).toContain("const rebootRecoveryPreparable = (code) => code === 'bundle_execution_unsettled' || code === 'bundle_reboot_recovery_changed';");
    expect(source).toContain('controlRoot: binding.controlRoot, expectedRevision: binding.selection.revision');
    expect(source).not.toContain("shell.openExternal('devryan://prepare-reboot-recovery')");
  });
});

it('native restart preparation rejects unrelated failures and derives authority from the selected binding', async () => {
  const source = mainSource();
  const recovery = source.slice(source.indexOf('let preparingStartupRebootRecovery ='), source.indexOf('const isLocalStartupTarget ='))
    .replace("await import('@devryan/web/server/lib/opencode/runtime-host/native-bundle-reboot-recovery.js')", 'await loadRecovery()');
  const failure = { code: 'native_runtime_artifacts_unverified' };
  const calls = [];
  let finish, refuse;
  const pending = new Promise(resolve => { finish = resolve; });
  const prepare = new Function('owners', `
    const { readNativeShellBundleBinding, loadRecovery, showStartupFailure, startupRecoveryFailure, log } = owners;
    const rebootRecoveryPreparable = code => code === 'bundle_execution_unsettled' || code === 'bundle_reboot_recovery_changed';
    const isPreview = false;
    const process = { platform: 'darwin', env: {} }, os = { homedir: () => '/fixture' }, fs = { existsSync: () => true };
    const readRuntimeBundleBinding = () => {};
    const startupErrorDetails = error => ({ code: error.code });
    ${recovery}
    return prepareStartupRebootRecovery;
  `)({
    startupRecoveryFailure: failure,
    readNativeShellBundleBinding: () => ({ controlRoot: '/fixture/selected', selection: { revision: 7 } }),
    loadRecovery: async () => ({ beginNativeBundleRebootRecovery: async value => { calls.push(value); await pending; if (refuse) throw refuse; } }),
    showStartupFailure: async (error, options) => { calls.push(options?.retainRecovery ? [error.code, 'retained'] : error.code); },
    log: { error: (_message, details) => { calls.push(['logged', details.code]); } },
  });
  await prepare();
  expect(calls).toEqual([]);
  failure.code = 'bundle_execution_unsettled';
  const first = prepare();
  await Promise.resolve();
  await prepare();
  finish();
  await first;
  expect(calls).toEqual([{ controlRoot: '/fixture/selected', expectedRevision: 7 }, 'bundle_reboot_required']);
  // A refused preparation is logged and leaves the launch failure preparable.
  calls.length = 0; refuse = { code: 'bundle_upgrade_owner_active' };
  await prepare();
  expect(calls.slice(1)).toEqual([['logged', 'bundle_upgrade_owner_active'], ['bundle_upgrade_owner_active', 'retained']]);
  failure.code = 'bundle_reboot_recovery_changed'; calls.length = 0; refuse = undefined;
  await prepare();
  expect(calls.at(-1)).toBe('bundle_reboot_required');
});
