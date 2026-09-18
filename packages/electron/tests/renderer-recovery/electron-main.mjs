import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import { installRendererRecovery } from '../../renderer-recovery.mjs';

const root = process.env.DEVRYAN_RENDERER_RECOVERY_ROOT;
const resultPath = process.env.DEVRYAN_RENDERER_RECOVERY_RESULT;
if (!root || !resultPath) throw new Error('Launch through run.mjs');
app.setName('DevRyan Renderer Recovery Fixture');
for (const [key, directory] of Object.entries({
  userData: 'user-data', sessionData: 'session-data', logs: 'logs', crashDumps: 'crashes',
})) {
  const isolatedPath = path.join(root, directory);
  mkdirSync(isolatedPath, { recursive: true });
  app.setPath(key, isolatedPath);
}
app.commandLine.appendSwitch('use-mock-keychain');
const records = [];
const prompts = [];
const checks = [];
let window;
let dispose;
let notifyPrompt;
const promptArrived = new Promise((resolve) => { notifyPrompt = resolve; });

const run = async () => {
  try {
    await app.whenReady();
    app.dock?.hide();
    const isolatedSession = session.fromPartition('renderer-recovery-fixture', { cache: false });
    assert.equal(isolatedSession.isPersistent(), false);
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: isolatedSession,
        nodeIntegration: false,
        contextIsolation: true,
        // The fixture preload needs process.exit to reproduce the exact incident.
        sandbox: false,
        preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    dispose = installRendererRecovery({
      browserWindow: window, shouldQuit: () => false,
      showMessageBox: (_parent, options) => new Promise((resolve) => {
        prompts.push({ options, resolve }); notifyPrompt();
      }),
      log: { info: (...args) => records.push(args), error: (...args) => records.push(args) },
    });
    const url = `data:text/html,${encodeURIComponent('<!doctype html><title>Recovery fixture</title><h1>DevRyan window restored</h1>')}`;
    await window.loadURL(url);
    const gone = once(contents, 'render-process-gone');
    const restored = once(contents, 'did-finish-load');
    contents.send('fixture-clean-exit');
    const [, details] = await gone;
    assert.equal(details.reason, 'clean-exit');
    await restored;
    assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), 'DevRyan window restored');
    assert.equal(contents.getURL(), url);
    assert.equal(prompts.length, 0);
    checks.push('Actual renderer clean-exit automatically reloads the same document');

    contents.forcefullyCrashRenderer();
    await promptArrived;
    assert.equal(prompts.length, 1);
    assert.equal(records.filter(([, record]) => record.event === 'reload_started').length, 1);
    checks.push('Second real renderer exit is bounded and offers host-owned recovery');
    const manuallyRestored = once(contents, 'did-finish-load');
    prompts[0].resolve({ response: 0 });
    await manuallyRestored;
    assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), 'DevRyan window restored');
    checks.push('Native recovery action restores the crashed window without a runtime restart');
    writeFileSync(resultPath, JSON.stringify({ status: 'passed', electron: process.versions.electron, checks }, null, 2));
    dispose();
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    dispose?.();
    window?.destroy();
    app.exit(1);
  }
};

void run();
