#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createLoopbackOpenCodeFixture } from '../../../scripts/perf/loopback-opencode-fixture.mjs';
import {
  discoverElectronPage,
  ElectronCdpConnection,
  evaluate,
  reserveLoopbackPort,
  waitForEvaluation,
} from './electron-cdp-smoke.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const electronDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(electronDirectory, '../..');
const requireElectronDependency = createRequire(path.join(electronDirectory, 'package.json'));
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const defaultOutputDirectory = () => path.join(
  repositoryRoot,
  '.cache/e2e/bot-catalog-native-pointer',
  new Date().toISOString().replace(/[:.]/g, '-'),
);

const positiveInteger = (value, flag) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
};

export const parseNativePointerSmokeArguments = (argv, {
  homeDirectory = os.homedir(),
  outputDirectory = defaultOutputDirectory(),
} = {}) => {
  const options = {
    outputDirectory,
    supabaseConfig: path.join(homeDirectory, '.config/openchamber/supabase.json'),
    electronBinary: null,
    electronMode: 'raw',
    timeoutMs: 60_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --flag value, received ${flag || '(empty)'}`);
    }
    index += 1;
    if (flag === '--output') options.outputDirectory = path.resolve(repositoryRoot, value);
    else if (flag === '--supabase-config') options.supabaseConfig = path.resolve(value);
    else if (flag === '--electron-binary') options.electronBinary = path.resolve(value);
    else if (flag === '--electron-mode') {
      if (value !== 'raw' && value !== 'packaged') throw new Error('--electron-mode must be raw or packaged');
      options.electronMode = value;
    }
    else if (flag === '--timeout-ms') options.timeoutMs = positiveInteger(value, flag);
    else throw new Error(`Unknown native pointer smoke flag: ${flag}`);
  }
  return options;
};

export const screenPointForCssRect = ({ screenX, screenY, rect }) => {
  const values = [screenX, screenY, rect?.left, rect?.top, rect?.width, rect?.height];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Catalog button did not expose valid screen coordinates');
  }
  return Object.freeze({
    x: screenX + rect.left + (rect.width / 2),
    y: screenY + rect.top + (rect.height / 2),
  });
};

const pathExists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

export const packagedDevRyanBinaryCandidates = ({
  platform = process.platform,
  arch = process.arch,
} = {}) => {
  if (platform === 'darwin') {
    const directories = arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-x64'];
    return directories.map((directory) => path.join(
      electronDirectory,
      'dist',
      directory,
      'DevRyan.app',
      'Contents/MacOS/DevRyan',
    ));
  }
  if (platform === 'win32') return [path.join(electronDirectory, 'dist/win-unpacked/DevRyan.exe')];
  return [
    path.join(electronDirectory, 'dist/linux-unpacked/devryan'),
    path.join(electronDirectory, 'dist/linux-unpacked/DevRyan'),
  ];
};

const resolveElectronBinary = async (override, mode) => {
  let binary = override;
  if (!binary && mode === 'packaged') {
    for (const candidate of packagedDevRyanBinaryCandidates()) {
      if (await pathExists(candidate)) {
        binary = candidate;
        break;
      }
    }
  }
  if (!binary && mode === 'raw') binary = requireElectronDependency('electron');
  if (typeof binary !== 'string' || !(await pathExists(binary))) {
    throw new Error(mode === 'packaged'
      ? 'Packaged DevRyan binary is unavailable; run `bun run electron:build` or pass --electron-binary'
      : 'Electron 41 binary is unavailable; run `bun install` or pass --electron-binary');
  }
  await access(binary, fsConstants.X_OK);
  return binary;
};

const appendBoundedLog = (current, chunk) => {
  const next = `${current}${chunk.toString('utf8')}`;
  return next.length > MAX_LOG_BYTES ? next.slice(-MAX_LOG_BYTES) : next;
};

const waitForChildExit = (child, timeoutMs) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  const onExit = () => {
    clearTimeout(timer);
    resolve(true);
  };
  const timer = setTimeout(() => {
    child.off('exit', onExit);
    resolve(false);
  }, timeoutMs);
  child.once('exit', onExit);
});

const signalProcessTree = (child, signal) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {}
  try {
    child.kill(signal);
  } catch {}
};

const stopProcessTree = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForChildExit(child, 5_000)) return;
  signalProcessTree(child, 'SIGKILL');
  await waitForChildExit(child, 2_000);
};

const rendererOriginExpression = `(() => {
  return location.protocol === 'http:' && location.hostname === '127.0.0.1'
    ? location.origin
    : null;
})()`;

const createButtonExpression = `(() => {
  const button = document.querySelector('button[aria-label="Create Bot"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled || document.visibilityState !== 'visible') return null;
  const rect = button.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    screenX: window.screenX,
    screenY: window.screenY,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    dialogOpen: document.querySelector('[data-bot-create-dialog]') !== null,
  };
})()`;

const createDialogExpression = `(() => {
  const dialog = document.querySelector('[data-bot-create-dialog]');
  if (!(dialog instanceof HTMLElement)) return null;
  const title = Array.from(dialog.querySelectorAll('h1,h2,h3,[role="heading"]'))
    .map((element) => element.textContent?.trim())
    .find(Boolean) || '';
  return { title, visible: dialog.getBoundingClientRect().width > 0 };
})()`;

const authenticatedShellExpression = `(() => {
  const button = document.querySelector('button[aria-label="Settings"]');
  return button instanceof HTMLButtonElement && !button.disabled;
})()`;

const loginAsTestAdministrator = async (cdp) => evaluate(cdp, `(async () => {
  const response = await fetch('/auth/agent-test-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
    body: JSON.stringify({ email: 'admin@1health.ae' }),
  });
  let code = null;
  try { code = (await response.json())?.code || null; } catch {}
  return { ok: response.ok, status: response.status, code };
})()`);

const captureScreenshot = async (cdp, targetPath) => {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (typeof result.data !== 'string') throw new Error('Electron screenshot did not return PNG data');
  await writeFile(targetPath, Buffer.from(result.data, 'base64'));
};

const runNativePointerSmoke = async (options) => {
  if (process.platform !== 'darwin') {
    throw new Error('The native Bot Catalog pointer smoke requires an interactive macOS session');
  }
  const swiftHelper = path.join(scriptDirectory, 'macos-pointer-click.swift');
  const appEntry = path.join(electronDirectory, 'main.mjs');
  const webIndex = path.join(electronDirectory, 'resources/web-dist/index.html');
  if (!(await pathExists(options.supabaseConfig))) {
    throw new Error(`Agent-test Supabase config is unavailable: ${options.supabaseConfig}`);
  }
  if (options.electronMode === 'raw' && !(await pathExists(webIndex))) {
    throw new Error('Current Electron web assets are missing; run `bun run --cwd packages/electron build:web-assets`');
  }
  const electronBinary = await resolveElectronBinary(options.electronBinary, options.electronMode);
  await mkdir(options.outputDirectory, { recursive: true });

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'devryan-bot-pointer-'));
  const dataDirectory = path.join(temporaryRoot, 'data');
  const userDataDirectory = path.join(temporaryRoot, 'electron-user-data');
  const fixtureDirectory = path.join(temporaryRoot, 'workspace');
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(fixtureDirectory, { recursive: true }),
  ]);
  const isolatedSupabaseConfig = path.join(dataDirectory, 'supabase.json');
  await copyFile(options.supabaseConfig, isolatedSupabaseConfig);
  await chmod(isolatedSupabaseConfig, 0o600);
  await writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({
    messageStreamTransport: 'sse',
    desktopWindowState: { width: 1280, height: 800, maximized: false },
  }, null, 2));

  const fixture = await createLoopbackOpenCodeFixture({ directory: fixtureDirectory });
  const debugPort = await reserveLoopbackPort();
  let logs = '';
  const launchArguments = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDirectory}`,
    '--force-device-scale-factor=1',
  ];
  if (options.electronMode === 'raw') launchArguments.push(appEntry);
  const child = spawn(electronBinary, launchArguments, {
    cwd: electronDirectory,
    env: {
      ...process.env,
      ...(options.electronMode === 'raw' ? { OPENCHAMBER_ELECTRON_DEV: '1' } : {}),
      OPENCHAMBER_DATA_DIR: dataDirectory,
      OPENCHAMBER_ELECTRON_USER_DATA_DIR: userDataDirectory,
      OPENCODE_HOST: fixture.origin,
      OPENCODE_SKIP_START: 'true',
      OPENCHAMBER_SKIP_OPENCODE_START: 'true',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => { logs = appendBoundedLog(logs, chunk); });
  child.stderr?.on('data', (chunk) => { logs = appendBoundedLog(logs, chunk); });

  let cdp = null;
  try {
    const target = await discoverElectronPage(debugPort, options.timeoutMs);
    cdp = await ElectronCdpConnection.connect(target.webSocketDebuggerUrl);
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
    const origin = await waitForEvaluation(cdp, rendererOriginExpression, {
      timeoutMs: options.timeoutMs,
      label: 'DevRyan loopback renderer',
    });
    const login = await loginAsTestAdministrator(cdp);
    if (!login?.ok) {
      throw new Error(`Password-free Test Administrator login failed with HTTP ${login?.status || 'unknown'}${login?.code ? ` (${login.code})` : ''}`);
    }
    await cdp.send('Page.navigate', { url: `${origin}/` });
    await waitForEvaluation(cdp, authenticatedShellExpression, {
      timeoutMs: options.timeoutMs,
      label: 'authenticated DevRyan shell',
    });
    await evaluate(cdp, `(() => {
      history.pushState({ settingsPath: 'bots' }, '', '${origin}/?settings=bots');
      window.dispatchEvent(new PopStateEvent('popstate'));
      return location.search;
    })()`);
    const button = await waitForEvaluation(cdp, createButtonExpression, {
      timeoutMs: options.timeoutMs,
      label: 'enabled Catalog Create Bot button',
    });
    if (button.dialogOpen) throw new Error('Create Bot dialog was already open before the pointer click');
    const point = screenPointForCssRect(button);

    await execFileAsync('/usr/bin/xcrun', [
      'swift',
      swiftHelper,
      String(child.pid),
      String(point.x),
      String(point.y),
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });

    const dialog = await waitForEvaluation(cdp, createDialogExpression, {
      timeoutMs: 10_000,
      label: 'Create Bot dialog after native pointer click',
    });
    if (!dialog.visible || dialog.title !== 'Create Bot') {
      throw new Error(`Native click opened an unexpected dialog: ${dialog.title || '(untitled)'}`);
    }

    const screenshotPath = path.join(options.outputDirectory, 'catalog-native-pointer.png');
    await captureScreenshot(cdp, screenshotPath);
    const evidence = {
      schemaVersion: 1,
      result: 'pass',
      createdAt: new Date().toISOString(),
      assertion: 'CoreGraphics mouse click at the enabled Catalog plus opened the Create Bot dialog',
      testAccount: 'admin@1health.ae',
      electronBinary,
      electronMode: options.electronMode,
      buttonRect: button.rect,
      screenPoint: point,
      dialogTitle: dialog.title,
      screenshot: path.basename(screenshotPath),
    };
    await writeFile(
      path.join(options.outputDirectory, 'evidence.json'),
      JSON.stringify(evidence, null, 2),
    );
    process.stdout.write(`[electron-native-pointer] PASS ${screenshotPath}\n`);
    return evidence;
  } catch (error) {
    if (cdp) {
      await captureScreenshot(cdp, path.join(options.outputDirectory, 'failure.png')).catch(() => undefined);
    }
    throw error;
  } finally {
    cdp?.close();
    await stopProcessTree(child);
    await fixture.close();
    await writeFile(path.join(options.outputDirectory, 'electron.log'), logs);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const options = parseNativePointerSmokeArguments(process.argv.slice(2));
  await runNativePointerSmoke(options);
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error('[electron-native-pointer] FAIL', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
