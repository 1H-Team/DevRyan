import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDesktopSettings } from '../desktop-settings.mjs';
import { createNativeNotifications } from '../native-notifications.mjs';
import { createDesktopMenu } from '../desktop-menu.mjs';

test('settings serialize mutations, recover after failure and read the current data directory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devryan-settings-'));
  const environment = { env: { DEVRYAN_DATA_DIR: root }, pid: process.pid };
  try {
    const settings = createDesktopSettings({ fs, fsp, os, process: environment, log: {}, getMainWindow: () => null, LOCAL_HOST_ID: 'local' });
    await Promise.all([
      settings.mutateSettingsRoot(async (value) => { await Promise.resolve(); value.first = 1; }),
      settings.mutateSettingsRoot((value) => { value.second = 2; }),
    ]);
    assert.deepEqual(settings.readSettingsRoot(), { first: 1, second: 2 });
    await assert.rejects(settings.mutateSettingsRoot(() => { throw new Error('mutator'); }), /mutator/);
    await settings.writeDesktopHostsConfig({ hosts: [{ id: 'remote', url: 'https://host.test/#old' }, { id: 'local', url: 'https://ignored.test' }], initialHostChoiceCompleted: true });
    assert.equal(settings.readDesktopHostsConfig().hosts[0].url, 'https://host.test/');
    assert.equal(settings.readDesktopHostsConfig().hosts.length, 1);
    assert.equal(settings.readSettingsRoot().first, 1);
    environment.env.DEVRYAN_DATA_DIR = path.join(root, 'other');
    assert.deepEqual(settings.readSettingsRoot(), {});
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('a failed settings write leaves no temporary file behind', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devryan-settings-'));
  const environment = { env: { DEVRYAN_DATA_DIR: root }, pid: process.pid };
  const failingFsp = { ...fsp, rename: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  try {
    const settings = createDesktopSettings({ fs, fsp: failingFsp, os, process: environment, log: {}, getMainWindow: () => null, LOCAL_HOST_ID: 'local' });
    await assert.rejects(settings.mutateSettingsRoot((value) => { value.first = 1; }), /disk full/);
    const leftovers = (await fsp.readdir(root)).filter((name) => name.startsWith('settings.json.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('notifications use live focus and main window state when clicked', () => {
  const events = [];
  let focused = true;
  const window = { isDestroyed: () => false, isFocused: () => focused, isVisible: () => true,
    isMinimized: () => true, restore: () => events.push('restore'), show: () => events.push('show'), focus: () => events.push('focus') };
  let notification;
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notification = this; }
    show() { events.push('notification'); }
  }
  const runtime = createNativeNotifications({ Notification, BrowserWindow: { getAllWindows: () => [window] },
    app: { focus: () => events.push('app-focus') }, platform: 'darwin', getMainWindow: () => window,
    emitToAllWindows: (name, payload) => events.push([name, payload]) });
  runtime.maybeShowNativeNotification({ requireHidden: true });
  assert.equal(notification, undefined);
  focused = false;
  runtime.maybeShowNativeNotification({ payload: { requireHidden: true, sessionId: 'session' } });
  notification.emit('click');
  assert.deepEqual(events, ['notification', 'app-focus', 'restore', 'show', 'focus', ['devryan:open-session', { sessionId: 'session' }]]);
});

test('menu dispatch follows the current focused window and preserves native shortcuts', () => {
  const calls = [];
  const appWindow = (label, id) => ({
    __ocLabel: label,
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      executeJavaScript: async (script) => { calls.push(['dom', label, script]); },
      copy: () => calls.push(['copy', label]),
    },
  });
  const first = appWindow('main', 1);
  const second = appWindow('main-2', 2);
  let focused = first;
  const menu = createDesktopMenu({ BrowserWindow: { getFocusedWindow: () => focused, getAllWindows: () => [first, second] },
    Menu: { buildFromTemplate: (template) => template }, app: { name: 'DevRyan' }, shell: {}, log: {},
    getMainWindow: () => first, getFocusedWebContents: () => focused.webContents,
    emitToWindow: (window, event, action) => calls.push([window, event, action]), emitToAllWindows: () => {} });
  const template = menu.buildMacMenu();
  const copy = template.find((item) => item.label === 'Edit').submenu.find((item) => item.label === 'Copy');
  const settings = template.find((item) => item.label === 'DevRyan').submenu.find((item) => item.label === 'Settings');
  assert.equal(copy.accelerator, 'Cmd+C');
  focused = second;
  settings.click();
  assert.deepEqual(calls[0], [second, 'devryan:menu-action', 'settings']);
  assert.deepEqual(calls[1].slice(0, 2), ['dom', 'main-2']);
  // Copy follows the focused document: native copy there, then the app action
  // once through the DOM, never through emitToWindow.
  copy.click();
  assert.deepEqual(calls[2], ['copy', 'main-2']);
  assert.deepEqual(calls[3].slice(0, 2), ['dom', 'main-2']);
  assert.match(calls[3][2], /"devryan:menu-action", \{ detail: "copy" \}/);
  assert.equal(calls.length, 4);
});
