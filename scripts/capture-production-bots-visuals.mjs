#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  ElectronCdpConnection,
  evaluate,
  reserveLoopbackPort,
  wait,
  waitForEvaluation,
} from '../packages/electron/scripts/electron-cdp-smoke.mjs';
import {
  PRODUCTION_BOTS_VISUAL_MATRIX,
  productionBotsVisualUrl,
} from '../tests/visual-production-bots/matrix.mjs';
import { resolvePackagedVisualShellBinary } from './package-production-bots-visual-shell.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const electronDirectory = path.join(repositoryRoot, 'packages/electron');
const requireElectron = createRequire(path.join(electronDirectory, 'package.json'));
const defaultOutputDirectory = () => path.join(
  repositoryRoot,
  '.cache/e2e/production-bots-visual',
  new Date().toISOString().replace(/[:.]/g, '-'),
);

export const parseProductionBotsVisualArguments = (argv, defaults = {}) => {
  const options = {
    outputDirectory: defaults.outputDirectory || defaultOutputDirectory(),
    baseUrl: defaults.baseUrl || null,
    caseIds: [],
    timeoutMs: 45_000,
    electronBinary: defaults.electronBinary || null,
    electronMode: defaults.electronMode || 'raw',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --flag value, received ${flag || '(empty)'}`);
    }
    index += 1;
    if (flag === '--output') options.outputDirectory = path.resolve(repositoryRoot, value);
    else if (flag === '--base-url') options.baseUrl = new URL(value).href;
    else if (flag === '--case') options.caseIds.push(...value.split(',').filter(Boolean));
    else if (flag === '--timeout-ms') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1_000) throw new Error('--timeout-ms must be at least 1000');
      options.timeoutMs = parsed;
    } else if (flag === '--electron-binary') options.electronBinary = path.resolve(value);
    else if (flag === '--electron-mode') {
      if (value !== 'raw' && value !== 'packaged') throw new Error('--electron-mode must be raw or packaged');
      options.electronMode = value;
    }
    else throw new Error(`Unknown visual capture flag: ${flag}`);
  }
  return options;
};

const stopChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    wait(5_000).then(() => false),
  ]);
  if (stopped) return;
  child.kill('SIGKILL');
};

const waitForUrl = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Visual fixture did not become ready at ${url}`);
};

const discoverVisualPage = async (debugPort, expectedBaseUrl, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => (
          target.type === 'page'
          && typeof target.url === 'string'
          && target.url.startsWith(expectedBaseUrl)
          && target.title === 'DevRyan Production Bots Visual Fixture'
          && typeof target.webSocketDebuggerUrl === 'string'
        ));
        if (page) return page;
      }
    } catch {}
    await wait(100);
  }
  throw new Error('Electron visual fixture page did not appear');
};

const waitForCdpEvent = (cdp, method, timeoutMs) => new Promise((resolve, reject) => {
  let unsubscribe = () => undefined;
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`Timed out waiting for CDP ${method}`));
  }, timeoutMs);
  unsubscribe = cdp.on(method, (params) => {
    clearTimeout(timer);
    unsubscribe();
    resolve(params);
  });
});

const startFixture = async (timeoutMs) => {
  const builtIndex = path.join(repositoryRoot, 'tests/visual-production-bots/dist/index.html');
  try {
    await access(builtIndex);
  } catch {
    throw new Error('Built visual fixture is missing; run `bun run visual:bots:build` first');
  }
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const child = spawn('bunx', [
    'vite',
    'preview',
    '--config',
    'tests/visual-production-bots/vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure = '';
  child.stderr.on('data', (chunk) => { failure = `${failure}${chunk}`.slice(-16_384); });
  try {
    await waitForUrl(baseUrl, timeoutMs);
    return { baseUrl, child };
  } catch (error) {
    await stopChild(child);
    throw new Error(`${error.message}${failure ? `\n${failure}` : ''}`);
  }
};

const resolveElectronBinary = async (override, mode) => {
  if (!override && mode === 'packaged') return resolvePackagedVisualShellBinary();
  const binary = override || requireElectron('electron');
  if (typeof binary !== 'string') throw new Error('Electron binary path is invalid');
  await access(binary);
  return binary;
};

const dispatchKey = async (cdp, key, code = key) => {
  const virtualKeyCode = key === 'Tab' ? 9 : key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0;
  const base = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (key === 'Enter') {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'char',
      ...base,
      text: '\r',
      unmodifiedText: '\r',
    });
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};

const clickCenter = async (cdp, selectorExpression) => {
  const point = await evaluate(cdp, `(() => {
    const element = ${selectorExpression};
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error('Interactive visual fixture control is unavailable');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
};

const resetFixtureDocumentScroll = async (cdp) => {
  await evaluate(cdp, `(() => {
    const previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    for (const container of document.querySelectorAll('#root, .fixture-shell, .fixture-grid, .fixture-content')) {
      container.scrollTop = 0;
      container.scrollLeft = 0;
    }
    document.documentElement.style.scrollBehavior = previous;
  })()`);
};

const alignFixtureFocusScope = async (cdp) => {
  await evaluate(cdp, `(() => {
    const target = document.querySelector('[data-visual-focus-scope="true"]');
    const container = target?.closest('[data-network-policy-window]');
    if (!(target instanceof HTMLElement) || !(container instanceof HTMLElement)) return false;
    const targetRect = target.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    container.scrollTop += targetRect.top - containerRect.top - 8;
    return true;
  })()`);
};

const layoutAssertionsExpression = `(() => {
  const root = document.documentElement;
  const body = document.body;
  const errors = Array.isArray(window.__DEVRYAN_VISUAL_FIXTURE_ERRORS__)
    ? window.__DEVRYAN_VISUAL_FIXTURE_ERRORS__
    : ['missing_error_collector'];
  const secretPattern = /(Bearer\\s+[A-Za-z0-9._~-]{8,}|sk-[A-Za-z0-9]{8,}|BEGIN PRIVATE KEY|rawArguments|credentialValue|hiddenTarget|devryan-secret-fixture)/i;
  const text = body.innerText || '';
  const values = Array.from(document.querySelectorAll('input,textarea'))
    .map((element) => element.value || '')
    .join(' ');
  const overflow = [];
  if (root.scrollWidth > root.clientWidth + 1) overflow.push('document');
  if (body.scrollWidth > body.clientWidth + 1) overflow.push('body');
  for (const region of document.querySelectorAll('.fixture-content, [role="dialog"]')) {
    if (region.scrollWidth > region.clientWidth + 1) overflow.push('content_region');
  }
  for (const rail of document.querySelectorAll('[data-bot-operations-rail]')) {
    if (rail.scrollWidth > rail.clientWidth + 1) overflow.push('operations_rail');
  }
  const unnamedDialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((dialog) => {
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const label = dialog.getAttribute('aria-label');
    return !label && !(labelledBy && document.getElementById(labelledBy));
  }).length;
  const focused = document.querySelector('[aria-current="true"][data-bot-action-id], [aria-current="true"][data-bot-approval-action-id]');
  const expectedFocusScope = new URLSearchParams(location.search).get('scene') === 'network';
  const focusScope = document.querySelector('[data-visual-focus-scope="true"]');
  const focusScopeContainer = focusScope?.closest('[data-network-policy-window]');
  let focusScopeInView = !expectedFocusScope;
  if (focusScope instanceof HTMLElement && focusScopeContainer instanceof HTMLElement) {
    const scopeRect = focusScope.getBoundingClientRect();
    const containerRect = focusScopeContainer.getBoundingClientRect();
    focusScopeInView = scopeRect.top >= containerRect.top - 1
      && scopeRect.top < Math.min(containerRect.bottom, window.innerHeight);
  }
  const headerTop = document.querySelector('header')?.getBoundingClientRect().top ?? 0;
  let focusedInView = true;
  if (focused) {
    const rect = focused.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    focusedInView = rect.top >= 0 && rect.bottom <= viewportHeight;
  }
  return {
    ok: errors.length === 0 && overflow.length === 0 && !secretPattern.test(text) && !secretPattern.test(values) && unnamedDialogs === 0 && focusedInView && focusScopeInView && Math.abs(headerTop) <= 1,
    errors,
    overflow,
    secretSentinelFound: secretPattern.test(text) || secretPattern.test(values),
    unnamedDialogs,
    focusedInView,
    focusScopeInView,
    headerTop,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

const assertKeyboardFocus = async (cdp) => {
  const before = await evaluate(cdp, `(() => ({
    active: document.activeElement instanceof HTMLElement
      ? { tag: document.activeElement.tagName.toLowerCase(), id: document.activeElement.id, data: { ...document.activeElement.dataset } }
      : null,
    scroll: { x: window.scrollX, y: window.scrollY },
    bodyRect: (() => { const rect = document.body.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(),
    tabbables: Array.from((document.querySelector('[data-visual-focus-scope="true"]') || document)
      .querySelectorAll('button,a[href],input,select,textarea,[tabindex]'))
      .filter((element) => element instanceof HTMLElement && !element.hasAttribute('disabled') && element.tabIndex >= 0)
      .slice(0, 12)
      .map((element) => ({ tag: element.tagName.toLowerCase(), name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40) || '', tabIndex: element.tabIndex })),
  }))()`);
  const originReady = await evaluate(cdp, `(() => {
    const scope = document.querySelector('[data-visual-focus-scope="true"]') || document;
    const candidates = Array.from(scope.querySelectorAll('button,a[href],input,select,textarea,[tabindex]'));
    const origin = candidates.find((element) => {
      if (!(element instanceof HTMLElement) || element.hasAttribute('disabled') || element.tabIndex < 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth;
    });
    if (!(origin instanceof HTMLElement)) return false;
    origin.dataset.visualFocusOrigin = 'true';
    origin.focus({ preventScroll: true });
    return document.activeElement === origin;
  })()`);
  if (!originReady) throw new Error(`No visible keyboard focus origin: ${JSON.stringify(before)}`);
  await dispatchKey(cdp, 'Tab', 'Tab');
  const result = await evaluate(cdp, `(() => {
    const element = document.activeElement;
    const origin = document.querySelector('[data-visual-focus-origin="true"]');
    const moved = element !== origin;
    origin?.removeAttribute('data-visual-focus-origin');
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80) || '',
      visible: rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth,
      focusVisible: element.matches(':focus-visible'),
      moved,
    };
  })()`);
  if (!result?.visible || !result.focusVisible || !result.moved) {
    throw new Error(`Keyboard Tab did not produce a visible focus target: ${JSON.stringify({ result, before })}`);
  }
  const restoreScroll = `(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(${before.scroll.x}, ${before.scroll.y});
    for (const container of document.querySelectorAll('#root, .fixture-shell, .fixture-grid, .fixture-content')) {
      container.scrollTop = 0;
      container.scrollLeft = 0;
    }
    document.documentElement.style.scrollBehavior = previous;
  })()`;
  await evaluate(cdp, restoreScroll);
  await wait(50);
  await evaluate(cdp, restoreScroll);
  const restored = await evaluate(cdp, `(() => {
    const header = document.querySelector('header')?.getBoundingClientRect();
    return {
      windowY: window.scrollY,
      documentY: document.documentElement.scrollTop,
      bodyY: document.body.scrollTop,
      visualPageTop: window.visualViewport?.pageTop ?? null,
      headerTop: header?.top ?? null,
    };
  })()`);
  return { ...result, initialScroll: before.scroll, restored };
};

const prepareLegacyDialog = async (cdp, timeoutMs) => {
  const enableSelector = `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Enable Background Bots')`;
  await clickCenter(cdp, enableSelector);
  await waitForEvaluation(cdp, `document.querySelector('[role="dialog"]') !== null`, {
    timeoutMs,
    label: 'legacy LaunchAgent consent dialog',
  });
};

const verifyLegacyDialogKeyboard = async (cdp, timeoutMs) => {
  await dispatchKey(cdp, 'Escape', 'Escape');
  await waitForEvaluation(cdp, `document.querySelector('[role="dialog"]') === null`, {
    timeoutMs,
    label: 'legacy consent dialog to close with Escape',
  });
  await wait(200);
  await prepareLegacyDialog(cdp, timeoutMs);
  await wait(250);
  for (let index = 0; index < 8; index += 1) {
    const active = await evaluate(cdp, `document.activeElement?.textContent?.trim() || ''`);
    if (active === 'Enable') break;
    await dispatchKey(cdp, 'Tab', 'Tab');
  }
  const active = await evaluate(cdp, `document.activeElement?.textContent?.trim() || ''`);
  if (active !== 'Enable') throw new Error('Legacy consent dialog did not expose Enable in the Tab order');
  await dispatchKey(cdp, 'Enter', 'Enter');
  await waitForEvaluation(cdp, `document.querySelector('[role="dialog"]') === null`, {
    timeoutMs,
    label: 'legacy consent dialog to submit with Enter',
  });
};

const verifyTranscriptOmitsActivity = async (cdp) => {
  const result = await evaluate(cdp, `(() => {
    const response = document.querySelector('[data-bot-message-role="assistant"]');
    const responseButtons = response
      ? Array.from(response.querySelectorAll('button')).map((button) => button.textContent?.trim())
      : [];
    return {
      hasResponse: response !== null,
      hasMarker: response?.querySelector('[data-bot-transcript-action-id]') !== null,
      hasActivityLink: responseButtons.includes('View Activity'),
      hasReviewControl: responseButtons.includes('Review'),
      hasApprovalInRail: document.querySelector('[data-bot-approval-action-id]') !== null,
    };
  })()`);
  if (
    !result?.hasResponse
    || result.hasMarker
    || result.hasActivityLink
    || result.hasReviewControl
    || !result.hasApprovalInRail
  ) {
    throw new Error(`Bot response activity isolation failed: ${JSON.stringify(result)}`);
  }
};

const capturePng = async (cdp, targetPath) => {
  const viewport = await evaluate(cdp, `({ width: window.innerWidth, height: window.innerHeight })`);
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
  }, 60_000);
  if (typeof result.data !== 'string') throw new Error('CDP did not return PNG data');
  await writeFile(targetPath, Buffer.from(result.data, 'base64'));
};

export const runProductionBotsVisualCapture = async (options) => {
  const selected = options.caseIds.length === 0
    ? PRODUCTION_BOTS_VISUAL_MATRIX
    : PRODUCTION_BOTS_VISUAL_MATRIX.filter((entry) => options.caseIds.includes(entry.id));
  const missing = options.caseIds.filter((id) => !selected.some((entry) => entry.id === id));
  if (missing.length > 0) throw new Error(`Unknown visual case: ${missing.join(', ')}`);
  await mkdir(options.outputDirectory, { recursive: true });
  await rm(path.join(options.outputDirectory, 'failure.png'), { force: true });

  const fixture = options.baseUrl ? { baseUrl: options.baseUrl, child: null } : await startFixture(options.timeoutMs);
  process.stdout.write(`[production-bots-visual] fixture ${fixture.baseUrl}\n`);
  const electronBinary = await resolveElectronBinary(options.electronBinary, options.electronMode);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'devryan-production-bots-visual-'));
  const debugPort = await reserveLoopbackPort();
  const shell = path.join(repositoryRoot, 'tests/visual-production-bots');
  const launchArguments = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(temporaryRoot, 'electron-user-data')}`,
    '--force-device-scale-factor=1',
  ];
  if (options.electronMode === 'raw') launchArguments.push(shell);
  const child = spawn(electronBinary, launchArguments, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DEVRYAN_VISUAL_FIXTURE_URL: productionBotsVisualUrl(fixture.baseUrl, selected[0]),
      DEVRYAN_VISUAL_DEBUG_PORT: String(debugPort),
      DEVRYAN_VISUAL_HEADLESS: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-128 * 1024); });
  child.stderr.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-128 * 1024); });

  let cdp = null;
  const evidence = [];
  try {
    process.stdout.write(`[production-bots-visual] electron ${debugPort}\n`);
    const target = await discoverVisualPage(debugPort, fixture.baseUrl, options.timeoutMs);
    process.stdout.write(`[production-bots-visual] target ${target.id}\n`);
    cdp = await ElectronCdpConnection.connect(target.webSocketDebuggerUrl);
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Log.enable'),
    ]);
    let rendererErrors = [];
    cdp.on('Runtime.exceptionThrown', (event) => {
      rendererErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'renderer_exception');
    });
    cdp.on('Log.entryAdded', (event) => {
      if (event.entry?.level === 'error') {
        rendererErrors.push(`${event.entry.text || 'console_error'}${event.entry.url ? ` @ ${event.entry.url}` : ''}`);
      }
    });

    for (const entry of selected) {
      process.stdout.write(`[production-bots-visual] checking ${entry.id}\n`);
      rendererErrors = [];
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: entry.viewport.width,
        height: entry.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      process.stdout.write(`[production-bots-visual] metrics ${entry.id}\n`);
      const caseUrl = productionBotsVisualUrl(fixture.baseUrl, entry);
      const currentUrl = await evaluate(cdp, 'location.href');
      process.stdout.write(`[production-bots-visual] url ${currentUrl}\n`);
      if (currentUrl !== caseUrl) {
        const loaded = waitForCdpEvent(cdp, 'Page.loadEventFired', options.timeoutMs);
        await cdp.send('Page.navigate', { url: caseUrl });
        await loaded;
        process.stdout.write(`[production-bots-visual] navigated ${entry.id}\n`);
      }
      await waitForEvaluation(cdp, `document.documentElement.dataset.fixtureReady === 'true'`, {
        timeoutMs: options.timeoutMs,
        label: `${entry.id} fixture readiness`,
      });
      process.stdout.write(`[production-bots-visual] ready ${entry.id}\n`);
      await wait(100);
      await alignFixtureFocusScope(cdp);
      const focus = await assertKeyboardFocus(cdp);
      if (entry.interaction === 'legacy_dialog') {
        await prepareLegacyDialog(cdp, options.timeoutMs);
        await wait(250);
      }
      if (entry.interaction === 'activity_hidden') {
        await verifyTranscriptOmitsActivity(cdp);
      }
      await resetFixtureDocumentScroll(cdp);
      await alignFixtureFocusScope(cdp);
      await wait(25);
      await resetFixtureDocumentScroll(cdp);
      await alignFixtureFocusScope(cdp);
      const assertions = await evaluate(cdp, layoutAssertionsExpression);
      if (!assertions?.ok || rendererErrors.length > 0) {
        throw new Error(`${entry.id} failed visual assertions: ${JSON.stringify({ assertions, rendererErrors })}`);
      }
      const screenshot = `${entry.id}.png`;
      await capturePng(cdp, path.join(options.outputDirectory, screenshot));
      if (entry.interaction === 'legacy_dialog') {
        await verifyLegacyDialogKeyboard(cdp, options.timeoutMs);
      }
      evidence.push({
        id: entry.id,
        scene: entry.scene,
        state: entry.state,
        theme: entry.theme,
        role: entry.role,
        rail: entry.rail,
        drawer: entry.drawer,
        viewport: entry.viewport,
        screenshot,
        assertions,
        keyboardFocus: focus,
        rendererErrorCount: rendererErrors.length,
      });
      process.stdout.write(`[production-bots-visual] PASS ${entry.id}\n`);
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      result: 'pass',
      browser: options.electronMode === 'packaged'
        ? 'Packaged Electron CDP isolated visual shell'
        : 'Electron CDP isolated visual shell',
      electronMode: options.electronMode,
      crossMachinePixelBaseline: false,
      reviewStatus: 'pending_human_or_agent_review',
      cases: evidence,
    };
    await writeFile(path.join(options.outputDirectory, 'evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    if (cdp) {
      await capturePng(cdp, path.join(options.outputDirectory, 'failure.png')).catch(() => undefined);
    }
    throw error;
  } finally {
    cdp?.close();
    await stopChild(child);
    await stopChild(fixture.child);
    await writeFile(path.join(options.outputDirectory, 'electron.log'), logs);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const options = parseProductionBotsVisualArguments(process.argv.slice(2));
  await runProductionBotsVisualCapture(options);
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error('[production-bots-visual] FAIL', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
