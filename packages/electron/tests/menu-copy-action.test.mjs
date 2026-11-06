import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopMenu, isAppDocumentWindow } from '../desktop-menu.mjs';

let nextContentsId = 1;

const createContents = (calls, name) => {
  let destroyed = false;
  return {
    id: nextContentsId++,
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    copy: () => calls.push(['copy', name]),
    executeJavaScript: async (script) => { calls.push(['dom', name, script]); },
  };
};

const createWindow = (calls, name, markers) => ({
  ...markers,
  isDestroyed: () => false,
  webContents: createContents(calls, name),
});

const setup = () => {
  const calls = [];
  const main = createWindow(calls, 'main', { __ocLabel: 'main' });
  const additional = createWindow(calls, 'main-2', { __ocLabel: 'main-2' });
  const miniChat = createWindow(calls, 'mini-chat', { __ocLabel: 'main-3', __ocMiniChat: true });
  const popout = createWindow(calls, 'popout', { __ocLabel: 'browser-surface', __ocBrowserPopout: true });
  const guest = createContents(calls, 'guest');
  const devTools = createContents(calls, 'devtools');
  let focused = null;
  const menu = createDesktopMenu({
    app: { name: 'DevRyan' },
    Menu: { buildFromTemplate: (template) => template },
    shell: {},
    log: {},
    // The focused window stays the main window: Copy must follow the focused
    // contents, not the focused window.
    BrowserWindow: { getFocusedWindow: () => main, getAllWindows: () => [main, additional, miniChat, popout] },
    getMainWindow: () => main,
    getFocusedWebContents: () => focused,
    isAppDocumentWindow,
    emitToWindow: (_window, event, detail) => calls.push(['emit', event, detail]),
    emitToAllWindows: () => {},
  });
  const items = menu.buildMacMenu().flatMap((section) => section.submenu || []);
  const copyItem = items.find((item) => item.label === 'Copy');
  return {
    calls, main, additional, miniChat, popout, guest, devTools, copyItem,
    focus: (contents) => { focused = contents; },
  };
};

const copyScriptFor = (name) => ['dom', name,
  'window.dispatchEvent(new CustomEvent("devryan:menu-action", { detail: "copy" }));'
  + 'window.dispatchEvent(new CustomEvent("openchamber:menu-action", { detail: "copy" }));'];

test('Copy keeps its Cmd+C accelerator', () => {
  const { copyItem } = setup();
  assert.equal(copyItem.accelerator, 'Cmd+C');
});

for (const windowName of ['main', 'additional', 'miniChat']) {
  test(`Copy in the ${windowName} app document copies once and dispatches one DOM event`, () => {
    const context = setup();
    const target = context[windowName];
    context.focus(target.webContents);
    context.copyItem.click();
    const name = target.__ocMiniChat ? 'mini-chat' : target.__ocLabel;
    assert.deepEqual(context.calls, [['copy', name], copyScriptFor(name)]);
  });
}

test('Copy in a webview guest, popout or DevTools runs the native copy only', () => {
  for (const pick of [(context) => context.guest, (context) => context.popout.webContents, (context) => context.devTools]) {
    const context = setup();
    const contents = pick(context);
    context.focus(contents);
    context.copyItem.click();
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0][0], 'copy');
  }
});

test('Copy does nothing without live focused contents', () => {
  const empty = setup();
  empty.copyItem.click();
  assert.deepEqual(empty.calls, []);

  const destroyed = setup();
  destroyed.main.webContents.destroy();
  destroyed.focus(destroyed.main.webContents);
  destroyed.copyItem.click();
  assert.deepEqual(destroyed.calls, []);
});

test('Copy never uses the IPC emit path', () => {
  const context = setup();
  for (const contents of [context.main.webContents, context.miniChat.webContents, context.guest, context.devTools]) {
    context.focus(contents);
    context.copyItem.click();
  }
  assert.equal(context.calls.some(([kind]) => kind === 'emit'), false);
  assert.equal(context.calls.filter(([kind]) => kind === 'copy').length, 4);
  assert.equal(context.calls.filter(([kind]) => kind === 'dom').length, 2);
});

test('app document windows are main, main-N and Mini Chat, never popouts', () => {
  const window = (markers, destroyed = false) => ({ ...markers, isDestroyed: () => destroyed });
  assert.equal(isAppDocumentWindow(window({ __ocLabel: 'main' })), true);
  assert.equal(isAppDocumentWindow(window({ __ocLabel: 'main-12' })), true);
  assert.equal(isAppDocumentWindow(window({ __ocMiniChat: true })), true);
  assert.equal(isAppDocumentWindow(window({ __ocLabel: 'main', __ocBrowserPopout: true })), false);
  assert.equal(isAppDocumentWindow(window({ __ocLabel: 'browser-surface', __ocBrowserPopout: true })), false);
  assert.equal(isAppDocumentWindow(window({ __ocLabel: 'main-x' })), false);
  assert.equal(isAppDocumentWindow(window({})), false);
  assert.equal(isAppDocumentWindow(window({ __ocLabel: 'main' }, true)), false);
  assert.equal(isAppDocumentWindow(null), false);
});
