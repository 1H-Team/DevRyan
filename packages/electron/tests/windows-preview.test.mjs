import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureWindowsPreview, isWindowsPreview, createPreviewUpdater, WINDOWS_PREVIEW_VERSION,
  WINDOWS_PREVIEW_NAME, WINDOWS_PREVIEW_APP_ID, isPreviewUnsupportedCommand } from '../windows-preview.mjs';

test('dedicated packaged Windows entry isolates product identity and runtime before main import', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-identity-'));
  try {
    const paths = { appData: root, userData: path.join(root, 'stable') };
    let name = 'DevRyan', modelId;
    const app = { isPackaged: true, getVersion: () => WINDOWS_PREVIEW_VERSION,
      getName: () => name, setName: value => { name = value; }, setAppUserModelId: value => { modelId = value; },
      getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; } };
    const environment = { DEVRYAN_RUNTIME_BUNDLE_ROOT: path.join(root, 'native'), OPENCODE_SERVER_PASSWORD: 'disposable-fixture',
      OPENCHAMBER_ELECTRON_USER_DATA_DIR: path.join(root, 'stable'), OPENCODE_CONFIG: 'inherited.json', OPENCODE_SKIP_START: 'true' };
    const userData = configureWindowsPreview({ app, resourcesPath: path.join(root, 'resources'), environment, arch: 'arm64', platform: 'win32' });
    assert.equal(name, WINDOWS_PREVIEW_NAME);
    assert.equal(modelId, WINDOWS_PREVIEW_APP_ID);
    assert.equal(paths.userData, path.join(root, WINDOWS_PREVIEW_NAME));
    assert.equal(environment.DEVRYAN_RUNTIME_MODE, 'standard-preview');
    assert.equal(environment.DEVRYAN_STANDARD_OPENCODE_BINARY, path.join(root, 'resources/opencode/opencode.exe'));
    assert.equal(environment.OPENCHAMBER_DATA_DIR, path.join(userData, 'data'));
    assert.equal(environment.DEVRYAN_RUNTIME_BUNDLE_ROOT, undefined);
    assert.equal(environment.OPENCODE_SERVER_PASSWORD, undefined);
    assert.equal(environment.OPENCODE_CONFIG, undefined);
    assert.equal(environment.OPENCODE_SKIP_START, undefined);
    assert.equal(isWindowsPreview({ app, environment, platform: 'win32' }), true);
    assert.throws(() => isWindowsPreview({ app: { ...app, getVersion: () => '2.0.2' }, environment, platform: 'win32' }));
    assert.throws(() => configureWindowsPreview({ app, resourcesPath: root, environment, platform: 'darwin', arch: 'arm64' }));
    assert.equal(isWindowsPreview({ app, environment: {}, platform: 'win32' }), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('preview updater never provides a download or native installation owner', async () => {
  const updater = createPreviewUpdater();
  assert.equal(updater.isDownloaded(), false);
  for (const operation of ['check', 'download', 'getDownloaded']) await assert.rejects(updater[operation](), /windows_preview_updates_disabled/);
});

test('preview main keeps origin protections and avoids native bootstrap before web entry', async () => {
  const main = await fs.readFile(new URL('../main.mjs', import.meta.url), 'utf8');
  const entry = await fs.readFile(new URL('../windows-preview-entry.mjs', import.meta.url), 'utf8');
  assert.ok(entry.indexOf('configureWindowsPreview({') < entry.indexOf("await import('./main.mjs')"));
  assert.match(main, /!isPreview && !isRuntimeServiceControlProbe.*await import\('@openchamber\/web\/server\/lib\/opencode\/runtime-host\/runtime-bundle-binding.js'\)/);
  assert.match(main, /if \(!isPreview\) await acquireRuntimeOwner/);
  assert.match(main, /isPreview \? createPreviewUpdater\(\) : createDesktopUpdater/);
  assert.match(main, /!isPreview && !app.isDefaultProtocolClient/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /isPrivilegedRendererUrl/);
  assert.match(main, /isPreviewUnsupportedCommand\(command\)/);
  for (const command of ['desktop_browser_surface_create', 'desktop_agent_browser_install', 'desktop_bot_runtime_setup', 'desktop_runtime_bundle_resume', 'desktop_runtime_service_enable', 'desktop_macos_speech_start', 'desktop_export_bot_recovery', 'desktop_restore_bot_recovery']) assert.equal(isPreviewUnsupportedCommand(command), true);
  assert.equal(isPreviewUnsupportedCommand('desktop_restart'), false);
});
